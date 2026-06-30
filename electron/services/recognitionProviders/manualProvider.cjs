const MANUAL_PROVIDER = {
  id: 'manual',
  name: '人工校正',
  type: 'manual',
  mode: 'manual',
  getStatus() {
    return {
      providerId: this.id,
      status: 'available',
      message: '人工校正结果结构已预留。',
      enabled: true,
      requiresUserConsent: false
    };
  },
  async recognizePhoto(photo = {}, options = {}) {
    return normalizeManualResult(photo, options.manualResult || {});
  },
  async recognizePhotos(photos = [], options = {}) {
    return photos.map((photo) => normalizeManualResult(photo, options.manualResults?.[photo.id] || {}));
  }
};

function normalizeManualResult(photo = {}, manualResult = {}) {
  const now = new Date().toISOString();
  return {
    photoId: photo.id || photo.photoId || manualResult.photoId || '',
    filePath: photo.originalPath || photo.filePath || photo.path || manualResult.filePath || '',
    source: 'manual',
    providerId: 'manual',
    mode: 'manual',
    rawText: '',
    cleanedText: '',
    fields: {
      dateTime: manualResult.fields?.dateTime || '',
      date: manualResult.fields?.date || '',
      time: manualResult.fields?.time || '',
      location: manualResult.fields?.location || '',
      project: manualResult.fields?.project || '',
      workContent: manualResult.fields?.workContent || '',
      categoryHint: manualResult.fields?.categoryHint || '',
      keywords: Array.isArray(manualResult.fields?.keywords) ? manualResult.fields.keywords : [],
      remark: manualResult.fields?.remark || '',
      possibleStage: manualResult.fields?.possibleStage || '',
      possibleStatus: manualResult.fields?.possibleStatus || ''
    },
    confidence: null,
    status: manualResult.fields ? 'corrected' : 'pending',
    errorCode: '',
    errorMessage: '',
    warnings: [],
    updatedAt: now
  };
}

module.exports = MANUAL_PROVIDER;
