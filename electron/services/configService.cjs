const fs = require('node:fs/promises');
const path = require('node:path');

const CONFIG_DIR = path.join(__dirname, '..', '..', 'config');

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
  const entries = await Promise.all(
    Object.entries(CONFIG_FILES).map(async ([key, fileName]) => {
      const filePath = path.join(CONFIG_DIR, fileName);
      const content = await fs.readFile(filePath, 'utf-8');
      return [key, JSON.parse(content)];
    })
  );

  return Object.fromEntries(entries);
}

module.exports = { loadConfigs };
