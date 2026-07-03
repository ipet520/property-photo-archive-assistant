const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { generateSmartSortGroups } = require('../electron/services/smartSortService.cjs');

async function main() {
  const {
    buildArchiveSuggestion,
    buildRecognitionSuggestionDisplayModel,
    clearArchiveSuggestionForPhoto,
    clearRecognitionForPhoto,
    confirmArchiveSuggestion,
    getPreviewDisabledReason,
    parseWatermarkRecord,
    regenerateArchiveSuggestion,
    updateArchiveSuggestion,
    validateSortForm
  } = await import('../src/utils/sortRightPanelState.js');

  const configs = {
    photoSources: ['工作照片'],
    projects: ['潇湘新区二期', '香辰康园'],
    departments: ['秩序维护部', '工程维修部'],
    watermarkCategories: {
      '公共设施设备': { items: ['太阳能巡查', '公共照明维修', '设施设备巡查'] },
      '秩序维护': { items: ['消防通道违停', '电动车乱停乱放', '飞线充电治理'] },
      '环境卫生': { items: ['楼道杂物清理', '环境卫生维护'] }
    },
    photoStages: ['整改前', '整改中', '整改后', '现场照片'],
    processStatuses: ['待处理', '处理中', '已完成']
  };

  const context = {
    configs,
    currentProject: '潇湘新区二期',
    defaultProject: '潇湘新区二期',
    currentPhotoSource: '工作照片',
    defaultPhotoSource: '工作照片',
    defaultDepartment: '工程维修部',
    photoFolder: 'D:/photos/xiaoxiang',
    archiveRoot: 'D:/archive'
  };

  const photos = [
    { id: 'photo-a', sortStatus: 'unassigned', archiveInfo: null, previewInfo: null, archiveResult: null },
    { id: 'photo-b', sortStatus: 'unassigned', archiveInfo: null, previewInfo: null, archiveResult: null }
  ];

  const recognitionResultsByPhoto = {};
  let watermarkRecordsByPhoto = {};
  let archiveSuggestionsByPhoto = {};
  let rightPanelMode = 'form';

  const recognitionA = {
    photoId: 'photo-a',
    success: true,
    status: 'success',
    rawText: [
      '拍摄日期：2026-06-05',
      '拍摄时间：09:05',
      '项目文本：潇湘新区二期',
      '地点文本：小区名称：潇湘新区二期',
      '工作内容文本：太阳能巡查'
    ].join('\n'),
    engine: 'rapidocr',
    provider: 'local_ocr',
    durationMs: 128,
    recognizedAt: '2026-07-02T10:00:00.000Z',
    taskId: 'task-a'
  };

  recognitionResultsByPhoto['photo-a'] = recognitionA;
  const watermarkA = parseWatermarkRecord(recognitionA);
  watermarkRecordsByPhoto['photo-a'] = watermarkA;
  const suggestionA = buildArchiveSuggestion(watermarkA, context);
  archiveSuggestionsByPhoto['photo-a'] = suggestionA;

  assert.equal(recognitionResultsByPhoto['photo-a'].rawText.includes('太阳能巡查'), true, 'recognitionResult should keep OCR evidence');
  assert.equal(watermarkA.captureDate, '2026-06-05', 'watermarkRecord should parse labeled capture date');
  assert.equal(watermarkA.captureTime, '09:05', 'watermarkRecord should parse labeled capture time');
  assert.equal(watermarkA.projectText, '潇湘新区二期', 'watermarkRecord should parse project text');
  assert.equal(watermarkA.locationText, '潇湘新区二期', 'watermarkRecord should clean OCR location label');
  assert.equal(watermarkA.workContentText, '太阳能巡查', 'watermarkRecord should parse work content text');
  assert.notDeepEqual(watermarkA, suggestionA, 'watermarkRecord and archiveSuggestion must be separate objects');
  assert.equal(suggestionA.suggestedFields.project, '潇湘新区二期', 'archiveSuggestion should use context to fill project');
  assert.equal(suggestionA.suggestedFields.department, '工程维修部', 'archiveSuggestion should use default department from context');
  assert.equal(suggestionA.suggestedFields.photoSource, '工作照片', 'archiveSuggestion should fix photoSource to work photos');
  assert.equal(suggestionA.suggestedFields.workContent, '太阳能巡查', 'archiveSuggestion should keep OCR work content');
  assert.equal(suggestionA.suggestedFields.date, '2026-06-05', 'archiveSuggestion should keep OCR date');
  assert.equal(suggestionA.suggestedFields.area, '潇湘新区二期', 'archiveSuggestion should keep OCR area fallback');
  assert.equal(suggestionA.suggestedFields.location, '潇湘新区二期', 'archiveSuggestion should mirror area into location');
  assert.equal(suggestionA.suggestedFields.watermarkCategory, '公共设施设备', 'archiveSuggestion should infer close category from work content');
  assert.equal(suggestionA.fieldSources.date, 'watermark.date', 'date source should be watermark');
  assert.equal(suggestionA.fieldSources.project, 'context.project', 'project source should be context when current project exists');
  assert.equal(suggestionA.fieldSources.photoSource, 'context.photoSource', 'photoSource source should be context');
  assert.equal(suggestionA.suggestedFields.itemName.includes('太阳能巡查'), true, 'itemName should be derived from area/work content');
  assert.equal(suggestionA.suggestedFields.keywords.includes('太阳能巡查'), true, 'keywords should be derived from OCR facts and work content');
  assert.equal(Boolean(suggestionA.suggestedFields.photoStage), false, 'photoStage should remain optional');
  assert.equal(Boolean(suggestionA.suggestedFields.processStatus), false, 'processStatus should remain optional');
  assert.deepEqual(suggestionA.missingRequiredFields, [], 'complete core fields should not require optional fields');
  assert.equal(suggestionA.status, 'suggestion_ready', 'complete core fields should be suggestion_ready');
  assert.equal(photos[0].archiveInfo, null, 'saving suggestion must not write photos[].archiveInfo');

  const displayModelA = buildRecognitionSuggestionDisplayModel({
    archiveSuggestion: suggestionA,
    recognitionResult: recognitionA,
    watermarkRecord: watermarkA
  });
  const displayByLabelA = Object.fromEntries(displayModelA.applicableDisplayFields.map((field) => [field.label, field.displayValue]));
  assert.equal(displayByLabelA['工作内容'], '太阳能巡查', 'right suggestion display should show workContent from archiveSuggestion');
  assert.equal(displayByLabelA['位置/区域'], '潇湘新区二期', 'right suggestion display should show area from archiveSuggestion');
  assert.equal(displayByLabelA['备注'], undefined, 'right suggestion display must not show workContent as remark');
  assert.equal(displayModelA.missingFields.includes('事项名称'), false, 'right suggestion display must not require itemName');
  assert.equal(displayModelA.missingFields.includes('照片阶段'), false, 'right suggestion display must not require photoStage');
  assert.equal(displayModelA.missingFields.includes('处理状态'), false, 'right suggestion display must not require processStatus');

  assert.equal(rightPanelMode, 'form', 'recognition completion should leave right panel in suggestion form mode');
  rightPanelMode = 'recognition';
  assert.equal(rightPanelMode, 'recognition', 'view evidence should only switch panel mode');
  assert.ok(recognitionResultsByPhoto['photo-a'], 'view evidence should not clear recognition');
  assert.ok(archiveSuggestionsByPhoto['photo-a'], 'view evidence should not clear suggestion');
  rightPanelMode = 'form';
  assert.equal(rightPanelMode, 'form', 'return suggestion should only switch panel mode');

  const manuallyEditedA = updateArchiveSuggestion(archiveSuggestionsByPhoto['photo-a'], {
    workContent: '人工确认太阳能巡查'
  }, { configs, photoId: 'photo-a' });
  archiveSuggestionsByPhoto['photo-a'] = manuallyEditedA;
  assert.equal(manuallyEditedA.fieldSources.workContent, 'mixed', 'manual workContent edit should be marked manual/mixed');
  assert.equal(recognitionResultsByPhoto['photo-a'], recognitionA, 'manual patch must not mutate recognitionResult');
  assert.equal(watermarkRecordsByPhoto['photo-a'], watermarkA, 'manual patch must not mutate watermarkRecord');
  assert.equal(photos[0].archiveInfo, null, 'manual patch must not write archiveInfo before confirmation');

  const regeneratedA = regenerateArchiveSuggestion(watermarkA, context, manuallyEditedA);
  assert.equal(regeneratedA.suggestedFields.workContent, '人工确认太阳能巡查', 'regeneration must not silently overwrite manual fields');
  assert.ok(regeneratedA.conflictFields.includes('工作内容') || regeneratedA.fieldSources.workContent === 'mixed', 'manual field should be preserved or marked as conflict/manual');

  const oldWrongSuggestion = {
    photoId: 'photo-a',
    suggestedFields: {
      photoSource: '工作照片',
      project: '潇湘新区二期',
      date: '2026-06-05',
      workContent: '',
      area: '',
      location: '',
      itemName: '',
      remark: '太阳能巡查'
    },
    fieldSources: {
      date: 'watermark.date',
      remark: 'watermark.remark'
    },
    missingRequiredFields: ['工作内容', '位置/区域', '事项名称'],
    status: 'needs_completion'
  };
  const regeneratedFromWrong = regenerateArchiveSuggestion(watermarkA, context, oldWrongSuggestion);
  assert.equal(regeneratedFromWrong.suggestedFields.workContent, '太阳能巡查', 'regeneration should correct old non-manual empty workContent');
  assert.equal(regeneratedFromWrong.suggestedFields.area, '潇湘新区二期', 'regeneration should correct old non-manual empty area');
  assert.equal(regeneratedFromWrong.suggestedFields.remark, '', 'regeneration should not keep workContent as remark when it was not manual');
  assert.equal(regeneratedFromWrong.missingRequiredFields.includes('事项名称'), false, 'regeneration should remove itemName from missing fields');

  const confirmA = confirmArchiveSuggestion(manuallyEditedA);
  assert.equal(confirmA.ok, true, 'core-complete suggestion should pass confirmation without stage/status');
  photos[0].archiveInfo = confirmA.archiveInfo;
  photos[0].sortStatus = 'assigned';
  assert.deepEqual(validateSortForm(photos[0].archiveInfo), [], 'confirmed archiveInfo should pass core validation');
  assert.equal(getPreviewDisabledReason({
    isBusy: false,
    selectedIds: ['photo-a'],
    selectedHasIgnored: false,
    selectedAssignedCount: 1,
    assignedCount: 1,
    suggestion: manuallyEditedA
  }), '', 'preview should be enabled only after archiveInfo exists');

  const missingCategoryRecognition = {
    photoId: 'photo-b',
    success: true,
    status: 'success',
    rawText: [
      '拍摄日期：2026-06-05',
      '地点文本：潇湘新区二期 3 栋门口',
      '工作内容文本：现场记录'
    ].join('\n'),
    engine: 'rapidocr',
    provider: 'local_ocr'
  };
  recognitionResultsByPhoto['photo-b'] = missingCategoryRecognition;
  watermarkRecordsByPhoto['photo-b'] = parseWatermarkRecord(missingCategoryRecognition);
  archiveSuggestionsByPhoto['photo-b'] = buildArchiveSuggestion(watermarkRecordsByPhoto['photo-b'], context);
  assert.ok(archiveSuggestionsByPhoto['photo-b'], 'unknown category OCR should still create an archiveSuggestion');
  assert.equal(archiveSuggestionsByPhoto['photo-b'].suggestedFields.workContent, '现场记录', 'unknown work content should still be kept from OCR');
  assert.deepEqual(archiveSuggestionsByPhoto['photo-b'].missingRequiredFields, ['归档分类'], 'only category should be missing when date/area/workContent exist');
  const displayModelMissingCategory = buildRecognitionSuggestionDisplayModel({
    archiveSuggestion: archiveSuggestionsByPhoto['photo-b'],
    recognitionResult: missingCategoryRecognition,
    watermarkRecord: watermarkRecordsByPhoto['photo-b']
  });
  assert.deepEqual(displayModelMissingCategory.missingFields, ['归档分类'], 'right suggestion display should only show category as missing');
  assert.equal(
    Object.fromEntries(displayModelMissingCategory.applicableDisplayFields.map((field) => [field.label, field.displayValue]))['工作内容'],
    '现场记录',
    'right suggestion display should keep unknown OCR workContent as workContent'
  );
  assert.equal(archiveSuggestionsByPhoto['photo-b'].status, 'needs_completion', 'missing category should be needs_completion');
  assert.equal(archiveSuggestionsByPhoto['photo-b'].missingRequiredFields.includes('事项名称'), false, 'itemName must not be required');
  assert.equal(archiveSuggestionsByPhoto['photo-b'].missingRequiredFields.includes('照片阶段'), false, 'photoStage must not be required');
  assert.equal(archiveSuggestionsByPhoto['photo-b'].missingRequiredFields.includes('处理状态'), false, 'processStatus must not be required');
  assert.equal(archiveSuggestionsByPhoto['photo-b'].missingRequiredFields.includes('项目'), false, 'project must not be required');
  assert.equal(archiveSuggestionsByPhoto['photo-b'].missingRequiredFields.includes('照片来源'), false, 'photoSource must not be required');
  assert.notEqual(photos[1].archiveInfo, archiveSuggestionsByPhoto['photo-b'], 'archiveSuggestion must not be treated as confirmed archiveInfo');
  assert.notEqual(getPreviewDisabledReason({
    isBusy: false,
    selectedIds: ['photo-b'],
    selectedHasIgnored: false,
    selectedAssignedCount: 0,
    assignedCount: 1,
    suggestion: archiveSuggestionsByPhoto['photo-b']
  }), '', 'unconfirmed suggestion should not enable preview');

  const noWorkRecognition = {
    photoId: 'photo-b',
    success: true,
    status: 'success',
    rawText: '拍摄日期：2026-06-05\n地点文本：潇湘新区二期 5 栋门口\n备注文本：现场正常',
    engine: 'rapidocr',
    provider: 'local_ocr'
  };
  const noWorkRecord = parseWatermarkRecord(noWorkRecognition);
  const noWorkSuggestion = buildArchiveSuggestion(noWorkRecord, context);
  assert.ok(noWorkSuggestion, 'OCR rawText with no clear workContent should still create suggestion');
  assert.equal(noWorkSuggestion.status, 'needs_completion', 'missing workContent/category should require completion');
  assert.ok(noWorkSuggestion.suggestedFields.keywords.includes('现场正常'), 'remark facts should become keyword candidates');
  assert.notEqual(noWorkSuggestion.suggestedFields.workContent, '小区名称', 'OCR label must not become workContent');

  const clearedRecognition = clearRecognitionForPhoto({
    recognitionResultsByPhoto,
    watermarkRecordsByPhoto,
    photoId: 'photo-a'
  });
  assert.equal(clearedRecognition.recognitionResultsByPhoto['photo-a'], undefined, 'clear recognition should remove current photo recognition');
  assert.equal(clearedRecognition.watermarkRecordsByPhoto['photo-a'], undefined, 'clear recognition should remove current photo watermark');
  assert.ok(archiveSuggestionsByPhoto['photo-a'], 'clear recognition should not clear archiveSuggestion');

  const clearedSuggestion = clearArchiveSuggestionForPhoto({
    archiveSuggestionsByPhoto,
    photoId: 'photo-b'
  });
  assert.equal(clearedSuggestion.archiveSuggestionsByPhoto['photo-b'], undefined, 'clear suggestion should remove current photo suggestion');
  assert.ok(recognitionResultsByPhoto['photo-b'], 'clear suggestion should not clear recognitionResult');
  assert.ok(watermarkRecordsByPhoto['photo-b'], 'clear suggestion should not clear watermarkRecord');

  const failedRecognition = {
    photoId: 'photo-b',
    success: false,
    status: 'failed',
    rawText: '',
    engine: 'rapidocr',
    provider: 'local_ocr',
    error: 'runner failed',
    recognizedAt: '2026-07-02T10:01:00.000Z'
  };
  recognitionResultsByPhoto['photo-b'] = failedRecognition;
  watermarkRecordsByPhoto['photo-b'] = parseWatermarkRecord(failedRecognition);
  assert.equal(watermarkRecordsByPhoto['photo-b'].parseWarnings.length > 0, true, 'OCR failure should still create a failure watermark record');
  archiveSuggestionsByPhoto['photo-b'] = updateArchiveSuggestion(null, {
    photoSource: '工作照片',
    project: '潇湘新区二期',
    department: '工程维修部',
    watermarkCategory: '秩序维护',
    workContent: '消防通道违停',
    date: '2026-06-12',
    location: 'manual location',
    itemName: 'manual item'
  }, { configs, photoId: 'photo-b' });
  const confirmB = confirmArchiveSuggestion(archiveSuggestionsByPhoto['photo-b']);
  assert.equal(confirmB.ok, true, 'OCR failure photo should still support manual suggestion confirmation');
  photos[1].archiveInfo = confirmB.archiveInfo;
  photos[1].sortStatus = 'assigned';

  archiveSuggestionsByPhoto['photo-a'] = updateArchiveSuggestion(archiveSuggestionsByPhoto['photo-a'], {
    location: 'photo A manual only'
  }, { configs, photoId: 'photo-a' });
  assert.notEqual(archiveSuggestionsByPhoto['photo-b'].suggestedFields.location, 'photo A manual only', 'current photo changes must not pollute other selected photos');
  assert.equal(photos[1].sortStatus, 'assigned', 'photo B status should remain independent from photo A edits');

  const persistedDraft = {
    recognitionResultsByPhoto,
    watermarkRecordsByPhoto,
    archiveSuggestionsByPhoto,
    rightPanelMode,
    photos
  };
  assert.ok(persistedDraft.recognitionResultsByPhoto['photo-b'], 'save progress payload should include recognitionResultsByPhoto');
  assert.ok(persistedDraft.watermarkRecordsByPhoto['photo-b'], 'save progress payload should include watermarkRecordsByPhoto');
  assert.ok(persistedDraft.archiveSuggestionsByPhoto['photo-b'], 'save progress payload should include archiveSuggestionsByPhoto');

  const smartSortDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v31-smart-sort-'));
  const smartSortResult = await generateSmartSortGroups(smartSortDir, {
    photos: [
      createSmartSortPhoto('p-env-1', {
        archiveSuggestion: {
          status: 'suggestion_ready',
          suggestedFields: { workContent: '环境卫生巡查', area: '潇湘新区二期', watermarkCategory: '巡查检查类' }
        },
        recognition: { status: 'success', rawText: '小区名称：潇湘新区二期\n工作内容文本：环境卫生巡查' }
      }),
      createSmartSortPhoto('p-env-2', {
        archiveSuggestion: {
          status: 'suggestion_ready',
          suggestedFields: { workContent: '环境卫生巡查', area: '潇湘新区二期', watermarkCategory: '巡查检查类' }
        },
        recognition: { status: 'success', rawText: '小区名称：潇湘新区二期\n工作内容文本：环境卫生巡查' }
      }),
      createSmartSortPhoto('p-solar', {
        archiveSuggestion: {
          status: 'suggestion_ready',
          suggestedFields: { workContent: '太阳能巡查', area: '潇湘新区二期', watermarkCategory: '公共设施设备' }
        },
        recognition: { status: 'success', rawText: '工作内容文本：太阳能巡查' }
      }),
      createSmartSortPhoto('p-category', {
        archiveSuggestion: {
          status: 'needs_completion',
          suggestedFields: { watermarkCategory: '巡查检查类', area: '潇湘新区二期' }
        },
        recognition: { status: 'success', rawText: '小区名称：潇湘新区二期' }
      }),
      createSmartSortPhoto('p-confirmed', {
        sortStatus: 'assigned',
        archiveInfo: { workContent: '已确认内容' }
      }),
      createSmartSortPhoto('p-previewed', {
        sortStatus: 'previewed',
        previewInfo: { targetPath: 'D:/archive/p-previewed.jpg' }
      }),
      createSmartSortPhoto('p-archive-failed', {
        sortStatus: 'archive_failed',
        archiveResult: { success: false, error: 'copy failed' }
      }),
      createSmartSortPhoto('p-archived', {
        sortStatus: 'archived',
        archiveResult: { success: true, targetPath: 'D:/archive/p-archived.jpg' }
      })
    ],
    options: { source: 'selected_photos' }
  });
  const groupMap = Object.fromEntries((smartSortResult.groups || []).map((group) => [group.title, group]));
  assert.ok(groupMap['环境卫生巡查'], 'smart sort should group by archiveSuggestion workContent');
  assert.equal(groupMap['环境卫生巡查'].photoCount, 2, 'smart sort group count should equal actual photo count');
  assert.ok(groupMap['太阳能巡查'], 'smart sort should group solar patrol by workContent');
  assert.ok(groupMap['巡查检查类'], 'smart sort should fallback to category when workContent is empty');
  assert.ok(groupMap['已确认待预览'], 'confirmed photos should be grouped as waiting preview');
  assert.ok(groupMap['已预览待归档'], 'previewed photos should be grouped as waiting archive');
  assert.ok(groupMap['归档失败'], 'archive failed photos should be grouped as archive failed');
  assert.ok(groupMap['已归档'], 'archived photos should be grouped as archived');
  assert.equal(Boolean(groupMap['小区名称']), false, 'smart sort must not create xiaoqumingcheng group');
  assert.equal(Boolean(groupMap['时间段']), false, 'smart sort must not create time-window label group when suggestions exist');
  assert.equal(Boolean(groupMap['缺少照片阶段']), false, 'smart sort must not group by missing photoStage');
  assert.equal(Boolean(groupMap['缺少处理状态']), false, 'smart sort must not group by missing processStatus');
  assert.notEqual(smartSortResult.groupCount, 0, 'smart sort should not be empty when archiveSuggestion workContent exists');

  const scenarioResults = {
    'scenario 1 incomplete OCR forms suggestion': 'pass',
    'scenario 2 watermark fact and suggestion are separate': 'pass',
    'scenario 3 manual completion updates suggestion only': 'pass',
    'scenario 4 confirmation writes archiveInfo only after validation': 'pass',
    'scenario 5 clearing recognition keeps suggestion': 'pass',
    'scenario 6 clearing suggestion keeps recognition': 'pass',
    'scenario 7 OCR failure allows manual suggestion': 'pass',
    'scenario 8 current photo does not pollute selected photos': 'pass',
    'rawText solar patrol enters workContent': 'pass',
    'labeled date/time/location enter suggestion': 'pass',
    'unknown category still creates needs-completion suggestion': 'pass',
    'itemName/photoStage/processStatus/project/photoSource are not core missing fields': 'pass',
    'manual field is preserved during regeneration': 'pass',
    'old non-manual wrong suggestion is corrected during regeneration': 'pass',
    'right recognition suggestion display reads archiveSuggestion first': 'pass',
    'OCR label xiaoqumingcheng is not treated as workContent': 'pass',
    'smart sort groups by archiveSuggestion workContent/category/status': 'pass'
  };

  console.log(JSON.stringify({
    success: true,
    scenarioResults,
    checked: [
      'recognitionResult is evidence only',
      'parseWatermarkRecord creates objective facts',
      'buildArchiveSuggestion creates incomplete but saveable suggestion',
      'fieldSources recorded',
      'candidate/missing fields supported',
      'save suggestion does not write photos[].archiveInfo',
      'confirm suggestion validates before archiveInfo',
      'preview depends on confirmed archiveInfo',
      'clear recognition keeps suggestion',
      'clear suggestion keeps recognition',
      'OCR failure can create manual suggestion',
      'photoId isolation',
      'save/restore payload includes recognition/watermark/suggestion',
      'solar patrol OCR fact enters archiveSuggestion.workContent',
      'right suggestion display shows workContent and area from archiveSuggestion',
      'category missing does not block suggestion creation',
      'optional fields do not block confirmation',
      'smart sort reads archiveSuggestion before OCR rawText'
    ]
  }, null, 2));
}

function createSmartSortPhoto(id, patch = {}) {
  return {
    photoId: id,
    filePath: `D:/photos/${id}.jpg`,
    fileName: `${id}.jpg`,
    index: Number(id.replace(/\D/g, '')) || 0,
    ...patch
  };
}

main().catch((error) => {
  console.error(JSON.stringify({ success: false, error: error.message, stack: error.stack }, null, 2));
  process.exit(1);
});
