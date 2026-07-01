const localProvider = require('./recognitionProviders/localProvider.cjs');
const cloudProviders = require('./recognitionProviders/cloudProvider.cjs');
const manualProvider = require('./recognitionProviders/manualProvider.cjs');
const {
  createUnavailableResult,
  normalizeParsedFields,
  normalizeRecognitionResult
} = require('./recognitionProviders/providerUtils.cjs');
const {
  diagnoseRecognitionConfig,
  getSafeRecognitionConfig,
  loadRecognitionConfig,
  updateRecognitionConfig
} = require('./recognitionConfigService.cjs');

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

async function getRecognitionStatus(userDataDir) {
  try {
    const loaded = await loadRecognitionConfig(userDataDir);
    const config = loaded.config;
    const providerStatuses = await getRecognitionProviders(userDataDir, config);
    const mode = config.recognitionMode || 'disabled';
    const targetProvider = resolveStatusProvider(providerStatuses, config);
    const realEngineAvailable = providerStatuses.some((provider) => provider.available && provider.type !== 'manual');
    const effectiveAvailable = mode === 'manual'
      ? Boolean(targetProvider?.available)
      : Boolean(targetProvider?.available && targetProvider.type !== 'manual');
    const status = mode === 'disabled'
      ? 'disabled'
      : (targetProvider?.status || (realEngineAvailable ? 'available' : 'not_configured'));
    const reason = mode === 'disabled'
      ? '识别服务已禁用，当前保持手动填写归档信息流程。'
      : (targetProvider?.reason || '识别 provider 尚未配置，当前保持手动填写归档信息流程。');
    return {
      success: true,
      serviceStatus: 'available',
      engineStatus: effectiveAvailable ? 'available' : status,
      currentMode: mode,
      activeProviderId: config.activeProviderId || '',
      status,
      available: effectiveAvailable,
      reason,
      message: effectiveAvailable ? '识别 provider 可用。' : reason,
      currentProcessing: '手动填写归档信息',
      providers: providerStatuses,
      warnings: loaded.warnings,
      errors: loaded.errors,
      privacy: RECOGNITION_CONFIG.privacy,
      updatedAt: new Date().toISOString()
    };
  } catch (error) {
    return createServiceError('recognition_status_error', error);
  }
}

async function getRecognitionProviders(userDataDir, loadedConfig = null) {
  const config = loadedConfig || (await loadRecognitionConfig(userDataDir)).config;
  return providers.map((provider) => safeDiagnoseProvider(provider, config));
}

async function getRecognitionConfig(userDataDir) {
  const safeConfig = await getSafeRecognitionConfig(userDataDir);
  return {
    ...safeConfig,
    defaults: { ...RECOGNITION_CONFIG }
  };
}

async function recognizePhoto(photo = {}, options = {}) {
  return (await recognizePhotos([photo], options))[0] || buildErrorResult(createRecognitionTask(photo, options), new Error('未生成识别结果。'));
}

async function recognizePhotos(photos = [], options = {}) {
  try {
    const safePhotos = Array.isArray(photos) ? photos : [];
    if (safePhotos.length === 0) return [];
    const loaded = options.config
      ? { config: options.config, warnings: [], errors: [] }
      : (options.userDataDir ? await loadRecognitionConfig(options.userDataDir) : { config: createDisabledRecognitionConfig(), warnings: [], errors: [] });
    const results = [];
    for (const photo of safePhotos) {
      const task = createRecognitionTask(photo, {
        mode: loaded.config.recognitionMode || 'disabled',
        providerId: options.providerId || loaded.config.activeProviderId || '',
        providerType: options.providerType || ''
      });
      results.push(await runRecognitionTask(task, photo, loaded.config, options, loaded));
    }
    return results;
  } catch (error) {
    return (Array.isArray(photos) ? photos : []).map((photo) => normalizeRecognitionResult({
      ...buildErrorResult(createRecognitionTask(photo, options), error),
      errors: [{ code: 'recognition_failed', message: error.message || '识别调用失败。' }],
      warnings: ['识别调用失败，未修改照片或台账。']
    }));
  }
}

async function runRecognitionTask(task, photo = {}, config = {}, options = {}, loaded = {}) {
  const startedAt = new Date().toISOString();
  const runningTask = { ...task, status: 'running', startedAt };
  const mode = config.recognitionMode || 'disabled';
  if (mode === 'disabled') {
    return buildUnavailableResult(runningTask, '识别服务已禁用，当前保持手动填写归档信息流程。', {
      status: 'disabled',
      code: 'recognition_disabled',
      warnings: ['识别服务已禁用，已跳过识别任务。']
    });
  }

  const provider = selectProvider(config, options);
  if (!provider) {
    return buildUnavailableResult(runningTask, '未找到可用识别 provider。', {
      status: 'not_configured',
      code: 'provider_not_configured',
      warnings: ['识别 provider 未配置，已跳过识别任务。']
    });
  }

  const providerStatus = safeDiagnoseProvider(provider, config);
  const providerTask = {
    ...runningTask,
    providerId: provider.id || '',
    providerType: provider.type || '',
    mode: provider.mode || mode
  };
  const normalizedStatus = normalizeProviderExecutionStatus(providerStatus);
  if (!providerStatus.available && provider.id !== 'manual') {
    return buildUnavailableResult(providerTask, providerStatus.reason || providerStatus.message || '识别 provider 不可用。', {
      status: normalizedStatus,
      code: normalizedStatus,
      warnings: [
        providerStatus.reason || '识别 provider 不可用。',
        ...(loaded.warnings || [])
      ]
    });
  }

  try {
    const providerOptions = {
      ...options,
      config,
      providerStatus,
      task: providerTask,
      taskId: providerTask.taskId
    };
    const rawResult = typeof provider.recognize === 'function'
      ? await provider.recognize(photo, providerOptions)
      : createUnavailableResult(photo, provider, {
        taskId: providerTask.taskId,
        status: 'not_implemented',
        code: 'provider_not_implemented',
        reason: '识别 provider 尚未实现 recognize 方法。'
      });
    const parsedManualResult = provider.id === 'manual' && rawResult.rawText
      ? parseRecognitionText(rawResult.rawText, {
        photoId: providerTask.photoId,
        filePath: providerTask.filePath,
        source: 'manual',
        providerId: provider.id,
        providerType: provider.type
      })
      : null;
    const parsedFields = hasUsefulParsedFields(rawResult.parsedFields)
      ? rawResult.parsedFields
      : (parsedManualResult?.parsedFields || rawResult.parsedFields);
    return normalizeRecognitionResult({
      ...rawResult,
      parsedFields,
      warnings: [
        ...(rawResult.warnings || []),
        ...(parsedManualResult?.warnings || [])
      ],
      taskId: providerTask.taskId,
      photoId: providerTask.photoId,
      fileName: providerTask.fileName,
      filePath: providerTask.filePath,
      providerId: provider.id || rawResult.providerId || '',
      providerType: provider.type || rawResult.providerType || '',
      source: rawResult.source || provider.type || 'system',
      createdAt: rawResult.createdAt || new Date().toISOString(),
      task: {
        ...providerTask,
        status: normalizeTaskStatus(rawResult.status),
        finishedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    return buildErrorResult(providerTask, error);
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

function resolveProvider(options = {}, config = {}) {
  const providerId = options.providerId || '';
  const mode = options.mode || '';
  const activeProviderId = providerId || config.activeProviderId || '';
  const activeMode = mode || config.recognitionMode || '';
  return providers.find((provider) => provider.id === activeProviderId)
    || providers.find((provider) => provider.type === activeProviderId)
    || providers.find((provider) => provider.mode === activeMode && provider.mode !== 'manual')
    || providers.find((provider) => provider.type === activeMode && provider.type !== 'manual')
    || null;
}

function selectProvider(config = {}, options = {}) {
  return resolveProvider(options, config);
}

function createRecognitionTask(photo = {}, patch = {}) {
  const filePath = photo.originalPath || photo.filePath || photo.path || patch.filePath || '';
  const fileName = photo.fileName || photo.name || String(filePath).split(/[\\/]/).pop() || '';
  const createdAt = patch.createdAt || new Date().toISOString();
  return {
    taskId: patch.taskId || createTaskId(photo, createdAt),
    photoId: String(photo.id || photo.photoId || patch.photoId || ''),
    filePath: String(filePath || ''),
    fileName: String(fileName || ''),
    providerId: String(patch.providerId || ''),
    providerType: String(patch.providerType || ''),
    mode: String(patch.mode || 'disabled'),
    status: patch.status || 'pending',
    createdAt,
    startedAt: patch.startedAt || '',
    finishedAt: patch.finishedAt || '',
    errors: Array.isArray(patch.errors) ? patch.errors : [],
    warnings: Array.isArray(patch.warnings) ? patch.warnings : []
  };
}

function buildUnavailableResult(task = {}, reason = '', patch = {}) {
  const status = patch.status || 'provider_unavailable';
  return normalizeRecognitionResult({
    taskId: task.taskId || '',
    photoId: task.photoId || '',
    filePath: task.filePath || '',
    fileName: task.fileName || '',
    source: patch.source || 'system',
    providerId: task.providerId || patch.providerId || '',
    providerType: task.providerType || patch.providerType || '',
    status,
    confidence: null,
    rawText: '',
    parsedFields: {},
    warnings: Array.isArray(patch.warnings) ? patch.warnings : [reason || '识别任务未执行。'],
    errors: patch.errors || [{ code: patch.code || status, message: reason || '识别任务未执行。' }],
    createdAt: new Date().toISOString(),
    task: {
      ...task,
      status: normalizeTaskStatus(status),
      finishedAt: new Date().toISOString(),
      errors: patch.errors || [{ code: patch.code || status, message: reason || '识别任务未执行。' }],
      warnings: Array.isArray(patch.warnings) ? patch.warnings : [reason || '识别任务未执行。']
    }
  });
}

function buildErrorResult(task = {}, error = {}) {
  const message = error.message || '识别任务执行失败。';
  return buildUnavailableResult(task, message, {
    status: 'failed',
    code: 'recognition_task_failed',
    warnings: ['识别任务执行失败，未修改照片或台账。'],
    errors: [{ code: 'recognition_task_failed', message }]
  });
}

function normalizeProviderExecutionStatus(providerStatus = {}) {
  if (providerStatus.status === 'disabled') return 'disabled';
  if (providerStatus.status === 'not_configured') return 'not_configured';
  if (providerStatus.status === 'not_implemented') return 'not_implemented';
  if (providerStatus.status === 'error') return 'provider_unavailable';
  return providerStatus.available ? 'success' : 'provider_unavailable';
}

function normalizeTaskStatus(status = '') {
  if (['disabled', 'not_configured', 'not_implemented', 'provider_unavailable', 'failed', 'cancelled', 'skipped', 'no_input'].includes(status)) {
    return status;
  }
  if (['success', 'recognized', 'corrected'].includes(status)) return 'success';
  return status || 'failed';
}

function hasUsefulParsedFields(fields = {}) {
  return Object.entries(fields || {}).some(([key, value]) => {
    if (['project', 'categoryHint', 'possibleStage', 'possibleStatus', 'dateTime'].includes(key)) return false;
    if (Array.isArray(value)) return value.length > 0;
    return value !== null && value !== undefined && String(value).trim() !== '';
  });
}

function createDisabledRecognitionConfig() {
  return {
    recognitionMode: 'disabled',
    activeProviderId: '',
    providers: {}
  };
}

function createTaskId(photo = {}, createdAt = new Date().toISOString()) {
  const seed = `${photo.id || photo.photoId || photo.fileName || photo.name || 'photo'}-${createdAt}-${Math.random().toString(16).slice(2)}`;
  return `rec_${seed.replace(/[^a-zA-Z0-9_-]+/g, '_')}`;
}

function resolveStatusProvider(providerStatuses = [], config = {}) {
  const mode = config.recognitionMode || 'disabled';
  if (mode === 'disabled') return null;
  if (config.activeProviderId) {
    return providerStatuses.find((provider) => provider.providerId === config.activeProviderId || provider.id === config.activeProviderId) || null;
  }
  if (mode === 'hybrid') {
    return providerStatuses.find((provider) => provider.type !== 'manual' && provider.available)
      || providerStatuses.find((provider) => provider.type !== 'manual')
      || null;
  }
  return providerStatuses.find((provider) => provider.mode === mode || provider.type === mode || provider.providerId === mode) || null;
}

function safeDiagnoseProvider(provider, config = {}) {
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
      ...diagnose.call(provider, config)
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
      checkedAt: new Date().toISOString(),
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
  getSafeRecognitionConfig,
  updateRecognitionConfig,
  diagnoseRecognitionConfig,
  createRecognitionTask,
  selectProvider,
  recognizePhoto,
  recognizePhotos,
  parseRecognitionText,
  normalizeRecognitionResult,
  cleanRecognitionText
};
