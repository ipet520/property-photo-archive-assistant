export const SORT_STATUSES = {
  unassigned: 'unassigned',
  assigned: 'assigned',
  archived: 'archived',
  failed: 'failed'
};

// 照片分拣工作台的统一字段约定。
export const FUTURE_SORT_PHOTO_SHAPE = {
  id: '',
  sourcePath: '',
  originalName: '',
  extension: '',
  size: 0,
  mtime: '',
  exifDate: '',
  thumbnail: '',
  sortStatus: SORT_STATUSES.unassigned,
  archiveInfo: {
    project: '',
    department: '',
    photoSource: '',
    watermarkCategory: '',
    workContent: '',
    date: '',
    location: '',
    workItem: '',
    photoStage: '',
    processStatus: '',
    keywords: '',
    remark: ''
  },
  targetPath: '',
  targetName: '',
  error: ''
};
