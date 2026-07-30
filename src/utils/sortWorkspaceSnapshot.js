const SNAPSHOT_WORKSPACE_DEFAULTS = Object.freeze({
  projectId: '',
  projectName: '',
  photoFolder: '',
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
});

const MANUAL_DRAFT_VERSION = '3.2.0';
const MANUAL_DRAFT_FORBIDDEN_KEYS = new Set([
  '__proto__',
  'prototype',
  'constructor',
  'previewurl',
  'thumbnailpath',
  'url',
  'remoteurl',
  'originalurl',
  'rawcontent',
  'content',
  'moment',
  'moments',
  'apiresponse',
  'responsebody',
  'apikey',
  'organizationkey',
  'markikey',
  'sign',
  'signature',
  'headers',
  'requestheaders',
  'stack'
]);

export function buildSortWorkspaceSnapshotWorkspace(state = {}) {
  return {
    projectId: String(state.projectId || state.activeProject?.projectId || '').trim(),
    projectName: String(state.projectName || state.activeProject?.projectName || '').trim(),
    photoFolder: String(state.photoFolder || '').trim(),
    photos: Array.isArray(state.photos) ? state.photos : [],
    selectedIds: Array.isArray(state.selectedIds) ? state.selectedIds : [],
    activePhotoId: state.activePhotoId || '',
    recognitionResultsByPhoto: state.recognitionResultsByPhoto || {},
    watermarkRecordsByPhoto: state.watermarkRecordsByPhoto || {},
    archiveSuggestionsByPhoto: state.archiveSuggestionsByPhoto || {},
    photoDraftByPhotoId: state.photoDraftByPhotoId || {},
    groupDraftByGroupId: state.groupDraftByGroupId || {},
    archivePreviewPlan: state.archivePreviewPlan || null,
    smartSortResult: state.smartSortResult || null,
    smartSortViewMode: state.smartSortViewMode || 'statusFilter',
    activeSmartSortGroupId: state.activeSmartSortGroupId || '',
    filter: state.filter || 'all',
    sortMode: state.sortMode || 'timeAsc',
    pageSize: Number(state.pageSize) || 50,
    rightPanelMode: state.rightPanelMode || 'form',
    form: state.form || {},
    searchText: state.searchText || '',
    page: Number(state.page) || 1,
    viewMode: state.viewMode || 'grid'
  };
}

export function createDebouncedSnapshotSaver({
  save,
  delayMs = 500,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  if (typeof save !== 'function') throw new TypeError('save 必须为函数');
  let enabled = false;
  let timer = null;
  let pendingWorkspace = null;
  let saveQueue = Promise.resolve();

  const enqueue = (workspace) => {
    if (!workspace) return Promise.resolve({ success: true, skipped: true });
    saveQueue = saveQueue
      .catch(() => {})
      .then(() => save(workspace));
    return saveQueue;
  };

  return {
    setEnabled(value) {
      enabled = Boolean(value);
      if (!enabled) {
        if (timer) clearTimer(timer);
        timer = null;
        pendingWorkspace = null;
      }
    },
    schedule(workspace) {
      if (!enabled) return;
      pendingWorkspace = workspace;
      if (timer) clearTimer(timer);
      timer = setTimer(() => {
        timer = null;
        const next = pendingWorkspace;
        pendingWorkspace = null;
        void enqueue(next);
      }, delayMs);
    },
    flush(workspace) {
      if (workspace) pendingWorkspace = workspace;
      if (timer) clearTimer(timer);
      timer = null;
      const next = pendingWorkspace;
      pendingWorkspace = null;
      return enqueue(next);
    },
    cancel() {
      if (timer) clearTimer(timer);
      timer = null;
      pendingWorkspace = null;
    },
    whenIdle() {
      return saveQueue.catch(() => {});
    }
  };
}

export async function persistMarkiWorkbenchImport({
  currentWorkspace,
  workbenchImportPackage,
  mergeWorkbenchImport,
  saveSnapshot,
  consumeBatch,
  commitWorkspace,
  prepareWorkspace
}) {
  if (
    typeof mergeWorkbenchImport !== 'function'
    || typeof saveSnapshot !== 'function'
    || typeof consumeBatch !== 'function'
    || typeof commitWorkspace !== 'function'
  ) {
    throw new TypeError('Marki 工作台持久化依赖无效');
  }

  const merged = mergeWorkbenchImport(currentWorkspace, workbenchImportPackage);
  const baseWorkspace = buildSortWorkspaceSnapshotWorkspace({
    ...currentWorkspace,
    ...merged
  });
  const workspace = buildSortWorkspaceSnapshotWorkspace(
    typeof prepareWorkspace === 'function'
      ? prepareWorkspace({ currentWorkspace, merged, workspace: baseWorkspace })
      : baseWorkspace
  );
  const snapshotResult = await saveSnapshot(workspace);
  if (snapshotResult?.success !== true) {
    return {
      success: false,
      stage: 'snapshot',
      merged,
      workspace,
      snapshotResult,
      consumeResult: null
    };
  }

  let consumeResult;
  try {
    consumeResult = await consumeBatch(workbenchImportPackage.batchId);
  } catch {
    consumeResult = { success: false };
  }
  commitWorkspace(merged, workspace);
  return {
    success: consumeResult?.success === true,
    stage: consumeResult?.success === true ? 'completed' : 'consume',
    merged,
    workspace,
    snapshotResult,
    consumeResult
  };
}

export function prepareWorkspaceAfterPhotoAppend({
  workspace = {},
  addedPhotoIds = [],
  repairedPhotoIds = []
} = {}) {
  const hasAddedPhotos = Array.isArray(addedPhotoIds) && addedPhotoIds.length > 0;
  const repairedIds = new Set(
    (Array.isArray(repairedPhotoIds) ? repairedPhotoIds : []).map(String)
  );
  const previewAffected = repairedIds.size > 0
    && (Array.isArray(workspace.archivePreviewPlan?.items)
      ? workspace.archivePreviewPlan.items
      : []
    ).some((item) => repairedIds.has(String(item?.photoId || '')));
  return buildSortWorkspaceSnapshotWorkspace({
    ...workspace,
    archivePreviewPlan: previewAffected ? null : workspace.archivePreviewPlan,
    filter: hasAddedPhotos ? 'all' : workspace.filter,
    searchText: hasAddedPhotos ? '' : workspace.searchText
  });
}

export async function persistLocalPhotoRelinks({
  currentWorkspace = {},
  nextPhotos = [],
  saveSnapshot,
  commitWorkspace
} = {}) {
  if (typeof saveSnapshot !== 'function' || typeof commitWorkspace !== 'function') {
    throw new TypeError('本地照片重新定位持久化依赖无效');
  }
  const workspace = buildSortWorkspaceSnapshotWorkspace({
    ...currentWorkspace,
    photos: nextPhotos
  });
  const snapshotResult = await saveSnapshot(workspace);
  if (snapshotResult?.success !== true) {
    return { success: false, workspace, snapshotResult };
  }
  commitWorkspace(workspace);
  return { success: true, workspace, snapshotResult };
}

export async function persistProjectPhotoFolder({
  currentWorkspace = {},
  photoFolder = '',
  saveSnapshot,
  commitWorkspace
} = {}) {
  if (typeof saveSnapshot !== 'function' || typeof commitWorkspace !== 'function') {
    throw new TypeError('项目照片来源持久化依赖无效');
  }
  const workspace = buildSortWorkspaceSnapshotWorkspace({
    ...currentWorkspace,
    photoFolder
  });
  const snapshotResult = await saveSnapshot(workspace);
  if (snapshotResult?.success !== true) {
    return { success: false, workspace, snapshotResult };
  }
  commitWorkspace(workspace);
  return { success: true, workspace, snapshotResult };
}

export function getEmptySortWorkspaceSnapshotWorkspace(overrides = {}) {
  return buildSortWorkspaceSnapshotWorkspace({
    ...SNAPSHOT_WORKSPACE_DEFAULTS,
    ...overrides
  });
}

export function shouldOfferLegacyWorkspaceMigration(inspection) {
  return (
    inspection?.success === true
    && inspection.found === true
    && inspection.migrationAvailable === true
  );
}

export async function loadProjectWorkspaceSnapshotWithLegacyMigration({
  activeProject,
  loadSnapshot,
  inspectLegacy,
  migrateLegacy,
  confirmMigration,
  onLegacyBlocked
} = {}) {
  if (
    typeof loadSnapshot !== 'function'
    || typeof inspectLegacy !== 'function'
    || typeof migrateLegacy !== 'function'
    || typeof confirmMigration !== 'function'
  ) {
    throw new TypeError('旧工作台迁移依赖无效');
  }
  const loaded = await loadSnapshot(activeProject);
  if (loaded?.success !== true || loaded.found === true) return loaded;

  const inspection = await inspectLegacy(activeProject);
  if (!shouldOfferLegacyWorkspaceMigration(inspection)) {
    if (inspection?.found === true && typeof onLegacyBlocked === 'function') {
      onLegacyBlocked(inspection);
    }
    return loaded;
  }
  if (confirmMigration(inspection, activeProject) !== true) return loaded;

  const migrated = await migrateLegacy(activeProject);
  if (migrated?.success !== true) return migrated;
  return loadSnapshot(activeProject);
}

export function buildSortWorkspaceManualDraft(workspace, options = {}) {
  const savedAt = normalizeIsoTimestamp(options.savedAt || new Date().toISOString());
  return {
    version: MANUAL_DRAFT_VERSION,
    savedAt,
    workspace: sanitizeManualDraftValue(
      buildSortWorkspaceSnapshotWorkspace(workspace)
    )
  };
}

export function readSortWorkspaceManualDraft(draft) {
  if (!isPlainObject(draft)) {
    throw new TypeError('分拣草稿格式无效');
  }
  const source = isPlainObject(draft.workspace) ? draft.workspace : draft;
  if (!Array.isArray(source.photos)) {
    throw new TypeError('分拣草稿照片列表无效');
  }
  const seenPhotoIds = new Set();
  for (const photo of source.photos) {
    if (!isPlainObject(photo)) throw new TypeError('分拣草稿照片记录无效');
    const photoId = String(photo.id || '').trim();
    if (photoId && seenPhotoIds.has(photoId)) {
      throw new TypeError('分拣草稿包含重复照片');
    }
    if (photoId) seenPhotoIds.add(photoId);
  }
  for (const fieldName of [
    'recognitionResultsByPhoto',
    'watermarkRecordsByPhoto',
    'archiveSuggestionsByPhoto',
    'photoDraftByPhotoId',
    'groupDraftByGroupId'
  ]) {
    if (source[fieldName] != null && !isPlainObject(source[fieldName])) {
      throw new TypeError('分拣草稿映射格式无效');
    }
  }
  return {
    version: String(draft.version || 'legacy'),
    savedAt: String(draft.savedAt || ''),
    workspace: buildSortWorkspaceSnapshotWorkspace(
      sanitizeManualDraftValue(source)
    )
  };
}

function sanitizeManualDraftValue(value, seen = new WeakSet()) {
  if (
    value == null
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('分拣草稿包含无效数字');
    return value;
  }
  if (typeof value !== 'object' || value instanceof Date) {
    throw new TypeError('分拣草稿包含不可序列化数据');
  }
  if (seen.has(value)) throw new TypeError('分拣草稿包含循环引用');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeManualDraftValue(item, seen));
    }
    if (!isPlainObject(value)) {
      throw new TypeError('分拣草稿包含不可序列化对象');
    }
    const result = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      const normalizedKey = String(key || '').trim();
      if (!normalizedKey || MANUAL_DRAFT_FORBIDDEN_KEYS.has(normalizedKey.toLowerCase())) {
        continue;
      }
      if (item !== undefined) {
        result[normalizedKey] = sanitizeManualDraftValue(item, seen);
      }
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function normalizeIsoTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('分拣草稿保存时间无效');
  return date.toISOString();
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
