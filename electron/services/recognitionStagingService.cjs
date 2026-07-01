const fs = require('node:fs/promises');
const path = require('node:path');

const STAGING_FILE_NAME = 'recognition-staged-results.json';
const STAGING_SCHEMA_VERSION = 1;
const MAX_STAGED_RESULTS = 1000;
const STAGE_STATUSES = new Set([
  'staged',
  'pending_review',
  'reviewed',
  'dismissed',
  'cleared',
  'expired'
]);

function getRecognitionStagingPath(userDataDir) {
  return path.join(String(userDataDir || ''), STAGING_FILE_NAME);
}

async function stageRecognitionResult(userDataDir, result = {}) {
  try {
    const stagedResults = await readStagedResults(userDataDir);
    const stagedResult = createRecognitionStagedResult(result);
    const nextResults = limitResults([stagedResult, ...stagedResults]);
    await writeStagedResults(userDataDir, nextResults);
    logInfo('stage result created', stagedResult);
    return stagedResult;
  } catch (error) {
    logError('storage write failed', error);
    return null;
  }
}

async function getStagedRecognitionResult(userDataDir, id = '') {
  try {
    const stagedResults = await readStagedResults(userDataDir);
    return stagedResults.find((item) => item.id === String(id || '')) || null;
  } catch (error) {
    logError('staged result loaded failed', error);
    return null;
  }
}

async function getStagedRecognitionResultByTaskId(userDataDir, taskId = '') {
  try {
    const stagedResults = await readStagedResults(userDataDir);
    return stagedResults.find((item) => item.taskId === String(taskId || '')) || null;
  } catch (error) {
    logError('staged result loaded failed', error);
    return null;
  }
}

async function getStagedRecognitionResultByPhoto(userDataDir, photoInput = {}) {
  try {
    const stagedResults = await readStagedResults(userDataDir);
    const photoId = String(photoInput?.photoId || '');
    const filePath = normalizePath(photoInput?.filePath || '');
    return stagedResults.find((item) => (
      (photoId && item.photoId === photoId)
      || (filePath && normalizePath(item.filePath) === filePath)
    )) || null;
  } catch (error) {
    logError('staged result loaded failed', error);
    return null;
  }
}

async function listStagedRecognitionResults(userDataDir, options = {}) {
  try {
    const stagedResults = await readStagedResults(userDataDir);
    const stageStatus = String(options?.stageStatus || '');
    const limit = normalizeLimit(options?.limit);
    return stagedResults
      .filter((item) => !stageStatus || item.stageStatus === stageStatus)
      .slice(0, limit);
  } catch (error) {
    logError('staged result loaded failed', error);
    return [];
  }
}

async function updateStagedRecognitionStatus(userDataDir, id = '', stageStatus = 'staged') {
  try {
    const normalizedStatus = normalizeStageStatus(stageStatus);
    const stagedResults = await readStagedResults(userDataDir);
    let updatedResult = null;
    const updatedAt = new Date().toISOString();
    const nextResults = stagedResults.map((item) => {
      if (item.id !== String(id || '')) return item;
      updatedResult = {
        ...item,
        stageStatus: normalizedStatus,
        updatedAt,
        reviewedAt: ['reviewed', 'dismissed'].includes(normalizedStatus) ? updatedAt : item.reviewedAt,
        clearedAt: normalizedStatus === 'cleared' ? updatedAt : item.clearedAt
      };
      return updatedResult;
    });
    if (!updatedResult) return null;
    await writeStagedResults(userDataDir, nextResults);
    return updatedResult;
  } catch (error) {
    logError('staged status update failed', error);
    return null;
  }
}

async function clearStagedRecognitionResult(userDataDir, id = '') {
  try {
    const stagedResults = await readStagedResults(userDataDir);
    const nextResults = stagedResults.filter((item) => item.id !== String(id || ''));
    if (nextResults.length === stagedResults.length) return false;
    await writeStagedResults(userDataDir, nextResults);
    logInfo('staged result cleared', { id });
    return true;
  } catch (error) {
    logError('staged result clear failed', error);
    return false;
  }
}

async function clearStagedRecognitionResultsByPhoto(userDataDir, photoInput = {}) {
  try {
    const photoId = String(photoInput?.photoId || '');
    const filePath = normalizePath(photoInput?.filePath || '');
    const stagedResults = await readStagedResults(userDataDir);
    const nextResults = stagedResults.filter((item) => !(
      (photoId && item.photoId === photoId)
      || (filePath && normalizePath(item.filePath) === filePath)
    ));
    const clearedCount = stagedResults.length - nextResults.length;
    if (clearedCount > 0) await writeStagedResults(userDataDir, nextResults);
    return clearedCount;
  } catch (error) {
    logError('staged result clear by photo failed', error);
    return 0;
  }
}

async function clearAllStagedRecognitionResults(userDataDir) {
  try {
    const stagedResults = await readStagedResults(userDataDir);
    if (stagedResults.length === 0) return 0;
    await writeStagedResults(userDataDir, []);
    logInfo('staged result cleared', { count: stagedResults.length });
    return stagedResults.length;
  } catch (error) {
    logError('all staged result clear failed', error);
    return 0;
  }
}

function createRecognitionStagedResult(result = {}) {
  const now = new Date().toISOString();
  const filePath = String(result.filePath || result.path || result.originalPath || '');
  const fileName = String(result.fileName || result.name || path.basename(filePath) || '');
  return {
    id: createStagedResultId(result, now),
    taskId: String(result.taskId || result.task?.taskId || ''),
    photoId: String(result.photoId || result.task?.photoId || ''),
    filePath,
    fileName,
    providerId: String(result.providerId || ''),
    providerKey: String(result.providerKey || result.providerId || ''),
    providerType: String(result.providerType || ''),
    recognitionStatus: String(result.status || 'pending'),
    stageStatus: 'staged',
    rawText: String(result.rawText || ''),
    parsedFields: clonePlainObject(result.parsedFields || result.fields || {}),
    proposedFields: {},
    confidence: Number.isFinite(Number(result.confidence)) ? Number(result.confidence) : null,
    warnings: normalizeStringArray(result.warnings),
    errors: normalizeErrors(result.errors, result.errorCode, result.errorMessage),
    message: String(result.message || result.reason || ''),
    source: 'recognition_pipeline',
    createdAt: now,
    updatedAt: now,
    reviewedAt: '',
    clearedAt: '',
    schemaVersion: STAGING_SCHEMA_VERSION
  };
}

async function readStagedResults(userDataDir) {
  const stagingPath = getRecognitionStagingPath(userDataDir);
  try {
    const content = await fs.readFile(stagingPath, 'utf-8');
    const parsed = JSON.parse(content);
    const rawResults = Array.isArray(parsed) ? parsed : parsed.results;
    if (!Array.isArray(rawResults)) return [];
    return rawResults.map(normalizeStagedResult).filter(Boolean).sort(sortByCreatedDesc);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    logError('storage read failed', error);
    return [];
  }
}

async function writeStagedResults(userDataDir, results = []) {
  const stagingPath = getRecognitionStagingPath(userDataDir);
  await fs.mkdir(path.dirname(stagingPath), { recursive: true });
  await fs.writeFile(stagingPath, JSON.stringify(limitResults(results), null, 2), 'utf-8');
}

function normalizeStagedResult(result = {}) {
  if (!result || typeof result !== 'object') return null;
  const createdAt = String(result.createdAt || new Date().toISOString());
  const updatedAt = String(result.updatedAt || createdAt);
  return {
    id: String(result.id || createStagedResultId(result, createdAt)),
    taskId: String(result.taskId || ''),
    photoId: String(result.photoId || ''),
    filePath: String(result.filePath || ''),
    fileName: String(result.fileName || path.basename(String(result.filePath || '')) || ''),
    providerId: String(result.providerId || ''),
    providerKey: String(result.providerKey || result.providerId || ''),
    providerType: String(result.providerType || ''),
    recognitionStatus: String(result.recognitionStatus || result.status || 'pending'),
    stageStatus: normalizeStageStatus(result.stageStatus),
    rawText: String(result.rawText || ''),
    parsedFields: clonePlainObject(result.parsedFields || {}),
    proposedFields: clonePlainObject(result.proposedFields || {}),
    confidence: Number.isFinite(Number(result.confidence)) ? Number(result.confidence) : null,
    warnings: normalizeStringArray(result.warnings),
    errors: normalizeErrors(result.errors),
    message: String(result.message || ''),
    source: 'recognition_pipeline',
    createdAt,
    updatedAt,
    reviewedAt: String(result.reviewedAt || ''),
    clearedAt: String(result.clearedAt || ''),
    schemaVersion: STAGING_SCHEMA_VERSION
  };
}

function normalizeStageStatus(stageStatus = '') {
  const value = String(stageStatus || '').trim();
  return STAGE_STATUSES.has(value) ? value : 'staged';
}

function limitResults(results = []) {
  return results.map(normalizeStagedResult).filter(Boolean).sort(sortByCreatedDesc).slice(0, MAX_STAGED_RESULTS);
}

function sortByCreatedDesc(a, b) {
  return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
}

function normalizeLimit(limit) {
  const value = Number(limit);
  if (!Number.isFinite(value) || value <= 0) return MAX_STAGED_RESULTS;
  return Math.min(Math.floor(value), MAX_STAGED_RESULTS);
}

function createStagedResultId(result = {}, createdAt = new Date().toISOString()) {
  const seed = `${result.taskId || result.task?.taskId || result.photoId || result.fileName || 'recognition'}-${createdAt}-${Math.random().toString(16).slice(2)}`;
  return `stage_${seed.replace(/[^a-zA-Z0-9_-]+/g, '_')}`;
}

function normalizeStringArray(values = []) {
  return Array.from(new Set((Array.isArray(values) ? values : [values])
    .map((item) => String(item || '').trim())
    .filter(Boolean)));
}

function normalizeErrors(errors, errorCode = '', errorMessage = '') {
  const normalized = Array.isArray(errors)
    ? errors.map((error) => {
      if (!error) return null;
      if (typeof error === 'string') return { code: 'recognition_staging_error', message: error };
      return {
        code: String(error.code || error.errorCode || 'recognition_staging_error'),
        message: String(error.message || error.errorMessage || '')
      };
    }).filter((error) => error?.message)
    : [];
  if (normalized.length > 0) return normalized;
  if (errorCode || errorMessage) {
    return [{ code: String(errorCode || 'recognition_staging_error'), message: String(errorMessage || '识别暂存结果异常。') }];
  }
  return [];
}

function clonePlainObject(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return {};
  }
}

function normalizePath(value = '') {
  return String(value || '').trim().toLowerCase();
}

function logInfo(message, payload = {}) {
  const summary = payload.id ? ` id=${payload.id}` : (payload.count ? ` count=${payload.count}` : '');
  console.info(`[recognition-staging] ${message}${summary}`);
}

function logError(message, error = {}) {
  console.warn(`[recognition-staging] ${message}: ${error.message || 'unknown error'}`);
}

module.exports = {
  STAGING_FILE_NAME,
  STAGING_SCHEMA_VERSION,
  getRecognitionStagingPath,
  createRecognitionStagedResult,
  stageRecognitionResult,
  getStagedRecognitionResult,
  getStagedRecognitionResultByTaskId,
  getStagedRecognitionResultByPhoto,
  listStagedRecognitionResults,
  updateStagedRecognitionStatus,
  clearStagedRecognitionResult,
  clearStagedRecognitionResultsByPhoto,
  clearAllStagedRecognitionResults
};
