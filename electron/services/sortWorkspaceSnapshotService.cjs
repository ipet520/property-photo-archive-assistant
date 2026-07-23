const fs = require('node:fs/promises');
const path = require('node:path');
const { inspectPhotoSourceFile } = require('./photoFileHealthService.cjs');

const SNAPSHOT_DIRECTORY_NAME = 'sort-workspace';
const SNAPSHOT_FILE_NAME = 'active-workbench.json';
const SNAPSHOT_SCHEMA_VERSION = 1;
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const MAX_PHOTO_COUNT = 10000;
const MAX_NESTING_DEPTH = 16;
const MAX_STRING_LENGTH = 2 * 1024 * 1024;

const WORKSPACE_KEYS = new Set([
  'photos',
  'selectedIds',
  'activePhotoId',
  'recognitionResultsByPhoto',
  'watermarkRecordsByPhoto',
  'archiveSuggestionsByPhoto',
  'photoDraftByPhotoId',
  'groupDraftByGroupId',
  'archivePreviewPlan',
  'smartSortResult',
  'smartSortViewMode',
  'activeSmartSortGroupId',
  'photoFolder',
  'archiveRoot',
  'filter',
  'sortMode',
  'pageSize',
  'rightPanelMode',
  'form',
  'searchText',
  'page',
  'viewMode'
]);

const PHOTO_KEYS = new Set([
  'id',
  'originalPath',
  'originalName',
  'extension',
  'size',
  'width',
  'height',
  'sha256',
  'modifiedAt',
  'capturedAt',
  'previewUrl',
  'thumbnailPath',
  'selected',
  'sortStatus',
  'smartSortStatus',
  'archiveInfo',
  'previewInfo',
  'archiveResult',
  'archiveMethod',
  'archivedAt',
  'originalMissing',
  'missingSortStatus',
  'ignoredPreviousSortStatus',
  'ignoredAt',
  'ignoredPreviousState',
  'ignoredMembershipRestoreStatus',
  'sourceType',
  'sourceKey',
  'sourceMetadataRef',
  'fileHealth'
]);

const FORBIDDEN_KEYS = new Set([
  '__proto__',
  'prototype',
  'constructor',
  'url',
  'previewurl',
  'thumbnailpath',
  'remoteurl',
  'originalurl',
  'rawcontent',
  'content',
  'moment',
  'moments',
  'apiresponse',
  'responsebody',
  'apikey',
  'sign',
  'signature',
  'headers',
  'requestheaders',
  'stack'
]);

const snapshotWriteQueues = new Map();

class SortWorkspaceSnapshotError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SortWorkspaceSnapshotError';
    this.code = code;
  }
}

function getSortWorkspaceSnapshotPath(userDataPath) {
  const root = normalizeUserDataPath(userDataPath);
  return path.join(root, SNAPSHOT_DIRECTORY_NAME, SNAPSHOT_FILE_NAME);
}

function validateSortWorkspaceSnapshot(input, options = {}) {
  if (!isPlainObject(input)) {
    throw createSnapshotError('sort_workspace_snapshot_invalid', '工作台快照格式无效。');
  }
  assertExactKeys(input, ['schemaVersion', 'savedAt', 'workspace']);
  if (input.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw createSnapshotError('sort_workspace_snapshot_incompatible', '工作台快照版本不兼容。');
  }
  const savedAt = normalizeIsoDate(input.savedAt);
  const workspace = normalizeWorkspace(input.workspace, options);
  const snapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    savedAt,
    workspace
  };
  assertSnapshotSize(snapshot);
  return snapshot;
}

async function saveSortWorkspaceSnapshot(userDataPath, workspace, options = {}) {
  const snapshotPath = getSortWorkspaceSnapshotPath(userDataPath);
  const fileSystem = resolveFileSystem(options);
  return withSnapshotWriteLock(snapshotPath, async () => {
    try {
      const snapshot = validateSortWorkspaceSnapshot({
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        savedAt: resolveNow(options).toISOString(),
        workspace
      });
      await assertExistingSnapshotCanBeReplaced(fileSystem, snapshotPath);
      await writeSnapshotAtomically(fileSystem, snapshotPath, snapshot);
      return {
        success: true,
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        savedAt: snapshot.savedAt,
        photoCount: snapshot.workspace.photos.length
      };
    } catch (error) {
      return toSafeSnapshotFailure(error, 'sort_workspace_snapshot_save_failed', '工作台自动保存失败，请重试。');
    }
  });
}

async function loadSortWorkspaceSnapshot(userDataPath, options = {}) {
  const snapshotPath = getSortWorkspaceSnapshotPath(userDataPath);
  const fileSystem = resolveFileSystem(options);
  try {
    const text = await fileSystem.readFile(snapshotPath, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw createSnapshotError('sort_workspace_snapshot_corrupt', '工作台快照已损坏，未自动恢复。');
    }
    const snapshot = validateSortWorkspaceSnapshot(parsed);
    const workspace = await markMissingOriginalPhotos(snapshot.workspace, fileSystem, options);
    return {
      success: true,
      found: true,
      snapshot: {
        ...snapshot,
        workspace
      }
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        success: true,
        found: false,
        snapshot: null
      };
    }
    return {
      success: false,
      found: true,
      snapshot: null,
      error: toSafeSnapshotError(error, 'sort_workspace_snapshot_load_failed', '工作台快照读取失败，已使用空工作台。')
    };
  }
}

async function clearSortWorkspaceSnapshot(userDataPath, options = {}) {
  return saveSortWorkspaceSnapshot(userDataPath, createEmptyWorkspace(), options);
}

function createEmptyWorkspace() {
  return {
    photos: [],
    selectedIds: [],
    activePhotoId: '',
    recognitionResultsByPhoto: {},
    watermarkRecordsByPhoto: {},
    archiveSuggestionsByPhoto: {},
    photoDraftByPhotoId: {},
    groupDraftByGroupId: {},
    archivePreviewPlan: null,
    smartSortResult: null,
    smartSortViewMode: 'statusFilter',
    activeSmartSortGroupId: '',
    filter: 'all',
    sortMode: 'timeAsc',
    pageSize: 50,
    rightPanelMode: 'form',
    form: {},
    searchText: '',
    page: 1,
    viewMode: 'grid'
  };
}

function normalizeWorkspace(input, options = {}) {
  if (!isPlainObject(input)) {
    throw createSnapshotError('sort_workspace_snapshot_invalid', '工作台快照内容无效。');
  }
  assertAllowedKeys(input, WORKSPACE_KEYS);
  const photos = normalizePhotos(input.photos);
  const photoIds = new Set(photos.map((photo) => photo.id));
  const selectedIds = normalizeStringArray(input.selectedIds, 'selectedIds')
    .filter((photoId) => photoIds.has(photoId));
  const activePhotoId = normalizeText(input.activePhotoId, 500);
  const safeActivePhotoId = photoIds.has(activePhotoId)
    ? activePhotoId
    : selectedIds[0] || photos[0]?.id || '';
  return {
    photos,
    selectedIds,
    activePhotoId: safeActivePhotoId,
    recognitionResultsByPhoto: normalizePhotoMap(input.recognitionResultsByPhoto, photoIds, 'recognitionResultsByPhoto'),
    watermarkRecordsByPhoto: normalizePhotoMap(input.watermarkRecordsByPhoto, photoIds, 'watermarkRecordsByPhoto'),
    archiveSuggestionsByPhoto: normalizePhotoMap(input.archiveSuggestionsByPhoto, photoIds, 'archiveSuggestionsByPhoto'),
    photoDraftByPhotoId: normalizePhotoMap(input.photoDraftByPhotoId ?? {}, photoIds, 'photoDraftByPhotoId'),
    groupDraftByGroupId: normalizeOptionalObjectMap(input.groupDraftByGroupId, 'groupDraftByGroupId'),
    archivePreviewPlan: sanitizeJsonValue(input.archivePreviewPlan ?? null, 'archivePreviewPlan'),
    smartSortResult: sanitizeJsonValue(input.smartSortResult ?? null, 'smartSortResult'),
    smartSortViewMode: normalizeEnum(input.smartSortViewMode, ['statusFilter', 'smartSortGroup'], 'statusFilter'),
    activeSmartSortGroupId: normalizeText(input.activeSmartSortGroupId, 500),
    filter: normalizeText(input.filter, 100) || 'all',
    sortMode: normalizeEnum(input.sortMode, ['timeAsc', 'timeDesc', 'nameAsc', 'nameDesc'], 'timeAsc'),
    pageSize: normalizeEnumNumber(input.pageSize, [50, 100, 200], 50),
    rightPanelMode: normalizeEnum(input.rightPanelMode, ['form', 'recognition'], 'form'),
    form: sanitizeJsonValue(input.form || {}, 'form'),
    searchText: normalizeText(input.searchText, 1000),
    page: normalizePositiveInteger(input.page, 1),
    viewMode: normalizeEnum(input.viewMode, ['grid', 'list'], 'grid'),
    ...(options.includeUnknown === true ? {} : {})
  };
}

function normalizePhotos(input) {
  if (!Array.isArray(input) || input.length > MAX_PHOTO_COUNT) {
    throw createSnapshotError('sort_workspace_snapshot_invalid', '工作台照片列表无效。');
  }
  const ids = new Set();
  return input.map((photo) => {
    if (!isPlainObject(photo)) {
      throw createSnapshotError('sort_workspace_snapshot_invalid', '工作台照片记录无效。');
    }
    assertAllowedKeys(photo, PHOTO_KEYS);
    const id = normalizeText(photo.id, 500);
    const originalPath = normalizeText(photo.originalPath, 32767);
    if (!id || !originalPath || ids.has(id)) {
      throw createSnapshotError('sort_workspace_snapshot_invalid', '工作台照片标识或来源路径无效。');
    }
    ids.add(id);
    const normalized = {
      id,
      originalPath,
      originalName: normalizeText(photo.originalName, 1000),
      extension: normalizeText(photo.extension, 30),
      size: normalizeNonNegativeNumber(photo.size),
      width: normalizeNonNegativeNumber(photo.width),
      height: normalizeNonNegativeNumber(photo.height),
      sha256: normalizeOptionalSha256(photo.sha256),
      modifiedAt: normalizeOptionalDateValue(photo.modifiedAt),
      capturedAt: normalizeOptionalDateValue(photo.capturedAt),
      selected: Boolean(photo.selected),
      sortStatus: normalizeText(photo.sortStatus, 100) || 'unassigned',
      smartSortStatus: normalizeEnum(
        photo.smartSortStatus,
        ['not_run', 'running', 'completed', 'needs_completion', 'failed'],
        'not_run'
      ),
      archiveInfo: sanitizeJsonValue(photo.archiveInfo ?? null, 'archiveInfo'),
      previewInfo: sanitizeJsonValue(photo.previewInfo ?? null, 'previewInfo'),
      archiveResult: sanitizeJsonValue(photo.archiveResult ?? null, 'archiveResult'),
      archiveMethod: normalizeText(photo.archiveMethod, 200),
      archivedAt: normalizeOptionalDateValue(photo.archivedAt),
      originalMissing: Boolean(photo.originalMissing),
      missingSortStatus: normalizeText(photo.missingSortStatus, 100),
      ignoredPreviousSortStatus: normalizeText(photo.ignoredPreviousSortStatus, 100),
      ignoredAt: normalizeOptionalDateValue(photo.ignoredAt),
      ignoredPreviousState: sanitizeJsonValue(
        photo.ignoredPreviousState ?? null,
        'ignoredPreviousState'
      ),
      ignoredMembershipRestoreStatus: normalizeEnum(
        photo.ignoredMembershipRestoreStatus,
        ['membership_expired'],
        ''
      ),
      sourceType: normalizeText(photo.sourceType, 100),
      sourceKey: normalizeText(photo.sourceKey, 2000),
      sourceMetadataRef: normalizeText(photo.sourceMetadataRef, 2000),
      fileHealth: sanitizeJsonValue(photo.fileHealth ?? null, 'fileHealth')
    };
    return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== ''));
  });
}

function normalizePhotoMap(input, photoIds, fieldName) {
  if (!isPlainObject(input)) {
    throw createSnapshotError('sort_workspace_snapshot_invalid', `${fieldName} 格式无效。`);
  }
  const result = Object.create(null);
  for (const [photoId, value] of Object.entries(input)) {
    if (!photoIds.has(photoId)) continue;
    assertSafeObjectKey(photoId);
    result[photoId] = sanitizeJsonValue(value, fieldName);
  }
  return result;
}

function normalizeOptionalObjectMap(input, fieldName) {
  if (input === undefined || input === null) return {};
  if (!isPlainObject(input)) {
    throw createSnapshotError('sort_workspace_snapshot_invalid', `${fieldName} 格式无效。`);
  }
  return sanitizeJsonValue(input, fieldName);
}

function sanitizeJsonValue(value, fieldName, depth = 0) {
  if (depth > MAX_NESTING_DEPTH) {
    throw createSnapshotError('sort_workspace_snapshot_invalid', `${fieldName} 层级过深。`);
  }
  if (value === undefined) return null;
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return normalizeText(value, MAX_STRING_LENGTH);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw createSnapshotError('sort_workspace_snapshot_invalid', `${fieldName} 包含无效数字。`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_PHOTO_COUNT) {
      throw createSnapshotError('sort_workspace_snapshot_invalid', `${fieldName} 数量过多。`);
    }
    return value.map((item) => sanitizeJsonValue(item, fieldName, depth + 1));
  }
  if (!isPlainObject(value)) {
    throw createSnapshotError('sort_workspace_snapshot_invalid', `${fieldName} 包含不可保存的临时对象。`);
  }
  const result = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = String(key || '').trim();
    assertSafeObjectKey(normalizedKey);
    if (item === undefined) continue;
    if (FORBIDDEN_KEYS.has(normalizedKey.toLowerCase())) continue;
    result[normalizedKey] = sanitizeJsonValue(item, fieldName, depth + 1);
  }
  return result;
}

async function markMissingOriginalPhotos(workspace, fileSystem, options = {}) {
  const inspectFile = options.inspectPhotoSourceFile || inspectPhotoSourceFile;
  const photos = [];
  for (const photo of workspace.photos) {
    let fileHealth;
    try {
      fileHealth = await inspectFile(photo, photo.sha256, {
        fs: fileSystem,
        ...(options.createReadStream ? { createReadStream: options.createReadStream } : {})
      });
    } catch {
      fileHealth = {
        resolvedPath: photo.originalPath,
        exists: false,
        isFile: false,
        readable: false,
        size: 0,
        sizeValid: false,
        mimeType: '',
        extensionSupported: false,
        decodable: false,
        currentSha256: '',
        expectedSha256: photo.sha256 || '',
        fingerprintMatches: false,
        healthStatus: 'unreadable',
        failureReason: '照片文件健康检查失败。'
      };
    }
    const originalMissing = !['healthy', 'fingerprint_unknown'].includes(fileHealth.healthStatus);
    photos.push({
      ...photo,
      sha256: photo.sha256 || '',
      fileHealth,
      originalMissing,
      missingSortStatus: originalMissing
        ? (photo.missingSortStatus || photo.sortStatus || 'unassigned')
        : undefined,
      sortStatus: photo.sortStatus || 'unassigned'
    });
  }
  return {
    ...workspace,
    photos
  };
}

async function assertExistingSnapshotCanBeReplaced(fileSystem, snapshotPath) {
  let text;
  try {
    text = await fileSystem.readFile(snapshotPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  try {
    validateSortWorkspaceSnapshot(JSON.parse(text));
  } catch {
    throw createSnapshotError(
      'sort_workspace_snapshot_existing_invalid',
      '现有工作台快照异常，已停止覆盖，请先人工核查。'
    );
  }
}

async function writeSnapshotAtomically(fileSystem, snapshotPath, snapshot) {
  await fileSystem.mkdir(path.dirname(snapshotPath), { recursive: true });
  const temporaryPath = `${snapshotPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const payload = `${JSON.stringify(snapshot, null, 2)}\n`;
  let handle;
  try {
    handle = await fileSystem.open(temporaryPath, 'wx');
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fileSystem.rename(temporaryPath, snapshotPath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fileSystem.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

function withSnapshotWriteLock(snapshotPath, action) {
  const previous = snapshotWriteQueues.get(snapshotPath) || Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  snapshotWriteQueues.set(snapshotPath, current);
  return current.finally(() => {
    if (snapshotWriteQueues.get(snapshotPath) === current) {
      snapshotWriteQueues.delete(snapshotPath);
    }
  });
}

function resolveFileSystem(options) {
  return options.fs || fs;
}

function resolveNow(options) {
  const value = typeof options.now === 'function' ? options.now() : options.now;
  const date = value instanceof Date ? value : value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    throw createSnapshotError('sort_workspace_snapshot_time_invalid', '工作台快照时间无效。');
  }
  return date;
}

function assertSnapshotSize(snapshot) {
  if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > MAX_SNAPSHOT_BYTES) {
    throw createSnapshotError('sort_workspace_snapshot_too_large', '工作台快照数据过大，无法保存。');
  }
}

function assertExactKeys(input, expectedKeys) {
  const keys = Object.keys(input).sort();
  const expected = [...expectedKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw createSnapshotError('sort_workspace_snapshot_invalid', '工作台快照字段无效。');
  }
}

function assertAllowedKeys(input, allowedKeys) {
  for (const key of Object.keys(input)) {
    assertSafeObjectKey(key);
    if (!allowedKeys.has(key)) {
      throw createSnapshotError('sort_workspace_snapshot_invalid', '工作台快照包含未支持字段。');
    }
  }
}

function assertSafeObjectKey(key) {
  const normalized = String(key || '').trim();
  if (!normalized || ['__proto__', 'prototype', 'constructor'].includes(normalized)) {
    throw createSnapshotError('sort_workspace_snapshot_invalid', '工作台快照包含不安全字段。');
  }
}

function normalizeStringArray(value, fieldName) {
  if (!Array.isArray(value) || value.length > MAX_PHOTO_COUNT) {
    throw createSnapshotError('sort_workspace_snapshot_invalid', `${fieldName} 格式无效。`);
  }
  const result = [];
  const seen = new Set();
  for (const item of value) {
    const text = normalizeText(item, 500);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function normalizeText(value, maxLength) {
  const text = value == null ? '' : String(value).trim();
  if (text.length > maxLength || /[\u0000]/.test(text)) {
    throw createSnapshotError('sort_workspace_snapshot_invalid', '工作台快照文本字段无效。');
  }
  return text;
}

function normalizeIsoDate(value) {
  const text = normalizeText(value, 100);
  const date = new Date(text);
  if (!text || Number.isNaN(date.getTime()) || date.toISOString() !== text) {
    throw createSnapshotError('sort_workspace_snapshot_invalid', '工作台快照保存时间无效。');
  }
  return text;
}

function normalizeOptionalDateValue(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw createSnapshotError('sort_workspace_snapshot_invalid', '工作台照片时间无效。');
    }
    return value;
  }
  return normalizeText(value, 100);
}

function normalizeNonNegativeNumber(value) {
  if (value == null || value === '') return 0;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw createSnapshotError('sort_workspace_snapshot_invalid', '工作台照片尺寸无效。');
  }
  return number;
}

function normalizeOptionalSha256(value) {
  const sha256 = normalizeText(value, 64).toLowerCase();
  if (!sha256) return '';
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw createSnapshotError('sort_workspace_snapshot_invalid', '工作台照片内容指纹无效。');
  }
  return sha256;
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function normalizeEnum(value, allowed, fallback) {
  const text = String(value || '').trim();
  return allowed.includes(text) ? text : fallback;
}

function normalizeEnumNumber(value, allowed, fallback) {
  const number = Number(value);
  return allowed.includes(number) ? number : fallback;
}

function normalizeUserDataPath(value) {
  const text = String(value || '').trim();
  if (!text) {
    throw createSnapshotError('sort_workspace_snapshot_path_invalid', '工作台快照目录无效。');
  }
  return path.resolve(text);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function createSnapshotError(code, message) {
  return new SortWorkspaceSnapshotError(code, message);
}

function toSafeSnapshotError(error, fallbackCode, fallbackMessage) {
  if (error instanceof SortWorkspaceSnapshotError) {
    return {
      code: error.code,
      message: error.message
    };
  }
  return {
    code: fallbackCode,
    message: fallbackMessage
  };
}

function toSafeSnapshotFailure(error, fallbackCode, fallbackMessage) {
  return {
    success: false,
    error: toSafeSnapshotError(error, fallbackCode, fallbackMessage)
  };
}

module.exports = {
  MAX_SNAPSHOT_BYTES,
  SNAPSHOT_SCHEMA_VERSION,
  SortWorkspaceSnapshotError,
  clearSortWorkspaceSnapshot,
  createEmptyWorkspace,
  getSortWorkspaceSnapshotPath,
  loadSortWorkspaceSnapshot,
  saveSortWorkspaceSnapshot,
  validateSortWorkspaceSnapshot
};
