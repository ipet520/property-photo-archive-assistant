export const PROJECT_INFO = [
  {
    name: '曲靖潇湘新区二期',
    shortName: '潇湘新区二期',
    phone: '0874-3296029',
    serviceCenter: '佳恒物业潇湘新区二期客服中心',
    aliases: ['曲靖潇湘新区二期', '潇湘新区二期', '潇湘', '新区二期']
  },
  {
    name: '曲靖香辰康园',
    shortName: '香辰康园',
    phone: '0874-3956880',
    serviceCenter: '佳恒物业香辰康园客服中心',
    aliases: ['曲靖香辰康园', '香辰康园', '香辰']
  }
];

export function resolveProjectInfo(projectName) {
  const raw = String(projectName || '').trim();
  const normalized = normalizeProjectText(raw);
  const matched = PROJECT_INFO.find((project) => (
    project.aliases.some((alias) => normalized.includes(normalizeProjectText(alias)))
  ));
  if (matched) return { ...matched, isFallback: false };
  return {
    name: raw || '未识别项目',
    shortName: raw && raw !== '未识别项目' ? raw : '物业服务中心',
    phone: '请填写物业服务中心电话',
    serviceCenter: '物业服务中心',
    aliases: [],
    isFallback: true
  };
}

export function normalizeProjectText(value) {
  return String(value || '').trim().replace(/\s+/g, '');
}
