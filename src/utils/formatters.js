export function formatFileSize(size) {
  if (!size) return '0 KB';
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function getSuggestedKeywords(form, configs) {
  if (!configs) return form.keywords || '';

  const direct = configs.keywords.filter((keyword) => {
    return form.workContent?.includes(keyword) || form.watermarkCategory?.includes(keyword);
  });

  const fromScenes = configs.sceneExamples
    .filter((scene) => scene.watermarkCategory === form.watermarkCategory && scene.workContent === form.workContent)
    .flatMap((scene) => scene.keywords);

  return Array.from(new Set([...direct, ...fromScenes])).slice(0, 6).join('、');
}
