export const MARKI_WATERMARK_FILTERS = Object.freeze({
  WATERMARKED: 'watermarked',
  UNWATERMARKED: 'unwatermarked',
  ALL: 'all'
});

export const MARKI_IMPORT_STATUS_FILTERS = Object.freeze([
  { value: 'all', label: '全部状态' },
  { value: 'not_imported', label: '未导入' },
  { value: 'imported_active', label: '已在工作池' },
  { value: 'removed_reimportable', label: '可重新导入' },
  { value: 'failed_retryable', label: '导入失败' },
  { value: 'filtered', label: '已过滤' }
]);

const SELECTABLE_STATUSES = new Set([
  'discovered',
  'removed_reimportable',
  'failed_retryable'
]);

export function normalizeMarkiWatermarkName(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
}

export function buildMarkiWatermarkFilterOptions(photos = []) {
  const names = new Map();
  for (const photo of photos) {
    if (photo?.isWatermarked !== true) continue;
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
    { value: MARKI_WATERMARK_FILTERS.ALL, label: '全部（含无水印）' }
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
  return photo?.isWatermarked === true
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
    unwatermarkedCount: rawPhotos.filter((photo) => photo?.isWatermarked !== true).length,
    selectableCount: filteredPhotos.filter(isMarkiQueryPhotoSelectable).length
  };
}

export function formatMarkiImportLifecycleStatus(status) {
  return {
    discovered: '未导入',
    imported_active: '已在工作池',
    removed_reimportable: '可重新导入',
    failed_retryable: '导入失败',
    filtered_unwatermarked: '无水印已过滤',
    queued: '等待导入',
    downloading: '正在导入',
    downloaded: '已下载',
    append_pending: '待进入工作池',
    archived_locked: '已归档'
  }[status] || '状态未知';
}

function matchesWatermarkFilter(photo, filter) {
  if (filter === MARKI_WATERMARK_FILTERS.ALL) return true;
  if (filter === MARKI_WATERMARK_FILTERS.WATERMARKED) return photo?.isWatermarked === true;
  if (filter === MARKI_WATERMARK_FILTERS.UNWATERMARKED) return photo?.isWatermarked !== true;
  return photo?.isWatermarked === true && String(photo.watermarkKey || '') === filter;
}

function matchesImportStatusFilter(photo, filter) {
  const status = String(photo?.selectedSourceStatus || '');
  if (filter === 'all') return true;
  if (filter === 'not_imported') return status === 'discovered';
  if (filter === 'filtered') return status === 'filtered_unwatermarked';
  return status === filter;
}
