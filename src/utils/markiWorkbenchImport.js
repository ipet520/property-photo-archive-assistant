const WORKBENCH_PACKAGE_FIELDS = [
  'batchId',
  'photos',
  'recognitionResultsByPhoto',
  'watermarkRecordsByPhoto',
  'archiveSuggestionsByPhoto'
];

const SPECIAL_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SKIP_REASONS = {
  duplicateSourceKey: 'duplicate_source_key',
  conflictingPhotoId: 'conflicting_photo_id'
};

export class MarkiWorkbenchImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MarkiWorkbenchImportError';
    this.code = code;
  }
}

export function mergeMarkiWorkbenchImportPackage(currentState, workbenchImportPackage) {
  const current = normalizeCurrentState(currentState);
  const incoming = validateWorkbenchImportPackage(workbenchImportPackage);
  const existingPhotoIds = new Set();
  const existingSourceKeys = new Map();

  for (const photo of current.photos) {
    const photoId = normalizeRequiredString(photo?.id);
    if (photoId) existingPhotoIds.add(photoId);
    const sourceKey = normalizeRequiredString(photo?.sourceKey);
    if (sourceKey && !existingSourceKeys.has(sourceKey)) {
      existingSourceKeys.set(sourceKey, photoId);
    }
  }
  for (const map of [
    current.recognitionResultsByPhoto,
    current.watermarkRecordsByPhoto,
    current.archiveSuggestionsByPhoto
  ]) {
    for (const photoId of Object.keys(map)) {
      existingPhotoIds.add(photoId);
    }
  }

  const acceptedPhotos = [];
  const addedPhotoIds = [];
  const skippedItems = [];
  let duplicateCount = 0;
  let conflictCount = 0;

  for (const photo of incoming.photos) {
    const photoId = photo.id.trim();
    const sourceKey = photo.sourceKey.trim();
    if (existingSourceKeys.has(sourceKey)) {
      duplicateCount += 1;
      skippedItems.push({
        photoId,
        sourceKey,
        reason: SKIP_REASONS.duplicateSourceKey,
        existingPhotoId: existingSourceKeys.get(sourceKey) || ''
      });
      continue;
    }
    if (existingPhotoIds.has(photoId)) {
      conflictCount += 1;
      skippedItems.push({
        photoId,
        sourceKey,
        reason: SKIP_REASONS.conflictingPhotoId,
        existingPhotoId: photoId
      });
      continue;
    }

    acceptedPhotos.push(photo);
    addedPhotoIds.push(photoId);
    existingPhotoIds.add(photoId);
    existingSourceKeys.set(sourceKey, photoId);
  }

  const stats = {
    inputCount: incoming.photos.length,
    addedCount: acceptedPhotos.length,
    duplicateCount,
    conflictCount,
    skippedItems
  };

  if (acceptedPhotos.length === 0) {
    return {
      ...current,
      addedPhotoIds,
      stats
    };
  }

  const nextRecognitionResults = { ...current.recognitionResultsByPhoto };
  const nextWatermarkRecords = { ...current.watermarkRecordsByPhoto };
  const nextArchiveSuggestions = { ...current.archiveSuggestionsByPhoto };
  for (const photoId of addedPhotoIds) {
    nextRecognitionResults[photoId] = incoming.recognitionResultsByPhoto[photoId];
    nextWatermarkRecords[photoId] = incoming.watermarkRecordsByPhoto[photoId];
    nextArchiveSuggestions[photoId] = incoming.archiveSuggestionsByPhoto[photoId];
  }

  const nextSelectedIds = [...current.selectedIds];
  const selectedIdSet = new Set(nextSelectedIds);
  for (const photoId of addedPhotoIds) {
    if (selectedIdSet.has(photoId)) continue;
    selectedIdSet.add(photoId);
    nextSelectedIds.push(photoId);
  }

  return {
    photos: [...current.photos, ...acceptedPhotos],
    recognitionResultsByPhoto: nextRecognitionResults,
    watermarkRecordsByPhoto: nextWatermarkRecords,
    archiveSuggestionsByPhoto: nextArchiveSuggestions,
    selectedIds: nextSelectedIds,
    activePhotoId: addedPhotoIds[0],
    addedPhotoIds,
    stats
  };
}

function normalizeCurrentState(currentState) {
  if (!isPlainObject(currentState)) {
    throw new MarkiWorkbenchImportError('marki_workbench_state_invalid', '当前工作台状态无效，无法追加照片。');
  }
  const photos = Array.isArray(currentState.photos) ? currentState.photos : [];
  const recognitionResultsByPhoto = normalizeStateMap(currentState.recognitionResultsByPhoto);
  const watermarkRecordsByPhoto = normalizeStateMap(currentState.watermarkRecordsByPhoto);
  const archiveSuggestionsByPhoto = normalizeStateMap(currentState.archiveSuggestionsByPhoto);
  const selectedIds = Array.isArray(currentState.selectedIds) ? currentState.selectedIds : [];
  return {
    photos,
    recognitionResultsByPhoto,
    watermarkRecordsByPhoto,
    archiveSuggestionsByPhoto,
    selectedIds,
    activePhotoId: normalizeRequiredString(currentState.activePhotoId)
  };
}

function normalizeStateMap(value) {
  return isPlainObject(value) ? value : {};
}

function validateWorkbenchImportPackage(value) {
  if (!isPlainObject(value)) {
    throwPackageError();
  }
  const keys = Object.keys(value);
  if (
    keys.length !== WORKBENCH_PACKAGE_FIELDS.length
    || WORKBENCH_PACKAGE_FIELDS.some((field) => !Object.hasOwn(value, field))
    || keys.some((key) => !WORKBENCH_PACKAGE_FIELDS.includes(key))
  ) {
    throwPackageError();
  }
  assertNoSpecialObjectKeys(value);

  if (!isSafeIdentifier(value.batchId) || value.batchId !== value.batchId.trim()) {
    throw new MarkiWorkbenchImportError('marki_workbench_batch_id_invalid', '马克导入批次标识无效。');
  }
  if (!Array.isArray(value.photos)) {
    throwPackageError();
  }

  const maps = [
    value.recognitionResultsByPhoto,
    value.watermarkRecordsByPhoto,
    value.archiveSuggestionsByPhoto
  ];
  if (maps.some((entry) => !isPlainObject(entry))) {
    throwPackageError();
  }

  const photoIds = new Set();
  for (const photo of value.photos) {
    if (!isPlainObject(photo)) throwPackageError();
    const photoId = normalizeRequiredString(photo.id);
    const sourceKey = normalizeRequiredString(photo.sourceKey);
    if (
      !isSafeIdentifier(photoId)
      || photo.id !== photoId
      || photo.sourceType !== 'marki_api'
      || !sourceKey.startsWith('marki_api:')
      || photo.sourceKey !== sourceKey
      || containsControlCharacter(sourceKey)
      || SPECIAL_OBJECT_KEYS.has(photoId)
    ) {
      throw new MarkiWorkbenchImportError('marki_workbench_photo_invalid', '马克导入照片数据无效。');
    }
    photoIds.add(photoId);
  }

  for (const map of maps) {
    const mapKeys = Object.keys(map);
    if (
      value.photos.some((photo) => !Object.hasOwn(map, photo.id.trim()))
      || mapKeys.some((photoId) => !photoIds.has(photoId))
    ) {
      throw new MarkiWorkbenchImportError('marki_workbench_mapping_invalid', '马克导入照片与结构化数据不一致。');
    }
  }

  return value;
}

function assertNoSpecialObjectKeys(value, visited = new Set()) {
  if (!value || typeof value !== 'object' || visited.has(value)) return;
  visited.add(value);
  for (const key of Object.keys(value)) {
    if (SPECIAL_OBJECT_KEYS.has(key.trim())) {
      throw new MarkiWorkbenchImportError('marki_workbench_special_key_rejected', '马克导入数据包含不允许的字段。');
    }
    assertNoSpecialObjectKeys(value[key], visited);
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeIdentifier(value) {
  const normalized = normalizeRequiredString(value);
  return Boolean(
    normalized
    && normalized !== '.'
    && normalized !== '..'
    && !/[\\/]/.test(normalized)
    && !containsControlCharacter(normalized)
    && !SPECIAL_OBJECT_KEYS.has(normalized)
  );
}

function normalizeRequiredString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function containsControlCharacter(value) {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function throwPackageError() {
  throw new MarkiWorkbenchImportError('marki_workbench_package_invalid', '马克工作台导入包结构无效。');
}
