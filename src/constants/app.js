export const APP_VERSION = '2.2.1';
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
      { key: PAGE_KEYS.dashboard, label: '首页总览', icon: 'dashboard' },
      { key: PAGE_KEYS.quickArchive, label: '快速批量归档', icon: 'archive' },
      { key: PAGE_KEYS.sortWorkspace, label: '照片分拣工作台', icon: 'grid' }
    ]
  },
  {
    title: '查询与资料',
    items: [
      { key: PAGE_KEYS.searchCenter, label: '归档记录', icon: 'records' },
      { key: PAGE_KEYS.rectificationCenter, label: '整改闭环中心', icon: 'wrench' },
      { key: PAGE_KEYS.reportCenter, label: '资料汇总中心', icon: 'chart' }
    ]
  },
  {
    title: '管理',
    items: [
      { key: PAGE_KEYS.dataMaintenance, label: '数据维护中心', icon: 'database' },
      { key: PAGE_KEYS.settings, label: '系统设置', icon: 'settings' }
    ]
  }
];

export const PAGE_TITLES = {
  ...Object.fromEntries(
    NAV_GROUPS.flatMap((group) => group.items.map((item) => [item.key, item.label]))
  ),
  [PAGE_KEYS.configCenter]: '系统设置'
};
