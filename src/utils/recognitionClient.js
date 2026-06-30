import { parseRecognitionText as parseLocally } from './recognitionResultParser.js';

function getRecognitionApi() {
  return window.archiveAssistant?.recognition || null;
}

export async function getRecognitionStatus() {
  const api = getRecognitionApi();
  if (!api?.getStatus) {
    return {
      success: false,
      serviceStatus: 'unavailable',
      engineStatus: 'not_configured',
      message: '识别服务底座不可用。',
      currentProcessing: '手动填写归档信息',
      providers: []
    };
  }
  return api.getStatus();
}

export async function getRecognitionProviders() {
  const api = getRecognitionApi();
  return api?.getProviders ? api.getProviders() : [];
}

export async function recognizePhotos(photos = [], options = {}) {
  const api = getRecognitionApi();
  if (!api?.recognizePhotos) {
    return photos.map((photo) => ({
      photoId: photo.id || '',
      filePath: photo.originalPath || photo.path || '',
      source: 'system',
      providerId: '',
      mode: 'disabled',
      rawText: '',
      cleanedText: '',
      fields: {},
      confidence: null,
      status: 'provider_unavailable',
      errorCode: 'provider_unavailable',
      errorMessage: '识别服务底座不可用。',
      warnings: ['当前仅可手动填写归档信息。'],
      updatedAt: new Date().toISOString()
    }));
  }
  return api.recognizePhotos(photos, options);
}

export async function parseRecognitionText(rawText = '', options = {}) {
  const api = getRecognitionApi();
  if (api?.parseText) return api.parseText(rawText, options);
  return parseLocally(rawText, options);
}
