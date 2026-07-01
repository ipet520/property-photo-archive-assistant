const fs = require('node:fs/promises');
const path = require('node:path');

const CANDIDATE_FIELD_SET_FILE_NAME = 'recognition-candidate-field-sets.json';
const CANDIDATE_SCHEMA_VERSION = 1;
const MAX_CANDIDATE_FIELD_SETS = 1000;

const CANDIDATE_FIELD_STATUSES = new Set([
  'candidate',
  'pending_review',
  'accepted',
  'rejected',
  'ignored',
  'conflict',
  'invalid'
]);

const CANDIDATE_FIELD_SET_STATUSES = new Set([
  'empty',
  'pending_review',
  'partially_reviewed',
  'reviewed',
  'dismissed',
  'failed'
]);

const DEFAULT_FIELD_MAPPING_RULES = [
  createMappingRule('projectName', 'project', '项目', 'string'),
  createMappingRule('communityName', 'project', '项目', 'string'),
  createMappingRule('project', 'project', '项目', 'string'),
  createMappingRule('department', 'department', '部门', 'string'),
  createMappingRule('category', 'watermarkCategory', '水印分类', 'string'),
  createMappingRule('workCategory', 'watermarkCategory', '水印分类', 'string'),
  createMappingRule('watermarkCategory', 'watermarkCategory', '水印分类', 'string'),
  createMappingRule('workContent', 'workContent', '工作内容', 'string'),
  createMappingRule('location', 'location', '位置/区域', 'string'),
  createMappingRule('building', 'location', '位置/区域', 'string'),
  createMappingRule('unit', 'location', '位置/区域', 'string'),
  createMappingRule('floor', 'location', '位置/区域', 'string'),
  createMappingRule('room', 'location', '位置/区域', 'string'),
  createMappingRule('date', 'date', '日期', 'date'),
  createMappingRule('datetime', 'date', '日期', 'datetime'),
  createMappingRule('keywords', 'keywords', '关键词', 'array'),
  createMappingRule('remark', 'remark', '备注', 'string'),
  createMappingRule('description', 'remark', '备注', 'string'),
  createMappingRule('stage', 'photoStage', '照片阶段', 'string'),
  createMappingRule('photoStage', 'photoStage', '照片阶段', 'string'),
  createMappingRule('processStatus', 'processStatus', '处理状态', 'string'),
  createMappingRule('itemName', 'itemName', '事项名称', 'string')
];

async function getRecognitionFieldMappingRules() {
  return DEFAULT_FIELD_MAPPING_RULES.map((rule) => ({ ...rule }));
}

async function getRecognitionFieldMappingRule(sourceFieldKey = '') {
  const normalizedKey = normalizeKey(sourceFieldKey);
  return DEFAULT_FIELD_MAPPING_RULES.find((rule) => rule.sourceFieldKey === normalizedKey) || null;
}

async function buildCandidateFieldSetFromStagedResult(userDataDir, stagedResult = {}) {
  try {
    const mappingRules = await getRecognitionFieldMappingRules();
    const fieldSet = await mapProposedFieldsToCandidates({ stagedResult, mappingRules });
    const existingFieldSets = await readCandidateFieldSets(userDataDir);
    const nextFieldSets = limitFieldSets([fieldSet, ...existingFieldSets.filter((item) => item.stagedResultId !== fieldSet.stagedResultId)]);
    await writeCandidateFieldSets(userDataDir, nextFieldSets);
    logInfo('candidate field set created', fieldSet);
    return fieldSet;
  } catch (error) {
    logError('candidate field set failed', error);
    return createFailedCandidateFieldSet(stagedResult, error);
  }
}

async function normalizeProposedFields(proposedFields = {}) {
  if (!isPlainObject(proposedFields)) return {};
  return Object.fromEntries(Object.entries(proposedFields).map(([key, value]) => [normalizeKey(key), value]).filter(([key]) => Boolean(key)));
}

async function mapProposedFieldsToCandidates(input = {}) {
  const stagedResult = input.stagedResult || {};
  const mappingRules = Array.isArray(input.mappingRules) ? input.mappingRules : await getRecognitionFieldMappingRules();
  const warnings = normalizeStringArray(stagedResult.warnings);
  const errors = normalizeErrors(stagedResult.errors);
  const proposedFields = stagedResult.proposedFields;
  if (!proposedFields || Object.keys(proposedFields).length === 0) {
    return createCandidateFieldSet(stagedResult, [], 'empty', warnings, errors);
  }
  if (!isPlainObject(proposedFields)) {
    return createCandidateFieldSet(stagedResult, [], 'failed', [
      ...warnings,
      'proposedFields 不是对象，已跳过候选字段映射。'
    ], errors);
  }
  const normalizedFields = await normalizeProposedFields(proposedFields);
  const fields = Object.entries(normalizedFields).map(([sourceFieldKey, value]) => {
    const mappingRule = mappingRules.find((rule) => rule.enabled && rule.sourceFieldKey === sourceFieldKey) || null;
    return createCandidateField({
      stagedResult,
      sourceFieldKey,
      value,
      mappingRule
    });
  });
  return createCandidateFieldSet(stagedResult, fields, fields.length > 0 ? 'pending_review' : 'empty', warnings, errors);
}

async function getCandidateFieldSet(userDataDir, id = '') {
  try {
    const fieldSets = await readCandidateFieldSets(userDataDir);
    return fieldSets.find((item) => item.id === String(id || '')) || null;
  } catch (error) {
    logError('candidate field set load failed', error);
    return null;
  }
}

async function getCandidateFieldSetByStagedResult(userDataDir, stagedResultId = '') {
  try {
    const fieldSets = await readCandidateFieldSets(userDataDir);
    return fieldSets.find((item) => item.stagedResultId === String(stagedResultId || '')) || null;
  } catch (error) {
    logError('candidate field set load failed', error);
    return null;
  }
}

async function getCandidateFieldSetByPhoto(userDataDir, photoInput = {}) {
  try {
    const photoId = String(photoInput?.photoId || '');
    const filePath = normalizePath(photoInput?.filePath || '');
    const fieldSets = await readCandidateFieldSets(userDataDir);
    return fieldSets.find((item) => (
      (photoId && item.photoId === photoId)
      || (filePath && normalizePath(item.filePath) === filePath)
    )) || null;
  } catch (error) {
    logError('candidate field set load failed', error);
    return null;
  }
}

async function listCandidateFieldSets(userDataDir, options = {}) {
  try {
    const fieldSets = await readCandidateFieldSets(userDataDir);
    const status = String(options?.status || '');
    const limit = normalizeLimit(options?.limit);
    return fieldSets.filter((item) => !status || item.status === status).slice(0, limit);
  } catch (error) {
    logError('candidate field set list failed', error);
    return [];
  }
}

async function clearCandidateFieldSet(userDataDir, id = '') {
  try {
    const fieldSets = await readCandidateFieldSets(userDataDir);
    const nextFieldSets = fieldSets.filter((item) => item.id !== String(id || ''));
    if (nextFieldSets.length === fieldSets.length) return false;
    await writeCandidateFieldSets(userDataDir, nextFieldSets);
    return true;
  } catch (error) {
    logError('candidate field set clear failed', error);
    return false;
  }
}

async function clearCandidateFieldSetsByPhoto(userDataDir, photoInput = {}) {
  try {
    const photoId = String(photoInput?.photoId || '');
    const filePath = normalizePath(photoInput?.filePath || '');
    const fieldSets = await readCandidateFieldSets(userDataDir);
    const nextFieldSets = fieldSets.filter((item) => !(
      (photoId && item.photoId === photoId)
      || (filePath && normalizePath(item.filePath) === filePath)
    ));
    const clearedCount = fieldSets.length - nextFieldSets.length;
    if (clearedCount > 0) await writeCandidateFieldSets(userDataDir, nextFieldSets);
    return clearedCount;
  } catch (error) {
    logError('candidate field set clear by photo failed', error);
    return 0;
  }
}

async function clearAllCandidateFieldSets(userDataDir) {
  try {
    const fieldSets = await readCandidateFieldSets(userDataDir);
    if (fieldSets.length === 0) return 0;
    await writeCandidateFieldSets(userDataDir, []);
    return fieldSets.length;
  } catch (error) {
    logError('candidate field set clear all failed', error);
    return 0;
  }
}

function createCandidateField({ stagedResult = {}, sourceFieldKey = '', value = null, mappingRule = null }) {
  const now = new Date().toISOString();
  const normalized = normalizeCandidateValue(value, mappingRule?.valueType || 'unknown');
  const canApply = Boolean(mappingRule?.enabled && mappingRule?.targetFieldKey && !normalized.warning);
  return {
    id: createId('candidate_field', `${stagedResult.id || stagedResult.taskId}-${sourceFieldKey}`),
    stagedResultId: String(stagedResult.id || ''),
    taskId: String(stagedResult.taskId || ''),
    sourceFieldKey,
    targetFieldKey: mappingRule?.targetFieldKey || 'unmapped',
    label: mappingRule?.label || sourceFieldKey,
    value,
    normalizedValue: normalized.value,
    confidence: Number.isFinite(Number(stagedResult.confidence)) ? Number(stagedResult.confidence) : null,
    status: normalized.warning ? 'invalid' : 'pending_review',
    source: 'recognition_proposed_fields',
    reason: mappingRule ? '候选字段来自识别 proposedFields，需人工确认后才可应用。' : '未找到安全映射规则，当前不可应用。',
    warning: normalized.warning || (mappingRule ? '' : '未映射字段不可应用。'),
    error: '',
    canApply,
    requiresReview: true,
    allowAutoApply: false,
    existingValue: null,
    hasConflict: false,
    conflictReason: '',
    createdAt: now,
    updatedAt: now,
    schemaVersion: CANDIDATE_SCHEMA_VERSION
  };
}

function createCandidateFieldSet(stagedResult = {}, fields = [], status = 'empty', warnings = [], errors = []) {
  const now = new Date().toISOString();
  return {
    id: createId('candidate_set', stagedResult.id || stagedResult.taskId || stagedResult.fileName || 'empty'),
    stagedResultId: String(stagedResult.id || ''),
    taskId: String(stagedResult.taskId || ''),
    photoId: String(stagedResult.photoId || ''),
    filePath: String(stagedResult.filePath || ''),
    fileName: String(stagedResult.fileName || path.basename(String(stagedResult.filePath || '')) || ''),
    fields: fields.map(normalizeCandidateField).filter(Boolean),
    status: normalizeFieldSetStatus(status),
    warnings: normalizeStringArray(warnings),
    errors: normalizeErrors(errors),
    createdAt: now,
    updatedAt: now,
    schemaVersion: CANDIDATE_SCHEMA_VERSION
  };
}

function createFailedCandidateFieldSet(stagedResult = {}, error = {}) {
  return createCandidateFieldSet(stagedResult, [], 'failed', ['候选字段集生成失败，未修改照片、表单或台账。'], [
    { code: 'candidate_field_set_failed', message: error.message || '候选字段集生成失败。' }
  ]);
}

function createMappingRule(sourceFieldKey, targetFieldKey, label, valueType) {
  const now = 'system';
  return {
    id: `map_${sourceFieldKey}_to_${targetFieldKey}`,
    sourceFieldKey,
    targetFieldKey,
    label,
    enabled: true,
    valueType,
    requiredReview: true,
    allowAutoApply: false,
    normalize: valueType,
    createdAt: now,
    updatedAt: now,
    schemaVersion: CANDIDATE_SCHEMA_VERSION
  };
}

async function readCandidateFieldSets(userDataDir) {
  const storagePath = getCandidateFieldSetPath(userDataDir);
  try {
    const content = await fs.readFile(storagePath, 'utf-8');
    const parsed = JSON.parse(content);
    const rawItems = Array.isArray(parsed) ? parsed : parsed.items;
    if (!Array.isArray(rawItems)) return [];
    return rawItems.map(normalizeCandidateFieldSet).filter(Boolean).sort(sortByCreatedDesc);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    logError('storage read failed', error);
    return [];
  }
}

async function writeCandidateFieldSets(userDataDir, fieldSets = []) {
  const storagePath = getCandidateFieldSetPath(userDataDir);
  await fs.mkdir(path.dirname(storagePath), { recursive: true });
  await fs.writeFile(storagePath, JSON.stringify(limitFieldSets(fieldSets), null, 2), 'utf-8');
}

function getCandidateFieldSetPath(userDataDir) {
  return path.join(String(userDataDir || ''), CANDIDATE_FIELD_SET_FILE_NAME);
}

function normalizeCandidateFieldSet(fieldSet = {}) {
  if (!isPlainObject(fieldSet)) return null;
  const createdAt = String(fieldSet.createdAt || new Date().toISOString());
  return {
    id: String(fieldSet.id || createId('candidate_set', fieldSet.stagedResultId || fieldSet.taskId || 'empty')),
    stagedResultId: String(fieldSet.stagedResultId || ''),
    taskId: String(fieldSet.taskId || ''),
    photoId: String(fieldSet.photoId || ''),
    filePath: String(fieldSet.filePath || ''),
    fileName: String(fieldSet.fileName || path.basename(String(fieldSet.filePath || '')) || ''),
    fields: (Array.isArray(fieldSet.fields) ? fieldSet.fields : []).map(normalizeCandidateField).filter(Boolean),
    status: normalizeFieldSetStatus(fieldSet.status),
    warnings: normalizeStringArray(fieldSet.warnings),
    errors: normalizeErrors(fieldSet.errors),
    createdAt,
    updatedAt: String(fieldSet.updatedAt || createdAt),
    schemaVersion: CANDIDATE_SCHEMA_VERSION
  };
}

function normalizeCandidateField(field = {}) {
  if (!isPlainObject(field)) return null;
  const createdAt = String(field.createdAt || new Date().toISOString());
  return {
    id: String(field.id || createId('candidate_field', `${field.stagedResultId}-${field.sourceFieldKey}`)),
    stagedResultId: String(field.stagedResultId || ''),
    taskId: String(field.taskId || ''),
    sourceFieldKey: String(field.sourceFieldKey || ''),
    targetFieldKey: String(field.targetFieldKey || 'unmapped'),
    label: String(field.label || field.sourceFieldKey || ''),
    value: cloneJsonValue(field.value),
    normalizedValue: cloneJsonValue(field.normalizedValue),
    confidence: Number.isFinite(Number(field.confidence)) ? Number(field.confidence) : null,
    status: normalizeFieldStatus(field.status),
    source: 'recognition_proposed_fields',
    reason: String(field.reason || ''),
    warning: String(field.warning || ''),
    error: String(field.error || ''),
    canApply: field.canApply === true,
    requiresReview: true,
    allowAutoApply: false,
    existingValue: field.existingValue === undefined ? null : cloneJsonValue(field.existingValue),
    hasConflict: field.hasConflict === true,
    conflictReason: String(field.conflictReason || ''),
    createdAt,
    updatedAt: String(field.updatedAt || createdAt),
    schemaVersion: CANDIDATE_SCHEMA_VERSION
  };
}

function normalizeCandidateValue(value, valueType = 'unknown') {
  if (valueType === 'string') return { value: String(value || '').trim(), warning: '' };
  if (valueType === 'number') {
    const number = Number(value);
    return Number.isFinite(number) ? { value: number, warning: '' } : { value, warning: '候选值不是明确数字。' };
  }
  if (valueType === 'date') {
    const text = String(value || '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? { value: text, warning: '' } : { value, warning: '候选值不是明确日期。' };
  }
  if (valueType === 'datetime') {
    const text = String(value || '').trim();
    const date = text.match(/^\d{4}-\d{2}-\d{2}/)?.[0] || '';
    return date ? { value: date, warning: '' } : { value, warning: '候选值不是明确日期时间。' };
  }
  if (valueType === 'array') return { value: Array.isArray(value) ? value : normalizeStringArray(value), warning: '' };
  if (valueType === 'boolean') {
    if (value === true || value === false) return { value, warning: '' };
    return { value, warning: '候选值不是明确布尔值。' };
  }
  if (valueType === 'object') return { value: isPlainObject(value) ? cloneJsonValue(value) : {}, warning: isPlainObject(value) ? '' : '候选值不是对象。' };
  return { value: cloneJsonValue(value), warning: '' };
}

function normalizeFieldStatus(status = '') {
  const value = String(status || '').trim();
  return CANDIDATE_FIELD_STATUSES.has(value) ? value : 'pending_review';
}

function normalizeFieldSetStatus(status = '') {
  const value = String(status || '').trim();
  return CANDIDATE_FIELD_SET_STATUSES.has(value) ? value : 'empty';
}

function limitFieldSets(fieldSets = []) {
  return fieldSets.map(normalizeCandidateFieldSet).filter(Boolean).sort(sortByCreatedDesc).slice(0, MAX_CANDIDATE_FIELD_SETS);
}

function sortByCreatedDesc(a, b) {
  return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
}

function normalizeLimit(limit) {
  const value = Number(limit);
  if (!Number.isFinite(value) || value <= 0) return MAX_CANDIDATE_FIELD_SETS;
  return Math.min(Math.floor(value), MAX_CANDIDATE_FIELD_SETS);
}

function normalizeKey(key = '') {
  return String(key || '').trim();
}

function normalizePath(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeStringArray(values = []) {
  return Array.from(new Set((Array.isArray(values) ? values : [values])
    .flatMap((item) => String(item || '').split(/[、,，;；]/))
    .map((item) => item.trim())
    .filter(Boolean)));
}

function normalizeErrors(errors = []) {
  return (Array.isArray(errors) ? errors : [errors]).map((error) => {
    if (!error) return null;
    if (typeof error === 'string') return { code: 'recognition_mapping_error', message: error };
    return {
      code: String(error.code || 'recognition_mapping_error'),
      message: String(error.message || '')
    };
  }).filter((error) => error?.message);
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

function logInfo(message, payload = {}) {
  const summary = payload.id ? ` id=${payload.id}` : '';
  console.info(`[recognition-mapping] ${message}${summary}`);
}

function logError(message, error = {}) {
  console.warn(`[recognition-mapping] ${message}: ${error.message || 'unknown error'}`);
}

module.exports = {
  CANDIDATE_FIELD_SET_FILE_NAME,
  getRecognitionFieldMappingRules,
  getRecognitionFieldMappingRule,
  buildCandidateFieldSetFromStagedResult,
  normalizeProposedFields,
  mapProposedFieldsToCandidates,
  getCandidateFieldSet,
  getCandidateFieldSetByStagedResult,
  getCandidateFieldSetByPhoto,
  listCandidateFieldSets,
  clearCandidateFieldSet,
  clearCandidateFieldSetsByPhoto,
  clearAllCandidateFieldSets
};
