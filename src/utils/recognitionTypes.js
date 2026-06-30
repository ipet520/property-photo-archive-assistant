import {
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

export function createEmptyRecognitionResult(photo = {}) {
  return {
    photoId: photo.id || '',
    filePath: photo.originalPath || photo.path || '',
    source: 'system',
    providerId: '',
    mode: 'disabled',
    rawText: '',
    cleanedText: '',
    fields: {
      dateTime: '',
      date: '',
      time: '',
      location: '',
      project: '',
      workContent: '',
      categoryHint: '',
      keywords: [],
      remark: '',
      possibleStage: '',
      possibleStatus: ''
    },
    confidence: null,
    status: 'pending',
    errorCode: '',
    errorMessage: '',
    warnings: [],
    updatedAt: ''
  };
}

export function normalizeRecognitionResult(result = {}) {
  const empty = createEmptyRecognitionResult();
  return {
    ...empty,
    ...result,
    fields: {
      ...empty.fields,
      ...(result.fields || {}),
      keywords: normalizeKeywords(result.fields?.keywords)
    },
    warnings: Array.isArray(result.warnings) ? result.warnings.filter(Boolean) : [],
    confidence: Number.isFinite(Number(result.confidence)) ? Number(result.confidence) : null
  };
}

export function normalizeKeywords(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  return String(value || '').split(/[、,，;；\s]+/).map((item) => item.trim()).filter(Boolean);
}
