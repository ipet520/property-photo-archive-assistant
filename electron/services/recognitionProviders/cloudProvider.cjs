const { createProviderStatus, createUnavailableResult } = require('./providerUtils.cjs');

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
    diagnose() {
      return createProviderStatus(this, {
        enabled: false,
        available: false,
        status: 'disabled',
        reason: this.reason,
        message: this.reason,
        capabilities: this.capabilities,
        requiresUserConsent: true,
        config: this.config
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
        status: 'disabled',
        code: `${id}_disabled`,
        reason: '联网识别 provider 尚未配置，未发起任何网络请求。',
        warnings: ['当前版本不上传照片、不调用远程识别服务。']
      });
    },
    async recognizePhoto(photo = {}) {
      return this.recognize(photo);
    },
    async recognizePhotos(photos = []) {
      return (Array.isArray(photos) ? photos : []).map((photo) => this.recognize(photo));
    }
  };
}

module.exports = [
  createCloudProvider({ id: 'cloud_ocr', name: '联网 OCR', type: 'cloud_ocr' }),
  createCloudProvider({ id: 'cloud_ai', name: '云端 AI 识图', type: 'cloud_ai' })
];
