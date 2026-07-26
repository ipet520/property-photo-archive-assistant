const fs = require('node:fs/promises');
const path = require('node:path');
const {
  getMarkiImportRoot,
  getMarkiSourceRecordByKey,
  loadMarkiSourceManifest
} = require('./markiSourceManifestService.cjs');
const {
  loadSortWorkspaceSnapshot,
  saveSortWorkspaceSnapshot
} = require('./sortWorkspaceSnapshotService.cjs');
const {
  getMarkiImportBatch,
  listReadyMarkiImportBatches
} = require('./markiImportBatchService.cjs');

const LEDGER_FILE_NAME = 'marki-import-lifecycle.json';
const LEDGER_VERSION = 1;
const BATCH_STATUSES = new Set([
  'created',
  'downloading',
  'ready_to_append',
  'appending',
  'completed',
  'partial_failed',
  'failed',
  'cancelled',
  'cleared'
]);
const ITEM_STATUSES = new Set([
  'queued',
  'downloading',
  'downloaded',
  'append_pending',
  'imported_active',
  'workspace_file_repairable',
  'failed_retryable',
  'removed_reimportable',
  'archived_locked'
]);
const ACTIVE_ITEM_STATUSES = new Set([
  'queued',
  'downloading',
  'downloaded',
  'append_pending'
]);
const ACTIVE_BATCH_STATUSES = new Set([
  'created',
  'downloading',
  'ready_to_append',
  'appending'
]);
const RETRYABLE_ITEM_STATUSES = new Set([
  'workspace_file_repairable',
  'failed_retryable',
  'removed_reimportable'
]);
const ledgerWriteQueues = new Map();

class MarkiImportLifecycleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MarkiImportLifecycleError';
    this.code = code;
  }
}

async function beginMarkiImportLifecycleBatch(userDataPath, input = {}, options = {}) {
  const normalized = normalizeBeginInput(input);
  return updateLedger(userDataPath, options, (ledger, now) => {
    const existing = ledger.batches[normalized.batchId];
    if (existing) {
      if (!['failed', 'partial_failed'].includes(existing.status)) {
        throw createError('marki_import_lifecycle_state_invalid', '当前导入记录不能重新开始。');
      }
      const existingKeys = existing.items.map((item) => item.sourceKey).sort();
      const nextKeys = normalized.items.map((item) => item.sourceKey).sort();
      if (JSON.stringify(existingKeys) !== JSON.stringify(nextKeys)) {
        throw createError('marki_import_lifecycle_retry_mismatch', '失败导入只能使用原照片集合重试。');
      }
      existing.status = 'downloading';
      existing.updatedAt = now;
      existing.clearedAt = '';
      existing.items = existing.items.map((item) => ({
        ...item,
        status: RETRYABLE_ITEM_STATUSES.has(item.status) ? 'queued' : item.status,
        code: '',
        message: '',
        updatedAt: now
      }));
      return buildSafeRecord(existing);
    }
    const record = {
      batchId: normalized.batchId,
      status: 'created',
      querySummary: normalized.querySummary,
      items: normalized.items.map((item) => ({
        ...item,
        status: 'queued',
        photoId: '',
        code: '',
        message: '',
        createdAt: now,
        updatedAt: now
      })),
      createdAt: now,
      updatedAt: now,
      completedAt: '',
      clearedAt: ''
    };
    ledger.batches[record.batchId] = record;
    return buildSafeRecord(record);
  });
}

async function markMarkiImportLifecycleDownloading(userDataPath, batchId, options = {}) {
  return mutateBatch(userDataPath, batchId, options, (record, now) => {
    record.status = 'downloading';
    record.items = record.items.map((item) => ({
      ...item,
      status: item.status === 'queued' ? 'downloading' : item.status,
      updatedAt: now
    }));
  });
}

async function settleMarkiImportLifecycleDownloads(userDataPath, input = {}, options = {}) {
  const normalized = normalizeItemResultsInput(input);
  return mutateBatch(userDataPath, normalized.batchId, options, (record, now) => {
    const resultBySourceKey = new Map(normalized.items.map((item) => [item.sourceKey, item]));
    record.items = record.items.map((item) => {
      const result = resultBySourceKey.get(item.sourceKey);
      if (!result) return item;
      return {
        ...item,
        status: result.success ? 'downloaded' : 'failed_retryable',
        code: result.success ? '' : result.code,
        message: result.success ? '' : result.message,
        updatedAt: now
      };
    });
    const failedCount = record.items.filter((item) => item.status === 'failed_retryable').length;
    record.status = failedCount === 0
      ? 'downloading'
      : failedCount === record.items.length ? 'failed' : 'partial_failed';
  });
}

async function markMarkiImportLifecycleReady(userDataPath, input = {}, options = {}) {
  const normalized = normalizeReadyInput(input);
  return mutateBatch(userDataPath, normalized.batchId, options, (record, now) => {
    const photoIdBySourceKey = new Map(
      normalized.photos.map((photo) => [photo.sourceKey, photo.photoId])
    );
    record.status = 'ready_to_append';
    record.items = record.items.map((item) => ({
      ...item,
      status: photoIdBySourceKey.has(item.sourceKey) ? 'append_pending' : item.status,
      photoId: photoIdBySourceKey.get(item.sourceKey) || item.photoId,
      code: '',
      message: '',
      updatedAt: now
    }));
  });
}

async function markMarkiImportLifecycleAppending(userDataPath, batchId, options = {}) {
  return mutateBatch(userDataPath, batchId, options, (record, now) => {
    if (record.status === 'completed') return;
    if (!['ready_to_append', 'appending'].includes(record.status)) {
      throw createError(
        'marki_import_lifecycle_state_invalid',
        '当前导入记录尚未准备好进入工作池。'
      );
    }
    record.status = 'appending';
    record.items = record.items.map((item) => ({
      ...item,
      updatedAt: item.status === 'append_pending' ? now : item.updatedAt
    }));
  });
}

async function markMarkiImportLifecycleFailed(userDataPath, input = {}, options = {}) {
  const normalized = normalizeFailureInput(input);
  return mutateBatch(userDataPath, normalized.batchId, options, (record, now) => {
    const failureBySourceKey = new Map(
      normalized.failures.map((failure) => [failure.sourceKey, failure])
    );
    record.items = record.items.map((item) => {
      const failure = failureBySourceKey.get(item.sourceKey);
      if (!failure) return item;
      return {
        ...item,
        status: 'failed_retryable',
        code: failure.code,
        message: failure.message,
        updatedAt: now
      };
    });
    const failedCount = record.items.filter((item) => item.status === 'failed_retryable').length;
    record.status = failedCount === record.items.length ? 'failed' : 'partial_failed';
  });
}

async function completeMarkiImportLifecycleBatch(userDataPath, batchId, options = {}) {
  const snapshotResult = await resolveDependencies(options).loadSnapshot(userDataPath);
  const activeBySourceKey = getWorkspaceSourceState(snapshotResult);
  return mutateBatch(userDataPath, batchId, options, (record, now) => {
    record.items = record.items.map((item) => {
      const workspaceState = activeBySourceKey.get(item.sourceKey);
      if (!workspaceState) {
        return item.status === 'append_pending'
          ? {
              ...item,
              status: 'failed_retryable',
              code: 'marki_import_append_not_persisted',
              message: '照片未在工作池中确认，可重新查询后重试。',
              updatedAt: now
            }
          : item;
      }
      return {
        ...item,
        status: workspaceState.sourceStatus,
        photoId: workspaceState.photoId,
        code: '',
        message: '',
        updatedAt: now
      };
    });
    const unresolved = record.items.filter((item) => (
      !['imported_active', 'archived_locked'].includes(item.status)
    )).length;
    record.status = unresolved === 0 ? 'completed' : 'partial_failed';
    if (unresolved === 0) record.completedAt = now;
  });
}

async function listMarkiImportLifecycleRecords(userDataPath, options = {}) {
  const dependencies = resolveDependencies(options);
  const ledger = await loadLedger(userDataPath, dependencies.fs);
  const snapshotResult = await dependencies.loadSnapshot(userDataPath);
  const activeBySourceKey = getWorkspaceSourceState(snapshotResult);
  const items = Object.values(ledger.batches)
    .filter((record) => record.status !== 'cleared')
    .map((record) => buildSafeRecord(reconcileRecord(record, activeBySourceKey)))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  return {
    success: true,
    items,
    totalCount: items.length
  };
}

async function clearMarkiImportLifecycleRecord(userDataPath, batchId, options = {}) {
  return mutateBatch(userDataPath, batchId, options, (record, now) => {
    if (
      ACTIVE_BATCH_STATUSES.has(record.status)
      || record.items.some((item) => (
        ACTIVE_ITEM_STATUSES.has(item.status)
        || item.status === 'failed_retryable'
        || item.status === 'removed_reimportable'
      ))
    ) {
      throw createError('marki_import_record_not_clearable', '当前导入记录仍有待处理或可重试项目，不能清除。');
    }
    record.status = 'cleared';
    record.clearedAt = now;
  });
}

async function undoMarkiImportLifecycleBatch(userDataPath, batchId, options = {}) {
  const dependencies = resolveDependencies(options);
  const normalizedBatchId = normalizeBatchId(batchId);
  const ledger = await loadLedger(userDataPath, dependencies.fs);
  const record = ledger.batches[normalizedBatchId];
  if (!record) throw createError('marki_import_record_not_found', '未找到对应的导入记录。');
  if (record.status === 'cleared') {
    throw createError('marki_import_record_not_undoable', '该导入记录已清除，不能执行撤销。');
  }
  const targetSourceKeys = new Set(
    record.items
      .filter((item) => item.status === 'imported_active')
      .map((item) => item.sourceKey)
  );
  if (targetSourceKeys.size === 0) {
    throw createError('marki_import_record_not_undoable', '当前导入记录没有可撤销照片。');
  }

  const snapshotResult = await dependencies.loadSnapshot(userDataPath);
  if (snapshotResult?.success !== true || !snapshotResult.found) {
    throw createError('marki_import_undo_snapshot_unavailable', '工作台快照不可用，未执行撤销。');
  }
  const workspace = snapshotResult.snapshot.workspace;
  const blockedSourceKeys = new Set(
    workspace.photos
      .filter((photo) => (
        targetSourceKeys.has(String(photo.sourceKey || '')) && isArchivedPhoto(photo)
      ))
      .map((photo) => String(photo.sourceKey || ''))
  );
  const removableSourceKeys = new Set(
    [...targetSourceKeys].filter((sourceKey) => !blockedSourceKeys.has(sourceKey))
  );
  if (removableSourceKeys.size === 0) {
    throw createError('marki_import_record_archived_locked', '所选照片已经归档，不能撤销导入。');
  }
  const nextWorkspace = removeSourcesFromWorkspace(workspace, removableSourceKeys);
  const saveResult = await dependencies.saveSnapshot(userDataPath, nextWorkspace);
  if (saveResult?.success !== true) {
    throw createError('marki_import_undo_snapshot_failed', '工作台保存失败，未执行撤销。');
  }

  const updated = await mutateBatch(userDataPath, normalizedBatchId, options, (stored, now) => {
    stored.items = stored.items.map((item) => (
      removableSourceKeys.has(item.sourceKey)
        ? {
            ...item,
            status: 'removed_reimportable',
            code: '',
            message: '',
            updatedAt: now
          }
        : item
    ));
    stored.status = stored.items.some((item) => item.status === 'imported_active')
      ? 'completed'
      : 'cancelled';
  });
  return {
    success: true,
    batchId: normalizedBatchId,
    removedCount: removableSourceKeys.size,
    archivedLockedCount: blockedSourceKeys.size,
    record: updated
  };
}

async function cleanupMarkiImportLifecycleCache(
  documentsPath,
  userDataPath,
  batchId,
  options = {}
) {
  const dependencies = resolveDependencies(options);
  const normalizedBatchId = normalizeBatchId(batchId);
  const ledger = await loadLedger(userDataPath, dependencies.fs);
  const record = ledger.batches[normalizedBatchId];
  if (!record) throw createError('marki_import_record_not_found', '未找到对应的导入记录。');
  const snapshotResult = await dependencies.loadSnapshot(userDataPath);
  const activeBySourceKey = getWorkspaceSourceState(snapshotResult);
  const candidates = record.items.filter((item) => (
    RETRYABLE_ITEM_STATUSES.has(item.status) && !activeBySourceKey.has(item.sourceKey)
  ));
  const importRoot = path.resolve(getMarkiImportRoot(documentsPath));
  let removedCount = 0;
  let skippedCount = record.items.length - candidates.length;
  let failedCount = 0;
  for (const item of candidates) {
    try {
      const parsed = parseSourceKey(item.sourceKey);
      const sourceRecord = await dependencies.getSourceRecord(
        documentsPath,
        parsed.orgId,
        item.sourceKey
      );
      const relativePath = String(sourceRecord?.downloadInfo?.relativePath || '');
      if (!relativePath) {
        skippedCount += 1;
        continue;
      }
      const targetPath = path.resolve(importRoot, ...relativePath.split('/'));
      if (!isPathInside(importRoot, targetPath)) {
        throw createError('marki_import_cache_path_invalid', '缓存文件位置无效。');
      }
      await dependencies.fs.rm(targetPath, { force: true });
      removedCount += 1;
    } catch {
      failedCount += 1;
    }
  }
  return {
    success: failedCount === 0,
    batchId: normalizedBatchId,
    removedCount,
    skippedCount,
    failedCount
  };
}

async function recoverMarkiImportLifecycle(userDataPath, options = {}) {
  const dependencies = resolveDependencies(options);
  const snapshotResult = await dependencies.loadSnapshot(userDataPath);
  const activeBySourceKey = getWorkspaceSourceState(snapshotResult);
  const legacyReadyBatches = await loadLegacyReadyBatches(userDataPath, dependencies);
  return updateLedger(userDataPath, options, (ledger, now) => {
    let changedCount = 0;
    for (const batch of legacyReadyBatches) {
      if (ledger.batches[batch.batchId]) continue;
      try {
        ledger.batches[batch.batchId] = buildLegacyReadyRecord(batch, now);
        changedCount += 1;
      } catch {
        // A malformed legacy batch remains isolated in the existing batch service.
      }
    }
    for (const record of Object.values(ledger.batches)) {
      if (record.status === 'cleared') continue;
      const before = JSON.stringify(record);
      record.items = record.items.map((item) => {
        const active = activeBySourceKey.get(item.sourceKey);
        if (active) {
          return {
            ...item,
            status: active.archived ? 'archived_locked' : 'imported_active',
            photoId: active.photoId,
            code: '',
            message: '',
            updatedAt: now
          };
        }
        if (['queued', 'downloading'].includes(item.status)) {
          return {
            ...item,
            status: 'failed_retryable',
            code: 'marki_import_interrupted',
            message: '导入任务已中断，可重新查询后重试。',
            updatedAt: now
          };
        }
        if (item.status === 'downloaded') {
          return {
            ...item,
            status: 'failed_retryable',
            code: 'marki_import_interrupted',
            message: '照片已下载但导入任务未完成，可重新查询后重试。',
            updatedAt: now
          };
        }
        if (item.status === 'imported_active') {
          return {
            ...item,
            status: 'removed_reimportable',
            code: '',
            message: '',
            updatedAt: now
          };
        }
        return item;
      });
      const activeCount = record.items.filter((item) => (
        ['imported_active', 'archived_locked'].includes(item.status)
      )).length;
      const retryableCount = record.items.filter((item) => (
        RETRYABLE_ITEM_STATUSES.has(item.status)
      )).length;
      const removedCount = record.items.filter((item) => (
        item.status === 'removed_reimportable'
      )).length;
      const appendPendingCount = record.items.filter((item) => (
        item.status === 'append_pending'
      )).length;
      if (activeCount === record.items.length) record.status = 'completed';
      else if (removedCount === record.items.length) record.status = 'cancelled';
      else if (retryableCount === record.items.length) record.status = 'failed';
      else if (retryableCount > 0) record.status = 'partial_failed';
      else if (appendPendingCount > 0) record.status = 'ready_to_append';
      if (JSON.stringify(record) !== before) changedCount += 1;
    }
    return { success: true, changedCount };
  });
}

async function loadLegacyReadyBatches(userDataPath, dependencies) {
  try {
    const result = await dependencies.listReadyBatches(userDataPath);
    const batches = [];
    for (const item of result?.items || []) {
      const batch = await dependencies.getImportBatch(userDataPath, item.batchId);
      if (batch?.status === 'ready' && batch.workbenchImportPackage) batches.push(batch);
    }
    return batches;
  } catch {
    return [];
  }
}

function buildLegacyReadyRecord(batch, now) {
  const photos = Array.isArray(batch.workbenchImportPackage?.photos)
    ? batch.workbenchImportPackage.photos
    : [];
  if (photos.length === 0) {
    throw createError('marki_import_lifecycle_input_invalid', '旧导入批次没有可恢复照片。');
  }
  return {
    batchId: normalizeBatchId(batch.batchId),
    status: 'ready_to_append',
    querySummary: normalizeQuerySummary({
      selectedCount: photos.length
    }),
    items: photos.map((photo, index) => ({
      sourceKey: normalizeSourceKey(photo.sourceKey),
      displayId: String(index + 1),
      markName: '',
      status: 'append_pending',
      photoId: normalizeText(photo.id, 300),
      code: '',
      message: '',
      createdAt: now,
      updatedAt: now
    })),
    createdAt: normalizeOptionalIso(batch.createdAt) || now,
    updatedAt: now,
    completedAt: '',
    clearedAt: ''
  };
}

async function resolveMarkiImportSourceStatuses({
  documentsPath,
  userDataPath,
  orgId,
  sourceKeys
}, options = {}) {
  const dependencies = resolveDependencies(options);
  const manifest = await dependencies.loadManifest(documentsPath, orgId);
  const ledger = await loadLedger(userDataPath, dependencies.fs);
  const snapshotResult = await dependencies.loadSnapshot(userDataPath);
  const activeBySourceKey = getWorkspaceSourceState(snapshotResult);
  const lifecycleBySourceKey = buildLifecycleStateBySourceKey(ledger);
  const bySourceKey = {};
  for (const sourceKey of sourceKeys) {
    const active = activeBySourceKey.get(sourceKey);
    if (active) {
      bySourceKey[sourceKey] = active.sourceStatus;
      continue;
    }
    const lifecycleState = lifecycleBySourceKey.get(sourceKey);
    if (ACTIVE_ITEM_STATUSES.has(lifecycleState)) {
      bySourceKey[sourceKey] = lifecycleState;
      continue;
    }
    if (lifecycleState === 'archived_locked') {
      bySourceKey[sourceKey] = 'archived_locked';
      continue;
    }
    if (RETRYABLE_ITEM_STATUSES.has(lifecycleState)) {
      bySourceKey[sourceKey] = lifecycleState;
      continue;
    }
    const sourceRecord = manifest.records[sourceKey];
    if (!sourceRecord) {
      bySourceKey[sourceKey] = 'discovered';
    } else if (sourceRecord.importStatus === 'imported') {
      bySourceKey[sourceKey] = 'removed_reimportable';
    } else if ([
      'download_failed',
      'downloading',
      'repair_required',
      'repairing',
      'repair_failed'
    ].includes(sourceRecord.importStatus)) {
      bySourceKey[sourceKey] = 'failed_retryable';
    } else {
      bySourceKey[sourceKey] = 'discovered';
    }
  }
  return { success: true, bySourceKey };
}

function buildLifecycleStateBySourceKey(ledger) {
  const entries = Object.values(ledger.batches || {})
    .filter((record) => record.status !== 'cleared')
    .sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt));
  const bySourceKey = new Map();
  for (const record of entries) {
    for (const item of record.items) {
      bySourceKey.set(item.sourceKey, item.status);
    }
  }
  return bySourceKey;
}

function removeSourcesFromWorkspace(workspace, sourceKeys) {
  const removedPhotoIds = new Set(
    workspace.photos
      .filter((photo) => sourceKeys.has(String(photo.sourceKey || '')))
      .map((photo) => String(photo.id))
  );
  const photos = workspace.photos.filter((photo) => !removedPhotoIds.has(String(photo.id)));
  const prunePhotoMap = (input) => Object.fromEntries(
    Object.entries(input || {}).filter(([photoId]) => !removedPhotoIds.has(photoId))
  );
  const smartSortResult = pruneSmartSortResult(workspace.smartSortResult, removedPhotoIds);
  const activeGroupIds = new Set((smartSortResult?.groups || []).map((group) => String(group.id)));
  return {
    ...workspace,
    photos,
    selectedIds: (workspace.selectedIds || []).filter((photoId) => !removedPhotoIds.has(photoId)),
    activePhotoId: removedPhotoIds.has(String(workspace.activePhotoId || ''))
      ? photos[0]?.id || ''
      : workspace.activePhotoId,
    recognitionResultsByPhoto: prunePhotoMap(workspace.recognitionResultsByPhoto),
    watermarkRecordsByPhoto: prunePhotoMap(workspace.watermarkRecordsByPhoto),
    archiveSuggestionsByPhoto: prunePhotoMap(workspace.archiveSuggestionsByPhoto),
    photoDraftByPhotoId: prunePhotoMap(workspace.photoDraftByPhotoId),
    groupDraftByGroupId: Object.fromEntries(
      Object.entries(workspace.groupDraftByGroupId || {})
        .filter(([groupId]) => activeGroupIds.has(groupId))
    ),
    smartSortResult,
    activeSmartSortGroupId: activeGroupIds.has(String(workspace.activeSmartSortGroupId || ''))
      ? workspace.activeSmartSortGroupId
      : '',
    smartSortViewMode: activeGroupIds.size > 0 ? workspace.smartSortViewMode : 'statusFilter'
  };
}

function pruneSmartSortResult(input, removedPhotoIds) {
  if (!input || typeof input !== 'object') return null;
  const groups = (Array.isArray(input.groups) ? input.groups : [])
    .map((group) => {
      const photoIds = (Array.isArray(group.photoIds) ? group.photoIds : [])
        .filter((photoId) => !removedPhotoIds.has(String(photoId)));
      const photos = (Array.isArray(group.photos) ? group.photos : [])
        .filter((photo) => !removedPhotoIds.has(String(photo?.id || photo?.photoId || '')));
      return {
        ...group,
        ...(Array.isArray(group.photoIds) ? { photoIds } : {}),
        ...(Array.isArray(group.photos) ? { photos } : {}),
        photoCount: Array.isArray(group.photoIds) ? photoIds.length : photos.length
      };
    })
    .filter((group) => Number(group.photoCount) > 0);
  return {
    ...input,
    groups,
    groupCount: groups.length,
    photoCount: groups.reduce((sum, group) => sum + Number(group.photoCount || 0), 0)
  };
}

function buildSafeRecord(record) {
  const counts = countRecordItems(record.items, record.querySummary);
  return {
    batchId: record.batchId,
    status: record.status,
    querySummary: { ...record.querySummary },
    totalCount: record.items.length,
    ...counts,
    hasRetryableItems: counts.retryableCount > 0,
    hasActivePhotos: counts.activeCount > 0,
    items: record.items.map((item) => ({
      displayId: item.displayId,
      markName: item.markName,
      status: item.status,
      code: item.code,
      message: item.message
    })),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
    clearedAt: record.clearedAt
  };
}

function countRecordItems(items, querySummary = {}) {
  const count = (statuses) => items.filter((item) => statuses.has(item.status)).length;
  return {
    filteredCount: normalizeCount(querySummary.unwatermarkedCount)
      + normalizeCount(querySummary.watermarkUnknownCount),
    duplicateCount: normalizeCount(querySummary.duplicateCount),
    downloadedCount: count(new Set(['downloaded', 'append_pending', 'imported_active', 'archived_locked'])),
    appendedCount: count(new Set(['imported_active', 'archived_locked'])),
    failedCount: count(new Set(['failed_retryable'])),
    retryableCount: count(RETRYABLE_ITEM_STATUSES),
    removedCount: count(new Set(['removed_reimportable'])),
    activeCount: count(new Set(['imported_active', 'archived_locked']))
  };
}

function reconcileRecord(record, activeBySourceKey) {
  return {
    ...record,
    items: record.items.map((item) => {
      const active = activeBySourceKey.get(item.sourceKey);
      if (active) {
        return {
          ...item,
          status: active.sourceStatus,
          photoId: active.photoId
        };
      }
      if (item.status === 'imported_active') {
        return { ...item, status: 'removed_reimportable' };
      }
      return item;
    })
  };
}

async function mutateBatch(userDataPath, batchId, options, mutate) {
  const normalizedBatchId = normalizeBatchId(batchId);
  return updateLedger(userDataPath, options, (ledger, now) => {
    const record = ledger.batches[normalizedBatchId];
    if (!record) throw createError('marki_import_record_not_found', '未找到对应的导入记录。');
    mutate(record, now);
    record.updatedAt = now;
    if (!BATCH_STATUSES.has(record.status)) {
      throw createError('marki_import_lifecycle_state_invalid', '导入记录状态无效。');
    }
    return buildSafeRecord(record);
  });
}

async function updateLedger(userDataPath, options, action) {
  const dependencies = resolveDependencies(options);
  const ledgerPath = getLedgerPath(userDataPath);
  return withWriteLock(ledgerPath, async () => {
    const ledger = await loadLedger(userDataPath, dependencies.fs);
    const now = resolveNow(options);
    const result = await action(ledger, now);
    ledger.updatedAt = now;
    await writeLedger(ledgerPath, ledger, dependencies.fs);
    return result;
  });
}

async function loadLedger(userDataPath, fileSystem = fs) {
  const ledgerPath = getLedgerPath(userDataPath);
  try {
    return normalizeLedger(JSON.parse(await fileSystem.readFile(ledgerPath, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { version: LEDGER_VERSION, updatedAt: '', batches: {} };
    }
    if (error instanceof MarkiImportLifecycleError) throw error;
    throw createError('marki_import_lifecycle_invalid', '马克导入记录损坏，已停止处理。');
  }
}

async function writeLedger(ledgerPath, ledger, fileSystem) {
  await fileSystem.mkdir(path.dirname(ledgerPath), { recursive: true });
  const temporaryPath = `${ledgerPath}.${process.pid}.${Date.now()}.tmp`;
  let handle;
  try {
    handle = await fileSystem.open(temporaryPath, 'wx');
    await handle.writeFile(`${JSON.stringify(normalizeLedger(ledger), null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fileSystem.rename(temporaryPath, ledgerPath);
  } catch {
    if (handle) await handle.close().catch(() => {});
    await fileSystem.rm(temporaryPath, { force: true }).catch(() => {});
    throw createError('marki_import_lifecycle_save_failed', '马克导入记录保存失败，请重试。');
  }
}

function normalizeLedger(input) {
  if (!isPlainObject(input) || Number(input.version) !== LEDGER_VERSION || !isPlainObject(input.batches)) {
    throw createError('marki_import_lifecycle_invalid', '马克导入记录格式无效。');
  }
  const batches = {};
  for (const [batchId, value] of Object.entries(input.batches)) {
    const normalizedBatchId = normalizeBatchId(batchId);
    if (!isPlainObject(value) || value.batchId !== normalizedBatchId) {
      throw createError('marki_import_lifecycle_invalid', '马克导入批次记录无效。');
    }
    const status = normalizeEnum(value.status, BATCH_STATUSES, '批次状态');
    const items = normalizeStoredItems(value.items);
    batches[normalizedBatchId] = {
      batchId: normalizedBatchId,
      status,
      querySummary: normalizeQuerySummary(value.querySummary),
      items,
      createdAt: normalizeIso(value.createdAt),
      updatedAt: normalizeIso(value.updatedAt),
      completedAt: normalizeOptionalIso(value.completedAt),
      clearedAt: normalizeOptionalIso(value.clearedAt)
    };
  }
  return {
    version: LEDGER_VERSION,
    updatedAt: normalizeOptionalIso(input.updatedAt),
    batches
  };
}

function normalizeBeginInput(input) {
  if (!isPlainObject(input) || !Array.isArray(input.items) || input.items.length === 0) {
    throw createError('marki_import_lifecycle_input_invalid', '导入记录参数无效。');
  }
  return {
    batchId: normalizeBatchId(input.batchId),
    querySummary: normalizeQuerySummary(input.querySummary),
    items: input.items.map((item) => ({
      sourceKey: normalizeSourceKey(item.sourceKey),
      displayId: normalizeDisplayId(item.displayId),
      markName: normalizeText(item.markName, 300)
    }))
  };
}

function normalizeStoredItems(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > 1000) {
    throw createError('marki_import_lifecycle_invalid', '马克导入单项记录无效。');
  }
  return input.map((item) => ({
    sourceKey: normalizeSourceKey(item.sourceKey),
    displayId: normalizeDisplayId(item.displayId),
    markName: normalizeText(item.markName, 300),
    status: normalizeEnum(item.status, ITEM_STATUSES, '单项状态'),
    photoId: normalizeText(item.photoId, 500),
    code: normalizeCode(item.code),
    message: normalizeText(item.message, 300),
    createdAt: normalizeIso(item.createdAt),
    updatedAt: normalizeIso(item.updatedAt)
  }));
}

function normalizeItemResultsInput(input) {
  if (!isPlainObject(input) || !Array.isArray(input.items)) {
    throw createError('marki_import_lifecycle_input_invalid', '下载结果记录无效。');
  }
  return {
    batchId: normalizeBatchId(input.batchId),
    items: input.items.map((item) => ({
      sourceKey: normalizeSourceKey(item.sourceKey),
      success: item.success === true,
      code: item.success === true ? '' : normalizeCode(item.code, true),
      message: item.success === true ? '' : normalizeText(item.message, 300, true)
    }))
  };
}

function normalizeReadyInput(input) {
  if (!isPlainObject(input) || !Array.isArray(input.photos) || input.photos.length === 0) {
    throw createError('marki_import_lifecycle_input_invalid', '就绪批次记录无效。');
  }
  return {
    batchId: normalizeBatchId(input.batchId),
    photos: input.photos.map((photo) => ({
      sourceKey: normalizeSourceKey(photo.sourceKey),
      photoId: normalizeText(photo.photoId || photo.id, 500, true)
    }))
  };
}

function normalizeFailureInput(input) {
  if (!isPlainObject(input) || !Array.isArray(input.failures) || input.failures.length === 0) {
    throw createError('marki_import_lifecycle_input_invalid', '失败批次记录无效。');
  }
  return {
    batchId: normalizeBatchId(input.batchId),
    failures: input.failures.map((failure) => ({
      sourceKey: normalizeSourceKey(failure.sourceKey),
      code: normalizeCode(failure.code, true),
      message: normalizeText(failure.message, 300, true)
    }))
  };
}

function normalizeQuerySummary(input = {}) {
  return {
    teamId: normalizeText(input.teamId, 100),
    uid: normalizeText(input.uid, 100),
    start: normalizeText(input.start, 30),
    end: normalizeText(input.end, 30),
    watermarkFilter: normalizeText(input.watermarkFilter, 500) || 'watermarked',
    importStatusFilter: normalizeText(input.importStatusFilter, 100) || 'all',
    loadedCount: normalizeCount(input.loadedCount),
    selectedCount: normalizeCount(input.selectedCount),
    unwatermarkedCount: normalizeCount(input.unwatermarkedCount),
    watermarkUnknownCount: normalizeCount(input.watermarkUnknownCount),
    duplicateCount: normalizeCount(input.duplicateCount)
  };
}

function normalizeCount(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function getWorkspaceSourceState(snapshotResult) {
  const result = new Map();
  if (snapshotResult?.success !== true || !snapshotResult.found) return result;
  for (const photo of snapshotResult.snapshot?.workspace?.photos || []) {
    const sourceKey = String(photo.sourceKey || '');
    if (!sourceKey) continue;
    result.set(sourceKey, resolveWorkspaceSourceOccupancy(photo));
  }
  return result;
}

function resolveWorkspaceSourceOccupancy(photo = {}) {
  const photoId = String(photo.id || '');
  if (!photoId || photo.sourceType !== 'marki_api' || !String(photo.sourceKey || '').trim()) {
    return {
      photoId,
      occupancy: 'absent',
      sourceStatus: 'unavailable'
    };
  }
  if (isArchivedPhoto(photo)) {
    return {
      photoId,
      occupancy: 'archived_locked',
      sourceStatus: 'archived_locked'
    };
  }
  if (photo.originalMissing === true || photo.fileHealth?.exists === false) {
    return {
      photoId,
      occupancy: 'repairable_missing',
      sourceStatus: 'workspace_file_repairable'
    };
  }
  const healthStatus = String(photo.fileHealth?.healthStatus || '').trim();
  if ([
    'missing',
    'not_file',
    'unreadable',
    'empty',
    'too_large',
    'unsupported_format',
    'decode_failed',
    'fingerprint_changed'
  ].includes(healthStatus)) {
    return {
      photoId,
      occupancy: healthStatus === 'missing' ? 'repairable_missing' : 'repairable_corrupt',
      sourceStatus: 'workspace_file_repairable'
    };
  }
  if (
    healthStatus
    && !['healthy', 'fingerprint_unknown'].includes(healthStatus)
  ) {
    return {
      photoId,
      occupancy: 'unavailable',
      sourceStatus: 'unavailable'
    };
  }
  return {
    photoId,
    occupancy: 'healthy_active',
    sourceStatus: 'imported_active'
  };
}

function isArchivedPhoto(photo) {
  return (
    String(photo?.sortStatus || '') === 'archived'
    || Boolean(photo?.archivedAt)
    || photo?.archiveResult?.success === true
    || photo?.archiveResult?.stage === 'committed'
  );
}

function getLedgerPath(userDataPath) {
  const root = String(userDataPath || '').trim();
  if (!root || !path.isAbsolute(root)) {
    throw createError('marki_import_lifecycle_storage_invalid', '马克导入记录目录不可用。');
  }
  return path.join(root, LEDGER_FILE_NAME);
}

function resolveDependencies(options = {}) {
  return {
    fs: options.fs || fs,
    loadSnapshot: options.loadSnapshot || loadSortWorkspaceSnapshot,
    saveSnapshot: options.saveSnapshot || saveSortWorkspaceSnapshot,
    loadManifest: options.loadManifest || loadMarkiSourceManifest,
    getSourceRecord: options.getSourceRecord || getMarkiSourceRecordByKey,
    listReadyBatches: options.listReadyBatches || listReadyMarkiImportBatches,
    getImportBatch: options.getImportBatch || getMarkiImportBatch
  };
}

function parseSourceKey(sourceKey) {
  const match = /^marki_api:(\d+):(.+)$/.exec(normalizeSourceKey(sourceKey));
  return { orgId: match[1], momentId: match[2] };
}

function normalizeSourceKey(value) {
  const text = String(value || '').trim();
  if (!/^marki_api:\d+:[^<>:"/\\|?*\u0000-\u001f\u007f]{1,200}$/.test(text)) {
    throw createError('marki_import_lifecycle_source_invalid', '马克来源标识无效。');
  }
  return text;
}

function normalizeBatchId(value) {
  const text = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(text)) {
    throw createError('marki_import_lifecycle_batch_invalid', '马克导入批次标识无效。');
  }
  return text;
}

function normalizeDisplayId(value) {
  const text = String(value || '').trim();
  return /^\d{1,6}$/.test(text) ? text : '1';
}

function normalizeCode(value, required = false) {
  const text = String(value || '').trim();
  if (!text && !required) return '';
  if (!/^[a-z][a-z0-9_]{1,90}$/.test(text)) {
    throw createError('marki_import_lifecycle_input_invalid', '导入失败代码无效。');
  }
  return text;
}

function normalizeText(value, maxLength, required = false) {
  const text = String(value || '').trim();
  if ((required && !text) || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw createError('marki_import_lifecycle_input_invalid', '导入记录文本无效。');
  }
  return text;
}

function normalizeEnum(value, allowed, label) {
  const text = String(value || '').trim();
  if (!allowed.has(text)) {
    throw createError('marki_import_lifecycle_invalid', `${label}无效。`);
  }
  return text;
}

function normalizeIso(value) {
  const text = String(value || '').trim();
  const date = new Date(text);
  if (!text || Number.isNaN(date.getTime())) {
    throw createError('marki_import_lifecycle_invalid', '导入记录时间无效。');
  }
  return date.toISOString();
}

function normalizeOptionalIso(value) {
  const text = String(value || '').trim();
  return text ? normalizeIso(text) : '';
}

function resolveNow(options) {
  const value = typeof options.now === 'function' ? options.now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw createError('marki_import_lifecycle_clock_invalid', '系统时间不可用。');
  }
  return date.toISOString();
}

function isPathInside(root, target) {
  const relative = path.relative(root, target);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function withWriteLock(key, action) {
  const previous = ledgerWriteQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  ledgerWriteQueues.set(key, current);
  return current.finally(() => {
    if (ledgerWriteQueues.get(key) === current) ledgerWriteQueues.delete(key);
  });
}

function createError(code, message) {
  return new MarkiImportLifecycleError(code, message);
}

module.exports = {
  ACTIVE_ITEM_STATUSES,
  ACTIVE_BATCH_STATUSES,
  BATCH_STATUSES,
  ITEM_STATUSES,
  LEDGER_FILE_NAME,
  LEDGER_VERSION,
  MarkiImportLifecycleError,
  beginMarkiImportLifecycleBatch,
  cleanupMarkiImportLifecycleCache,
  clearMarkiImportLifecycleRecord,
  completeMarkiImportLifecycleBatch,
  listMarkiImportLifecycleRecords,
  markMarkiImportLifecycleDownloading,
  markMarkiImportLifecycleFailed,
  markMarkiImportLifecycleAppending,
  markMarkiImportLifecycleReady,
  recoverMarkiImportLifecycle,
  removeSourcesFromWorkspace,
  resolveMarkiImportSourceStatuses,
  resolveWorkspaceSourceOccupancy,
  settleMarkiImportLifecycleDownloads,
  undoMarkiImportLifecycleBatch
};
