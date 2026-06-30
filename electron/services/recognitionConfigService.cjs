const fs = require('node:fs/promises');
const path = require('node:path');

const CONFIG_FILE_NAME = 'recognition-config.json';
const CONFIG_VERSION = 1;
const RECOGNITION_MODES = ['disabled', 'manual', 'local', 'cloud', 'hybrid'];
const SENSITIVE_FIELDS = new Set([
  'apiKey',
  'secretKey',
  'accessToken',
  'refreshToken',
  'authorization',
  'password',
  'token'
]);

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_RETRIES = 0;

const DEFAULT_PROVIDER_CONFIGS = {
  local_ocr: createDefaultProviderConfig({
    providerId: 'local_ocr',
    providerType: 'local_ocr',
    displayName: '本地 OCR',
    enabled: false
  }),
  cloud_ocr: createDefaultProviderConfig({
    providerId: 'cloud_ocr',
    providerType: 'cloud_ocr',
    displayName: '联网 OCR',
    enabled: false
  }),
  cloud_ai: createDefaultProviderConfig({
    providerId: 'cloud_ai',
    providerType: 'cloud_ai',
    displayName: '云端 AI 识图',
    enabled: false
  }),
  manual: createDefaultProviderConfig({
    providerId: 'manual',
    providerType: 'manual',
    displayName: '人工校正',
    enabled: true
  })
};

function getRecognitionConfigPath(userDataDir) {
  return path.join(String(userDataDir || ''), CONFIG_FILE_NAME);
}

function createDefaultRecognitionConfig() {
  const now = new Date().toISOString();
  return {
    version: CONFIG_VERSION,
    recognitionMode: 'disabled',
    activeProviderId: '',
    providers: cloneJson(DEFAULT_PROVIDER_CONFIGS),
    createdAt: now,
    updatedAt: now
  };
}

async function loadRecognitionConfig(userDataDir) {
  const configPath = getRecognitionConfigPath(userDataDir);
  const fallbackConfig = createDefaultRecognitionConfig();
  try {
    const content = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(content);
    const normalized = normalizeRecognitionConfig(parsed, fallbackConfig);
    const validation = validateRecognitionConfig(normalized);
    return {
      success: validation.errors.length === 0,
      config: normalized,
      safeConfig: maskSensitiveConfig(normalized),
      configPath,
      warnings: validation.warnings,
      errors: validation.errors,
      loadedAt: new Date().toISOString()
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        success: true,
        config: fallbackConfig,
        safeConfig: maskSensitiveConfig(fallbackConfig),
        configPath,
        warnings: ['识别配置文件不存在，已使用安全默认配置。'],
        errors: [],
        loadedAt: new Date().toISOString()
      };
    }
    return {
      success: false,
      config: fallbackConfig,
      safeConfig: maskSensitiveConfig(fallbackConfig),
      configPath,
      warnings: ['识别配置读取失败，已使用安全默认配置。'],
      errors: [{ code: 'recognition_config_read_failed', message: error.message || '识别配置读取失败。' }],
      loadedAt: new Date().toISOString()
    };
  }
}

async function getSafeRecognitionConfig(userDataDir) {
  const loaded = await loadRecognitionConfig(userDataDir);
  return {
    success: loaded.success,
    config: loaded.safeConfig,
    configPath: loaded.configPath,
    warnings: loaded.warnings,
    errors: loaded.errors,
    loadedAt: loaded.loadedAt
  };
}

async function updateRecognitionConfig(userDataDir, patch = {}) {
  const loaded = await loadRecognitionConfig(userDataDir);
  const rawValidation = validateRecognitionConfigPatch(patch);
  if (rawValidation.errors.length > 0) {
    return {
      success: false,
      config: loaded.safeConfig,
      configPath: loaded.configPath,
      warnings: rawValidation.warnings,
      errors: rawValidation.errors,
      updatedAt: new Date().toISOString()
    };
  }

  const merged = normalizeRecognitionConfig(deepMerge(loaded.config, patch), loaded.config);
  const validation = validateRecognitionConfig(merged);
  if (validation.errors.length > 0) {
    return {
      success: false,
      config: maskSensitiveConfig(merged),
      configPath: loaded.configPath,
      warnings: validation.warnings,
      errors: validation.errors,
      updatedAt: new Date().toISOString()
    };
  }

  const nextConfig = {
    ...merged,
    createdAt: loaded.config.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await fs.mkdir(path.dirname(loaded.configPath), { recursive: true });
  await fs.writeFile(loaded.configPath, JSON.stringify(nextConfig, null, 2), 'utf-8');
  return {
    success: true,
    config: maskSensitiveConfig(nextConfig),
    configPath: loaded.configPath,
    warnings: validation.warnings,
    errors: [],
    updatedAt: nextConfig.updatedAt
  };
}

async function diagnoseRecognitionConfig(userDataDir) {
  const loaded = await loadRecognitionConfig(userDataDir);
  const config = loaded.config;
  const providerDiagnostics = Object.fromEntries(Object.entries(config.providers || {}).map(([providerId, providerConfig]) => [
    providerId,
    {
      providerId,
      providerType: providerConfig.providerType || '',
      enabled: providerConfig.enabled === true,
      displayName: providerConfig.displayName || providerId,
      configStatus: getProviderConfigStatus(providerConfig),
      safeConfig: maskSensitiveConfig(providerConfig)
    }
  ]));
  return {
    success: loaded.success,
    mode: config.recognitionMode,
    activeProviderId: config.activeProviderId,
    providers: providerDiagnostics,
    configPath: loaded.configPath,
    warnings: loaded.warnings,
    errors: loaded.errors,
    checkedAt: new Date().toISOString()
  };
}

function normalizeRecognitionConfig(config = {}, fallback = createDefaultRecognitionConfig()) {
  const mergedProviders = {
    ...cloneJson(DEFAULT_PROVIDER_CONFIGS),
    ...cloneJson(fallback.providers || {}),
    ...cloneJson(config.providers || {})
  };
  const normalizedProviders = Object.fromEntries(Object.entries(mergedProviders).map(([providerId, providerConfig]) => [
    providerId,
    normalizeProviderConfig({ providerId, ...providerConfig })
  ]));
  return {
    ...cloneJson(fallback),
    ...cloneJson(config),
    version: Number(config.version || fallback.version || CONFIG_VERSION),
    recognitionMode: RECOGNITION_MODES.includes(config.recognitionMode) ? config.recognitionMode : (fallback.recognitionMode || 'disabled'),
    activeProviderId: String(config.activeProviderId || fallback.activeProviderId || ''),
    providers: normalizedProviders,
    createdAt: String(config.createdAt || fallback.createdAt || new Date().toISOString()),
    updatedAt: String(config.updatedAt || fallback.updatedAt || new Date().toISOString())
  };
}

function normalizeProviderConfig(config = {}) {
  return {
    ...cloneJson(config),
    enabled: config.enabled === true,
    providerId: String(config.providerId || ''),
    providerType: String(config.providerType || ''),
    displayName: String(config.displayName || config.providerId || ''),
    endpoint: String(config.endpoint || ''),
    apiKey: String(config.apiKey || ''),
    model: String(config.model || ''),
    timeoutMs: normalizePositiveNumber(config.timeoutMs, DEFAULT_TIMEOUT_MS),
    maxRetries: normalizeNonNegativeInteger(config.maxRetries, DEFAULT_MAX_RETRIES),
    extraOptions: isPlainObject(config.extraOptions) ? cloneJson(config.extraOptions) : {}
  };
}

function validateRecognitionConfig(config = {}) {
  const errors = [];
  const warnings = [];
  if (!RECOGNITION_MODES.includes(config.recognitionMode)) {
    errors.push({ code: 'invalid_recognition_mode', message: 'recognitionMode 必须是允许的识别模式。' });
  }
  const providers = isPlainObject(config.providers) ? config.providers : {};
  if (config.activeProviderId && !providers[config.activeProviderId]) {
    errors.push({ code: 'invalid_active_provider', message: 'activeProviderId 必须存在于 providers 中，或为空。' });
  }
  Object.entries(providers).forEach(([providerId, providerConfig]) => {
    if (typeof providerConfig.enabled !== 'boolean') {
      errors.push({ code: 'invalid_provider_enabled', message: `${providerId}.enabled 必须是布尔值。` });
    }
    if (!Number.isFinite(Number(providerConfig.timeoutMs)) || Number(providerConfig.timeoutMs) <= 0) {
      errors.push({ code: 'invalid_timeout', message: `${providerId}.timeoutMs 必须是正数。` });
    }
    if (!Number.isInteger(Number(providerConfig.maxRetries)) || Number(providerConfig.maxRetries) < 0) {
      errors.push({ code: 'invalid_max_retries', message: `${providerId}.maxRetries 必须是非负整数。` });
    }
    if (providerConfig.endpoint && typeof providerConfig.endpoint !== 'string') {
      errors.push({ code: 'invalid_endpoint', message: `${providerId}.endpoint 必须是字符串。` });
    }
    if (providerConfig.apiKey && typeof providerConfig.apiKey !== 'string') {
      errors.push({ code: 'invalid_api_key', message: `${providerId}.apiKey 必须是字符串。` });
    }
    const status = getProviderConfigStatus(providerConfig);
    if (providerConfig.enabled && status.missingFields.length > 0 && isCloudProviderType(providerConfig.providerType)) {
      warnings.push(`${providerId} 已启用但缺少配置项：${status.missingFields.join('、')}。`);
    }
  });
  return { valid: errors.length === 0, errors, warnings };
}

function validateRecognitionConfigPatch(patch = {}) {
  const errors = [];
  const warnings = [];
  if (patch.recognitionMode !== undefined && !RECOGNITION_MODES.includes(patch.recognitionMode)) {
    errors.push({ code: 'invalid_recognition_mode', message: 'recognitionMode 必须是允许的识别模式。' });
  }
  if (patch.activeProviderId !== undefined && typeof patch.activeProviderId !== 'string') {
    errors.push({ code: 'invalid_active_provider', message: 'activeProviderId 必须是字符串或为空。' });
  }
  if (patch.providers !== undefined && !isPlainObject(patch.providers)) {
    errors.push({ code: 'invalid_providers', message: 'providers 必须是对象。' });
  }
  Object.entries(isPlainObject(patch.providers) ? patch.providers : {}).forEach(([providerId, providerConfig]) => {
    if (!isPlainObject(providerConfig)) {
      errors.push({ code: 'invalid_provider_config', message: `${providerId} 配置必须是对象。` });
      return;
    }
    if (providerConfig.enabled !== undefined && typeof providerConfig.enabled !== 'boolean') {
      errors.push({ code: 'invalid_provider_enabled', message: `${providerId}.enabled 必须是布尔值。` });
    }
    if (providerConfig.timeoutMs !== undefined && (!Number.isFinite(Number(providerConfig.timeoutMs)) || Number(providerConfig.timeoutMs) <= 0)) {
      errors.push({ code: 'invalid_timeout', message: `${providerId}.timeoutMs 必须是正数。` });
    }
    if (providerConfig.maxRetries !== undefined && (!Number.isInteger(Number(providerConfig.maxRetries)) || Number(providerConfig.maxRetries) < 0)) {
      errors.push({ code: 'invalid_max_retries', message: `${providerId}.maxRetries 必须是非负整数。` });
    }
    if (providerConfig.endpoint !== undefined && typeof providerConfig.endpoint !== 'string') {
      errors.push({ code: 'invalid_endpoint', message: `${providerId}.endpoint 必须是字符串。` });
    }
    if (providerConfig.apiKey !== undefined && typeof providerConfig.apiKey !== 'string') {
      errors.push({ code: 'invalid_api_key', message: `${providerId}.apiKey 必须是字符串。` });
    }
  });
  return { valid: errors.length === 0, errors, warnings };
}

function getProviderConfigStatus(providerConfig = {}) {
  const hasEndpoint = Boolean(String(providerConfig.endpoint || '').trim());
  const hasApiKey = Boolean(String(providerConfig.apiKey || '').trim());
  const hasModel = Boolean(String(providerConfig.model || '').trim());
  const isEnabled = providerConfig.enabled === true;
  const missingFields = [];
  if (isEnabled && isCloudProviderType(providerConfig.providerType)) {
    if (!hasEndpoint) missingFields.push('endpoint');
    if (!hasApiKey) missingFields.push('apiKey');
  }
  return {
    hasEndpoint,
    hasApiKey,
    hasModel,
    isEnabled,
    missingFields
  };
}

function maskSensitiveConfig(value) {
  if (Array.isArray(value)) return value.map(maskSensitiveConfig);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (SENSITIVE_FIELDS.has(key)) return [key, maskSensitiveValue(item)];
    return [key, maskSensitiveConfig(item)];
  }));
}

function maskSensitiveValue(value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 4) return '已配置';
  return `****${text.slice(-4)}`;
}

function createDefaultProviderConfig({ providerId, providerType, displayName, enabled }) {
  return {
    enabled,
    providerId,
    providerType,
    displayName,
    endpoint: '',
    apiKey: '',
    model: '',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxRetries: DEFAULT_MAX_RETRIES,
    extraOptions: {}
  };
}

function isCloudProviderType(providerType = '') {
  return ['cloud_ocr', 'cloud_ai'].includes(providerType);
}

function normalizePositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalizeNonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function deepMerge(base = {}, patch = {}) {
  if (!isPlainObject(base)) return cloneJson(patch);
  if (!isPlainObject(patch)) return cloneJson(base);
  const output = cloneJson(base);
  Object.entries(patch).forEach(([key, value]) => {
    output[key] = isPlainObject(value) && isPlainObject(output[key])
      ? deepMerge(output[key], value)
      : cloneJson(value);
  });
  return output;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value) {
  if (value === undefined) return {};
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  CONFIG_FILE_NAME,
  RECOGNITION_MODES,
  SENSITIVE_FIELDS,
  createDefaultRecognitionConfig,
  getRecognitionConfigPath,
  loadRecognitionConfig,
  getSafeRecognitionConfig,
  updateRecognitionConfig,
  diagnoseRecognitionConfig,
  normalizeRecognitionConfig,
  validateRecognitionConfig,
  getProviderConfigStatus,
  maskSensitiveConfig
};
