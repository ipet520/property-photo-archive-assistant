import {
  EMPTY_RECOGNITION_FIELDS,
  RECOGNITION_MODES,
  RECOGNITION_PROVIDER_STATUSES,
  RECOGNITION_PROVIDER_TYPES as PROVIDER_TYPES,
  RECOGNITION_RESULT_SOURCES,
  RECOGNITION_RESULT_STATUSES
} from '../constants/recognition.js';

export { RECOGNITION_MODES };

export const RECOGNITION_SOURCES = RECOGNITION_RESULT_SOURCES;

export const RECOGNITION_STATUSES = RECOGNITION_RESULT_STATUSES;

export const RECOGNITION_PROVIDER_STATUS = RECOGNITION_PROVIDER_STATUSES;

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
    updatedAt: ''
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
    updatedAt: createdAt
  };
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
