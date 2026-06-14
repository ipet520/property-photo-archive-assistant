export const SORT_STATUSES = {
  unassigned: 'unassigned',
  assigned: 'assigned',
  archived: 'archived',
  failed: 'failed'
};

// V1.3.0 照片分拣工作台预留结构，当前版本只作为字段约定使用。
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
