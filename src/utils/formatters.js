export function formatFileSize(size) {
  if (!size) return '0 KB';
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function getSuggestedKeywords(form, configs) {
  if (!configs) return form.keywords || '';

  const sceneKeywords = configs.sceneExamples
    .filter((scene) => scene.watermarkCategory === form.watermarkCategory && scene.workContent === form.workContent)
    .flatMap((scene) => scene.keywords || []);

  const workItemKeywords = configs.watermarkCategories?.[form.watermarkCategory]?.itemMeta?.[form.workContent]?.keywords || [];

  const direct = configs.keywords.filter((keyword) => {
    return (
      form.workContent?.includes(keyword) ||
      form.watermarkCategory?.includes(keyword) ||
      form.location?.includes(keyword) ||
      form.workItem?.includes(keyword) ||
      form.processStatus?.includes(keyword)
    );
  });

  const fromCurrentWork = [form.workContent, form.workItem, form.location]
    .filter(Boolean)
    .map((value) => String(value).trim())
    .filter((value) => value.length >= 2);

  const statusKeywords = form.processStatus ? [form.processStatus] : [];

  return uniqueKeywords([...workItemKeywords, ...sceneKeywords, ...direct, ...fromCurrentWork, ...statusKeywords]).slice(0, 10).join('、');
}

export function splitKeywords(value) {
  return String(value || '')
    .split(/[、,，;；\s]+/)
    .map((keyword) => keyword.trim())
    .filter(Boolean);
}

export function joinKeywords(keywords) {
  return uniqueKeywords(keywords).join('、');
}

export function uniqueKeywords(keywords) {
  return Array.from(new Set(
    keywords
      .map((keyword) => String(keyword || '').trim())
      .filter(Boolean)
  ));
}

export function toggleKeyword(currentValue, keyword) {
  const current = splitKeywords(currentValue);
  if (current.includes(keyword)) {
    return joinKeywords(current.filter((item) => item !== keyword));
  }
  return joinKeywords([...current, keyword]);
}

export function buildRemarkTemplates(form, sceneExamples = [], configs = null) {
  const matchedScene = sceneExamples.find(
    (scene) => scene.watermarkCategory === form.watermarkCategory && scene.workContent === form.workContent
  );
  const matchedWorkItem = configs?.watermarkCategories?.[form.watermarkCategory]?.itemMeta?.[form.workContent];

  const templates = [
    matchedWorkItem?.remarkTemplate,
    matchedScene?.remarkTemplate,
    form.workContent?.includes('楼道杂物') && '位置/区域发现楼道杂物，已通知相关业主清理，后续将跟进复查。',
    form.workContent?.includes('飞线充电') && '位置/区域发现飞线充电现象，现场已进行劝阻并提醒安全风险。',
    form.workContent?.includes('消防通道') && '位置/区域发现车辆占用消防通道，已联系车主挪移并做好现场记录。',
    form.workContent?.includes('设备房') && '位置/区域完成设备房巡检，现场状态正常/异常，已做好记录。',
    form.watermarkCategory === '工程类专用' && '位置/区域发现相关设施设备问题，已安排工程人员处理。',
    form.watermarkCategory === '时间地点水印' && '位置/区域进行现场确认，事项为：事项名称，请结合照片留存记录。'
  ].filter(Boolean);

  return Array.from(new Set(templates)).slice(0, 4);
}
