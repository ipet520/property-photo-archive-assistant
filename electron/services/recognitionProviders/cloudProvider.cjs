const { createProviderStatus, createUnavailableResult } = require('./providerUtils.cjs');
const { getProviderConfigStatus, maskSensitiveConfig } = require('../recognitionConfigService.cjs');

function createCloudProvider({ id, name, type }) {
  return {
    id,
    name,
    type,
    mode: 'cloud',
    enabled: false,
    available: false,
    status: 'disabled',
    reason: '联网识别能力尚未配置，当前版本不会上传照片或调用远程服务。',
    capabilities: ['status_diagnose', 'placeholder_recognize'],
    config: {
      endpoint: '',
      providerName: '',
      authType: '',
      enabled: false,
      requiresUserConsent: true
    },
    diagnose(config = {}) {
      const providerConfig = resolveProviderConfig(this, config);
      const configStatus = getProviderConfigStatus(providerConfig);
      const enabled = providerConfig.enabled === true;
      const missingFields = configStatus.missingFields || [];
      const isConfigured = missingFields.length === 0 && configStatus.hasEndpoint && configStatus.hasApiKey;
      const status = !enabled ? 'disabled' : (isConfigured ? 'not_implemented' : 'not_configured');
      const reason = !enabled
        ? '联网识别 provider 未启用，当前不会上传照片或调用远程服务。'
        : (isConfigured
          ? '联网识别 provider 已配置，但真实远程识别请求尚未启用。'
          : `联网识别 provider 缺少配置项：${missingFields.join('、') || 'endpoint、apiKey'}。`);
      return createProviderStatus(this, {
        enabled,
        available: false,
        status,
        reason,
        message: reason,
        capabilities: this.capabilities,
        requiresUserConsent: true,
        configStatus,
        safeConfig: maskSensitiveConfig(providerConfig)
      });
    },
    checkAvailability() {
      return this.diagnose();
    },
    getStatus() {
      return this.diagnose();
    },
    async recognize(photo = {}, options = {}) {
      const providerConfig = resolveProviderConfig(this, options.config || {});
      const configStatus = getProviderConfigStatus(providerConfig);
      const missingFields = configStatus.missingFields || [];
      const hasRequiredConfig = configStatus.hasEndpoint && configStatus.hasApiKey && missingFields.length === 0;
      return createUnavailableResult(photo, this, {
        taskId: options.taskId || options.task?.taskId || '',
        status: hasRequiredConfig ? 'not_implemented' : 'not_configured',
        code: hasRequiredConfig ? `${id}_not_implemented` : `${id}_not_configured`,
        reason: hasRequiredConfig
          ? '真实远程识别请求尚未启用，未上传照片、未发起网络请求。'
          : `联网识别 provider 缺少配置项：${missingFields.join('、') || 'endpoint、apiKey'}。`,
        warnings: ['当前版本不上传照片、不调用远程识别服务。']
      });
    },
    async recognizePhoto(photo = {}, options = {}) {
      return this.recognize(photo, options);
    },
    async recognizePhotos(photos = [], options = {}) {
      return Promise.all((Array.isArray(photos) ? photos : []).map((photo) => this.recognize(photo, options)));
    }
  };
}

function resolveProviderConfig(provider, config = {}) {
  return config.providers?.[provider.id] || config[provider.id] || config || {};
}

module.exports = [
  createCloudProvider({ id: 'cloud_ocr', name: '联网 OCR', type: 'cloud_ocr' }),
  createCloudProvider({ id: 'cloud_ai', name: '云端 AI 识图', type: 'cloud_ai' })
];
