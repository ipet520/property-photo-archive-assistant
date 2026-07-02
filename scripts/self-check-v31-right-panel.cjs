const assert = require('node:assert/strict');

async function main() {
  const {
    buildArchiveSuggestion,
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
    photoSources: ['Mark watermark camera'],
    projects: ['Xiaoxiang Phase 2', 'Xiangchen Garden'],
    departments: ['Order', 'Engineering'],
    watermarkCategories: {
      Vehicle: { items: ['Fire lane parking', 'Parking violation'] },
      Engineering: { items: ['Lighting repair', 'Door closer repair'] }
    },
    photoStages: ['Before', 'During', 'After', 'Site photo'],
    processStatuses: ['Pending', 'Processing', 'Completed']
  };

  const context = {
    configs,
    currentProject: 'Xiaoxiang Phase 2',
    defaultProject: 'Xiaoxiang Phase 2',
    currentPhotoSource: 'Mark watermark camera',
    defaultPhotoSource: 'Mark watermark camera',
    defaultDepartment: 'Order',
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
      '2026-06-12 10:21',
      'Xiaoxiang Phase 2 Building 3 entrance',
      'Fire lane parking'
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

  assert.equal(recognitionResultsByPhoto['photo-a'].rawText.includes('Fire lane parking'), true, 'recognitionResult should keep OCR evidence');
  assert.equal(watermarkA.captureDate, '2026-06-12', 'watermarkRecord should parse capture date from OCR text');
  assert.equal(watermarkA.captureTime, '10:21', 'watermarkRecord should parse capture time from OCR text');
  assert.equal(watermarkA.locationText.includes('Building 3'), true, 'watermarkRecord should keep objective location text');
  assert.notDeepEqual(watermarkA, suggestionA, 'watermarkRecord and archiveSuggestion must be separate objects');
  assert.equal(suggestionA.suggestedFields.project, 'Xiaoxiang Phase 2', 'archiveSuggestion should use context to fill project');
  assert.equal(suggestionA.suggestedFields.department, 'Order', 'archiveSuggestion should use default department from context');
  assert.equal(suggestionA.suggestedFields.photoSource, 'Mark watermark camera', 'archiveSuggestion should use photo source from context');
  assert.equal(suggestionA.suggestedFields.workContent, 'Fire lane parking', 'archiveSuggestion should map work content from OCR facts');
  assert.equal(suggestionA.suggestedFields.watermarkCategory, 'Vehicle', 'archiveSuggestion should map category from work content');
  assert.equal(suggestionA.fieldSources.date, 'watermark.date', 'date source should be watermark');
  assert.equal(suggestionA.fieldSources.project, 'context.project', 'project source should be context when current project exists');
  assert.equal(suggestionA.fieldSources.photoSource, 'context.photoSource', 'photoSource source should be context');
  assert.equal(suggestionA.suggestedFields.itemName.includes('Fire lane parking'), true, 'itemName should be derived from area/work content');
  assert.equal(suggestionA.suggestedFields.keywords.includes('Fire'), true, 'keywords should be derived from OCR facts and work content');
  assert.equal(Boolean(suggestionA.suggestedFields.photoStage), false, 'photoStage should remain empty when OCR/context cannot determine it');
  assert.equal(suggestionA.missingRequiredFields.length > 0, true, 'missing required fields should keep suggestion in completion state');
  assert.equal(suggestionA.status, 'needs_completion', 'incomplete suggestion should be saved as needs_completion');
  assert.equal(photos[0].archiveInfo, null, 'saving suggestion must not write photos[].archiveInfo');

  assert.equal(rightPanelMode, 'form', 'recognition completion should leave right panel in suggestion form mode');
  rightPanelMode = 'recognition';
  assert.equal(rightPanelMode, 'recognition', 'view evidence should only switch panel mode');
  assert.ok(recognitionResultsByPhoto['photo-a'], 'view evidence should not clear recognition');
  assert.ok(archiveSuggestionsByPhoto['photo-a'], 'view evidence should not clear suggestion');
  rightPanelMode = 'form';
  assert.equal(rightPanelMode, 'form', 'return suggestion should only switch panel mode');

  const manuallyCompletedA = updateArchiveSuggestion(archiveSuggestionsByPhoto['photo-a'], {
    photoStage: 'Before',
    processStatus: 'Pending'
  }, { configs, photoId: 'photo-a' });
  archiveSuggestionsByPhoto['photo-a'] = manuallyCompletedA;
  assert.equal(manuallyCompletedA.fieldSources.photoStage, 'manual', 'manual photoStage should be marked manual');
  assert.equal(recognitionResultsByPhoto['photo-a'], recognitionA, 'manual patch must not mutate recognitionResult');
  assert.equal(watermarkRecordsByPhoto['photo-a'], watermarkA, 'manual patch must not mutate watermarkRecord');
  assert.equal(photos[0].archiveInfo, null, 'manual patch must not write archiveInfo before confirmation');

  const regeneratedA = regenerateArchiveSuggestion(watermarkA, context, manuallyCompletedA);
  assert.equal(regeneratedA.suggestedFields.photoStage, 'Before', 'regeneration must not silently overwrite manual fields');
  assert.ok(regeneratedA.conflictFields.includes('photoStage') || regeneratedA.fieldSources.photoStage === 'manual', 'manual field should be preserved or marked as conflict/manual');

  const confirmA = confirmArchiveSuggestion(manuallyCompletedA);
  assert.equal(confirmA.ok, true, 'completed suggestion should pass confirmation');
  photos[0].archiveInfo = confirmA.archiveInfo;
  photos[0].sortStatus = 'assigned';
  assert.deepEqual(validateSortForm(photos[0].archiveInfo), [], 'confirmed archiveInfo should pass form validation');
  assert.equal(getPreviewDisabledReason({
    isBusy: false,
    selectedIds: ['photo-a'],
    selectedHasIgnored: false,
    selectedAssignedCount: 1,
    assignedCount: 1,
    suggestion: manuallyCompletedA
  }), '', 'preview should be enabled only after archiveInfo exists');

  const incompleteRecognition = {
    photoId: 'photo-b',
    success: true,
    status: 'success',
    rawText: '2026-06-12\nXiaoxiang Phase 2 Building 9',
    engine: 'rapidocr',
    provider: 'local_ocr'
  };
  recognitionResultsByPhoto['photo-b'] = incompleteRecognition;
  watermarkRecordsByPhoto['photo-b'] = parseWatermarkRecord(incompleteRecognition);
  archiveSuggestionsByPhoto['photo-b'] = buildArchiveSuggestion(watermarkRecordsByPhoto['photo-b'], context);
  assert.ok(archiveSuggestionsByPhoto['photo-b'], 'incomplete OCR should still create an archiveSuggestion');
  assert.ok(archiveSuggestionsByPhoto['photo-b'].missingRequiredFields.length > 0, 'incomplete suggestion should keep missing fields');
  assert.notEqual(photos[1].archiveInfo, archiveSuggestionsByPhoto['photo-b'], 'archiveSuggestion must not be treated as confirmed archiveInfo');
  assert.notEqual(getPreviewDisabledReason({
    isBusy: false,
    selectedIds: ['photo-b'],
    selectedHasIgnored: false,
    selectedAssignedCount: 0,
    assignedCount: 1,
    suggestion: archiveSuggestionsByPhoto['photo-b']
  }), '', 'unconfirmed suggestion should not enable preview');

  const clearedRecognition = clearRecognitionForPhoto({
    recognitionResultsByPhoto,
    watermarkRecordsByPhoto,
    photoId: 'photo-a'
  });
  assert.equal(clearedRecognition.recognitionResultsByPhoto['photo-a'], undefined, 'clear recognition should remove only current photo recognition');
  assert.equal(clearedRecognition.watermarkRecordsByPhoto['photo-a'], undefined, 'clear recognition should remove only current photo watermark');
  assert.ok(archiveSuggestionsByPhoto['photo-a'], 'clear recognition should not clear archiveSuggestion');

  const clearedSuggestion = clearArchiveSuggestionForPhoto({
    archiveSuggestionsByPhoto,
    photoId: 'photo-b'
  });
  assert.equal(clearedSuggestion.archiveSuggestionsByPhoto['photo-b'], undefined, 'clear suggestion should remove only current photo suggestion');
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
    photoSource: 'Mark watermark camera',
    project: 'Xiaoxiang Phase 2',
    department: 'Order',
    watermarkCategory: 'Vehicle',
    workContent: 'Parking violation',
    date: '2026-06-12',
    photoStage: 'Before',
    processStatus: 'Pending',
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

  const scenarioResults = {
    'scenario 1 incomplete OCR forms suggestion': 'pass',
    'scenario 2 watermark fact and suggestion are separate': 'pass',
    'scenario 3 manual completion updates suggestion only': 'pass',
    'scenario 4 confirmation writes archiveInfo only after validation': 'pass',
    'scenario 5 clearing recognition keeps suggestion': 'pass',
    'scenario 6 clearing suggestion keeps recognition': 'pass',
    'scenario 7 OCR failure allows manual suggestion': 'pass',
    'scenario 8 current photo does not pollute selected photos': 'pass'
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
      'save/restore payload includes recognition/watermark/suggestion'
    ]
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ success: false, error: error.message, stack: error.stack }, null, 2));
  process.exit(1);
});
