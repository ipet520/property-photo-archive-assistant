import { parseRecognitionText as parseLocally } from './recognitionResultParser.js';
import {
  normalizeRecognitionCandidateFieldSet,
  normalizeRecognitionFormPatchDraft,
  normalizeRecognitionFormPatchValidationResult,
  normalizeRecognitionResult,
  normalizeRecognitionReviewDecision,
  normalizeRecognitionReviewDraft,
  normalizeRecognitionStagedResult
} from './recognitionTypes.js';

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

export async function getStagedResult(id = '') {
  try {
    const api = getRecognitionApi();
    const result = api?.getStagedResult ? await api.getStagedResult(id) : null;
    return result ? normalizeRecognitionStagedResult(result) : null;
  } catch {
    return null;
  }
}

export async function getStagedResultByTaskId(taskId = '') {
  try {
    const api = getRecognitionApi();
    const result = api?.getStagedResultByTaskId ? await api.getStagedResultByTaskId(taskId) : null;
    return result ? normalizeRecognitionStagedResult(result) : null;
  } catch {
    return null;
  }
}

export async function getStagedResultByPhoto(photoInput = {}) {
  try {
    const api = getRecognitionApi();
    const result = api?.getStagedResultByPhoto ? await api.getStagedResultByPhoto(photoInput) : null;
    return result ? normalizeRecognitionStagedResult(result) : null;
  } catch {
    return null;
  }
}

export async function listStagedResults(options = {}) {
  try {
    const api = getRecognitionApi();
    const results = api?.listStagedResults ? await api.listStagedResults(options) : [];
    return (Array.isArray(results) ? results : []).map(normalizeRecognitionStagedResult);
  } catch {
    return [];
  }
}

export async function updateStagedResultStatus(id = '', stageStatus = 'staged') {
  try {
    const api = getRecognitionApi();
    const result = api?.updateStagedResultStatus ? await api.updateStagedResultStatus(id, stageStatus) : null;
    return result ? normalizeRecognitionStagedResult(result) : null;
  } catch {
    return null;
  }
}

export async function clearStagedResult(id = '') {
  try {
    const api = getRecognitionApi();
    return api?.clearStagedResult ? Boolean(await api.clearStagedResult(id)) : false;
  } catch {
    return false;
  }
}

export async function clearStagedResultsByPhoto(photoInput = {}) {
  try {
    const api = getRecognitionApi();
    const count = api?.clearStagedResultsByPhoto ? await api.clearStagedResultsByPhoto(photoInput) : 0;
    return Number.isFinite(Number(count)) ? Number(count) : 0;
  } catch {
    return 0;
  }
}

export async function clearAllStagedResults() {
  try {
    const api = getRecognitionApi();
    const count = api?.clearAllStagedResults ? await api.clearAllStagedResults() : 0;
    return Number.isFinite(Number(count)) ? Number(count) : 0;
  } catch {
    return 0;
  }
}

export async function getFieldMappingRules() {
  try {
    const api = getRecognitionApi();
    return api?.getFieldMappingRules ? await api.getFieldMappingRules() : [];
  } catch {
    return [];
  }
}

export async function buildCandidateFieldSet(stagedResultId = '') {
  try {
    const api = getRecognitionApi();
    const result = api?.buildCandidateFieldSet ? await api.buildCandidateFieldSet(stagedResultId) : null;
    return result ? normalizeRecognitionCandidateFieldSet(result) : null;
  } catch {
    return null;
  }
}

export async function getCandidateFieldSet(id = '') {
  try {
    const api = getRecognitionApi();
    const result = api?.getCandidateFieldSet ? await api.getCandidateFieldSet(id) : null;
    return result ? normalizeRecognitionCandidateFieldSet(result) : null;
  } catch {
    return null;
  }
}

export async function getCandidateFieldSetByStagedResult(stagedResultId = '') {
  try {
    const api = getRecognitionApi();
    const result = api?.getCandidateFieldSetByStagedResult ? await api.getCandidateFieldSetByStagedResult(stagedResultId) : null;
    return result ? normalizeRecognitionCandidateFieldSet(result) : null;
  } catch {
    return null;
  }
}

export async function getCandidateFieldSetByPhoto(photoInput = {}) {
  try {
    const api = getRecognitionApi();
    const result = api?.getCandidateFieldSetByPhoto ? await api.getCandidateFieldSetByPhoto(photoInput) : null;
    return result ? normalizeRecognitionCandidateFieldSet(result) : null;
  } catch {
    return null;
  }
}

export async function listCandidateFieldSets(options = {}) {
  try {
    const api = getRecognitionApi();
    const results = api?.listCandidateFieldSets ? await api.listCandidateFieldSets(options) : [];
    return (Array.isArray(results) ? results : []).map(normalizeRecognitionCandidateFieldSet);
  } catch {
    return [];
  }
}

export async function clearCandidateFieldSet(id = '') {
  try {
    const api = getRecognitionApi();
    return api?.clearCandidateFieldSet ? Boolean(await api.clearCandidateFieldSet(id)) : false;
  } catch {
    return false;
  }
}

export async function clearCandidateFieldSetsByPhoto(photoInput = {}) {
  try {
    const api = getRecognitionApi();
    const count = api?.clearCandidateFieldSetsByPhoto ? await api.clearCandidateFieldSetsByPhoto(photoInput) : 0;
    return Number.isFinite(Number(count)) ? Number(count) : 0;
  } catch {
    return 0;
  }
}

export async function clearAllCandidateFieldSets() {
  try {
    const api = getRecognitionApi();
    const count = api?.clearAllCandidateFieldSets ? await api.clearAllCandidateFieldSets() : 0;
    return Number.isFinite(Number(count)) ? Number(count) : 0;
  } catch {
    return 0;
  }
}

export async function createReviewDraft(stagedResultId = '') {
  try {
    const api = getRecognitionApi();
    const result = api?.createReviewDraft ? await api.createReviewDraft(stagedResultId) : null;
    return result ? normalizeRecognitionReviewDraft(result) : null;
  } catch {
    return null;
  }
}

export async function getReviewDraft(id = '') {
  try {
    const api = getRecognitionApi();
    const result = api?.getReviewDraft ? await api.getReviewDraft(id) : null;
    return result ? normalizeRecognitionReviewDraft(result) : null;
  } catch {
    return null;
  }
}

export async function getReviewDraftByStagedResult(stagedResultId = '') {
  try {
    const api = getRecognitionApi();
    const result = api?.getReviewDraftByStagedResult ? await api.getReviewDraftByStagedResult(stagedResultId) : null;
    return result ? normalizeRecognitionReviewDraft(result) : null;
  } catch {
    return null;
  }
}

export async function getReviewDraftByPhoto(photoInput = {}) {
  try {
    const api = getRecognitionApi();
    const result = api?.getReviewDraftByPhoto ? await api.getReviewDraftByPhoto(photoInput) : null;
    return result ? normalizeRecognitionReviewDraft(result) : null;
  } catch {
    return null;
  }
}

export async function listReviewDrafts(options = {}) {
  try {
    const api = getRecognitionApi();
    const results = api?.listReviewDrafts ? await api.listReviewDrafts(options) : [];
    return (Array.isArray(results) ? results : []).map(normalizeRecognitionReviewDraft);
  } catch {
    return [];
  }
}

export async function updateReviewDraftStatus(id = '', status = 'pending_review') {
  try {
    const api = getRecognitionApi();
    const result = api?.updateReviewDraftStatus ? await api.updateReviewDraftStatus(id, status) : null;
    return result ? normalizeRecognitionReviewDraft(result) : null;
  } catch {
    return null;
  }
}

export async function clearReviewDraft(id = '') {
  try {
    const api = getRecognitionApi();
    return api?.clearReviewDraft ? Boolean(await api.clearReviewDraft(id)) : false;
  } catch {
    return false;
  }
}

export async function clearReviewDraftsByPhoto(photoInput = {}) {
  try {
    const api = getRecognitionApi();
    const count = api?.clearReviewDraftsByPhoto ? await api.clearReviewDraftsByPhoto(photoInput) : 0;
    return Number.isFinite(Number(count)) ? Number(count) : 0;
  } catch {
    return 0;
  }
}

export async function clearAllReviewDrafts() {
  try {
    const api = getRecognitionApi();
    const count = api?.clearAllReviewDrafts ? await api.clearAllReviewDrafts() : 0;
    return Number.isFinite(Number(count)) ? Number(count) : 0;
  } catch {
    return 0;
  }
}

export async function createReviewDecision(input = {}) {
  try {
    const api = getRecognitionApi();
    const result = api?.createReviewDecision ? await api.createReviewDecision(input) : null;
    return result ? normalizeRecognitionReviewDecision(result) : null;
  } catch {
    return null;
  }
}

export async function getReviewDecision(id = '') {
  try {
    const api = getRecognitionApi();
    const result = api?.getReviewDecision ? await api.getReviewDecision(id) : null;
    return result ? normalizeRecognitionReviewDecision(result) : null;
  } catch {
    return null;
  }
}

export async function getReviewDecisionByReviewDraft(reviewDraftId = '') {
  try {
    const api = getRecognitionApi();
    const result = api?.getReviewDecisionByReviewDraft ? await api.getReviewDecisionByReviewDraft(reviewDraftId) : null;
    return result ? normalizeRecognitionReviewDecision(result) : null;
  } catch {
    return null;
  }
}

export async function getReviewDecisionByPhoto(photoInput = {}) {
  try {
    const api = getRecognitionApi();
    const result = api?.getReviewDecisionByPhoto ? await api.getReviewDecisionByPhoto(photoInput) : null;
    return result ? normalizeRecognitionReviewDecision(result) : null;
  } catch {
    return null;
  }
}

export async function getRecognitionReadOnlyBundleByPhoto(photoInput = {}) {
  const emptyBundle = createEmptyReadOnlyBundle();
  try {
    const [stagedResult, candidateFieldSet, reviewDraft, reviewDecision, formPatchDraft] = await Promise.allSettled([
      getStagedResultByPhoto(photoInput),
      getCandidateFieldSetByPhoto(photoInput),
      getReviewDraftByPhoto(photoInput),
      getReviewDecisionByPhoto(photoInput),
      getFormPatchDraftByPhoto(photoInput)
    ]);
    return {
      stagedResult: settledValue(stagedResult, null),
      candidateFieldSet: settledValue(candidateFieldSet, null),
      reviewDraft: settledValue(reviewDraft, null),
      reviewDecision: settledValue(reviewDecision, null),
      formPatchDraft: settledValue(formPatchDraft, null),
      warnings: [
        ...settledWarning(stagedResult, '识别暂存状态读取失败。'),
        ...settledWarning(candidateFieldSet, '候选字段读取失败。'),
        ...settledWarning(reviewDraft, '人工确认草稿读取失败。'),
        ...settledWarning(reviewDecision, '人工确认决策读取失败。'),
        ...settledWarning(formPatchDraft, '表单补丁草稿读取失败。')
      ],
      errors: []
    };
  } catch (error) {
    return {
      ...emptyBundle,
      errors: [{ code: 'recognition_readonly_bundle_error', message: error.message || '识别确认信息读取失败。' }]
    };
  }
}

export async function listReviewDecisions(options = {}) {
  try {
    const api = getRecognitionApi();
    const results = api?.listReviewDecisions ? await api.listReviewDecisions(options) : [];
    return (Array.isArray(results) ? results : []).map(normalizeRecognitionReviewDecision);
  } catch {
    return [];
  }
}

export async function clearReviewDecision(id = '') {
  try {
    const api = getRecognitionApi();
    return api?.clearReviewDecision ? Boolean(await api.clearReviewDecision(id)) : false;
  } catch {
    return false;
  }
}

export async function clearReviewDecisionsByPhoto(photoInput = {}) {
  try {
    const api = getRecognitionApi();
    const count = api?.clearReviewDecisionsByPhoto ? await api.clearReviewDecisionsByPhoto(photoInput) : 0;
    return Number.isFinite(Number(count)) ? Number(count) : 0;
  } catch {
    return 0;
  }
}

export async function clearAllReviewDecisions() {
  try {
    const api = getRecognitionApi();
    const count = api?.clearAllReviewDecisions ? await api.clearAllReviewDecisions() : 0;
    return Number.isFinite(Number(count)) ? Number(count) : 0;
  } catch {
    return 0;
  }
}

export async function buildFormPatchDraft(input = {}) {
  try {
    const api = getRecognitionApi();
    const result = api?.buildFormPatchDraft ? await api.buildFormPatchDraft(input) : null;
    return result ? normalizeRecognitionFormPatchDraft(result) : null;
  } catch {
    return null;
  }
}

export async function validateFormPatchDraft(patchDraftId = '') {
  try {
    const api = getRecognitionApi();
    const result = api?.validateFormPatchDraft ? await api.validateFormPatchDraft(patchDraftId) : createPatchValidationFallback(patchDraftId);
    return normalizeRecognitionFormPatchValidationResult(result);
  } catch (error) {
    return createPatchValidationFallback(patchDraftId, error);
  }
}

export async function getFormPatchDraft(id = '') {
  try {
    const api = getRecognitionApi();
    const result = api?.getFormPatchDraft ? await api.getFormPatchDraft(id) : null;
    return result ? normalizeRecognitionFormPatchDraft(result) : null;
  } catch {
    return null;
  }
}

export async function getFormPatchDraftByReviewDecision(reviewDecisionId = '') {
  try {
    const api = getRecognitionApi();
    const result = api?.getFormPatchDraftByReviewDecision ? await api.getFormPatchDraftByReviewDecision(reviewDecisionId) : null;
    return result ? normalizeRecognitionFormPatchDraft(result) : null;
  } catch {
    return null;
  }
}

export async function getFormPatchDraftByPhoto(photoInput = {}) {
  try {
    const api = getRecognitionApi();
    const result = api?.getFormPatchDraftByPhoto ? await api.getFormPatchDraftByPhoto(photoInput) : null;
    return result ? normalizeRecognitionFormPatchDraft(result) : null;
  } catch {
    return null;
  }
}

export async function listFormPatchDrafts(options = {}) {
  try {
    const api = getRecognitionApi();
    const results = api?.listFormPatchDrafts ? await api.listFormPatchDrafts(options) : [];
    return (Array.isArray(results) ? results : []).map(normalizeRecognitionFormPatchDraft);
  } catch {
    return [];
  }
}

export async function updateFormPatchDraftStatus(id = '', status = 'draft') {
  try {
    const api = getRecognitionApi();
    const result = api?.updateFormPatchDraftStatus ? await api.updateFormPatchDraftStatus(id, status) : null;
    return result ? normalizeRecognitionFormPatchDraft(result) : null;
  } catch {
    return null;
  }
}

export async function clearFormPatchDraft(id = '') {
  try {
    const api = getRecognitionApi();
    return api?.clearFormPatchDraft ? Boolean(await api.clearFormPatchDraft(id)) : false;
  } catch {
    return false;
  }
}

export async function clearFormPatchDraftsByPhoto(photoInput = {}) {
  try {
    const api = getRecognitionApi();
    const count = api?.clearFormPatchDraftsByPhoto ? await api.clearFormPatchDraftsByPhoto(photoInput) : 0;
    return Number.isFinite(Number(count)) ? Number(count) : 0;
  } catch {
    return 0;
  }
}

export async function clearAllFormPatchDrafts() {
  try {
    const api = getRecognitionApi();
    const count = api?.clearAllFormPatchDrafts ? await api.clearAllFormPatchDrafts() : 0;
    return Number.isFinite(Number(count)) ? Number(count) : 0;
  } catch {
    return 0;
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

function createPatchValidationFallback(patchDraftId = '', error = null) {
  return normalizeRecognitionFormPatchValidationResult({
    ok: false,
    patchDraftId,
    validPatches: [],
    invalidPatches: [],
    conflictPatches: [],
    warnings: [],
    errors: [{
      code: 'patch_validation_unavailable',
      message: error?.message || '表单补丁校验接口不可用。'
    }],
    checkedAt: new Date().toISOString(),
    schemaVersion: 1
  });
}

function createEmptyReadOnlyBundle() {
  return {
    stagedResult: null,
    candidateFieldSet: null,
    reviewDraft: null,
    reviewDecision: null,
    formPatchDraft: null,
    warnings: [],
    errors: []
  };
}

function settledValue(result, fallback) {
  return result.status === 'fulfilled' ? result.value : fallback;
}

function settledWarning(result, message) {
  return result.status === 'rejected' ? [message] : [];
}
