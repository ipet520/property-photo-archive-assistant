import {
  buildSmartGroupDescriptor,
  normalizeSmartGroupDescriptor
} from './smartGroupKey.js';

export function rebuildSmartSortResult({
  photos = [],
  sourceCanonicalByPhotoId = {},
  effectiveArchiveInfoByPhotoId = {},
  previousSmartSortResult = null,
  includePhotoIds = []
} = {}) {
  const previousGroups = Array.isArray(previousSmartSortResult?.groups)
    ? previousSmartSortResult.groups
    : [];
  const previousGroupByKey = new Map();
  for (const group of previousGroups) {
    const groupKey = cleanValue(group?.groupKey);
    if (groupKey && !previousGroupByKey.has(groupKey)) previousGroupByKey.set(groupKey, group);
  }
  const explicitlyIncluded = new Set(
    (Array.isArray(includePhotoIds) ? includePhotoIds : []).map(cleanValue).filter(Boolean)
  );

  const buckets = new Map();
  for (const photo of Array.isArray(photos) ? photos : []) {
    const photoId = cleanValue(photo?.id);
    const effectiveInfo = effectiveArchiveInfoByPhotoId[photoId]
      || sourceCanonicalByPhotoId[photoId]
      || {};
    if (!photoId || !isPhotoEligibleForSmartGroupRebuild(photo, explicitlyIncluded, effectiveInfo)) continue;
    const descriptor = normalizeSmartGroupDescriptor(
      buildSmartGroupDescriptor({
        photo,
        canonicalFields: effectiveInfo
      }),
      photoId
    );
    if (!buckets.has(descriptor.groupKey)) {
      buckets.set(descriptor.groupKey, {
        descriptor,
        photoIds: []
      });
    }
    buckets.get(descriptor.groupKey).photoIds.push(photoId);
  }

  const groups = [...buckets.values()].map(({ descriptor, photoIds }) => {
    const oldGroup = previousGroupByKey.get(descriptor.groupKey) || {};
    return {
      ...oldGroup,
      id: `smart-group-${hashKey(descriptor.groupKey)}`,
      groupKey: descriptor.groupKey,
      title: descriptor.title,
      basis: 'business_fields',
      photoIds,
      photos: photoIds.map((photoId) => ({ photoId })),
      suggestedFields: { ...descriptor.fields },
      groupValidity: descriptor.missingFields.length ? 'needs_completion' : 'valid',
      missingFields: [...descriptor.missingFields],
      warnings: descriptor.missingFields.length
        ? ['该组包含待补全字段，补全后会重新计算业务分组。']
        : []
    };
  });
  return {
    ...(previousSmartSortResult || {}),
    groups,
    groupCount: groups.length,
    photoCount: groups.reduce((total, group) => total + group.photoIds.length, 0),
    status: groups.length ? 'created' : 'empty',
    updatedAt: new Date().toISOString()
  };
}

export function isPhotoEligibleForSmartGroupRebuild(
  photo = {},
  explicitlyIncluded = new Set(),
  effectiveInfo = {}
) {
  const photoId = cleanValue(photo?.id);
  if (!photoId) return false;
  const sortStatus = cleanValue(photo.sortStatus);
  const smartSortStatus = cleanValue(photo.smartSortStatus);
  if (
    ['ignored', 'archived', 'archiving'].includes(sortStatus)
    || photo?.archiveResult?.status === '归档成功'
    || photo?.archiveResult?.success === true
    || ['filtered_unwatermarked', 'watermark_unknown'].includes(cleanValue(photo.selectedSourceStatus))
    || ['unwatermarked', 'watermark_unknown'].includes(cleanValue(photo.watermarkStatus))
    || smartSortStatus === 'failed'
  ) {
    return false;
  }
  const fileHealthStatus = cleanValue(photo?.fileHealth?.healthStatus);
  const fileIsHealthy = photo.originalMissing !== true && (
    !fileHealthStatus
    || ['healthy', 'fingerprint_unknown'].includes(fileHealthStatus)
  );
  const completeMarkiPlatformData = cleanValue(photo.sourceType) === 'marki_api'
    && hasCompleteBusinessGroupingData(effectiveInfo);
  if (!fileIsHealthy && !completeMarkiPlatformData) return false;
  if (explicitlyIncluded.has(photoId)) return true;
  return ['completed', 'needs_completion'].includes(smartSortStatus);
}

export function migrateGroupDraftsByGroupKey(
  previousSmartSortResult = null,
  nextSmartSortResult = null,
  previousDraftsByGroupId = {}
) {
  const draftByGroupKey = new Map();
  for (const group of Array.isArray(previousSmartSortResult?.groups) ? previousSmartSortResult.groups : []) {
    const groupKey = cleanValue(group?.groupKey);
    const draft = previousDraftsByGroupId?.[group?.id];
    if (groupKey && draft && typeof draft === 'object' && !Array.isArray(draft)) {
      draftByGroupKey.set(groupKey, structuredClone(draft));
    }
  }
  return Object.fromEntries(
    (Array.isArray(nextSmartSortResult?.groups) ? nextSmartSortResult.groups : [])
      .map((group) => [group.id, draftByGroupKey.get(cleanValue(group.groupKey))])
      .filter(([, draft]) => draft)
  );
}

function hasCompleteBusinessGroupingData(value = {}) {
  const template = cleanValue(value.watermarkTemplateType);
  return Boolean(
    cleanValue(value.date)
    && cleanValue(value.projectId || value.projectName || value.project)
    && cleanValue(value.archiveCategory || value.watermarkCategory)
    && (
      template === 'time_location'
      || cleanValue(value.workContent || value.violationType)
    )
  );
}

function hashKey(value) {
  let hash = 2166136261;
  for (const char of String(value || '')) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function cleanValue(value) {
  return String(value ?? '').trim();
}
