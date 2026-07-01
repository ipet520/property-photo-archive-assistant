import {
  EMPTY_RECOGNITION_FIELDS,
  RECOGNITION_CANDIDATE_FIELD_SET_STATUSES,
  RECOGNITION_CANDIDATE_FIELD_STATUSES,
  RECOGNITION_MODES,
  RECOGNITION_PROVIDER_STATUSES,
  RECOGNITION_PROVIDER_TYPES as PROVIDER_TYPES,
  RECOGNITION_RESULT_SOURCES,
  RECOGNITION_RESULT_STATUSES,
  RECOGNITION_REVIEW_DRAFT_STATUSES,
  RECOGNITION_STAGE_STATUSES,
  RECOGNITION_TASK_STATUSES
} from '../constants/recognition.js';

export { RECOGNITION_MODES };

export const RECOGNITION_SOURCES = RECOGNITION_RESULT_SOURCES;

export const RECOGNITION_STATUSES = RECOGNITION_RESULT_STATUSES;

export const RECOGNITION_PROVIDER_STATUS = RECOGNITION_PROVIDER_STATUSES;

export const RECOGNITION_TASK_STATUS = RECOGNITION_TASK_STATUSES;

export const RECOGNITION_STAGE_STATUS = RECOGNITION_STAGE_STATUSES;

export const RECOGNITION_PROVIDERS = ['local_ocr', 'cloud_ocr', 'cloud_ai', 'manual'];

export const RECOGNITION_PROVIDER_TYPES = PROVIDER_TYPES;

export function createEmptyRecognitionFields() {
  return {
    ...EMPTY_RECOGNITION_FIELDS,
    keywords: []
  };
}

export function createEmptyRecognitionResult(photo = {}) {
  const parsedFields = createEmptyRecognitionFields();
  return {
    photoId: photo.id || '',
    filePath: photo.originalPath || photo.path || '',
    fileName: photo.fileName || photo.name || '',
    taskId: '',
    source: 'system',
    providerId: '',
    providerType: '',
    status: 'pending',
    confidence: null,
    rawText: '',
    parsedFields,
    warnings: [],
    errors: [],
    createdAt: '',
    // Backward-compatible aliases for the V2.8.0 internal bridge.
    mode: 'disabled',
    cleanedText: '',
    fields: parsedFields,
    errorCode: '',
    errorMessage: '',
    updatedAt: '',
    stagedResultId: '',
    stageStatus: '',
    stagedResult: undefined,
    candidateFieldSetId: '',
    candidateFieldSet: undefined,
    reviewDraftId: '',
    reviewDraft: undefined,
    candidateReviewError: undefined,
    stagingError: undefined
  };
}

export function createRecognitionTask(photo = {}, patch = {}) {
  const createdAt = patch.createdAt || new Date().toISOString();
  return {
    taskId: patch.taskId || createTaskId(photo),
    photoId: String(photo.id || photo.photoId || patch.photoId || ''),
    filePath: String(photo.originalPath || photo.filePath || photo.path || patch.filePath || ''),
    fileName: String(photo.fileName || photo.name || patch.fileName || ''),
    providerId: String(patch.providerId || ''),
    providerType: String(patch.providerType || ''),
    mode: String(patch.mode || 'disabled'),
    status: patch.status || 'pending',
    createdAt,
    startedAt: patch.startedAt || '',
    finishedAt: patch.finishedAt || '',
    errors: normalizeErrors(patch.errors),
    warnings: normalizeStringArray(patch.warnings)
  };
}

export function normalizeRecognitionResult(result = {}) {
  const empty = createEmptyRecognitionResult();
  const parsedFields = normalizeRecognitionFields(result.parsedFields || result.fields || {});
  const errors = normalizeErrors(result.errors, result.errorCode, result.errorMessage);
  const createdAt = result.createdAt || result.updatedAt || new Date().toISOString();
  const providerType = result.providerType || result.type || result.mode || '';
  return {
    ...empty,
    ...result,
    taskId: String(result.taskId || empty.taskId || ''),
    photoId: String(result.photoId || empty.photoId || ''),
    fileName: String(result.fileName || empty.fileName || ''),
    providerType,
    status: result.status || empty.status,
    confidence: Number.isFinite(Number(result.confidence)) ? Number(result.confidence) : null,
    rawText: String(result.rawText || ''),
    parsedFields,
    warnings: normalizeStringArray(result.warnings),
    errors,
    createdAt,
    mode: result.mode || providerType || 'disabled',
    cleanedText: String(result.cleanedText || cleanText(result.rawText || '')),
    fields: parsedFields,
    errorCode: errors[0]?.code || result.errorCode || '',
    errorMessage: errors[0]?.message || result.errorMessage || '',
    updatedAt: createdAt,
    task: result.task && typeof result.task === 'object' ? result.task : undefined,
    stagedResultId: String(result.stagedResultId || ''),
    stageStatus: String(result.stageStatus || ''),
    stagedResult: result.stagedResult && typeof result.stagedResult === 'object' ? normalizeRecognitionStagedResult(result.stagedResult) : undefined,
    candidateFieldSetId: String(result.candidateFieldSetId || ''),
    candidateFieldSet: result.candidateFieldSet && typeof result.candidateFieldSet === 'object' ? normalizeRecognitionCandidateFieldSet(result.candidateFieldSet) : undefined,
    reviewDraftId: String(result.reviewDraftId || ''),
    reviewDraft: result.reviewDraft && typeof result.reviewDraft === 'object' ? normalizeRecognitionReviewDraft(result.reviewDraft) : undefined,
    candidateReviewError: result.candidateReviewError && typeof result.candidateReviewError === 'object' ? result.candidateReviewError : undefined,
    stagingError: result.stagingError && typeof result.stagingError === 'object' ? result.stagingError : undefined
  };
}

export function normalizeRecognitionStagedResult(result = {}) {
  const createdAt = String(result.createdAt || new Date().toISOString());
  return {
    id: String(result.id || ''),
    taskId: String(result.taskId || ''),
    photoId: String(result.photoId || ''),
    filePath: String(result.filePath || ''),
    fileName: String(result.fileName || ''),
    providerId: String(result.providerId || ''),
    providerKey: String(result.providerKey || result.providerId || ''),
    providerType: String(result.providerType || ''),
    recognitionStatus: String(result.recognitionStatus || result.status || 'pending'),
    stageStatus: normalizeStageStatus(result.stageStatus),
    rawText: String(result.rawText || ''),
    parsedFields: normalizePlainObject(result.parsedFields),
    proposedFields: normalizePlainObject(result.proposedFields),
    confidence: Number.isFinite(Number(result.confidence)) ? Number(result.confidence) : null,
    warnings: normalizeStringArray(result.warnings),
    errors: normalizeErrors(result.errors),
    message: String(result.message || ''),
    source: 'recognition_pipeline',
    createdAt,
    updatedAt: String(result.updatedAt || createdAt),
    reviewedAt: String(result.reviewedAt || ''),
    clearedAt: String(result.clearedAt || ''),
    schemaVersion: 1
  };
}

export function normalizeRecognitionCandidateField(field = {}) {
  const createdAt = String(field.createdAt || new Date().toISOString());
  return {
    id: String(field.id || ''),
    stagedResultId: String(field.stagedResultId || ''),
    taskId: String(field.taskId || ''),
    sourceFieldKey: String(field.sourceFieldKey || ''),
    targetFieldKey: String(field.targetFieldKey || 'unmapped'),
    label: String(field.label || field.sourceFieldKey || ''),
    value: cloneJsonValue(field.value),
    normalizedValue: cloneJsonValue(field.normalizedValue),
    confidence: Number.isFinite(Number(field.confidence)) ? Number(field.confidence) : null,
    status: normalizeCandidateFieldStatus(field.status),
    source: 'recognition_proposed_fields',
    reason: String(field.reason || ''),
    warning: String(field.warning || ''),
    error: String(field.error || ''),
    canApply: field.canApply === true,
    requiresReview: true,
    allowAutoApply: false,
    existingValue: field.existingValue === undefined ? null : cloneJsonValue(field.existingValue),
    hasConflict: field.hasConflict === true,
    conflictReason: String(field.conflictReason || ''),
    createdAt,
    updatedAt: String(field.updatedAt || createdAt),
    schemaVersion: 1
  };
}

export function normalizeRecognitionCandidateFieldSet(fieldSet = {}) {
  const createdAt = String(fieldSet.createdAt || new Date().toISOString());
  return {
    id: String(fieldSet.id || ''),
    stagedResultId: String(fieldSet.stagedResultId || ''),
    taskId: String(fieldSet.taskId || ''),
    photoId: String(fieldSet.photoId || ''),
    filePath: String(fieldSet.filePath || ''),
    fileName: String(fieldSet.fileName || ''),
    fields: (Array.isArray(fieldSet.fields) ? fieldSet.fields : []).map(normalizeRecognitionCandidateField),
    status: normalizeCandidateFieldSetStatus(fieldSet.status),
    warnings: normalizeStringArray(fieldSet.warnings),
    errors: normalizeErrors(fieldSet.errors),
    createdAt,
    updatedAt: String(fieldSet.updatedAt || createdAt),
    schemaVersion: 1
  };
}

export function normalizeRecognitionReviewDraft(draft = {}) {
  const createdAt = String(draft.createdAt || new Date().toISOString());
  const fields = (Array.isArray(draft.fields) ? draft.fields : []).map(normalizeRecognitionCandidateField);
  return {
    id: String(draft.id || ''),
    stagedResultId: String(draft.stagedResultId || ''),
    candidateFieldSetId: String(draft.candidateFieldSetId || ''),
    taskId: String(draft.taskId || ''),
    photoId: String(draft.photoId || ''),
    filePath: String(draft.filePath || ''),
    fileName: String(draft.fileName || ''),
    fields,
    status: normalizeReviewDraftStatus(draft.status),
    summary: {
      total: Number(draft.summary?.total || fields.length),
      canApplyCount: Number(draft.summary?.canApplyCount || fields.filter((field) => field.canApply).length),
      requiresReviewCount: Number(draft.summary?.requiresReviewCount || fields.filter((field) => field.requiresReview).length),
      conflictCount: Number(draft.summary?.conflictCount || fields.filter((field) => field.hasConflict).length),
      invalidCount: Number(draft.summary?.invalidCount || fields.filter((field) => field.status === 'invalid').length)
    },
    createdAt,
    updatedAt: String(draft.updatedAt || createdAt),
    reviewedAt: String(draft.reviewedAt || ''),
    clearedAt: String(draft.clearedAt || ''),
    schemaVersion: 1
  };
}

function createTaskId(photo = {}) {
  const seed = `${photo.id || photo.photoId || photo.fileName || photo.name || 'photo'}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `rec_${seed.replace(/[^a-zA-Z0-9_-]+/g, '_')}`;
}

export function normalizeRecognitionFields(fields = {}) {
  return {
    watermarkCategory: nullableString(fields.watermarkCategory || fields.categoryHint),
    workContent: nullableString(fields.workContent),
    projectName: nullableString(fields.projectName || fields.project),
    location: nullableString(fields.location),
    date: nullableString(fields.date),
    time: nullableString(fields.time),
    weekday: nullableString(fields.weekday),
    keywords: normalizeKeywords(fields.keywords),
    remark: nullableString(fields.remark),
    stage: nullableString(fields.stage || fields.photoStage || fields.possibleStage),
    processStatus: nullableString(fields.processStatus || fields.possibleStatus),
    // Backward-compatible aliases for older suggestion rules.
    project: nullableString(fields.projectName || fields.project),
    categoryHint: nullableString(fields.watermarkCategory || fields.categoryHint),
    possibleStage: nullableString(fields.stage || fields.photoStage || fields.possibleStage),
    possibleStatus: nullableString(fields.processStatus || fields.possibleStatus),
    dateTime: nullableString(fields.dateTime)
  };
}

export function normalizeKeywords(value) {
  if (Array.isArray(value)) return normalizeStringArray(value);
  return String(value || '')
    .split(/[、,，;；\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeErrors(errors, errorCode = '', errorMessage = '') {
  const normalized = Array.isArray(errors)
    ? errors.map((error) => {
      if (!error) return null;
      if (typeof error === 'string') return { code: 'recognition_error', message: error };
      return {
        code: String(error.code || error.errorCode || 'recognition_error'),
        message: String(error.message || error.errorMessage || '')
      };
    }).filter((error) => error?.message)
    : [];
  if (normalized.length > 0) return normalized;
  if (errorCode || errorMessage) {
    return [{ code: String(errorCode || 'recognition_error'), message: String(errorMessage || '识别结果异常。') }];
  }
  return [];
}

function normalizeStringArray(values = []) {
  return Array.from(new Set((Array.isArray(values) ? values : [values])
    .map((item) => String(item || '').trim())
    .filter(Boolean)));
}

function nullableString(value) {
  const text = String(value || '').trim();
  return text || null;
}

function cleanText(value) {
  return String(value || '').replace(/\r/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

function normalizeStageStatus(value = '') {
  const stageStatus = String(value || '').trim();
  return RECOGNITION_STAGE_STATUSES.includes(stageStatus) ? stageStatus : 'staged';
}

function normalizeCandidateFieldStatus(value = '') {
  const status = String(value || '').trim();
  return RECOGNITION_CANDIDATE_FIELD_STATUSES.includes(status) ? status : 'pending_review';
}

function normalizeCandidateFieldSetStatus(value = '') {
  const status = String(value || '').trim();
  return RECOGNITION_CANDIDATE_FIELD_SET_STATUSES.includes(status) ? status : 'empty';
}

function normalizeReviewDraftStatus(value = '') {
  const status = String(value || '').trim();
  return RECOGNITION_REVIEW_DRAFT_STATUSES.includes(status) ? status : 'pending_review';
}

function normalizePlainObject(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return {};
  }
}

function cloneJsonValue(value) {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}
