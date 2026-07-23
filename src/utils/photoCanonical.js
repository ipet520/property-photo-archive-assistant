import {
  buildTemplateDrivenCanonical,
  isolateTemplateSpecificFields,
  NOT_APPLICABLE_WORK_CONTENT,
  WATERMARK_TEMPLATE_TYPES
} from './watermarkTemplateAdapter.js';

const COMMON_GROUP_FIELDS = Object.freeze([
  'date',
  'projectId',
  'projectName',
  'project',
  'archiveCategory',
  'watermarkCategory',
  'workContent',
  'watermarkTemplateType'
]);

const PHOTO_SPECIFIC_FIELDS = Object.freeze([
  'vehiclePlate',
  'violationType',
  'constructionUnitId',
  'constructionUnitName',
  'constructionUnitOriginalText',
  'constructionUnitConfirmed',
  'constructionUnitSource',
  'locationArea',
  'location',
  'keywords',
  'remarks',
  'remark'
]);

export function buildSourceCanonical({
  photo = {},
  recognitionResult = null,
  watermarkRecord = null,
  sourceAwareProcessing = null,
  configs = {}
} = {}) {
  const canonical = buildTemplateDrivenCanonical({
    photo,
    recognitionResult,
    watermarkRecord,
    sourceAwareProcessing,
    configs
  });
  return cloneCanonical(canonical);
}

export function resolveEffectivePhotoArchiveInfo({
  photo = {},
  sourceCanonical = {},
  sourceAwareProcessing = null,
  photoDraft = null
} = {}) {
  const processing = sourceAwareProcessing || {};
  const effectiveSupplement = processing.effectiveResult?.requiredFields || {};
  const confirmed = isPlainObject(photo.archiveInfo) ? photo.archiveInfo : {};
  const draft = compactDraft(photoDraft);
  const supplemented = { ...sourceCanonical };

  for (const key of ['date', 'project', 'archiveCategory', 'workContent']) {
    if (!cleanValue(supplemented[key]) && cleanValue(effectiveSupplement[key])) {
      supplemented[key] = cleanValue(effectiveSupplement[key]);
    }
  }
  supplemented.projectName = supplemented.projectName || supplemented.project || '';
  supplemented.project = supplemented.project || supplemented.projectName || '';
  supplemented.watermarkCategory = supplemented.watermarkCategory || supplemented.archiveCategory || '';
  supplemented.archiveCategory = supplemented.archiveCategory || supplemented.watermarkCategory || '';
  if (
    supplemented.watermarkTemplateType === WATERMARK_TEMPLATE_TYPES.TIME_LOCATION
  ) {
    supplemented.workContent = NOT_APPLICABLE_WORK_CONTENT;
  }

  const merged = {
    ...supplemented,
    ...draft,
    ...confirmed,
    fieldSources: {
      ...(sourceCanonical.fieldSources || {}),
      ...(draft.fieldSources || {}),
      ...(confirmed.fieldSources || {})
    }
  };
  merged.project = merged.projectName || merged.project || '';
  merged.projectName = merged.projectName || merged.project || '';
  merged.archiveCategory = merged.archiveCategory || merged.watermarkCategory || '';
  merged.watermarkCategory = merged.watermarkCategory || merged.archiveCategory || '';
  merged.locationArea = merged.locationArea || merged.location || '';
  merged.location = merged.location || merged.locationArea || '';
  merged.remarks = merged.remarks || merged.remark || '';
  merged.remark = merged.remark || merged.remarks || '';
  merged.unresolvedFields = getEffectiveUnresolvedFields(merged);
  return isolateTemplateSpecificFields(cloneCanonical(merged));
}

export function buildGroupCanonical(members = []) {
  const normalizedMembers = (Array.isArray(members) ? members : [])
    .filter((member) => cleanValue(member?.photoId))
    .map((member) => ({
      photoId: cleanValue(member.photoId),
      effectiveInfo: cloneCanonical(member.effectiveInfo || {})
    }));
  const groupCommonFields = {};
  const photoSpecificFields = {};
  const mixedFields = [];
  const conflictReasons = [];
  const missingCommonFields = [];

  for (const field of COMMON_GROUP_FIELDS) {
    const memberValues = normalizedMembers.map((member) => cleanValue(member.effectiveInfo[field]));
    const values = [...new Set(memberValues)];
    if (values.length === 1) {
      groupCommonFields[field] = values[0];
      if (!values[0]) missingCommonFields.push(field);
    } else {
      groupCommonFields[field] = '';
      mixedFields.push(field);
      conflictReasons.push({ field, photoIds: normalizedMembers.map((member) => member.photoId) });
    }
  }

  for (const member of normalizedMembers) {
    photoSpecificFields[member.photoId] = Object.fromEntries(
      PHOTO_SPECIFIC_FIELDS.map((field) => [field, member.effectiveInfo[field] ?? ''])
    );
  }

  for (const field of PHOTO_SPECIFIC_FIELDS) {
    if (uniqueValues(normalizedMembers.map((member) => member.effectiveInfo[field])).length > 1) {
      mixedFields.push(field);
    }
  }

  return {
    groupCommonFields,
    photoSpecificFields,
    mixedFields: [...new Set(mixedFields)],
    groupValidity: conflictReasons.length
      ? 'invalid_group'
      : missingCommonFields.length
        ? 'needs_completion'
        : 'valid',
    conflictReasons,
    missingCommonFields
  };
}

export function buildCanonicalArchiveFormSeed({
  groupCanonical = null,
  activePhotoEffectiveInfo = {},
  groupDraft = null,
  photoDraft = null
} = {}) {
  const groupFields = groupCanonical && groupCanonical.groupValidity !== 'invalid_group'
    ? groupCanonical.groupCommonFields || {}
    : {};
  const commonDraft = compactDraft(groupDraft);
  const specificDraft = compactDraft(photoDraft);
  const result = {
    ...activePhotoEffectiveInfo,
    ...groupFields,
    ...commonDraft,
    ...specificDraft
  };
  result.project = result.projectName || result.project || '';
  result.projectName = result.projectName || result.project || '';
  result.archiveCategory = result.archiveCategory || result.watermarkCategory || '';
  result.watermarkCategory = result.watermarkCategory || result.archiveCategory || '';
  result.locationArea = result.locationArea || result.location || '';
  result.location = result.location || result.locationArea || '';
  result.remarks = result.remarks || result.remark || '';
  result.remark = result.remark || result.remarks || '';
  return isolateTemplateSpecificFields(cloneCanonical(result));
}

function getEffectiveUnresolvedFields(value) {
  const missing = [];
  if (!cleanValue(value.date)) missing.push('date');
  if (!cleanValue(value.projectName || value.project)) missing.push('project');
  if (!cleanValue(value.archiveCategory || value.watermarkCategory)) missing.push('archiveCategory');
  if (
    value.watermarkTemplateType === WATERMARK_TEMPLATE_TYPES.STANDARD_WORK_RECORD
    && !cleanValue(value.workContent)
  ) missing.push('workContent');
  if (value.watermarkTemplateType === WATERMARK_TEMPLATE_TYPES.VEHICLE_VIOLATION) {
    if (!cleanValue(value.vehiclePlate)) missing.push('vehiclePlate');
    if (!cleanValue(value.violationType || value.workContent)) missing.push('violationType');
  }
  if (value.watermarkTemplateType === WATERMARK_TEMPLATE_TYPES.UNRESOLVED) {
    missing.push('watermarkTemplateType');
  }
  return [...new Set(missing)];
}

function uniqueValues(values) {
  return [...new Set(values.map(cleanValue).filter(Boolean))];
}

function cloneCanonical(value) {
  return structuredClone(value || {});
}

function cleanValue(value) {
  return String(value ?? '').normalize('NFKC').trim();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function compactDraft(value) {
  if (!isPlainObject(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, item]) => {
    if (typeof item === 'string') return cleanValue(item) !== '';
    if (Array.isArray(item)) return item.length > 0;
    if (isPlainObject(item)) return Object.keys(item).length > 0;
    return item != null;
  }));
}
