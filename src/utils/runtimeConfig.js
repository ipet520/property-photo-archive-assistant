export const FALLBACK_RUNTIME_CONFIGS = {
  projects: ['潇湘新区二期', '香辰康园', '其他'],
  projectOptions: [
    { id: 'project-潇湘新区二期-1', name: '潇湘新区二期' },
    { id: 'project-香辰康园-2', name: '香辰康园' },
    { id: 'project-其他-3', name: '其他' }
  ],
  constructionUnits: [],
  departments: ['工程', '客服', '秩序', '环境', '综合'],
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
  keywords: ['现场', '巡查', '维修', '清理', '安全隐患', '复查']
};

export function withRuntimeConfigFallback(configs) {
  const source = configs || {};
  const watermarkCategories = normalizeWatermarkRuntime(source.watermarkCategories);
  const projects = nonEmptyList(source.projects, FALLBACK_RUNTIME_CONFIGS.projects);
  const projectOptions = normalizeProjectOptions(source.projectOptions, projects);
  return {
    projects,
    projectOptions,
    constructionUnits: normalizeConstructionUnits(source.constructionUnits),
    departments: nonEmptyList(source.departments, FALLBACK_RUNTIME_CONFIGS.departments),
    watermarkCategories: Object.keys(watermarkCategories).length ? watermarkCategories : FALLBACK_RUNTIME_CONFIGS.watermarkCategories,
    keywords: nonEmptyList(source.keywords, FALLBACK_RUNTIME_CONFIGS.keywords)
  };
}

function normalizeProjectOptions(value, projects) {
  const items = (Array.isArray(value) ? value : [])
    .map((item) => ({
      id: String(item?.id || '').trim(),
      name: String(item?.name || '').trim()
    }))
    .filter((item) => item.id && item.name && projects.includes(item.name));
  if (items.length === projects.length) return items;
  return projects.map((name, index) => (
    items.find((item) => item.name === name)
    || { id: `project-runtime-${index + 1}`, name }
  ));
}

function normalizeConstructionUnits(value) {
  return (Array.isArray(value) ? value : []).map((item) => ({
    id: String(item?.id || '').trim(),
    name: String(item?.name || '').trim(),
    aliases: uniqueStrings(item?.aliases),
    enabled: item?.enabled !== false,
    projectIds: uniqueStrings(item?.projectIds)
  })).filter((item) => item.id && item.name);
}

function uniqueStrings(value) {
  const source = Array.isArray(value) ? value : [];
  return Array.from(new Set(source.map((item) => String(item || '').trim()).filter(Boolean)));
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
  if (settings?.photoSourceDirectory != null) {
    return String(settings.photoSourceDirectory || '').trim();
  }
  if (settings?.pathStatus?.lastPhotoFolderExists) return settings.lastPhotoFolder;
  if (settings?.pathStatus?.defaultPhotoFolderExists) return settings.defaultPhotoFolder;
  return '';
}

export function getUsableArchiveRoot(settings) {
  if (settings?.archiveRootDirectory != null) {
    return String(settings.archiveRootDirectory || '').trim();
  }
  if (settings?.pathStatus?.defaultArchiveRootExists) return settings.defaultArchiveRoot;
  if (settings?.pathStatus?.lastArchiveRootExists) return settings.lastArchiveRoot;
  return '';
}

export function normalizeRuntimeConfiguration(runtimeConfiguration) {
  const source = runtimeConfiguration || {};
  return {
    schemaVersion: Number(source.schemaVersion) || 1,
    revision: String(source.revision || ''),
    loadedFrom: String(source.loadedFrom || ''),
    migratedFrom: String(source.migratedFrom || ''),
    validationWarnings: Array.isArray(source.validationWarnings) ? source.validationWarnings : [],
    photoSourceDirectory: String(source.photoSourceDirectory || '').trim(),
    archiveRootDirectory: String(source.archiveRootDirectory || '').trim(),
    archivePackageDirectory: String(source.archivePackageDirectory || '').trim(),
    configs: withRuntimeConfigFallback(source.configs),
    settings: source.settings && typeof source.settings === 'object' ? source.settings : {}
  };
}

function nonEmptyList(value, fallback) {
  const list = Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [];
  return list.length ? list : fallback;
}

function normalizeWatermarkRuntime(value) {
  const entries = Object.entries(value || {}).filter(([name, category]) => {
    return String(name || '').trim() && Array.isArray(category?.items) && category.items.length > 0;
  });
  return Object.fromEntries(entries);
}
