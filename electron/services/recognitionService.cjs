const localProvider = require('./recognitionProviders/localProvider.cjs');
const cloudProviders = require('./recognitionProviders/cloudProvider.cjs');
const manualProvider = require('./recognitionProviders/manualProvider.cjs');
const {
  createUnavailableResult,
  normalizeParsedFields,
  normalizeRecognitionResult
} = require('./recognitionProviders/providerUtils.cjs');

const providers = [localProvider, ...cloudProviders, manualProvider];

const RECOGNITION_CONFIG = {
  defaultMode: 'disabled',
  modes: ['local', 'cloud', 'hybrid', 'manual', 'disabled'],
  providerTypes: ['local_ocr', 'cloud_ocr', 'cloud_ai', 'manual'],
  privacy: {
    uploadsPhotos: false,
    callsRemoteService: false,
    logsRawText: false,
    requiresConsentForCloud: true
  },
  cloud: {
    endpoint: '',
    providerName: '',
    authType: '',
    enabled: false,
    requiresUserConsent: true
  }
};

function getRecognitionStatus() {
  try {
    const providerStatuses = getRecognitionProviders();
    const realEngineAvailable = providerStatuses.some((provider) => provider.available && provider.type !== 'manual');
    const hasConfiguredProvider = providerStatuses.some((provider) => ['available', 'disabled', 'not_configured'].includes(provider.status));
    return {
      success: true,
      serviceStatus: hasConfiguredProvider ? 'available' : 'unavailable',
      engineStatus: realEngineAvailable ? 'available' : 'not_configured',
      currentMode: 'disabled',
      status: realEngineAvailable ? 'available' : 'not_configured',
      reason: realEngineAvailable ? '' : '识别引擎待配置，当前仅保留手动填写归档信息流程。',
      message: '识别服务底座已接入，识别引擎待配置。',
      currentProcessing: '手动填写归档信息',
      providers: providerStatuses,
      privacy: RECOGNITION_CONFIG.privacy,
      updatedAt: new Date().toISOString()
    };
  } catch (error) {
    return createServiceError('recognition_status_error', error);
  }
}

function getRecognitionProviders() {
  return providers.map((provider) => safeDiagnoseProvider(provider));
}

function getRecognitionConfig() {
  return { ...RECOGNITION_CONFIG };
}

async function recognizePhoto(photo = {}, options = {}) {
  return (await recognizePhotos([photo], options))[0] || createProviderUnavailableResult(photo, options);
}

async function recognizePhotos(photos = [], options = {}) {
  try {
    const safePhotos = Array.isArray(photos) ? photos : [];
    if (safePhotos.length === 0) return [];
    const provider = resolveProvider(options);
    if (!provider || provider.id === 'manual') {
      return safePhotos.map((photo) => createProviderUnavailableResult(photo, options));
    }
    const status = safeDiagnoseProvider(provider);
    if (!status.available) {
      return safePhotos.map((photo) => createProviderUnavailableResult(photo, {
        ...options,
        providerId: provider.id,
        reason: status.reason || status.message,
        status: status.status
      }));
    }
    if (typeof provider.recognizePhotos === 'function') {
      const results = await provider.recognizePhotos(safePhotos, options);
      return (Array.isArray(results) ? results : []).map((result) => normalizeRecognitionResult(result));
    }
    return Promise.all(safePhotos.map((photo) => provider.recognize(photo, options).then(normalizeRecognitionResult)));
  } catch (error) {
    return (Array.isArray(photos) ? photos : []).map((photo) => normalizeRecognitionResult({
      ...createProviderUnavailableResult(photo, options),
      status: 'failed',
      errors: [{ code: 'recognition_failed', message: error.message || '识别调用失败。' }],
      warnings: ['识别调用失败，未修改照片或台账。']
    }));
  }
}

function parseRecognitionText(rawText = '', options = {}) {
  try {
    const cleanedText = cleanRecognitionText(rawText);
    const parsedFields = normalizeParsedFields({
      ...extractDateTime(cleanedText),
      projectName: extractLabeledValue(cleanedText, ['项目', '项目名称', '小区']),
      location: extractLabeledValue(cleanedText, ['地点', '地址', '位置']) || extractLocation(cleanedText),
      ...extractWorkContent(cleanedText),
      remark: extractLabeledValue(cleanedText, ['备注', '说明']),
      stage: detectPhotoStage(cleanedText),
      processStatus: detectProcessStatus(cleanedText)
    });
    return normalizeRecognitionResult({
      photoId: options.photoId || '',
      filePath: options.filePath || '',
      source: options.source || 'watermark_parser',
      providerId: options.providerId || 'text_parser',
      providerType: options.providerType || 'manual',
      rawText: String(rawText || ''),
      cleanedText,
      parsedFields,
      confidence: null,
      status: cleanedText ? 'weak' : 'failed',
      errors: cleanedText ? [] : [{ code: 'empty_text', message: '识别文本为空。' }],
      warnings: cleanedText ? buildParserWarnings(parsedFields) : ['识别文本为空，无法解析。'],
      createdAt: new Date().toISOString()
    });
  } catch (error) {
    return normalizeRecognitionResult({
      source: options.source || 'watermark_parser',
      providerId: options.providerId || 'text_parser',
      providerType: options.providerType || 'manual',
      rawText: String(rawText || ''),
      status: 'failed',
      errors: [{ code: 'parse_failed', message: error.message || '识别文本解析失败。' }],
      warnings: ['识别文本解析失败，未修改照片或台账。'],
      createdAt: new Date().toISOString()
    });
  }
}

function resolveProvider(options = {}) {
  const providerId = options.providerId || '';
  const mode = options.mode || '';
  return providers.find((provider) => provider.id === providerId)
    || providers.find((provider) => provider.type === providerId)
    || providers.find((provider) => provider.mode === mode && provider.mode !== 'manual')
    || providers.find((provider) => provider.type === mode && provider.type !== 'manual')
    || null;
}

function safeDiagnoseProvider(provider) {
  try {
    const diagnose = provider.diagnose || provider.checkAvailability || provider.getStatus;
    if (typeof diagnose !== 'function') throw new Error('Provider 未实现 diagnose/checkAvailability。');
    return {
      id: provider.id,
      providerId: provider.id,
      name: provider.name,
      type: provider.type,
      mode: provider.mode || '',
      enabled: Boolean(provider.enabled),
      available: Boolean(provider.available),
      status: provider.status || 'unavailable',
      reason: provider.reason || '',
      capabilities: Array.isArray(provider.capabilities) ? provider.capabilities : [],
      ...diagnose.call(provider)
    };
  } catch (error) {
    return {
      id: provider.id || '',
      providerId: provider.id || '',
      name: provider.name || '未知识别 provider',
      type: provider.type || '',
      enabled: false,
      available: false,
      status: 'error',
      reason: error.message || '识别 provider 状态读取失败。',
      message: '识别 provider 状态读取失败。',
      capabilities: [],
      errors: [{ code: 'provider_status_error', message: error.message || 'provider 状态异常。' }]
    };
  }
}

function createProviderUnavailableResult(photo = {}, options = {}) {
  const provider = providers.find((item) => item.id === options.providerId) || {};
  return createUnavailableResult(photo, provider, {
    status: options.status || 'provider_unavailable',
    code: options.status === 'disabled' ? 'provider_disabled' : 'provider_unavailable',
    reason: options.reason || '识别引擎尚未接入。',
    warnings: [options.reason || '当前版本仅提供识别服务底座，不执行真实 OCR 或 AI 识别。']
  });
}

function createServiceError(code, error) {
  return {
    success: false,
    serviceStatus: 'unavailable',
    engineStatus: 'error',
    currentMode: 'disabled',
    status: 'error',
    reason: error.message || '识别服务状态读取失败。',
    message: '识别服务状态读取失败。',
    providers: [],
    errors: [{ code, message: error.message || '识别服务异常。' }],
    updatedAt: new Date().toISOString()
  };
}

function cleanRecognitionText(rawText = '') {
  return String(rawText || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function extractDateTime(text = '') {
  const value = String(text || '');
  const datePatterns = [
    /(?<year>\d{4})[-/.](?<month>\d{1,2})[-/.](?<day>\d{1,2})/,
    /(?<year>\d{4})年(?<month>\d{1,2})月(?<day>\d{1,2})日?/
  ];
  const timeMatch = value.match(/(?<!\d)(?<hour>\d{1,2}):(?<minute>\d{2})(?::(?<second>\d{2}))?(?!\d)/);
  const weekday = value.match(/(星期[一二三四五六日天]|周[一二三四五六日天])/)?.[1] || null;
  let date = null;
  for (const pattern of datePatterns) {
    const match = value.match(pattern);
    if (!match?.groups) continue;
    date = `${match.groups.year}-${match.groups.month.padStart(2, '0')}-${match.groups.day.padStart(2, '0')}`;
    break;
  }
  const time = timeMatch?.groups
    ? `${timeMatch.groups.hour.padStart(2, '0')}:${timeMatch.groups.minute}${timeMatch.groups.second ? `:${timeMatch.groups.second}` : ''}`
    : null;
  return { date, time, weekday, dateTime: date && time ? `${date} ${time}` : null };
}

function extractLocation(text = '') {
  const locationPattern = /((?:\d+\s*[栋幢号#][^\s，,。；;]{0,12})|(?:\d+\s*单元[^\s，,。；;]{0,8})|(?:楼层|楼道|通道|车库|门岗|道路|绿化带|设备房|消防通道|公共区域|地下室|电梯厅)[^\s，,。；;]{0,12})/;
  return String(text || '').match(locationPattern)?.[1]?.trim() || null;
}

function extractWorkContent(text = '') {
  const labeledWorkContent = extractLabeledValue(text, ['工作内容', '事项', '事项名称']);
  const labeledCategory = extractLabeledValue(text, ['水印分类', '分类']);
  const normalized = normalizeForMatch(text);
  const rules = [
    { workContent: '楼道杂物清理', watermarkCategory: '绿化保洁类', keywords: ['楼道杂物', '公共区域', '环境卫生', '清理整治'], tests: ['楼道杂物', '杂物清理'] },
    { workContent: '飞线充电治理', watermarkCategory: '安全管理类', keywords: ['飞线充电', '安全隐患', '用电安全', '治理'], tests: ['飞线充电', '飞线'] },
    { workContent: '消防通道违停', watermarkCategory: '机动车违规管理', keywords: ['消防通道', '违规停车', '车辆停放', '安全隐患'], tests: ['消防通道', '违停', '违规停车'] },
    { workContent: '公共设施设备维修', watermarkCategory: '工程类专用', keywords: ['公共设施', '设备维修', '工程维修', '设备设施'], tests: ['公共设施', '设备维修', '设施维修'] }
  ];
  const matched = rules.find((rule) => rule.tests.some((keyword) => normalized.includes(normalizeForMatch(keyword))));
  return {
    workContent: labeledWorkContent || matched?.workContent || null,
    watermarkCategory: labeledCategory || matched?.watermarkCategory || null,
    keywords: matched?.keywords || []
  };
}

function detectPhotoStage(text = '') {
  return ['整改前', '整改中', '整改后', '处理前', '处理中', '处理后', '现场', '远景', '近景', '定位']
    .find((keyword) => normalizeForMatch(text).includes(normalizeForMatch(keyword))) || null;
}

function detectProcessStatus(text = '') {
  return ['待处理', '处理中', '已处理', '已完成', '已整改', '已清理', '已维修', '已巡查', '已跟进']
    .find((keyword) => normalizeForMatch(text).includes(normalizeForMatch(keyword))) || null;
}

function extractLabeledValue(text = '', labels = []) {
  const escapedLabels = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return String(text || '').match(new RegExp(`(?:${escapedLabels})\\s*[:：]\\s*([^\\n，,。；;]{1,60})`))?.[1]?.trim() || null;
}

function buildParserWarnings(fields = {}) {
  return [
    !fields.date && '未解析到日期。',
    !fields.time && '未解析到时间。',
    !fields.projectName && '未解析到项目名称。',
    !fields.location && '未解析到地点或位置。',
    !fields.workContent && '未解析到工作内容。',
    !fields.watermarkCategory && '未解析到水印分类。'
  ].filter(Boolean);
}

function normalizeForMatch(value = '') {
  return String(value || '').replace(/\s+/g, '').toLowerCase();
}

module.exports = {
  getRecognitionStatus,
  getRecognitionProviders,
  getRecognitionConfig,
  recognizePhoto,
  recognizePhotos,
  parseRecognitionText,
  normalizeRecognitionResult,
  cleanRecognitionText
};
