const MARKI_SOURCE_TYPE = 'marki_api';
const LOCAL_SOURCE_TYPE = 'local_file';
const ACTIVE_CONTEXT_SOURCE = 'active_project_context';

export function mergeScannedLocalPhotoSubpool({
  currentPhotos = [],
  scannedPhotos = [],
  archivedMatches = {},
  recognitionResultsByPhoto = {},
  watermarkRecordsByPhoto = {},
  archiveSuggestionsByPhoto = {},
  selectedIds = [],
  activePhotoId = '',
  activeProject = null
} = {}) {
  const projectId = cleanId(activeProject?.projectId);
  const projectName = cleanId(activeProject?.projectName);
  if (!projectId || !projectName) {
    const error = new Error('请选择当前工作项目。');
    error.code = 'active_project_required';
    throw error;
  }
  const safeCurrentPhotos = Array.isArray(currentPhotos) ? currentPhotos : [];
  const safeScannedPhotos = Array.isArray(scannedPhotos) ? scannedPhotos : [];
  const retainedPhotoIds = new Set(
    safeCurrentPhotos.map((photo) => cleanId(photo?.id)).filter(Boolean)
  );
  const knownContentHashes = new Set(
    safeCurrentPhotos.map((photo) => normalizeSha256(photo?.sha256)).filter(Boolean)
  );
  let nextPhotos = [...safeCurrentPhotos];
  const addedPhotoIds = [];
  let duplicateCount = 0;
  let projectConflictCount = 0;
  let rejectedCount = 0;

  for (const rawPhoto of safeScannedPhotos) {
    const normalized = createScannedLocalPhoto(rawPhoto, { projectId, projectName });
    if (!normalized) {
      rejectedCount += 1;
      continue;
    }
    if (knownContentHashes.has(normalized.sha256)) {
      const existing = safeCurrentPhotos.find(
        (photo) => normalizeSha256(photo?.sha256) === normalized.sha256
      );
      if (existing?.projectId && cleanId(existing.projectId) !== projectId) {
        projectConflictCount += 1;
      }
      duplicateCount += 1;
      continue;
    }
    const newPhoto = applyArchivedMatch(normalized, archivedMatches?.[rawPhoto?.id]);
    nextPhotos.push(newPhoto);
    retainedPhotoIds.add(newPhoto.id);
    knownContentHashes.add(newPhoto.sha256);
    addedPhotoIds.push(newPhoto.id);
  }

  const nextSelectedIds = uniqueIds([
    ...selectedIds.filter((photoId) => retainedPhotoIds.has(cleanId(photoId))),
    ...addedPhotoIds
  ]);
  const nextActivePhotoId = retainedPhotoIds.has(cleanId(activePhotoId))
    ? cleanId(activePhotoId)
    : addedPhotoIds[0] || nextPhotos[0]?.id || '';

  return {
    photos: nextPhotos,
    recognitionResultsByPhoto,
    watermarkRecordsByPhoto,
    archiveSuggestionsByPhoto,
    selectedIds: nextSelectedIds,
    activePhotoId: nextActivePhotoId,
    localPoolChanged: addedPhotoIds.length > 0,
    stats: {
      scannedCount: safeScannedPhotos.length,
      retainedMarkiCount: safeCurrentPhotos.filter(isMarkiPhoto).length,
      retainedLocalCount: safeCurrentPhotos.filter(isLocalPhoto).length,
      addedLocalCount: addedPhotoIds.length,
      duplicateCount,
      projectConflictCount,
      rejectedCount
    }
  };
}

function createScannedLocalPhoto(photo = {}, activeProject = {}) {
  const sourceType = cleanId(photo?.sourceType);
  if (
    (sourceType && sourceType !== LOCAL_SOURCE_TYPE)
    || cleanId(photo?.sourceKey)
    || cleanId(photo?.sourceMetadataRef)
  ) {
    return null;
  }
  const sha256 = normalizeSha256(photo?.sha256);
  const originalPath = cleanId(photo?.path || photo?.originalPath);
  if (!sha256 || !originalPath) return null;
  const originalName = cleanId(photo?.name || photo?.originalName);
  const previewUrl = cleanId(photo?.previewUrl || photo?.thumbnailPath);
  return {
    id: `local-${sha256}`,
    sourceType: LOCAL_SOURCE_TYPE,
    originalPath,
    originalName,
    extension: cleanId(photo?.extension),
    size: Number(photo?.size) || 0,
    sha256,
    modifiedAt: cleanId(photo?.modifiedAt),
    thumbnailPath: previewUrl,
    previewUrl,
    selected: false,
    sortStatus: 'unassigned',
    smartSortStatus: 'not_run',
    projectId: activeProject.projectId,
    projectName: activeProject.projectName,
    projectAssignmentSource: ACTIVE_CONTEXT_SOURCE,
    archiveInfo: null,
    previewInfo: null,
    archiveResult: null,
    originalMissing: false
  };
}

function applyArchivedMatch(photo, record) {
  return record ? buildArchivedScannedPhoto(photo, record) : photo;
}

function buildArchivedScannedPhoto(photo, record = {}) {
  const archiveInfo = {
    project: record.project || '',
    watermarkCategory: record.watermarkCategory || '',
    workContent: record.workContent || '',
    date: record.date || '',
    location: record.location || '',
    keywords: record.keywords || '',
    remark: record.remark || ''
  };
  const archiveResult = {
    id: photo.id,
    status: '归档成功',
    targetPath: record.archivePath || '',
    newFileName: record.newFileName || '',
    originalName: record.originalName || photo.originalName
  };
  return {
    ...photo,
    sortStatus: 'archived',
    archiveInfo,
    previewInfo: { ...archiveInfo, ...archiveResult },
    archiveResult,
    archiveMethod: '归档台账',
    archivedAt: record.archivedAt || ''
  };
}

function isMarkiPhoto(photo) {
  return cleanId(photo?.sourceType) === MARKI_SOURCE_TYPE;
}

function isLocalPhoto(photo) {
  const sourceType = cleanId(photo?.sourceType);
  return sourceType === LOCAL_SOURCE_TYPE || !sourceType;
}

function uniqueIds(values) {
  return [...new Set(values.map(cleanId).filter(Boolean))];
}

function normalizeSha256(value) {
  const sha256 = cleanId(value).toLowerCase();
  return /^[a-f0-9]{64}$/.test(sha256) ? sha256 : '';
}

function cleanId(value) {
  return typeof value === 'string'
    ? value.trim()
    : value == null
      ? ''
      : String(value).trim();
}
