export const RECOGNITION_PROVIDER_TYPES = ['local_ocr', 'cloud_ocr', 'cloud_ai', 'manual'];

export const RECOGNITION_MODES = ['local', 'cloud', 'hybrid', 'manual', 'disabled'];

export const RECOGNITION_CONFIG_SENSITIVE_FIELDS = [
  'apiKey',
  'secretKey',
  'accessToken',
  'refreshToken',
  'authorization',
  'password',
  'token'
];

export const RECOGNITION_PROVIDER_STATUSES = [
  'available',
  'unavailable',
  'not_configured',
  'disabled',
  'provider_unavailable',
  'error'
];

export const RECOGNITION_CONFIG_STATUSES = [
  'configured',
  'not_configured',
  'disabled',
  'invalid'
];

export const RECOGNITION_RESULT_SOURCES = [
  'local_ocr',
  'cloud_ocr',
  'cloud_ai',
  'manual',
  'watermark_parser',
  'system'
];

export const RECOGNITION_RESULT_STATUSES = [
  'pending',
  'skipped',
  'running',
  'success',
  'recognized',
  'weak',
  'failed',
  'cancelled',
  'corrected',
  'provider_unavailable',
  'not_configured',
  'not_implemented',
  'no_input',
  'disabled',
  'error'
];

export const RECOGNITION_TASK_STATUSES = [
  'pending',
  'skipped',
  'running',
  'success',
  'failed',
  'cancelled',
  'provider_unavailable',
  'not_configured',
  'not_implemented',
  'disabled',
  'no_input'
];

export const RECOGNITION_STAGE_STATUS = {
  STAGED: 'staged',
  PENDING_REVIEW: 'pending_review',
  REVIEWED: 'reviewed',
  DISMISSED: 'dismissed',
  CLEARED: 'cleared',
  EXPIRED: 'expired'
};

export const RECOGNITION_STAGE_STATUSES = Object.values(RECOGNITION_STAGE_STATUS);

export const RECOGNITION_CANDIDATE_FIELD_STATUS = {
  CANDIDATE: 'candidate',
  PENDING_REVIEW: 'pending_review',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  IGNORED: 'ignored',
  CONFLICT: 'conflict',
  INVALID: 'invalid'
};

export const RECOGNITION_CANDIDATE_FIELD_STATUSES = Object.values(RECOGNITION_CANDIDATE_FIELD_STATUS);

export const RECOGNITION_CANDIDATE_FIELD_SET_STATUS = {
  EMPTY: 'empty',
  PENDING_REVIEW: 'pending_review',
  PARTIALLY_REVIEWED: 'partially_reviewed',
  REVIEWED: 'reviewed',
  DISMISSED: 'dismissed',
  FAILED: 'failed'
};

export const RECOGNITION_CANDIDATE_FIELD_SET_STATUSES = Object.values(RECOGNITION_CANDIDATE_FIELD_SET_STATUS);

export const RECOGNITION_REVIEW_DRAFT_STATUS = {
  PENDING_REVIEW: 'pending_review',
  REVIEWING: 'reviewing',
  ACCEPTED: 'accepted',
  PARTIALLY_ACCEPTED: 'partially_accepted',
  REJECTED: 'rejected',
  DISMISSED: 'dismissed',
  CLEARED: 'cleared'
};

export const RECOGNITION_REVIEW_DRAFT_STATUSES = Object.values(RECOGNITION_REVIEW_DRAFT_STATUS);

export const RECOGNITION_FIELD_DECISION_ACTION = {
  ACCEPT: 'accept',
  REJECT: 'reject',
  IGNORE: 'ignore',
  EDIT: 'edit'
};

export const RECOGNITION_FIELD_DECISION_ACTIONS = Object.values(RECOGNITION_FIELD_DECISION_ACTION);

export const RECOGNITION_REVIEW_DECISION_STATUS = {
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
  CONVERTED_TO_PATCH: 'converted_to_patch',
  DISMISSED: 'dismissed',
  CLEARED: 'cleared'
};

export const RECOGNITION_REVIEW_DECISION_STATUSES = Object.values(RECOGNITION_REVIEW_DECISION_STATUS);

export const RECOGNITION_FIELD_PATCH_OPERATION = {
  SET: 'set',
  APPEND: 'append',
  CLEAR: 'clear'
};

export const RECOGNITION_FIELD_PATCH_OPERATIONS = Object.values(RECOGNITION_FIELD_PATCH_OPERATION);

export const RECOGNITION_FORM_PATCH_DRAFT_STATUS = {
  DRAFT: 'draft',
  VALID: 'valid',
  INVALID: 'invalid',
  PARTIALLY_VALID: 'partially_valid',
  APPLIED: 'applied',
  DISMISSED: 'dismissed',
  CLEARED: 'cleared'
};

export const RECOGNITION_FORM_PATCH_DRAFT_STATUSES = Object.values(RECOGNITION_FORM_PATCH_DRAFT_STATUS);

export const RECOGNITION_ALLOWED_FORM_PATCH_FIELDS = [
  'photoSource',
  'project',
  'department',
  'watermarkCategory',
  'workContent',
  'date',
  'location',
  'itemName',
  'photoStage',
  'processStatus',
  'keywords',
  'remark'
];

export const RECOGNITION_PRIVACY_POLICY = {
  uploadsPhotos: false,
  callsRemoteService: false,
  logsRawText: false,
  requiresConsentForCloud: true
};

export const EMPTY_RECOGNITION_FIELDS = {
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

export const RECOGNITION_STATUS_COPY = {
  readyWithoutEngine: '识别服务底座已接入，识别引擎待配置。',
  manualFallback: '当前处理方式：手动填写归档信息',
  providerUnavailable: '识别引擎尚未接入'
};
