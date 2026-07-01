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
    return api?.getConfig ? await api.getConfig() : createUnavailableConfig();
  } catch {
    return createUnavailableConfig();
  }
}

export async function getSafeRecognitionConfig() {
  try {
    const api = getRecognitionApi();
    return api?.getSafeConfig ? await api.getSafeConfig() : createUnavailableConfig();
  } catch {
    return createUnavailableConfig();
  }
}

export async function updateRecognitionConfig(patch = {}) {
  try {
    const api = getRecognitionApi();
    if (!api?.updateConfig) return createUnavailableConfig(new Error('识别配置更新接口不可用。'));
    return await api.updateConfig(patch);
  } catch (error) {
    return createUnavailableConfig(error);
  }
}

export async function diagnoseRecognitionConfig() {
  try {
    const api = getRecognitionApi();
    if (!api?.diagnoseConfig) {
      return {
        ...createUnavailableConfig(new Error('识别配置诊断接口不可用。')),
        providers: {}
      };
    }
    return await api.diagnoseConfig();
  } catch (error) {
    return {
      ...createUnavailableConfig(error),
      providers: {}
    };
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

export async function recognizePhoto(photo = {}, options = {}) {
  try {
    const api = getRecognitionApi();
    if (!api?.recognizePhoto) return createUnavailableResult(photo, options);
    return normalizeRecognitionResult(await api.recognizePhoto(photo, options));
  } catch (error) {
    return createUnavailableResult(photo, {
      ...options,
      errorMessage: error.message || '识别服务调用失败。'
    });
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

function createUnavailableConfig(error = null) {
  return {
    success: false,
    config: {
      recognitionMode: 'disabled',
      activeProviderId: '',
      providers: {}
    },
    warnings: ['识别配置不可用，已使用安全默认配置。'],
    errors: error ? [{ code: 'recognition_config_client_error', message: error.message || '识别配置调用失败。' }] : []
  };
}

function createUnavailableResult(photo = {}, options = {}) {
  return normalizeRecognitionResult({
    photoId: photo.id || '',
    filePath: photo.originalPath || photo.path || '',
    fileName: photo.fileName || photo.name || '',
    taskId: options.taskId || '',
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
