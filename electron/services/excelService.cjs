const crypto = require('node:crypto');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const XLSX = require('xlsx');

const LEDGER_FILE_NAME = '照片归档台账.xlsx';
const LEDGER_HEADERS = [
  '日期',
  '项目',
  '归档分类',
  '工作内容',
  '具体位置',
  '新文件名',
  '原文件名',
  '关键词',
  '备注',
  '归档路径',
  '归档时间',
  '来源类型',
  '来源标识',
  '照片ID',
  '来源文件路径',
  '来源文件SHA-256',
  '归档文件SHA-256',
  '归档事务ID',
  '水印模板',
  '识别处理方式',
  '车牌号码',
  '违停类型',
  '施工单位ID',
  '施工单位',
  '施工单位原始文本',
  '施工单位已确认',
  '施工单位来源'
];

const LEDGER_HEADER_ALIASES = {
  日期: ['日期', '归档日期', '拍摄日期', '时间'],
  项目: ['项目', '项目名称'],
  归档分类: ['归档分类', '水印分类', '分类'],
  工作内容: ['工作内容', '标准工作项'],
  具体位置: ['具体位置', '位置/区域', '位置', '区域'],
  新文件名: ['新文件名', '归档文件名', '文件名'],
  原文件名: ['原文件名', '原始文件名'],
  关键词: ['关键词', '关键字'],
  备注: ['备注'],
  归档路径: ['归档路径', '目标路径', '文件路径', '归档文件路径'],
  归档时间: ['归档时间', '写入时间'],
  来源类型: ['来源类型', '照片来源类型'],
  来源标识: ['来源标识', 'sourceKey'],
  照片ID: ['照片ID', 'photoId'],
  来源文件路径: ['来源文件路径', '原始文件路径', '原图路径', '来源路径'],
  '来源文件SHA-256': ['来源文件SHA-256', 'sourceSha256'],
  '归档文件SHA-256': ['归档文件SHA-256', 'archiveSha256'],
  归档事务ID: ['归档事务ID', 'transactionId'],
  水印模板: ['水印模板', 'watermarkTemplateType'],
  识别处理方式: ['识别处理方式', 'processingMode'],
  车牌号码: ['车牌号码', 'vehiclePlate'],
  违停类型: ['违停类型', 'violationType'],
  施工单位ID: ['施工单位ID', 'constructionUnitId'],
  施工单位: ['施工单位', 'constructionUnitName'],
  施工单位原始文本: ['施工单位原始文本', 'constructionUnitOriginalText'],
  施工单位已确认: ['施工单位已确认', 'constructionUnitConfirmed'],
  施工单位来源: ['施工单位来源', 'constructionUnitSource']
};
const LEDGER_SWAP_PREFIX = '.photo-ledger-swap-';
const ledgerWriteQueues = new Map();

class LedgerWriteError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LedgerWriteError';
    this.code = code;
  }
}

function getLedgerPath(archiveRoot) {
  return path.join(archiveRoot || '', LEDGER_FILE_NAME);
}

async function appendLedgerRows(archiveRoot, archiveResults, options = {}) {
  const root = normalizeArchiveRoot(archiveRoot);
  const ledgerPath = getLedgerPath(root);
  return withLedgerWriteLock(ledgerPath, () => appendLedgerRowsUnlocked(root, archiveResults, options));
}

async function appendLedgerRowsUnlocked(archiveRoot, archiveResults, options = {}) {
  if (!Array.isArray(archiveResults) || archiveResults.length === 0) {
    return {
      appendedCount: 0,
      skippedExistingCount: 0,
      committedArchivePaths: [],
      totalRowCount: 0
    };
  }
  const ledgerPath = getLedgerPath(archiveRoot);
  await fs.mkdir(archiveRoot, { recursive: true });
  await recoverLedgerSwapArtifacts(archiveRoot, options);

  const rows = await readNormalizedLedgerRows(ledgerPath, { allowMissing: true });
  const archivePathIndex = LEDGER_HEADERS.indexOf('归档路径');
  const existingPathKeys = new Set(rows.slice(1).map((row) => normalizeArchivePathKey(row[archivePathIndex])).filter(Boolean));
  const accepted = [];
  const skipped = [];

  for (const item of archiveResults) {
    const validated = await validateLedgerArchiveItem(archiveRoot, item);
    const archivePathKey = normalizeArchivePathKey(validated.targetPath);
    if (existingPathKeys.has(archivePathKey)) {
      skipped.push(validated);
      continue;
    }
    existingPathKeys.add(archivePathKey);
    accepted.push(validated);
  }

  if (accepted.length === 0) {
    return {
      appendedCount: 0,
      skippedExistingCount: skipped.length,
      committedArchivePaths: skipped.map((item) => item.targetPath),
      totalRowCount: Math.max(0, rows.length - 1)
    };
  }

  const nextRows = [
    ...rows,
    ...accepted.map(toLedgerDataRow)
  ];
  await replaceLedgerWorkbook(archiveRoot, ledgerPath, nextRows, accepted, options);
  return {
    appendedCount: accepted.length,
    skippedExistingCount: skipped.length,
    committedArchivePaths: [...skipped, ...accepted].map((item) => item.targetPath),
    totalRowCount: Math.max(0, nextRows.length - 1)
  };
}

function normalizeExistingLedgerRows(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return [LEDGER_HEADERS];
  const sourceHeaders = rows[0].map((header) => String(header || '').trim());
  const normalizedRows = rows.slice(1).map((row) => {
    if (isCurrentRowUnderLegacyHeaders(sourceHeaders, row)) {
      return LEDGER_HEADERS.map((_, index) => (index < 11 ? row[index] ?? '' : ''));
    }
    return LEDGER_HEADERS.map((header) => {
      const aliases = LEDGER_HEADER_ALIASES[header] || [header];
      const sourceIndex = sourceHeaders.findIndex((sourceHeader) => aliases.includes(sourceHeader));
      return sourceIndex >= 0 ? row[sourceIndex] ?? '' : '';
    });
  });
  return [LEDGER_HEADERS, ...normalizedRows];
}

function isCurrentRowUnderLegacyHeaders(headers = [], row = []) {
  if (headers.includes('归档分类')) return false;
  const legacyPathIndex = headers.indexOf('归档路径');
  const legacyStatusIndex = headers.indexOf('处理状态');
  if (legacyPathIndex < 0 || legacyStatusIndex < 0) return false;
  return !String(row[legacyPathIndex] || '').trim() && looksLikeArchivePath(row[legacyStatusIndex]);
}

function looksLikeArchivePath(value = '') {
  const text = String(value || '').trim();
  return path.isAbsolute(text) && /\.(jpe?g|png|webp|bmp|gif|tiff?|heic)$/i.test(text);
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function recoverLedgerSwapArtifacts(archiveRoot, options = {}) {
  const ledgerPath = getLedgerPath(archiveRoot);
  const entries = await fs.readdir(archiveRoot, { withFileTypes: true });
  const backups = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(LEDGER_SWAP_PREFIX) && entry.name.endsWith('.backup.xlsx'))
    .map((entry) => path.join(archiveRoot, entry.name));
  const temporaryFiles = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(LEDGER_SWAP_PREFIX) && entry.name.endsWith('.tmp.xlsx'))
    .map((entry) => path.join(archiveRoot, entry.name));

  if (backups.length > 1) {
    throw createLedgerError('ledger_recovery_ambiguous', '检测到多个台账恢复文件，已停止自动处理，请人工核查。');
  }
  const ledgerExists = await exists(ledgerPath);
  if (backups.length === 1) {
    const backupPath = backups[0];
    await readNormalizedLedgerRows(backupPath);
    if (ledgerExists) {
      await readNormalizedLedgerRows(ledgerPath);
      await safeRemove(backupPath);
      await Promise.all(temporaryFiles.map(safeRemove));
      return { recovered: false, cleaned: true };
    }
    await fs.rename(backupPath, ledgerPath);
    await readNormalizedLedgerRows(ledgerPath);
    await Promise.all(temporaryFiles.map(safeRemove));
    return { recovered: true, cleaned: true };
  }

  if (ledgerExists) {
    await readNormalizedLedgerRows(ledgerPath);
    await Promise.all(temporaryFiles.map(safeRemove));
    return { recovered: false, cleaned: temporaryFiles.length > 0 };
  }
  if (temporaryFiles.length > 1) {
    throw createLedgerError('ledger_recovery_ambiguous', '检测到多个台账临时文件，已停止自动处理，请人工核查。');
  }
  if (temporaryFiles.length === 1) {
    await readNormalizedLedgerRows(temporaryFiles[0]);
    await fs.rename(temporaryFiles[0], ledgerPath);
    await readNormalizedLedgerRows(ledgerPath);
    return { recovered: true, cleaned: true };
  }
  return { recovered: false, cleaned: false };
}

async function replaceLedgerWorkbook(archiveRoot, ledgerPath, rows, acceptedItems, options = {}) {
  const swapId = crypto.randomUUID();
  const temporaryPath = path.join(archiveRoot, `${LEDGER_SWAP_PREFIX}${swapId}.tmp.xlsx`);
  const backupPath = path.join(archiveRoot, `${LEDGER_SWAP_PREFIX}${swapId}.backup.xlsx`);
  const hooks = options.hooks || {};
  const ledgerExisted = await exists(ledgerPath);
  let backupCreated = false;
  let replacementInstalled = false;

  try {
    const workbook = buildLedgerWorkbook(rows);
    if (typeof hooks.writeWorkbook === 'function') {
      await hooks.writeWorkbook(workbook, temporaryPath);
    } else {
      XLSX.writeFile(workbook, temporaryPath, { bookType: 'xlsx' });
    }
    await syncFile(temporaryPath);
    await validateLedgerWorkbook(temporaryPath, rows.length, acceptedItems.map((item) => item.targetPath));
    if (typeof hooks.beforeBackup === 'function') await hooks.beforeBackup();

    if (ledgerExisted) {
      await fs.rename(ledgerPath, backupPath);
      backupCreated = true;
      if (typeof hooks.afterBackup === 'function') await hooks.afterBackup();
    }
    if (typeof hooks.beforeInstall === 'function') await hooks.beforeInstall();
    await fs.rename(temporaryPath, ledgerPath);
    replacementInstalled = true;
    if (typeof hooks.afterInstall === 'function') await hooks.afterInstall();
    await validateLedgerWorkbook(ledgerPath, rows.length, acceptedItems.map((item) => item.targetPath));
    if (backupCreated) {
      await safeRemove(backupPath);
      backupCreated = false;
    }
  } catch (error) {
    if (backupCreated) {
      try {
        if (replacementInstalled && await exists(ledgerPath)) await fs.rm(ledgerPath, { force: true });
        if (!await exists(ledgerPath)) await fs.rename(backupPath, ledgerPath);
        backupCreated = false;
      } catch {
        throw createLedgerError('ledger_restore_failed', '台账替换失败且自动恢复未完成，请保留现场并人工核查。');
      }
    } else if (!ledgerExisted && replacementInstalled) {
      await safeRemove(ledgerPath);
    }
    if (error instanceof LedgerWriteError) throw error;
    throw createLedgerError('ledger_write_failed', '台账暂时无法写入，照片文件已保留，可稍后重试补记。');
  } finally {
    await safeRemove(temporaryPath);
    if (!backupCreated && await exists(backupPath)) await safeRemove(backupPath);
  }
}

function buildLedgerWorkbook(rows) {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!cols'] = LEDGER_HEADERS.map((header) => ({ wch: Math.max(header.length + 8, 16) }));
  XLSX.utils.book_append_sheet(workbook, sheet, '照片归档台账');
  return workbook;
}

async function readNormalizedLedgerRows(filePath, options = {}) {
  if (!await exists(filePath)) {
    if (options.allowMissing) return [LEDGER_HEADERS];
    throw createLedgerError('ledger_missing', '台账恢复文件不存在。');
  }
  try {
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    if (!sheetName || !workbook.Sheets[sheetName]) {
      throw new Error('missing_sheet');
    }
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' });
    return normalizeExistingLedgerRows(rows);
  } catch (error) {
    if (error instanceof LedgerWriteError) throw error;
    throw createLedgerError('ledger_corrupt', '照片归档台账无法读取，已拒绝覆盖，请先恢复台账。');
  }
}

async function validateLedgerWorkbook(filePath, expectedRowCount, requiredArchivePaths = []) {
  const rows = await readNormalizedLedgerRows(filePath);
  if (rows.length !== expectedRowCount) {
    throw createLedgerError('ledger_validation_failed', '台账临时文件校验失败，原台账未被替换。');
  }
  const archivePathIndex = LEDGER_HEADERS.indexOf('归档路径');
  const archivePaths = new Set(rows.slice(1).map((row) => normalizeArchivePathKey(row[archivePathIndex])).filter(Boolean));
  if (requiredArchivePaths.some((archivePath) => !archivePaths.has(normalizeArchivePathKey(archivePath)))) {
    throw createLedgerError('ledger_validation_failed', '台账临时文件缺少本次归档记录，原台账未被替换。');
  }
}

async function validateLedgerArchiveItem(archiveRoot, input = {}) {
  const targetPath = path.resolve(String(input.targetPath || ''));
  if (!isPathInside(archiveRoot, targetPath)) {
    throw createLedgerError('ledger_target_invalid', '归档文件路径无效，已拒绝写入台账。');
  }
  let stat;
  try {
    stat = await fs.stat(targetPath);
  } catch {
    throw createLedgerError('ledger_target_missing', '归档文件不存在，已拒绝写入台账。');
  }
  if (!stat.isFile()) throw createLedgerError('ledger_target_invalid', '归档目标不是文件，已拒绝写入台账。');
  const expectedSize = Number(input.targetSize ?? input.sourceSize);
  if (Number.isFinite(expectedSize) && expectedSize >= 0 && stat.size !== expectedSize) {
    throw createLedgerError('ledger_target_mismatch', '归档文件校验失败，已拒绝写入台账。');
  }
  const expectedHash = String(input.targetSha256 || input.sourceSha256 || '').trim().toLowerCase();
  if (expectedHash && await hashFile(targetPath) !== expectedHash) {
    throw createLedgerError('ledger_target_mismatch', '归档文件校验失败，已拒绝写入台账。');
  }
  return { ...input, targetPath, targetSize: stat.size, targetSha256: expectedHash };
}

function toLedgerDataRow(item) {
  return [
    item.date,
    item.project,
    item.watermarkCategory,
    item.workContent,
    item.location,
    item.newFileName,
    item.originalName,
    item.keywords,
    item.remark,
    item.targetPath,
    item.archivedAt,
    item.sourceType,
    item.sourceKey,
    item.photoId,
    item.sourcePath,
    item.sourceSha256,
    item.archiveSha256 || item.targetSha256,
    item.transactionId,
    item.watermarkTemplateType,
    item.processingMode,
    item.vehiclePlate,
    item.violationType,
    item.constructionUnitId,
    item.constructionUnitName,
    item.constructionUnitOriginalText,
    item.constructionUnitConfirmed,
    item.constructionUnitSource
  ];
}

function withLedgerWriteLock(ledgerPath, action) {
  const key = normalizeArchivePathKey(ledgerPath);
  const previous = ledgerWriteQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => undefined).then(action);
  ledgerWriteQueues.set(key, current);
  return current.finally(() => {
    if (ledgerWriteQueues.get(key) === current) ledgerWriteQueues.delete(key);
  });
}

function normalizeArchiveRoot(value) {
  const text = String(value || '').trim();
  if (!text) throw createLedgerError('ledger_archive_root_missing', '缺少归档根目录。');
  return path.resolve(text);
}

function normalizeArchivePathKey(value) {
  const text = String(value || '').trim();
  return text ? path.resolve(text).toLocaleLowerCase('zh-CN') : '';
}

function isPathInside(rootPath, targetPath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fsSync.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function syncFile(filePath) {
  const handle = await fs.open(filePath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function safeRemove(filePath) {
  try {
    await fs.rm(filePath, { force: true });
  } catch {
    // Owned swap artifacts can be retried on the next append.
  }
}

function createLedgerError(code, message) {
  return new LedgerWriteError(code, message);
}

module.exports = {
  LedgerWriteError,
  appendLedgerRows,
  getLedgerPath,
  normalizeExistingLedgerRows,
  recoverLedgerSwapArtifacts
};
