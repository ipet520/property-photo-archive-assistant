const { createProviderStatus, normalizeRecognitionResult } = require('./providerUtils.cjs');

const MANUAL_PROVIDER = {
  id: 'manual',
  name: '人工校正',
  type: 'manual',
  mode: 'manual',
  enabled: true,
  available: true,
  status: 'available',
  reason: '人工输入识别结果结构已预留，仅用于手动校正或调试占位。',
  capabilities: ['manual_input', 'status_diagnose'],
  diagnose() {
    return createProviderStatus(this, {
      enabled: true,
      available: true,
      status: 'available',
      reason: this.reason,
      message: this.reason,
      capabilities: this.capabilities,
      requiresUserConsent: false
    });
  },
  checkAvailability() {
    return this.diagnose();
  },
  getStatus() {
    return this.diagnose();
  },
  async recognize(photo = {}, options = {}) {
    return normalizeManualResult(photo, options.manualResult || {});
  },
  async recognizePhoto(photo = {}, options = {}) {
    return this.recognize(photo, options);
  },
  async recognizePhotos(photos = [], options = {}) {
    return (Array.isArray(photos) ? photos : []).map((photo) => this.recognize(photo, {
      manualResult: options.manualResults?.[photo.id] || {}
    }));
  }
};

function normalizeManualResult(photo = {}, manualResult = {}) {
  const hasFields = Boolean(manualResult.parsedFields || manualResult.fields);
  return normalizeRecognitionResult({
    photoId: photo.id || photo.photoId || manualResult.photoId || '',
    filePath: photo.originalPath || photo.filePath || photo.path || manualResult.filePath || '',
    source: 'manual',
    providerId: 'manual',
    providerType: 'manual',
    rawText: manualResult.rawText || '',
    parsedFields: manualResult.parsedFields || manualResult.fields || {},
    confidence: null,
    status: hasFields ? 'corrected' : 'pending',
    warnings: hasFields ? [] : ['尚未输入人工识别结果。'],
    errors: [],
    createdAt: new Date().toISOString()
  });
}

module.exports = MANUAL_PROVIDER;
