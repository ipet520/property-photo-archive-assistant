export function formatFileSize(size) {
  if (!size) return '0 KB';
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function getSuggestedKeywords(form, configs) {
  if (!configs) return form.keywords || '';

  const direct = configs.keywords.filter((keyword) => {
    return (
      form.workContent?.includes(keyword) ||
      form.watermarkCategory?.includes(keyword) ||
      form.location?.includes(keyword) ||
      form.workItem?.includes(keyword)
    );
  });

  const fromScenes = configs.sceneExamples
    .filter((scene) => scene.watermarkCategory === form.watermarkCategory && scene.workContent === form.workContent)
    .flatMap((scene) => scene.keywords);

  const fromCurrentWork = [form.workContent, form.workItem]
    .filter(Boolean)
    .map((value) => String(value).trim())
    .filter((value) => value.length >= 2);

  return Array.from(new Set([...fromScenes, ...direct, ...fromCurrentWork])).slice(0, 8).join('、');
}
