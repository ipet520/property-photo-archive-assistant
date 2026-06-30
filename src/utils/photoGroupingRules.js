import { buildArchiveSuggestion } from './archiveSuggestionRules.js';

const TIME_STRONG_MINUTES = 10;
const TIME_MEDIUM_MINUTES = 30;
const MAX_REASONABLE_GROUP_SIZE = 50;

export function buildPhotoGroups(photos = [], context = {}) {
  const candidates = photos.filter((photo) => !['archived', 'ignored'].includes(photo.sortStatus));
  if (candidates.length === 0) return [];

  const sorted = [...candidates].sort((a, b) => getPhotoTime(a) - getPhotoTime(b));
  const keywordSet = buildKeywordSet(context);
  const groups = [];
  let current = [];

  sorted.forEach((photo) => {
    if (current.length === 0) {
      current.push(photo);
      return;
    }
    const previous = current[current.length - 1];
    if (shouldJoinGroup(previous, photo, keywordSet)) {
      current.push(photo);
      return;
    }
    groups.push(current);
    current = [photo];
  });
  if (current.length > 0) groups.push(current);

  const mapped = groups.map((items, index) => buildGroup(items, index, context, keywordSet, candidates.length));
  const validGroups = mapped.filter((group) => isValidGroup(group, candidates.length));
  const confident = validGroups.filter((group) => group.confidence !== 'ungrouped');
  const invalidPhotoIds = new Set(validGroups.flatMap((group) => group.photoIds));
  const ungroupedPhotos = candidates.filter((photo) => !invalidPhotoIds.has(photo.id));
  const result = confident;

  if (result.length === 0) return [];

  if (ungroupedPhotos.length > 0) {
    result.push(buildUngroupedGroup(ungroupedPhotos, result.length, context));
  }

  return result;
}

export function createManualGroup(photos = [], index = 0, context = {}, name = '') {
  return {
    ...buildGroup(photos, index, context, buildKeywordSet(context)),
    id: `manual-${Date.now()}-${index}`,
    name: name || `拆分组 ${index + 1}`,
    confidence: 'manual',
    confidenceLabel: '待人工确认',
    reasons: ['用户手动拆分'],
    basis: '用户手动拆分形成，请人工确认。',
    requiresHumanConfirmation: true
  };
}

export function buildUngroupedGroup(photos = [], index = 0, context = {}) {
  const suggestion = buildArchiveSuggestion({
    ...context.form,
    scene: context.scene,
    historyRecords: context.historyRecords,
    extraSources: ['分组建议']
  }, context.configs || {});
  return {
    id: `ungrouped-${index}`,
    name: '未分组照片',
    photos,
    photoIds: photos.map((photo) => photo.id),
    confidence: 'ungrouped',
    confidenceLabel: '待人工确认',
    reasons: ['暂未匹配到明确事项'],
    basis: '以下照片暂未匹配到明确事项，请人工确认后处理。',
    suggestion: {
      ...suggestion,
      sources: unique(['分组建议', ...(suggestion.sources || [])]),
      confidenceText: '当前照片缺少足够信息，暂未形成明确分组。您仍可手动选择照片进行归档。'
    },
    requiresHumanConfirmation: true
  };
}

function buildGroup(photos, index, context, keywordSet, totalCount) {
  const first = photos[0];
  const last = photos[photos.length - 1] || first;
  const timeGap = Math.max(0, (getPhotoTime(last) - getPhotoTime(first)) / 60000);
  const sceneHits = photos.filter((photo) => matchesKeywords(photo, keywordSet)).length;
  const pathSimilar = hasSimilarPath(photos);
  const nameSimilar = hasSimilarName(photos);
  const reasons = buildReasons({ photos, timeGap, sceneHits, pathSimilar, nameSimilar, context });
  const confidence = getConfidence({ photos, timeGap, sceneHits, pathSimilar, nameSimilar, context, totalCount });
  const confidenceLabel = confidence === 'high' ? '高匹配' : confidence === 'medium' ? '中匹配' : confidence === 'low' ? '低匹配' : '待人工确认';
  const scene = context.scene || null;
  const form = context.form || {};
  const fallbackTitle = scene?.title || form.workContent || inferNameFromPhotos(photos) || `疑似事项组 ${index + 1}`;
  const suggestion = buildArchiveSuggestion({
    ...form,
    watermarkCategory: form.watermarkCategory || scene?.watermarkCategory,
    workContent: form.workContent || scene?.workContent || fallbackTitle,
    scene,
    historyRecords: context.historyRecords,
    extraSources: ['分组建议']
  }, context.configs || {});

  return {
    id: `group-${index}-${photos.map((photo) => photo.id).join('-')}`,
    name: confidence === 'ungrouped' ? '未分组照片' : fallbackTitle,
    photos,
    photoIds: photos.map((photo) => photo.id),
    confidence,
    confidenceLabel,
    reasons,
    basis: reasons.join('；') || '规则分组结果，请人工确认。',
    suggestion: {
      ...suggestion,
      sources: unique(['分组建议', ...(suggestion.sources || [])])
    },
    requiresHumanConfirmation: true
  };
}

function shouldJoinGroup(previous, current, keywordSet) {
  const diffMinutes = Math.abs(getPhotoTime(current) - getPhotoTime(previous)) / 60000;
  const keywordMatched = matchesKeywords(current, keywordSet) && matchesKeywords(previous, keywordSet);
  if (diffMinutes <= TIME_STRONG_MINUTES && (keywordMatched || sameNamePrefix(previous, current))) return true;
  if (diffMinutes <= TIME_MEDIUM_MINUTES && keywordMatched) return true;
  if (diffMinutes <= TIME_MEDIUM_MINUTES && sameNamePrefix(previous, current)) return true;
  return false;
}

function getConfidence({ photos, timeGap, sceneHits, pathSimilar, nameSimilar, context, totalCount }) {
  const hasScene = Boolean(context.scene?.title || context.activeSceneTitle);
  const tooLarge = photos.length > Math.max(MAX_REASONABLE_GROUP_SIZE, Math.floor(totalCount * 0.5));
  const hasStrongKeyword = sceneHits > 0 || hasScene || nameSimilar;
  if (tooLarge && !hasStrongKeyword) return 'ungrouped';
  if (photos.length >= 2 && timeGap <= TIME_STRONG_MINUTES && sceneHits > 0 && (hasScene || nameSimilar)) return 'high';
  if (photos.length >= 2 && ((timeGap <= TIME_MEDIUM_MINUTES && sceneHits > 0) || (nameSimilar && (sceneHits > 0 || timeGap <= TIME_STRONG_MINUTES)))) return 'medium';
  if (photos.length >= 2 && (sceneHits > 0 || nameSimilar)) return 'low';
  return 'ungrouped';
}

function buildReasons({ photos, timeGap, sceneHits, pathSimilar, nameSimilar, context }) {
  return [
    photos.length > 1 && timeGap <= TIME_STRONG_MINUTES && `时间间隔 ${Math.ceil(timeGap)} 分钟内`,
    photos.length > 1 && timeGap > TIME_STRONG_MINUTES && timeGap <= TIME_MEDIUM_MINUTES && `时间间隔 ${Math.ceil(timeGap)} 分钟内`,
    context.scene?.title && `当前场景：${context.scene.title}`,
    sceneHits > 0 && `${sceneHits} 张照片命中文件名/路径关键词`,
    pathSimilar && '同一目录参考',
    nameSimilar && '文件名前缀相近'
  ].filter(Boolean);
}

function isValidGroup(group, totalCount) {
  if (group.confidence === 'ungrouped') return false;
  if (group.photos.length > Math.floor(totalCount * 0.5)) return false;
  if (group.photos.length > MAX_REASONABLE_GROUP_SIZE && !group.reasons.some((reason) => /关键词|场景|前缀/.test(reason))) return false;
  if (group.reasons.length === 1 && group.reasons[0] === '同一目录参考') return false;
  return true;
}

function buildKeywordSet(context = {}) {
  const scene = context.scene || {};
  const form = context.form || {};
  return unique([
    scene.title,
    scene.watermarkCategory,
    scene.workContent,
    ...(scene.keywords || []),
    form.watermarkCategory,
    form.workContent,
    form.itemName,
    form.keywords
  ].flatMap(splitKeywords));
}

function matchesKeywords(photo, keywords) {
  if (!keywords.length) return false;
  const haystack = normalize([photo.originalName, photo.name, photo.originalPath, photo.path, photo.archiveInfo?.workContent, photo.archiveInfo?.itemName].filter(Boolean).join(' '));
  return keywords.some((keyword) => haystack.includes(normalize(keyword)));
}

function sameDirectory(a, b) {
  return getDirectory(a) && getDirectory(a) === getDirectory(b);
}

function sameNamePrefix(a, b) {
  const left = getNamePrefix(a.originalName || a.name);
  const right = getNamePrefix(b.originalName || b.name);
  return left && right && left === right;
}

function hasSimilarPath(photos) {
  if (photos.length < 2) return false;
  const directories = new Set(photos.map(getDirectory).filter(Boolean));
  return directories.size === 1;
}

function hasSimilarName(photos) {
  if (photos.length < 2) return false;
  const prefixes = new Set(photos.map((photo) => getNamePrefix(photo.originalName || photo.name)).filter(Boolean));
  return prefixes.size === 1;
}

function inferNameFromPhotos(photos) {
  const prefix = getNamePrefix(photos[0]?.originalName || photos[0]?.name);
  return prefix ? `${prefix}事项` : '';
}

function getPhotoTime(photo) {
  const value = Date.parse(photo.modifiedAt || photo.createdAt || photo.time || '');
  return Number.isFinite(value) ? value : 0;
}

function getDirectory(photo) {
  const value = String(photo.originalPath || photo.path || '');
  const index = Math.max(value.lastIndexOf('\\'), value.lastIndexOf('/'));
  return index >= 0 ? value.slice(0, index) : '';
}

function getNamePrefix(name = '') {
  return String(name || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]?\d{3,}$/g, '')
    .replace(/\d{8,}/g, '')
    .trim()
    .slice(0, 18);
}

function splitKeywords(value) {
  if (Array.isArray(value)) return value.flatMap(splitKeywords);
  return String(value || '').split(/[、,，;；\s/]+/).map((item) => item.trim()).filter(Boolean);
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, '');
}

function unique(values = []) {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
}
