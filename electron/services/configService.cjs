const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');

const APP_FOLDER_NAME = '物业工作照片归档助手';
const DEV_CONFIG_DIR = path.join(__dirname, '..', '..', 'config');
const MAX_BACKUPS = 30;

const CONFIG_FILES = {
  projects: 'projects.json',
  departments: 'departments.json',
  photoSources: 'photoSources.json',
  watermarkCategories: 'watermarkCategories.json',
  photoStages: 'photoStages.json',
  processStatuses: 'processStatuses.json',
  keywords: 'keywords.json',
  sceneExamples: 'sceneExamples.json'
};

const LEGACY_WORK_CONTENTS_FILE = 'workContents.json';

const SIMPLE_CONFIG_KEYS = new Set([
  'projects',
  'departments',
  'photoSources',
  'photoStages',
  'processStatuses',
  'keywords'
]);

function getDefaultConfigDir() {
  const packagedConfigDir = process.resourcesPath ? path.join(process.resourcesPath, 'config') : '';
  if (packagedConfigDir && fsSync.existsSync(packagedConfigDir)) {
    return packagedConfigDir;
  }
  return DEV_CONFIG_DIR;
}

function getConfigPaths(documentsPath) {
  const appDataDir = path.join(documentsPath, APP_FOLDER_NAME);
  return {
    defaultConfigDir: getDefaultConfigDir(),
    userConfigDir: path.join(appDataDir, 'config'),
    backupDir: path.join(appDataDir, 'config-backup'),
    settingsPath: path.join(appDataDir, 'settings.json')
  };
}

async function ensureUserConfigs(documentsPath) {
  const paths = getConfigPaths(documentsPath);
  await fs.mkdir(paths.userConfigDir, { recursive: true });

  await Promise.all(Object.values(CONFIG_FILES).map(async (fileName) => {
    const userFile = path.join(paths.userConfigDir, fileName);
    if (fsSync.existsSync(userFile)) return;
    await fs.copyFile(path.join(paths.defaultConfigDir, fileName), userFile);
  }));

  return paths;
}

async function loadUserConfigs(documentsPath) {
  const paths = await ensureUserConfigs(documentsPath);
  const configs = {};
  for (const [key, fileName] of Object.entries(CONFIG_FILES)) {
    const filePath = path.join(paths.userConfigDir, fileName);
    configs[key] = await readJsonFile(filePath);
  }
  await migrateLegacyWorkContentsIfNeeded(paths, configs);
  return {
    configs,
    editableConfigs: normalizeEditableConfigs(configs),
    runtimeConfigs: normalizeRuntimeConfigs(configs),
    paths
  };
}

async function loadConfigs(documentsPath) {
  const result = await loadUserConfigs(documentsPath);
  return result.runtimeConfigs;
}

async function saveUserConfig(documentsPath, configName, data) {
  if (!CONFIG_FILES[configName]) {
    throw new Error(`未知配置项：${configName}`);
  }
  validateConfig(configName, data);
  const paths = await ensureUserConfigs(documentsPath);
  await backupConfigs(documentsPath);
  await writeJsonFile(path.join(paths.userConfigDir, CONFIG_FILES[configName]), normalizeConfigForStorage(configName, data));
  return loadUserConfigs(documentsPath);
}

async function saveAllUserConfigs(documentsPath, configs) {
  const paths = await ensureUserConfigs(documentsPath);
  const normalized = {};
  for (const key of Object.keys(CONFIG_FILES)) {
    normalized[key] = normalizeConfigForStorage(key, configs[key]);
    validateConfig(key, normalized[key]);
  }

  await backupConfigs(documentsPath);
  await Promise.all(Object.entries(CONFIG_FILES).map(([key, fileName]) => (
    writeJsonFile(path.join(paths.userConfigDir, fileName), normalized[key])
  )));
  return loadUserConfigs(documentsPath);
}

async function resetConfigsToDefault(documentsPath) {
  const paths = await ensureUserConfigs(documentsPath);
  await backupConfigs(documentsPath);
  await Promise.all(Object.values(CONFIG_FILES).map((fileName) => (
    fs.copyFile(path.join(paths.defaultConfigDir, fileName), path.join(paths.userConfigDir, fileName))
  )));
  return loadUserConfigs(documentsPath);
}

async function exportConfigs(documentsPath, targetFilePath) {
  const { configs } = await loadUserConfigs(documentsPath);
  const payload = {
    app: APP_FOLDER_NAME,
    version: 1,
    exportedAt: new Date().toISOString(),
    configs
  };
  await writeJsonFile(targetFilePath, payload);
  return { success: true, filePath: targetFilePath };
}

async function importConfigs(documentsPath, sourceFilePath) {
  const imported = await readJsonFile(sourceFilePath);
  const configs = imported.configs || imported;
  const nextConfigs = {};
  for (const key of Object.keys(CONFIG_FILES)) {
    if (!configs[key]) {
      throw new Error(`导入文件缺少配置：${key}`);
    }
    nextConfigs[key] = normalizeConfigForStorage(key, configs[key]);
  }
  if (configs.workContents) {
    nextConfigs.watermarkCategories = mergeLegacyWorkContents(nextConfigs.watermarkCategories, configs.workContents);
  }
  return saveAllUserConfigs(documentsPath, nextConfigs);
}

async function backupConfigs(documentsPath) {
  const paths = await ensureUserConfigs(documentsPath);
  await fs.mkdir(paths.backupDir, { recursive: true });
  const backupFile = path.join(paths.backupDir, `config-backup_${formatTimestamp()}.json`);
  const configs = {};
  for (const [key, fileName] of Object.entries(CONFIG_FILES)) {
    configs[key] = await readJsonFile(path.join(paths.userConfigDir, fileName));
  }
  await writeJsonFile(backupFile, {
    app: APP_FOLDER_NAME,
    version: 1,
    backedUpAt: new Date().toISOString(),
    configs
  });
  await cleanupOldBackups(paths.backupDir);
  return { success: true, backupFile, backupDir: paths.backupDir };
}

async function readJsonFile(filePath) {
  const content = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(content);
}

async function writeJsonFile(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function normalizeRuntimeConfigs(configs) {
  const editable = normalizeEditableConfigs(configs);
  return {
    projects: enabledNames(editable.projects),
    departments: enabledNames(editable.departments),
    photoSources: enabledNames(editable.photoSources),
    watermarkCategories: normalizeRuntimeWatermarkCategories(editable.watermarkCategories),
    photoStages: enabledNames(editable.photoStages),
    processStatuses: enabledNames(editable.processStatuses),
    keywords: enabledNames(editable.keywords),
    sceneExamples: editable.sceneExamples
      .filter((scene) => scene.enabled !== false)
      .sort(bySort)
      .map((scene) => ({
        title: scene.title || scene.name,
        watermarkCategory: scene.watermarkCategory || '',
        workContent: scene.workContent || '',
        workItemSuggestion: scene.workItemSuggestion || '',
        processStatusSuggestion: scene.processStatusSuggestion || '',
        photoStageSuggestion: scene.photoStageSuggestion || '',
        keywords: normalizeKeywords(scene.keywords),
        remarkTemplate: scene.remarkTemplate || ''
      }))
  };
}

function normalizeEditableConfigs(configs) {
  const watermarkCategories = mergeLegacyWorkContents(configs.watermarkCategories, configs.workContents);
  return {
    projects: normalizeSimpleItems(configs.projects, 'project', { defaultName: '潇湘新区二期' }),
    departments: normalizeSimpleItems(configs.departments, 'department', { defaultName: '工程' }),
    photoSources: normalizeSimpleItems(configs.photoSources, 'photo-source'),
    watermarkCategories: normalizeWatermarkCategories(watermarkCategories),
    photoStages: normalizeSimpleItems(configs.photoStages, 'photo-stage', { defaultName: '现场照片' }),
    processStatuses: normalizeSimpleItems(configs.processStatuses, 'process-status', { defaultName: '待处理' }),
    keywords: normalizeSimpleItems(configs.keywords, 'keyword', { withGroup: true }),
    sceneExamples: normalizeSceneExamples(configs.sceneExamples)
  };
}

function normalizeConfigForStorage(configName, data) {
  if (SIMPLE_CONFIG_KEYS.has(configName)) {
    return normalizeSimpleItems(data, configName);
  }
  if (configName === 'watermarkCategories') {
    return normalizeWatermarkCategories(data);
  }
  if (configName === 'sceneExamples') {
    return normalizeSceneExamples(data);
  }
  return data;
}

function normalizeSimpleItems(data, idPrefix, options = {}) {
  const source = Array.isArray(data) ? data : [];
  return source.map((item, index) => {
    if (typeof item === 'string') {
      return {
        id: createId(idPrefix, item, index),
        name: item,
        enabled: true,
        sort: (index + 1) * 10,
        isDefault: options.defaultName ? item === options.defaultName : index === 0 && false,
        description: '',
        ...(options.withGroup ? { group: '' } : {})
      };
    }

    const name = String(item?.name || item?.title || '').trim();
    return {
      id: String(item?.id || createId(idPrefix, name, index)),
      name,
      enabled: item?.enabled !== false,
      sort: Number.isFinite(Number(item?.sort)) ? Number(item.sort) : (index + 1) * 10,
      isDefault: Boolean(item?.isDefault),
      description: String(item?.description || ''),
      ...(options.withGroup || item?.group !== undefined ? { group: String(item?.group || '') } : {})
    };
  }).filter((item) => item.name);
}

function normalizeWatermarkCategories(data) {
  if (Array.isArray(data)) {
    return data.map((category, index) => normalizeWatermarkCategory(category, index)).filter((item) => item.name);
  }

  return Object.entries(data || {}).map(([name, category], index) => normalizeWatermarkCategory({
    ...category,
    name,
    items: category?.items || []
  }, index)).filter((item) => item.name);
}

async function migrateLegacyWorkContentsIfNeeded(paths, configs) {
  const legacyWorkContentsPath = path.join(paths.userConfigDir, LEGACY_WORK_CONTENTS_FILE);
  if (!fsSync.existsSync(legacyWorkContentsPath)) return false;

  const legacyWorkContents = await readJsonFile(legacyWorkContentsPath);
  configs.workContents = legacyWorkContents;
  configs.watermarkCategories = mergeLegacyWorkContents(configs.watermarkCategories, legacyWorkContents);
  await backupConfigsFromPaths(paths);
  await writeJsonFile(path.join(paths.userConfigDir, CONFIG_FILES.watermarkCategories), normalizeWatermarkCategories(configs.watermarkCategories));
  await fs.rename(legacyWorkContentsPath, path.join(paths.userConfigDir, `${LEGACY_WORK_CONTENTS_FILE}.migrated-${formatTimestamp()}`));
  return true;
}

function mergeLegacyWorkContents(watermarkCategories, legacyWorkContents) {
  const categories = normalizeWatermarkCategories(watermarkCategories);
  const legacyItems = normalizeLegacyWorkContents(legacyWorkContents);
  if (legacyItems.length === 0) return categories;

  const categoriesById = new Map(categories.map((category) => [category.id, category]));
  const categoriesByName = new Map(categories.map((category) => [category.name, category]));
  let uncategorized = categoriesByName.get('未分类工作内容');

  legacyItems.forEach((legacyItem) => {
    const targetCategory = categoriesById.get(legacyItem.categoryId)
      || categoriesByName.get(legacyItem.categoryName);

    if (targetCategory) {
      appendWorkItemIfMissing(targetCategory, legacyItem);
      return;
    }

    if (!uncategorized) {
      uncategorized = {
        id: 'uncategorized-work-contents',
        name: '未分类工作内容',
        enabled: true,
        sort: 9999,
        isDefault: false,
        isFallback: true,
        description: '由旧版独立工作内容配置迁移生成，请人工归类到正确水印分类。',
        fallbackTip: '这些工作内容来自旧版独立配置，请人工归类。',
        items: []
      };
      categories.push(uncategorized);
      categoriesByName.set(uncategorized.name, uncategorized);
    }
    appendWorkItemIfMissing(uncategorized, legacyItem);
  });

  return categories;
}

function normalizeLegacyWorkContents(data) {
  return (Array.isArray(data) ? data : []).map((item, index) => {
    if (typeof item === 'string') {
      return {
        id: createId('legacy-work', item, index),
        name: item,
        enabled: true,
        sort: (index + 1) * 10,
        description: '',
        keywords: [],
        remarkTemplate: '',
        categoryId: '',
        categoryName: ''
      };
    }
    return {
      id: String(item?.id || createId('legacy-work', item?.name, index)),
      name: String(item?.name || '').trim(),
      enabled: item?.enabled !== false,
      sort: Number.isFinite(Number(item?.sort)) ? Number(item.sort) : (index + 1) * 10,
      description: String(item?.description || ''),
      keywords: normalizeKeywords(item?.keywords),
      remarkTemplate: String(item?.remarkTemplate || ''),
      categoryId: String(item?.categoryId || ''),
      categoryName: String(item?.categoryName || item?.watermarkCategory || '')
    };
  }).filter((item) => item.name);
}

function appendWorkItemIfMissing(category, workItem) {
  if (category.items.some((item) => item.name === workItem.name)) return;
  category.items.push({
    id: workItem.id,
    name: workItem.name,
    enabled: workItem.enabled,
    sort: workItem.sort,
    description: workItem.description,
    keywords: workItem.keywords,
    remarkTemplate: workItem.remarkTemplate
  });
}

function normalizeWatermarkCategory(category, index) {
  const name = String(category?.name || '').trim();
  return {
    id: String(category?.id || createId('watermark-category', name, index)),
    name,
    enabled: category?.enabled !== false,
    sort: Number.isFinite(Number(category?.sort)) ? Number(category.sort) : (index + 1) * 10,
    isDefault: Boolean(category?.isDefault),
    isFallback: Boolean(category?.isFallback),
    description: String(category?.description || ''),
    fallbackTip: String(category?.fallbackTip || ''),
    items: normalizeWorkItems(category?.items || [], name)
  };
}

function normalizeWorkItems(items, categoryName) {
  return (Array.isArray(items) ? items : []).map((item, index) => {
    if (typeof item === 'string') {
      return {
        id: createId(`${categoryName}-work`, item, index),
        name: item,
        enabled: true,
        sort: (index + 1) * 10,
        description: '',
        keywords: [],
        remarkTemplate: ''
      };
    }
    const name = String(item?.name || '').trim();
    return {
      id: String(item?.id || createId(`${categoryName}-work`, name, index)),
      name,
      enabled: item?.enabled !== false,
      sort: Number.isFinite(Number(item?.sort)) ? Number(item.sort) : (index + 1) * 10,
      description: String(item?.description || ''),
      keywords: normalizeKeywords(item?.keywords),
      remarkTemplate: String(item?.remarkTemplate || '')
    };
  }).filter((item) => item.name);
}

function normalizeSceneExamples(data) {
  return (Array.isArray(data) ? data : []).map((scene, index) => {
    const title = String(scene?.title || scene?.name || '').trim();
    return {
      id: String(scene?.id || createId('scene', title, index)),
      title,
      name: title,
      enabled: scene?.enabled !== false,
      sort: Number.isFinite(Number(scene?.sort)) ? Number(scene.sort) : (index + 1) * 10,
      watermarkCategory: String(scene?.watermarkCategory || ''),
      workContent: String(scene?.workContent || ''),
      workItemSuggestion: String(scene?.workItemSuggestion || ''),
      processStatusSuggestion: String(scene?.processStatusSuggestion || ''),
      photoStageSuggestion: String(scene?.photoStageSuggestion || ''),
      keywords: normalizeKeywords(scene?.keywords),
      remarkTemplate: String(scene?.remarkTemplate || '')
    };
  }).filter((scene) => scene.title);
}

function normalizeRuntimeWatermarkCategories(categories) {
  return Object.fromEntries(
    categories
      .filter((category) => category.enabled !== false)
      .sort(bySort)
      .map((category) => [
        category.name,
        {
          description: category.description || '',
          fallbackTip: category.fallbackTip || '',
          isFallback: Boolean(category.isFallback),
          items: category.items
            .filter((item) => item.enabled !== false)
            .sort(bySort)
            .map((item) => item.name),
          itemMeta: Object.fromEntries(category.items.map((item) => [item.name, item]))
        }
      ])
  );
}

function validateConfig(configName, data) {
  if (SIMPLE_CONFIG_KEYS.has(configName)) {
    validateNames(normalizeSimpleItems(data, configName), '名称');
  }
  if (configName === 'watermarkCategories') {
    const categories = normalizeWatermarkCategories(data);
    validateNames(categories, '水印分类名称');
    categories.forEach((category) => validateNames(category.items, `${category.name} 的工作内容名称`));
  }
  if (configName === 'sceneExamples') {
    validateNames(normalizeSceneExamples(data).map((scene) => ({ ...scene, name: scene.title })), '常见场景名称');
  }
  return { success: true };
}

function validateNames(items, label) {
  const names = new Set();
  items.forEach((item) => {
    if (!item.name) throw new Error(`${label}不能为空`);
    if (!Number.isFinite(Number(item.sort))) throw new Error(`${item.name} 的排序必须是有效数字`);
    const key = item.name.trim();
    if (names.has(key)) throw new Error(`${label}不能重复：${key}`);
    names.add(key);
  });
}

function enabledNames(items) {
  return items.filter((item) => item.enabled !== false).sort(bySort).map((item) => item.name);
}

function bySort(a, b) {
  return Number(a.sort || 0) - Number(b.sort || 0);
}

function normalizeKeywords(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  return String(value || '').split(/[、,，;；\s]+/).map((item) => item.trim()).filter(Boolean);
}

function createId(prefix, value, index) {
  const safe = String(value || 'item')
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${prefix}-${safe || 'item'}-${index + 1}`;
}

function formatTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const padMs = (value) => String(value).padStart(3, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '_',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    '_',
    padMs(date.getMilliseconds())
  ].join('');
}

async function cleanupOldBackups(backupDir) {
  const files = (await fs.readdir(backupDir))
    .filter((fileName) => fileName.endsWith('.json'))
    .map((fileName) => ({
      fileName,
      fullPath: path.join(backupDir, fileName),
      mtimeMs: fsSync.statSync(path.join(backupDir, fileName)).mtimeMs
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  await Promise.all(files.slice(MAX_BACKUPS).map((file) => fs.unlink(file.fullPath)));
}

async function backupConfigsFromPaths(paths) {
  await fs.mkdir(paths.backupDir, { recursive: true });
  const backupFile = path.join(paths.backupDir, `config-backup_${formatTimestamp()}.json`);
  const configs = {};
  for (const [key, fileName] of Object.entries(CONFIG_FILES)) {
    configs[key] = await readJsonFile(path.join(paths.userConfigDir, fileName));
  }
  await writeJsonFile(backupFile, {
    app: APP_FOLDER_NAME,
    version: 1,
    backedUpAt: new Date().toISOString(),
    reason: 'legacy-work-contents-migration',
    configs
  });
  await cleanupOldBackups(paths.backupDir);
  return { success: true, backupFile, backupDir: paths.backupDir };
}

module.exports = {
  CONFIG_FILES,
  loadConfigs,
  loadUserConfigs,
  saveUserConfig,
  saveAllUserConfigs,
  resetConfigsToDefault,
  exportConfigs,
  importConfigs,
  backupConfigs,
  getConfigPaths,
  validateConfig,
  normalizeRuntimeConfigs,
  normalizeEditableConfigs
};
