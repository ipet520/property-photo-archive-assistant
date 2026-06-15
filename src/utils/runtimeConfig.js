export const FALLBACK_RUNTIME_CONFIGS = {
  projects: ['潇湘新区二期', '香辰康园', '其他'],
  departments: ['工程', '客服', '秩序', '环境', '综合'],
  photoSources: ['马克水印相机', '手机拍摄', '微信接收', '业主提供', '外委单位提供', '其他'],
  watermarkCategories: {
    工程类专用: {
      description: '用于维修、施工、维保、设施设备处理等工程类工作。',
      fallbackTip: '',
      isFallback: false,
      items: ['公共设施设备维修'],
      itemMeta: {
        公共设施设备维修: {
          keywords: ['公共设施', '设备维修', '工程维修'],
          remarkTemplate: '位置/区域发现相关设施设备问题，已安排工程人员处理。'
        }
      }
    },
    安全管理类: {
      description: '用于秩序维护、安全隐患治理和现场管控。',
      fallbackTip: '',
      isFallback: false,
      items: ['楼道杂物清理', '飞线充电治理', '消防通道违停'],
      itemMeta: {
        楼道杂物清理: { keywords: ['楼道杂物', '清理', '安全隐患'], remarkTemplate: '位置/区域发现楼道杂物，已通知相关业主清理，后续将跟进复查。' },
        飞线充电治理: { keywords: ['飞线充电', '安全隐患', '劝阻'], remarkTemplate: '位置/区域发现飞线充电现象，现场已进行劝阻并提醒安全风险。' },
        消防通道违停: { keywords: ['消防通道', '违停', '车辆管理'], remarkTemplate: '位置/区域发现车辆占用消防通道，已联系车主挪移并做好现场记录。' }
      }
    }
  },
  photoStages: ['现场照片', '处理前', '处理中', '处理后', '复查照片'],
  processStatuses: ['待处理', '已处理', '已劝阻', '已完成', '需跟进'],
  keywords: ['现场', '巡查', '维修', '清理', '安全隐患', '复查'],
  sceneExamples: [
    {
      title: '楼道杂物清理',
      watermarkCategory: '安全管理类',
      workContent: '楼道杂物清理',
      itemName: '楼道杂物清理',
      locationPlaceholder: '如：3栋1单元楼道',
      processStatus: '待处理',
      photoStage: '现场照片',
      keywords: ['楼道杂物', '清理', '安全隐患'],
      remarkTemplate: '位置/区域发现楼道杂物，已通知相关业主清理，后续将跟进复查。'
    },
    {
      title: '公共设施设备维修',
      watermarkCategory: '工程类专用',
      workContent: '公共设施设备维修',
      itemName: '公共设施设备维修',
      locationPlaceholder: '如：小区公共区域',
      processStatus: '待处理',
      photoStage: '现场照片',
      keywords: ['公共设施', '设备维修', '工程维修'],
      remarkTemplate: '位置/区域发现相关设施设备问题，已安排工程人员处理。'
    }
  ]
};

export function withRuntimeConfigFallback(configs) {
  const source = configs || {};
  const watermarkCategories = normalizeWatermarkRuntime(source.watermarkCategories);
  return {
    projects: nonEmptyList(source.projects, FALLBACK_RUNTIME_CONFIGS.projects),
    departments: nonEmptyList(source.departments, FALLBACK_RUNTIME_CONFIGS.departments),
    photoSources: nonEmptyList(source.photoSources, FALLBACK_RUNTIME_CONFIGS.photoSources),
    watermarkCategories: Object.keys(watermarkCategories).length ? watermarkCategories : FALLBACK_RUNTIME_CONFIGS.watermarkCategories,
    photoStages: nonEmptyList(source.photoStages, FALLBACK_RUNTIME_CONFIGS.photoStages),
    processStatuses: nonEmptyList(source.processStatuses, FALLBACK_RUNTIME_CONFIGS.processStatuses),
    keywords: nonEmptyList(source.keywords, FALLBACK_RUNTIME_CONFIGS.keywords),
    sceneExamples: nonEmptyScenes(source.sceneExamples, FALLBACK_RUNTIME_CONFIGS.sceneExamples)
  };
}

export function getDefaultArchivePackageSettings(settings) {
  const packageSettings = settings?.archivePackageSettings || {};
  return {
    groupingRule: packageSettings.groupingRule || 'project/category/workContent',
    packageNamePrefix: packageSettings.packageNamePrefix || '物业照片资料包',
    generateReadme: packageSettings.generateReadme !== false,
    generateCatalog: packageSettings.generateCatalog !== false,
    promptOpenAfterGenerated: packageSettings.promptOpenAfterGenerated !== false
  };
}

export function getUsablePhotoFolder(settings) {
  if (settings?.pathStatus?.lastPhotoFolderExists) return settings.lastPhotoFolder;
  if (settings?.pathStatus?.defaultPhotoFolderExists) return settings.defaultPhotoFolder;
  return '';
}

export function getUsableArchiveRoot(settings) {
  if (settings?.pathStatus?.lastArchiveRootExists) return settings.lastArchiveRoot;
  if (settings?.pathStatus?.defaultArchiveRootExists) return settings.defaultArchiveRoot;
  return '';
}

function nonEmptyList(value, fallback) {
  const list = Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [];
  return list.length ? list : fallback;
}

function nonEmptyScenes(value, fallback) {
  const list = Array.isArray(value) ? value.filter((scene) => String(scene?.title || '').trim()) : [];
  return list.length ? list : fallback;
}

function normalizeWatermarkRuntime(value) {
  const entries = Object.entries(value || {}).filter(([name, category]) => {
    return String(name || '').trim() && Array.isArray(category?.items) && category.items.length > 0;
  });
  return Object.fromEntries(entries);
}
