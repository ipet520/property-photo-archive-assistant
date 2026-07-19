import {
  SMART_SORT_PHOTO_STAGE,
  classifyPhotoSmartSortStage,
  getPhotoSmartSortStatusLabel
} from './sourceAwareRecognition.js';

export const PHOTO_WORKFLOW_STAGE = Object.freeze({
  ORIGINAL_MISSING: 'original_missing',
  ARCHIVED: 'archived',
  ARCHIVING: 'archiving',
  IGNORED: 'ignored',
  LEDGER_PENDING: 'ledger_pending',
  TARGET_CONFLICT: 'target_conflict',
  ARCHIVE_FAILED: 'archive_failed',
  PREVIEWED: 'previewed',
  ORGANIZED: 'organized',
  RECOGNITION_ISSUE: 'recognition_issue',
  PENDING_SORT: 'pending_sort',
  PENDING_ORGANIZE: 'pending_organize',
  RUNNING: 'running',
  INCONSISTENT: 'inconsistent',
  EXCLUDED: 'excluded'
});

export function classifyPhotoWorkflowStage(photo = {}, isGroupMember = false) {
  if (photo?.originalMissing) return PHOTO_WORKFLOW_STAGE.ORIGINAL_MISSING;
  if (hasArchivedPhotoState(photo)) return PHOTO_WORKFLOW_STAGE.ARCHIVED;
  const sortStatus = cleanText(photo?.sortStatus);
  if (sortStatus === 'archiving') return PHOTO_WORKFLOW_STAGE.ARCHIVING;
  if (sortStatus === 'ignored') return PHOTO_WORKFLOW_STAGE.IGNORED;
  if (photo?.archiveResult?.stage === 'ledger_pending') {
    return PHOTO_WORKFLOW_STAGE.LEDGER_PENDING;
  }
  if (photo?.archiveResult?.stage === 'target_conflict') {
    return PHOTO_WORKFLOW_STAGE.TARGET_CONFLICT;
  }
  if (
    ['failed', 'archive_failed'].includes(sortStatus)
    || photo?.archiveResult?.status === '归档失败'
    || photo?.archiveResult?.success === false
  ) {
    return PHOTO_WORKFLOW_STAGE.ARCHIVE_FAILED;
  }
  if (sortStatus === 'previewed') return PHOTO_WORKFLOW_STAGE.PREVIEWED;
  if (photo?.archiveInfo || sortStatus === 'assigned') {
    return PHOTO_WORKFLOW_STAGE.ORGANIZED;
  }
  if (sortStatus === 'recognition_failed') {
    return PHOTO_WORKFLOW_STAGE.RECOGNITION_ISSUE;
  }

  const smartSortStage = classifyPhotoSmartSortStage(photo, isGroupMember);
  if (smartSortStage === SMART_SORT_PHOTO_STAGE.PENDING_SORT) {
    return PHOTO_WORKFLOW_STAGE.PENDING_SORT;
  }
  if (smartSortStage === SMART_SORT_PHOTO_STAGE.PENDING_ORGANIZE) {
    return PHOTO_WORKFLOW_STAGE.PENDING_ORGANIZE;
  }
  if (smartSortStage === SMART_SORT_PHOTO_STAGE.RUNNING) {
    return PHOTO_WORKFLOW_STAGE.RUNNING;
  }
  if (smartSortStage === SMART_SORT_PHOTO_STAGE.INCONSISTENT) {
    return PHOTO_WORKFLOW_STAGE.INCONSISTENT;
  }
  return PHOTO_WORKFLOW_STAGE.EXCLUDED;
}

export function getPhotoWorkflowStageLabel(photo = {}, isGroupMember = false) {
  const stage = classifyPhotoWorkflowStage(photo, isGroupMember);
  const labels = {
    [PHOTO_WORKFLOW_STAGE.ORIGINAL_MISSING]: '原图缺失',
    [PHOTO_WORKFLOW_STAGE.ARCHIVED]: '已归档',
    [PHOTO_WORKFLOW_STAGE.ARCHIVING]: '正在归档',
    [PHOTO_WORKFLOW_STAGE.IGNORED]: '已忽略',
    [PHOTO_WORKFLOW_STAGE.LEDGER_PENDING]: '台账待补记',
    [PHOTO_WORKFLOW_STAGE.TARGET_CONFLICT]: '目标冲突',
    [PHOTO_WORKFLOW_STAGE.ARCHIVE_FAILED]: '归档失败',
    [PHOTO_WORKFLOW_STAGE.PREVIEWED]: '已生成预览',
    [PHOTO_WORKFLOW_STAGE.ORGANIZED]: '待预览',
    [PHOTO_WORKFLOW_STAGE.RECOGNITION_ISSUE]: '识别失败'
  };
  return labels[stage] || getPhotoSmartSortStatusLabel(photo, isGroupMember) || '';
}

export function matchesPhotoWorkflowFilter({
  photo,
  filter = 'all',
  isGroupMember = false,
  selected = false
} = {}) {
  const stage = classifyPhotoWorkflowStage(photo, isGroupMember);
  if (filter === 'all') return true;
  if (filter === 'selected') return selected;
  if (filter === 'unarchived') {
    return ![
      PHOTO_WORKFLOW_STAGE.ARCHIVED,
      PHOTO_WORKFLOW_STAGE.IGNORED
    ].includes(stage);
  }
  if (filter === 'pending_sort') return stage === PHOTO_WORKFLOW_STAGE.PENDING_SORT;
  if (filter === 'pending_organize') return stage === PHOTO_WORKFLOW_STAGE.PENDING_ORGANIZE;
  if (filter === 'recognition_issue') return stage === PHOTO_WORKFLOW_STAGE.RECOGNITION_ISSUE;
  if (filter === 'original_missing') return stage === PHOTO_WORKFLOW_STAGE.ORIGINAL_MISSING;
  if (filter === 'previewed') return stage === PHOTO_WORKFLOW_STAGE.PREVIEWED;
  if (filter === 'archived') return stage === PHOTO_WORKFLOW_STAGE.ARCHIVED;
  if (filter === 'failed') return stage === PHOTO_WORKFLOW_STAGE.ARCHIVE_FAILED;
  if (filter === 'ignored') return stage === PHOTO_WORKFLOW_STAGE.IGNORED;
  return cleanText(photo?.sortStatus) === filter;
}

export function getWorkflowFilterCount(
  filter,
  photos = [],
  selectedIds = [],
  groupMembershipByPhotoId = new Map()
) {
  const selectedIdSet = new Set(selectedIds);
  return photos.filter((photo) => matchesPhotoWorkflowFilter({
    photo,
    filter,
    isGroupMember: groupMembershipByPhotoId.has(photo?.id),
    selected: selectedIdSet.has(photo?.id)
  })).length;
}

export function getVisibleWorkflowPhotos({
  photos = [],
  activeSmartGroupPhotoKeys = null,
  groupMembershipByPhotoId = new Map(),
  filter = 'all',
  searchText = '',
  selectedIds = [],
  sortMode = 'timeAsc'
} = {}) {
  const selectedIdSet = new Set(selectedIds);
  const keyword = cleanText(searchText).toLowerCase();
  return [...photos]
    .filter((photo) => {
      if (activeSmartGroupPhotoKeys) {
        return activeSmartGroupPhotoKeys.has(photo?.id)
          || activeSmartGroupPhotoKeys.has(photo?.originalPath);
      }
      return matchesPhotoWorkflowFilter({
        photo,
        filter,
        isGroupMember: groupMembershipByPhotoId.has(photo?.id),
        selected: selectedIdSet.has(photo?.id)
      });
    })
    .filter((photo) => {
      if (!keyword) return true;
      return [
        photo?.originalName,
        photo?.archiveInfo?.remark,
        photo?.archiveInfo?.workContent,
        photo?.archiveInfo?.location,
        photo?.archiveInfo?.keywords
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(keyword));
    })
    .sort((left, right) => comparePhotos(left, right, sortMode));
}

export function isPhotoWorkflowActionable(photo = {}, isGroupMember = false) {
  return ![
    PHOTO_WORKFLOW_STAGE.ORIGINAL_MISSING,
    PHOTO_WORKFLOW_STAGE.ARCHIVED,
    PHOTO_WORKFLOW_STAGE.ARCHIVING,
    PHOTO_WORKFLOW_STAGE.IGNORED,
    PHOTO_WORKFLOW_STAGE.LEDGER_PENDING
  ].includes(classifyPhotoWorkflowStage(photo, isGroupMember));
}

export function hasArchivedPhotoState(photo = {}) {
  return photo?.sortStatus === 'archived'
    || photo?.archiveResult?.status === '归档成功'
    || photo?.archiveResult?.success === true;
}

export function resolvePhotoDirectoryTarget({
  photos = [],
  activePhotoId = '',
  selectedIds = [],
  photoFolder = ''
} = {}) {
  const selectedIdSet = new Set(selectedIds);
  const photo = photos.find((item) => item?.id === activePhotoId)
    || photos.find((item) => selectedIdSet.has(item?.id))
    || null;
  if (photo?.sourceType === 'marki_api') {
    const managedDirectory = getParentDirectory(photo.originalPath);
    return managedDirectory
      ? { success: true, targetPath: managedDirectory, sourceType: 'marki_api' }
      : { success: false, code: 'marki_photo_directory_unavailable' };
  }
  const localDirectory = cleanText(photoFolder) || getParentDirectory(photo?.originalPath);
  return localDirectory
    ? { success: true, targetPath: localDirectory, sourceType: 'local_file' }
    : { success: false, code: 'photo_directory_unavailable' };
}

export function resolveArchiveDirectoryTarget(archiveRoot = '') {
  const targetPath = cleanText(archiveRoot);
  return targetPath
    ? { success: true, targetPath }
    : { success: false, code: 'archive_directory_unavailable' };
}

function comparePhotos(left, right, sortMode) {
  const leftName = cleanText(left?.originalName);
  const rightName = cleanText(right?.originalName);
  if (sortMode === 'nameAsc') return leftName.localeCompare(rightName, 'zh-CN');
  if (sortMode === 'nameDesc') return rightName.localeCompare(leftName, 'zh-CN');
  const leftTime = String(left?.modifiedAt || left?.capturedAt || '');
  const rightTime = String(right?.modifiedAt || right?.capturedAt || '');
  if (sortMode === 'timeDesc') return rightTime.localeCompare(leftTime);
  return leftTime.localeCompare(rightTime);
}

function getParentDirectory(filePath) {
  const normalized = String(filePath || '').trim().replaceAll('/', '\\');
  const separatorIndex = normalized.lastIndexOf('\\');
  return separatorIndex > 0 ? normalized.slice(0, separatorIndex) : '';
}

function cleanText(value) {
  return String(value == null ? '' : value).trim();
}
