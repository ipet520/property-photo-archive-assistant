const localProvider = require('./recognitionProviders/localProvider.cjs');
const cloudProviders = require('./recognitionProviders/cloudProvider.cjs');
const manualProvider = require('./recognitionProviders/manualProvider.cjs');

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
  const providerStatuses = getRecognitionProviders();
  const availableProviders = providerStatuses.filter((provider) => provider.status === 'available');
  return {
    success: true,
    serviceStatus: 'available',
    engineStatus: availableProviders.some((provider) => provider.type !== 'manual') ? 'available' : 'not_configured',
    currentMode: 'disabled',
    message: '识别服务底座已接入，识别引擎待配置。',
    currentProcessing: '手动填写归档信息',
    providers: providerStatuses,
    privacy: RECOGNITION_CONFIG.privacy,
    updatedAt: new Date().toISOString()
  };
}

function getRecognitionProviders() {
  return providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    type: provider.type,
    mode: provider.mode,
    ...safeProviderStatus(provider)
  }));
}

function getRecognitionConfig() {
  return { ...RECOGNITION_CONFIG };
}

async function recognizePhoto(photo = {}, options = {}) {
  const provider = resolveProvider(options);
  if (!provider || provider.id === 'manual') {
    return normalizeRecognitionResult(createProviderUnavailableResult(photo, options));
  }
  try {
    return normalizeRecognitionResult(await provider.recognizePhoto(photo, options));
  } catch (error) {
    return normalizeRecognitionResult(createFailedResult(photo, options, error));
  }
}

async function recognizePhotos(photos = [], options = {}) {
  if (!Array.isArray(photos) || photos.length === 0) return [];
  const provider = resolveProvider(options);
  if (!provider || provider.id === 'manual') {
    return photos.map((photo) => normalizeRecognitionResult(createProviderUnavailableResult(photo, options)));
  }
  try {
    const results = await provider.recognizePhotos(photos, options);
    return results.map((result) => normalizeRecognitionResult(result));
  } catch (error) {
    return photos.map((photo) => normalizeRecognitionResult(createFailedResult(photo, options, error)));
  }
}

function parseRecognitionText(rawText = '', options = {}) {
  const cleanedText = cleanRecognitionText(rawText);
  const fields = normalizeRecognitionFields({
    ...extractDateTime(cleanedText),
    project: extractProject(cleanedText),
    location: extractLocation(cleanedText),
    ...extractWorkContent(cleanedText),
    possibleStage: detectPhotoStage(cleanedText),
    possibleStatus: detectProcessStatus(cleanedText)
  });
  return normalizeRecognitionResult({
    photoId: options.photoId || '',
    filePath: options.filePath || '',
    source: options.source || 'system',
    providerId: options.providerId || 'text_parser',
    mode: options.mode || 'manual',
    rawText: String(rawText || ''),
    cleanedText,
    fields,
    confidence: null,
    status: cleanedText ? 'weak' : 'failed',
    errorCode: cleanedText ? '' : 'empty_text',
    errorMessage: cleanedText ? '' : '识别文本为空。',
    warnings: cleanedText ? buildParserWarnings(fields) : ['识别文本为空，无法解析。'],
    updatedAt: new Date().toISOString()
  });
}

function normalizeRecognitionResult(result = {}) {
  return {
    photoId: String(result.photoId || ''),
    filePath: String(result.filePath || ''),
    source: result.source || 'system',
    providerId: result.providerId || '',
    mode: result.mode || 'disabled',
    rawText: String(result.rawText || ''),
    cleanedText: String(result.cleanedText || cleanRecognitionText(result.rawText || '')),
    fields: normalizeRecognitionFields(result.fields || {}),
    confidence: Number.isFinite(Number(result.confidence)) ? Number(result.confidence) : null,
    status: result.status || 'pending',
    errorCode: result.errorCode || '',
    errorMessage: result.errorMessage || '',
    warnings: Array.isArray(result.warnings) ? result.warnings.filter(Boolean) : [],
    updatedAt: result.updatedAt || new Date().toISOString()
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
  const patterns = [
    /(?<year>\d{4})[-/.年](?<month>\d{1,2})[-/.月](?<day>\d{1,2})(?:日)?\s*(?<time>\d{1,2}:\d{2})?/,
    /(?<month>\d{1,2})[-/.月](?<day>\d{1,2})(?:日)?\s*(?<time>\d{1,2}:\d{2})?/
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (!match?.groups) continue;
    const year = match.groups.year || '';
    const month = match.groups.month?.padStart(2, '0') || '';
    const day = match.groups.day?.padStart(2, '0') || '';
    const time = normalizeTime(match.groups.time || '');
    const date = year ? `${year}-${month}-${day}` : `${month}-${day}`;
    return { date, time, dateTime: time ? `${date} ${time}` : date };
  }
  return { date: '', time: '', dateTime: '' };
}

function extractProject(text = '') {
  const normalized = normalizeForMatch(text);
  const projects = [
    { project: '潇湘新区二期', aliases: ['曲靖潇湘新区二期', '潇湘新区二期', '潇湘', '新区二期'] },
    { project: '香辰康园', aliases: ['曲靖香辰康园', '香辰康园', '香辰'] }
  ];
  const matched = projects.find((item) => item.aliases.some((alias) => normalized.includes(normalizeForMatch(alias))));
  return matched?.project || '';
}

function extractLocation(text = '') {
  const value = String(text || '');
  const labeled = value.match(/(?:地点|位置|地址)[:：]?\s*([^\n，,。；;]{2,32})/);
  if (labeled?.[1]) return labeled[1].trim();
  const locationPattern = /((?:\d+\s*[栋幢号#][^\s，,。；;]{0,12})|(?:\d+\s*单元[^\s，,。；;]{0,8})|(?:楼道|通道|车库|门岗|道路|绿化带|设备房|消防通道|公共区域|地下室|电梯厅)[^\s，,。；;]{0,12})/;
  return value.match(locationPattern)?.[1]?.trim() || '';
}

function extractWorkContent(text = '') {
  const rules = [
    { workContent: '楼道杂物清理', categoryHint: '绿化保洁类', keywords: ['楼道杂物', '公共区域', '环境卫生', '清理整治'], tests: ['楼道杂物', '杂物清理'] },
    { workContent: '飞线充电治理', categoryHint: '安全管理类', keywords: ['飞线充电', '安全隐患', '用电安全', '治理'], tests: ['飞线充电', '飞线'] },
    { workContent: '消防通道违停', categoryHint: '机动车违规管理', keywords: ['消防通道', '违规停车', '车辆停放', '安全隐患'], tests: ['消防通道', '违停', '违规停车'] },
    { workContent: '公共设施设备维修', categoryHint: '工程类专用', keywords: ['公共设施', '设备维修', '工程维修', '设备设施'], tests: ['公共设施', '设备维修', '设施维修'] },
    { workContent: '环境卫生维护', categoryHint: '绿化保洁类', keywords: ['环境卫生', '清理', '保洁', '维护'], tests: ['环境卫生', '保洁', '清理'] },
    { workContent: '绿化养护', categoryHint: '绿化保洁类', keywords: ['绿化养护', '修剪', '绿化带'], tests: ['绿化养护', '修剪', '绿化带'] },
    { workContent: '秩序巡查', categoryHint: '巡查检查类', keywords: ['秩序巡查', '巡查', '现场记录'], tests: ['秩序巡查', '巡查'] },
    { workContent: '安全隐患排查', categoryHint: '安全管理类', keywords: ['安全隐患', '排查', '整改', '跟进'], tests: ['安全隐患', '隐患排查', '整改'] }
  ];
  const normalized = normalizeForMatch(text);
  const matched = rules.find((rule) => rule.tests.some((keyword) => normalized.includes(normalizeForMatch(keyword))));
  if (!matched) {
    const keywords = extractKeywords(text);
    return { workContent: keywords[0] || '', categoryHint: '', keywords, remark: '' };
  }
  return {
    workContent: matched.workContent,
    categoryHint: matched.categoryHint,
    keywords: matched.keywords,
    remark: ''
  };
}

function extractKeywords(text = '') {
  const candidates = ['楼道杂物', '飞线充电', '消防通道', '公共设施', '设备维修', '环境卫生', '绿化养护', '秩序巡查', '安全隐患', '高空抛物', '违停', '车辆停放', '资料整理', '宣传通知', '巡查', '清理', '维修', '整改', '处理'];
  const normalized = normalizeForMatch(text);
  return unique(candidates.filter((keyword) => normalized.includes(normalizeForMatch(keyword))));
}

function detectPhotoStage(text = '') {
  const rules = ['整改前', '整改中', '整改后', '处理前', '处理中', '处理后', '现场', '远景', '近景', '定位'];
  return rules.find((keyword) => normalizeForMatch(text).includes(normalizeForMatch(keyword))) || '';
}

function detectProcessStatus(text = '') {
  const rules = ['待处理', '处理中', '已处理', '已完成', '已整改', '已清理', '已维修', '已巡查', '已跟进'];
  return rules.find((keyword) => normalizeForMatch(text).includes(normalizeForMatch(keyword))) || '';
}

function normalizeRecognitionFields(fields = {}) {
  return {
    dateTime: String(fields.dateTime || '').trim(),
    date: String(fields.date || '').trim(),
    time: String(fields.time || '').trim(),
    location: String(fields.location || '').trim(),
    project: String(fields.project || '').trim(),
    workContent: String(fields.workContent || '').trim(),
    categoryHint: String(fields.categoryHint || '').trim(),
    keywords: unique(Array.isArray(fields.keywords) ? fields.keywords : String(fields.keywords || '').split(/[、,，;；\s]+/)),
    remark: String(fields.remark || '').trim(),
    possibleStage: String(fields.possibleStage || '').trim(),
    possibleStatus: String(fields.possibleStatus || '').trim()
  };
}

function buildParserWarnings(fields = {}) {
  return [
    !fields.date && '未解析到日期。',
    !fields.project && '未解析到项目。',
    !fields.location && '未解析到位置。',
    !fields.workContent && '未解析到工作内容。'
  ].filter(Boolean);
}

function resolveProvider(options = {}) {
  const providerId = options.providerId || '';
  const mode = options.mode || '';
  return providers.find((provider) => provider.id === providerId)
    || providers.find((provider) => provider.mode === mode && provider.mode !== 'manual')
    || null;
}

function safeProviderStatus(provider) {
  try {
    return provider.getStatus();
  } catch (error) {
    return {
      providerId: provider.id,
      status: 'error',
      message: '识别 provider 状态读取失败。',
      errorCode: 'provider_status_error'
    };
  }
}

function createProviderUnavailableResult(photo = {}, options = {}) {
  return {
    photoId: photo.id || photo.photoId || '',
    filePath: photo.originalPath || photo.filePath || photo.path || '',
    source: options.source || 'system',
    providerId: options.providerId || '',
    mode: options.mode || 'disabled',
    rawText: '',
    cleanedText: '',
    fields: normalizeRecognitionFields(),
    confidence: null,
    status: 'provider_unavailable',
    errorCode: 'provider_unavailable',
    errorMessage: '识别引擎尚未接入。',
    warnings: ['当前版本仅提供识别服务底座，不执行真实 OCR 或 AI 识别。'],
    updatedAt: new Date().toISOString()
  };
}

function createFailedResult(photo = {}, options = {}, error = {}) {
  return {
    ...createProviderUnavailableResult(photo, options),
    status: 'failed',
    errorCode: 'recognition_failed',
    errorMessage: error.message || '识别调用失败。',
    warnings: ['识别调用失败，未修改照片或台账。']
  };
}

function normalizeTime(value = '') {
  const match = String(value || '').match(/(\d{1,2}):(\d{2})/);
  if (!match) return '';
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

function normalizeForMatch(value = '') {
  return String(value || '').replace(/\s+/g, '').toLowerCase();
}

function unique(values = []) {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
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
