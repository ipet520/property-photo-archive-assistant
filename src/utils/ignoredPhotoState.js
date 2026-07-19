const IGNORED_SORT_STATUS = 'ignored';
const SAFE_PENDING_STATUS = 'not_run';
const RESTORABLE_SMART_SORT_STATUSES = new Set([
  'not_run',
  'failed',
  'completed',
  'needs_completion'
]);
const GROUP_COLLECTION_KEYS = Object.freeze([
  'photos',
  'items',
  'groupPhotos',
  'photoList'
]);

export const IGNORED_MEMBERSHIP_RESTORE_STATUS = Object.freeze({
  RESTORED: 'restored',
  NOT_REQUIRED: 'not_required',
  EXPIRED: 'membership_expired'
});

export function ignorePhotosInWorkspace({
  photos = [],
  smartSortResult = null,
  targetPhotoIds = [],
  recognitionStageStatusByPhotoId = {},
  now = () => new Date().toISOString()
} = {}) {
  const targetIds = new Set(normalizeIds(targetPhotoIds));
  const ignoredAt = now();
  const preparedSmartSortResult = ensureSmartSortResultIdentity(
    smartSortResult,
    ignoredAt
  );
  const membership = buildMembershipDetails(preparedSmartSortResult);
  const ignoredPhotoIds = [];
  const skippedPhotoIds = [];

  const nextPhotos = normalizeArray(photos).map((photo) => {
    const photoId = cleanText(photo?.id);
    if (!targetIds.has(photoId)) return photo;
    if (!canIgnorePhoto(photo)) {
      skippedPhotoIds.push(photoId);
      return photo;
    }

    ignoredPhotoIds.push(photoId);
    const membershipDetail = membership.get(photoId) || null;
    return {
      ...photo,
      sortStatus: IGNORED_SORT_STATUS,
      ignoredAt,
      ignoredPreviousState: {
        schemaVersion: 1,
        sortStatus: cleanText(photo?.sortStatus) || 'unassigned',
        smartSortStatus: normalizeRestorableSmartSortStatus(photo?.smartSortStatus),
        recognitionStageStatus: normalizeRecognitionStageStatus(
          recognitionStageStatusByPhotoId?.[photoId]
        ),
        groupMembership: membershipDetail
          ? buildStoredMembership(preparedSmartSortResult, membershipDetail)
          : null
      }
    };
  });

  const ignoredIdSet = new Set(ignoredPhotoIds);
  return {
    photos: nextPhotos,
    smartSortResult: removePhotosFromSmartSortResult(
      preparedSmartSortResult,
      ignoredIdSet,
      ignoredAt
    ),
    ignoredPhotoIds,
    skippedPhotoIds
  };
}

export function restoreIgnoredPhotosInWorkspace({
  photos = [],
  smartSortResult = null,
  targetPhotoIds = [],
  now = () => new Date().toISOString()
} = {}) {
  const targetIds = new Set(normalizeIds(targetPhotoIds));
  const restoredPhotoIds = [];
  const skippedPhotoIds = [];
  const membershipRestoredPhotoIds = [];
  const membershipExpiredPhotoIds = [];
  const restoredPhotosById = new Map();
  let nextSmartSortResult = smartSortResult;

  const nextPhotos = normalizeArray(photos).map((photo) => {
    const photoId = cleanText(photo?.id);
    if (!targetIds.has(photoId)) return photo;
    if (!isIgnoredPhoto(photo) || hasHighPriorityState(photo)) {
      skippedPhotoIds.push(photoId);
      return photo;
    }

    const previousState = normalizePreviousState(photo);
    const storedMembership = previousState.groupMembership;
    const canRestoreMembership = isStoredMembershipCurrent(
      storedMembership,
      nextSmartSortResult
    );
    const previousSmartSortStatus = normalizeRestorableSmartSortStatus(
      previousState.smartSortStatus
    );
    const requiresMembership = ['completed', 'needs_completion']
      .includes(previousSmartSortStatus);
    const membershipRestoreStatus = storedMembership && canRestoreMembership
      ? IGNORED_MEMBERSHIP_RESTORE_STATUS.RESTORED
      : requiresMembership
        ? IGNORED_MEMBERSHIP_RESTORE_STATUS.EXPIRED
        : IGNORED_MEMBERSHIP_RESTORE_STATUS.NOT_REQUIRED;
    const restoredSmartSortStatus = membershipRestoreStatus
      === IGNORED_MEMBERSHIP_RESTORE_STATUS.EXPIRED
      ? SAFE_PENDING_STATUS
      : previousSmartSortStatus;
    const {
      ignoredAt,
      ignoredPreviousState,
      ignoredPreviousSortStatus,
      ignoredMembershipRestoreStatus,
      ...basePhoto
    } = photo;
    const restoredPhoto = {
      ...basePhoto,
      sortStatus: normalizeRestoredSortStatus(previousState.sortStatus),
      smartSortStatus: restoredSmartSortStatus,
      ...(membershipRestoreStatus === IGNORED_MEMBERSHIP_RESTORE_STATUS.EXPIRED
        ? { ignoredMembershipRestoreStatus: membershipRestoreStatus }
        : {})
    };

    restoredPhotoIds.push(photoId);
    restoredPhotosById.set(photoId, restoredPhoto);
    if (membershipRestoreStatus === IGNORED_MEMBERSHIP_RESTORE_STATUS.RESTORED) {
      membershipRestoredPhotoIds.push(photoId);
    } else if (membershipRestoreStatus === IGNORED_MEMBERSHIP_RESTORE_STATUS.EXPIRED) {
      membershipExpiredPhotoIds.push(photoId);
    }
    return restoredPhoto;
  });

  for (const photoId of membershipRestoredPhotoIds) {
    const restoredPhoto = restoredPhotosById.get(photoId);
    const previousState = normalizePreviousState(
      normalizeArray(photos).find((photo) => cleanText(photo?.id) === photoId)
    );
    nextSmartSortResult = restorePhotoMembership(
      nextSmartSortResult,
      restoredPhoto,
      previousState.groupMembership,
      now()
    );
  }

  return {
    photos: nextPhotos,
    smartSortResult: nextSmartSortResult,
    restoredPhotoIds,
    skippedPhotoIds,
    membershipRestoredPhotoIds,
    membershipExpiredPhotoIds
  };
}

export function isIgnoredPhotoState(photo = {}) {
  return cleanText(photo?.sortStatus) === IGNORED_SORT_STATUS;
}

export function getIgnoredRecognitionStageStatus(photo = {}) {
  return normalizePreviousState(photo).recognitionStageStatus;
}

function canIgnorePhoto(photo = {}) {
  return Boolean(cleanText(photo?.id))
    && !isIgnoredPhoto(photo)
    && !hasHighPriorityState(photo);
}

function hasHighPriorityState(photo = {}) {
  const sortStatus = cleanText(photo?.sortStatus);
  return Boolean(photo?.originalMissing)
    || ['archived', 'archiving'].includes(sortStatus)
    || photo?.archiveResult?.status === '归档成功'
    || photo?.archiveResult?.success === true;
}

function isIgnoredPhoto(photo = {}) {
  return cleanText(photo?.sortStatus) === IGNORED_SORT_STATUS;
}

function normalizePreviousState(photo = {}) {
  const state = photo?.ignoredPreviousState;
  if (state && typeof state === 'object' && !Array.isArray(state)) {
    return {
      sortStatus: cleanText(state.sortStatus) || 'unassigned',
      smartSortStatus: normalizeRestorableSmartSortStatus(state.smartSortStatus),
      recognitionStageStatus: normalizeRecognitionStageStatus(
        state.recognitionStageStatus
      ),
      groupMembership: normalizeStoredMembership(state.groupMembership)
    };
  }
  return {
    sortStatus: cleanText(photo?.ignoredPreviousSortStatus) || 'unassigned',
    smartSortStatus: SAFE_PENDING_STATUS,
    recognitionStageStatus: 'staged',
    groupMembership: null
  };
}

function normalizeStoredMembership(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const resultId = cleanText(value.resultId);
  const groupId = cleanText(value.groupId);
  if (!resultId || !groupId) return null;
  return {
    resultId,
    groupId,
    groupSnapshot: normalizeGroupSnapshot(value.groupSnapshot),
    collectionKeys: normalizeCollectionKeys(value.collectionKeys)
  };
}

function buildStoredMembership(smartSortResult, detail) {
  return {
    resultId: getSmartSortResultIdentity(smartSortResult),
    groupId: detail.groupId,
    groupSnapshot: buildGroupSnapshot(detail.group),
    collectionKeys: detail.collectionKeys
  };
}

function buildMembershipDetails(smartSortResult) {
  const membership = new Map();
  for (const group of normalizeArray(smartSortResult?.groups)) {
    const groupId = cleanText(group?.id);
    if (!groupId) continue;
    const collectionKeys = [];
    if (Array.isArray(group.photoIds)) collectionKeys.push('photoIds');
    GROUP_COLLECTION_KEYS.forEach((key) => {
      if (Array.isArray(group?.[key])) collectionKeys.push(key);
    });
    if (Array.isArray(group.photoPaths)) collectionKeys.push('photoPaths');
    for (const photoId of getGroupMemberIds(group)) {
      if (!membership.has(photoId)) {
        membership.set(photoId, {
          groupId,
          group,
          collectionKeys
        });
      }
    }
  }
  return membership;
}

function removePhotosFromSmartSortResult(smartSortResult, targetIds, updatedAt) {
  if (!smartSortResult || targetIds.size === 0) return smartSortResult;
  let changed = false;
  const groups = normalizeArray(smartSortResult.groups)
    .map((group) => {
      const memberIds = getGroupMemberIds(group);
      if (![...memberIds].some((photoId) => targetIds.has(photoId))) return group;
      changed = true;
      return filterGroupMembers(group, (photoId) => !targetIds.has(photoId));
    })
    .filter(Boolean);
  if (!changed) return smartSortResult;
  const photoCount = countUniqueGroupMembers(groups);
  return {
    ...smartSortResult,
    groups,
    groupCount: groups.length,
    photoCount,
    status: groups.length ? smartSortResult.status : 'empty',
    updatedAt
  };
}

function restorePhotoMembership(
  smartSortResult,
  photo,
  storedMembership,
  updatedAt
) {
  if (!isStoredMembershipCurrent(storedMembership, smartSortResult)) {
    return smartSortResult;
  }
  const currentMembership = buildMembershipDetails(smartSortResult);
  if (currentMembership.has(cleanText(photo?.id))) return smartSortResult;

  const groupIndex = normalizeArray(smartSortResult?.groups)
    .findIndex((group) => cleanText(group?.id) === storedMembership.groupId);
  const groups = [...normalizeArray(smartSortResult?.groups)];
  if (groupIndex >= 0) {
    groups[groupIndex] = appendPhotoToGroup(
      groups[groupIndex],
      photo,
      storedMembership.collectionKeys
    );
  } else {
    groups.push(appendPhotoToGroup(
      {
        ...normalizeGroupSnapshot(storedMembership.groupSnapshot),
        id: storedMembership.groupId
      },
      photo,
      storedMembership.collectionKeys
    ));
  }
  return {
    ...smartSortResult,
    groups,
    groupCount: groups.length,
    photoCount: countUniqueGroupMembers(groups),
    status: groups.length ? 'created' : 'empty',
    updatedAt
  };
}

function isStoredMembershipCurrent(storedMembership, smartSortResult) {
  return Boolean(
    storedMembership
    && cleanText(storedMembership.resultId)
    && getSmartSortResultIdentity(smartSortResult)
    && cleanText(storedMembership.resultId) === getSmartSortResultIdentity(smartSortResult)
  );
}

function filterGroupMembers(group, predicate) {
  const memberIds = getGroupMemberIds(group);
  const retainedIds = new Set([...memberIds].filter(predicate));
  if (retainedIds.size === 0) return null;
  const nextGroup = { ...group };
  if (Array.isArray(group.photoIds)) {
    nextGroup.photoIds = normalizeIds(group.photoIds)
      .filter((photoId) => retainedIds.has(photoId));
  }
  GROUP_COLLECTION_KEYS.forEach((key) => {
    if (!Array.isArray(group?.[key])) return;
    nextGroup[key] = group[key].filter((item) => (
      retainedIds.has(cleanText(item?.photoId || item?.id))
    ));
  });
  if (Array.isArray(group.photoPaths)) {
    const retainedPaths = new Set(GROUP_COLLECTION_KEYS
      .flatMap((key) => Array.isArray(nextGroup?.[key]) ? nextGroup[key] : [])
      .map((item) => cleanText(item?.filePath || item?.originalPath || item?.path))
      .filter(Boolean));
    if (retainedPaths.size > 0) {
      nextGroup.photoPaths = group.photoPaths
        .map(cleanText)
        .filter((photoPath) => retainedPaths.has(photoPath));
    }
  }
  nextGroup.photoCount = retainedIds.size;
  return nextGroup;
}

function appendPhotoToGroup(group, photo, collectionKeys) {
  const keys = normalizeCollectionKeys(collectionKeys);
  const effectiveKeys = keys.length ? keys : ['photoIds'];
  const photoId = cleanText(photo?.id);
  const member = buildMinimalGroupMember(photo);
  const nextGroup = { ...group };
  if (effectiveKeys.includes('photoIds')) {
    nextGroup.photoIds = uniqueStrings([
      ...normalizeIds(group?.photoIds),
      photoId
    ]);
  }
  GROUP_COLLECTION_KEYS.forEach((key) => {
    if (!effectiveKeys.includes(key)) return;
    const current = normalizeArray(group?.[key]);
    nextGroup[key] = current.some((item) => (
      cleanText(item?.photoId || item?.id) === photoId
    ))
      ? current
      : [...current, member];
  });
  if (effectiveKeys.includes('photoPaths')) {
    nextGroup.photoPaths = uniqueStrings([
      ...normalizeArray(group?.photoPaths),
      photo?.originalPath
    ]);
  }
  nextGroup.photoCount = getGroupMemberIds(nextGroup).size;
  return nextGroup;
}

function buildMinimalGroupMember(photo = {}) {
  return {
    photoId: cleanText(photo.id),
    filePath: cleanText(photo.originalPath),
    fileName: cleanText(photo.originalName),
    capturedAt: cleanText(photo.capturedAt),
    modifiedAt: cleanText(photo.modifiedAt),
    postTime: cleanText(photo.postTime)
  };
}

function buildGroupSnapshot(group = {}) {
  return normalizeGroupSnapshot({
    schemaVersion: group.schemaVersion,
    id: group.id,
    title: group.title,
    status: group.status,
    basis: group.basis,
    summary: group.summary,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    confidence: group.confidence,
    confidenceLabel: group.confidenceLabel
  });
}

function normalizeGroupSnapshot(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const snapshot = {};
  [
    'schemaVersion',
    'id',
    'title',
    'status',
    'basis',
    'summary',
    'createdAt',
    'updatedAt',
    'confidence',
    'confidenceLabel'
  ].forEach((key) => {
    const item = value[key];
    if (typeof item === 'string' || typeof item === 'number') {
      snapshot[key] = item;
    }
  });
  return snapshot;
}

function normalizeCollectionKeys(value) {
  const allowed = new Set([
    'photoIds',
    'photoPaths',
    ...GROUP_COLLECTION_KEYS
  ]);
  return uniqueStrings(normalizeArray(value))
    .filter((key) => allowed.has(key));
}

function getGroupMemberIds(group = {}) {
  const photoIds = new Set(normalizeIds(group?.photoIds));
  GROUP_COLLECTION_KEYS.forEach((key) => {
    normalizeArray(group?.[key]).forEach((item) => {
      const photoId = cleanText(item?.photoId || item?.id);
      if (photoId) photoIds.add(photoId);
    });
  });
  return photoIds;
}

function countUniqueGroupMembers(groups) {
  const photoIds = new Set();
  normalizeArray(groups).forEach((group) => {
    getGroupMemberIds(group).forEach((photoId) => photoIds.add(photoId));
  });
  return photoIds.size;
}

function ensureSmartSortResultIdentity(smartSortResult, nowValue) {
  if (!smartSortResult || getSmartSortResultIdentity(smartSortResult)) {
    return smartSortResult;
  }
  return {
    ...smartSortResult,
    membershipVersion: `ignored-membership-${cleanText(nowValue)}`
  };
}

function getSmartSortResultIdentity(smartSortResult) {
  return cleanText(
    smartSortResult?.id
    || smartSortResult?.membershipVersion
  );
}

function normalizeRestorableSmartSortStatus(value) {
  const status = cleanText(value);
  return RESTORABLE_SMART_SORT_STATUSES.has(status)
    ? status
    : SAFE_PENDING_STATUS;
}

function normalizeRecognitionStageStatus(value) {
  const status = cleanText(value);
  return ['pending_review', 'reviewed', 'staged'].includes(status)
    ? status
    : 'staged';
}

function normalizeRestoredSortStatus(value) {
  const status = cleanText(value);
  return status && status !== IGNORED_SORT_STATUS ? status : 'unassigned';
}

function normalizeIds(value) {
  return normalizeArray(value).map(cleanText).filter(Boolean);
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(value) {
  return [...new Set(normalizeArray(value).map(cleanText).filter(Boolean))];
}

function cleanText(value) {
  return typeof value === 'string'
    ? value.trim()
    : value == null
      ? ''
      : String(value).trim();
}
