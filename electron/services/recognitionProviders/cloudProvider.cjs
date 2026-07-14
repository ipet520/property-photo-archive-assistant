const { createProviderStatus, createUnavailableResult } = require('./providerUtils.cjs');
const { getProviderConfigStatus, maskSensitiveConfig } = require('../recognitionConfigService.cjs');
const { runCustomCloudOcr } = require('../cloudOcrService.cjs');

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
    capabilities: ['status_diagnose', 'watermark_ocr', 'custom_http_ocr'],
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
      const requireAuth = providerConfig.extraOptions?.requireAuth !== false;
      const isConfigured = configStatus.hasEndpoint && (!requireAuth || configStatus.hasApiKey) && missingFields.length === 0;
      const status = !enabled ? 'disabled' : (isConfigured ? 'available' : 'not_configured');
      const reason = !enabled
        ? '联网识别 provider 未启用，当前不会上传照片或调用远程服务。'
        : (isConfigured
          ? '联网识别 provider 已配置；仅在用户授权后上传裁剪水印区域并发起请求。'
          : `联网识别 provider 缺少配置项：${missingFields.join('、') || 'endpoint、apiKey'}。`);
      return createProviderStatus(this, {
        enabled,
        available: enabled && isConfigured,
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
      const requireAuth = providerConfig.extraOptions?.requireAuth !== false;
      const hasRequiredConfig = configStatus.hasEndpoint && (!requireAuth || configStatus.hasApiKey) && missingFields.length === 0;
      if (providerConfig.enabled !== true || !hasRequiredConfig) {
        return createUnavailableResult(photo, this, {
          taskId: options.taskId || options.task?.taskId || '',
          status: providerConfig.enabled === true ? 'not_configured' : 'disabled',
          code: providerConfig.enabled === true ? `${id}_not_configured` : `${id}_disabled`,
          reason: providerConfig.enabled === true
            ? `联网识别 provider 缺少配置项：${missingFields.join('、') || 'endpoint、apiKey'}。`
            : '联网识别 provider 未启用。'
        });
      }
      const imagePath = photo.croppedPath || photo.filePath || photo.originalPath || photo.path || '';
      const result = await runCustomCloudOcr(imagePath, providerConfig, options);
      return {
        taskId: options.taskId || options.task?.taskId || '',
        photoId: photo.id || photo.photoId || '',
        filePath: photo.originalPath || photo.filePath || photo.path || '',
        fileName: photo.fileName || photo.name || '',
        source: 'watermark_cloud',
        providerId: this.id,
        providerType: this.type,
        rawText: result.text,
        parsedFields: {},
        confidence: result.confidence,
        status: result.success && result.text ? 'success' : (result.success ? 'empty' : 'failed'),
        warnings: result.success && !result.text ? ['云端 OCR 返回空文本，需人工确认。'] : [],
        errors: result.success && result.text ? [] : [{ code: result.success ? 'cloud_ocr_empty' : 'cloud_ocr_failed', message: result.error || '云端 OCR 失败。' }],
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
}

function resolveProviderConfig(provider, config = {}) {
  return config.providers?.[provider.id] || config[provider.id] || config || {};
}

module.exports = [
  createCloudProvider({ id: 'custom_ocr', name: '通用 HTTP OCR', type: 'cloud_ocr' }),
  createCloudProvider({ id: 'cloud_ocr', name: '联网 OCR', type: 'cloud_ocr' }),
  createCloudProvider({ id: 'cloud_ai', name: '云端 AI 识图', type: 'cloud_ai' })
];
