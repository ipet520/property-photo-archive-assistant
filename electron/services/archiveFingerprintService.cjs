const crypto = require('node:crypto');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const { loadLedgerRecords } = require('./ledgerQueryService.cjs');

const INDEX_DIRECTORY_NAME = '.archive-assistant';
const INDEX_FILE_NAME = 'photo-fingerprint-index.json';
const INDEX_VERSION = 1;
const HASH_ALGORITHM = 'sha256';

function getFingerprintIndexPath(archiveRoot) {
  const root = String(archiveRoot || '').trim();
  return root ? path.join(root, INDEX_DIRECTORY_NAME, INDEX_FILE_NAME) : '';
}

async function recordArchivedPhotoFingerprints(archiveRoot, archiveResults = []) {
  if (!archiveRoot) throw new Error('缺少归档根目录');
  const successfulResults = archiveResults.filter((item) => item?.status === '归档成功' && item.targetPath);
  if (successfulResults.length === 0) return { success: true, recordedCount: 0, indexPath: getFingerprintIndexPath(archiveRoot) };

  const index = await readFingerprintIndex(archiveRoot);
  const entriesByArchivePath = new Map(index.entries.map((entry) => [normalizePathKey(entry.archivePath), entry]));
  let recordedCount = 0;

  for (const item of successfulResults) {
    const entry = await createFingerprintEntry({
      archivePath: item.targetPath,
      originalName: item.originalName,
      newFileName: item.newFileName,
      archivedAt: item.archivedAt
    });
    if (!entry) continue;
    entriesByArchivePath.set(normalizePathKey(entry.archivePath), entry);
    recordedCount += 1;
  }

  const nextIndex = createIndexPayload(Array.from(entriesByArchivePath.values()));
  await writeFingerprintIndex(archiveRoot, nextIndex);
  return { success: true, recordedCount, indexPath: getFingerprintIndexPath(archiveRoot) };
}

async function matchArchivedPhotos(archiveRoot, photos = []) {
  if (!archiveRoot || !Array.isArray(photos) || photos.length === 0) {
    return { success: true, matchedCount: 0, matches: {}, indexPath: getFingerprintIndexPath(archiveRoot) };
  }

  const ledgerResult = await loadLedgerRecords(archiveRoot);
  const ledgerRecords = (ledgerResult.records || []).filter((record) => record.archivePath && record.fileExists);
  const { index, updated } = await reconcileIndexWithLedger(archiveRoot, ledgerRecords);
  const currentArchivePaths = new Set(ledgerRecords.map((record) => normalizePathKey(record.archivePath)));
  const recordsByArchivePath = new Map(ledgerRecords.map((record) => [normalizePathKey(record.archivePath), record]));
  const entriesBySize = new Map();

  index.entries.forEach((entry) => {
    const archivePathKey = normalizePathKey(entry.archivePath);
    if (!currentArchivePaths.has(archivePathKey) || !entry.fingerprint || !Number.isFinite(Number(entry.fileSize))) return;
    const sizeKey = String(entry.fileSize);
    const entries = entriesBySize.get(sizeKey) || [];
    entries.push(entry);
    entriesBySize.set(sizeKey, entries);
  });

  const matches = {};
  let skippedCount = 0;
  for (const photo of photos) {
    const sourcePath = String(photo?.path || photo?.originalPath || '').trim();
    if (!sourcePath) continue;
    try {
      const fileSize = await resolveFileSize(sourcePath, photo?.size);
      const candidates = entriesBySize.get(String(fileSize)) || [];
      if (candidates.length === 0) continue;
      const fingerprint = await hashFile(sourcePath);
      const matchedEntry = candidates.find((entry) => entry.fingerprint === fingerprint);
      if (!matchedEntry) continue;
      const record = recordsByArchivePath.get(normalizePathKey(matchedEntry.archivePath));
      if (record && photo.id) matches[photo.id] = record;
    } catch {
      skippedCount += 1;
    }
  }

  if (updated) await writeFingerprintIndex(archiveRoot, index);
  return {
    success: true,
    matchedCount: Object.keys(matches).length,
    skippedCount,
    matches,
    indexPath: getFingerprintIndexPath(archiveRoot)
  };
}

async function reconcileIndexWithLedger(archiveRoot, ledgerRecords) {
  const current = await readFingerprintIndex(archiveRoot);
  const currentByArchivePath = new Map(current.entries.map((entry) => [normalizePathKey(entry.archivePath), entry]));
  const nextEntries = [];
  let updated = false;

  for (const record of ledgerRecords) {
    const key = normalizePathKey(record.archivePath);
    let entry = currentByArchivePath.get(key);
    if (!entry || !entry.fingerprint || !Number.isFinite(Number(entry.fileSize))) {
      entry = await createFingerprintEntry(record);
      updated = true;
    }
    if (entry) nextEntries.push(entry);
  }

  if (nextEntries.length !== current.entries.length) updated = true;
  return { index: createIndexPayload(nextEntries), updated };
}

async function createFingerprintEntry(input = {}) {
  const archivePath = String(input.archivePath || input.targetPath || '').trim();
  if (!archivePath || !await isFile(archivePath)) return null;
  const stat = await fsPromises.stat(archivePath);
  return {
    algorithm: HASH_ALGORITHM,
    fingerprint: await hashFile(archivePath),
    fileSize: stat.size,
    archivePath,
    originalName: String(input.originalName || '').trim(),
    newFileName: String(input.newFileName || path.basename(archivePath)).trim(),
    archivedAt: String(input.archivedAt || '').trim(),
    indexedAt: new Date().toISOString()
  };
}

async function readFingerprintIndex(archiveRoot) {
  const indexPath = getFingerprintIndexPath(archiveRoot);
  try {
    const payload = JSON.parse(await fsPromises.readFile(indexPath, 'utf-8'));
    return createIndexPayload(Array.isArray(payload.entries) ? payload.entries : []);
  } catch (error) {
    if (error.code === 'ENOENT' || error.name === 'SyntaxError') return createIndexPayload([]);
    throw error;
  }
}

function createIndexPayload(entries) {
  return {
    version: INDEX_VERSION,
    algorithm: HASH_ALGORITHM,
    updatedAt: new Date().toISOString(),
    entries: Array.isArray(entries) ? entries : []
  };
}

async function writeFingerprintIndex(archiveRoot, payload) {
  const indexPath = getFingerprintIndexPath(archiveRoot);
  const indexDirectory = path.dirname(indexPath);
  await fsPromises.mkdir(indexDirectory, { recursive: true });
  const temporaryPath = `${indexPath}.${process.pid}.${Date.now()}.tmp`;
  await fsPromises.writeFile(temporaryPath, JSON.stringify(payload, null, 2), 'utf-8');
  try {
    await fsPromises.copyFile(temporaryPath, indexPath);
  } finally {
    await fsPromises.rm(temporaryPath, { force: true });
  }
}

async function resolveFileSize(filePath, providedSize) {
  const normalizedSize = Number(providedSize);
  if (Number.isFinite(normalizedSize) && normalizedSize >= 0) return normalizedSize;
  return (await fsPromises.stat(filePath)).size;
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(HASH_ALGORITHM);
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function isFile(filePath) {
  try {
    return (await fsPromises.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function normalizePathKey(value = '') {
  const text = String(value || '').trim();
  return text ? path.resolve(text).toLocaleLowerCase('zh-CN') : '';
}

module.exports = {
  getFingerprintIndexPath,
  matchArchivedPhotos,
  recordArchivedPhotoFingerprints
};
