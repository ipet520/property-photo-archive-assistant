const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const BATCH_DIRECTORY_NAME = 'marki-import-batches';
const BATCH_SCHEMA_VERSION = 1;
const BATCH_STATUSES = Object.freeze({
  PREPARING: 'preparing',
  READY: 'ready',
  FAILED: 'failed',
  CONSUMED: 'consumed'
});
const BATCH_TTL_MS = Object.freeze({
  [BATCH_STATUSES.PREPARING]: 60 * 60 * 1000,
  [BATCH_STATUSES.READY]: 24 * 60 * 60 * 1000,
  [BATCH_STATUSES.FAILED]: 24 * 60 * 60 * 1000,
  [BATCH_STATUSES.CONSUMED]: 10 * 60 * 1000
});
const WORKBENCH_IMPORT_PACKAGE_KEYS = Object.freeze([
  'batchId',
  'photos',
  'recognitionResultsByPhoto',
  'watermarkRecordsByPhoto',
  'archiveSuggestionsByPhoto'
]);
const BATCH_RECORD_KEYS = new Set([
  'schemaVersion',
  'batchId',
  'projectId',
  'projectName',
  'status',
  'inputCount',
  'metadataSavedCount',
  'failedCount',
  'failures',
  'deduplication',
  'workbenchImportPackage',
  'createdAt',
  'updatedAt',
  'expiresAt',
  'consumedAt'
]);
const LEGACY_BATCH_RECORD_KEYS = new Set(
  [...BATCH_RECORD_KEYS].filter((key) => !['projectId', 'projectName'].includes(key))
);
const FAILURE_KEYS = new Set([
  'sourceMetadataRef',
  'sourceKey',
  'code',
  'message'
]);
const DEDUPLICATION_KEYS = new Set([
  'inputCount',
  'uniqueCount',
  'duplicateCount',
  'skippedItems'
]);
const SKIPPED_ITEM_KEYS = new Set([
  'sourceKey',
  'keptInputIndex',
  'skippedInputIndex'
]);
const FORBIDDEN_PAYLOAD_KEYS = new Set([
  '__proto__',
  'prototype',
  'constructor',
  'url',
  'originalurl',
  'rawcontent',
  'content',
  'parsedentries',
  'anticounterfeitcode',
  'stack',
  'error',
  'apikey',
  'key',
  'sign',
  'signature',
  'headers',
  'requestheaders',
  'response',
  'apiresponse'
]);
const batchWriteQueues = new Map();

class MarkiImportBatchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MarkiImportBatchError';
    this.code = code;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message
    };
  }
}

async function beginMarkiImportBatch(userDataPath, input = {}, options = {}) {
  const fileSystem = resolveFileSystem(options);
  const normalized = normalizeBeginInput(input);
  const batchPath = getMarkiImportBatchPath(userDataPath, normalized.batchId);
  return withBatchWriteLock(batchPath, async () => {
    const now = resolveNow(options);
    let existing = await loadBatchRecord(fileSystem, batchPath);
    if (existing && isExpired(existing, now)) {
      await removeBatchFile(fileSystem, batchPath);
      existing = null;
    }
    if (existing && existing.status !== BATCH_STATUSES.FAILED) {
      throw createBatchError(
        'marki_import_batch_transition_invalid',
        '当前马克导入批次状态不允许重新开始。'
      );
    }
    if (existing) {
      assertRetryIdentity(existing, normalized);
    }
    const nowIso = now.toISOString();
    const record = {
      schemaVersion: BATCH_SCHEMA_VERSION,
      batchId: normalized.batchId,
      projectId: normalized.projectId,
      projectName: normalized.projectName,
      status: BATCH_STATUSES.PREPARING,
      inputCount: normalized.inputCount,
      metadataSavedCount: 0,
      failedCount: 0,
      failures: [],
      deduplication: normalized.deduplication,
      workbenchImportPackage: null,
      createdAt: existing?.createdAt || nowIso,
      updatedAt: nowIso,
      expiresAt: resolveExpiresAt(BATCH_STATUSES.PREPARING, now),
      consumedAt: ''
    };
    await writeBatchAtomically(fileSystem, batchPath, record);
    return toPublicBatch(record);
  });
}

async function markMarkiImportBatchReady(userDataPath, input = {}, options = {}) {
  const fileSystem = resolveFileSystem(options);
  const normalized = normalizeCompletionInput(input, BATCH_STATUSES.READY);
  const batchPath = getMarkiImportBatchPath(userDataPath, normalized.batchId);
  return withBatchWriteLock(batchPath, async () => {
    const now = resolveNow(options);
    const existing = await loadActiveBatchRecord(fileSystem, batchPath, now);
    assertStatus(existing, BATCH_STATUSES.PREPARING, '当前马克导入批次不能标记为就绪。');
    assertCompletionMatches(existing, normalized);
    const nowIso = now.toISOString();
    const record = {
      ...existing,
      status: BATCH_STATUSES.READY,
      metadataSavedCount: normalized.metadataSavedCount,
      failedCount: 0,
      failures: [],
      deduplication: normalized.deduplication,
      workbenchImportPackage: normalized.workbenchImportPackage,
      updatedAt: nowIso,
      expiresAt: resolveExpiresAt(BATCH_STATUSES.READY, now),
      consumedAt: ''
    };
    await writeBatchAtomically(fileSystem, batchPath, record);
    return toPublicBatch(record);
  });
}

async function markMarkiImportBatchFailed(userDataPath, input = {}, options = {}) {
  const fileSystem = resolveFileSystem(options);
  const normalized = normalizeCompletionInput(input, BATCH_STATUSES.FAILED);
  const batchPath = getMarkiImportBatchPath(userDataPath, normalized.batchId);
  return withBatchWriteLock(batchPath, async () => {
    const now = resolveNow(options);
    const existing = await loadActiveBatchRecord(fileSystem, batchPath, now);
    assertStatus(existing, BATCH_STATUSES.PREPARING, '当前马克导入批次不能标记为失败。');
    assertCompletionMatches(existing, normalized);
    const nowIso = now.toISOString();
    const record = {
      ...existing,
      status: BATCH_STATUSES.FAILED,
      metadataSavedCount: normalized.metadataSavedCount,
      failedCount: normalized.failedCount,
      failures: normalized.failures,
      deduplication: normalized.deduplication,
      workbenchImportPackage: null,
      updatedAt: nowIso,
      expiresAt: resolveExpiresAt(BATCH_STATUSES.FAILED, now),
      consumedAt: ''
    };
    await writeBatchAtomically(fileSystem, batchPath, record);
    return toPublicBatch(record);
  });
}

async function getMarkiImportBatch(userDataPath, batchId, options = {}) {
  const fileSystem = resolveFileSystem(options);
  const normalizedBatchId = normalizeBatchId(batchId);
  const batchPath = getMarkiImportBatchPath(userDataPath, normalizedBatchId);
  return withBatchWriteLock(batchPath, async () => {
    const record = await loadActiveBatchRecord(fileSystem, batchPath, resolveNow(options));
    return toPublicBatch(record);
  });
}

async function consumeMarkiImportBatch(userDataPath, batchId, options = {}) {
  const fileSystem = resolveFileSystem(options);
  const normalizedBatchId = normalizeBatchId(batchId);
  const batchPath = getMarkiImportBatchPath(userDataPath, normalizedBatchId);
  return withBatchWriteLock(batchPath, async () => {
    const now = resolveNow(options);
    const existing = await loadActiveBatchRecord(fileSystem, batchPath, now);
    if (existing.status === BATCH_STATUSES.CONSUMED) {
      return {
        success: true,
        batchId: existing.batchId,
        status: BATCH_STATUSES.CONSUMED,
        alreadyConsumed: true
      };
    }
    if (existing.status !== BATCH_STATUSES.READY) {
      throw createBatchError(
        'marki_import_batch_not_consumable',
        '当前马克导入批次尚不能消费。'
      );
    }
    const nowIso = now.toISOString();
    const record = {
      ...existing,
      status: BATCH_STATUSES.CONSUMED,
      workbenchImportPackage: null,
      updatedAt: nowIso,
      expiresAt: resolveExpiresAt(BATCH_STATUSES.CONSUMED, now),
      consumedAt: nowIso
    };
    await writeBatchAtomically(fileSystem, batchPath, record);
    return {
      success: true,
      batchId: record.batchId,
      status: BATCH_STATUSES.CONSUMED,
      alreadyConsumed: false
    };
  });
}

async function listReadyMarkiImportBatches(userDataPath, options = {}) {
  const fileSystem = resolveFileSystem(options);
  const directoryPath = getMarkiImportBatchDirectory(userDataPath);
  let entries;
  try {
    entries = await fileSystem.readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { success: true, items: [], failedCount: 0 };
    }
    throw createBatchError(
      'marki_import_batch_read_failed',
      '马克导入批次读取失败，请重试。'
    );
  }
  const now = resolveNow(options);
  const items = [];
  let failedCount = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const batchId = normalizeBatchId(entry.name.slice(0, -'.json'.length));
      const batchPath = getMarkiImportBatchPath(userDataPath, batchId);
      await withBatchWriteLock(batchPath, async () => {
        const record = await loadBatchRecord(fileSystem, batchPath);
        if (!record || isExpired(record, now) || record.status !== BATCH_STATUSES.READY) return;
        items.push({
          batchId: record.batchId,
          projectId: record.projectId,
          projectName: record.projectName,
          status: record.status,
          inputCount: record.inputCount,
          metadataSavedCount: record.metadataSavedCount,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          expiresAt: record.expiresAt
        });
      });
    } catch {
      failedCount += 1;
    }
  }
  items.sort((left, right) => (
    Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    || left.batchId.localeCompare(right.batchId, 'en')
  ));
  return {
    success: true,
    items: cloneJson(items),
    failedCount
  };
}

async function cleanupExpiredMarkiImportBatches(userDataPath, options = {}) {
  const fileSystem = resolveFileSystem(options);
  const directoryPath = getMarkiImportBatchDirectory(userDataPath);
  let entries;
  try {
    entries = await fileSystem.readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { success: true, removedCount: 0, failedCount: 0 };
    }
    throw createBatchError(
      'marki_import_batch_cleanup_failed',
      '马克导入过期批次清理失败，请重试。'
    );
  }
  const now = resolveNow(options);
  let removedCount = 0;
  let failedCount = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const fileBatchId = entry.name.slice(0, -'.json'.length);
    let normalizedBatchId;
    try {
      normalizedBatchId = normalizeBatchId(fileBatchId);
    } catch {
      failedCount += 1;
      continue;
    }
    const batchPath = getMarkiImportBatchPath(userDataPath, normalizedBatchId);
    await withBatchWriteLock(batchPath, async () => {
      try {
        const record = await loadBatchRecord(fileSystem, batchPath);
        if (record && isExpired(record, now)) {
          await removeBatchFile(fileSystem, batchPath);
          removedCount += 1;
        }
      } catch {
        failedCount += 1;
      }
    });
  }
  return {
    success: failedCount === 0,
    removedCount,
    failedCount
  };
}

function getMarkiImportBatchDirectory(userDataPath) {
  return path.join(normalizeUserDataPath(userDataPath), BATCH_DIRECTORY_NAME);
}

function getMarkiImportBatchPath(userDataPath, batchId) {
  return path.join(
    getMarkiImportBatchDirectory(userDataPath),
    `${normalizeBatchId(batchId)}.json`
  );
}

function normalizeBeginInput(input) {
  assertPlainInput(input, new Set([
    'batchId',
    'inputCount',
    'deduplication',
    'projectId',
    'projectName'
  ]));
  const batchId = normalizeBatchId(input.batchId);
  const inputCount = normalizeCount(input.inputCount, '照片数量');
  const deduplication = normalizeDeduplication(input.deduplication, inputCount);
  return {
    batchId,
    inputCount,
    deduplication,
    projectId: normalizeSafeText(input.projectId, 500),
    projectName: normalizeSafeText(input.projectName, 1000)
  };
}

function normalizeCompletionInput(input, targetStatus) {
  assertPlainInput(input, new Set([
    'success',
    'batchId',
    'inputCount',
    'metadataSavedCount',
    'failedCount',
    'failures',
    'deduplication',
    'workbenchImportPackage'
  ]));
  const batchId = normalizeBatchId(input.batchId);
  const inputCount = normalizeCount(input.inputCount, '照片数量');
  const metadataSavedCount = normalizeCount(input.metadataSavedCount, '元数据保存数量');
  const failedCount = normalizeCount(input.failedCount, '失败数量');
  const failures = normalizeFailures(input.failures);
  const deduplication = normalizeDeduplication(input.deduplication, inputCount);
  if (
    metadataSavedCount + failedCount !== deduplication.uniqueCount
    || failedCount !== failures.length
  ) {
    throw createBatchError(
      'marki_import_batch_result_invalid',
      '马克导入批次结果数量不一致。'
    );
  }

  if (targetStatus === BATCH_STATUSES.READY) {
    if (input.success !== true || failedCount !== 0 || failures.length !== 0) {
      throw createBatchError(
        'marki_import_batch_result_invalid',
        '马克导入成功结果无效。'
      );
    }
    return {
      batchId,
      inputCount,
      metadataSavedCount,
      failedCount,
      failures,
      deduplication,
      workbenchImportPackage: normalizeWorkbenchImportPackage(
        input.workbenchImportPackage,
        batchId
      )
    };
  }

  if (
    input.success !== false
    || failedCount < 1
    || input.workbenchImportPackage !== null
  ) {
    throw createBatchError(
      'marki_import_batch_result_invalid',
      '马克导入失败结果无效。'
    );
  }
  return {
    batchId,
    inputCount,
    metadataSavedCount,
    failedCount,
    failures,
    deduplication,
    workbenchImportPackage: null
  };
}

function normalizeStoredBatch(input) {
  if (
    !isPlainObject(input)
    || (!hasExactKeys(input, BATCH_RECORD_KEYS) && !hasExactKeys(input, LEGACY_BATCH_RECORD_KEYS))
  ) {
    throw createBatchError(
      'marki_import_batch_invalid',
      '马克导入批次文件损坏，已停止处理以保护现有数据。'
    );
  }
  if (input.schemaVersion !== BATCH_SCHEMA_VERSION) {
    throw createBatchError(
      'marki_import_batch_invalid',
      '马克导入批次版本无效，已停止处理。'
    );
  }
  const batchId = normalizeBatchId(input.batchId);
  const projectId = normalizeSafeText(input.projectId, 500);
  const projectName = normalizeSafeText(input.projectName, 1000);
  if (Boolean(projectId) !== Boolean(projectName)) {
    throw createBatchError('marki_import_batch_invalid', '马克导入批次项目归属无效。');
  }
  const status = normalizeStatus(input.status);
  const inputCount = normalizeCount(input.inputCount, '照片数量');
  const metadataSavedCount = normalizeCount(input.metadataSavedCount, '元数据保存数量');
  const failedCount = normalizeCount(input.failedCount, '失败数量');
  const failures = normalizeFailures(input.failures);
  const deduplication = normalizeDeduplication(input.deduplication, inputCount);
  const createdAt = normalizeIsoDate(input.createdAt, '创建时间');
  const updatedAt = normalizeIsoDate(input.updatedAt, '更新时间');
  const expiresAt = normalizeIsoDate(input.expiresAt, '过期时间');
  const consumedAt = input.consumedAt
    ? normalizeIsoDate(input.consumedAt, '消费时间')
    : '';
  if (
    Date.parse(updatedAt) < Date.parse(createdAt)
    || Date.parse(expiresAt) <= Date.parse(updatedAt)
    || failedCount !== failures.length
    || metadataSavedCount + failedCount > deduplication.uniqueCount
  ) {
    throw createBatchError(
      'marki_import_batch_invalid',
      '马克导入批次数据无效，已停止处理。'
    );
  }

  let workbenchImportPackage = null;
  if (status === BATCH_STATUSES.READY) {
    if (
      failedCount !== 0
      || failures.length !== 0
      || metadataSavedCount !== deduplication.uniqueCount
      || consumedAt
    ) {
      throw createBatchError('marki_import_batch_invalid', '马克导入就绪批次数据无效。');
    }
    workbenchImportPackage = normalizeWorkbenchImportPackage(
      input.workbenchImportPackage,
      batchId
    );
  } else if (input.workbenchImportPackage !== null) {
    throw createBatchError('marki_import_batch_invalid', '当前马克导入批次不得保存工作台包。');
  }

  if (status === BATCH_STATUSES.PREPARING && (
    metadataSavedCount !== 0
    || failedCount !== 0
    || failures.length !== 0
    || consumedAt
  )) {
    throw createBatchError('marki_import_batch_invalid', '马克导入准备批次数据无效。');
  }
  if (status === BATCH_STATUSES.FAILED && (failedCount < 1 || consumedAt)) {
    throw createBatchError('marki_import_batch_invalid', '马克导入失败批次数据无效。');
  }
  if (status === BATCH_STATUSES.CONSUMED && (
    failedCount !== 0
    || failures.length !== 0
    || metadataSavedCount !== deduplication.uniqueCount
    || !consumedAt
  )) {
    throw createBatchError('marki_import_batch_invalid', '马克导入已消费批次数据无效。');
  }

  return {
    schemaVersion: BATCH_SCHEMA_VERSION,
    batchId,
    projectId,
    projectName,
    status,
    inputCount,
    metadataSavedCount,
    failedCount,
    failures,
    deduplication,
    workbenchImportPackage,
    createdAt,
    updatedAt,
    expiresAt,
    consumedAt
  };
}

function normalizeWorkbenchImportPackage(input, expectedBatchId) {
  if (!isPlainObject(input)) {
    throw createBatchError('marki_import_batch_package_invalid', '马克工作台导入包无效。');
  }
  const keys = Object.keys(input);
  if (
    keys.length !== WORKBENCH_IMPORT_PACKAGE_KEYS.length
    || WORKBENCH_IMPORT_PACKAGE_KEYS.some((key) => !keys.includes(key))
    || input.batchId !== expectedBatchId
    || !Array.isArray(input.photos)
    || !isPlainObject(input.recognitionResultsByPhoto)
    || !isPlainObject(input.watermarkRecordsByPhoto)
    || !isPlainObject(input.archiveSuggestionsByPhoto)
  ) {
    throw createBatchError('marki_import_batch_package_invalid', '马克工作台导入包结构无效。');
  }
  validateSafePayload(input);
  return cloneJson(input);
}

function normalizeFailures(input) {
  if (!Array.isArray(input)) {
    throw createBatchError('marki_import_batch_failures_invalid', '马克导入失败摘要无效。');
  }
  return input.map((failure) => {
    if (!isPlainObject(failure) || !hasExactKeys(failure, FAILURE_KEYS)) {
      throw createBatchError('marki_import_batch_failures_invalid', '马克导入失败摘要无效。');
    }
    const sourceMetadataRef = normalizeSourceMetadataRef(failure.sourceMetadataRef);
    const sourceKey = normalizeMarkiSourceKey(
      failure.sourceKey,
      'marki_import_batch_failures_invalid',
      '马克失败摘要来源标识无效。'
    );
    const code = String(failure.code || '').trim();
    if (
      sourceMetadataRef.orgId !== sourceKey.orgId
      || sourceMetadataRef.momentId !== sourceKey.momentId
      || !/^marki_[a-z0-9_]{1,90}$/.test(code)
    ) {
      throw createBatchError('marki_import_batch_failures_invalid', '马克导入失败摘要无效。');
    }
    return {
      sourceMetadataRef: sourceMetadataRef.value,
      sourceKey: sourceKey.value,
      code,
      message: '马克来源元数据保存失败，请重试。'
    };
  });
}

function normalizeDeduplication(input, expectedInputCount) {
  if (!isPlainObject(input) || !hasExactKeys(input, DEDUPLICATION_KEYS)) {
    throw createBatchError('marki_import_batch_deduplication_invalid', '马克批内去重统计无效。');
  }
  const inputCount = normalizeCount(input.inputCount, '去重输入数量');
  const uniqueCount = normalizeCount(input.uniqueCount, '唯一照片数量');
  const duplicateCount = normalizeCount(input.duplicateCount, '重复照片数量');
  if (
    inputCount !== expectedInputCount
    || uniqueCount + duplicateCount !== inputCount
    || !Array.isArray(input.skippedItems)
    || input.skippedItems.length !== duplicateCount
  ) {
    throw createBatchError('marki_import_batch_deduplication_invalid', '马克批内去重统计不一致。');
  }
  const skippedItems = input.skippedItems.map((item) => {
    if (!isPlainObject(item) || !hasExactKeys(item, SKIPPED_ITEM_KEYS)) {
      throw createBatchError('marki_import_batch_deduplication_invalid', '马克重复照片摘要无效。');
    }
    const sourceKey = normalizeMarkiSourceKey(item.sourceKey).value;
    const keptInputIndex = normalizeIndex(item.keptInputIndex, inputCount);
    const skippedInputIndex = normalizeIndex(item.skippedInputIndex, inputCount);
    if (!sourceKey || keptInputIndex >= skippedInputIndex) {
      throw createBatchError('marki_import_batch_deduplication_invalid', '马克重复照片摘要无效。');
    }
    return { sourceKey, keptInputIndex, skippedInputIndex };
  });
  return { inputCount, uniqueCount, duplicateCount, skippedItems };
}

function validateSafePayload(value, state = { depth: 0, nodes: 0 }) {
  state.nodes += 1;
  if (state.depth > 30 || state.nodes > 100000) {
    throw createBatchError('marki_import_batch_package_invalid', '马克工作台导入包过大或层级过深。');
  }
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    if (typeof value === 'string' && /https?:\/\/[^\s]+/i.test(value)) {
      throw createBatchError('marki_import_batch_package_sensitive', '马克工作台导入包包含不允许保存的远程地址。');
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw createBatchError('marki_import_batch_package_invalid', '马克工作台导入包包含无效数字。');
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      validateSafePayload(item, { depth: state.depth + 1, nodes: state.nodes });
    }
    return;
  }
  if (!isPlainObject(value)) {
    throw createBatchError('marki_import_batch_package_invalid', '马克工作台导入包包含不可序列化数据。');
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_PAYLOAD_KEYS.has(key.toLowerCase())) {
      throw createBatchError('marki_import_batch_package_sensitive', '马克工作台导入包包含不允许保存的字段。');
    }
    validateSafePayload(child, { depth: state.depth + 1, nodes: state.nodes });
  }
}

async function loadActiveBatchRecord(fileSystem, batchPath, now) {
  const record = await loadBatchRecord(fileSystem, batchPath);
  if (!record) {
    throw createBatchError('marki_import_batch_not_found', '马克导入批次不存在。');
  }
  if (isExpired(record, now)) {
    await removeBatchFile(fileSystem, batchPath);
    throw createBatchError('marki_import_batch_expired', '马克导入批次已过期，请重新发起导入。');
  }
  return record;
}

async function loadBatchRecord(fileSystem, batchPath) {
  let text;
  try {
    text = await fileSystem.readFile(batchPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw createBatchError('marki_import_batch_read_failed', '马克导入批次读取失败，请重试。');
  }
  try {
    return normalizeStoredBatch(JSON.parse(text));
  } catch (error) {
    if (error instanceof MarkiImportBatchError) throw error;
    throw createBatchError(
      'marki_import_batch_invalid',
      '马克导入批次文件损坏，已停止处理以保护现有数据。'
    );
  }
}

async function writeBatchAtomically(fileSystem, batchPath, record) {
  await fileSystem.mkdir(path.dirname(batchPath), { recursive: true });
  const temporaryPath = `${batchPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  const payload = `${JSON.stringify(normalizeStoredBatch(record), null, 2)}\n`;
  let handle;
  try {
    handle = await fileSystem.open(temporaryPath, 'wx');
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fileSystem.rename(temporaryPath, batchPath);
  } catch {
    if (handle) await handle.close().catch(() => {});
    await fileSystem.rm(temporaryPath, { force: true }).catch(() => {});
    throw createBatchError('marki_import_batch_save_failed', '马克导入批次保存失败，请重试。');
  }
}

async function removeBatchFile(fileSystem, batchPath) {
  try {
    await fileSystem.rm(batchPath, { force: true });
  } catch {
    throw createBatchError('marki_import_batch_cleanup_failed', '马克导入过期批次清理失败，请重试。');
  }
}

function toPublicBatch(record) {
  return cloneJson({
    success: true,
    batchId: record.batchId,
    projectId: record.projectId,
    projectName: record.projectName,
    status: record.status,
    inputCount: record.inputCount,
    metadataSavedCount: record.metadataSavedCount,
    failedCount: record.failedCount,
    failures: record.failures,
    deduplication: record.deduplication,
    workbenchImportPackage: record.status === BATCH_STATUSES.READY
      ? record.workbenchImportPackage
      : null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
    consumedAt: record.consumedAt
  });
}

function assertRetryIdentity(existing, input) {
  if (
    existing.inputCount !== input.inputCount
    || JSON.stringify(existing.deduplication) !== JSON.stringify(input.deduplication)
    || (existing.projectId && existing.projectId !== input.projectId)
    || (existing.projectName && existing.projectName !== input.projectName)
  ) {
    throw createBatchError(
      'marki_import_batch_retry_mismatch',
      '马克导入失败批次与重试输入不一致。'
    );
  }
}

function assertCompletionMatches(existing, input) {
  if (
    existing.inputCount !== input.inputCount
    || JSON.stringify(existing.deduplication) !== JSON.stringify(input.deduplication)
  ) {
    throw createBatchError(
      'marki_import_batch_result_mismatch',
      '马克导入批次结果与准备记录不一致。'
    );
  }
}

function assertStatus(record, expected, message) {
  if (record.status !== expected) {
    throw createBatchError('marki_import_batch_transition_invalid', message);
  }
}

function assertPlainInput(input, allowedKeys) {
  if (!isPlainObject(input) || Object.keys(input).some((key) => !allowedKeys.has(key))) {
    throw createBatchError('marki_import_batch_input_invalid', '马克导入批次参数无效。');
  }
}

function normalizeUserDataPath(value) {
  const text = String(value || '').trim();
  if (!text || !path.isAbsolute(text) || /[\u0000-\u001f\u007f]/.test(text)) {
    throw createBatchError('marki_import_batch_storage_invalid', '马克导入批次存储目录无效。');
  }
  return text;
}

function normalizeBatchId(value) {
  const text = String(value ?? '').trim();
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(text) || text === '.' || text === '..') {
    throw createBatchError('marki_import_batch_id_invalid', '马克导入批次 ID 无效。');
  }
  return text;
}

function normalizeStatus(value) {
  const status = String(value || '').trim();
  if (!Object.values(BATCH_STATUSES).includes(status)) {
    throw createBatchError('marki_import_batch_invalid', '马克导入批次状态无效。');
  }
  return status;
}

function normalizeCount(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw createBatchError('marki_import_batch_count_invalid', `${label}无效。`);
  }
  return number;
}

function normalizeIndex(value, inputCount) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number >= inputCount) {
    throw createBatchError('marki_import_batch_deduplication_invalid', '马克重复照片索引无效。');
  }
  return number;
}

function normalizeSafeText(value, maxLength) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) return '';
  return text;
}

function normalizeSourceMetadataRef(value) {
  const text = normalizeSafeText(value, 500);
  const match = /^marki_source_metadata:(\d+):(.+)$/.exec(text);
  if (!match || !isSafeMomentId(match[2])) {
    throw createBatchError('marki_import_batch_failures_invalid', '马克来源元数据引用无效。');
  }
  return { value: text, orgId: match[1], momentId: match[2] };
}

function normalizeMarkiSourceKey(
  value,
  errorCode = 'marki_import_batch_deduplication_invalid',
  errorMessage = '马克来源标识无效。'
) {
  const text = normalizeSafeText(value, 500);
  const match = /^marki_api:(\d+):(.+)$/.exec(text);
  if (!match || !isSafeMomentId(match[2])) {
    throw createBatchError(errorCode, errorMessage);
  }
  return { value: text, orgId: match[1], momentId: match[2] };
}

function isSafeMomentId(value) {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= 200
    && !/[<>:"/\\|?*\u0000-\u001f\u007f]/.test(value)
  );
}

function normalizeIsoDate(value, label) {
  const text = String(value || '').trim();
  const date = new Date(text);
  if (!text || Number.isNaN(date.getTime())) {
    throw createBatchError('marki_import_batch_time_invalid', `${label}无效。`);
  }
  return date.toISOString();
}

function resolveNow(options) {
  const value = typeof options.now === 'function' ? options.now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw createBatchError('marki_import_batch_time_invalid', '当前时间无效。');
  }
  return date;
}

function resolveExpiresAt(status, now) {
  return new Date(now.getTime() + BATCH_TTL_MS[status]).toISOString();
}

function isExpired(record, now) {
  return Date.parse(record.expiresAt) <= now.getTime();
}

function resolveFileSystem(options) {
  const fileSystem = options.fs || fs;
  const requiredMethods = ['mkdir', 'open', 'readFile', 'readdir', 'rename', 'rm'];
  if (!fileSystem || requiredMethods.some((method) => typeof fileSystem[method] !== 'function')) {
    throw createBatchError('marki_import_batch_storage_invalid', '马克导入批次存储服务无效。');
  }
  return fileSystem;
}

function withBatchWriteLock(batchPath, action) {
  const previous = batchWriteQueues.get(batchPath) || Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  batchWriteQueues.set(batchPath, current);
  return current.finally(() => {
    if (batchWriteQueues.get(batchPath) === current) {
      batchWriteQueues.delete(batchPath);
    }
  });
}

function hasExactKeys(value, expectedKeys) {
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.size
    && actualKeys.every((key) => expectedKeys.has(key))
  );
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw createBatchError('marki_import_batch_serialization_failed', '马克导入批次数据无法序列化。');
  }
}

function createBatchError(code, message) {
  return new MarkiImportBatchError(code, message);
}

module.exports = {
  BATCH_DIRECTORY_NAME,
  BATCH_SCHEMA_VERSION,
  BATCH_STATUSES,
  BATCH_TTL_MS,
  MarkiImportBatchError,
  beginMarkiImportBatch,
  cleanupExpiredMarkiImportBatches,
  consumeMarkiImportBatch,
  getMarkiImportBatch,
  listReadyMarkiImportBatches,
  markMarkiImportBatchFailed,
  markMarkiImportBatchReady
};
