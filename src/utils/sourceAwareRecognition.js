import {
  buildSmartGroupTitle,
  normalizeSmartGroupDescriptor
} from './smartGroupKey.js';
import {
  resolveWatermarkTemplateType,
  WATERMARK_TEMPLATE_TYPES
} from './watermarkTemplateAdapter.js';

const MARKI_SOURCE_TYPE = 'marki_api';
const LOCAL_SOURCE_TYPE = 'local_file';
const MARKI_PROVIDER_TYPE = 'structured_data';
const SMART_SORT_STATUS_VALUES = new Set([
  'not_run',
  'running',
  'completed',
  'needs_completion',
  'failed'
]);

export const SMART_SORT_STATUS = Object.freeze({
  NOT_RUN: 'not_run',
  RUNNING: 'running',
  COMPLETED: 'completed',
  NEEDS_COMPLETION: 'needs_completion',
  FAILED: 'failed'
});

export const SMART_SORT_PHOTO_STAGE = Object.freeze({
  PENDING_SORT: 'pending_sort',
  PENDING_ORGANIZE: 'pending_organize',
  RUNNING: 'running',
  CONFIRMED: 'confirmed',
  EXCLUDED: 'excluded',
  INCONSISTENT: 'inconsistent'
});

const invalidFieldValues = new Set([
  '',
  '-',
  '--',
  '暂无',
  '未填写',
  '未设置',
  'null',
  'undefined'
]);

export const SOURCE_AWARE_REQUIRED_FIELDS = Object.freeze([
  Object.freeze({
    key: 'date',
    label: '日期',
    recognitionKeys: ['date', 'capturedAt', 'dateTime'],
    watermarkKey: 'captureDate'
  }),
  Object.freeze({
    key: 'project',
    label: '项目',
    recognitionKeys: ['projectName', 'project'],
    watermarkKey: 'projectText'
  }),
  Object.freeze({
    key: 'watermarkCategory',
    label: '归档分类',
    recognitionKeys: ['watermarkCategory', 'category'],
    watermarkKey: 'watermarkCategoryText'
  }),
  Object.freeze({
    key: 'workContent',
    label: '工作内容',
    recognitionKeys: ['workContent'],
    watermarkKey: 'workContentText'
  })
]);

export function getPhotoSmartSortStatus(photo = {}) {
  const value = cleanText(photo?.smartSortStatus);
  return SMART_SORT_STATUS_VALUES.has(value)
    ? value
    : SMART_SORT_STATUS.NOT_RUN;
}

export function classifyPhotoSmartSortStage(photo = {}, isGroupMember = false) {
  if (!isSmartSortEligiblePhoto(photo)) return SMART_SORT_PHOTO_STAGE.EXCLUDED;
  if (
    photo?.archiveInfo
    || photo?.previewInfo
    || ['assigned', 'previewed'].includes(cleanText(photo?.sortStatus))
  ) {
    return SMART_SORT_PHOTO_STAGE.CONFIRMED;
  }

  const status = getPhotoSmartSortStatus(photo);
  if ([SMART_SORT_STATUS.NOT_RUN, SMART_SORT_STATUS.FAILED].includes(status)) {
    return SMART_SORT_PHOTO_STAGE.PENDING_SORT;
  }
  if (status === SMART_SORT_STATUS.RUNNING) {
    return SMART_SORT_PHOTO_STAGE.RUNNING;
  }
  if (
    isGroupMember
    && [SMART_SORT_STATUS.COMPLETED, SMART_SORT_STATUS.NEEDS_COMPLETION].includes(status)
  ) {
    return SMART_SORT_PHOTO_STAGE.PENDING_ORGANIZE;
  }
  return SMART_SORT_PHOTO_STAGE.INCONSISTENT;
}

export function isPhotoPendingSmartSort(photo = {}, isGroupMember = false) {
  return classifyPhotoSmartSortStage(photo, isGroupMember)
    === SMART_SORT_PHOTO_STAGE.PENDING_SORT;
}

export function isPhotoPendingOrganize(photo = {}, isGroupMember = false) {
  return classifyPhotoSmartSortStage(photo, isGroupMember)
    === SMART_SORT_PHOTO_STAGE.PENDING_ORGANIZE;
}

export function hasPhotoSmartSortResult(photo = {}, isGroupMember = false) {
  const status = getPhotoSmartSortStatus(photo);
  return Boolean(isGroupMember)
    || status === SMART_SORT_STATUS.RUNNING
    || status === SMART_SORT_STATUS.COMPLETED
    || status === SMART_SORT_STATUS.NEEDS_COMPLETION
    || status === SMART_SORT_STATUS.FAILED;
}

export function getPhotoSmartSortStatusLabel(photo = {}, isGroupMember = false) {
  const stage = classifyPhotoSmartSortStage(photo, isGroupMember);
  const status = getPhotoSmartSortStatus(photo);
  if (stage === SMART_SORT_PHOTO_STAGE.RUNNING) return '智拣中';
  if (stage === SMART_SORT_PHOTO_STAGE.PENDING_ORGANIZE) {
    return status === SMART_SORT_STATUS.NEEDS_COMPLETION ? '待补充' : '待整理';
  }
  if (stage === SMART_SORT_PHOTO_STAGE.PENDING_SORT) {
    return status === SMART_SORT_STATUS.FAILED ? '智拣失败' : '待智拣';
  }
  if (stage === SMART_SORT_PHOTO_STAGE.INCONSISTENT) return '智拣结果失效';
  return '';
}

export function beginSmartSortExecution(photos = [], targetPhotoIds = []) {
  const targetIds = new Set(normalizePhotoIds(targetPhotoIds));
  return normalizePhotoArray(photos).map((photo) => (
    targetIds.has(cleanText(photo?.id)) && isSmartSortEligiblePhoto(photo)
      ? { ...photo, smartSortStatus: SMART_SORT_STATUS.RUNNING }
      : photo
  ));
}

export function invalidateSmartSortExecution(photos = []) {
  return normalizePhotoArray(photos).map((photo) => (
    isSmartSortEligiblePhoto(photo)
      ? { ...photo, smartSortStatus: SMART_SORT_STATUS.NOT_RUN }
      : photo
  ));
}

export function resetSelectedSmartSortResults({
  photos = [],
  selectedPhotoIds = [],
  recognitionResultsByPhoto = {},
  watermarkRecordsByPhoto = {},
  archiveSuggestionsByPhoto = {},
  smartSortResult = null
} = {}) {
  const requestedIds = new Set(normalizePhotoIds(selectedPhotoIds));
  const groupMemberIds = getSmartSortResultPhotoIds(smartSortResult);
  const targetPhotos = normalizePhotoArray(photos).filter((photo) => (
    requestedIds.has(cleanText(photo?.id))
    && isSmartSortResettablePhoto(photo)
    && hasPhotoSmartSortResult(
      photo,
      groupMemberIds.has(cleanText(photo?.id))
    )
  ));
  const targetPhotoIds = targetPhotos.map((photo) => cleanText(photo?.id));
  const targetIds = new Set(targetPhotoIds);
  const localTargetIds = new Set(
    targetPhotos
      .filter((photo) => cleanText(photo?.sourceType) !== 'marki_api')
      .map((photo) => cleanText(photo?.id))
  );

  const nextPhotos = normalizePhotoArray(photos).map((photo) => {
    const photoId = cleanText(photo?.id);
    if (!targetIds.has(photoId)) return photo;
    if (!localTargetIds.has(photoId)) {
      return {
        ...photo,
        smartSortStatus: SMART_SORT_STATUS.NOT_RUN
      };
    }
    return {
      ...photo,
      sortStatus: 'unassigned',
      smartSortStatus: SMART_SORT_STATUS.NOT_RUN,
      archiveInfo: null,
      previewInfo: null,
      archiveResult: null
    };
  });

  return {
    photos: nextPhotos,
    recognitionResultsByPhoto: omitPhotoMapEntries(
      recognitionResultsByPhoto,
      localTargetIds
    ),
    watermarkRecordsByPhoto: omitPhotoMapEntries(
      watermarkRecordsByPhoto,
      localTargetIds
    ),
    archiveSuggestionsByPhoto: omitPhotoMapEntries(
      archiveSuggestionsByPhoto,
      localTargetIds
    ),
    smartSortResult: targetPhotoIds.length > 0 && smartSortResult
      ? mergeScopedSmartSortResult({
          previousSmartSortResult: smartSortResult,
          nextSmartSortResult: null,
          targetPhotoIds
        })
      : smartSortResult,
    targetPhotos,
    targetPhotoIds,
    localTargetPhotos: targetPhotos.filter((photo) => localTargetIds.has(cleanText(photo?.id))),
    markiTargetPhotos: targetPhotos.filter((photo) => !localTargetIds.has(cleanText(photo?.id)))
  };
}

export function completeSmartSortExecution({
  photos = [],
  targetPhotoIds = [],
  processingResults = [],
  smartSortResult = null,
  smartSortError = null
} = {}) {
  const targetIds = new Set(normalizePhotoIds(targetPhotoIds));
  const groupMemberIds = getSmartSortResultPhotoIds(smartSortResult);
  const processingByPhotoId = new Map(
    normalizePhotoArray(processingResults)
      .map((result) => [cleanText(result?.photoId), result])
      .filter(([photoId]) => photoId)
  );

  return normalizePhotoArray(photos).map((photo) => {
    if (!isSmartSortEligiblePhoto(photo)) return photo;
    const photoId = cleanText(photo?.id);
    if (!targetIds.has(photoId)) return photo;

    const processing = processingByPhotoId.get(photoId);
    const missingRequiredFields = normalizeCanonicalFieldList(
      processing?.missingRequiredFields
    );
    let smartSortStatus = SMART_SORT_STATUS.FAILED;
    if (groupMemberIds.has(photoId)) {
      smartSortStatus = (
        processing?.status === 'failed'
        || missingRequiredFields.length > 0
      )
        ? SMART_SORT_STATUS.NEEDS_COMPLETION
        : SMART_SORT_STATUS.COMPLETED;
    } else if (smartSortError || smartSortResult?.status === 'failed') {
      smartSortStatus = SMART_SORT_STATUS.FAILED;
    }

    return {
      ...photo,
      smartSortStatus
    };
  });
}

export function failSmartSortExecution(photos = [], targetPhotoIds = []) {
  const targetIds = new Set(normalizePhotoIds(targetPhotoIds));
  return normalizePhotoArray(photos).map((photo) => (
    targetIds.has(cleanText(photo?.id)) && isSmartSortEligiblePhoto(photo)
      ? { ...photo, smartSortStatus: SMART_SORT_STATUS.FAILED }
      : photo
  ));
}

export function getSmartSortResultPhotoIds(smartSortResult = null) {
  return new Set(buildSmartSortGroupMembershipByPhotoId(smartSortResult).keys());
}

export function buildSmartSortGroupMembershipByPhotoId(smartSortResult = null) {
  const membershipByPhotoId = new Map();
  const groups = Array.isArray(smartSortResult?.groups) ? smartSortResult.groups : [];
  for (const group of groups) {
    const groupId = cleanText(group?.id);
    for (const photoId of getSmartSortGroupMemberIds(group)) {
      if (!membershipByPhotoId.has(photoId)) {
        membershipByPhotoId.set(photoId, groupId);
      }
    }
  }
  return membershipByPhotoId;
}

export function mergeScopedSmartSortResult({
  previousSmartSortResult = null,
  nextSmartSortResult = null,
  targetPhotoIds = [],
  groupContextByPhotoId = {}
} = {}) {
  const targetIds = new Set(normalizePhotoIds(targetPhotoIds));
  const contextByPhotoId = normalizeGroupContextByPhotoId(groupContextByPhotoId);
  const previousGroups = expandSmartSortGroupsByKey(
    normalizePhotoArray(previousSmartSortResult?.groups)
    .map((group) => filterSmartSortGroupMembers(group, (photoId) => !targetIds.has(photoId)))
    .filter(Boolean),
    contextByPhotoId
  );
  const nextGroups = expandSmartSortGroupsByKey(
    normalizePhotoArray(nextSmartSortResult?.groups)
    .map((group) => filterSmartSortGroupMembers(group, (photoId) => targetIds.has(photoId)))
    .filter(Boolean),
    contextByPhotoId
  );
  const occupiedPhotoIds = new Set();
  const groups = mergeSmartSortGroupsByKey([...previousGroups, ...nextGroups])
    .map((group) => deduplicateSmartSortGroupMembers(group, occupiedPhotoIds))
    .filter(Boolean);
  const baseResult = nextSmartSortResult || previousSmartSortResult || {};
  const previousErrors = Array.isArray(previousSmartSortResult?.errors)
    ? previousSmartSortResult.errors
    : [];
  const nextErrors = Array.isArray(nextSmartSortResult?.errors)
    ? nextSmartSortResult.errors
    : [];

  return {
    ...baseResult,
    groups,
    groupCount: groups.length,
    photoCount: occupiedPhotoIds.size,
    status: groups.length
      ? 'created'
      : cleanText(nextSmartSortResult?.status) || 'empty',
    errors: [...previousErrors, ...nextErrors],
    updatedAt: cleanText(nextSmartSortResult?.updatedAt) || new Date().toISOString()
  };
}

export function buildSourceAwareSmartSortPresentation({
  smartSortResult = null,
  currentActivePhotoId = ''
} = {}) {
  const groups = Array.isArray(smartSortResult?.groups) ? smartSortResult.groups : [];
  const firstGroup = groups.find((group) => cleanText(group?.id));
  if (!firstGroup || smartSortResult?.status === 'failed') {
    return {
      smartSortViewMode: 'statusFilter',
      activeSmartSortGroupId: '',
      activePhotoId: cleanText(currentActivePhotoId),
      searchText: '',
      page: 1,
      hasVisibleGroup: false
    };
  }
  return {
    smartSortViewMode: 'smartSortGroup',
    activeSmartSortGroupId: cleanText(firstGroup.id),
    activePhotoId: getFirstSmartSortGroupPhotoId(firstGroup) || cleanText(currentActivePhotoId),
    searchText: '',
    page: 1,
    hasVisibleGroup: true
  };
}

export function buildSourceAwareRecognitionNotice(stats = {}, options = {}) {
  const supersedeSyncFailedCount = Number(options.supersedeSyncFailedCount) || 0;
  return `智拣完成：平台数据直用 ${Number(stats.platformOnlyCount) || 0} 张，复用已有补充 ${Number(stats.existingSupplementCount) || 0} 张，本地 OCR ${Number(stats.localOcrCount) || 0} 张，Marki OCR 补充 ${Number(stats.markiOcrFallbackCount) || 0} 张，仍需人工完善 ${Number(stats.needsManualCount) || 0} 张。${Number(stats.conflictCount) ? `其中 ${Number(stats.conflictCount)} 张存在平台与 OCR 字段冲突，请人工核查。` : ''}${Number(stats.ocrUnavailableCount) ? `另有 ${Number(stats.ocrUnavailableCount)} 张因 OCR 服务不可用未完成补充。` : ''}${supersedeSyncFailedCount ? `另有 ${supersedeSyncFailedCount} 条旧记录未能标记为已替代，请在数据中心核对。` : ''}`;
}

const requiredFieldByAlias = new Map(
  SOURCE_AWARE_REQUIRED_FIELDS.flatMap((field) => [
    [field.key, field],
    [field.label, field]
  ])
);

export function classifyPhotoRecognitionRoute({
  photo = {},
  recognitionResult = null,
  watermarkRecord = null,
  archiveSuggestion = null,
  eligible = true
} = {}) {
  if (!eligible) return 'skip';
  const sourceType = cleanText(photo?.sourceType);
  if (sourceType === LOCAL_SOURCE_TYPE || (!sourceType && isLegacyLocalPhoto({
    photo,
    recognitionResult,
    watermarkRecord,
    archiveSuggestion
  }))) {
    return 'local_ocr';
  }
  if (sourceType !== MARKI_SOURCE_TYPE) return 'unsupported';
  if (!isTrustedMarkiStructuredData({
    photo,
    recognitionResult,
    watermarkRecord,
    archiveSuggestion
  })) {
    return 'unsupported';
  }

  const platformMissing = getMarkiPlatformMissingRequiredFields({
    recognitionResult,
    watermarkRecord,
    archiveSuggestion
  });
  if (platformMissing.length === 0) return 'marki_platform_only';

  return getMissingRequiredFields({
    recognitionResult,
    watermarkRecord,
    archiveSuggestion
  }).length === 0
    ? 'marki_existing_supplement'
    : 'marki_ocr_fallback';
}

export function getMissingRequiredFields({
  recognitionResult = null,
  watermarkRecord = null,
  archiveSuggestion = null
} = {}) {
  const values = getEffectiveRequiredFieldValues({
    recognitionResult,
    watermarkRecord,
    archiveSuggestion
  });
  return getApplicableRequiredFields({
    recognitionResult,
    watermarkRecord,
    archiveSuggestion
  })
    .filter((field) => !isUsableFieldValue(values[field.key]))
    .map((field) => field.key);
}

export function mergeMarkiOcrSupplement({
  recognitionResult,
  watermarkRecord,
  archiveSuggestion,
  ocrRecognitionResult,
  ocrWatermarkRecord,
  ocrArchiveSuggestion
} = {}) {
  const platformValues = getMarkiPlatformRequiredFieldValues({
    recognitionResult,
    watermarkRecord,
    archiveSuggestion
  });
  const effectiveValues = getEffectiveRequiredFieldValues({
    recognitionResult,
    watermarkRecord,
    archiveSuggestion
  });
  const ocrValues = getRequiredFieldValues({
    recognitionResult: ocrRecognitionResult,
    watermarkRecord: ocrWatermarkRecord,
    archiveSuggestion: ocrArchiveSuggestion
  });
  const previousProcessing = getSourceAwareProcessing(recognitionResult);
  const previousSupplement = previousProcessing?.ocrSupplement || {};
  const previousSupplementFields = normalizeCanonicalFieldList(
    previousSupplement.supplementedFields || previousProcessing?.supplementedFields
  );
  const supplementedFields = [...previousSupplementFields];
  const supplementValues = normalizeRequiredFieldObject(previousSupplement.fields);
  const conflicts = normalizeConflicts(
    previousSupplement.conflicts || previousProcessing?.conflicts
  );
  const mergedValues = { ...effectiveValues };

  for (const field of SOURCE_AWARE_REQUIRED_FIELDS) {
    const platformValue = cleanFieldValue(platformValues[field.key]);
    const effectiveValue = cleanFieldValue(effectiveValues[field.key]);
    const ocrValue = cleanFieldValue(ocrValues[field.key]);

    if (platformValue) {
      if (ocrValue && normalizeComparableValue(ocrValue) !== normalizeComparableValue(platformValue)) {
        addUniqueConflict(conflicts, {
          field: field.key,
          platformValue,
          ocrValue
        });
      }
      continue;
    }

    if (effectiveValue) {
      if (previousSupplementFields.includes(field.key) || isOcrSupplementField(archiveSuggestion, field.key)) {
        if (!supplementedFields.includes(field.key)) supplementedFields.push(field.key);
        supplementValues[field.key] = effectiveValue;
      }
      continue;
    }

    if (ocrValue) {
      mergedValues[field.key] = ocrValue;
      supplementValues[field.key] = ocrValue;
      if (!supplementedFields.includes(field.key)) supplementedFields.push(field.key);
    }
  }

  const missingBefore = SOURCE_AWARE_REQUIRED_FIELDS
    .filter((field) => !isUsableFieldValue(platformValues[field.key]))
    .map((field) => field.key);
  const unresolvedFields = SOURCE_AWARE_REQUIRED_FIELDS
    .filter((field) => !isUsableFieldValue(mergedValues[field.key]))
    .map((field) => field.key);
  const processing = buildSourceAwareProcessing({
    platformValues,
    missingBefore,
    supplementValues,
    supplementedFields,
    mergedValues,
    unresolvedFields,
    conflicts,
    ocrFallbackStatus: 'completed'
  });
  const nextRecognitionResult = {
    ...recognitionResult,
    sourceAwareProcessing: processing
  };
  const nextWatermarkRecord = watermarkRecord;
  const nextArchiveSuggestion = mergeArchiveRequiredFields({
    archiveSuggestion,
    ocrArchiveSuggestion,
    mergedValues,
    supplementedFields,
    unresolvedFields,
    conflicts
  });

  return {
    recognitionResult: nextRecognitionResult,
    watermarkRecord: nextWatermarkRecord,
    archiveSuggestion: nextArchiveSuggestion,
    sourceAwareProcessing: processing
  };
}

export async function orchestrateSourceAwareRecognition({
  photos = [],
  recognitionResultsByPhoto = {},
  watermarkRecordsByPhoto = {},
  archiveSuggestionsByPhoto = {},
  getOcrAvailability = async () => ({ available: true }),
  recognizePhoto,
  buildOcrArtifacts,
  getPhotoSortStatus = (_recognition, suggestion) => (
    suggestion?.status === 'needs_completion' ? 'needs_completion' : 'suggestion_ready'
  ),
  generateGroups = null,
  onProgress = null,
  onOcrResult = null
} = {}) {
  if (!Array.isArray(photos)) throw new TypeError('photos must be an array');
  if (typeof recognizePhoto !== 'function') throw new TypeError('recognizePhoto must be a function');
  if (typeof buildOcrArtifacts !== 'function') throw new TypeError('buildOcrArtifacts must be a function');

  const nextRecognitionResultsByPhoto = { ...recognitionResultsByPhoto };
  const nextWatermarkRecordsByPhoto = { ...watermarkRecordsByPhoto };
  const nextArchiveSuggestionsByPhoto = { ...archiveSuggestionsByPhoto };
  const nextPhotos = [...photos];
  const routes = photos.map((photo) => classifyPhotoRecognitionRoute({
    photo,
    recognitionResult: recognitionResultsByPhoto[photo.id],
    watermarkRecord: watermarkRecordsByPhoto[photo.id],
    archiveSuggestion: archiveSuggestionsByPhoto[photo.id]
  }));
  const needsOcr = routes.some((route) => route === 'local_ocr' || route === 'marki_ocr_fallback');
  let ocrAvailability = { available: true, skipped: true };
  if (needsOcr) {
    try {
      ocrAvailability = await getOcrAvailability();
    } catch {
      ocrAvailability = {
        available: false,
        reason: 'OCR 服务状态检查失败。'
      };
    }
  }
  const ocrAvailable = ocrAvailability?.available === true;
  const processingResults = [];
  const groupablePhotos = [];
  const stats = {
    inputCount: photos.length,
    platformOnlyCount: 0,
    existingSupplementCount: 0,
    localOcrCount: 0,
    markiOcrFallbackCount: 0,
    ocrCallCount: 0,
    ocrUnavailableCount: 0,
    failedCount: 0,
    needsManualCount: 0,
    conflictCount: 0,
    skippedCount: 0,
    groupCallCount: 0
  };

  for (let index = 0; index < photos.length; index += 1) {
    const photo = photos[index];
    const route = routes[index];
    await onProgress?.({ current: index + 1, total: photos.length, photo, route });
    if (route === 'skip' || route === 'unsupported') {
      stats.skippedCount += 1;
      processingResults.push({
        photoId: photo.id,
        route,
        status: 'skipped',
        reason: route === 'unsupported' ? 'unsupported_source' : 'ineligible'
      });
      continue;
    }

    if (route === 'marki_platform_only' || route === 'marki_existing_supplement') {
      if (route === 'marki_platform_only') {
        stats.platformOnlyCount += 1;
      } else {
        stats.existingSupplementCount += 1;
      }
      groupablePhotos.push(photo);
      processingResults.push({
        photoId: photo.id,
        route,
        status: 'completed',
        missingRequiredFields: []
      });
      continue;
    }

    if (!ocrAvailable) {
      stats.ocrUnavailableCount += 1;
      stats.failedCount += 1;
      if (route === 'marki_ocr_fallback') {
        const missing = getMissingRequiredFields({
          recognitionResult: recognitionResultsByPhoto[photo.id],
          watermarkRecord: watermarkRecordsByPhoto[photo.id],
          archiveSuggestion: archiveSuggestionsByPhoto[photo.id]
        });
        if (missing.length > 0) stats.needsManualCount += 1;
      }
      processingResults.push({
        photoId: photo.id,
        route,
        status: 'failed',
        reason: 'ocr_unavailable'
      });
      continue;
    }

    try {
      stats.ocrCallCount += 1;
      const ocrRecognitionResult = await recognizePhoto(photo, { route });
      await onOcrResult?.({ photo, route, result: ocrRecognitionResult });
      const artifacts = await buildOcrArtifacts({
        photo,
        route,
        recognitionResult: ocrRecognitionResult
      });

      if (route === 'local_ocr') {
        stats.localOcrCount += 1;
        nextRecognitionResultsByPhoto[photo.id] = artifacts.recognitionResult;
        nextWatermarkRecordsByPhoto[photo.id] = artifacts.watermarkRecord;
        nextArchiveSuggestionsByPhoto[photo.id] = artifacts.archiveSuggestion;
        nextPhotos[index] = updateRecognitionPhoto(
          photo,
          artifacts.recognitionResult,
          artifacts.archiveSuggestion,
          getPhotoSortStatus
        );
        const missing = getMissingRequiredFields(artifacts);
        const recognitionFailed = isRecognitionFailure(artifacts.recognitionResult);
        if (!recognitionFailed) groupablePhotos.push(nextPhotos[index]);
        if (missing.length > 0) stats.needsManualCount += 1;
        processingResults.push({
          photoId: photo.id,
          route,
          status: recognitionFailed ? 'failed' : 'completed',
          missingRequiredFields: missing
        });
        if (recognitionFailed) stats.failedCount += 1;
        continue;
      }

      stats.markiOcrFallbackCount += 1;
      if (isRecognitionFailure(ocrRecognitionResult)) {
        stats.failedCount += 1;
        stats.needsManualCount += 1;
        processingResults.push({
          photoId: photo.id,
          route,
          status: 'failed',
          reason: 'ocr_fallback_failed',
          missingRequiredFields: getMissingRequiredFields({
            recognitionResult: recognitionResultsByPhoto[photo.id],
            watermarkRecord: watermarkRecordsByPhoto[photo.id],
            archiveSuggestion: archiveSuggestionsByPhoto[photo.id]
          })
        });
        continue;
      }

      const merged = mergeMarkiOcrSupplement({
        recognitionResult: recognitionResultsByPhoto[photo.id],
        watermarkRecord: watermarkRecordsByPhoto[photo.id],
        archiveSuggestion: archiveSuggestionsByPhoto[photo.id],
        ocrRecognitionResult: artifacts.recognitionResult,
        ocrWatermarkRecord: artifacts.watermarkRecord,
        ocrArchiveSuggestion: artifacts.archiveSuggestion
      });
      nextRecognitionResultsByPhoto[photo.id] = merged.recognitionResult;
      nextWatermarkRecordsByPhoto[photo.id] = merged.watermarkRecord;
      nextArchiveSuggestionsByPhoto[photo.id] = merged.archiveSuggestion;
      nextPhotos[index] = updateRecognitionPhoto(
        photo,
        merged.recognitionResult,
        merged.archiveSuggestion,
        getPhotoSortStatus
      );
      groupablePhotos.push(nextPhotos[index]);
      if (merged.sourceAwareProcessing.conflicts.length > 0) stats.conflictCount += 1;
      if (
        merged.sourceAwareProcessing.unresolvedFields.length > 0
        || merged.sourceAwareProcessing.conflicts.length > 0
      ) {
        stats.needsManualCount += 1;
      }
      processingResults.push({
        photoId: photo.id,
        route,
        status: 'completed',
        missingRequiredFields: merged.sourceAwareProcessing.unresolvedFields,
        sourceAwareProcessing: merged.sourceAwareProcessing
      });
    } catch {
      stats.failedCount += 1;
      if (route === 'marki_ocr_fallback') {
        stats.markiOcrFallbackCount += 1;
        stats.needsManualCount += 1;
      } else {
        stats.localOcrCount += 1;
      }
      processingResults.push({
        photoId: photo.id,
        route,
        status: 'failed',
        reason: route === 'marki_ocr_fallback' ? 'ocr_fallback_failed' : 'ocr_failed'
      });
    }
  }

  let smartSortResult = null;
  let smartSortError = null;
  if (typeof generateGroups === 'function' && groupablePhotos.length > 0) {
    stats.groupCallCount += 1;
    try {
      smartSortResult = await generateGroups({
        photos: groupablePhotos,
        recognitionResultsByPhoto: nextRecognitionResultsByPhoto,
        watermarkRecordsByPhoto: nextWatermarkRecordsByPhoto,
        archiveSuggestionsByPhoto: nextArchiveSuggestionsByPhoto
      });
    } catch {
      smartSortError = {
        code: 'smart_sort_failed',
        message: '智能分组生成失败，识别结果已保留。'
      };
    }
  }

  return {
    photos: nextPhotos,
    recognitionResultsByPhoto: nextRecognitionResultsByPhoto,
    watermarkRecordsByPhoto: nextWatermarkRecordsByPhoto,
    archiveSuggestionsByPhoto: nextArchiveSuggestionsByPhoto,
    processingResults,
    stats,
    smartSortResult,
    smartSortError,
    ocrAvailability
  };
}

function isTrustedMarkiStructuredData({
  photo,
  recognitionResult,
  watermarkRecord,
  archiveSuggestion
}) {
  const photoId = cleanText(photo?.id);
  return cleanText(photo?.sourceType) === MARKI_SOURCE_TYPE
    && cleanText(recognitionResult?.source) === MARKI_SOURCE_TYPE
    && cleanText(recognitionResult?.providerType) === MARKI_PROVIDER_TYPE
    && (!cleanText(recognitionResult?.photoId) || cleanText(recognitionResult.photoId) === photoId)
    && cleanText(watermarkRecord?.source) === MARKI_SOURCE_TYPE
    && (!cleanText(watermarkRecord?.photoId) || cleanText(watermarkRecord.photoId) === photoId)
    && cleanText(archiveSuggestion?.source) === MARKI_SOURCE_TYPE
    && (!cleanText(archiveSuggestion?.photoId) || cleanText(archiveSuggestion.photoId) === photoId);
}

function isLegacyLocalPhoto({
  photo,
  recognitionResult,
  watermarkRecord,
  archiveSuggestion
}) {
  const hasMarkiIdentity = Boolean(
    cleanText(photo?.sourceKey)
    || cleanText(photo?.sourceMetadataRef)
    || cleanText(recognitionResult?.source) === MARKI_SOURCE_TYPE
    || cleanText(watermarkRecord?.source) === MARKI_SOURCE_TYPE
    || cleanText(archiveSuggestion?.source) === MARKI_SOURCE_TYPE
  );
  return !hasMarkiIdentity
    && Boolean(cleanText(photo?.id))
    && Boolean(cleanText(photo?.originalPath));
}

function getMarkiPlatformMissingRequiredFields({
  recognitionResult = null,
  watermarkRecord = null,
  archiveSuggestion = null
} = {}) {
  const values = getMarkiPlatformRequiredFieldValues({
    recognitionResult,
    watermarkRecord,
    archiveSuggestion
  });
  return getApplicableRequiredFields({
    recognitionResult,
    watermarkRecord,
    archiveSuggestion
  })
    .filter((field) => !isUsableFieldValue(values[field.key]))
    .map((field) => field.key);
}

function getApplicableRequiredFields(input = {}) {
  const templateType = resolveWatermarkTemplateType(input);
  return templateType === WATERMARK_TEMPLATE_TYPES.TIME_LOCATION
    ? SOURCE_AWARE_REQUIRED_FIELDS.filter((field) => field.key !== 'workContent')
    : SOURCE_AWARE_REQUIRED_FIELDS;
}

function getMarkiPlatformRequiredFieldValues({
  recognitionResult = null,
  watermarkRecord = null,
  archiveSuggestion = null
} = {}) {
  const processing = getSourceAwareProcessing(recognitionResult);
  const persistedBaseline = normalizeRequiredFieldObject(
    processing?.platformBaseline?.requiredFields
  );
  if (hasAllRequiredFieldKeys(processing?.platformBaseline?.requiredFields)) {
    return persistedBaseline;
  }

  const suggestedFields = archiveSuggestion?.suggestedFields || {};
  const fieldSources = archiveSuggestion?.fieldSources || {};
  const parsedWatermark = recognitionResult?.parsedWatermark || {};
  const parsedFields = recognitionResult?.parsedFields || {};
  return Object.fromEntries(SOURCE_AWARE_REQUIRED_FIELDS.map((field) => {
    if (Object.hasOwn(suggestedFields, field.key)) {
      if (!isEffectiveOnlyFieldSource(fieldSources[field.key])) {
        return [field.key, cleanFieldValue(suggestedFields[field.key])];
      }
      const recognitionValue = field.recognitionKeys
        .map((key) => parsedWatermark[key] ?? parsedFields[key])
        .find(isUsableFieldValue);
      return [field.key, cleanFieldValue(recognitionValue)];
    }
    const recognitionValue = field.recognitionKeys
      .map((key) => parsedWatermark[key] ?? parsedFields[key])
      .find(isUsableFieldValue);
    const value = [
      recognitionValue,
      watermarkRecord?.[field.watermarkKey]
    ].find(isUsableFieldValue);
    return [field.key, cleanFieldValue(value)];
  }));
}

function getEffectiveRequiredFieldValues({
  recognitionResult = null,
  watermarkRecord = null,
  archiveSuggestion = null
} = {}) {
  const currentValues = getRequiredFieldValues({
    recognitionResult,
    watermarkRecord,
    archiveSuggestion
  });
  const processing = getSourceAwareProcessing(recognitionResult);
  if (!hasAllRequiredFieldKeys(processing?.effectiveResult?.requiredFields)) {
    return currentValues;
  }
  const persistedValues = normalizeRequiredFieldObject(
    processing.effectiveResult.requiredFields
  );
  return Object.fromEntries(SOURCE_AWARE_REQUIRED_FIELDS.map((field) => [
    field.key,
    cleanFieldValue(currentValues[field.key]) || cleanFieldValue(persistedValues[field.key])
  ]));
}

function getRequiredFieldValues({
  recognitionResult = null,
  watermarkRecord = null,
  archiveSuggestion = null
} = {}) {
  const suggestedFields = archiveSuggestion?.suggestedFields || {};
  const parsedWatermark = recognitionResult?.parsedWatermark || {};
  const parsedFields = recognitionResult?.parsedFields || {};
  return Object.fromEntries(SOURCE_AWARE_REQUIRED_FIELDS.map((field) => {
    if (Object.hasOwn(suggestedFields, field.key)) {
      return [field.key, cleanFieldValue(suggestedFields[field.key])];
    }
    const recognitionValue = field.recognitionKeys
      .map((key) => parsedWatermark[key] ?? parsedFields[key])
      .find(isUsableFieldValue);
    const value = [
      recognitionValue,
      watermarkRecord?.[field.watermarkKey]
    ].find(isUsableFieldValue);
    return [field.key, cleanFieldValue(value)];
  }));
}

function buildSourceAwareProcessing({
  platformValues,
  missingBefore,
  supplementValues,
  supplementedFields,
  mergedValues,
  unresolvedFields,
  conflicts,
  ocrFallbackStatus
}) {
  const normalizedConflicts = normalizeConflicts(conflicts);
  return {
    strategy: 'platform_plus_ocr',
    platformBaseline: {
      source: MARKI_SOURCE_TYPE,
      providerType: MARKI_PROVIDER_TYPE,
      requiredFields: normalizeRequiredFieldObject(platformValues),
      missingRequiredFields: [...missingBefore]
    },
    ocrSupplement: {
      fields: Object.fromEntries(supplementedFields.map((key) => [
        key,
        cleanFieldValue(supplementValues[key])
      ])),
      supplementedFields: [...supplementedFields],
      conflicts: normalizedConflicts
    },
    effectiveResult: {
      requiredFields: normalizeRequiredFieldObject(mergedValues),
      unresolvedFields: [...unresolvedFields]
    },
    missingBefore: [...missingBefore],
    supplementedFields: [...supplementedFields],
    unresolvedFields: [...unresolvedFields],
    conflicts: normalizedConflicts,
    ocrFallbackStatus
  };
}

function getSourceAwareProcessing(recognitionResult) {
  const processing = recognitionResult?.sourceAwareProcessing;
  return processing && typeof processing === 'object' && !Array.isArray(processing)
    ? processing
    : null;
}

function hasAllRequiredFieldKeys(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && SOURCE_AWARE_REQUIRED_FIELDS.every((field) => Object.hasOwn(value, field.key));
}

function normalizeRequiredFieldObject(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(SOURCE_AWARE_REQUIRED_FIELDS.map((field) => [
    field.key,
    cleanFieldValue(source[field.key])
  ]));
}

function normalizeCanonicalFieldList(value) {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value)
    .map((item) => requiredFieldByAlias.get(item)?.key || '')
    .filter(Boolean);
}

function normalizeConflicts(value) {
  if (!Array.isArray(value)) return [];
  const conflicts = [];
  for (const item of value) {
    const field = requiredFieldByAlias.get(cleanText(item?.field))?.key;
    const platformValue = cleanFieldValue(item?.platformValue);
    const ocrValue = cleanFieldValue(item?.ocrValue);
    if (!field || !platformValue || !ocrValue) continue;
    addUniqueConflict(conflicts, { field, platformValue, ocrValue });
  }
  return conflicts;
}

function addUniqueConflict(conflicts, candidate) {
  const exists = conflicts.some((item) => (
    item.field === candidate.field
    && normalizeComparableValue(item.platformValue) === normalizeComparableValue(candidate.platformValue)
    && normalizeComparableValue(item.ocrValue) === normalizeComparableValue(candidate.ocrValue)
  ));
  if (!exists) conflicts.push(candidate);
}

function isOcrSupplementField(archiveSuggestion, key) {
  return cleanText(archiveSuggestion?.fieldSources?.[key]).toLowerCase() === 'ocr_fallback';
}

function isEffectiveOnlyFieldSource(value) {
  const normalized = cleanText(value).toLowerCase();
  return normalized === 'ocr_fallback'
    || normalized === 'manual'
    || normalized === 'mixed';
}

function mergeArchiveRequiredFields({
  archiveSuggestion,
  ocrArchiveSuggestion,
  mergedValues,
  supplementedFields,
  unresolvedFields,
  conflicts
}) {
  const fieldSources = { ...(archiveSuggestion?.fieldSources || {}) };
  const confidenceByField = { ...(archiveSuggestion?.confidenceByField || {}) };
  for (const key of supplementedFields) {
    fieldSources[key] = 'ocr_fallback';
    confidenceByField[key] = Number(ocrArchiveSuggestion?.confidenceByField?.[key])
      || Number(confidenceByField[key])
      || 0.6;
  }
  const conflictLabels = conflicts.map((conflict) => (
    requiredFieldByAlias.get(conflict.field)?.label || conflict.field
  ));
  const existingConflicts = Array.isArray(archiveSuggestion?.conflictFields)
    ? archiveSuggestion.conflictFields
    : [];
  return {
    ...archiveSuggestion,
    suggestedFields: {
      ...(archiveSuggestion?.suggestedFields || {}),
      ...Object.fromEntries(SOURCE_AWARE_REQUIRED_FIELDS.map((field) => [
        field.key,
        cleanFieldValue(mergedValues[field.key])
      ]))
    },
    fieldSources,
    confidenceByField,
    missingRequiredFields: unresolvedFields.map((key) => (
      requiredFieldByAlias.get(key)?.label || key
    )),
    conflictFields: uniqueStrings([...existingConflicts, ...conflictLabels]),
    needsHumanReview: unresolvedFields.length > 0
      || conflictLabels.length > 0
      || Boolean(archiveSuggestion?.needsHumanReview),
    status: unresolvedFields.length > 0 ? 'needs_completion' : 'suggestion_ready',
    updatedAt: new Date().toISOString()
  };
}

function updateRecognitionPhoto(photo, recognitionResult, archiveSuggestion, getPhotoSortStatus) {
  return {
    ...photo,
    sortStatus: getPhotoSortStatus(recognitionResult, archiveSuggestion),
    previewInfo: null,
    archiveResult: null
  };
}

function isRecognitionFailure(result) {
  return ['failed', 'error', 'provider_unavailable', 'not_configured', 'disabled']
    .includes(cleanText(result?.status).toLowerCase());
}

function isUsableFieldValue(value) {
  return Boolean(cleanFieldValue(value));
}

function cleanFieldValue(value) {
  const normalized = cleanText(value);
  return invalidFieldValues.has(normalized.toLowerCase()) ? '' : normalized;
}

function cleanText(value) {
  return typeof value === 'string'
    ? value.replace(/\u3000/g, ' ').replace(/\s+/g, ' ').trim()
    : value == null
      ? ''
      : String(value).trim();
}

function normalizeComparableValue(value) {
  return cleanFieldValue(value).replace(/\s+/g, '').toLowerCase();
}

function getFirstSmartSortGroupPhotoId(group = {}) {
  if (Array.isArray(group.photoIds)) {
    const photoId = group.photoIds.map(cleanText).find(Boolean);
    if (photoId) return photoId;
  }
  const collections = ['photos', 'items', 'groupPhotos', 'photoList'];
  for (const key of collections) {
    if (!Array.isArray(group[key])) continue;
    const photoId = group[key]
      .map((photo) => cleanText(photo?.photoId || photo?.id))
      .find(Boolean);
    if (photoId) return photoId;
  }
  return '';
}

function getSmartSortGroupMemberIds(group = {}) {
  const photoIds = new Set(normalizePhotoIds(group?.photoIds));
  for (const key of ['photos', 'items', 'groupPhotos', 'photoList']) {
    if (!Array.isArray(group?.[key])) continue;
    group[key].forEach((item) => {
      const photoId = cleanText(item?.photoId || item?.id);
      if (photoId) photoIds.add(photoId);
    });
  }
  return photoIds;
}

function normalizeGroupContextByPhotoId(value) {
  if (value instanceof Map) return value;
  const context = new Map();
  for (const [photoId, photo] of Object.entries(value || {})) {
    const safePhotoId = cleanText(photoId);
    if (safePhotoId) context.set(safePhotoId, photo);
  }
  return context;
}

function expandSmartSortGroupsByKey(groups = [], contextByPhotoId = new Map()) {
  return groups.flatMap((group) => {
    const memberIds = [...getSmartSortGroupMemberIds(group)];
    const hasCanonicalContext = memberIds.some((photoId) => (
      contextByPhotoId.get(photoId)?.smartGrouping
      || findSmartSortGroupPhoto(group, photoId)?.smartGrouping
    ));
    if (!cleanText(group?.groupKey) && !hasCanonicalContext) {
      return [group];
    }
    const buckets = new Map();
    memberIds.forEach((photoId) => {
      const contextPhoto = contextByPhotoId.get(photoId)
        || findSmartSortGroupPhoto(group, photoId)
        || {};
      const descriptor = normalizeSmartGroupDescriptor(
        contextPhoto.smartGrouping || {
          fields: group.suggestedFields || {},
          dateSource: group.dateSource || ''
        },
        photoId
      );
      if (!buckets.has(descriptor.groupKey)) {
        buckets.set(descriptor.groupKey, {
          descriptor,
          photoIds: new Set()
        });
      }
      buckets.get(descriptor.groupKey).photoIds.add(photoId);
    });

    return [...buckets.values()].map(({ descriptor, photoIds }, index) => {
      const filtered = filterSmartSortGroupMembers(
        group,
        (photoId) => photoIds.has(photoId)
      );
      if (!filtered) return null;
      return {
        ...filtered,
        id: index === 0
          ? cleanText(filtered.id)
          : `${cleanText(filtered.id) || 'smart-sort-group'}-${hashSmartGroupKey(descriptor.groupKey)}`,
        groupKey: descriptor.groupKey,
        title: descriptor.title || buildSmartGroupTitle(descriptor.fields),
        basis: 'business_fields',
        suggestedFields: { ...descriptor.fields },
        groupValidity: descriptor.missingFields?.length ? 'needs_completion' : 'valid',
        missingFields: [...(descriptor.missingFields || [])],
        summary: {
          ...(filtered.summary || {}),
          basisLabel: '按日期、项目、归档分类和工作内容分组',
          confidenceLabel: 'high'
        },
        warnings: descriptor.missingFields?.length
          ? uniqueStrings([
              ...(Array.isArray(filtered.warnings) ? filtered.warnings : []),
              '该照片存在待补全业务字段，补全后将重新计算分组。'
            ])
          : (Array.isArray(filtered.warnings) ? filtered.warnings : [])
      };
    }).filter(Boolean);
  });
}

function mergeSmartSortGroupsByKey(groups = []) {
  const grouped = new Map();
  for (const group of groups) {
    const explicitGroupKey = cleanText(group?.groupKey);
    const groupKey = explicitGroupKey || `legacy_group:${cleanText(group?.id)}`;
    if (!grouped.has(groupKey)) {
      grouped.set(groupKey, group);
      continue;
    }
    grouped.set(groupKey, mergeSmartSortGroupMembers(grouped.get(groupKey), group));
  }
  return [...grouped.values()];
}

function mergeSmartSortGroupMembers(existing = {}, incoming = {}) {
  const next = {
    ...existing,
    groupKey: cleanText(existing.groupKey) || cleanText(incoming.groupKey),
    title: cleanText(existing.title) || cleanText(incoming.title),
    suggestedFields: {
      ...(incoming.suggestedFields || {}),
      ...(existing.suggestedFields || {})
    },
    warnings: uniqueStrings([
      ...(Array.isArray(existing.warnings) ? existing.warnings : []),
      ...(Array.isArray(incoming.warnings) ? incoming.warnings : [])
    ]),
    updatedAt: cleanText(incoming.updatedAt) || cleanText(existing.updatedAt)
  };

  for (const key of ['photoIds', 'photos', 'items', 'groupPhotos', 'photoList']) {
    if (!Array.isArray(existing[key]) && !Array.isArray(incoming[key])) continue;
    const values = [
      ...(Array.isArray(existing[key]) ? existing[key] : []),
      ...(Array.isArray(incoming[key]) ? incoming[key] : [])
    ];
    if (key === 'photoIds') {
      next[key] = uniqueStrings(values);
      continue;
    }
    const seen = new Set();
    next[key] = values.filter((item) => {
      const photoId = cleanText(item?.photoId || item?.id);
      if (!photoId || seen.has(photoId)) return false;
      seen.add(photoId);
      return true;
    });
  }
  next.photoCount = getSmartSortGroupMemberIds(next).size;
  const memberPhotos = ['photos', 'items', 'groupPhotos', 'photoList']
    .flatMap((key) => Array.isArray(next[key]) ? next[key] : []);
  next.timeRange = buildSmartSortGroupTimeRange(memberPhotos, existing.timeRange || incoming.timeRange);
  return next;
}

function findSmartSortGroupPhoto(group = {}, photoId = '') {
  for (const key of ['photos', 'items', 'groupPhotos', 'photoList']) {
    if (!Array.isArray(group?.[key])) continue;
    const found = group[key].find((item) => (
      cleanText(item?.photoId || item?.id) === photoId
    ));
    if (found) return found;
  }
  return null;
}

function hashSmartGroupKey(value) {
  let hash = 2166136261;
  const text = cleanText(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function filterSmartSortGroupMembers(group = {}, predicate = () => true) {
  const originalPhotoIds = getSmartSortGroupMemberIds(group);
  const retainedPhotoIds = new Set([...originalPhotoIds].filter(predicate));
  if (retainedPhotoIds.size === 0) return null;
  if (
    retainedPhotoIds.size === originalPhotoIds.size
    && [...originalPhotoIds].every((photoId) => retainedPhotoIds.has(photoId))
  ) {
    return group;
  }

  const nextGroup = { ...group };
  if (Array.isArray(group.photoIds)) {
    nextGroup.photoIds = normalizePhotoIds(group.photoIds)
      .filter((photoId) => retainedPhotoIds.has(photoId));
  }
  for (const key of ['photos', 'items', 'groupPhotos', 'photoList']) {
    if (!Array.isArray(group[key])) continue;
    nextGroup[key] = group[key].filter((item) => (
      retainedPhotoIds.has(cleanText(item?.photoId || item?.id))
    ));
  }
  const retainedPhotos = ['photos', 'items', 'groupPhotos', 'photoList']
    .flatMap((key) => Array.isArray(nextGroup[key]) ? nextGroup[key] : []);
  const retainedPaths = new Set(retainedPhotos
    .map((item) => cleanText(item?.filePath || item?.originalPath || item?.path))
    .filter(Boolean));
  if (Array.isArray(group.photoPaths) && retainedPaths.size > 0) {
    nextGroup.photoPaths = group.photoPaths
      .map(cleanText)
      .filter((photoPath) => retainedPaths.has(photoPath));
  }
  nextGroup.photoCount = retainedPhotoIds.size;
  nextGroup.timeRange = buildSmartSortGroupTimeRange(retainedPhotos, group.timeRange);
  return nextGroup;
}

function deduplicateSmartSortGroupMembers(group = {}, occupiedPhotoIds = new Set()) {
  const uniquePhotoIds = [...getSmartSortGroupMemberIds(group)]
    .filter((photoId) => !occupiedPhotoIds.has(photoId));
  const nextGroup = filterSmartSortGroupMembers(
    group,
    (photoId) => uniquePhotoIds.includes(photoId)
  );
  if (!nextGroup) return null;
  uniquePhotoIds.forEach((photoId) => occupiedPhotoIds.add(photoId));
  return nextGroup;
}

function buildSmartSortGroupTimeRange(photos = [], fallback = null) {
  const timestamps = photos
    .map((photo) => (
      photo?.capturedAt
      || photo?.modifiedAt
      || photo?.postTime
      || ''
    ))
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (timestamps.length === 0) return fallback;
  return {
    start: new Date(timestamps[0]).toISOString(),
    end: new Date(timestamps[timestamps.length - 1]).toISOString()
  };
}

function normalizePhotoArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizePhotoIds(value) {
  return normalizePhotoArray(value).map(cleanText).filter(Boolean);
}

function omitPhotoMapEntries(input, omittedPhotoIds) {
  const result = Object.create(null);
  for (const [photoId, value] of Object.entries(input || {})) {
    if (!omittedPhotoIds.has(photoId)) result[photoId] = value;
  }
  return result;
}

function isSmartSortResettablePhoto(photo = {}) {
  return isSmartSortEligiblePhoto(photo)
    && cleanText(photo?.sortStatus) !== 'archiving';
}

function isSmartSortEligiblePhoto(photo = {}) {
  const sortStatus = cleanText(photo?.sortStatus);
  return !photo?.originalMissing
    && sortStatus !== 'ignored'
    && sortStatus !== 'archived'
    && photo?.archiveResult?.status !== '归档成功'
    && photo?.archiveResult?.success !== true;
}

function uniqueStrings(values) {
  return [...new Set(values.map(cleanText).filter(Boolean))];
}
