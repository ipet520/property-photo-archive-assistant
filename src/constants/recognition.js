export const RECOGNITION_PROVIDER_TYPES = ['local_ocr', 'cloud_ocr', 'cloud_ai', 'manual'];

export const RECOGNITION_MODES = ['local', 'cloud', 'hybrid', 'manual', 'disabled'];

export const RECOGNITION_PROVIDER_STATUSES = [
  'available',
  'unavailable',
  'not_configured',
  'disabled',
  'error'
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
  'recognized',
  'weak',
  'failed',
  'corrected',
  'provider_unavailable',
  'not_configured',
  'disabled',
  'error'
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
