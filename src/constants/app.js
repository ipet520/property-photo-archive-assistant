export const APP_VERSION = '1.4.1';
export const APP_NAME = '物业工作照片归档助手';

export const PAGE_KEYS = {
  dashboard: 'dashboard',
  quickArchive: 'quickArchive',
  sortWorkspace: 'sortWorkspace',
  searchCenter: 'searchCenter',
  rectificationCenter: 'rectificationCenter',
  reportCenter: 'reportCenter',
  configCenter: 'configCenter',
  dataMaintenance: 'dataMaintenance',
  settings: 'settings'
};

export const NAV_GROUPS = [
  {
    title: '工作台',
    items: [
      { key: PAGE_KEYS.dashboard, label: '首页总览', marker: '总' },
      { key: PAGE_KEYS.quickArchive, label: '快速批量归档', marker: '归' },
      { key: PAGE_KEYS.sortWorkspace, label: '照片分拣工作台', marker: '拣' }
    ]
  },
  {
    title: '查询与资料',
    items: [
      { key: PAGE_KEYS.searchCenter, label: '归档记录', marker: '查' },
      { key: PAGE_KEYS.rectificationCenter, label: '整改闭环中心', marker: '改' },
      { key: PAGE_KEYS.reportCenter, label: '资料汇总中心', marker: '汇' }
    ]
  },
  {
    title: '管理',
    items: [
      { key: PAGE_KEYS.configCenter, label: '配置管理中心', marker: '配' },
      { key: PAGE_KEYS.dataMaintenance, label: '数据维护中心', marker: '维' },
      { key: PAGE_KEYS.settings, label: '系统设置', marker: '设' }
    ]
  }
];

export const PAGE_TITLES = Object.fromEntries(
  NAV_GROUPS.flatMap((group) => group.items.map((item) => [item.key, item.label]))
);
