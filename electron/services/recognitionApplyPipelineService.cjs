const fs = require('node:fs/promises');
const path = require('node:path');
const { getReviewDraft } = require('./recognitionReviewDraftService.cjs');

const REVIEW_DECISION_FILE_NAME = 'recognition-review-decisions.json';
const FORM_PATCH_DRAFT_FILE_NAME = 'recognition-form-patch-drafts.json';
const APPLY_PIPELINE_SCHEMA_VERSION = 1;
const MAX_PIPELINE_ITEMS = 1000;

const FIELD_DECISION_ACTIONS = new Set(['accept', 'reject', 'ignore', 'edit']);
const REVIEW_DECISION_STATUSES = new Set(['draft', 'submitted', 'converted_to_patch', 'dismissed', 'cleared']);
const FIELD_PATCH_OPERATIONS = new Set(['set', 'append', 'clear']);
const FORM_PATCH_DRAFT_STATUSES = new Set(['draft', 'valid', 'invalid', 'partially_valid', 'applied', 'dismissed', 'cleared']);
const PATCHABLE_DECISION_ACTIONS = new Set(['accept', 'edit']);

const ALLOWED_FORM_PATCH_FIELDS = [
  'photoSource',
  'project',
  'department',
  'watermarkCategory',
  'workContent',
  'date',
  'location',
  'itemName',
  'photoStage',
  'processStatus',
  'keywords',
  'remark'
];

const ALLOWED_FORM_PATCH_FIELD_SET = new Set(ALLOWED_FORM_PATCH_FIELDS);

async function createReviewDecision(userDataDir, input = {}) {
  try {
    const reviewDraftId = String(input?.reviewDraftId || '');
    if (!reviewDraftId) return null;
    const reviewDraft = await getReviewDraft(userDataDir, reviewDraftId);
    if (!reviewDraft) return null;

    const now = new Date().toISOString();
    const candidateFields = Array.isArray(reviewDraft.fields) ? reviewDraft.fields : [];
    const candidateMap = new Map(candidateFields.map((field) => [String(field.id || ''), field]));
    const requestedDecisions = Array.isArray(input.fieldDecisions) ? input.fieldDecisions : [];
    const errors = [];
    const warnings = [];

    const fieldDecisions = requestedDecisions.map((decisionInput) => {
      const candidateFieldId = String(decisionInput?.candidateFieldId || '');
      const candidate = candidateMap.get(candidateFieldId);
      if (!candidate) {
        errors.push({
          code: 'candidate_not_in_review_draft',
          message: `候选字段不属于当前 ReviewDraft，已跳过：${candidateFieldId || 'empty'}`
        });
        return null;
      }
      const rawAction = String(decisionInput?.action || '').trim();
      if (!FIELD_DECISION_ACTIONS.has(rawAction)) {
        errors.push({
          code: 'invalid_decision_action',
          message: `人工确认动作无效，已跳过：${String(decisionInput?.action || '')}`
        });
        return null;
      }
      const action = normalizeDecisionAction(rawAction);
      if (action === 'edit' && decisionInput.decidedValue === undefined) {
        warnings.push(`候选字段 ${candidateFieldId} 使用 edit 决策但未提供 decidedValue，后续补丁会被标记为无效。`);
      }
      return createFieldDecision(reviewDraft, candidate, decisionInput, action, now);
    }).filter(Boolean);

    const reviewDecision = normalizeReviewDecision({
      id: createId('review_decision', reviewDraft.id),
      reviewDraftId: reviewDraft.id,
      stagedResultId: reviewDraft.stagedResultId,
      candidateFieldSetId: reviewDraft.candidateFieldSetId,
      taskId: reviewDraft.taskId,
      photoId: reviewDraft.photoId,
      filePath: reviewDraft.filePath,
      fileName: reviewDraft.fileName,
      fieldDecisions,
      status: 'submitted',
      summary: buildReviewDecisionSummary(candidateFields, fieldDecisions),
      warnings,
      errors,
      createdAt: now,
      updatedAt: now,
      submittedAt: now,
      schemaVersion: APPLY_PIPELINE_SCHEMA_VERSION
    });

    const decisions = await readReviewDecisions(userDataDir);
    const nextDecisions = limitItems([
      reviewDecision,
      ...decisions.filter((item) => item.reviewDraftId !== reviewDecision.reviewDraftId)
    ], normalizeReviewDecision);
    await writeReviewDecisions(userDataDir, nextDecisions);
    logInfo('review-decision', 'decision created', reviewDecision);
    return reviewDecision;
  } catch (error) {
    logError('review-decision', 'decision create failed', error);
    return null;
  }
}

async function getReviewDecision(userDataDir, id = '') {
  try {
    const decisions = await readReviewDecisions(userDataDir);
    return decisions.find((item) => item.id === String(id || '')) || null;
  } catch (error) {
    logError('review-decision', 'decision load failed', error);
    return null;
  }
}

async function getReviewDecisionByReviewDraftId(userDataDir, reviewDraftId = '') {
  try {
    const decisions = await readReviewDecisions(userDataDir);
    return decisions.find((item) => item.reviewDraftId === String(reviewDraftId || '')) || null;
  } catch (error) {
    logError('review-decision', 'decision load by draft failed', error);
    return null;
  }
}

async function getReviewDecisionByPhoto(userDataDir, photoInput = {}) {
  try {
    const photoId = String(photoInput?.photoId || '');
    const filePath = normalizePath(photoInput?.filePath || '');
    const decisions = await readReviewDecisions(userDataDir);
    return decisions.find((item) => (
      (photoId && item.photoId === photoId)
      || (filePath && normalizePath(item.filePath) === filePath)
    )) || null;
  } catch (error) {
    logError('review-decision', 'decision load by photo failed', error);
    return null;
  }
}

async function listReviewDecisions(userDataDir, options = {}) {
  try {
    const decisions = await readReviewDecisions(userDataDir);
    const status = String(options?.status || '');
    const limit = normalizeLimit(options?.limit);
    return decisions.filter((item) => !status || item.status === status).slice(0, limit);
  } catch (error) {
    logError('review-decision', 'decision list failed', error);
    return [];
  }
}

async function clearReviewDecision(userDataDir, id = '') {
  try {
    const decisions = await readReviewDecisions(userDataDir);
    const nextDecisions = decisions.filter((item) => item.id !== String(id || ''));
    if (nextDecisions.length === decisions.length) return false;
    await writeReviewDecisions(userDataDir, nextDecisions);
    logInfo('review-decision', 'decision cleared', { id });
    return true;
  } catch (error) {
    logError('review-decision', 'decision clear failed', error);
    return false;
  }
}

async function clearReviewDecisionsByPhoto(userDataDir, photoInput = {}) {
  try {
    const photoId = String(photoInput?.photoId || '');
    const filePath = normalizePath(photoInput?.filePath || '');
    const decisions = await readReviewDecisions(userDataDir);
    const nextDecisions = decisions.filter((item) => !(
      (photoId && item.photoId === photoId)
      || (filePath && normalizePath(item.filePath) === filePath)
    ));
    const clearedCount = decisions.length - nextDecisions.length;
    if (clearedCount > 0) await writeReviewDecisions(userDataDir, nextDecisions);
    return clearedCount;
  } catch (error) {
    logError('review-decision', 'decision clear by photo failed', error);
    return 0;
  }
}

async function clearAllReviewDecisions(userDataDir) {
  try {
    const decisions = await readReviewDecisions(userDataDir);
    if (decisions.length === 0) return 0;
    await writeReviewDecisions(userDataDir, []);
    return decisions.length;
  } catch (error) {
    logError('review-decision', 'decision clear all failed', error);
    return 0;
  }
}

async function buildFormPatchDraftFromReviewDecision(userDataDir, input = {}) {
  try {
    const reviewDecisionId = String(input?.reviewDecisionId || '');
    if (!reviewDecisionId) return null;
    const reviewDecision = await getReviewDecision(userDataDir, reviewDecisionId);
    if (!reviewDecision) return null;
    const formSnapshot = isPlainObject(input.formSnapshot) ? input.formSnapshot : null;
    const now = new Date().toISOString();
    const patches = reviewDecision.fieldDecisions
      .filter((decision) => PATCHABLE_DECISION_ACTIONS.has(decision.action))
      .map((decision) => createFieldPatch(reviewDecision, decision, formSnapshot, now));
    const validation = validatePatches(patches);
    const patchDraft = normalizeFormPatchDraft({
      id: createId('form_patch_draft', reviewDecision.id),
      reviewDecisionId: reviewDecision.id,
      reviewDraftId: reviewDecision.reviewDraftId,
      stagedResultId: reviewDecision.stagedResultId,
      candidateFieldSetId: reviewDecision.candidateFieldSetId,
      taskId: reviewDecision.taskId,
      photoId: reviewDecision.photoId,
      filePath: reviewDecision.filePath,
      fileName: reviewDecision.fileName,
      patches,
      status: derivePatchDraftStatus(validation, patches.length),
      summary: buildPatchDraftSummary(patches),
      warnings: [
        ...validation.warnings,
        ...(patches.length === 0 ? ['没有可生成表单补丁的人工确认字段。'] : [])
      ],
      errors: validation.errors,
      createdAt: now,
      updatedAt: now,
      schemaVersion: APPLY_PIPELINE_SCHEMA_VERSION
    });

    const drafts = await readFormPatchDrafts(userDataDir);
    const nextDrafts = limitItems([
      patchDraft,
      ...drafts.filter((item) => item.reviewDecisionId !== patchDraft.reviewDecisionId)
    ], normalizeFormPatchDraft);
    await writeFormPatchDrafts(userDataDir, nextDrafts);
    await markReviewDecisionConverted(userDataDir, reviewDecision.id);
    logInfo('form-patch', 'patch draft created', patchDraft);
    return patchDraft;
  } catch (error) {
    logError('form-patch', 'patch draft create failed', error);
    return null;
  }
}

async function validateFormPatchDraft(userDataDir, patchDraftId = '') {
  try {
    const patchDraft = await getFormPatchDraft(userDataDir, patchDraftId);
    if (!patchDraft) {
      return createValidationResult({
        patchDraftId,
        validPatches: [],
        invalidPatches: [],
        conflictPatches: [],
        warnings: [],
        errors: [{ code: 'patch_draft_not_found', message: '未找到表单补丁草稿。' }]
      });
    }
    const validation = validatePatches(patchDraft.patches);
    logInfo('form-patch', 'patch draft validated', patchDraft);
    return createValidationResult({
      patchDraftId: patchDraft.id,
      validPatches: validation.validPatches,
      invalidPatches: validation.invalidPatches,
      conflictPatches: validation.conflictPatches,
      warnings: validation.warnings,
      errors: validation.errors
    });
  } catch (error) {
    logError('form-patch', 'patch draft validate failed', error);
    return createValidationResult({
      patchDraftId,
      validPatches: [],
      invalidPatches: [],
      conflictPatches: [],
      warnings: [],
      errors: [{ code: 'patch_validation_failed', message: error.message || '表单补丁校验失败。' }]
    });
  }
}

async function getFormPatchDraft(userDataDir, id = '') {
  try {
    const drafts = await readFormPatchDrafts(userDataDir);
    return drafts.find((item) => item.id === String(id || '')) || null;
  } catch (error) {
    logError('form-patch', 'patch draft load failed', error);
    return null;
  }
}

async function getFormPatchDraftByReviewDecisionId(userDataDir, reviewDecisionId = '') {
  try {
    const drafts = await readFormPatchDrafts(userDataDir);
    return drafts.find((item) => item.reviewDecisionId === String(reviewDecisionId || '')) || null;
  } catch (error) {
    logError('form-patch', 'patch draft load by decision failed', error);
    return null;
  }
}

async function getFormPatchDraftByPhoto(userDataDir, photoInput = {}) {
  try {
    const photoId = String(photoInput?.photoId || '');
    const filePath = normalizePath(photoInput?.filePath || '');
    const drafts = await readFormPatchDrafts(userDataDir);
    return drafts.find((item) => (
      (photoId && item.photoId === photoId)
      || (filePath && normalizePath(item.filePath) === filePath)
    )) || null;
  } catch (error) {
    logError('form-patch', 'patch draft load by photo failed', error);
    return null;
  }
}

async function listFormPatchDrafts(userDataDir, options = {}) {
  try {
    const drafts = await readFormPatchDrafts(userDataDir);
    const status = String(options?.status || '');
    const limit = normalizeLimit(options?.limit);
    return drafts.filter((item) => !status || item.status === status).slice(0, limit);
  } catch (error) {
    logError('form-patch', 'patch draft list failed', error);
    return [];
  }
}

async function updateFormPatchDraftStatus(userDataDir, id = '', status = 'draft') {
  try {
    const normalizedStatus = normalizeFormPatchDraftStatus(status);
    const drafts = await readFormPatchDrafts(userDataDir);
    let updatedDraft = null;
    const updatedAt = new Date().toISOString();
    const nextDrafts = drafts.map((item) => {
      if (item.id !== String(id || '')) return item;
      updatedDraft = normalizeFormPatchDraft({
        ...item,
        status: normalizedStatus,
        updatedAt,
        appliedAt: normalizedStatus === 'applied' ? updatedAt : item.appliedAt,
        clearedAt: normalizedStatus === 'cleared' ? updatedAt : item.clearedAt
      });
      return updatedDraft;
    });
    if (!updatedDraft) return null;
    await writeFormPatchDrafts(userDataDir, nextDrafts);
    return updatedDraft;
  } catch (error) {
    logError('form-patch', 'patch draft status update failed', error);
    return null;
  }
}

async function clearFormPatchDraft(userDataDir, id = '') {
  try {
    const drafts = await readFormPatchDrafts(userDataDir);
    const nextDrafts = drafts.filter((item) => item.id !== String(id || ''));
    if (nextDrafts.length === drafts.length) return false;
    await writeFormPatchDrafts(userDataDir, nextDrafts);
    logInfo('form-patch', 'patch draft cleared', { id });
    return true;
  } catch (error) {
    logError('form-patch', 'patch draft clear failed', error);
    return false;
  }
}

async function clearFormPatchDraftsByPhoto(userDataDir, photoInput = {}) {
  try {
    const photoId = String(photoInput?.photoId || '');
    const filePath = normalizePath(photoInput?.filePath || '');
    const drafts = await readFormPatchDrafts(userDataDir);
    const nextDrafts = drafts.filter((item) => !(
      (photoId && item.photoId === photoId)
      || (filePath && normalizePath(item.filePath) === filePath)
    ));
    const clearedCount = drafts.length - nextDrafts.length;
    if (clearedCount > 0) await writeFormPatchDrafts(userDataDir, nextDrafts);
    return clearedCount;
  } catch (error) {
    logError('form-patch', 'patch draft clear by photo failed', error);
    return 0;
  }
}

async function clearAllFormPatchDrafts(userDataDir) {
  try {
    const drafts = await readFormPatchDrafts(userDataDir);
    if (drafts.length === 0) return 0;
    await writeFormPatchDrafts(userDataDir, []);
    return drafts.length;
  } catch (error) {
    logError('form-patch', 'patch draft clear all failed', error);
    return 0;
  }
}

function createFieldDecision(reviewDraft = {}, candidate = {}, decisionInput = {}, action = 'ignore', now = new Date().toISOString()) {
  const decidedValue = action === 'edit'
    ? cloneJsonValue(decisionInput.decidedValue)
    : (action === 'accept' ? firstUsableValue(candidate.normalizedValue, candidate.value) : null);
  return normalizeFieldDecision({
    id: createId('field_decision', `${reviewDraft.id}-${candidate.id}`),
    reviewDraftId: reviewDraft.id,
    candidateFieldId: candidate.id,
    action,
    targetFieldKey: String(candidate.targetFieldKey || ''),
    label: String(candidate.label || candidate.sourceFieldKey || ''),
    originalValue: firstUsableValue(candidate.normalizedValue, candidate.value),
    decidedValue,
    sourceValue: cloneJsonValue(candidate.value),
    candidateCanApply: candidate.canApply === true,
    candidateStatus: String(candidate.status || ''),
    candidateWarning: String(candidate.warning || ''),
    candidateError: String(candidate.error || ''),
    reason: String(decisionInput.reason || ''),
    decidedBy: 'manual',
    decidedAt: now,
    schemaVersion: APPLY_PIPELINE_SCHEMA_VERSION
  });
}

function createFieldPatch(reviewDecision = {}, fieldDecision = {}, formSnapshot = null, now = new Date().toISOString()) {
  const targetFieldKey = String(fieldDecision.targetFieldKey || '');
  const label = String(fieldDecision.label || targetFieldKey || '未映射字段');
  const sourceValue = cloneJsonValue(fieldDecision.sourceValue);
  const patchValue = fieldDecision.action === 'edit'
    ? cloneJsonValue(fieldDecision.decidedValue)
    : firstUsableValue(fieldDecision.decidedValue, fieldDecision.originalValue);
  const previousValue = formSnapshot && Object.prototype.hasOwnProperty.call(formSnapshot, targetFieldKey)
    ? cloneJsonValue(formSnapshot[targetFieldKey])
    : undefined;
  const hasPreviousValue = previousValue !== undefined;
  const hasConflict = hasPreviousValue && !isEmptyValue(previousValue) && !isSameValue(previousValue, patchValue);
  const errorParts = [];
  const warningParts = [];

  if (!targetFieldKey) errorParts.push('补丁目标字段为空。');
  if (!ALLOWED_FORM_PATCH_FIELD_SET.has(targetFieldKey)) errorParts.push('补丁目标字段不在归档字段白名单中。');
  if (fieldDecision.candidateCanApply !== true) errorParts.push('候选字段不可应用，补丁已阻断。');
  if (isEmptyValue(patchValue)) errorParts.push('补丁值为空，未做字段猜测。');
  if (hasConflict) warningParts.push('当前表单快照中已有不同值，等待未来 UI 人工处理。');

  return normalizeFieldPatch({
    id: createId('field_patch', `${reviewDecision.id}-${fieldDecision.candidateFieldId}`),
    reviewDecisionId: reviewDecision.id,
    reviewDraftId: reviewDecision.reviewDraftId,
    candidateFieldId: fieldDecision.candidateFieldId,
    targetFieldKey,
    label,
    operation: 'set',
    value: cloneJsonValue(patchValue),
    normalizedValue: cloneJsonValue(patchValue),
    sourceValue,
    previousValue: hasPreviousValue ? previousValue : undefined,
    hasPreviousValue,
    hasConflict,
    conflictReason: hasConflict ? '表单快照已有值且与补丁值不同。' : '',
    canApply: errorParts.length === 0 && !hasConflict,
    requiresExplicitApply: true,
    warning: warningParts.join('；'),
    error: errorParts.join('；'),
    createdAt: now,
    updatedAt: now,
    schemaVersion: APPLY_PIPELINE_SCHEMA_VERSION
  });
}

async function markReviewDecisionConverted(userDataDir, id = '') {
  try {
    const decisions = await readReviewDecisions(userDataDir);
    const updatedAt = new Date().toISOString();
    let changed = false;
    const nextDecisions = decisions.map((item) => {
      if (item.id !== id) return item;
      changed = true;
      return normalizeReviewDecision({ ...item, status: 'converted_to_patch', updatedAt });
    });
    if (changed) await writeReviewDecisions(userDataDir, nextDecisions);
  } catch (error) {
    logError('review-decision', 'decision status mark failed', error);
  }
}

async function readReviewDecisions(userDataDir) {
  const storagePath = getReviewDecisionPath(userDataDir);
  try {
    const content = await fs.readFile(storagePath, 'utf-8');
    const parsed = JSON.parse(content);
    const rawItems = Array.isArray(parsed) ? parsed : parsed.items;
    if (!Array.isArray(rawItems)) return [];
    return rawItems.map(normalizeReviewDecision).filter(Boolean).sort(sortByCreatedDesc);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    logError('review-decision', 'storage read failed', error);
    return [];
  }
}

async function writeReviewDecisions(userDataDir, decisions = []) {
  const storagePath = getReviewDecisionPath(userDataDir);
  await fs.mkdir(path.dirname(storagePath), { recursive: true });
  await fs.writeFile(storagePath, JSON.stringify(limitItems(decisions, normalizeReviewDecision), null, 2), 'utf-8');
}

async function readFormPatchDrafts(userDataDir) {
  const storagePath = getFormPatchDraftPath(userDataDir);
  try {
    const content = await fs.readFile(storagePath, 'utf-8');
    const parsed = JSON.parse(content);
    const rawItems = Array.isArray(parsed) ? parsed : parsed.items;
    if (!Array.isArray(rawItems)) return [];
    return rawItems.map(normalizeFormPatchDraft).filter(Boolean).sort(sortByCreatedDesc);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    logError('form-patch', 'storage read failed', error);
    return [];
  }
}

async function writeFormPatchDrafts(userDataDir, drafts = []) {
  const storagePath = getFormPatchDraftPath(userDataDir);
  await fs.mkdir(path.dirname(storagePath), { recursive: true });
  await fs.writeFile(storagePath, JSON.stringify(limitItems(drafts, normalizeFormPatchDraft), null, 2), 'utf-8');
}

function getReviewDecisionPath(userDataDir) {
  return path.join(String(userDataDir || ''), REVIEW_DECISION_FILE_NAME);
}

function getFormPatchDraftPath(userDataDir) {
  return path.join(String(userDataDir || ''), FORM_PATCH_DRAFT_FILE_NAME);
}

function normalizeFieldDecision(decision = {}) {
  if (!isPlainObject(decision)) return null;
  const decidedAt = String(decision.decidedAt || new Date().toISOString());
  return {
    id: String(decision.id || createId('field_decision', decision.candidateFieldId || 'empty')),
    reviewDraftId: String(decision.reviewDraftId || ''),
    candidateFieldId: String(decision.candidateFieldId || ''),
    action: normalizeDecisionAction(decision.action),
    targetFieldKey: String(decision.targetFieldKey || ''),
    label: String(decision.label || decision.targetFieldKey || ''),
    originalValue: cloneJsonValue(decision.originalValue),
    decidedValue: cloneJsonValue(decision.decidedValue),
    sourceValue: cloneJsonValue(decision.sourceValue),
    candidateCanApply: decision.candidateCanApply === true,
    candidateStatus: String(decision.candidateStatus || ''),
    candidateWarning: String(decision.candidateWarning || ''),
    candidateError: String(decision.candidateError || ''),
    reason: String(decision.reason || ''),
    decidedBy: 'manual',
    decidedAt,
    schemaVersion: APPLY_PIPELINE_SCHEMA_VERSION
  };
}

function normalizeReviewDecision(decision = {}) {
  if (!isPlainObject(decision)) return null;
  const createdAt = String(decision.createdAt || new Date().toISOString());
  const fieldDecisions = (Array.isArray(decision.fieldDecisions) ? decision.fieldDecisions : []).map(normalizeFieldDecision).filter(Boolean);
  return {
    id: String(decision.id || createId('review_decision', decision.reviewDraftId || 'empty')),
    reviewDraftId: String(decision.reviewDraftId || ''),
    stagedResultId: String(decision.stagedResultId || ''),
    candidateFieldSetId: String(decision.candidateFieldSetId || ''),
    taskId: String(decision.taskId || ''),
    photoId: String(decision.photoId || ''),
    filePath: String(decision.filePath || ''),
    fileName: String(decision.fileName || path.basename(String(decision.filePath || '')) || ''),
    fieldDecisions,
    status: normalizeReviewDecisionStatus(decision.status),
    summary: isPlainObject(decision.summary) ? normalizeReviewDecisionSummary(decision.summary, fieldDecisions) : normalizeReviewDecisionSummary({}, fieldDecisions),
    warnings: normalizeStringArray(decision.warnings),
    errors: normalizeErrors(decision.errors),
    createdAt,
    updatedAt: String(decision.updatedAt || createdAt),
    submittedAt: String(decision.submittedAt || ''),
    clearedAt: String(decision.clearedAt || ''),
    schemaVersion: APPLY_PIPELINE_SCHEMA_VERSION
  };
}

function normalizeFieldPatch(patch = {}) {
  if (!isPlainObject(patch)) return null;
  const createdAt = String(patch.createdAt || new Date().toISOString());
  return {
    id: String(patch.id || createId('field_patch', patch.candidateFieldId || 'empty')),
    reviewDecisionId: String(patch.reviewDecisionId || ''),
    reviewDraftId: String(patch.reviewDraftId || ''),
    candidateFieldId: String(patch.candidateFieldId || ''),
    targetFieldKey: String(patch.targetFieldKey || ''),
    label: String(patch.label || patch.targetFieldKey || ''),
    operation: normalizePatchOperation(patch.operation),
    value: cloneJsonValue(patch.value),
    normalizedValue: cloneJsonValue(patch.normalizedValue),
    sourceValue: cloneJsonValue(patch.sourceValue),
    previousValue: patch.previousValue === undefined ? undefined : cloneJsonValue(patch.previousValue),
    hasPreviousValue: patch.hasPreviousValue === true,
    hasConflict: patch.hasConflict === true,
    conflictReason: String(patch.conflictReason || ''),
    canApply: patch.canApply === true,
    requiresExplicitApply: true,
    warning: String(patch.warning || ''),
    error: String(patch.error || ''),
    createdAt,
    updatedAt: String(patch.updatedAt || createdAt),
    schemaVersion: APPLY_PIPELINE_SCHEMA_VERSION
  };
}

function normalizeFormPatchDraft(draft = {}) {
  if (!isPlainObject(draft)) return null;
  const createdAt = String(draft.createdAt || new Date().toISOString());
  const patches = (Array.isArray(draft.patches) ? draft.patches : []).map(normalizeFieldPatch).filter(Boolean);
  return {
    id: String(draft.id || createId('form_patch_draft', draft.reviewDecisionId || 'empty')),
    reviewDecisionId: String(draft.reviewDecisionId || ''),
    reviewDraftId: String(draft.reviewDraftId || ''),
    stagedResultId: String(draft.stagedResultId || ''),
    candidateFieldSetId: String(draft.candidateFieldSetId || ''),
    taskId: String(draft.taskId || ''),
    photoId: String(draft.photoId || ''),
    filePath: String(draft.filePath || ''),
    fileName: String(draft.fileName || path.basename(String(draft.filePath || '')) || ''),
    patches,
    status: normalizeFormPatchDraftStatus(draft.status),
    summary: isPlainObject(draft.summary) ? { ...buildPatchDraftSummary(patches), ...draft.summary } : buildPatchDraftSummary(patches),
    warnings: normalizeStringArray(draft.warnings),
    errors: normalizeErrors(draft.errors),
    createdAt,
    updatedAt: String(draft.updatedAt || createdAt),
    appliedAt: String(draft.appliedAt || ''),
    clearedAt: String(draft.clearedAt || ''),
    schemaVersion: APPLY_PIPELINE_SCHEMA_VERSION
  };
}

function createValidationResult(input = {}) {
  const validPatches = (Array.isArray(input.validPatches) ? input.validPatches : []).map(normalizeFieldPatch).filter(Boolean);
  const invalidPatches = (Array.isArray(input.invalidPatches) ? input.invalidPatches : []).map(normalizeFieldPatch).filter(Boolean);
  const conflictPatches = (Array.isArray(input.conflictPatches) ? input.conflictPatches : []).map(normalizeFieldPatch).filter(Boolean);
  return {
    ok: invalidPatches.length === 0 && conflictPatches.length === 0 && validPatches.length > 0,
    patchDraftId: String(input.patchDraftId || ''),
    validPatches,
    invalidPatches,
    conflictPatches,
    warnings: normalizeStringArray(input.warnings),
    errors: normalizeErrors(input.errors),
    checkedAt: new Date().toISOString(),
    schemaVersion: APPLY_PIPELINE_SCHEMA_VERSION
  };
}

function validatePatches(patches = []) {
  const validPatches = [];
  const invalidPatches = [];
  const conflictPatches = [];
  const warnings = [];
  const errors = [];
  for (const patch of patches.map(normalizeFieldPatch).filter(Boolean)) {
    const patchErrors = [];
    if (!patch.targetFieldKey) patchErrors.push('补丁目标字段为空。');
    if (!ALLOWED_FORM_PATCH_FIELD_SET.has(patch.targetFieldKey)) patchErrors.push('补丁目标字段不在归档字段白名单中。');
    if (!FIELD_PATCH_OPERATIONS.has(patch.operation)) patchErrors.push('补丁操作类型无效。');
    if (patch.requiresExplicitApply !== true) patchErrors.push('补丁必须要求显式应用。');
    if (isEmptyValue(patch.value)) patchErrors.push('补丁值为空。');
    if (patch.error) patchErrors.push(patch.error);
    if (patch.hasConflict) {
      conflictPatches.push(patch);
      warnings.push(patch.conflictReason || patch.warning || '补丁存在冲突。');
    }
    if (!patch.canApply || patchErrors.length > 0) {
      invalidPatches.push({ ...patch, error: Array.from(new Set(patchErrors)).filter(Boolean).join('；') });
      errors.push(...patchErrors);
    } else {
      validPatches.push(patch);
    }
  }
  return {
    validPatches,
    invalidPatches,
    conflictPatches,
    warnings: Array.from(new Set(warnings)).filter(Boolean),
    errors: Array.from(new Set(errors)).filter(Boolean).map((message) => ({ code: 'patch_validation_error', message }))
  };
}

function buildReviewDecisionSummary(candidateFields = [], fieldDecisions = []) {
  const decisions = Array.isArray(fieldDecisions) ? fieldDecisions : [];
  return {
    totalCandidates: Array.isArray(candidateFields) ? candidateFields.length : 0,
    acceptedCount: decisions.filter((item) => item.action === 'accept').length,
    editedCount: decisions.filter((item) => item.action === 'edit').length,
    rejectedCount: decisions.filter((item) => item.action === 'reject').length,
    ignoredCount: decisions.filter((item) => item.action === 'ignore').length,
    patchableCount: decisions.filter((item) => PATCHABLE_DECISION_ACTIONS.has(item.action)
      && item.candidateCanApply === true
      && ALLOWED_FORM_PATCH_FIELD_SET.has(item.targetFieldKey)).length
  };
}

function normalizeReviewDecisionSummary(summary = {}, fieldDecisions = []) {
  const decisions = Array.isArray(fieldDecisions) ? fieldDecisions : [];
  return {
    totalCandidates: Number(summary.totalCandidates || 0),
    acceptedCount: Number(summary.acceptedCount || decisions.filter((item) => item.action === 'accept').length),
    editedCount: Number(summary.editedCount || decisions.filter((item) => item.action === 'edit').length),
    rejectedCount: Number(summary.rejectedCount || decisions.filter((item) => item.action === 'reject').length),
    ignoredCount: Number(summary.ignoredCount || decisions.filter((item) => item.action === 'ignore').length),
    patchableCount: Number(summary.patchableCount || decisions.filter((item) => PATCHABLE_DECISION_ACTIONS.has(item.action)).length)
  };
}

function buildPatchDraftSummary(patches = []) {
  const safePatches = Array.isArray(patches) ? patches : [];
  return {
    total: safePatches.length,
    validCount: safePatches.filter((patch) => patch.canApply && !patch.hasConflict && !patch.error).length,
    invalidCount: safePatches.filter((patch) => !patch.canApply || patch.error).length,
    conflictCount: safePatches.filter((patch) => patch.hasConflict).length,
    blockedCount: safePatches.filter((patch) => !patch.canApply).length
  };
}

function derivePatchDraftStatus(validation, patchCount = 0) {
  if (patchCount === 0) return 'invalid';
  const validCount = validation.validPatches.length;
  const invalidCount = validation.invalidPatches.length;
  const conflictCount = validation.conflictPatches.length;
  if (validCount > 0 && invalidCount === 0 && conflictCount === 0) return 'valid';
  if (validCount > 0) return 'partially_valid';
  return 'invalid';
}

function normalizeDecisionAction(action = '') {
  const value = String(action || '').trim();
  return FIELD_DECISION_ACTIONS.has(value) ? value : 'ignore';
}

function normalizeReviewDecisionStatus(status = '') {
  const value = String(status || '').trim();
  return REVIEW_DECISION_STATUSES.has(value) ? value : 'submitted';
}

function normalizePatchOperation(operation = '') {
  const value = String(operation || '').trim();
  return FIELD_PATCH_OPERATIONS.has(value) ? value : 'set';
}

function normalizeFormPatchDraftStatus(status = '') {
  const value = String(status || '').trim();
  return FORM_PATCH_DRAFT_STATUSES.has(value) ? value : 'draft';
}

function limitItems(items = [], normalizer) {
  return items.map(normalizer).filter(Boolean).sort(sortByCreatedDesc).slice(0, MAX_PIPELINE_ITEMS);
}

function sortByCreatedDesc(a, b) {
  return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
}

function normalizeLimit(limit) {
  const value = Number(limit);
  if (!Number.isFinite(value) || value <= 0) return MAX_PIPELINE_ITEMS;
  return Math.min(Math.floor(value), MAX_PIPELINE_ITEMS);
}

function normalizePath(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeStringArray(values = []) {
  return Array.from(new Set((Array.isArray(values) ? values : [values])
    .map((item) => String(item || '').trim())
    .filter(Boolean)));
}

function normalizeErrors(errors = []) {
  return (Array.isArray(errors) ? errors : [errors]).map((error) => {
    if (!error) return null;
    if (typeof error === 'string') return { code: 'recognition_apply_pipeline_error', message: error };
    return {
      code: String(error.code || 'recognition_apply_pipeline_error'),
      message: String(error.message || '')
    };
  }).filter((error) => error?.message);
}

function isEmptyValue(value) {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'string') return value.trim() === '';
  return false;
}

function isSameValue(a, b) {
  return JSON.stringify(normalizeComparableValue(a)) === JSON.stringify(normalizeComparableValue(b));
}

function normalizeComparableValue(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  if (typeof value === 'string') return value.trim();
  return value;
}

function firstUsableValue(...values) {
  const found = values.find((value) => !isEmptyValue(value));
  return cloneJsonValue(found);
}

function createId(prefix, seed = '') {
  return `${prefix}_${String(seed || 'item').replace(/[^a-zA-Z0-9_-]+/g, '_')}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function cloneJsonValue(value) {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function logInfo(scope, message, payload = {}) {
  const summary = payload.id ? ` id=${payload.id}` : '';
  console.info(`[recognition-${scope}] ${message}${summary}`);
}

function logError(scope, message, error = {}) {
  console.warn(`[recognition-${scope}] ${message}: ${error.message || 'unknown error'}`);
}

module.exports = {
  REVIEW_DECISION_FILE_NAME,
  FORM_PATCH_DRAFT_FILE_NAME,
  ALLOWED_FORM_PATCH_FIELDS,
  createReviewDecision,
  getReviewDecision,
  getReviewDecisionByReviewDraftId,
  getReviewDecisionByPhoto,
  listReviewDecisions,
  clearReviewDecision,
  clearReviewDecisionsByPhoto,
  clearAllReviewDecisions,
  buildFormPatchDraftFromReviewDecision,
  validateFormPatchDraft,
  getFormPatchDraft,
  getFormPatchDraftByReviewDecisionId,
  getFormPatchDraftByPhoto,
  listFormPatchDrafts,
  updateFormPatchDraftStatus,
  clearFormPatchDraft,
  clearFormPatchDraftsByPhoto,
  clearAllFormPatchDrafts
};
