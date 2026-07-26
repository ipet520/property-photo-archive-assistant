const fs = require('node:fs/promises');
const path = require('node:path');

const APP_FOLDER_NAME = '物业工作照片归档助手';
const MARKI_IMPORT_DIRECTORY_NAME = 'marki-import';
const SOURCE_MANIFEST_FILE_NAME = 'source-manifest.json';
const SOURCE_MANIFEST_VERSION = 1;
const SOURCE_TYPE = 'marki_api';
const INITIAL_IMPORT_STATUS = 'discovered';
const IMPORT_STATUSES = Object.freeze([
  INITIAL_IMPORT_STATUS,
  'downloading',
  'imported',
  'download_failed',
  'repair_required',
  'repairing',
  'repair_failed'
]);
const IMPORT_STATUS_TRANSITIONS = Object.freeze({
  discovered: Object.freeze(['downloading']),
  downloading: Object.freeze(['downloading', 'imported', 'download_failed']),
  imported: Object.freeze(['repair_required']),
  download_failed: Object.freeze(['downloading']),
  repair_required: Object.freeze(['repairing']),
  repairing: Object.freeze(['repairing', 'imported', 'repair_failed']),
  repair_failed: Object.freeze(['repairing'])
});
const MAX_BATCH_SIZE = 5000;
const manifestWriteQueues = new Map();

function getMarkiImportRoot(documentsPath) {
  const root = String(documentsPath || '').trim();
  if (!root) throw createManifestError('invalid_documents_path', '缺少软件数据目录。');
  return path.join(root, APP_FOLDER_NAME, MARKI_IMPORT_DIRECTORY_NAME);
}

function getMarkiSourceManifestPath(documentsPath, orgId) {
  const normalizedOrgId = normalizeOrgId(orgId);
  return path.join(getMarkiImportRoot(documentsPath), normalizedOrgId, SOURCE_MANIFEST_FILE_NAME);
}

function buildMarkiSourceKey(orgId, momentId) {
  return `${SOURCE_TYPE}:${normalizeOrgId(orgId)}:${normalizeMomentId(momentId)}`;
}

async function loadMarkiSourceManifest(documentsPath, orgId) {
  const normalizedOrgId = normalizeOrgId(orgId);
  const manifestPath = getMarkiSourceManifestPath(documentsPath, normalizedOrgId);
  try {
    const content = await fs.readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(content);
    return cloneJson(normalizeStoredManifest(parsed, normalizedOrgId));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return createEmptyManifest(normalizedOrgId);
    }
    if (error.name === 'SyntaxError' || error.code === 'marki_source_manifest_invalid') {
      throw createManifestError(
        'marki_source_manifest_invalid',
        '马克来源清单无法解析，已停止写入以保护现有记录。'
      );
    }
    throw error;
  }
}

async function loadMarkiSourceManifestForRecovery(documentsPath, orgId) {
  const normalizedOrgId = normalizeOrgId(orgId);
  const manifestPath = getMarkiSourceManifestPath(documentsPath, normalizedOrgId);
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        orgId: normalizedOrgId,
        records: [],
        invalidRecords: []
      };
    }
    throw createManifestError(
      'marki_source_manifest_invalid',
      '马克来源清单无法解析，已停止恢复以保护现有记录。'
    );
  }

  if (!isPlainObject(parsed?.records)) {
    throw createManifestError(
      'marki_source_manifest_invalid',
      '马克来源清单记录结构无效。'
    );
  }
  normalizeStoredManifest({ ...parsed, records: {} }, normalizedOrgId);
  const records = [];
  const invalidRecords = [];
  for (const [index, [sourceKey, value]] of Object.entries(parsed.records).entries()) {
    try {
      const normalized = normalizeStoredManifest({
        ...parsed,
        records: { [sourceKey]: value }
      }, normalizedOrgId);
      records.push(normalized.records[sourceKey]);
    } catch {
      invalidRecords.push({ index: index + 1 });
    }
  }
  return {
    orgId: normalizedOrgId,
    records: cloneJson(records),
    invalidRecords
  };
}

async function upsertMarkiSourceRecords(documentsPath, orgId, sourceRecords = [], options = {}) {
  const normalizedOrgId = normalizeOrgId(orgId);
  const inputs = normalizeSourceRecordBatch(normalizedOrgId, sourceRecords);
  const manifestPath = getMarkiSourceManifestPath(documentsPath, normalizedOrgId);
  return withManifestWriteLock(manifestPath, async () => {
    const manifest = await loadMarkiSourceManifest(documentsPath, normalizedOrgId);
    const now = resolveNow(options);
    let createdCount = 0;
    let updatedCount = 0;
    let unchangedCount = 0;
    const items = [];

    for (const input of inputs.uniqueRecords) {
      const existing = manifest.records[input.sourceKey] || null;
      if (!existing) {
        const record = {
          ...input,
          importStatus: INITIAL_IMPORT_STATUS,
          downloadAttemptCount: 0,
          downloadInfo: null,
          lastDownloadError: null,
          createdAt: now,
          updatedAt: now
        };
        manifest.records[input.sourceKey] = record;
        createdCount += 1;
        items.push(createUpsertResult(record, false, true));
        continue;
      }

      const merged = {
        ...existing,
        teamId: input.teamId,
        uid: input.uid,
        postTime: input.postTime,
        markName: input.markName
      };
      if (hasSourceMetadataChanged(existing, merged)) {
        merged.updatedAt = now;
        manifest.records[input.sourceKey] = merged;
        updatedCount += 1;
        items.push(createUpsertResult(merged, true, true));
      } else {
        unchangedCount += 1;
        items.push(createUpsertResult(existing, true, false));
      }
    }

    if (createdCount > 0 || updatedCount > 0) {
      manifest.updatedAt = now;
      await writeMarkiSourceManifest(manifestPath, manifest);
    }

    return {
      success: true,
      orgId: normalizedOrgId,
      manifestPath,
      inputCount: inputs.inputCount,
      uniqueInputCount: inputs.uniqueRecords.length,
      duplicateInputCount: inputs.inputCount - inputs.uniqueRecords.length,
      createdCount,
      updatedCount,
      unchangedCount,
      totalCount: Object.keys(manifest.records).length,
      items
    };
  });
}

async function updateMarkiSourceImportStatus(
  documentsPath,
  orgId,
  sourceKey,
  nextStatus,
  details = {},
  options = {}
) {
  const normalizedOrgId = normalizeOrgId(orgId);
  const normalizedSourceKey = normalizeSourceKey(normalizedOrgId, sourceKey);
  const normalizedNextStatus = String(nextStatus || '').trim();
  if (!IMPORT_STATUSES.includes(normalizedNextStatus)) {
    throw createManifestError('invalid_import_status', '来源记录状态无效。');
  }
  const manifestPath = getMarkiSourceManifestPath(documentsPath, normalizedOrgId);
  return withManifestWriteLock(manifestPath, async () => {
    const manifest = await loadMarkiSourceManifest(documentsPath, normalizedOrgId);
    const existing = manifest.records[normalizedSourceKey];
    if (!existing) {
      throw createManifestError('source_record_not_found', '未找到对应的马克来源记录。');
    }
    const allowedNextStatuses = IMPORT_STATUS_TRANSITIONS[existing.importStatus] || [];
    if (!allowedNextStatuses.includes(normalizedNextStatus)) {
      throw createManifestError(
        'invalid_import_status_transition',
        `来源记录不能从 ${existing.importStatus} 变更为 ${normalizedNextStatus}。`
      );
    }

    const now = resolveNow(options);
    const nextRecord = {
      ...existing,
      importStatus: normalizedNextStatus,
      updatedAt: now
    };
    if (normalizedNextStatus === 'downloading') {
      nextRecord.downloadAttemptCount = existing.downloadAttemptCount + 1;
      nextRecord.downloadInfo = null;
      nextRecord.lastDownloadError = null;
    } else if (normalizedNextStatus === 'repairing') {
      nextRecord.downloadAttemptCount = existing.downloadAttemptCount + 1;
      nextRecord.downloadInfo = existing.downloadInfo;
      nextRecord.lastDownloadError = null;
    } else if (normalizedNextStatus === 'imported') {
      nextRecord.downloadInfo = normalizeDownloadInfo(details.downloadInfo);
      nextRecord.lastDownloadError = null;
    } else if (normalizedNextStatus === 'download_failed') {
      nextRecord.downloadInfo = null;
      nextRecord.lastDownloadError = normalizeDownloadError(details.error, now);
    } else if (normalizedNextStatus === 'repair_failed') {
      nextRecord.downloadInfo = existing.downloadInfo;
      nextRecord.lastDownloadError = normalizeDownloadError(details.error, now);
    }
    validateDownloadState(nextRecord);
    manifest.records[normalizedSourceKey] = nextRecord;
    manifest.updatedAt = now;
    await writeMarkiSourceManifest(manifestPath, manifest);
    return {
      success: true,
      orgId: normalizedOrgId,
      sourceKey: normalizedSourceKey,
      previousStatus: existing.importStatus,
      importStatus: normalizedNextStatus,
      record: cloneJson(nextRecord)
    };
  });
}

async function prepareMarkiSourceForRedownload(
  documentsPath,
  orgId,
  sourceKey,
  options = {}
) {
  const normalizedOrgId = normalizeOrgId(orgId);
  const normalizedSourceKey = normalizeSourceKey(normalizedOrgId, sourceKey);
  const manifestPath = getMarkiSourceManifestPath(documentsPath, normalizedOrgId);
  return withManifestWriteLock(manifestPath, async () => {
    const manifest = await loadMarkiSourceManifest(documentsPath, normalizedOrgId);
    const existing = manifest.records[normalizedSourceKey];
    if (!existing) {
      throw createManifestError('source_record_not_found', '未找到对应的马克来源记录。');
    }
    if (existing.importStatus !== 'imported') {
      throw createManifestError(
        'invalid_import_status_transition',
        '只有已下载完成但缓存失效的来源记录可以准备重新下载。'
      );
    }
    const now = resolveNow(options);
    const nextRecord = {
      ...existing,
      importStatus: 'repair_required',
      downloadInfo: existing.downloadInfo,
      lastDownloadError: normalizeDownloadError({
        code: 'marki_import_cache_invalid',
        message: '本地下载缓存缺失或校验失败，可重新下载。'
      }, now),
      updatedAt: now
    };
    validateDownloadState(nextRecord);
    manifest.records[normalizedSourceKey] = nextRecord;
    manifest.updatedAt = now;
    await writeMarkiSourceManifest(manifestPath, manifest);
    return {
      success: true,
      orgId: normalizedOrgId,
      sourceKey: normalizedSourceKey,
      previousStatus: existing.importStatus,
      importStatus: nextRecord.importStatus,
      record: cloneJson(nextRecord)
    };
  });
}

async function getMarkiSourceRecordByKey(documentsPath, orgId, sourceKey) {
  const normalizedOrgId = normalizeOrgId(orgId);
  const normalizedSourceKey = normalizeSourceKey(normalizedOrgId, sourceKey);
  const manifest = await loadMarkiSourceManifest(documentsPath, normalizedOrgId);
  const record = manifest.records[normalizedSourceKey];
  return record ? cloneJson(record) : null;
}

async function hasMarkiSourceKey(documentsPath, orgId, sourceKey) {
  return Boolean(await getMarkiSourceRecordByKey(documentsPath, orgId, sourceKey));
}

async function checkMarkiSourceKeys(documentsPath, orgId, sourceKeys = []) {
  const normalizedOrgId = normalizeOrgId(orgId);
  if (!Array.isArray(sourceKeys)) {
    throw createManifestError('invalid_source_keys', 'sourceKeys 必须为数组。');
  }
  if (sourceKeys.length > MAX_BATCH_SIZE) {
    throw createManifestError('source_key_batch_too_large', `一次最多检查 ${MAX_BATCH_SIZE} 个来源标识。`);
  }
  const uniqueSourceKeys = [];
  const seen = new Set();
  for (const sourceKey of sourceKeys) {
    const normalizedSourceKey = normalizeSourceKey(normalizedOrgId, sourceKey);
    if (seen.has(normalizedSourceKey)) continue;
    seen.add(normalizedSourceKey);
    uniqueSourceKeys.push(normalizedSourceKey);
  }

  const manifest = await loadMarkiSourceManifest(documentsPath, normalizedOrgId);
  const items = uniqueSourceKeys.map((sourceKey) => {
    const record = manifest.records[sourceKey] || null;
    return {
      sourceKey,
      exists: Boolean(record),
      importStatus: record?.importStatus || ''
    };
  });
  const bySourceKey = Object.fromEntries(items.map((item) => [item.sourceKey, {
    exists: item.exists,
    importStatus: item.importStatus
  }]));
  const existingCount = items.filter((item) => item.exists).length;
  return {
    success: true,
    orgId: normalizedOrgId,
    requestedCount: sourceKeys.length,
    uniqueCount: uniqueSourceKeys.length,
    duplicateInputCount: sourceKeys.length - uniqueSourceKeys.length,
    existingCount,
    newCount: items.length - existingCount,
    items,
    bySourceKey
  };
}

function normalizeSourceRecordBatch(orgId, sourceRecords) {
  if (!Array.isArray(sourceRecords)) {
    throw createManifestError('invalid_source_records', '来源记录必须为数组。');
  }
  if (sourceRecords.length > MAX_BATCH_SIZE) {
    throw createManifestError('source_record_batch_too_large', `一次最多写入 ${MAX_BATCH_SIZE} 条来源记录。`);
  }
  const recordsByKey = new Map();
  for (const item of sourceRecords) {
    const normalized = normalizeSourceRecordInput(orgId, item);
    recordsByKey.set(normalized.sourceKey, normalized);
  }
  return {
    inputCount: sourceRecords.length,
    uniqueRecords: Array.from(recordsByKey.values())
  };
}

function normalizeSourceRecordInput(orgId, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw createManifestError('invalid_source_record', '来源记录格式无效。');
  }
  const momentId = normalizeMomentId(input.momentId ?? input.id);
  return {
    sourceKey: buildMarkiSourceKey(orgId, momentId),
    sourceType: SOURCE_TYPE,
    orgId,
    momentId,
    teamId: normalizeOptionalId(input.teamId),
    uid: normalizeOptionalId(input.uid),
    postTime: normalizeTimestamp(input.postTime),
    markName: normalizeText(input.markName, 200)
  };
}

function normalizeStoredManifest(input, expectedOrgId) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw createManifestError('marki_source_manifest_invalid', '来源清单结构无效。');
  }
  if (Number(input.version) !== SOURCE_MANIFEST_VERSION) {
    throw createManifestError('marki_source_manifest_invalid', '来源清单版本不受支持。');
  }
  const storedOrgId = String(input.orgId || '').trim();
  if (!/^\d+$/.test(storedOrgId) || storedOrgId !== expectedOrgId) {
    throw createManifestError('marki_source_manifest_invalid', '来源清单组织 ID 不匹配。');
  }
  if (String(input.sourceType || '') !== SOURCE_TYPE) {
    throw createManifestError('marki_source_manifest_invalid', '来源清单类型无效。');
  }
  if (!isPlainObject(input.records)) {
    throw createManifestError('marki_source_manifest_invalid', '来源清单记录结构无效。');
  }

  const records = {};
  for (const [sourceKey, value] of Object.entries(input.records)) {
    const normalizedSourceKey = normalizeSourceKey(expectedOrgId, sourceKey);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw createManifestError('marki_source_manifest_invalid', '来源记录结构无效。');
    }
    const momentId = normalizeMomentId(value.momentId);
    if (buildMarkiSourceKey(expectedOrgId, momentId) !== normalizedSourceKey) {
      throw createManifestError('marki_source_manifest_invalid', '来源记录唯一标识不一致。');
    }
    const importStatus = String(value.importStatus || '');
    if (!IMPORT_STATUSES.includes(importStatus)) {
      throw createManifestError('marki_source_manifest_invalid', '来源记录状态无效。');
    }
    const normalizedRecord = {
      sourceKey: normalizedSourceKey,
      sourceType: SOURCE_TYPE,
      orgId: expectedOrgId,
      momentId,
      teamId: normalizeOptionalId(value.teamId),
      uid: normalizeOptionalId(value.uid),
      postTime: normalizeTimestamp(value.postTime),
      markName: normalizeText(value.markName, 200),
      importStatus,
      downloadAttemptCount: normalizeNonNegativeInteger(value.downloadAttemptCount),
      downloadInfo: value.downloadInfo == null ? null : normalizeDownloadInfo(value.downloadInfo),
      lastDownloadError: value.lastDownloadError == null
        ? null
        : normalizeDownloadError(value.lastDownloadError),
      createdAt: normalizeIsoDate(value.createdAt),
      updatedAt: normalizeIsoDate(value.updatedAt)
    };
    validateDownloadState(normalizedRecord);
    records[normalizedSourceKey] = normalizedRecord;
  }
  return {
    version: SOURCE_MANIFEST_VERSION,
    sourceType: SOURCE_TYPE,
    orgId: expectedOrgId,
    updatedAt: normalizeIsoDate(input.updatedAt, true),
    records
  };
}

async function writeMarkiSourceManifest(manifestPath, manifest) {
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  const temporaryPath = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
  const payload = `${JSON.stringify(manifest, null, 2)}\n`;
  let handle;
  try {
    handle = await fs.open(temporaryPath, 'wx');
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, manifestPath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

function createEmptyManifest(orgId) {
  return {
    version: SOURCE_MANIFEST_VERSION,
    sourceType: SOURCE_TYPE,
    orgId,
    updatedAt: '',
    records: {}
  };
}

function createUpsertResult(record, existedBefore, changed) {
  return {
    sourceKey: record.sourceKey,
    existedBefore,
    changed,
    importStatus: record.importStatus
  };
}

function hasSourceMetadataChanged(existing, next) {
  return ['teamId', 'uid', 'postTime', 'markName'].some((key) => existing[key] !== next[key]);
}

function normalizeSourceKey(orgId, sourceKey) {
  const text = String(sourceKey || '').trim();
  const expectedPrefix = `${SOURCE_TYPE}:${orgId}:`;
  if (!text.startsWith(expectedPrefix)) {
    throw createManifestError('invalid_source_key', '来源标识与当前组织不匹配。');
  }
  const momentId = normalizeMomentId(text.slice(expectedPrefix.length));
  const normalized = buildMarkiSourceKey(orgId, momentId);
  if (text !== normalized) {
    throw createManifestError('invalid_source_key', '来源标识格式无效。');
  }
  return normalized;
}

function normalizeOrgId(value) {
  const text = String(value || '').trim();
  if (!/^\d+$/.test(text)) {
    throw createManifestError('invalid_org_id', '组织 ID 必须为数字。');
  }
  return text;
}

function normalizeMomentId(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 200 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw createManifestError('invalid_moment_id', '照片来源 ID 无效。');
  }
  return text;
}

function normalizeOptionalId(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text.length > 100 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw createManifestError('invalid_source_record', '来源记录中的 ID 无效。');
  }
  return text;
}

function normalizeTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function normalizeText(value, maxLength) {
  const text = String(value ?? '').trim();
  return text.slice(0, maxLength);
}

function normalizeNonNegativeInteger(value) {
  const number = Number(value ?? 0);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw createManifestError('marki_source_manifest_invalid', '来源记录下载次数无效。');
  }
  return number;
}

function normalizeDownloadInfo(input) {
  if (!isPlainObject(input)) {
    throw createManifestError('marki_source_manifest_invalid', '来源记录下载信息无效。');
  }
  const relativePath = String(input.relativePath || '').trim().replaceAll('\\', '/');
  const pathParts = relativePath.split('/');
  if (
    !relativePath
    || path.isAbsolute(relativePath)
    || pathParts.some((part) => !part || part === '.' || part === '..')
    || /[\u0000-\u001f\u007f]/.test(relativePath)
  ) {
    throw createManifestError('marki_source_manifest_invalid', '来源记录下载路径无效。');
  }
  const fileName = String(input.fileName || '').trim();
  if (!/^[A-Za-z0-9_-]+\.jpg$/i.test(fileName)) {
    throw createManifestError('marki_source_manifest_invalid', '来源记录下载文件名无效。');
  }
  const size = normalizePositiveInteger(input.size, '来源记录下载文件大小无效。');
  const width = normalizePositiveInteger(input.width, '来源记录图片宽度无效。');
  const height = normalizePositiveInteger(input.height, '来源记录图片高度无效。');
  const sha256 = String(input.sha256 || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw createManifestError('marki_source_manifest_invalid', '来源记录文件摘要无效。');
  }
  return {
    relativePath,
    fileName,
    size,
    width,
    height,
    sha256,
    completedAt: normalizeIsoDate(input.completedAt)
  };
}

function normalizeDownloadError(input, fallbackAt = '') {
  if (!isPlainObject(input)) {
    throw createManifestError('marki_source_manifest_invalid', '来源记录下载错误无效。');
  }
  const code = String(input.code || '').trim();
  const message = normalizeText(input.message, 300);
  if (!/^[a-z0-9_]{1,100}$/.test(code) || !message) {
    throw createManifestError('marki_source_manifest_invalid', '来源记录下载错误无效。');
  }
  return {
    code,
    message,
    at: normalizeIsoDate(input.at || fallbackAt)
  };
}

function normalizePositiveInteger(value, message) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw createManifestError('marki_source_manifest_invalid', message);
  }
  return number;
}

function validateDownloadState(record) {
  const attemptCount = record.downloadAttemptCount;
  const hasDownloadInfo = record.downloadInfo !== null;
  const hasDownloadError = record.lastDownloadError !== null;
  const valid = {
    discovered: attemptCount === 0 && !hasDownloadInfo && !hasDownloadError,
    downloading: attemptCount > 0 && !hasDownloadInfo && !hasDownloadError,
    imported: attemptCount > 0 && hasDownloadInfo && !hasDownloadError,
    download_failed: attemptCount > 0 && !hasDownloadInfo && hasDownloadError,
    repair_required: attemptCount > 0 && hasDownloadInfo && hasDownloadError,
    repairing: attemptCount > 0 && hasDownloadInfo && !hasDownloadError,
    repair_failed: attemptCount > 0 && hasDownloadInfo && hasDownloadError
  };
  if (!valid[record.importStatus]) {
    throw createManifestError('marki_source_manifest_invalid', '来源记录下载状态与明细不一致。');
  }
}

function normalizeIsoDate(value, allowEmpty = false) {
  const text = String(value || '').trim();
  if (!text && allowEmpty) return '';
  const date = new Date(text);
  if (!text || Number.isNaN(date.getTime())) {
    throw createManifestError('marki_source_manifest_invalid', '来源记录时间无效。');
  }
  return date.toISOString();
}

function resolveNow(options = {}) {
  const value = typeof options.now === 'function' ? options.now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw createManifestError('invalid_current_time', '无法生成来源记录时间。');
  }
  return date.toISOString();
}

function withManifestWriteLock(manifestPath, action) {
  const previous = manifestWriteQueues.get(manifestPath) || Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  manifestWriteQueues.set(manifestPath, current);
  return current.finally(() => {
    if (manifestWriteQueues.get(manifestPath) === current) {
      manifestWriteQueues.delete(manifestPath);
    }
  });
}

function createManifestError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  IMPORT_STATUSES,
  INITIAL_IMPORT_STATUS,
  MARKI_IMPORT_DIRECTORY_NAME,
  MAX_BATCH_SIZE,
  SOURCE_MANIFEST_FILE_NAME,
  SOURCE_MANIFEST_VERSION,
  SOURCE_TYPE,
  buildMarkiSourceKey,
  checkMarkiSourceKeys,
  getMarkiImportRoot,
  getMarkiSourceManifestPath,
  getMarkiSourceRecordByKey,
  hasMarkiSourceKey,
  loadMarkiSourceManifest,
  loadMarkiSourceManifestForRecovery,
  prepareMarkiSourceForRedownload,
  updateMarkiSourceImportStatus,
  upsertMarkiSourceRecords
};
