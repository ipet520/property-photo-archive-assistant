const { createProviderStatus, createUnavailableResult } = require('./providerUtils.cjs');

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
  diagnose() {
    return createProviderStatus(this, {
      enabled: false,
      available: false,
      status: 'not_configured',
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
  async recognize(photo = {}) {
    return createUnavailableResult(photo, this, {
      status: 'not_configured',
      code: 'local_ocr_not_configured',
      reason: '本地 OCR provider 当前仅作为架构预留，不执行真实识别。',
      warnings: ['本地 OCR provider 当前仅作为架构预留，不返回假识别文本。']
    });
  },
  async recognizePhoto(photo = {}) {
    return this.recognize(photo);
  },
  async recognizePhotos(photos = []) {
    return (Array.isArray(photos) ? photos : []).map((photo) => this.recognize(photo));
  }
};

module.exports = LOCAL_PROVIDER;
