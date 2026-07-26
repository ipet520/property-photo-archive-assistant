export const MARKI_TEMPLATE_FILTERS = Object.freeze({
  UNKNOWN: 'template_unknown',
  ALL: 'all'
});

export const MARKI_IMPORT_STATUS_FILTERS = Object.freeze([
  { value: 'all', label: '全部状态' },
  { value: 'not_imported', label: '未导入' },
  { value: 'imported_active', label: '已在工作池' },
  { value: 'workspace_file_repairable', label: '工作池文件需修复' },
  { value: 'removed_reimportable', label: '可重新导入' },
  { value: 'failed_retryable', label: '导入失败' }
]);

const SELECTABLE_STATUSES = new Set([
  'discovered',
  'workspace_file_repairable',
  'removed_reimportable',
  'failed_retryable'
]);

export function normalizeMarkiTemplateName(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
}

export function buildMarkiTemplateFilterOptions(photos = []) {
  const names = new Map();
  let hasUnknown = false;
  for (const photo of photos) {
    const name = normalizeMarkiTemplateName(photo.templateName ?? photo.markName);
    if (!name) {
      hasUnknown = true;
      continue;
    }
    names.set(`name:${name}`, name);
  }
  return [
    { value: MARKI_TEMPLATE_FILTERS.ALL, label: '全部模板' },
    ...[...names.entries()]
      .sort((left, right) => left[1].localeCompare(right[1], 'zh-CN'))
      .map(([value, label]) => ({ value, label })),
    ...(hasUnknown
      ? [{ value: MARKI_TEMPLATE_FILTERS.UNKNOWN, label: '模板未知' }]
      : [])
  ];
}

export function filterMarkiQueryPhotos(photos = [], filters = {}) {
  const templateFilter = normalizeStoredTemplateFilter(
    filters.templateFilter ?? filters.watermarkFilter
  );
  const importStatusFilter = String(filters.importStatusFilter || 'all');
  return photos.filter((photo) => (
    matchesTemplateFilter(photo, templateFilter)
    && matchesImportStatusFilter(photo, importStatusFilter)
  ));
}

export function isMarkiQueryPhotoSelectable(photo) {
  return SELECTABLE_STATUSES.has(String(photo.selectedSourceStatus || ''));
}

export function selectMarkiFilteredTokens(photos = []) {
  return photos
    .filter(isMarkiQueryPhotoSelectable)
    .map((photo) => String(photo.selectionToken || ''))
    .filter(Boolean);
}

export function summarizeMarkiQueryResults(rawPhotos = [], filteredPhotos = [], selectedTokens = []) {
  const selected = new Set(selectedTokens.map(String));
  return {
    loadedCount: rawPhotos.length,
    filteredCount: filteredPhotos.length,
    selectedCount: filteredPhotos.filter((photo) => selected.has(String(photo.selectionToken))).length,
    selectableCount: filteredPhotos.filter(isMarkiQueryPhotoSelectable).length
  };
}

export function prepareMarkiWorkspaceFileRepairs(workspace = {}, workbenchImportPackage = {}) {
  const incomingBySourceKey = new Map(
    (Array.isArray(workbenchImportPackage.photos) ? workbenchImportPackage.photos : [])
      .filter((photo) => photo?.sourceType === 'marki_api' && photo.sourceKey)
      .map((photo) => [String(photo.sourceKey), photo])
  );
  let repairedCount = 0;
  const repairedPhotoIds = [];
  const photos = (Array.isArray(workspace.photos) ? workspace.photos : []).map((photo) => {
    const incoming = incomingBySourceKey.get(String(photo?.sourceKey || ''));
    if (!incoming || !isWorkspacePhotoFileRepairable(photo)) return photo;
    repairedCount += 1;
    repairedPhotoIds.push(String(photo.id));
    return {
      ...photo,
      originalPath: incoming.originalPath,
      originalName: incoming.originalName,
      extension: incoming.extension,
      size: incoming.size,
      sha256: incoming.sha256,
      width: incoming.width,
      height: incoming.height,
      modifiedAt: incoming.modifiedAt,
      thumbnailPath: incoming.thumbnailPath,
      previewUrl: incoming.previewUrl,
      originalMissing: false,
      fileHealth: {
        resolvedPath: incoming.originalPath,
        exists: true,
        isFile: true,
        readable: true,
        size: Number(incoming.size) || 0,
        sizeValid: Number(incoming.size) > 0,
        mimeType: 'image/jpeg',
        extensionSupported: true,
        decodable: true,
        currentSha256: incoming.sha256,
        expectedSha256: incoming.sha256,
        fingerprintMatches: true,
        healthStatus: 'healthy',
        failureReason: ''
      }
    };
  });
  return {
    repairedCount,
    repairedPhotoIds,
    workspace: repairedCount > 0 ? { ...workspace, photos } : workspace
  };
}

export function formatMarkiImportLifecycleStatus(status) {
  return {
    discovered: '未导入',
    imported_active: '已在工作池',
    workspace_file_repairable: '工作池文件需修复',
    removed_reimportable: '可重新导入',
    failed_retryable: '导入失败',
    queued: '等待导入',
    downloading: '正在导入',
    downloaded: '已下载',
    append_pending: '待进入工作池',
    archived_locked: '已归档',
    unavailable: '工作池状态不可用'
  }[status] || '状态未知';
}

function matchesTemplateFilter(photo, filter) {
  if (filter === MARKI_TEMPLATE_FILTERS.ALL) return true;
  const templateName = normalizeMarkiTemplateName(photo?.templateName ?? photo?.markName);
  const templateKey = templateName ? `name:${templateName}` : MARKI_TEMPLATE_FILTERS.UNKNOWN;
  return templateKey === filter;
}

function matchesImportStatusFilter(photo, filter) {
  const status = String(photo?.selectedSourceStatus || '');
  if (filter === 'all') return true;
  if (filter === 'not_imported') return status === 'discovered';
  return status === filter;
}

export function normalizeStoredTemplateFilter(value) {
  const text = String(value || '').normalize('NFKC').trim();
  if (text === MARKI_TEMPLATE_FILTERS.ALL || text === MARKI_TEMPLATE_FILTERS.UNKNOWN) {
    return text;
  }
  if (text.startsWith('name:')) {
    const name = normalizeMarkiTemplateName(text.slice(5));
    return name ? `name:${name}` : MARKI_TEMPLATE_FILTERS.ALL;
  }
  return MARKI_TEMPLATE_FILTERS.ALL;
}

function isWorkspacePhotoFileRepairable(photo = {}) {
  if (photo.sourceType !== 'marki_api' || isArchivedPhoto(photo)) return false;
  if (photo.originalMissing === true || photo.fileHealth?.exists === false) return true;
  return [
    'missing',
    'not_file',
    'unreadable',
    'empty',
    'too_large',
    'unsupported_format',
    'decode_failed',
    'fingerprint_changed'
  ].includes(String(photo.fileHealth?.healthStatus || ''));
}

function isArchivedPhoto(photo = {}) {
  return (
    String(photo.sortStatus || '') === 'archived'
    || Boolean(photo.archivedAt)
    || photo.archiveResult?.success === true
    || photo.archiveResult?.stage === 'committed'
  );
}
