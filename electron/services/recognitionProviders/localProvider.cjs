const { createProviderStatus, createUnavailableResult } = require('./providerUtils.cjs');
const { getProviderConfigStatus, maskSensitiveConfig } = require('../recognitionConfigService.cjs');

const LOCAL_PROVIDER = {
  id: 'local_ocr',
  name: '本地 OCR',
  type: 'local_ocr',
  mode: 'local',
  enabled: false,
  available: false,
  status: 'not_configured',
  reason: '本地 OCR 引擎尚未接入。',
  capabilities: ['status_diagnose', 'placeholder_recognize'],
  diagnose(config = {}) {
    const providerConfig = resolveProviderConfig(this, config);
    const enabled = providerConfig.enabled === true;
    const reason = enabled
      ? '本地 OCR provider 已启用，但真实 OCR 引擎尚未接入。'
      : '本地 OCR provider 未启用。';
    return createProviderStatus(this, {
      enabled,
      available: false,
      status: enabled ? 'not_implemented' : 'disabled',
      reason,
      message: reason,
      capabilities: this.capabilities,
      requiresUserConsent: false,
      configStatus: getProviderConfigStatus(providerConfig),
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
    return createUnavailableResult(photo, this, {
      taskId: options.taskId || options.task?.taskId || '',
      status: 'not_implemented',
      code: 'local_ocr_not_implemented',
      reason: '本地 OCR 引擎尚未接入，当前不执行真实识别。',
      warnings: ['本地 OCR 引擎尚未接入，不返回假 OCR 文本。']
    });
  },
  async recognizePhoto(photo = {}, options = {}) {
    return this.recognize(photo, options);
  },
  async recognizePhotos(photos = [], options = {}) {
    return Promise.all((Array.isArray(photos) ? photos : []).map((photo) => this.recognize(photo, options)));
  }
};

function resolveProviderConfig(provider, config = {}) {
  return config.providers?.[provider.id] || config[provider.id] || config || {};
}

module.exports = LOCAL_PROVIDER;
