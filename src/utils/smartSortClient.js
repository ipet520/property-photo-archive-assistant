function getSmartSortApi() {
  return window.archiveAssistant?.smartSort || null;
}

export async function generateSmartSortGroups(photos = [], options = {}) {
  try {
    const api = getSmartSortApi();
    if (!api?.generateGroups) return createFailedResult('智能分拣分组接口不可用。');
    return normalizeGroupingResult(await api.generateGroups({ photos, options }));
  } catch (error) {
    return createFailedResult(error.message || '智能分拣分组生成失败。');
  }
}

export async function getSmartSortGroupingResult() {
  try {
    const api = getSmartSortApi();
    const result = api?.getGroupingResult ? await api.getGroupingResult() : null;
    return result ? normalizeGroupingResult(result) : null;
  } catch {
    return null;
  }
}

export async function listSmartSortGroups() {
  try {
    const api = getSmartSortApi();
    const groups = api?.listGroups ? await api.listGroups() : [];
    return Array.isArray(groups) ? groups.map(normalizeGroup).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export async function getSmartSortGroup(id = '') {
  try {
    const api = getSmartSortApi();
    const group = api?.getGroup ? await api.getGroup(id) : null;
    return group ? normalizeGroup(group) : null;
  } catch {
    return null;
  }
}

export async function updateSmartSortGroupStatus(id = '', status = 'pending') {
  try {
    const api = getSmartSortApi();
    const group = api?.updateGroupStatus ? await api.updateGroupStatus(id, status) : null;
    return group ? normalizeGroup(group) : null;
  } catch {
    return null;
  }
}

export async function clearSmartSortGroups() {
  try {
    const api = getSmartSortApi();
    return api?.clearGroups ? Boolean(await api.clearGroups()) : false;
  } catch {
    return false;
  }
}

export function normalizeGroupingResult(result = {}) {
  const groups = Array.isArray(result?.groups) ? result.groups.map(normalizeGroup).filter(Boolean) : [];
  return {
    id: String(result?.id || ''),
    source: result?.source || 'current_photo_list',
    groupCount: Number.isFinite(Number(result?.groupCount)) ? Number(result.groupCount) : groups.length,
    photoCount: Number.isFinite(Number(result?.photoCount)) ? Number(result.photoCount) : groups.reduce((sum, group) => sum + group.photoCount, 0),
    groups,
    rules: Array.isArray(result?.rules) ? result.rules : [],
    status: result?.status || (groups.length ? 'created' : 'empty'),
    warnings: Array.isArray(result?.warnings) ? result.warnings : [],
    errors: Array.isArray(result?.errors) ? result.errors : [],
    createdAt: result?.createdAt || '',
    updatedAt: result?.updatedAt || '',
    schemaVersion: 1
  };
}

function normalizeGroup(group = {}) {
  if (!group || typeof group !== 'object') return null;
  const photos = Array.isArray(group.photos) ? group.photos.map(normalizePhoto).filter(Boolean) : [];
  return {
    id: String(group.id || ''),
    title: String(group.title || '分拣组'),
    status: group.status || 'pending',
    basis: group.basis || 'selection_order',
    photos,
    photoCount: Number.isFinite(Number(group.photoCount)) ? Number(group.photoCount) : photos.length,
    timeRange: group.timeRange || { start: null, end: null },
    summary: {
      basisLabel: String(group.summary?.basisLabel || '按当前照片列表顺序分组'),
      confidenceLabel: group.summary?.confidenceLabel || 'low',
      hasRecognitionData: Boolean(group.summary?.hasRecognitionData),
      hasCandidateFields: Boolean(group.summary?.hasCandidateFields),
      hasPatchDraft: Boolean(group.summary?.hasPatchDraft)
    },
    suggestedFields: {},
    warnings: Array.isArray(group.warnings) ? group.warnings : [],
    errors: Array.isArray(group.errors) ? group.errors : [],
    createdAt: group.createdAt || '',
    updatedAt: group.updatedAt || '',
    schemaVersion: 1
  };
}

function normalizePhoto(photo = {}) {
  const filePath = String(photo.filePath || '').trim();
  if (!filePath) return null;
  return {
    photoId: photo.photoId || '',
    filePath,
    fileName: String(photo.fileName || filePath.split(/[\\/]/).pop() || ''),
    index: Number.isFinite(Number(photo.index)) ? Number(photo.index) : undefined,
    capturedAt: photo.capturedAt || null,
    modifiedAt: photo.modifiedAt || null,
    source: 'photo_list',
    createdAt: photo.createdAt || '',
    schemaVersion: 1
  };
}

function createFailedResult(message) {
  return normalizeGroupingResult({
    id: '',
    source: 'current_photo_list',
    groupCount: 0,
    photoCount: 0,
    groups: [],
    rules: [],
    status: 'failed',
    warnings: [],
    errors: [{ code: 'smart_sort_client_error', message }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    schemaVersion: 1
  });
}
