import {
  buildSmartGroupDescriptor,
  normalizeSmartGroupDescriptor
} from './smartGroupKey.js';

export function rebuildSmartSortResult({
  photos = [],
  sourceCanonicalByPhotoId = {},
  effectiveArchiveInfoByPhotoId = {},
  previousSmartSortResult = null
} = {}) {
  const previousGroups = Array.isArray(previousSmartSortResult?.groups)
    ? previousSmartSortResult.groups
    : [];
  const previousGroupByPhotoId = new Map();
  for (const group of previousGroups) {
    for (const photoId of getGroupPhotoIds(group)) {
      if (!previousGroupByPhotoId.has(photoId)) previousGroupByPhotoId.set(photoId, group);
    }
  }

  const buckets = new Map();
  for (const photo of Array.isArray(photos) ? photos : []) {
    const photoId = cleanValue(photo?.id);
    if (!photoId || !previousGroupByPhotoId.has(photoId)) continue;
    const effectiveInfo = effectiveArchiveInfoByPhotoId[photoId]
      || sourceCanonicalByPhotoId[photoId]
      || {};
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
    const oldGroup = previousGroupByPhotoId.get(photoIds[0]) || {};
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

function getGroupPhotoIds(group = {}) {
  const values = new Set((Array.isArray(group.photoIds) ? group.photoIds : []).map(cleanValue).filter(Boolean));
  for (const key of ['photos', 'items', 'groupPhotos', 'photoList']) {
    for (const item of Array.isArray(group[key]) ? group[key] : []) {
      const photoId = cleanValue(item?.photoId || item?.id);
      if (photoId) values.add(photoId);
    }
  }
  return [...values];
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
