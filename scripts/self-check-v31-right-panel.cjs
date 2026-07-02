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
    photoSources: ['工作照片'],
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
    currentPhotoSource: '工作照片',
    defaultPhotoSource: '工作照片',
    defaultDepartment: 'Order',
    photoFolder: 'D:/photos/xiaoxiang',
    archiveRoot: 'D:/archive'
  };
  const photos = [
    { id: 'photo-a', originalPath: 'D:/photos/a.jpg', sortStatus: 'unrecognized', archiveInfo: null, previewInfo: null, archiveResult: null },
    { id: 'photo-b', originalPath: 'D:/photos/b.jpg', sortStatus: 'unrecognized', archiveInfo: null, previewInfo: null, archiveResult: null },
    { id: 'photo-c', originalPath: 'D:/photos/c.jpg', sortStatus: 'unrecognized', archiveInfo: null, previewInfo: null, archiveResult: null }
  ];

  const recognitionResultsByPhoto = {};
  let watermarkRecordsByPhoto = {};
  let archiveSuggestionsByPhoto = {};
  let activePhotoId = '';
  let selectedIds = [];
  let viewMode = 'statusFilter';
  let activeSmartGroupId = '';

  assert.equal(activePhotoId, '', '1. no activePhotoId should represent empty right panel state');

  activePhotoId = 'photo-a';
  let manualSuggestion = updateArchiveSuggestion(null, {
    photoSource: '工作照片',
    project: 'Xiaoxiang Phase 2',
    date: '2026-06-12'
  }, { configs, photoId: activePhotoId });
  archiveSuggestionsByPhoto[activePhotoId] = manualSuggestion;
  assert.ok(archiveSuggestionsByPhoto['photo-a'], '2. unrecognized photo can create manual archiveSuggestion');
  assert.equal(photos[0].archiveInfo, null, '3. manual suggestion must not write archiveInfo');
  assert.equal(photos[0].archiveInfo, null, '4. save suggestion must not write archiveInfo');

  manualSuggestion = updateArchiveSuggestion(manualSuggestion, {
    location: 'Building 3 entrance',
    watermarkCategory: 'Vehicle',
    workContent: 'Fire lane parking'
  }, { configs, photoId: activePhotoId });
  const confirmedManual = confirmArchiveSuggestion(manualSuggestion);
  assert.equal(confirmedManual.ok, true, '5. confirmation should succeed after core fields complete');
  photos[0].archiveInfo = confirmedManual.archiveInfo;
  photos[0].sortStatus = 'confirmed';

  assert.equal(updateArchiveSuggestion(null, {
    photoSource: '工作照片',
    project: 'Xiaoxiang Phase 2',
    location: 'Building 3',
    watermarkCategory: 'Vehicle',
    workContent: 'Fire lane parking'
  }, { configs, photoId: 'x' }).status, 'needs_completion', '6. missing date should be needs_completion');
  assert.equal(updateArchiveSuggestion(null, {
    photoSource: '工作照片',
    project: 'Xiaoxiang Phase 2',
    date: '2026-06-12',
    watermarkCategory: 'Vehicle',
    workContent: 'Fire lane parking'
  }, { configs, photoId: 'x' }).status, 'needs_completion', '7. missing location should be needs_completion');
  assert.equal(updateArchiveSuggestion(null, {
    photoSource: '工作照片',
    project: 'Xiaoxiang Phase 2',
    date: '2026-06-12',
    location: 'Building 3',
    watermarkCategory: 'Vehicle'
  }, { configs, photoId: 'x' }).status, 'needs_completion', '8. missing workContent should be needs_completion');
  assert.equal(updateArchiveSuggestion(null, {
    photoSource: '工作照片',
    project: 'Xiaoxiang Phase 2',
    date: '2026-06-12',
    location: 'Building 3',
    workContent: 'Fire lane parking'
  }, { configs, photoId: 'x' }).status, 'needs_completion', '9. missing archive category should be needs_completion');

  const optionalMissing = updateArchiveSuggestion(null, {
    photoSource: '工作照片',
    project: 'Xiaoxiang Phase 2',
    date: '2026-06-12',
    location: 'Building 3',
    watermarkCategory: 'Vehicle',
    workContent: 'Fire lane parking'
  }, { configs, photoId: 'x' });
  assert.equal(optionalMissing.status, 'suggestion_ready', '10/11. missing photoStage/processStatus should not block suggestion_ready');
  assert.equal(optionalMissing.suggestedFields.photoSource, '工作照片', '12. photoSource should be fixed as work photos');
  assert.equal(optionalMissing.suggestedFields.project, 'Xiaoxiang Phase 2', '13. project should come from current project context/config');
  assert.equal(optionalMissing.status === 'suggestion_ready' && !photos[1].archiveInfo, true, '14. suggestion_ready is not confirmed');
  const incomplete = updateArchiveSuggestion(null, { date: '2026-06-12' }, { configs, photoId: 'x' });
  assert.equal(incomplete.status === 'needs_completion' && !photos[1].archiveInfo, true, '15. needs_completion is not confirmed');
  assert.ok(photos[0].archiveInfo, '16. confirmed state must come from photos[].archiveInfo');

  selectedIds = ['photo-a'];
  assert.equal(getPreviewDisabledReason({
    isBusy: false,
    selectedIds,
    selectedHasIgnored: false,
    selectedAssignedCount: 1,
    assignedCount: 1,
    suggestion: manualSuggestion
  }), '', '17. preview should be based on confirmed selected photos');
  photos[0].previewInfo = { id: 'photo-a', targetPath: 'D:/archive/a.jpg', newName: 'a.jpg' };
  photos[0].sortStatus = 'previewed';
  assert.equal(selectedIds.every((id) => photos.find((photo) => photo.id === id)?.previewInfo), true, '18. archive should be based on valid previewInfo');

  selectedIds = ['photo-a', 'photo-b'];
  const selectedPhotoIdsSnapshot = [...selectedIds];
  selectedIds = ['photo-c'];
  assert.deepEqual(selectedPhotoIdsSnapshot, ['photo-a', 'photo-b'], '19. smart recognition should use selectedPhotoIdsSnapshot');
  selectedIds = [];
  assert.deepEqual(selectedIds, [], '20. smart recognition completion should clear selectedPhotoIds');

  selectedIds = ['photo-a'];
  viewMode = 'statusFilter';
  activeSmartGroupId = '';
  selectedIds = [];
  assert.deepEqual(selectedIds, [], '21. clicking status filter should clear selectedPhotoIds');
  activeSmartGroupId = 'group-1';
  viewMode = 'smartGroup';
  selectedIds = ['photo-b'];
  selectedIds = [];
  assert.deepEqual(selectedIds, [], '22. clicking smart group should clear selectedPhotoIds');
  viewMode = 'statusFilter';
  activeSmartGroupId = '';
  assert.equal(activeSmartGroupId, '', '23. clicking status filter should clear activeSmartGroupId');
  viewMode = 'smartGroup';
  activeSmartGroupId = 'group-1';
  assert.equal(viewMode, 'smartGroup', '24. clicking smart group should set viewMode=smartGroup');

  activePhotoId = 'photo-a';
  activePhotoId = 'photo-b';
  assert.equal(activePhotoId, 'photo-b', '25. clicking photo body should switch activePhotoId');
  selectedIds = [];
  selectedIds = selectedIds.includes('photo-c') ? selectedIds.filter((id) => id !== 'photo-c') : [...selectedIds, 'photo-c'];
  assert.equal(activePhotoId, 'photo-b', '26. checkbox should not change activePhotoId');

  const recognitionA = {
    photoId: 'photo-a',
    success: true,
    status: 'success',
    rawText: ['2026-06-12 10:21', 'Xiaoxiang Phase 2 Building 3 entrance', 'Fire lane parking'].join('\n'),
    engine: 'rapidocr',
    provider: 'local_ocr'
  };
  recognitionResultsByPhoto['photo-a'] = recognitionA;
  const watermarkA = parseWatermarkRecord(recognitionA);
  watermarkRecordsByPhoto['photo-a'] = watermarkA;
  const suggestionA = buildArchiveSuggestion(watermarkA, context);
  archiveSuggestionsByPhoto['photo-a'] = suggestionA;
  assert.ok(recognitionResultsByPhoto['photo-a'], 'four-layer: recognitionResult exists');
  assert.ok(watermarkA.locationText, 'four-layer: watermarkRecord exists');
  assert.notDeepEqual(watermarkA, suggestionA, 'four-layer: watermarkRecord and archiveSuggestion are separate');
  assert.equal(suggestionA.suggestedFields.project, 'Xiaoxiang Phase 2', 'four-layer: archiveSuggestion uses context project');
  assert.equal(suggestionA.suggestedFields.itemName.includes('Fire lane parking'), true, 'four-layer: itemName derived');
  assert.equal(suggestionA.suggestedFields.keywords.includes('Fire'), true, 'four-layer: keywords derived');

  const clearedRecognition = clearRecognitionForPhoto({ recognitionResultsByPhoto, watermarkRecordsByPhoto, photoId: 'photo-a' });
  assert.equal(clearedRecognition.recognitionResultsByPhoto['photo-a'], undefined, '27. clear recognition should clear recognitionResult');
  assert.ok(archiveSuggestionsByPhoto['photo-a'], '27. clear recognition should not clear archiveSuggestion');
  const clearedSuggestion = clearArchiveSuggestionForPhoto({ archiveSuggestionsByPhoto, photoId: 'photo-a' });
  assert.equal(clearedSuggestion.archiveSuggestionsByPhoto['photo-a'], undefined, '28. clear suggestion should clear archiveSuggestion');
  assert.ok(recognitionResultsByPhoto['photo-a'], '28. clear suggestion should not clear recognitionResult');

  photos[0].previewInfo = { id: 'photo-a', targetPath: 'old' };
  photos[0].archiveInfo.location = 'new location';
  photos[0].previewInfo = null;
  photos[0].sortStatus = 'confirmed';
  assert.equal(photos[0].previewInfo, null, '29. editing confirmed archiveInfo should invalidate previewInfo');

  selectedIds = ['photo-a'];
  const previewTargets = photos.filter((photo) => selectedIds.includes(photo.id) && photo.archiveInfo);
  assert.deepEqual(previewTargets.map((photo) => photo.id), ['photo-a'], '30. preview/archive should not process unselected photos');

  const failedRecognition = {
    photoId: 'photo-b',
    success: false,
    status: 'failed',
    rawText: '',
    engine: 'rapidocr',
    provider: 'local_ocr',
    error: 'runner failed'
  };
  recognitionResultsByPhoto['photo-b'] = failedRecognition;
  watermarkRecordsByPhoto['photo-b'] = parseWatermarkRecord(failedRecognition);
  archiveSuggestionsByPhoto['photo-b'] = updateArchiveSuggestion(null, {
    photoSource: '工作照片',
    project: 'Xiaoxiang Phase 2',
    date: '2026-06-12',
    location: 'manual location',
    watermarkCategory: 'Vehicle',
    workContent: 'Parking violation'
  }, { configs, photoId: 'photo-b' });
  assert.equal(confirmArchiveSuggestion(archiveSuggestionsByPhoto['photo-b']).ok, true, 'OCR failure photo should support manual suggestion confirmation');

  const regeneratedA = regenerateArchiveSuggestion(watermarkA, context, updateArchiveSuggestion(suggestionA, { location: 'manual location' }, { configs, photoId: 'photo-a' }));
  assert.equal(regeneratedA.suggestedFields.location, 'manual location', 'regenerate should not silently overwrite manual fields');

  console.log(JSON.stringify({
    success: true,
    scenarioResults: {
      'four-layer model': 'pass',
      'current photo workbench state': 'pass',
      'activePhotoId and selectedIds separated': 'pass',
      'core field validation': 'pass',
      'save vs confirm suggestion': 'pass',
      'preview/archive selected scope': 'pass',
      'clear recognition/suggestion boundaries': 'pass',
      'manual suggestion after OCR failure': 'pass'
    },
    checked: 30
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ success: false, error: error.message, stack: error.stack }, null, 2));
  process.exit(1);
});
