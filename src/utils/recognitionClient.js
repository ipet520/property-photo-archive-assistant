import { parseRecognitionText as parseLocally } from './recognitionResultParser.js';
import { normalizeRecognitionResult } from './recognitionTypes.js';

function getRecognitionApi() {
  return window.archiveAssistant?.recognition || null;
}

export async function getRecognitionStatus() {
  try {
    const api = getRecognitionApi();
    if (!api?.getStatus) return createUnavailableStatus();
    return await api.getStatus();
  } catch (error) {
    return createUnavailableStatus(error);
  }
}

export async function getRecognitionProviders() {
  try {
    const api = getRecognitionApi();
    return api?.getProviders ? await api.getProviders() : [];
  } catch {
    return [];
  }
}

export async function getRecognitionConfig() {
  try {
    const api = getRecognitionApi();
    return api?.getConfig ? await api.getConfig() : { defaultMode: 'disabled', providerTypes: [] };
  } catch {
    return { defaultMode: 'disabled', providerTypes: [] };
  }
}

export async function recognizePhotos(photos = [], options = {}) {
  try {
    const api = getRecognitionApi();
    if (!api?.recognizePhotos) return photos.map((photo) => createUnavailableResult(photo, options));
    const results = await api.recognizePhotos(photos, options);
    return (Array.isArray(results) ? results : []).map(normalizeRecognitionResult);
  } catch (error) {
    return photos.map((photo) => createUnavailableResult(photo, {
      ...options,
      errorMessage: error.message || '识别服务调用失败。'
    }));
  }
}

export async function parseRecognitionText(rawText = '', options = {}) {
  try {
    const api = getRecognitionApi();
    if (api?.parseText) return normalizeRecognitionResult(await api.parseText(rawText, options));
    return parseLocally(rawText, options);
  } catch (error) {
    return normalizeRecognitionResult({
      source: 'system',
      providerId: options.providerId || '',
      providerType: options.providerType || '',
      rawText,
      status: 'failed',
      warnings: ['识别文本解析失败，未修改照片或台账。'],
      errors: [{ code: 'parse_failed', message: error.message || '识别文本解析失败。' }],
      createdAt: new Date().toISOString()
    });
  }
}

function createUnavailableStatus(error = null) {
  return {
    success: false,
    serviceStatus: 'unavailable',
    engineStatus: error ? 'error' : 'not_configured',
    currentMode: 'disabled',
    status: error ? 'error' : 'not_configured',
    reason: error?.message || '识别服务底座不可用。',
    message: '识别服务底座不可用。',
    currentProcessing: '手动填写归档信息',
    providers: [],
    errors: error ? [{ code: 'recognition_client_error', message: error.message || '识别服务调用失败。' }] : []
  };
}

function createUnavailableResult(photo = {}, options = {}) {
  return normalizeRecognitionResult({
    photoId: photo.id || '',
    filePath: photo.originalPath || photo.path || '',
    source: 'system',
    providerId: options.providerId || '',
    providerType: options.providerType || '',
    rawText: '',
    parsedFields: {},
    confidence: null,
    status: 'provider_unavailable',
    warnings: ['当前仅可手动填写归档信息。'],
    errors: [{ code: 'provider_unavailable', message: options.errorMessage || '识别服务底座不可用。' }],
    createdAt: new Date().toISOString()
  });
}
