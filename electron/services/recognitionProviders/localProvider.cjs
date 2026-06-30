const LOCAL_PROVIDER = {
  id: 'local_ocr',
  name: '本地 OCR',
  type: 'local_ocr',
  mode: 'local',
  getStatus() {
    return {
      providerId: this.id,
      status: 'not_configured',
      message: '本地 OCR 引擎尚未接入。',
      enabled: false,
      requiresUserConsent: false
    };
  },
  async recognizePhoto(photo = {}, options = {}) {
    return createUnavailableResult(photo, options, this);
  },
  async recognizePhotos(photos = [], options = {}) {
    return photos.map((photo) => createUnavailableResult(photo, options, this));
  }
};

function createUnavailableResult(photo = {}, options = {}, provider = LOCAL_PROVIDER) {
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
    errorMessage: '识别引擎尚未接入。',
    warnings: ['本地 OCR provider 当前仅作为架构预留，不执行真实识别。'],
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

module.exports = LOCAL_PROVIDER;
