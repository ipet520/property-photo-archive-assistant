export const RECOGNITION_SOURCES = ['local_ocr', 'cloud_ocr', 'cloud_ai', 'manual'];

export const RECOGNITION_STATUSES = ['pending', 'recognized', 'weak', 'failed', 'corrected'];

export const RECOGNITION_MODES = ['local', 'cloud', 'hybrid', 'manual'];

export const RECOGNITION_PROVIDERS = ['none', 'local_engine', 'cloud_provider'];

export function createEmptyRecognitionResult(photo = {}) {
  return {
    photoId: photo.id || '',
    filePath: photo.originalPath || photo.path || '',
    source: 'manual',
    rawText: '',
    cleanedText: '',
    fields: {
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
    },
    confidence: 0,
    status: 'pending',
    errorMessage: '',
    updatedAt: ''
  };
}
