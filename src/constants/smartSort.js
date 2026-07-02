export const SMART_SORT_SCHEMA_VERSION = 1;

export const SMART_SORT_GROUP_STATUS_LABELS = {
  pending: '待处理',
  viewed: '已查看',
  ignored: '已忽略',
  confirmed_later: '稍后确认',
  cleared: '已清除'
};

export const SMART_SORT_GROUP_BASIS_LABELS = {
  time_window: '按照片时间接近自动分组',
  folder_batch: '按当前导入目录批次分组',
  selection_order: '按当前照片列表顺序分组',
  existing_metadata: '按已有元数据辅助分组',
  recognition_status: '按已有识别数据状态辅助分组',
  mixed: '混合依据分组'
};

export const SMART_SORT_CONFIDENCE_LABELS = {
  low: '低',
  medium: '中',
  high: '高'
};
