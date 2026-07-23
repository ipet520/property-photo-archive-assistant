const crypto = require('node:crypto');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');

const TRANSACTION_SCHEMA_VERSION = 1;
const TRANSACTION_DIRECTORY = path.join('.archive-assistant', 'archive-transactions');
const ITEM_STAGES = new Set([
  'planned',
  'copying',
  'copied',
  'ledger_pending',
  'committed',
  'copy_failed',
  'target_conflict'
]);
const TRANSACTION_STATES = new Set([
  'planned',
  'copying',
  'ledger_pending',
  'committed',
  'partial',
  'failed'
]);
const transactionQueues = new Map();

class ArchiveTransactionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ArchiveTransactionError';
    this.code = code;
  }
}

function buildArchiveSourceIdentity(input = {}) {
  const sourceKey = normalizeText(input.sourceKey);
  if (sourceKey) return `marki:${sourceKey}`;

  const sourceSha256 = normalizeSha256(input.sourceSha256);
  const originalPath = normalizeSourcePath(input.originalPath);
  if (!sourceSha256 || !originalPath) {
    throw createTransactionError('archive_source_identity_invalid', '照片来源身份不完整，无法创建归档事务。');
  }
  return `local:${sourceSha256}:${originalPath}`;
}

function buildArchiveOperationKey(items = []) {
  if (!Array.isArray(items) || items.length === 0) {
    throw createTransactionError('archive_operation_items_missing', '没有可用于创建归档事务的照片。');
  }
  const normalized = items.map((item) => ({
    sourceIdentity: normalizeText(item.sourceIdentity),
    project: normalizeText(item.ledgerRow?.project ?? item.project),
    watermarkCategory: normalizeText(item.ledgerRow?.watermarkCategory ?? item.watermarkCategory),
    workContent: normalizeText(item.ledgerRow?.workContent ?? item.workContent),
    date: normalizeText(item.ledgerRow?.date ?? item.date),
    location: normalizeText(item.ledgerRow?.location ?? item.location),
    keywords: normalizeText(item.ledgerRow?.keywords ?? item.keywords),
    remark: normalizeText(item.ledgerRow?.remark ?? item.remark)
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), 'en'));

  if (normalized.some((item) => !item.sourceIdentity)) {
    throw createTransactionError('archive_source_identity_invalid', '照片来源身份不完整，无法创建归档事务。');
  }
  return hashValue(JSON.stringify(normalized));
}

function createArchiveTransaction(input = {}) {
  const operationKey = normalizeSha256(input.operationKey);
  if (!operationKey) {
    throw createTransactionError('archive_operation_key_invalid', '归档事务标识无效。');
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw createTransactionError('archive_operation_items_missing', '归档事务没有可处理照片。');
  }
  const now = new Date().toISOString();
  const transactionId = crypto.randomUUID();
  return normalizeArchiveTransaction({
    schemaVersion: TRANSACTION_SCHEMA_VERSION,
    transactionId,
    operationKey,
    state: 'planned',
    createdAt: now,
    updatedAt: now,
    items: input.items.map((item, index) => ({
      ...item,
      itemId: normalizeText(item.itemId) || hashValue(`${transactionId}:${item.sourceIdentity}:${index}`),
      stage: 'planned',
      errorCode: '',
      errorMessage: '',
      copiedAt: '',
      committedAt: ''
    }))
  });
}

function getArchiveTransactionDirectory(archiveRoot) {
  return path.join(normalizeArchiveRoot(archiveRoot), TRANSACTION_DIRECTORY);
}

function getArchiveTransactionPath(archiveRoot, transactionId) {
  const normalizedId = normalizeTransactionId(transactionId);
  return path.join(getArchiveTransactionDirectory(archiveRoot), `${normalizedId}.json`);
}

function toArchiveTargetRelativePath(archiveRoot, targetPath) {
  const root = normalizeArchiveRoot(archiveRoot);
  const absoluteTarget = path.resolve(String(targetPath || ''));
  const relative = path.relative(root, absoluteTarget);
  validateRelativeTargetPath(relative);
  return relative.replaceAll('\\', '/');
}

function resolveArchiveTargetPath(archiveRoot, targetRelativePath) {
  const root = normalizeArchiveRoot(archiveRoot);
  const normalizedRelative = validateRelativeTargetPath(targetRelativePath);
  const targetPath = path.resolve(root, normalizedRelative);
  const relative = path.relative(root, targetPath);
  validateRelativeTargetPath(relative);
  return targetPath;
}

async function loadArchiveTransaction(archiveRoot, transactionId) {
  const transactionPath = getArchiveTransactionPath(archiveRoot, transactionId);
  try {
    const payload = JSON.parse(await fsPromises.readFile(transactionPath, 'utf8'));
    const transaction = normalizeArchiveTransaction(payload);
    if (transaction.transactionId !== normalizeTransactionId(transactionId)) {
      throw createTransactionError('archive_transaction_id_mismatch', '归档事务文件标识不一致。');
    }
    return transaction;
  } catch (error) {
    if (error instanceof ArchiveTransactionError) throw error;
    if (error.code === 'ENOENT') {
      throw createTransactionError('archive_transaction_not_found', '未找到对应的归档事务。');
    }
    throw createTransactionError('archive_transaction_corrupt', '归档事务记录损坏，已拒绝覆盖，请人工核查。');
  }
}

async function saveArchiveTransaction(archiveRoot, input, options = {}) {
  const transaction = normalizeArchiveTransaction({
    ...input,
    updatedAt: new Date().toISOString()
  });
  const transactionDirectory = getArchiveTransactionDirectory(archiveRoot);
  const transactionPath = getArchiveTransactionPath(archiveRoot, transaction.transactionId);
  await fsPromises.mkdir(transactionDirectory, { recursive: true });

  if (options.verifyExisting !== false && await isFile(transactionPath)) {
    await loadArchiveTransaction(archiveRoot, transaction.transactionId);
  }

  const temporaryPath = path.join(
    transactionDirectory,
    `.${transaction.transactionId}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`
  );
  let handle = null;
  try {
    handle = await fsPromises.open(temporaryPath, 'wx');
    await handle.writeFile(`${JSON.stringify(transaction, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsPromises.rename(temporaryPath, transactionPath);
    return transaction;
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // The original transaction remains authoritative.
      }
    }
    try {
      await fsPromises.rm(temporaryPath, { force: true });
    } catch {
      // A stale owned temp file is harmless and can be inspected manually.
    }
    if (error instanceof ArchiveTransactionError) throw error;
    throw createTransactionError('archive_transaction_write_failed', '归档事务记录保存失败，请重试。');
  }
}

async function findArchiveTransactionByOperationKey(archiveRoot, operationKey) {
  const normalizedKey = normalizeSha256(operationKey);
  if (!normalizedKey) throw createTransactionError('archive_operation_key_invalid', '归档事务标识无效。');
  const directory = getArchiveTransactionDirectory(archiveRoot);
  let entries = [];
  try {
    entries = await fsPromises.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw createTransactionError('archive_transaction_list_failed', '无法读取归档事务记录。');
  }

  const matches = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const transactionId = entry.name.slice(0, -5);
    const transaction = await loadArchiveTransaction(archiveRoot, transactionId);
    if (transaction.operationKey === normalizedKey) matches.push(transaction);
  }
  if (matches.length > 1) {
    throw createTransactionError('archive_operation_duplicate', '检测到重复归档事务记录，请人工核查。');
  }
  return matches[0] || null;
}

async function listPendingArchiveTransactions(archiveRoot) {
  const directory = getArchiveTransactionDirectory(archiveRoot);
  let entries = [];
  try {
    entries = await fsPromises.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { transactions: [], errors: [] };
    throw createTransactionError('archive_transaction_list_failed', '无法读取归档事务记录。');
  }

  const transactions = [];
  const errors = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const transaction = await loadArchiveTransaction(archiveRoot, entry.name.slice(0, -5));
      if (transaction.state !== 'committed') transactions.push(transaction);
    } catch (error) {
      errors.push({
        transactionId: entry.name.slice(0, -5),
        errorCode: error.code || 'archive_transaction_corrupt',
        message: safeErrorMessage(error)
      });
    }
  }
  return { transactions, errors };
}

async function updateArchiveTransaction(archiveRoot, transactionId, updater) {
  const current = await loadArchiveTransaction(archiveRoot, transactionId);
  const draft = JSON.parse(JSON.stringify(current));
  const updated = typeof updater === 'function' ? (await updater(draft)) || draft : { ...draft, ...updater };
  updated.state = calculateArchiveTransactionState(updated.items);
  return saveArchiveTransaction(archiveRoot, updated);
}

function calculateArchiveTransactionState(items = []) {
  if (!Array.isArray(items) || items.length === 0) return 'failed';
  const stages = items.map((item) => item.stage);
  if (stages.every((stage) => stage === 'committed')) return 'committed';
  if (stages.some((stage) => ['copied', 'ledger_pending'].includes(stage))) return 'ledger_pending';
  if (stages.some((stage) => stage === 'committed')) return 'partial';
  if (stages.some((stage) => stage === 'copying')) return 'copying';
  if (stages.every((stage) => ['copy_failed', 'target_conflict'].includes(stage))) return 'failed';
  if (stages.some((stage) => ['copy_failed', 'target_conflict'].includes(stage))) return 'partial';
  return 'planned';
}

function withArchiveTransactionLock(lockKey, action) {
  const normalizedKey = normalizeText(lockKey);
  if (!normalizedKey) return Promise.reject(createTransactionError('archive_lock_key_invalid', '归档事务锁标识无效。'));
  const previous = transactionQueues.get(normalizedKey) || Promise.resolve();
  const current = previous.catch(() => undefined).then(action);
  transactionQueues.set(normalizedKey, current);
  return current.finally(() => {
    if (transactionQueues.get(normalizedKey) === current) transactionQueues.delete(normalizedKey);
  });
}

function normalizeArchiveTransaction(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw createTransactionError('archive_transaction_corrupt', '归档事务记录格式无效。');
  }
  const transactionId = normalizeTransactionId(input.transactionId);
  const operationKey = normalizeSha256(input.operationKey);
  const state = normalizeText(input.state);
  if (Number(input.schemaVersion) !== TRANSACTION_SCHEMA_VERSION || !operationKey || !TRANSACTION_STATES.has(state)) {
    throw createTransactionError('archive_transaction_corrupt', '归档事务记录格式无效。');
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw createTransactionError('archive_transaction_corrupt', '归档事务记录缺少照片条目。');
  }
  const itemIds = new Set();
  const items = input.items.map((item) => {
    const normalized = normalizeArchiveTransactionItem(item);
    if (itemIds.has(normalized.itemId)) {
      throw createTransactionError('archive_transaction_corrupt', '归档事务记录包含重复条目。');
    }
    itemIds.add(normalized.itemId);
    return normalized;
  });
  return {
    schemaVersion: TRANSACTION_SCHEMA_VERSION,
    transactionId,
    operationKey,
    state,
    createdAt: normalizeText(input.createdAt) || new Date().toISOString(),
    updatedAt: normalizeText(input.updatedAt) || new Date().toISOString(),
    items
  };
}

function normalizeArchiveTransactionItem(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw createTransactionError('archive_transaction_corrupt', '归档事务照片条目格式无效。');
  }
  const itemId = normalizeSha256(input.itemId);
  const sourceSha256 = normalizeSha256(input.sourceSha256);
  const targetSha256 = input.targetSha256 ? normalizeSha256(input.targetSha256) : '';
  const stage = normalizeText(input.stage);
  const sourceIdentity = normalizeText(input.sourceIdentity);
  const originalPath = normalizeText(input.originalPath);
  const targetRelativePath = validateRelativeTargetPath(input.targetRelativePath).replaceAll('\\', '/');
  if (
    !itemId
    || !sourceIdentity
    || !originalPath
    || !sourceSha256
    || (input.targetSha256 && !targetSha256)
    || !ITEM_STAGES.has(stage)
  ) {
    throw createTransactionError('archive_transaction_corrupt', '归档事务照片条目格式无效。');
  }
  const expectedSourceIdentity = buildArchiveSourceIdentity({
    sourceKey: input.sourceKey,
    sourceSha256,
    originalPath
  });
  if (sourceIdentity !== expectedSourceIdentity) {
    throw createTransactionError('archive_transaction_corrupt', '归档事务照片来源身份不一致。');
  }
  const ledgerRow = normalizeLedgerRow(input.ledgerRow);
  return {
    itemId,
    photoId: normalizeText(input.photoId),
    sourceType: normalizeText(input.sourceType) || (input.sourceKey ? 'marki_api' : 'local_file'),
    sourceKey: normalizeText(input.sourceKey),
    sourceIdentity,
    originalPath,
    originalName: normalizeText(input.originalName),
    sourceSize: normalizeNonNegativeNumber(input.sourceSize),
    sourceSha256,
    targetRelativePath,
    targetSize: input.targetSize === '' || input.targetSize == null ? null : normalizeNonNegativeNumber(input.targetSize),
    targetSha256,
    ledgerRow,
    stage,
    errorCode: normalizeText(input.errorCode),
    errorMessage: normalizeText(input.errorMessage),
    copiedAt: normalizeText(input.copiedAt),
    committedAt: normalizeText(input.committedAt)
  };
}

function normalizeLedgerRow(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw createTransactionError('archive_transaction_corrupt', '归档事务台账数据格式无效。');
  }
  return {
    date: normalizeText(input.date),
    project: normalizeText(input.project),
    watermarkCategory: normalizeText(input.watermarkCategory),
    workContent: normalizeText(input.workContent),
    location: normalizeText(input.location),
    newFileName: normalizeText(input.newFileName),
    originalName: normalizeText(input.originalName),
    keywords: normalizeText(input.keywords),
    remark: normalizeText(input.remark),
    archivedAt: normalizeText(input.archivedAt),
    sourceType: normalizeText(input.sourceType),
    sourceKey: normalizeText(input.sourceKey),
    photoId: normalizeText(input.photoId),
    sourcePath: normalizeText(input.sourcePath),
    sourceSha256: normalizeText(input.sourceSha256),
    archiveSha256: normalizeText(input.archiveSha256),
    transactionId: normalizeText(input.transactionId),
    watermarkTemplateType: normalizeText(input.watermarkTemplateType),
    processingMode: normalizeText(input.processingMode)
  };
}

function validateRelativeTargetPath(value) {
  const text = normalizeText(value).replaceAll('/', path.sep);
  if (!text || path.isAbsolute(text)) {
    throw createTransactionError('archive_target_path_invalid', '归档目标路径无效。');
  }
  const normalized = path.normalize(text);
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw createTransactionError('archive_target_path_invalid', '归档目标路径无效。');
  }
  return normalized;
}

function normalizeArchiveRoot(value) {
  const text = normalizeText(value);
  if (!text) throw createTransactionError('archive_root_missing', '缺少归档根目录。');
  return path.resolve(text);
}

function normalizeSourcePath(value) {
  const text = normalizeText(value);
  return text ? path.resolve(text).replaceAll('/', '\\').toLocaleLowerCase('zh-CN') : '';
}

function normalizeTransactionId(value) {
  const text = normalizeText(value);
  if (!/^[a-f0-9-]{16,64}$/i.test(text)) {
    throw createTransactionError('archive_transaction_id_invalid', '归档事务标识无效。');
  }
  return text;
}

function normalizeSha256(value) {
  const text = normalizeText(value).toLowerCase();
  return /^[a-f0-9]{64}$/.test(text) ? text : '';
}

function normalizeNonNegativeNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw createTransactionError('archive_transaction_corrupt', '归档事务文件大小无效。');
  }
  return number;
}

function normalizeText(value) {
  return String(value ?? '').trim();
}

function hashValue(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
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

function createTransactionError(code, message) {
  return new ArchiveTransactionError(code, message);
}

function safeErrorMessage(error) {
  return error instanceof ArchiveTransactionError
    ? error.message
    : '归档事务处理失败，请重试。';
}

module.exports = {
  ArchiveTransactionError,
  ITEM_STAGES,
  TRANSACTION_STATES,
  buildArchiveOperationKey,
  buildArchiveSourceIdentity,
  calculateArchiveTransactionState,
  createArchiveTransaction,
  createTransactionError,
  findArchiveTransactionByOperationKey,
  getArchiveTransactionDirectory,
  getArchiveTransactionPath,
  hashFile,
  listPendingArchiveTransactions,
  loadArchiveTransaction,
  resolveArchiveTargetPath,
  saveArchiveTransaction,
  toArchiveTargetRelativePath,
  updateArchiveTransaction,
  withArchiveTransactionLock
};
