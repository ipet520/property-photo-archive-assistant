const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const dayjs = require('dayjs');
const { inspectDirectoryHealth } = require('./directoryHealthService.cjs');
const { appendLedgerRows, LedgerWriteError } = require('./excelService.cjs');
const { recordArchivedPhotoFingerprints } = require('./archiveFingerprintService.cjs');
const {
  ArchivePreviewPlanError,
  buildArchivePreviewItems,
  createArchivePreviewPlan,
  normalizeArchivePreviewPlan,
  toTransactionItems,
  validateArchivePreviewPlanItemsForExecution
} = require('./archivePreviewPlanService.cjs');
const {
  ArchiveTransactionError,
  calculateArchiveTransactionState,
  createArchiveTransaction,
  findArchiveTransactionByOperationKey,
  hashFile,
  listPendingArchiveTransactions,
  loadArchiveTransaction,
  resolveArchiveTargetPath,
  saveArchiveTransaction,
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
  const { form, photos, archiveRoot, activeProject } = payload;
  validatePreviewPayload(form, photos, archiveRoot);

  const previewInputs = [];
  for (let index = 0; index < photos.length; index += 1) {
    const photo = photos[index];
    const item = mergePhotoOverrides(form, photo);
    item.projectId = String(activeProject?.projectId || photo.projectId || '').trim();
    const targetDirectory = buildTargetDirectory(archiveRoot, item);
    const newFileName = buildFileName(item, photo.extension, index + 1);
    const targetPath = path.join(targetDirectory, newFileName);
    previewInputs.push({
      photoId: photo.id,
      sourcePath: photo.path || photo.sourcePath,
      originalName: photo.name || photo.originalName,
      extension: photo.extension,
      sourceType: photo.sourceType || (photo.sourceKey ? 'marki_api' : 'local_file'),
      sourceKey: photo.sourceKey || '',
      targetPath,
      ledgerRow: buildLedgerRow({
        ...item,
        photoId: photo.id,
        sourceType: photo.sourceType || (photo.sourceKey ? 'marki_api' : 'local_file'),
        sourceKey: photo.sourceKey || '',
        sourcePath: photo.path || photo.sourcePath,
        watermarkTemplateType: photo.watermarkTemplateType || item.watermarkTemplateType,
        processingMode: photo.processingMode
          || photo.sourceAwareProcessing?.strategy
          || item.processingMode
      })
    });
  }
  const previewPlan = await createArchivePreviewPlan({
    projectId: activeProject?.projectId,
    projectName: activeProject?.projectName,
    archiveRoot,
    items: previewInputs
  });
  return {
    success: true,
    previewPlan,
    items: buildArchivePreviewItems(previewPlan)
  };
}

async function archivePhotos(archivePlan, options = {}) {
  validateArchivePlan(archivePlan);
  const suppliedTransactionId = String(archivePlan.transactionId || '').trim();

  if (suppliedTransactionId) {
    const archiveRoot = path.resolve(String(archivePlan.archiveRoot || '').trim());
    const loaded = await loadArchiveTransaction(archiveRoot, suppliedTransactionId);
    return withArchiveTransactionLock(`operation:${loaded.operationKey}`, async () => {
      const transaction = await loadArchiveTransaction(archiveRoot, suppliedTransactionId);
      return processArchiveTransaction(archiveRoot, transaction, { ...options, allowCopy: true });
    });
  }

  const previewPlan = normalizeArchivePreviewPlan(archivePlan.previewPlan);
  const archiveRoot = previewPlan.archiveRoot;
  const operationKey = previewPlan.planId;
  return withArchiveTransactionLock(`operation:${operationKey}`, async () => {
    let transaction = await findArchiveTransactionByOperationKey(archiveRoot, operationKey);
    if (!transaction) {
      const preflight = await validateArchivePreviewPlanItemsForExecution(previewPlan, options);
      const preflightByItemId = new Map(preflight.items.map((item) => [item.itemId, item]));
      transaction = createArchiveTransaction({
        operationKey,
        items: toTransactionItems(previewPlan)
      });
      transaction = {
        ...transaction,
        items: transaction.items.map((item) => ({
          ...item,
          ...(preflightByItemId.get(item.itemId)?.valid === false
            ? {
                stage: preflightByItemId.get(item.itemId).stage,
                errorCode: preflightByItemId.get(item.itemId).errorCode,
                errorMessage: preflightByItemId.get(item.itemId).message
              }
            : {}),
          ledgerRow: {
            ...item.ledgerRow,
            transactionId: transaction.transactionId
          }
        }))
      };
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

async function recoverPendingArchiveTransactionsAcrossRoots(archiveRoots, options = {}) {
  const roots = uniqueArchiveRoots(archiveRoots);
  const inspectRoot = options.inspectRoot || ((archiveRoot) => inspectDirectoryHealth(archiveRoot, {
    readable: true,
    writable: true,
    allowCreate: false,
    checkOnly: true
  }));
  const recoverRoot = options.recoverRoot || recoverPendingArchiveTransactions;
  const summary = {
    success: true,
    recoveredTransactionCount: 0,
    transactionCount: 0,
    committedCount: 0,
    pendingLedgerCount: 0,
    retryRequiredCount: 0,
    conflictCount: 0,
    errors: [],
    transactions: []
  };

  for (const archiveRoot of roots) {
    try {
      const health = await inspectRoot(archiveRoot);
      if (health?.healthStatus !== 'healthy') {
        summary.errors.push({
          archiveRoot,
          errorCode: 'project_archive_directory_invalid',
          message: '历史归档目录当前不可用，已跳过该目录的事务恢复。'
        });
        continue;
      }
      const result = await recoverRoot(archiveRoot);
      summary.recoveredTransactionCount += Number(result?.recoveredTransactionCount || 0);
      summary.transactionCount += Number(result?.transactionCount || 0);
      summary.committedCount += Number(result?.committedCount || 0);
      summary.pendingLedgerCount += Number(result?.pendingLedgerCount || 0);
      summary.retryRequiredCount += Number(result?.retryRequiredCount || 0);
      summary.conflictCount += Number(result?.conflictCount || 0);
      summary.errors.push(...(result?.errors || []).map((error) => ({
        ...error,
        archiveRoot
      })));
      summary.transactions.push(...(result?.transactions || []).map((transaction) => ({
        ...transaction,
        archiveRoot
      })));
    } catch (error) {
      const knownError = /^(archive|ledger|project_archive)_/.test(String(error?.code || ''));
      summary.errors.push({
        archiveRoot,
        errorCode: knownError ? String(error.code) : 'archive_recovery_failed',
        message: knownError
          ? String(error.message || '历史归档目录事务恢复失败。')
          : '历史归档目录事务恢复失败，请稍后重试。'
      });
    }
  }
  summary.success = summary.errors.length === 0;
  return summary;
}

function uniqueArchiveRoots(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : []).reduce((result, value) => {
    const text = String(value || '').trim();
    if (!text) return result;
    const normalized = path.resolve(text);
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) return result;
    seen.add(key);
    result.push(normalized);
    return result;
  }, []);
}

async function processArchiveTransaction(archiveRoot, inputTransaction, options = {}) {
  let transaction = inputTransaction;
  const copyFile = options.copyFile || fs.copyFile.bind(fs);
  const linkFile = options.linkFile || fs.link.bind(fs);

  for (let index = 0; index < transaction.items.length; index += 1) {
    const item = transaction.items[index];
    if (item.stage === 'committed' || isFrozenPreflightFailure(item)) continue;
    const targetPath = resolveArchiveTargetPath(archiveRoot, item.targetRelativePath);
    const stagingPath = buildArchiveStagingPath(targetPath, transaction, item);
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
      await removeOwnedStagingFile(stagingPath);
      continue;
    }

    let staged = await inspectFrozenTarget(stagingPath, item, options);
    if (!staged.exists && !options.allowCopy) {
      if (['copying', 'copied', 'ledger_pending'].includes(item.stage)) {
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

    try {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      if (!staged.exists) {
        transaction = await updateTransactionItem(archiveRoot, transaction, index, {
          stage: 'copying',
          errorCode: '',
          errorMessage: ''
        });
        await copyFile(item.originalPath, stagingPath, fsSync.constants.COPYFILE_EXCL);
        await syncFile(stagingPath);
        staged = await inspectFrozenTarget(stagingPath, item, options);
      }
      if (!staged.exists || !staged.matches) {
        await removeOwnedStagingFile(stagingPath);
        transaction = await updateTransactionItem(archiveRoot, transaction, index, {
          stage: 'copy_failed',
          errorCode: 'archive_copy_verification_failed',
          errorMessage: '照片复制后校验失败，已停止后续台账写入。'
        });
        continue;
      }
      try {
        await linkFile(stagingPath, targetPath);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      const installed = await inspectFrozenTarget(targetPath, item, options);
      if (!installed.exists || !installed.matches) {
        transaction = await updateTransactionItem(archiveRoot, transaction, index, {
          stage: 'target_conflict',
          errorCode: 'archive_target_conflict',
          errorMessage: '归档目标位置存在其他文件，已拒绝覆盖。'
        });
        continue;
      }
      await removeOwnedStagingFile(stagingPath);
      transaction = await updateTransactionItem(archiveRoot, transaction, index, {
        stage: 'copied',
        targetSize: installed.size,
        targetSha256: installed.sha256,
        copiedAt: new Date().toISOString(),
        errorCode: '',
        errorMessage: ''
      });
      transaction = await updateTransactionItem(archiveRoot, transaction, index, {
        stage: 'ledger_pending'
      });
    } catch (error) {
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

function isFrozenPreflightFailure(item = {}) {
  return item.stage === 'target_conflict'
    || (
      item.stage === 'copy_failed'
      && String(item.errorCode || '').startsWith('archive_preview_')
    );
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
    projectId: String(item.projectId || '').trim(),
    project: String(item.project || '').trim(),
    watermarkCategory: String(item.watermarkCategory || '').trim(),
    workContent: String(item.workContent || '').trim(),
    location: String(item.location || '').trim() || '现场',
    newFileName: String(item.newFileName || '').trim(),
    originalName: String(item.originalName || '').trim(),
    keywords: String(item.keywords || '').trim(),
    remark: String(item.remark || '').trim(),
    archivedAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
    sourceType: String(item.sourceType || '').trim(),
    sourceKey: String(item.sourceKey || '').trim(),
    photoId: String(item.photoId || item.id || '').trim(),
    sourcePath: String(item.sourcePath || item.path || '').trim(),
    sourceSha256: String(item.sourceSha256 || '').trim(),
    archiveSha256: String(item.archiveSha256 || '').trim(),
    transactionId: String(item.transactionId || '').trim(),
    watermarkTemplateType: String(item.watermarkTemplateType || '').trim(),
    processingMode: String(item.processingMode || '').trim(),
    vehiclePlate: String(item.vehiclePlate || '').trim(),
    violationType: String(item.violationType || '').trim(),
    constructionUnitId: String(item.constructionUnitId || '').trim(),
    constructionUnitName: String(item.constructionUnitName || '').trim(),
    constructionUnitOriginalText: String(item.constructionUnitOriginalText || '').trim(),
    constructionUnitConfirmed: item.constructionUnitConfirmed === true ? 'true' : '',
    constructionUnitSource: String(item.constructionUnitSource || '').trim()
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
    archiveSha256: item.targetSha256 || item.sourceSha256,
    sourceSize: item.sourceSize,
    sourceSha256: item.sourceSha256,
    status: '归档成功',
    transactionId: item.ledgerRow.transactionId || ''
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
      transactionId: transaction.transactionId,
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
  const message = error instanceof ArchiveServiceError || error instanceof ArchivePreviewPlanError
    ? error.message
    : '归档前检查失败，照片尚未复制。';
  const conflict = errorCode === 'archive_preview_target_conflict';
  const results = items.map((item) => ({
    id: String(item.id || item.photoId || '').trim(),
    photoId: String(item.id || item.photoId || '').trim(),
    sourceKey: String(item.sourceKey || '').trim(),
    stage: conflict ? 'target_conflict' : 'copy_failed',
    status: conflict ? '目标冲突' : '归档失败',
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
    failedCount: conflict ? 0 : results.length,
    conflictCount: conflict ? results.length : 0,
    fingerprintIndexWarning: '',
    items: results
  };
}

function validateArchivePlan(archivePlan) {
  if (!archivePlan || typeof archivePlan !== 'object' || Array.isArray(archivePlan)) {
    throw new ArchiveServiceError('archive_plan_invalid', '归档执行参数无效。');
  }
  if (archivePlan.transactionId) {
    if (!archivePlan.archiveRoot) throw new ArchiveServiceError('archive_root_missing', '缺少归档根目录。');
    return;
  }
  if (!archivePlan.previewPlan) {
    throw new ArchiveServiceError('archive_preview_plan_missing', '归档预览计划不存在，请重新生成预览。');
  }
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
  if (
    String(form?.watermarkTemplateType || '').trim() !== 'time_location'
    && !String(form?.workContent || '').trim()
  ) {
    throw new Error('请选择工作内容');
  }
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
    remark: photo.remark ?? form.remark,
    vehiclePlate: photo.vehiclePlate ?? form.vehiclePlate,
    violationType: photo.violationType ?? form.violationType,
    constructionUnitId: photo.constructionUnitId ?? form.constructionUnitId,
    constructionUnitName: photo.constructionUnitName ?? form.constructionUnitName,
    constructionUnitOriginalText: photo.constructionUnitOriginalText
      ?? form.constructionUnitOriginalText,
    constructionUnitConfirmed: photo.constructionUnitConfirmed
      ?? form.constructionUnitConfirmed,
    constructionUnitSource: photo.constructionUnitSource ?? form.constructionUnitSource
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

function buildArchiveStagingPath(targetPath, transaction, item) {
  return path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${transaction.transactionId}.${item.itemId}.archive-stage`
  );
}

async function syncFile(filePath) {
  const handle = await fs.open(filePath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeOwnedStagingFile(filePath) {
  try {
    await fs.rm(filePath, { force: true });
  } catch {
    // The transaction can inspect and clean its own staging file on retry.
  }
}

function normalizePathKey(targetPath) {
  return path.resolve(targetPath).toLowerCase();
}

module.exports = {
  ArchiveServiceError,
  ArchivePreviewPlanError,
  archivePhotos,
  buildArchivePreview,
  recoverPendingArchiveTransactions,
  recoverPendingArchiveTransactionsAcrossRoots
};
