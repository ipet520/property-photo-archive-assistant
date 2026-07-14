const { createProviderStatus, createUnavailableResult } = require('./providerUtils.cjs');
const { getProviderConfigStatus, maskSensitiveConfig } = require('../recognitionConfigService.cjs');
const { runLocalOcr, diagnoseLocalOcr } = require('../localOcrService.cjs');

const LOCAL_PROVIDER = {
  id: 'local_ocr',
  name: '本地 OCR',
  type: 'local_ocr',
  mode: 'local',
  enabled: false,
  available: false,
  status: 'not_configured',
  reason: '本地 OCR 引擎待检测。',
  capabilities: ['status_diagnose', 'watermark_ocr', 'tesseract_command'],
  async diagnose(config = {}) {
    const providerConfig = resolveProviderConfig(this, config);
    const enabled = providerConfig.enabled === true || ['local_first', 'local_only', 'compare', 'local', 'hybrid'].includes(config.recognitionMode);
    const detected = enabled ? await diagnoseLocalOcr(providerConfig, config.runtime || {}) : null;
    const available = Boolean(enabled && detected?.available);
    const reason = enabled ? detected.reason : '本地 OCR provider 未启用。';
    return createProviderStatus(this, {
      enabled,
      available,
      status: !enabled ? 'disabled' : (available ? 'available' : 'not_configured'),
      reason,
      message: reason,
      capabilities: this.capabilities,
      requiresUserConsent: false,
      configStatus: getProviderConfigStatus(providerConfig),
      safeConfig: maskSensitiveConfig(providerConfig),
      engine: detected?.engine || 'rapidocr',
      engineName: 'RapidOCR-ONNX',
      source: detected?.command?.source || detected?.source || 'none',
      executablePath: detected?.command?.executablePath || detected?.executablePath || ''
    });
  },
  async checkAvailability(config = {}) {
    return this.diagnose(config);
  },
  async getStatus(config = {}) {
    return this.diagnose(config);
  },
  async recognize(photo = {}, options = {}) {
    const providerConfig = resolveProviderConfig(this, options.config || {});
    const enabled = providerConfig.enabled === true || ['local_first', 'local_only', 'compare', 'local', 'hybrid'].includes(options.config?.recognitionMode);
    if (!enabled) {
      return createUnavailableResult(photo, this, {
        taskId: options.taskId || options.task?.taskId || '',
        status: 'disabled',
        code: 'local_ocr_disabled',
        reason: '本地 OCR provider 未启用。'
      });
    }
    const imagePath = photo.croppedPath || photo.filePath || photo.originalPath || photo.path || '';
    const result = await runLocalOcr(imagePath, providerConfig, options);
    return {
      taskId: options.taskId || options.task?.taskId || '',
      photoId: photo.id || photo.photoId || '',
      filePath: photo.originalPath || photo.filePath || photo.path || '',
      fileName: photo.fileName || photo.name || '',
      source: 'watermark_local',
      providerId: this.id,
      providerType: this.type,
      rawText: result.text,
      parsedFields: {},
      confidence: result.confidence,
      status: result.success && result.text ? 'success' : (result.success ? 'empty' : 'failed'),
      warnings: result.success && !result.text ? ['本地 OCR 返回空文本，需人工确认或使用云端增强。'] : [],
      errors: result.success && result.text ? [] : [{ code: result.success ? 'local_ocr_empty' : 'local_ocr_failed', message: result.error || '本地 OCR 失败。' }],
      createdAt: new Date().toISOString(),
      engineResult: result
    };
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
