export const FIELD_AUTOMATION_POLICY = {
  suggestedFields: ['事项名称', '关键词', '备注模板', '照片阶段', '处理状态', '常用位置'],
  manualConfirmFields: ['项目', '水印分类', '工作内容', '是否公开展示', '整改是否完成', '是否删除记录'],
  forbiddenAutoFields: ['业主姓名', '电话', '门牌号', '完整车牌', '责任认定', '投诉纠纷细节', '敏感备注']
};

export function buildArchiveSuggestion(input = {}, configs = {}) {
  const category = String(input.watermarkCategory || input.category || '').trim();
  const workContent = String(input.workContent || input.workItem || '').trim();
  if (!category || !workContent) return createEmptyArchiveSuggestion();

  const direction = SUGGESTION_RULES.find((rule) => category.includes(rule.match)) || SUGGESTION_RULES[0];
  const isParkingOccupation = category.includes('机动车违规管理') && workContent.includes('占用') && workContent.includes('车位');
  const processStatus = pickConfigName(configs.processStatuses, '待处理');
  const photoStage = pickConfigName(configs.photoStages, '远景定位');

  return {
    itemName: isParkingOccupation
      ? '车辆占用车位处理'
      : `${workContent || direction.itemStem}${/(处理|维修|巡查|检查|归档|宣传|培训|清理)$/.test(workContent) ? '' : '处理'}`,
    locationPlaceholder: isParkingOccupation ? '填写车位号、楼栋单元、地下车库区域等' : direction.location,
    processStatus,
    photoStage,
    keywords: buildRecommendedKeywords(category, workContent, direction.keywords),
    remarkTemplate: isParkingOccupation
      ? '现场发现车辆占用他人车位，已记录并按流程联系处理，后续持续跟进。'
      : `现场开展${workContent || direction.itemStem}工作，已完成记录并按流程处理，后续持续跟进。`,
    requiresHumanConfirmation: true,
    policy: FIELD_AUTOMATION_POLICY
  };
}

export function createEmptyArchiveSuggestion() {
  return {
    itemName: '',
    locationPlaceholder: '',
    processStatus: '',
    photoStage: '',
    keywords: [],
    remarkTemplate: '',
    requiresHumanConfirmation: true,
    policy: FIELD_AUTOMATION_POLICY
  };
}

const SUGGESTION_RULES = [
  { match: '安全管理类', itemStem: '安全巡查', location: '填写楼栋、单元、通道或隐患点位', keywords: ['巡查', '隐患', '秩序', '安全提醒'] },
  { match: '工程类专用', itemStem: '设施设备检查', location: '填写设备房、楼栋单元或设施点位', keywords: ['维修', '检查', '处理', '设备设施'] },
  { match: '绿化保洁类', itemStem: '环境维护', location: '填写楼栋周边、园区道路或绿化区域', keywords: ['清理', '保洁', '修剪', '消杀'] },
  { match: '巡查检查类', itemStem: '现场巡查', location: '填写巡查区域、楼栋单元或具体点位', keywords: ['巡查', '记录', '复查'] },
  { match: '机动车违规管理', itemStem: '车辆秩序维护', location: '填写车位号、道路、出入口或车库区域', keywords: ['车辆停放', '占用通道', '占用车位', '秩序维护'] },
  { match: '资料整理归档', itemStem: '资料归档', location: '填写资料所属项目、部门或存放区域', keywords: ['资料收集', '分类', '归档', '核对'] },
  { match: '会议培训宣传', itemStem: '会议培训宣传', location: '填写会议室、活动区域或宣传点位', keywords: ['通知', '宣传', '培训', '活动记录'] }
];

const WORK_KEYWORD_RULES = [
  { category: '机动车违规管理', work: ['占用', '车位'], keywords: ['占用车位', '车辆停放', '车位管理', '秩序维护'] },
  { category: '机动车违规管理', work: ['消防通道'], keywords: ['消防通道', '违规停车', '车辆停放', '安全隐患', '秩序维护'] },
  { category: '绿化保洁类', work: ['楼道', '杂物'], keywords: ['楼道杂物', '公共区域', '环境卫生', '清理整治'] },
  { category: '工程类专用', work: ['公共照明'], keywords: ['公共照明', '设施维修', '工程维修', '设备设施'] }
];

function buildRecommendedKeywords(category, workContent, categoryKeywords) {
  if (!category) return [];
  const matchedRule = WORK_KEYWORD_RULES.find((rule) => (
    category.includes(rule.category) && rule.work.every((keyword) => workContent.includes(keyword))
  ));
  const workKeywords = workContent
    ? (matchedRule?.keywords || [workContent, ...splitKeywords(workContent.replace(/[与和、/]/g, '、'))])
    : [];
  return Array.from(new Set([...workKeywords, ...(categoryKeywords || [])].filter(Boolean)));
}

function pickConfigName(items = [], preferred) {
  return items.find((item) => item.enabled !== false && item.name === preferred)?.name
    || items.find((item) => item.enabled !== false)?.name
    || '';
}

function splitKeywords(value) {
  return String(value || '').split(/[、,，;；\s]+/).map((item) => item.trim()).filter(Boolean);
}
