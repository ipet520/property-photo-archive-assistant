export const MARKI_WATERMARK_FILTERS = Object.freeze({
  WATERMARKED: 'watermarked',
  UNWATERMARKED: 'unwatermarked',
  UNKNOWN: 'watermark_unknown',
  ALL: 'all'
});

export const MARKI_IMPORT_STATUS_FILTERS = Object.freeze([
  { value: 'all', label: '全部状态' },
  { value: 'not_imported', label: '未导入' },
  { value: 'imported_active', label: '已在工作池' },
  { value: 'workspace_file_repairable', label: '工作池文件需修复' },
  { value: 'removed_reimportable', label: '可重新导入' },
  { value: 'failed_retryable', label: '导入失败' },
  { value: 'filtered', label: '已过滤' }
]);

const SELECTABLE_STATUSES = new Set([
  'discovered',
  'workspace_file_repairable',
  'removed_reimportable',
  'failed_retryable'
]);

export function normalizeMarkiWatermarkName(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
}

export function buildMarkiWatermarkFilterOptions(photos = []) {
  const names = new Map();
  for (const photo of photos) {
    if (getWatermarkStatus(photo) !== MARKI_WATERMARK_FILTERS.WATERMARKED) continue;
    const name = normalizeMarkiWatermarkName(photo.markName);
    if (!name) continue;
    names.set(
      photo.watermarkKey || `name:${name}`,
      name === '时间地点(兜底选择)' ? '时间地点（兜底选择）' : name
    );
  }
  return [
    { value: MARKI_WATERMARK_FILTERS.WATERMARKED, label: '全部有水印' },
    ...[...names.entries()]
      .sort((left, right) => left[1].localeCompare(right[1], 'zh-CN'))
      .map(([value, label]) => ({ value, label })),
    { value: MARKI_WATERMARK_FILTERS.UNWATERMARKED, label: '无水印' },
    { value: MARKI_WATERMARK_FILTERS.UNKNOWN, label: '水印状态待确认' },
    { value: MARKI_WATERMARK_FILTERS.ALL, label: '全部结果' }
  ];
}

export function filterMarkiQueryPhotos(photos = [], filters = {}) {
  const watermarkFilter = String(filters.watermarkFilter || MARKI_WATERMARK_FILTERS.WATERMARKED);
  const importStatusFilter = String(filters.importStatusFilter || 'all');
  return photos.filter((photo) => (
    matchesWatermarkFilter(photo, watermarkFilter)
    && matchesImportStatusFilter(photo, importStatusFilter)
  ));
}

export function isMarkiQueryPhotoSelectable(photo) {
  return getWatermarkStatus(photo) === MARKI_WATERMARK_FILTERS.WATERMARKED
    && SELECTABLE_STATUSES.has(String(photo.selectedSourceStatus || ''));
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
    unwatermarkedCount: rawPhotos.filter(
      (photo) => getWatermarkStatus(photo) === MARKI_WATERMARK_FILTERS.UNWATERMARKED
    ).length,
    watermarkUnknownCount: rawPhotos.filter(
      (photo) => getWatermarkStatus(photo) === MARKI_WATERMARK_FILTERS.UNKNOWN
    ).length,
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
  const photos = (Array.isArray(workspace.photos) ? workspace.photos : []).map((photo) => {
    const incoming = incomingBySourceKey.get(String(photo?.sourceKey || ''));
    if (!incoming || !isWorkspacePhotoFileRepairable(photo)) return photo;
    repairedCount += 1;
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
    filtered_unwatermarked: '无水印已过滤',
    watermark_unknown: '水印状态待确认',
    queued: '等待导入',
    downloading: '正在导入',
    downloaded: '已下载',
    append_pending: '待进入工作池',
    archived_locked: '已归档',
    unavailable: '工作池状态不可用'
  }[status] || '状态未知';
}

function matchesWatermarkFilter(photo, filter) {
  if (filter === MARKI_WATERMARK_FILTERS.ALL) return true;
  const status = getWatermarkStatus(photo);
  if (filter === MARKI_WATERMARK_FILTERS.WATERMARKED) {
    return status === MARKI_WATERMARK_FILTERS.WATERMARKED;
  }
  if (filter === MARKI_WATERMARK_FILTERS.UNWATERMARKED) {
    return status === MARKI_WATERMARK_FILTERS.UNWATERMARKED;
  }
  if (filter === MARKI_WATERMARK_FILTERS.UNKNOWN) {
    return status === MARKI_WATERMARK_FILTERS.UNKNOWN;
  }
  return status === MARKI_WATERMARK_FILTERS.WATERMARKED
    && String(photo.watermarkKey || '') === filter;
}

function matchesImportStatusFilter(photo, filter) {
  const status = String(photo?.selectedSourceStatus || '');
  if (filter === 'all') return true;
  if (filter === 'not_imported') return status === 'discovered';
  if (filter === 'filtered') {
    return ['filtered_unwatermarked', 'watermark_unknown'].includes(status);
  }
  return status === filter;
}

function getWatermarkStatus(photo) {
  const status = String(photo?.watermarkStatus || '');
  if ([
    MARKI_WATERMARK_FILTERS.WATERMARKED,
    MARKI_WATERMARK_FILTERS.UNWATERMARKED,
    MARKI_WATERMARK_FILTERS.UNKNOWN
  ].includes(status)) {
    return status;
  }
  if (photo?.isWatermarked === true) return MARKI_WATERMARK_FILTERS.WATERMARKED;
  if (photo?.isWatermarked === false) return MARKI_WATERMARK_FILTERS.UNWATERMARKED;
  return MARKI_WATERMARK_FILTERS.UNKNOWN;
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
