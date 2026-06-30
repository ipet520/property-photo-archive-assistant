const EMPTY_PARSED_FIELDS = {
  watermarkCategory: null,
  workContent: null,
  projectName: null,
  location: null,
  date: null,
  time: null,
  weekday: null,
  keywords: [],
  remark: null,
  stage: null,
  processStatus: null
};

function createProviderStatus(provider = {}, patch = {}) {
  const status = patch.status || (patch.available ? 'available' : 'not_configured');
  return {
    id: provider.id || patch.id || '',
    providerId: provider.id || patch.providerId || '',
    name: provider.name || patch.name || '',
    type: provider.type || patch.type || '',
    mode: provider.mode || patch.mode || '',
    enabled: Boolean(patch.enabled),
    available: Boolean(patch.available),
    status,
    reason: patch.reason || patch.message || '',
    message: patch.message || patch.reason || '',
    capabilities: Array.isArray(patch.capabilities) ? patch.capabilities : [],
    requiresUserConsent: Boolean(patch.requiresUserConsent),
    configStatus: patch.configStatus || undefined,
    safeConfig: patch.safeConfig || undefined,
    checkedAt: patch.checkedAt || new Date().toISOString()
  };
}

function createUnavailableResult(photo = {}, provider = {}, patch = {}) {
  const reason = patch.reason || '识别 provider 尚未配置。';
  return normalizeRecognitionResult({
    photoId: photo.id || photo.photoId || '',
    filePath: photo.originalPath || photo.filePath || photo.path || '',
    source: provider.type || 'system',
    providerId: provider.id || '',
    providerType: provider.type || '',
    rawText: '',
    parsedFields: createEmptyParsedFields(),
    confidence: null,
    status: patch.status || 'provider_unavailable',
    warnings: patch.warnings || [reason],
    errors: patch.errors || [{ code: patch.code || 'provider_unavailable', message: reason }],
    createdAt: new Date().toISOString()
  });
}

function normalizeRecognitionResult(result = {}) {
  const parsedFields = normalizeParsedFields(result.parsedFields || result.fields || {});
  const errors = normalizeErrors(result.errors, result.errorCode, result.errorMessage);
  const createdAt = result.createdAt || result.updatedAt || new Date().toISOString();
  return {
    photoId: String(result.photoId || ''),
    filePath: String(result.filePath || ''),
    source: result.source || 'system',
    providerId: result.providerId || '',
    providerType: result.providerType || result.type || result.mode || '',
    status: result.status || 'pending',
    confidence: Number.isFinite(Number(result.confidence)) ? Number(result.confidence) : null,
    rawText: String(result.rawText || ''),
    parsedFields,
    warnings: normalizeStringArray(result.warnings),
    errors,
    createdAt,
    mode: result.mode || result.providerType || 'disabled',
    cleanedText: String(result.cleanedText || cleanText(result.rawText || '')),
    fields: parsedFields,
    errorCode: errors[0]?.code || '',
    errorMessage: errors[0]?.message || '',
    updatedAt: createdAt
  };
}

function normalizeParsedFields(fields = {}) {
  return {
    watermarkCategory: nullableString(fields.watermarkCategory || fields.categoryHint),
    workContent: nullableString(fields.workContent),
    projectName: nullableString(fields.projectName || fields.project),
    location: nullableString(fields.location),
    date: nullableString(fields.date),
    time: nullableString(fields.time),
    weekday: nullableString(fields.weekday),
    keywords: normalizeStringArray(Array.isArray(fields.keywords) ? fields.keywords : String(fields.keywords || '').split(/[、,，;；\s]+/)),
    remark: nullableString(fields.remark),
    stage: nullableString(fields.stage || fields.photoStage || fields.possibleStage),
    processStatus: nullableString(fields.processStatus || fields.possibleStatus),
    project: nullableString(fields.projectName || fields.project),
    categoryHint: nullableString(fields.watermarkCategory || fields.categoryHint),
    possibleStage: nullableString(fields.stage || fields.photoStage || fields.possibleStage),
    possibleStatus: nullableString(fields.processStatus || fields.possibleStatus),
    dateTime: nullableString(fields.dateTime)
  };
}

function createEmptyParsedFields() {
  return {
    ...EMPTY_PARSED_FIELDS,
    keywords: []
  };
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
    .map((value) => String(value || '').trim())
    .filter(Boolean)));
}

function nullableString(value) {
  const text = String(value || '').trim();
  return text || null;
}

function cleanText(value) {
  return String(value || '').replace(/\r/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

module.exports = {
  createProviderStatus,
  createUnavailableResult,
  normalizeRecognitionResult,
  normalizeParsedFields,
  createEmptyParsedFields
};
