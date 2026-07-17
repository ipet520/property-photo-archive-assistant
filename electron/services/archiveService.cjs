const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const dayjs = require('dayjs');
const { appendLedgerRows, LedgerWriteError } = require('./excelService.cjs');
const { recordArchivedPhotoFingerprints } = require('./archiveFingerprintService.cjs');
const {
  ArchiveTransactionError,
  buildArchiveOperationKey,
  buildArchiveSourceIdentity,
  calculateArchiveTransactionState,
  createArchiveTransaction,
  findArchiveTransactionByOperationKey,
  hashFile,
  listPendingArchiveTransactions,
  loadArchiveTransaction,
  resolveArchiveTargetPath,
  saveArchiveTransaction,
  toArchiveTargetRelativePath,
  withArchiveTransactionLock
} = require('./archiveTransactionService.cjs');

const ILLEGAL_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

class ArchiveServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ArchiveServiceError';
    this.code = code;
  }
}

async function buildArchivePreview(payload) {
  const { form, photos, archiveRoot } = payload;
  validatePreviewPayload(form, photos, archiveRoot);

  const previewItems = [];
  const reservedPaths = new Set();
  for (let index = 0; index < photos.length; index += 1) {
    const photo = photos[index];
    const item = mergePhotoOverrides(form, photo);
    const targetDirectory = buildTargetDirectory(archiveRoot, item);
    const newFileName = buildFileName(item, photo.extension, index + 1);
    const targetPath = await resolveUniquePath(path.join(targetDirectory, newFileName), reservedPaths);
    reservedPaths.add(normalizePathKey(targetPath));

    previewItems.push({
      id: photo.id,
      index: index + 1,
      sourcePath: photo.path || photo.sourcePath,
      originalName: photo.name || photo.originalName,
      previewUrl: photo.previewUrl,
      extension: photo.extension,
      sourceType: photo.sourceType || (photo.sourceKey ? 'marki_api' : 'local_folder'),
      sourceKey: photo.sourceKey || '',
      sourceMetadataRef: photo.sourceMetadataRef || '',
      newFileName: path.basename(targetPath),
      targetDirectory,
      targetPath,
      status: '待归档',
      error: '',
      ...item
    });
  }
  return previewItems;
}

async function archivePhotos(archivePlan, options = {}) {
  validateArchivePlan(archivePlan);
  const archiveRoot = path.resolve(archivePlan.archiveRoot);
  const suppliedTransactionId = String(archivePlan.transactionId || '').trim();

  if (suppliedTransactionId) {
    const loaded = await loadArchiveTransaction(archiveRoot, suppliedTransactionId);
    return withArchiveTransactionLock(`operation:${loaded.operationKey}`, async () => {
      const transaction = await loadArchiveTransaction(archiveRoot, suppliedTransactionId);
      return processArchiveTransaction(archiveRoot, transaction, { ...options, allowCopy: true });
    });
  }

  let preparedItems;
  try {
    preparedItems = await prepareArchiveItems(archiveRoot, archivePlan.items, options);
  } catch (error) {
    return buildPreflightFailureResult(archivePlan.items, error);
  }
  const operationKey = buildArchiveOperationKey(preparedItems);
  return withArchiveTransactionLock(`operation:${operationKey}`, async () => {
    let transaction = await findArchiveTransactionByOperationKey(archiveRoot, operationKey);
    if (!transaction) {
      const transactionItems = await freezeArchiveTargets(archiveRoot, preparedItems);
      transaction = createArchiveTransaction({ operationKey, items: transactionItems });
      transaction = await saveArchiveTransaction(archiveRoot, transaction, { verifyExisting: false });
    }
    return processArchiveTransaction(archiveRoot, transaction, { ...options, allowCopy: true });
  });
}

async function recoverPendingArchiveTransactions(archiveRoot, options = {}) {
  const root = path.resolve(String(archiveRoot || '').trim());
  if (!String(archiveRoot || '').trim()) {
    throw new ArchiveServiceError('archive_root_missing', '缺少归档根目录。');
  }
  const pending = await listPendingArchiveTransactions(root);
  const recoveryErrors = [...pending.errors];
  const results = [];
  for (const candidate of pending.transactions) {
    try {
      const result = await withArchiveTransactionLock(`operation:${candidate.operationKey}`, async () => {
        const transaction = await loadArchiveTransaction(root, candidate.transactionId);
        return processArchiveTransaction(root, transaction, { ...options, allowCopy: false });
      });
      results.push(result);
    } catch (error) {
      recoveryErrors.push({
        transactionId: candidate.transactionId,
        errorCode: /^(archive|ledger)_/.test(String(error.code || '')) ? error.code : 'archive_recovery_failed',
        message: error instanceof ArchiveTransactionError || error instanceof ArchiveServiceError || error instanceof LedgerWriteError
          ? error.message
          : '归档事务恢复失败，请稍后重试。'
      });
    }
  }
  return {
    success: recoveryErrors.length === 0,
    recoveredTransactionCount: results.filter((result) => result.committedCount > 0).length,
    transactionCount: results.length,
    committedCount: results.reduce((sum, result) => sum + result.committedCount, 0),
    pendingLedgerCount: results.reduce((sum, result) => sum + result.pendingLedgerCount, 0),
    retryRequiredCount: results.reduce(
      (sum, result) => sum + result.items.filter((item) => ['planned', 'copying', 'copy_failed'].includes(item.stage)).length,
      0
    ),
    conflictCount: results.reduce((sum, result) => sum + result.conflictCount, 0),
    errors: recoveryErrors,
    transactions: results
  };
}

async function prepareArchiveItems(archiveRoot, items, options = {}) {
  const prepared = [];
  for (const item of items) {
    const sourcePath = path.resolve(String(item.sourcePath || '').trim());
    let stat;
    let sourceSha256;
    try {
      stat = await fs.stat(sourcePath);
      if (!stat.isFile()) throw new Error('not_file');
      sourceSha256 = await (options.hashFile || hashFile)(sourcePath);
    } catch {
      throw new ArchiveServiceError('archive_source_unreadable', '无法读取原始照片，归档尚未开始。');
    }
    const sourceKey = String(item.sourceKey || '').trim();
    const sourceIdentity = buildArchiveSourceIdentity({
      sourceKey,
      sourceSha256,
      originalPath: sourcePath
    });
    const ledgerRow = buildLedgerRow(item);
    prepared.push({
      photoId: String(item.id || item.photoId || '').trim(),
      sourceType: String(item.sourceType || '').trim() || (sourceKey ? 'marki_api' : 'local_folder'),
      sourceKey,
      sourceIdentity,
      originalPath: sourcePath,
      originalName: String(item.originalName || path.basename(sourcePath)).trim(),
      sourceSize: stat.size,
      sourceSha256,
      targetCandidatePath: resolveSafeTargetCandidate(archiveRoot, item.targetPath),
      ledgerRow
    });
  }
  return prepared;
}

async function freezeArchiveTargets(archiveRoot, preparedItems) {
  const reservedPaths = new Set();
  const frozen = [];
  for (const item of preparedItems) {
    const targetPath = await resolveUniquePath(item.targetCandidatePath, reservedPaths);
    reservedPaths.add(normalizePathKey(targetPath));
    frozen.push({
      photoId: item.photoId,
      sourceType: item.sourceType,
      sourceKey: item.sourceKey,
      sourceIdentity: item.sourceIdentity,
      originalPath: item.originalPath,
      originalName: item.originalName,
      sourceSize: item.sourceSize,
      sourceSha256: item.sourceSha256,
      targetRelativePath: toArchiveTargetRelativePath(archiveRoot, targetPath),
      targetSize: null,
      targetSha256: '',
      ledgerRow: {
        ...item.ledgerRow,
        newFileName: path.basename(targetPath)
      }
    });
  }
  return frozen;
}

async function processArchiveTransaction(archiveRoot, inputTransaction, options = {}) {
  let transaction = inputTransaction;
  const copyFile = options.copyFile || fs.copyFile.bind(fs);

  for (let index = 0; index < transaction.items.length; index += 1) {
    const item = transaction.items[index];
    if (item.stage === 'committed') continue;
    const targetPath = resolveArchiveTargetPath(archiveRoot, item.targetRelativePath);
    const existing = await inspectFrozenTarget(targetPath, item, options);

    if (existing.exists) {
      if (!existing.matches) {
        transaction = await updateTransactionItem(archiveRoot, transaction, index, {
          stage: 'target_conflict',
          errorCode: 'archive_target_conflict',
          errorMessage: '归档目标位置存在其他文件，已拒绝覆盖。'
        });
        continue;
      }
      transaction = await markItemLedgerPending(archiveRoot, transaction, index, existing);
      continue;
    }

    if (!options.allowCopy) {
      if (['copied', 'ledger_pending'].includes(item.stage)) {
        transaction = await updateTransactionItem(archiveRoot, transaction, index, {
          stage: 'copy_failed',
          errorCode: 'archive_target_missing',
          errorMessage: '已记录的归档文件不存在，需要人工重新执行归档。'
        });
      } else {
        transaction = await updateTransactionItem(archiveRoot, transaction, index, {
          errorCode: 'archive_retry_required',
          errorMessage: '该照片尚未完成复制，需要用户重新执行归档。'
        });
      }
      continue;
    }

    transaction = await updateTransactionItem(archiveRoot, transaction, index, {
      stage: 'copying',
      errorCode: '',
      errorMessage: ''
    });
    try {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await copyFile(item.originalPath, targetPath, fsSync.constants.COPYFILE_EXCL);
      const copied = await inspectFrozenTarget(targetPath, item, options);
      if (!copied.exists || !copied.matches) {
        transaction = await updateTransactionItem(archiveRoot, transaction, index, {
          stage: 'target_conflict',
          errorCode: 'archive_copy_verification_failed',
          errorMessage: '照片复制后校验失败，已停止后续台账写入。'
        });
        continue;
      }
      transaction = await updateTransactionItem(archiveRoot, transaction, index, {
        stage: 'copied',
        targetSize: copied.size,
        targetSha256: copied.sha256,
        copiedAt: new Date().toISOString(),
        errorCode: '',
        errorMessage: ''
      });
      transaction = await updateTransactionItem(archiveRoot, transaction, index, {
        stage: 'ledger_pending'
      });
    } catch (error) {
      if (error.code === 'EEXIST') {
        const concurrent = await inspectFrozenTarget(targetPath, item, options);
        if (concurrent.exists && concurrent.matches) {
          transaction = await markItemLedgerPending(archiveRoot, transaction, index, concurrent);
          continue;
        }
        transaction = await updateTransactionItem(archiveRoot, transaction, index, {
          stage: 'target_conflict',
          errorCode: 'archive_target_conflict',
          errorMessage: '归档目标位置存在其他文件，已拒绝覆盖。'
        });
        continue;
      }
      transaction = await updateTransactionItem(archiveRoot, transaction, index, {
        stage: 'copy_failed',
        errorCode: normalizeCopyErrorCode(error),
        errorMessage: '照片复制失败，原图保持不变，可稍后重试。'
      });
    }
  }

  const ledgerPendingIndexes = transaction.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.stage === 'ledger_pending');
  if (ledgerPendingIndexes.length > 0) {
    try {
      const ledgerResult = await appendLedgerRows(
        archiveRoot,
        ledgerPendingIndexes.map(({ item }) => buildLedgerCommitInput(archiveRoot, item)),
        options.excelOptions || {}
      );
      if (typeof options.hooks?.afterLedgerAppend === 'function') {
        await options.hooks.afterLedgerAppend(ledgerResult);
      }
      const committedKeys = new Set(ledgerResult.committedArchivePaths.map(normalizePathKey));
      for (const { item, index } of ledgerPendingIndexes) {
        const targetPath = resolveArchiveTargetPath(archiveRoot, item.targetRelativePath);
        if (!committedKeys.has(normalizePathKey(targetPath))) continue;
        transaction = await updateTransactionItem(archiveRoot, transaction, index, {
          stage: 'committed',
          committedAt: new Date().toISOString(),
          errorCode: '',
          errorMessage: ''
        });
      }
    } catch (error) {
      const safeError = normalizeLedgerError(error);
      for (const { index } of ledgerPendingIndexes) {
        transaction = await updateTransactionItem(archiveRoot, transaction, index, {
          stage: 'ledger_pending',
          errorCode: safeError.code,
          errorMessage: safeError.message
        });
      }
    }
  }

  let fingerprintIndexWarning = '';
  const committedInputs = transaction.items
    .filter((item) => item.stage === 'committed')
    .map((item) => buildLedgerCommitInput(archiveRoot, item));
  if (committedInputs.length > 0) {
    try {
      await recordArchivedPhotoFingerprints(archiveRoot, committedInputs);
    } catch {
      fingerprintIndexWarning = '照片和台账已归档，但内容指纹索引暂未更新，可稍后重新扫描恢复。';
      console.warn('[archive-fingerprint] committed archive fingerprint update deferred');
    }
  }
  return buildArchiveTransactionResult(archiveRoot, transaction, fingerprintIndexWarning);
}

async function markItemLedgerPending(archiveRoot, transaction, index, inspected) {
  let next = transaction;
  if (!['copied', 'ledger_pending'].includes(transaction.items[index].stage)) {
    next = await updateTransactionItem(archiveRoot, next, index, {
      stage: 'copied',
      targetSize: inspected.size,
      targetSha256: inspected.sha256,
      copiedAt: transaction.items[index].copiedAt || new Date().toISOString(),
      errorCode: '',
      errorMessage: ''
    });
  }
  return updateTransactionItem(archiveRoot, next, index, {
    stage: 'ledger_pending',
    targetSize: inspected.size,
    targetSha256: inspected.sha256,
    errorCode: '',
    errorMessage: ''
  });
}

async function updateTransactionItem(archiveRoot, transaction, index, patch) {
  const next = JSON.parse(JSON.stringify(transaction));
  next.items[index] = { ...next.items[index], ...patch };
  next.state = calculateArchiveTransactionState(next.items);
  return saveArchiveTransaction(archiveRoot, next);
}

async function inspectFrozenTarget(targetPath, item, options = {}) {
  try {
    const stat = await fs.stat(targetPath);
    if (!stat.isFile()) return { exists: true, matches: false, size: stat.size, sha256: '' };
    const sha256 = await (options.hashFile || hashFile)(targetPath);
    return {
      exists: true,
      matches: stat.size === Number(item.sourceSize) && sha256 === item.sourceSha256,
      size: stat.size,
      sha256
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, matches: false, size: 0, sha256: '' };
    return { exists: true, matches: false, size: 0, sha256: '' };
  }
}

function buildLedgerRow(item) {
  return {
    date: String(item.date || '').trim(),
    project: String(item.project || '').trim(),
    watermarkCategory: String(item.watermarkCategory || '').trim(),
    workContent: String(item.workContent || '').trim(),
    location: String(item.location || '').trim() || '现场',
    newFileName: String(item.newFileName || '').trim(),
    originalName: String(item.originalName || '').trim(),
    keywords: String(item.keywords || '').trim(),
    remark: String(item.remark || '').trim(),
    archivedAt: dayjs().format('YYYY-MM-DD HH:mm:ss')
  };
}

function buildLedgerCommitInput(archiveRoot, item) {
  const targetPath = resolveArchiveTargetPath(archiveRoot, item.targetRelativePath);
  return {
    ...item.ledgerRow,
    id: item.photoId,
    photoId: item.photoId,
    sourceKey: item.sourceKey,
    targetPath,
    newFileName: path.basename(targetPath),
    targetSize: item.targetSize,
    targetSha256: item.targetSha256 || item.sourceSha256,
    sourceSize: item.sourceSize,
    sourceSha256: item.sourceSha256,
    status: '归档成功'
  };
}

function buildArchiveTransactionResult(archiveRoot, transaction, fingerprintIndexWarning = '') {
  const items = transaction.items.map((item) => {
    const archivedPath = resolveArchiveTargetPath(archiveRoot, item.targetRelativePath);
    const committed = item.stage === 'committed';
    const pending = item.stage === 'ledger_pending';
    const failed = item.stage === 'copy_failed';
    const conflict = item.stage === 'target_conflict';
    return {
      id: item.photoId,
      photoId: item.photoId,
      sourceKey: item.sourceKey,
      stage: item.stage,
      status: committed ? '归档成功' : pending ? '台账待补记' : conflict ? '目标冲突' : failed ? '归档失败' : '待重试',
      archivedPath,
      targetPath: archivedPath,
      newFileName: path.basename(archivedPath),
      originalName: item.originalName,
      recoverable: pending,
      errorCode: item.errorCode,
      message: item.errorMessage,
      error: item.errorMessage,
      archivedAt: item.ledgerRow.archivedAt,
      ...item.ledgerRow
    };
  });
  const committedCount = items.filter((item) => item.stage === 'committed').length;
  const pendingLedgerCount = items.filter((item) => item.stage === 'ledger_pending').length;
  const failedCount = items.filter((item) => item.stage === 'copy_failed').length;
  const conflictCount = items.filter((item) => item.stage === 'target_conflict').length;
  const copiedCount = committedCount + pendingLedgerCount;
  const status = pendingLedgerCount > 0
    ? 'ledger_pending'
    : committedCount === items.length
      ? 'committed'
      : committedCount > 0
        ? 'partial'
        : 'failed';
  return {
    success: status === 'committed',
    recoverable: pendingLedgerCount > 0,
    transactionId: transaction.transactionId,
    status,
    inputCount: items.length,
    total: items.length,
    copiedCount,
    committedCount,
    successCount: committedCount,
    pendingLedgerCount,
    failedCount,
    conflictCount,
    fingerprintIndexWarning,
    items
  };
}

function buildPreflightFailureResult(items, error) {
  const errorCode = error?.code || 'archive_preflight_failed';
  const message = error instanceof ArchiveServiceError
    ? error.message
    : '归档前检查失败，照片尚未复制。';
  const results = items.map((item) => ({
    id: String(item.id || item.photoId || '').trim(),
    photoId: String(item.id || item.photoId || '').trim(),
    sourceKey: String(item.sourceKey || '').trim(),
    stage: 'copy_failed',
    status: '归档失败',
    archivedPath: '',
    targetPath: String(item.targetPath || '').trim(),
    newFileName: String(item.newFileName || '').trim(),
    originalName: String(item.originalName || '').trim(),
    recoverable: false,
    errorCode,
    message,
    error: message
  }));
  return {
    success: false,
    recoverable: false,
    transactionId: '',
    status: 'failed',
    inputCount: results.length,
    total: results.length,
    copiedCount: 0,
    committedCount: 0,
    successCount: 0,
    pendingLedgerCount: 0,
    failedCount: results.length,
    conflictCount: 0,
    fingerprintIndexWarning: '',
    items: results
  };
}

function validateArchivePlan(archivePlan) {
  if (!archivePlan?.archiveRoot) throw new ArchiveServiceError('archive_root_missing', '缺少归档根目录。');
  if (!Array.isArray(archivePlan.items) || archivePlan.items.length === 0) {
    throw new ArchiveServiceError('archive_items_missing', '没有可归档的照片。');
  }
}

function resolveSafeTargetCandidate(archiveRoot, targetPath) {
  const root = path.resolve(archiveRoot);
  const target = path.resolve(String(targetPath || ''));
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ArchiveServiceError('archive_target_invalid', '归档目标路径无效。');
  }
  return target;
}

function normalizeCopyErrorCode(error) {
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'archive_copy_permission_denied';
  if (error?.code === 'ENOSPC') return 'archive_copy_disk_full';
  if (error?.code === 'ENOENT') return 'archive_source_missing';
  return 'archive_copy_failed';
}

function normalizeLedgerError(error) {
  if (error instanceof LedgerWriteError) return { code: error.code, message: error.message };
  return {
    code: 'ledger_write_failed',
    message: '台账暂时无法写入，照片文件已保留，可稍后重试补记。'
  };
}

function validatePreviewPayload(form, photos, archiveRoot) {
  if (!String(archiveRoot || '').trim()) throw new Error('请先选择归档根目录');
  if (!Array.isArray(photos) || photos.length === 0) throw new Error('请先扫描照片');
  if (!String(form?.project || '').trim()) throw new Error('请选择项目');
  if (!String(form?.watermarkCategory || '').trim()) throw new Error('请选择归档分类');
  if (!String(form?.workContent || '').trim()) throw new Error('请选择工作内容');
  if (!String(form?.date || '').trim()) throw new Error('请选择日期');
}

function mergePhotoOverrides(form, photo) {
  const item = {
    ...form,
    project: photo.project || form.project,
    watermarkCategory: photo.watermarkCategory || form.watermarkCategory,
    workContent: photo.workContent || form.workContent,
    location: photo.location ?? form.location,
    date: photo.date || form.date,
    keywords: photo.keywords ?? form.keywords,
    remark: photo.remark ?? form.remark
  };
  return normalizeArchiveItem(item);
}

function normalizeArchiveItem(item) {
  const location = String(item.location || '').trim() || '现场';
  return {
    ...item,
    location
  };
}

function buildTargetDirectory(archiveRoot, item) {
  const date = dayjs(item.date);
  return path.join(
    archiveRoot,
    sanitizeSegment(item.project, 40),
    date.format('YYYY'),
    `${date.format('MM')}月`,
    sanitizeSegment(item.watermarkCategory, 40),
    sanitizeSegment(item.workContent, 50),
    sanitizeSegment(`${item.date}_${item.location}`, 90)
  );
}

function buildFileName(item, extension, index) {
  const parts = [
    item.date,
    item.workContent,
    item.location,
    String(index).padStart(3, '0')
  ];
  const baseName = truncateFileName(parts.map((part) => sanitizeSegment(part, 45)).join('_'), 120);
  return `${baseName}${extension}`;
}

function sanitizeSegment(value, maxLength = 80) {
  const text = String(value || '').replace(ILLEGAL_FILENAME_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return truncateFileName(text || '未填写', maxLength);
}

function truncateFileName(value, maxLength) {
  return value.length > maxLength ? value.slice(0, maxLength).trim() : value;
}

async function resolveUniquePath(targetPath, reservedPaths = new Set()) {
  const parsed = path.parse(targetPath);
  let candidate = targetPath;
  let counter = 1;

  while (reservedPaths.has(normalizePathKey(candidate)) || await exists(candidate)) {
    candidate = path.join(parsed.dir, `${parsed.name}_${String(counter).padStart(2, '0')}${parsed.ext}`);
    counter += 1;
  }

  return candidate;
}

function normalizePathKey(targetPath) {
  return path.resolve(targetPath).toLowerCase();
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  ArchiveServiceError,
  archivePhotos,
  buildArchivePreview,
  recoverPendingArchiveTransactions
};
