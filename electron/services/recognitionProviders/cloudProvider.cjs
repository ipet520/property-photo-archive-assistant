const CLOUD_PROVIDERS = [
  {
    id: 'cloud_ocr',
    name: '联网 OCR',
    type: 'cloud_ocr',
    mode: 'cloud',
    config: {
      endpoint: '',
      providerName: '',
      authType: '',
      enabled: false,
      requiresUserConsent: true
    }
  },
  {
    id: 'cloud_ai',
    name: '云端 AI 识图',
    type: 'cloud_ai',
    mode: 'cloud',
    config: {
      endpoint: '',
      providerName: '',
      authType: '',
      enabled: false,
      requiresUserConsent: true
    }
  }
].map((provider) => ({
  ...provider,
  getStatus() {
    return {
      providerId: this.id,
      status: 'disabled',
      message: '联网识别能力尚未配置，当前版本不会上传照片或调用远程服务。',
      enabled: false,
      requiresUserConsent: true,
      config: this.config
    };
  },
  async recognizePhoto(photo = {}, options = {}) {
    return createUnavailableResult(photo, options, this);
  },
  async recognizePhotos(photos = [], options = {}) {
    return photos.map((photo) => createUnavailableResult(photo, options, this));
  }
}));

function createUnavailableResult(photo = {}, options = {}, provider) {
  const now = new Date().toISOString();
  return {
    photoId: photo.id || photo.photoId || '',
    filePath: photo.originalPath || photo.filePath || photo.path || '',
    source: provider.type,
    providerId: provider.id,
    mode: provider.mode,
    rawText: '',
    cleanedText: '',
    fields: createEmptyFields(),
    confidence: null,
    status: 'provider_unavailable',
    errorCode: 'provider_unavailable',
    errorMessage: '联网识别 provider 尚未配置。',
    warnings: ['当前版本不上传照片、不调用远程识别服务。'],
    updatedAt: now,
    options: {
      requestedMode: options.mode || ''
    }
  };
}

function createEmptyFields() {
  return {
    dateTime: '',
    date: '',
    time: '',
    location: '',
    project: '',
    workContent: '',
    categoryHint: '',
    keywords: [],
    remark: '',
    possibleStage: '',
    possibleStatus: ''
  };
}

module.exports = CLOUD_PROVIDERS;
