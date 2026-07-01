const fs = require('node:fs/promises');
const path = require('node:path');
const { getStagedRecognitionResult } = require('./recognitionStagingService.cjs');
const { buildCandidateFieldSetFromStagedResult } = require('./recognitionFieldMappingService.cjs');

const REVIEW_DRAFT_FILE_NAME = 'recognition-review-drafts.json';
const REVIEW_DRAFT_SCHEMA_VERSION = 1;
const MAX_REVIEW_DRAFTS = 1000;
const REVIEW_DRAFT_STATUSES = new Set([
  'pending_review',
  'reviewing',
  'accepted',
  'partially_accepted',
  'rejected',
  'dismissed',
  'cleared'
]);

async function createReviewDraftFromStagedResult(userDataDir, stagedResultId = '') {
  try {
    const stagedResult = await getStagedRecognitionResult(userDataDir, stagedResultId);
    if (!stagedResult) return null;
    const candidateFieldSet = await buildCandidateFieldSetFromStagedResult(userDataDir, stagedResult);
    return createReviewDraftFromCandidateFieldSet(userDataDir, candidateFieldSet);
  } catch (error) {
    logError('review draft create from staged failed', error);
    return null;
  }
}

async function createReviewDraftFromCandidateFieldSet(userDataDir, candidateFieldSet = {}) {
  try {
    const reviewDraft = createReviewDraft(candidateFieldSet);
    const drafts = await readReviewDrafts(userDataDir);
    const nextDrafts = limitDrafts([reviewDraft, ...drafts.filter((item) => item.candidateFieldSetId !== reviewDraft.candidateFieldSetId)]);
    await writeReviewDrafts(userDataDir, nextDrafts);
    logInfo('review draft created', reviewDraft);
    return reviewDraft;
  } catch (error) {
    logError('review draft create failed', error);
    return null;
  }
}

async function getReviewDraft(userDataDir, id = '') {
  try {
    const drafts = await readReviewDrafts(userDataDir);
    return drafts.find((item) => item.id === String(id || '')) || null;
  } catch (error) {
    logError('review draft load failed', error);
    return null;
  }
}

async function getReviewDraftByStagedResultId(userDataDir, stagedResultId = '') {
  try {
    const drafts = await readReviewDrafts(userDataDir);
    return drafts.find((item) => item.stagedResultId === String(stagedResultId || '')) || null;
  } catch (error) {
    logError('review draft load failed', error);
    return null;
  }
}

async function getReviewDraftByPhoto(userDataDir, photoInput = {}) {
  try {
    const photoId = String(photoInput?.photoId || '');
    const filePath = normalizePath(photoInput?.filePath || '');
    const drafts = await readReviewDrafts(userDataDir);
    return drafts.find((item) => (
      (photoId && item.photoId === photoId)
      || (filePath && normalizePath(item.filePath) === filePath)
    )) || null;
  } catch (error) {
    logError('review draft load failed', error);
    return null;
  }
}

async function listReviewDrafts(userDataDir, options = {}) {
  try {
    const drafts = await readReviewDrafts(userDataDir);
    const status = String(options?.status || '');
    const limit = normalizeLimit(options?.limit);
    return drafts.filter((item) => !status || item.status === status).slice(0, limit);
  } catch (error) {
    logError('review draft list failed', error);
    return [];
  }
}

async function updateReviewDraftStatus(userDataDir, id = '', status = 'pending_review') {
  try {
    const normalizedStatus = normalizeDraftStatus(status);
    const drafts = await readReviewDrafts(userDataDir);
    let updatedDraft = null;
    const updatedAt = new Date().toISOString();
    const nextDrafts = drafts.map((item) => {
      if (item.id !== String(id || '')) return item;
      updatedDraft = {
        ...item,
        status: normalizedStatus,
        updatedAt,
        reviewedAt: ['accepted', 'partially_accepted', 'rejected', 'dismissed'].includes(normalizedStatus) ? updatedAt : item.reviewedAt,
        clearedAt: normalizedStatus === 'cleared' ? updatedAt : item.clearedAt
      };
      return updatedDraft;
    });
    if (!updatedDraft) return null;
    await writeReviewDrafts(userDataDir, nextDrafts);
    return updatedDraft;
  } catch (error) {
    logError('review draft status update failed', error);
    return null;
  }
}

async function clearReviewDraft(userDataDir, id = '') {
  try {
    const drafts = await readReviewDrafts(userDataDir);
    const nextDrafts = drafts.filter((item) => item.id !== String(id || ''));
    if (nextDrafts.length === drafts.length) return false;
    await writeReviewDrafts(userDataDir, nextDrafts);
    logInfo('review draft cleared', { id });
    return true;
  } catch (error) {
    logError('review draft clear failed', error);
    return false;
  }
}

async function clearReviewDraftsByPhoto(userDataDir, photoInput = {}) {
  try {
    const photoId = String(photoInput?.photoId || '');
    const filePath = normalizePath(photoInput?.filePath || '');
    const drafts = await readReviewDrafts(userDataDir);
    const nextDrafts = drafts.filter((item) => !(
      (photoId && item.photoId === photoId)
      || (filePath && normalizePath(item.filePath) === filePath)
    ));
    const clearedCount = drafts.length - nextDrafts.length;
    if (clearedCount > 0) await writeReviewDrafts(userDataDir, nextDrafts);
    return clearedCount;
  } catch (error) {
    logError('review draft clear by photo failed', error);
    return 0;
  }
}

async function clearAllReviewDrafts(userDataDir) {
  try {
    const drafts = await readReviewDrafts(userDataDir);
    if (drafts.length === 0) return 0;
    await writeReviewDrafts(userDataDir, []);
    return drafts.length;
  } catch (error) {
    logError('review draft clear all failed', error);
    return 0;
  }
}

function createReviewDraft(candidateFieldSet = {}) {
  const now = new Date().toISOString();
  const fields = Array.isArray(candidateFieldSet.fields) ? candidateFieldSet.fields : [];
  return {
    id: createId('review_draft', candidateFieldSet.id || candidateFieldSet.stagedResultId || candidateFieldSet.taskId || 'empty'),
    stagedResultId: String(candidateFieldSet.stagedResultId || ''),
    candidateFieldSetId: String(candidateFieldSet.id || ''),
    taskId: String(candidateFieldSet.taskId || ''),
    photoId: String(candidateFieldSet.photoId || ''),
    filePath: String(candidateFieldSet.filePath || ''),
    fileName: String(candidateFieldSet.fileName || path.basename(String(candidateFieldSet.filePath || '')) || ''),
    fields: fields.map(normalizeCandidateField).filter(Boolean),
    status: 'pending_review',
    summary: buildSummary(fields),
    createdAt: now,
    updatedAt: now,
    reviewedAt: '',
    clearedAt: '',
    schemaVersion: REVIEW_DRAFT_SCHEMA_VERSION
  };
}

function buildSummary(fields = []) {
  const safeFields = Array.isArray(fields) ? fields : [];
  return {
    total: safeFields.length,
    canApplyCount: safeFields.filter((field) => field.canApply === true).length,
    requiresReviewCount: safeFields.filter((field) => field.requiresReview !== false).length,
    conflictCount: safeFields.filter((field) => field.hasConflict === true || field.status === 'conflict').length,
    invalidCount: safeFields.filter((field) => field.status === 'invalid').length
  };
}

async function readReviewDrafts(userDataDir) {
  const storagePath = getReviewDraftPath(userDataDir);
  try {
    const content = await fs.readFile(storagePath, 'utf-8');
    const parsed = JSON.parse(content);
    const rawItems = Array.isArray(parsed) ? parsed : parsed.items;
    if (!Array.isArray(rawItems)) return [];
    return rawItems.map(normalizeReviewDraft).filter(Boolean).sort(sortByCreatedDesc);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    logError('storage read failed', error);
    return [];
  }
}

async function writeReviewDrafts(userDataDir, drafts = []) {
  const storagePath = getReviewDraftPath(userDataDir);
  await fs.mkdir(path.dirname(storagePath), { recursive: true });
  await fs.writeFile(storagePath, JSON.stringify(limitDrafts(drafts), null, 2), 'utf-8');
}

function getReviewDraftPath(userDataDir) {
  return path.join(String(userDataDir || ''), REVIEW_DRAFT_FILE_NAME);
}

function normalizeReviewDraft(draft = {}) {
  if (!draft || typeof draft !== 'object') return null;
  const createdAt = String(draft.createdAt || new Date().toISOString());
  const fields = (Array.isArray(draft.fields) ? draft.fields : []).map(normalizeCandidateField).filter(Boolean);
  return {
    id: String(draft.id || createId('review_draft', draft.candidateFieldSetId || draft.stagedResultId || 'empty')),
    stagedResultId: String(draft.stagedResultId || ''),
    candidateFieldSetId: String(draft.candidateFieldSetId || ''),
    taskId: String(draft.taskId || ''),
    photoId: String(draft.photoId || ''),
    filePath: String(draft.filePath || ''),
    fileName: String(draft.fileName || path.basename(String(draft.filePath || '')) || ''),
    fields,
    status: normalizeDraftStatus(draft.status),
    summary: draft.summary && typeof draft.summary === 'object' ? { ...buildSummary(fields), ...draft.summary } : buildSummary(fields),
    createdAt,
    updatedAt: String(draft.updatedAt || createdAt),
    reviewedAt: String(draft.reviewedAt || ''),
    clearedAt: String(draft.clearedAt || ''),
    schemaVersion: REVIEW_DRAFT_SCHEMA_VERSION
  };
}

function normalizeCandidateField(field = {}) {
  if (!field || typeof field !== 'object') return null;
  return {
    ...field,
    canApply: field.canApply === true,
    requiresReview: true,
    allowAutoApply: false,
    existingValue: field.existingValue === undefined ? null : field.existingValue,
    hasConflict: field.hasConflict === true,
    conflictReason: String(field.conflictReason || '')
  };
}

function normalizeDraftStatus(status = '') {
  const value = String(status || '').trim();
  return REVIEW_DRAFT_STATUSES.has(value) ? value : 'pending_review';
}

function limitDrafts(drafts = []) {
  return drafts.map(normalizeReviewDraft).filter(Boolean).sort(sortByCreatedDesc).slice(0, MAX_REVIEW_DRAFTS);
}

function sortByCreatedDesc(a, b) {
  return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
}

function normalizeLimit(limit) {
  const value = Number(limit);
  if (!Number.isFinite(value) || value <= 0) return MAX_REVIEW_DRAFTS;
  return Math.min(Math.floor(value), MAX_REVIEW_DRAFTS);
}

function normalizePath(value = '') {
  return String(value || '').trim().toLowerCase();
}

function createId(prefix, seed = '') {
  return `${prefix}_${String(seed || 'item').replace(/[^a-zA-Z0-9_-]+/g, '_')}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function logInfo(message, payload = {}) {
  const summary = payload.id ? ` id=${payload.id}` : '';
  console.info(`[recognition-review-draft] ${message}${summary}`);
}

function logError(message, error = {}) {
  console.warn(`[recognition-review-draft] ${message}: ${error.message || 'unknown error'}`);
}

module.exports = {
  REVIEW_DRAFT_FILE_NAME,
  createReviewDraftFromStagedResult,
  createReviewDraftFromCandidateFieldSet,
  getReviewDraft,
  getReviewDraftByStagedResultId,
  getReviewDraftByPhoto,
  listReviewDrafts,
  updateReviewDraftStatus,
  clearReviewDraft,
  clearReviewDraftsByPhoto,
  clearAllReviewDrafts
};
