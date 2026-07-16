const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { buildArchivePreview, archivePhotos } = require('../electron/services/archiveService.cjs');
const { buildPackagePlan, generateArchivePackage } = require('../electron/services/archivePackageService.cjs');
const { matchArchivedPhotos } = require('../electron/services/archiveFingerprintService.cjs');
const { loadDashboardData } = require('../electron/services/dashboardService.cjs');
const { getDataMaintenanceReport } = require('../electron/services/dataMaintenanceService.cjs');
const { loadLedgerRecords } = require('../electron/services/ledgerQueryService.cjs');
const { getRecognitionStatus } = require('../electron/services/recognitionService.cjs');
const { saveRectificationItem } = require('../electron/services/rectificationService.cjs');
const { saveSettings } = require('../electron/services/settingsService.cjs');
const { generateSmartSortGroups } = require('../electron/services/smartSortService.cjs');
const { loadSummaryData } = require('../electron/services/summaryService.cjs');

async function main() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-archive-self-check-'));
  try {
    await checkRecognitionEngine(temporaryRoot);
    await checkCurrentFormContract();
    await checkMaintenanceRecommendations(path.join(temporaryRoot, 'maintenance'));
    await checkSmartSortOutcomes(path.join(temporaryRoot, 'smart-sort'));
    await checkArchiveFlow(path.join(temporaryRoot, 'archive-flow'));
    await checkSourceContracts();
    console.log('核心流程自检通过：OCR、智拣、表单、预览、归档、台账、指纹和 IPC 契约均正常。');
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function checkMaintenanceRecommendations(root) {
  const documentsPath = path.join(root, 'documents');
  const archiveRoot = path.join(root, 'archive');
  const packageRoot = path.join(root, 'packages');
  await fs.mkdir(archiveRoot, { recursive: true });
  await fs.mkdir(packageRoot, { recursive: true });
  await saveSettings(documentsPath, {
    defaultArchiveRoot: archiveRoot,
    lastArchiveRoot: archiveRoot,
    defaultPhotoFolder: '',
    lastPhotoFolder: '',
    defaultArchivePackageRoot: packageRoot
  });

  const report = await getDataMaintenanceReport({ documentsPath, projectRoot: process.cwd() });
  const directoryByKey = new Map(report.directoryStatus.items.map((item) => [item.key, item]));
  assert.equal(directoryByKey.get('sortDrafts')?.status, 'info', '尚未创建的分拣草稿目录不应误报异常');
  assert.equal(directoryByKey.get('configBackup')?.status, 'info', '尚未创建的设置备份目录不应误报异常');
  assert.equal(report.sortProgressStatus.status, 'info', '没有分拣草稿应为提示状态');
  assert.equal(report.packageStatus.status, 'normal', '已配置且可读写的空资料包目录应为正常状态');
  assert.equal(report.suggestions.some((item) => item.title.includes('分拣进度保存目录不可用')), false, '维护建议不应误报分拣草稿目录');
  assert.equal(report.suggestions.some((item) => item.title.includes('设置备份目录不可用')), false, '维护建议不应误报设置备份目录');

  await saveSettings(documentsPath, {
    defaultArchiveRoot: archiveRoot,
    lastArchiveRoot: archiveRoot,
    defaultPhotoFolder: '',
    lastPhotoFolder: '',
    defaultArchivePackageRoot: ''
  });
  const optionalPackageReport = await getDataMaintenanceReport({ documentsPath, projectRoot: process.cwd() });
  const optionalPackageSuggestion = optionalPackageReport.suggestions.find((item) => item.title.includes('资料包导出目录未配置'));
  assert.equal(optionalPackageSuggestion?.level, 'info', '未配置可选资料包目录只应显示普通提示');

  const invalidDocumentsPath = path.join(root, 'invalid-documents');
  const missingArchiveRoot = path.join(root, 'missing-archive');
  await saveSettings(invalidDocumentsPath, {
    defaultArchiveRoot: missingArchiveRoot,
    lastArchiveRoot: missingArchiveRoot,
    defaultPhotoFolder: '',
    lastPhotoFolder: '',
    defaultArchivePackageRoot: ''
  });
  const invalidReport = await getDataMaintenanceReport({ documentsPath: invalidDocumentsPath, projectRoot: process.cwd() });
  assert.equal(invalidReport.suggestions.some((item) => item.title === '默认归档根目录不可用'), true, '失效归档根目录应明确提示');
  assert.equal(invalidReport.suggestions.some((item) => item.title === '未发现归档台账'), false, '归档根目录失效时不应重复提示未发现台账');
}

async function checkRecognitionEngine(userDataDir) {
  const status = await getRecognitionStatus(userDataDir);
  const localProvider = (status.providers || []).find((provider) => provider.id === 'local_ocr' || provider.providerId === 'local_ocr');
  assert.equal(localProvider?.available, true, `本地 OCR 引擎不可用：${localProvider?.reason || status.reason || '未知原因'}`);
  assert.equal(localProvider?.engine, 'rapidocr', '本地 OCR 引擎应为 RapidOCR');
  assert.match(String(localProvider?.componentVersion || ''), /2026\.7\.2.*v3\.9\.1/i, 'OCR 组件版本号未统一');
}

async function checkCurrentFormContract() {
  const {
    buildArchiveSuggestion,
    parseWatermarkRecord,
    validateSortForm
  } = await import('../src/utils/sortRightPanelState.js');
  const configs = {
    projects: ['潇湘新区二期'],
    watermarkCategories: {
      机动车违规管理: { items: ['随意停放阻碍通行'] }
    }
  };
  const recognition = {
    photoId: 'photo-form',
    status: 'success',
    success: true,
    rawText: [
      '日期：2026-06-12',
      '时间：16:05',
      '小区名称：潇湘新区二期',
      '工作内容：随意停放阻碍通行'
    ].join('\n')
  };
  const watermark = parseWatermarkRecord(recognition);
  const suggestion = buildArchiveSuggestion(watermark, {
    configs,
    currentProject: '潇湘新区二期',
    defaultProject: '潇湘新区二期'
  });
  assert.equal(watermark.locationText, '', '只有项目名称时，位置/区域必须保持为空');
  assert.equal(suggestion.suggestedFields.location, '', '项目名称不得重复写入位置/区域');
  assert.deepEqual(validateSortForm({
    date: '2026-06-12',
    watermarkCategory: '机动车违规管理',
    workContent: '随意停放阻碍通行',
    location: '',
    keywords: '',
    remark: ''
  }), [], '当前表单只应要求日期、归档分类和工作内容');
}

async function checkSmartSortOutcomes(userDataDir) {
  const photos = [
    {
      id: 'no-watermark',
      path: path.join(userDataDir, 'no-watermark.jpg'),
      recognition: { status: 'success', rawText: '消防车辆正在场地开展演练' },
      archiveSuggestion: { suggestedFields: {}, missingRequiredFields: ['归档分类', '工作内容'] }
    },
    {
      id: 'recognition-failed',
      path: path.join(userDataDir, 'recognition-failed.jpg'),
      recognition: { status: 'failed', rawText: '' },
      archiveSuggestion: { suggestedFields: {}, missingRequiredFields: ['归档分类', '工作内容'] }
    },
    {
      id: 'archive-failed',
      path: path.join(userDataDir, 'archive-failed.jpg'),
      sortStatus: 'failed',
      archiveResult: { status: '归档失败', error: '测试失败' }
    }
  ];
  const result = await generateSmartSortGroups(userDataDir, { photos });
  const titles = new Set((result.groups || []).map((group) => group.title));
  assert.equal(titles.has('未检测到水印'), true, '无有效水印文字应进入“未检测到水印”');
  assert.equal(titles.has('无法判断工作内容'), false, '无水印场景文字不应进入“无法判断工作内容”');
  assert.equal(titles.has('识别失败'), true, 'OCR 执行失败应进入“识别失败”');
  assert.equal(titles.has('归档失败'), true, '归档失败状态应进入“归档失败”');
}

async function checkArchiveFlow(root) {
  const sourceDirectory = path.join(root, 'source');
  const archiveRoot = path.join(root, 'archive');
  await fs.mkdir(sourceDirectory, { recursive: true });
  const sourcePath = path.join(sourceDirectory, 'original.jpg');
  const originalContent = Buffer.from('AAAA-BBBB-CCCC');
  await fs.writeFile(sourcePath, originalContent);
  const form = {
    project: '潇湘新区二期',
    watermarkCategory: '机动车违规管理',
    workContent: '随意停放阻碍通行',
    date: '2026-06-12',
    location: '',
    keywords: '车辆停放',
    remark: '核心流程自检'
  };
  const photo = {
    id: 'archive-photo',
    path: sourcePath,
    name: 'original.jpg',
    extension: '.jpg'
  };

  const initialPreview = await buildArchivePreview({ form, photos: [photo], archiveRoot });
  await fs.mkdir(initialPreview[0].targetDirectory, { recursive: true });
  await fs.writeFile(initialPreview[0].targetPath, Buffer.from('existing-target'));
  const preview = await buildArchivePreview({ form, photos: [photo], archiveRoot });
  assert.match(preview[0].newFileName, /_01\.jpg$/i, '预览应提前显示重名后的最终文件名');
  assert.equal(preview[0].location, '现场', '空位置应在归档服务中统一归一为“现场”');

  const archiveResult = await archivePhotos({ archiveRoot, items: preview });
  assert.equal(archiveResult.success, true, '归档复制应成功');
  assert.equal(archiveResult.items[0].targetPath, preview[0].targetPath, '无并发冲突时，预览文件名与最终文件名必须一致');
  assert.deepEqual(await fs.readFile(sourcePath), originalContent, '归档不得移动、删除或修改原始照片');

  const ledger = await loadLedgerRecords(archiveRoot);
  assert.equal(ledger.records.length, 1, '归档成功应追加一条台账记录');
  assert.equal(ledger.records[0].watermarkCategory, form.watermarkCategory, '台账归档分类字段应正确');
  assert.equal(ledger.records[0].workContent, form.workContent, '台账工作内容字段应正确');
  assert.equal(ledger.records[0].location, '现场', '台账位置字段应正确');
  assert.equal(ledger.records[0].fileExists, true, '台账归档文件应能被后续页面找到');

  const renamedCopy = path.join(sourceDirectory, 'renamed.jpg');
  const sameNameDifferentContent = path.join(sourceDirectory, 'original-copy.jpg');
  await fs.writeFile(renamedCopy, originalContent);
  await fs.writeFile(sameNameDifferentContent, Buffer.from('ZZZZ-YYYY-XXXX'));
  const matches = await matchArchivedPhotos(archiveRoot, [
    { id: 'renamed', path: renamedCopy, size: originalContent.length },
    { id: 'different', path: sameNameDifferentContent, size: originalContent.length }
  ]);
  assert.equal(Boolean(matches.matches.renamed), true, '同内容改名照片应识别为已归档');
  assert.equal(Boolean(matches.matches.different), false, '同大小不同内容照片不得误判为已归档');

  const failedArchiveRoot = path.join(root, 'failed-archive');
  const failedPreview = await buildArchivePreview({
    form,
    photos: [{ ...photo, id: 'missing-source', path: path.join(sourceDirectory, 'missing.jpg') }],
    archiveRoot: failedArchiveRoot
  });
  const failedResult = await archivePhotos({ archiveRoot: failedArchiveRoot, items: failedPreview });
  assert.equal(failedResult.failedCount, 1, '原图缺失时应明确归档失败');
  const failedLedger = await loadLedgerRecords(failedArchiveRoot);
  assert.equal(failedLedger.records.length, 0, '归档失败不得写入台账');

  await checkDownstreamPages({ root, archiveRoot, ledgerRecord: ledger.records[0] });
}

async function checkDownstreamPages({ root, archiveRoot, ledgerRecord }) {
  const documentsPath = path.join(root, 'documents');
  const packageTargetRoot = path.join(root, 'packages');
  await fs.mkdir(packageTargetRoot, { recursive: true });
  await saveSettings(documentsPath, {
    defaultArchiveRoot: archiveRoot,
    lastArchiveRoot: archiveRoot,
    defaultPhotoFolder: '',
    lastPhotoFolder: '',
    defaultArchivePackageRoot: packageTargetRoot
  });

  const packagePlan = buildPackagePlan([ledgerRecord], packageTargetRoot);
  assert.equal(packagePlan.existsCount, 1, '资料包预检查应识别可复制的归档照片');
  assert.equal(packagePlan.missingCount, 0, '资料包预检查不应误报文件缺失');
  const packageResult = await generateArchivePackage([
    ledgerRecord,
    { ...ledgerRecord, id: 'missing-package-record', archivePath: path.join(root, 'missing-package.jpg') }
  ], { targetRoot: packageTargetRoot });
  assert.equal(packageResult.copiedCount, 1, '资料包应复制存在的归档照片');
  assert.equal(packageResult.missingCount, 1, '资料包应记录并跳过缺失照片');
  assert.equal(await isFile(ledgerRecord.archivePath), true, '生成资料包不得移动或删除归档照片');

  const rectification = await saveRectificationItem(documentsPath, {
    project: ledgerRecord.project,
    responsibleDepartment: '秩序',
    watermarkCategory: ledgerRecord.watermarkCategory,
    workContent: ledgerRecord.workContent,
    location: ledgerRecord.location,
    title: `${ledgerRecord.workContent}整改`,
    description: ledgerRecord.remark || '现场问题',
    requirement: '请核实并完成整改。',
    deadline: '2026-06-20',
    status: '待整改',
    keywords: ledgerRecord.keywords,
    photos: {
      before: [{ filePath: ledgerRecord.archivePath, fileName: ledgerRecord.newFileName, stage: 'before', sourceType: '归档记录' }],
      during: [],
      after: []
    }
  });
  assert.equal(rectification.item.watermarkCategory, ledgerRecord.watermarkCategory, '整改事项应沿用归档分类');
  assert.equal(rectification.item.workContent, ledgerRecord.workContent, '整改事项应沿用工作内容');

  const summary = await loadSummaryData({ archiveRoot, documentsPath, projectRoot: process.cwd() });
  assert.equal(summary.photoRecords.length, 1, '资料汇总中心应读取归档照片记录');
  assert.equal(summary.rectificationItems.length, 1, '资料汇总中心应读取整改事项');
  assert.equal(summary.photoRecords[0].fileExists, true, '资料汇总中心应正确判断归档文件状态');

  const dashboard = await loadDashboardData({ documentsPath, projectRoot: process.cwd() });
  assert.equal(dashboard.archiveMetrics.total, 1, '首页归档总数应与台账一致');
  assert.equal(dashboard.archiveMetrics.missingCount, 0, '首页不应误报归档文件缺失');
  assert.equal(dashboard.rectificationMetrics.total, 1, '首页整改总数应与整改数据一致');

  const maintenance = await getDataMaintenanceReport({ documentsPath, projectRoot: process.cwd() });
  assert.equal(maintenance.ledgerStatus.total, 1, '数据维护中心台账统计应与归档记录一致');
  assert.equal(maintenance.ledgerStatus.missingCount, 0, '数据维护中心不应误报归档文件缺失');
}

async function checkSourceContracts() {
  const [mainSource, preloadSource, workspaceSource, settingsSource, serviceBriefSource] = await Promise.all([
    fs.readFile(path.join(process.cwd(), 'electron/main.cjs'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'electron/preload.cjs'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'src/pages/SortWorkspacePage.jsx'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'src/pages/SettingsPage.jsx'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'src/pages/ServiceBriefPage.jsx'), 'utf8')
  ]);
  const invokedChannels = new Set([...preloadSource.matchAll(/ipcRenderer\.invoke\(['"]([^'"]+)['"]/g)].map((match) => match[1]));
  const handledChannels = new Set([...mainSource.matchAll(/ipcMain\.handle\(['"]([^'"]+)['"]/g)].map((match) => match[1]));
  const missingHandlers = [...invokedChannels].filter((channel) => !handledChannels.has(channel));
  assert.deepEqual(missingHandlers, [], `preload 中存在无主进程处理器的 IPC：${missingHandlers.join(', ')}`);
  assert.equal(workspaceSource.includes("return selectedSessionFolder || defaultPhotoFolder;"), true, '手工选择的照片目录应优先于默认目录');
  assert.equal(workspaceSource.includes('|| pagePhotos[0] || photos[0] || null'), false, '空筛选组不得显示组外照片');
  assert.equal(workspaceSource.includes("['assigned', '待预览']"), false, '状态筛选不应重新出现冗余的“待预览”组');
  assert.equal(workspaceSource.includes('采用智拣结果'), false, '批量整理不应保留隐藏的自动采纳建议分支');
  assert.equal(workspaceSource.includes('套用并预览'), true, '当前表单应通过单一入口完成套用和预览');
  assert.equal(workspaceSource.includes('applyCurrentInfoAndBuildPreview'), true, '套用和预览应使用同一条业务路径');
  assert.equal(workspaceSource.includes('setSelectedIds(selectableGroupPhotos.map((photo) => photo.id))'), true, '进入智能分组时应自动选择本组可处理照片');
  assert.equal(workspaceSource.includes('重选本组'), true, '智能分组内应提供明确的重新全选入口');
  assert.equal(workspaceSource.includes('未自动选择照片'), false, '智能分组提示不应继续宣称不会自动选择');
  assert.equal(/function isSmartGroupBatchSelectable[\s\S]*?!hasArchivedPhotoState\(photo\)/.test(workspaceSource), true, '分组选择判断应使用组件外可访问的归档状态函数');
  assert.equal(workspaceSource.includes('canRestorePreviousGroup'), true, '取消预览时应优先恢复发起预览前的智能分组');
  assert.equal(workspaceSource.includes('并返回之前选择的智能分组'), true, '取消预览应明确反馈已返回原智能分组');
  assert.equal(/项目部门照片来源/.test(settingsSource), false, '系统设置不应继续暴露已停用的旧版基础数据入口');
  assert.equal(serviceBriefSource.includes('archivedDateCounts'), true, '每日服务简报日期选择器应统计有归档的日期');
  assert.equal(serviceBriefSource.includes('archive-date-dot'), true, '每日服务简报日历应显示归档日期圆点');
}

async function isFile(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

main().catch((error) => {
  console.error(`核心流程自检失败：${error.message}`);
  process.exit(1);
});
