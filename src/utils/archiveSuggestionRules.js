export const FIELD_AUTOMATION_POLICY = {
  suggestedFields: ['部门', '水印分类', '工作内容', '事项名称', '位置/区域', '关键词', '备注模板', '照片阶段', '处理状态', '常用位置'],
  manualConfirmFields: ['项目', '部门', '水印分类', '工作内容', '事项名称', '是否归档', '是否公开展示', '整改是否完成', '是否删除记录'],
  forbiddenAutoFields: ['业主姓名', '电话', '电话号码', '门牌号', '完整车牌', '责任认定', '投诉纠纷细节', '敏感备注']
};

export function buildArchiveSuggestion(input = {}, configs = {}) {
  const scene = input.scene || null;
  const category = clean(input.watermarkCategory || input.category || scene?.watermarkCategory);
  const workContent = clean(input.workContent || input.workItem || scene?.workContent);
  const history = buildHistoryHint(input.historyRecords || [], { ...input, watermarkCategory: category, workContent });
  const currentSources = [];
  const extraSources = Array.isArray(input.extraSources) ? input.extraSources : [];
  if (scene?.title) currentSources.push('常用场景');
  if (input.watermarkCategory || input.workContent || input.workItem) currentSources.push('用户当前输入');

  if (!category && !workContent && !history.hasValue) {
    return createEmptyArchiveSuggestion();
  }

  const direction = findDirection(category, workContent);
  const isParkingOccupation = category.includes('机动车违规管理') && workContent.includes('占用') && workContent.includes('车位');
  const sources = unique([
    ...extraSources,
    ...currentSources,
    category && '分类规则',
    workContent && '工作内容规则',
    history.hasValue && '历史记录',
    (!category || !workContent) && '默认兜底'
  ]);

  const itemName = clean(scene?.itemName)
    || history.itemName
    || (isParkingOccupation
      ? '车辆占用车位处理'
      : buildItemName(workContent, direction.itemStem));
  const locationSuggestion = clean(scene?.location)
    || history.location
    || '';
  const locationPlaceholder = clean(scene?.locationPlaceholder)
    || history.location
    || (isParkingOccupation ? '填写车位号、楼栋单元、地下车库区域等' : direction.location);
  const processStatus = clean(scene?.processStatusSuggestion || scene?.processStatus)
    || history.processStatus
    || pickConfigName(configs.processStatuses, '待处理');
  const photoStage = clean(scene?.photoStageSuggestion || scene?.photoStage)
    || history.photoStage
    || pickConfigName(configs.photoStages, '远景定位');
  const department = clean(input.department || scene?.department)
    || history.department
    || pickDepartment(configs.departments, category, workContent);
  const keywords = unique([
    ...splitKeywords(scene?.keywords),
    ...history.keywords,
    ...buildRecommendedKeywords(category, workContent, direction.keywords)
  ]);
  const remarkTemplate = clean(scene?.remarkTemplate)
    || history.remark
    || (isParkingOccupation
      ? '现场发现车辆占用他人车位，已记录并按流程联系处理，后续持续跟进。'
      : `现场开展${workContent || direction.itemStem}工作，已完成记录并按流程处理，后续持续跟进。`);

  return {
    department,
    watermarkCategory: category,
    workContent,
    itemName,
    workItem: itemName,
    location: locationSuggestion,
    locationPlaceholder,
    processStatus,
    photoStage,
    keywords,
    remarkTemplate,
    remark: remarkTemplate,
    sources,
    confidenceText: buildConfidenceText({ scene, category, workContent, history, sources }),
    matchedHistoryCount: history.count,
    requiresHumanConfirmation: true,
    isEmpty: false,
    policy: FIELD_AUTOMATION_POLICY
  };
}

export function createEmptyArchiveSuggestion() {
  return {
    department: '',
    watermarkCategory: '',
    workContent: '',
    itemName: '',
    workItem: '',
    location: '',
    locationPlaceholder: '',
    processStatus: '',
    photoStage: '',
    keywords: [],
    remarkTemplate: '',
    remark: '',
    sources: [],
    confidenceText: '',
    matchedHistoryCount: 0,
    requiresHumanConfirmation: true,
    isEmpty: true,
    policy: FIELD_AUTOMATION_POLICY
  };
}

export function suggestionToFormPatch(suggestion = {}, target = 'sort') {
  const keywords = Array.isArray(suggestion.keywords) ? suggestion.keywords.join('、') : clean(suggestion.keywords);
  const common = {
    department: suggestion.department || '',
    watermarkCategory: suggestion.watermarkCategory || '',
    workContent: suggestion.workContent || '',
    location: suggestion.location || '',
    locationPlaceholder: suggestion.locationPlaceholder || '',
    photoStage: suggestion.photoStage || '',
    processStatus: suggestion.processStatus || '',
    keywords,
    remark: suggestion.remarkTemplate || suggestion.remark || ''
  };
  if (target === 'quick') {
    return { ...common, workItem: suggestion.itemName || suggestion.workItem || '' };
  }
  return { ...common, itemName: suggestion.itemName || suggestion.workItem || '' };
}

export function filterEmptyPatch(patch = {}, current = {}) {
  return Object.fromEntries(Object.entries(patch).filter(([key, value]) => {
    if (!String(value || '').trim()) return false;
    return !String(current[key] || '').trim();
  }));
}

const SUGGESTION_RULES = [
  { match: '安全管理类', itemStem: '安全巡查', location: '填写楼栋、单元、通道或隐患点位', departmentHints: ['秩序', '客服'], keywords: ['巡查', '隐患', '秩序', '安全提醒'] },
  { match: '工程类专用', itemStem: '设施设备检查', location: '填写设备房、楼栋单元或设施点位', departmentHints: ['工程'], keywords: ['维修', '检查', '处理', '设备设施'] },
  { match: '绿化保洁类', itemStem: '环境维护', location: '填写楼栋周边、园区道路或绿化区域', departmentHints: ['环境', '客服'], keywords: ['清理', '保洁', '修剪', '消杀'] },
  { match: '巡查检查类', itemStem: '现场巡查', location: '填写巡查区域、楼栋单元或具体点位', departmentHints: ['客服', '秩序'], keywords: ['巡查', '记录', '复查'] },
  { match: '机动车违规管理', itemStem: '车辆秩序维护', location: '填写车位号、道路、出入口或车库区域', departmentHints: ['秩序'], keywords: ['车辆停放', '占用通道', '占用车位', '秩序维护'] },
  { match: '资料整理归档', itemStem: '资料归档', location: '填写资料所属项目、部门或存放区域', departmentHints: ['客服'], keywords: ['资料收集', '分类', '归档', '核对'] },
  { match: '会议培训宣传', itemStem: '会议培训宣传', location: '填写会议室、活动区域或宣传点位', departmentHints: ['客服'], keywords: ['通知', '宣传', '培训', '活动记录'] }
];

const WORK_KEYWORD_RULES = [
  { category: '机动车违规管理', work: ['占用', '车位'], keywords: ['占用车位', '车辆停放', '车位管理', '秩序维护'] },
  { category: '机动车违规管理', work: ['消防通道'], keywords: ['消防通道', '违规停车', '车辆停放', '安全隐患', '秩序维护'] },
  { category: '绿化保洁类', work: ['楼道', '杂物'], keywords: ['楼道杂物', '公共区域', '环境卫生', '清理整治'] },
  { category: '工程类专用', work: ['公共照明'], keywords: ['公共照明', '设施维修', '工程维修', '设备设施'] }
];

function buildHistoryHint(records = [], input = {}) {
  const category = clean(input.watermarkCategory);
  const workContent = clean(input.workContent || input.workItem);
  const project = clean(input.project);
  const matched = records
    .filter((record) => {
      const sameCategory = category && clean(record.watermarkCategory).includes(category);
      const sameWork = workContent && clean(record.workContent || record.workItem).includes(workContent);
      const sameProject = project && clean(record.project).includes(project);
      return (sameCategory && sameWork) || (sameProject && (sameCategory || sameWork));
    })
    .slice(0, 20);

  const first = matched[0] || {};
  return {
    hasValue: matched.length > 0,
    count: matched.length,
    department: clean(first.department),
    itemName: clean(first.workItem || first.itemName),
    location: mostFrequent(matched.map((record) => record.location)),
    processStatus: clean(first.processStatus),
    photoStage: clean(first.photoStage),
    keywords: unique(matched.flatMap((record) => splitKeywords(record.keywords))).slice(0, 8),
    remark: clean(first.remark)
  };
}

function buildRecommendedKeywords(category, workContent, categoryKeywords) {
  if (!category && !workContent) return [];
  const matchedRule = WORK_KEYWORD_RULES.find((rule) => (
    category.includes(rule.category) && rule.work.every((keyword) => workContent.includes(keyword))
  ));
  const workKeywords = workContent
    ? (matchedRule?.keywords || [workContent, ...splitKeywords(workContent.replace(/[与和、/]/g, '、'))])
    : [];
  return unique([...workKeywords, ...(categoryKeywords || [])]);
}

function findDirection(category, workContent) {
  return SUGGESTION_RULES.find((rule) => category.includes(rule.match))
    || SUGGESTION_RULES.find((rule) => workContent.includes(rule.itemStem))
    || SUGGESTION_RULES[0];
}

function buildItemName(workContent, fallback) {
  const base = workContent || fallback;
  return `${base}${/(处理|维修|巡查|检查|归档|宣传|培训|清理|治理|维护|养护)$/.test(base) ? '' : '处理'}`;
}

function pickDepartment(departments = [], category, workContent) {
  const direction = findDirection(category, workContent);
  const enabledDepartments = departments.filter((item) => item.enabled !== false);
  const matched = enabledDepartments.find((item) => (
    direction.departmentHints?.some((hint) => getOptionName(item).includes(hint))
  ));
  return getOptionName(matched);
}

function buildConfidenceText({ scene, category, workContent, history, sources }) {
  if (scene?.title && history.count > 0) return `根据常见场景和 ${history.count} 条历史记录生成，归档前请人工确认。`;
  if (scene?.title) return '根据常见场景生成，归档前请人工确认。';
  if (history.count > 0) return `根据分类、工作内容和 ${history.count} 条历史记录生成，归档前请人工确认。`;
  if (category && workContent) return '根据分类与工作内容规则生成，归档前请人工确认。';
  if (sources.includes('默认兜底')) return '当前字段不足，仅提供兜底建议，请补充分类和工作内容后再确认。';
  return '建议仅用于辅助填写，归档前请人工确认。';
}

function pickConfigName(items = [], preferred) {
  return getOptionName(items.find((item) => item.enabled !== false && getOptionName(item) === preferred))
    || getOptionName(items.find((item) => item.enabled !== false))
    || '';
}

function getOptionName(item) {
  if (!item) return '';
  if (typeof item === 'string') return item;
  return clean(item.name || item.label || item.value);
}

function mostFrequent(values = []) {
  const counts = new Map();
  values.map(clean).filter(Boolean).forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

function splitKeywords(value) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  return String(value || '').split(/[、,，;；\s]+/).map(clean).filter(Boolean);
}

function clean(value) {
  return String(value || '').trim();
}

function unique(values = []) {
  return Array.from(new Set(values.map((value) => clean(value)).filter(Boolean)));
}
