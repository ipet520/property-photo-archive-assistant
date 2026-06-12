const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');

const DEV_CONFIG_DIR = path.join(__dirname, '..', '..', 'config');

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

async function loadConfigs() {
  const configDir = resolveConfigDir();
  const entries = await Promise.all(
    Object.entries(CONFIG_FILES).map(async ([key, fileName]) => {
      const filePath = path.join(configDir, fileName);
      const content = await fs.readFile(filePath, 'utf-8');
      return [key, JSON.parse(content)];
    })
  );

  return Object.fromEntries(entries);
}

function resolveConfigDir() {
  const packagedConfigDir = process.resourcesPath
    ? path.join(process.resourcesPath, 'config')
    : '';

  if (packagedConfigDir && fsSync.existsSync(packagedConfigDir)) {
    return packagedConfigDir;
  }

  return DEV_CONFIG_DIR;
}

module.exports = { loadConfigs };
