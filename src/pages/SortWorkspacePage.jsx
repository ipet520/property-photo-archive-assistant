import { useEffect, useMemo, useRef, useState } from 'react';
import ThumbnailHoverPreview from '../components/ThumbnailHoverPreview.jsx';
import {
  SMART_SORT_CONFIDENCE_LABELS,
  SMART_SORT_GROUP_STATUS_LABELS
} from '../constants/smartSort.js';
import { OCR_COMPONENT_VERSION, PAGE_KEYS } from '../constants/app.js';
import { formatFileSize, getSuggestedKeywords } from '../utils/formatters.js';
import { mergeMarkiWorkbenchImportPackage } from '../utils/markiWorkbenchImport.js';
import { recordRuntimeLog } from '../utils/runtimeLogger.js';
import { getUsableArchiveRoot, withRuntimeConfigFallback } from '../utils/runtimeConfig.js';
import {
  buildArchiveSuggestion,
  buildCurrentPhotoArchiveServiceForm,
  buildRecognitionSuggestionDisplayModel,
  clearArchiveSuggestionForPhoto,
  clearRecognitionForPhoto,
  confirmArchiveSuggestion,
  getSuggestionSourceLabel,
  parseWatermarkRecord,
  regenerateArchiveSuggestion,
  sanitizeDraftFields,
  updateArchiveSuggestion,
  validateRequiredArchiveFields,
  validateSortForm
} from '../utils/sortRightPanelState.js';
import {
  clearCandidateFieldSetsByPhoto,
  clearFormPatchDraftsByPhoto,
  clearReviewDecisionsByPhoto,
  clearReviewDraftsByPhoto,
  clearStagedResultsByPhoto,
  getRecognitionStatus,
  recognizePhoto,
  updateStagedResultStatus
} from '../utils/recognitionClient.js';
import {
  clearSmartSortGroups,
  generateSmartSortGroups
} from '../utils/smartSortClient.js';

const defaultForm = {
  project: '',
  watermarkCategory: '',
  workContent: '',
  date: new Date().toISOString().slice(0, 10),
  location: '',
  keywords: '',
  remark: ''
};

const statusLabels = {
  unassigned: '待智拣',
  unrecognized: '待智拣',
  recognizing: '识别中',
  recognition_failed: '识别失败',
  recognition_empty: '待补充',
  recognized: '待整理',
  suggestion_ready: '待整理',
  needs_completion: '待补充',
  confirmed: '待整理',
  assigned: '待预览',
  previewed: '已生成预览',
  archived: '已归档',
  failed: '归档失败',
  archive_failed: '归档失败',
  ignored: '已忽略'
};

const statusFilters = [
  ['all', '全部照片'],
  ['unarchived', '未归档'],
  ['pending_sort', '待智拣'],
  ['pending_organize', '待整理'],
  ['selected', '已选择'],
  ['recognition_issue', '识别异常'],
  ['original_missing', '原图缺失'],
  ['previewed', '已生成预览'],
  ['archived', '已归档'],
  ['failed', '归档失败'],
  ['ignored', '已忽略']
];

const viewModes = [
  { key: 'grid', label: '网格', title: '网格视图' },
  { key: 'list', label: '列表', title: '列表视图' }
];

const recognitionFailureStatuses = new Set(['failed', 'error', 'provider_unavailable', 'not_configured', 'disabled']);
const pendingSortStatuses = new Set(['unassigned', 'unrecognized']);
const pendingOrganizeStatuses = new Set(['recognition_empty', 'recognized', 'suggestion_ready', 'needs_completion', 'confirmed']);

const sortDraftAvailableKey = 'property-photo-sort-draft-available';
const sortSessionPhotoFolderKey = 'property-photo-sort-session-folder';
let sortWorkspaceSessionCache = null;

function resolveEffectivePhotoFolder(loadedSettings, sessionPhotoFolder) {
  const selectedSessionFolder = String(sessionPhotoFolder || '').trim();
  const defaultPhotoFolder = loadedSettings?.pathStatus?.defaultPhotoFolderExists
    ? String(loadedSettings.defaultPhotoFolder || '').trim()
    : '';
  return selectedSessionFolder || defaultPhotoFolder;
}

function normalizeStatusFilter(filter) {
  return filter === 'assigned' ? 'unarchived' : (filter || 'all');
}

export default function SortWorkspacePage({ archiveState, onNavigate, navigationRequest }) {
  const rightPanelRef = useRef(null);
  const photoBrowserRef = useRef(null);
  const sessionPhotoFolderRef = useRef(window.sessionStorage.getItem(sortSessionPhotoFolderKey) || '');
  const cachedSessionRef = useRef(sortWorkspaceSessionCache);
  const sessionSnapshotRef = useRef(cachedSessionRef.current);
  const hasHydratedSessionRef = useRef(false);
  const recoveredArchiveRootsRef = useRef(new Set());
  const processedMarkiImportRequestNoncesRef = useRef(new Set());
  const pendingMarkiFocusPhotoIdRef = useRef('');
  const markiWorkbenchStateRef = useRef(null);
  const isSortWorkspaceMountedRef = useRef(true);
  const cachedSession = cachedSessionRef.current || {};
  const [isSessionHydrated, setIsSessionHydrated] = useState(false);
  const [configs, setConfigs] = useState(null);
  const [settings, setSettings] = useState(null);
  const [photoFolder, setPhotoFolder] = useState(() => cachedSession.photoFolder || '');
  const [archiveRoot, setArchiveRoot] = useState(() => cachedSession.archiveRoot || '');
  const [photos, setPhotos] = useState(() => Array.isArray(cachedSession.photos) ? cachedSession.photos : []);
  const [form, setForm] = useState(() => cachedSession.form || defaultForm);
  const [filter, setFilter] = useState(() => normalizeStatusFilter(cachedSession.filter));
  const [searchText, setSearchText] = useState(() => cachedSession.searchText || '');
  const [viewMode, setViewMode] = useState(() => cachedSession.viewMode || 'grid');
  const [sortMode, setSortMode] = useState(() => cachedSession.sortMode || 'timeAsc');
  const [selectedIds, setSelectedIds] = useState(() => Array.isArray(cachedSession.selectedIds) ? cachedSession.selectedIds : []);
  const [activePhotoId, setActivePhotoId] = useState(() => cachedSession.activePhotoId || '');
  const [lastClickedId, setLastClickedId] = useState(() => cachedSession.lastClickedId || null);
  const [editingPhotoId, setEditingPhotoId] = useState(() => cachedSession.editingPhotoId || '');
  const [lastDraftSavedAt, setLastDraftSavedAt] = useState(() => cachedSession.lastDraftSavedAt || '');
  const [hasSavedDraft, setHasSavedDraft] = useState(() => typeof cachedSession.hasSavedDraft === 'boolean' ? cachedSession.hasSavedDraft : window.localStorage.getItem(sortDraftAvailableKey) === 'true');
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(() => Boolean(cachedSession.hasUnsavedChanges));
  const [showConfirm, setShowConfirm] = useState(false);
  const [status, setStatus] = useState(() => cachedSession.status || { type: 'idle', text: '请选择照片文件夹并扫描照片。' });
  const [isBusy, setIsBusy] = useState(false);
  const [page, setPage] = useState(() => Number(cachedSession.page) || 1);
  const [pageSize, setPageSize] = useState(() => Number(cachedSession.pageSize) || 50);
  const [smartSortResult, setSmartSortResult] = useState(() => cachedSession.smartSortResult || null);
  const [smartSortViewMode, setSmartSortViewMode] = useState(() => cachedSession.smartSortViewMode || 'statusFilter');
  const [activeSmartSortGroupId, setActiveSmartSortGroupId] = useState(() => cachedSession.activeSmartSortGroupId || '');
  const [smartSortMessage, setSmartSortMessage] = useState(() => cachedSession.smartSortMessage || { type: 'idle', text: '' });
  const [isSmartSortBusy, setIsSmartSortBusy] = useState(false);
  const [recognitionResultsByPhoto, setRecognitionResultsByPhoto] = useState(() => cachedSession.recognitionResultsByPhoto || {});
  const [watermarkRecordsByPhoto, setWatermarkRecordsByPhoto] = useState(() => cachedSession.watermarkRecordsByPhoto || {});
  const [archiveSuggestionsByPhoto, setArchiveSuggestionsByPhoto] = useState(() => cachedSession.archiveSuggestionsByPhoto || {});
  const [isRecognitionBusy, setIsRecognitionBusy] = useState(false);
  const [recognitionMessage, setRecognitionMessage] = useState(() => cachedSession.recognitionMessage || { type: 'idle', text: '' });
  const [recognitionProgress, setRecognitionProgress] = useState({ current: 0, total: 0 });
  const [recognitionServiceStatus, setRecognitionServiceStatus] = useState(null);
  const [rightPanelMode, setRightPanelMode] = useState(() => ['form', 'recognition'].includes(cachedSession.rightPanelMode) ? cachedSession.rightPanelMode : 'form');
  const [batchPreparationUndo, setBatchPreparationUndo] = useState(() => cachedSession.batchPreparationUndo || null);

  markiWorkbenchStateRef.current = {
    photos,
    recognitionResultsByPhoto,
    watermarkRecordsByPhoto,
    archiveSuggestionsByPhoto,
    selectedIds,
    activePhotoId
  };

  useEffect(() => {
    isSortWorkspaceMountedRef.current = true;
    return () => {
      isSortWorkspaceMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    Promise.all([
      window.archiveAssistant.loadConfigs(),
      window.archiveAssistant.loadSettings()
    ]).then(([loadedConfigs, loadedSettings]) => {
      const cachedSession = cachedSessionRef.current;
      const safeConfigs = withRuntimeConfigFallback(loadedConfigs);
      const restoredPhotoFolder = resolveEffectivePhotoFolder(loadedSettings, sessionPhotoFolderRef.current);
      const restoredArchiveRoot = getUsableArchiveRoot(loadedSettings);
      setConfigs(safeConfigs);
      setSettings(loadedSettings);
      setForm(reconcileForm(cachedSession?.form || defaultForm, safeConfigs));
      if (cachedSession?.photoFolder) sessionPhotoFolderRef.current = cachedSession.photoFolder;
      setPhotoFolder(cachedSession?.photoFolder || restoredPhotoFolder);
      if (!cachedSession?.status && restoredPhotoFolder) {
        setStatus({ type: 'idle', text: '点击扫描读取当前照片目录。' });
      }
      if (cachedSession?.archiveRoot) setArchiveRoot(cachedSession.archiveRoot);
      else if (restoredArchiveRoot) setArchiveRoot(restoredArchiveRoot);
      hasHydratedSessionRef.current = true;
      setIsSessionHydrated(true);
    }).catch((error) => {
      const safeConfigs = withRuntimeConfigFallback(null);
      setConfigs(safeConfigs);
      setForm(reconcileForm(cachedSessionRef.current?.form || defaultForm, safeConfigs));
      setStatus({ type: 'error', text: `配置加载失败：${error.message}` });
      hasHydratedSessionRef.current = true;
      setIsSessionHydrated(true);
    });
  }, []);

  useEffect(() => {
    let active = true;
    getRecognitionStatus().then((nextStatus) => {
      if (active) setRecognitionServiceStatus(nextStatus);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const normalizedRoot = String(archiveRoot || '').trim();
    if (!isSessionHydrated || !normalizedRoot || recoveredArchiveRootsRef.current.has(normalizedRoot)) return undefined;
    recoveredArchiveRootsRef.current.add(normalizedRoot);
    let active = true;
    void (async () => {
      if (typeof window.archiveAssistant.recoverPendingArchiveTransactions !== 'function') return;
      const recovery = await window.archiveAssistant.recoverPendingArchiveTransactions(normalizedRoot);
      if (!active) return;
      if (recovery?.committedCount > 0 && photos.length > 0) {
        try {
          const matchResult = await window.archiveAssistant.matchArchivedPhotos(normalizedRoot, photos.map((photo) => ({
            id: photo.id,
            path: photo.originalPath,
            size: photo.size
          })));
          const matches = matchResult?.matches || {};
          setPhotos((current) => current.map((photo) => (
            matches[photo.id] ? buildArchivedScannedPhoto(photo, matches[photo.id]) : photo
          )));
        } catch (error) {
          void recordRuntimeLog({
            page: '照片分拣工作台',
            operation: '恢复归档事务后核对照片',
            errorType: '归档状态核对',
            summary: error.message || '归档状态核对失败',
            error
          });
        }
      }
      if (recovery?.pendingLedgerCount > 0) {
        setStatus({ type: 'warning', text: `检测到 ${recovery.pendingLedgerCount} 张照片已复制但台账仍待补记，可重新点击归档恢复。` });
      } else if (recovery?.committedCount > 0) {
        setStatus({ type: 'success', text: `已恢复 ${recovery.committedCount} 张照片的归档台账记录。` });
      } else if (Array.isArray(recovery?.errors) && recovery.errors.length > 0) {
        setStatus({ type: 'warning', text: '检测到归档事务记录异常，已停止自动恢复，请导出运行日志后人工核查。' });
      }
    })().catch((error) => {
      if (!active) return;
      void recordRuntimeLog({
        page: '照片分拣工作台',
        operation: '恢复待处理归档事务',
        errorType: '归档事务恢复',
        summary: error.message || '归档事务恢复失败',
        error
      });
      setStatus({ type: 'warning', text: '待处理归档事务暂未恢复，可稍后重新进入工作台重试。' });
    });
    return () => { active = false; };
  }, [archiveRoot, isSessionHydrated]);

  useEffect(() => {
    if (!isSessionHydrated || !hasHydratedSessionRef.current) return;
    const snapshot = {
      photoFolder,
      archiveRoot,
      photos,
      form,
      filter,
      searchText,
      viewMode,
      sortMode,
      selectedIds,
      activePhotoId,
      lastClickedId,
      editingPhotoId,
      lastDraftSavedAt,
      hasSavedDraft,
      hasUnsavedChanges,
      status,
      page,
      pageSize,
      smartSortResult,
      smartSortViewMode,
      activeSmartSortGroupId,
      smartSortMessage,
      recognitionResultsByPhoto,
      watermarkRecordsByPhoto,
      archiveSuggestionsByPhoto,
      recognitionMessage,
      rightPanelMode,
      batchPreparationUndo
    };
    sessionSnapshotRef.current = snapshot;
    sortWorkspaceSessionCache = snapshot;
  }, [
    photoFolder,
    archiveRoot,
    photos,
    form,
    filter,
    searchText,
    viewMode,
    sortMode,
    selectedIds,
    activePhotoId,
    lastClickedId,
    editingPhotoId,
    lastDraftSavedAt,
    hasSavedDraft,
    hasUnsavedChanges,
    status,
    page,
    pageSize,
    smartSortResult,
    smartSortViewMode,
    activeSmartSortGroupId,
    smartSortMessage,
    recognitionResultsByPhoto,
    watermarkRecordsByPhoto,
    archiveSuggestionsByPhoto,
    recognitionMessage,
    rightPanelMode,
    batchPreparationUndo,
    isSessionHydrated
  ]);

  useEffect(() => () => {
    if (sessionSnapshotRef.current) {
      sortWorkspaceSessionCache = sessionSnapshotRef.current;
    }
  }, []);

  useEffect(() => {
    const refreshPhotoFolder = () => synchronizePhotoFolderFromSettings();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshPhotoFolder();
    };
    window.addEventListener('focus', refreshPhotoFolder);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('focus', refreshPhotoFolder);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  const smartSortGroups = useMemo(() => Array.isArray(smartSortResult?.groups) ? smartSortResult.groups : [], [smartSortResult]);
  const activeSmartGroup = useMemo(
    () => smartSortGroups.find((group) => group.id === activeSmartSortGroupId) || null,
    [smartSortGroups, activeSmartSortGroupId]
  );
  const activeSmartSortGroupName = activeSmartGroup?.title || '';
  const activeSmartSortGroupPhotoIds = useMemo(() => getSmartSortGroupPhotoIds(activeSmartGroup), [activeSmartGroup]);
  const activeSmartSortGroupPhotoPaths = useMemo(() => getSmartSortGroupPhotoPaths(activeSmartGroup), [activeSmartGroup]);
  const activeSmartSortGroupPhotoCount = activeSmartGroup ? getSmartSortGroupPhotoCount(activeSmartGroup) : 0;
  const activeSmartGroupPhotoKeys = useMemo(() => {
    if (smartSortViewMode !== 'smartSortGroup' || !activeSmartGroup) return null;
    return new Set([...activeSmartSortGroupPhotoIds, ...activeSmartSortGroupPhotoPaths].filter(Boolean));
  }, [activeSmartGroup, activeSmartSortGroupPhotoIds, activeSmartSortGroupPhotoPaths, smartSortViewMode]);
  const currentPhotoKeySet = useMemo(() => new Set(photos.flatMap((photo) => [photo.id, photo.originalPath]).filter(Boolean)), [photos]);

  const visiblePhotos = useMemo(() => {
    return getVisiblePhotosSnapshot({ photos, activeSmartGroupPhotoKeys, filter, searchText, selectedIds, sortMode });
  }, [photos, activeSmartGroupPhotoKeys, filter, searchText, selectedIds, sortMode]);

  const totalPages = Math.max(1, Math.ceil(visiblePhotos.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pagePhotos = visiblePhotos.slice((safePage - 1) * pageSize, safePage * pageSize);
  const selectedPhotos = photos.filter((photo) => selectedIds.includes(photo.id));
  const activePhoto = pagePhotos.find((photo) => photo.id === activePhotoId) || null;
  const selectedPagePhoto = pagePhotos.find((photo) => selectedIds.includes(photo.id)) || null;
  const primaryPhoto = activePhoto || selectedPagePhoto || pagePhotos[0] || null;
  const assignedCount = photos.filter((photo) => photo.sortStatus === 'assigned').length;
  const previewPhotos = photos.filter((photo) => photo.sortStatus === 'previewed' && photo.previewInfo);
  const pendingCount = photos.filter((photo) => !['assigned', 'previewed', 'archived', 'ignored'].includes(photo.sortStatus)).length;
  const ignoredCount = photos.filter((photo) => photo.sortStatus === 'ignored').length;
  const missingOriginalCount = photos.filter((photo) => photo.originalMissing).length;
  const editingPhoto = photos.find((photo) => photo.id === editingPhotoId) || null;
  const effectivePhotoFolder = resolveEffectivePhotoFolder(settings, sessionPhotoFolderRef.current);
  const selectedStateText = getSelectedStateText(selectedPhotos);
  const selectedHasIgnored = selectedPhotos.some(isIgnoredPhoto);
  const selectedEditablePhotos = selectedPhotos.filter((photo) => !isArchivedPhoto(photo) && !isIgnoredPhoto(photo) && !photo.originalMissing);
  const selectedIgnorableCount = selectedPhotos.filter((photo) => !isArchivedPhoto(photo) && !isIgnoredPhoto(photo)).length;
  const selectedSmartResultCount = selectedEditablePhotos.filter((photo) => (
    recognitionResultsByPhoto[photo.id]
    || watermarkRecordsByPhoto[photo.id]
    || archiveSuggestionsByPhoto[photo.id]
  )).length;
  const smartSortActionLabel = selectedSmartResultCount > 0 ? '重新智拣' : '智拣';
  const smartSortActionTitle = selectedSmartResultCount > 0
    ? '重新识别已选照片，替换当前识别结果与归档建议，并重新生成智能分组。'
    : '对已选照片执行水印识别、解析并生成智能分组。';
  const selectedIgnoredCount = selectedPhotos.filter(isIgnoredPhoto).length;
  const selectedSuggestionReadyCount = selectedEditablePhotos.filter((photo) => {
    const suggestion = archiveSuggestionsByPhoto[photo.id];
    return suggestion?.suggestedFields && validateRequiredArchiveFields(suggestion.suggestedFields, configs).length === 0;
  }).length;
  const currentPanelPhoto = primaryPhoto;
  const currentPagePhotoIndex = currentPanelPhoto
    ? pagePhotos.findIndex((photo) => photo.id === currentPanelPhoto.id)
    : -1;
  const canShowPreviousPhoto = currentPagePhotoIndex > 0;
  const canShowNextPhoto = currentPagePhotoIndex >= 0 && currentPagePhotoIndex < pagePhotos.length - 1;
  const currentRecognitionPhoto = currentPanelPhoto;
  const isPreviewStatusView = smartSortViewMode === 'statusFilter' && filter === 'previewed';
  const effectiveViewMode = isPreviewStatusView ? 'list' : viewMode;
  const isPreviewAuditList = isPreviewStatusView;
  const currentRecognitionResult = currentRecognitionPhoto ? recognitionResultsByPhoto[currentRecognitionPhoto.id] : null;
  const currentWatermarkRecord = currentPanelPhoto ? watermarkRecordsByPhoto[currentPanelPhoto.id] : null;
  const currentArchiveSuggestion = currentPanelPhoto ? archiveSuggestionsByPhoto[currentPanelPhoto.id] : null;
  const currentRecognitionIssue = getRecognitionRecoveryIssue(currentRecognitionResult);
  const currentRecognitionManualPending = getRecognitionOutcome(currentRecognitionResult) === 'manual_pending';
  const currentRecognitionEmpty = getRecognitionOutcome(currentRecognitionResult) === 'empty';
  const recognitionSuggestion = useMemo(() => buildRecognitionSuggestionDisplayModel({
    archiveSuggestion: currentArchiveSuggestion,
    recognitionResult: currentRecognitionResult,
    watermarkRecord: currentWatermarkRecord
  }), [currentArchiveSuggestion, currentRecognitionResult, currentWatermarkRecord]);
  const hasCurrentPhoto = Boolean(currentPanelPhoto);
  const hasRecognitionEvidence = Boolean(currentRecognitionResult || currentWatermarkRecord);
  const hasArchiveSuggestion = Boolean(currentArchiveSuggestion);
  const hasConfirmedArchiveInfo = Boolean(currentPanelPhoto?.archiveInfo);
  const hasPreviewInfo = Boolean(currentPanelPhoto?.previewInfo);
  const hasArchiveResult = Boolean(currentPanelPhoto?.archiveResult);
  const hasExplicitWorkflowState = Boolean(currentPanelPhoto && (
    currentPanelPhoto.originalMissing
    || !pendingSortStatuses.has(currentPanelPhoto.sortStatus)
  ));
  const rightWorkbenchStage = !hasCurrentPhoto
    ? 'empty'
    : (hasRecognitionEvidence || hasArchiveSuggestion || hasConfirmedArchiveInfo || hasPreviewInfo || hasArchiveResult || hasExplicitWorkflowState)
      ? 'smart'
      : 'scanned';
  const currentMissingRequiredFields = validateRequiredArchiveFields(form, configs);
  const currentRequiredFieldsComplete = currentMissingRequiredFields.length === 0;
  const currentPhotoArchived = Boolean(
    currentPanelPhoto?.sortStatus === 'archived'
    || currentPanelPhoto?.archiveResult?.status === '归档成功'
    || currentPanelPhoto?.archiveResult?.success === true
  );
  const currentPhotoArchiveFailed = Boolean(
    currentPanelPhoto?.sortStatus === 'failed'
    || currentPanelPhoto?.sortStatus === 'archive_failed'
    || currentPanelPhoto?.archiveResult?.status === '归档失败'
    || currentPanelPhoto?.archiveResult?.success === false
  );
  const currentPhotoIgnored = isIgnoredPhoto(currentPanelPhoto);
  const currentPhotoPreviewed = currentPanelPhoto?.sortStatus === 'previewed';
  const currentPhotoAssigned = currentPanelPhoto?.sortStatus === 'assigned';
  const currentPhotoOriginalMissing = Boolean(currentPanelPhoto?.originalMissing);
  const currentFormLocked = currentPhotoOriginalMissing || currentPhotoArchived || currentPhotoIgnored || currentPhotoPreviewed;
  const currentPhotoStatusText = getPhotoWorkflowStatus(currentPanelPhoto, {
    recognitionResult: currentRecognitionResult,
    requiredFieldsComplete: currentRequiredFieldsComplete
  });
  const recognitionSummary = useMemo(() => summarizeRecognitionResults(recognitionResultsByPhoto), [recognitionResultsByPhoto]);
  const batchActionsBusy = isBusy || isRecognitionBusy || isSmartSortBusy;
  const smartSortProgressVisible = isRecognitionBusy || isSmartSortBusy;
  const smartSortProgressPercent = isSmartSortBusy
    ? 92
    : recognitionProgress.total > 0
      ? Math.round((recognitionProgress.current / recognitionProgress.total) * 85)
      : 0;
  const smartSortBottomText = buildSmartSortBottomText({
    result: smartSortResult,
    viewMode: smartSortViewMode,
    activeGroup: activeSmartGroup,
    activeGroupName: activeSmartSortGroupName,
    activeGroupPhotoCount: activeSmartSortGroupPhotoCount,
    filter,
    photos
  });
  const smartSortEngineText = buildSmartSortEngineText({
    recognitionSummary,
    result: currentRecognitionResult,
    serviceStatus: recognitionServiceStatus
  });
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  useEffect(() => {
    const pendingPhotoId = pendingMarkiFocusPhotoIdRef.current;
    if (!pendingPhotoId) return;
    const visibleIndex = visiblePhotos.findIndex((photo) => photo.id === pendingPhotoId);
    if (visibleIndex < 0) return;
    const targetPage = Math.floor(visibleIndex / pageSize) + 1;
    if (page !== targetPage) {
      setPage(targetPage);
      return;
    }
    if (activePhotoId !== pendingPhotoId) {
      setActivePhotoId(pendingPhotoId);
      return;
    }
    window.requestAnimationFrame(() => {
      const target = Array.from(photoBrowserRef.current?.querySelectorAll('[data-photo-id]') || [])
        .find((element) => element.dataset.photoId === pendingPhotoId);
      target?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    pendingMarkiFocusPhotoIdRef.current = '';
  }, [activePhotoId, page, pageSize, visiblePhotos]);

  useEffect(() => {
    if (activePhotoId && !photos.some((photo) => photo.id === activePhotoId)) {
      setActivePhotoId('');
    }
  }, [activePhotoId, photos]);

  useEffect(() => {
    if (pendingMarkiFocusPhotoIdRef.current) return;
    const currentPhotoId = currentPanelPhoto?.id || '';
    if (currentPhotoId !== activePhotoId) setActivePhotoId(currentPhotoId);
  }, [activePhotoId, currentPanelPhoto?.id]);

  useEffect(() => {
    if (!isSessionHydrated || navigationRequest?.action !== 'appendMarkiImportBatch') return undefined;
    const batchId = typeof navigationRequest?.payload?.batchId === 'string'
      ? navigationRequest.payload.batchId.trim()
      : '';
    const nonce = navigationRequest?.nonce;
    if (!batchId || nonce === undefined || nonce === null || nonce === '') return undefined;
    const nonceKey = `${typeof nonce}:${String(nonce)}`;
    if (processedMarkiImportRequestNoncesRef.current.has(nonceKey)) return undefined;
    processedMarkiImportRequestNoncesRef.current.add(nonceKey);

    void (async () => {
      const markiApi = window.archiveAssistant?.marki;
      if (typeof markiApi?.getImportBatch !== 'function' || typeof markiApi?.consumeImportBatch !== 'function') {
        if (isSortWorkspaceMountedRef.current) {
          setStatus({ type: 'error', text: '马克导入批次服务暂不可用，请重新打开软件后再试。' });
        }
        return;
      }

      let batchResult;
      try {
        batchResult = await markiApi.getImportBatch(batchId);
      } catch {
        if (isSortWorkspaceMountedRef.current) {
          setStatus({ type: 'error', text: '读取马克导入批次失败，请重试。' });
        }
        return;
      }
      if (!isSortWorkspaceMountedRef.current) return;
      if (batchResult?.success === false) {
        setStatus({ type: 'error', text: getSafeMarkiImportMessage(batchResult, '读取马克导入批次失败，请重试。') });
        return;
      }
      if (batchResult?.status === 'preparing') {
        setStatus({ type: 'idle', text: '导入批次仍在准备，请稍后重新发起导入。' });
        return;
      }
      if (batchResult?.status === 'failed') {
        setStatus({ type: 'warning', text: `马克导入批次处理失败 ${Number(batchResult.failedCount) || 0} 项，可重新发起导入。` });
        return;
      }
      if (batchResult?.status === 'consumed') {
        setStatus({ type: 'warning', text: '该马克导入批次已经处理。' });
        return;
      }
      if (batchResult?.status !== 'ready' || !batchResult.workbenchImportPackage) {
        setStatus({ type: 'error', text: '马克导入批次状态无效，请重新发起导入。' });
        return;
      }

      let merged;
      try {
        merged = mergeMarkiWorkbenchImportPackage(
          markiWorkbenchStateRef.current,
          batchResult.workbenchImportPackage
        );
      } catch {
        setStatus({ type: 'error', text: '马克工作台导入包校验失败，未修改当前工作台。' });
        return;
      }
      if (!isSortWorkspaceMountedRef.current) return;

      if (merged.stats.addedCount > 0) {
        markiWorkbenchStateRef.current = merged;
        pendingMarkiFocusPhotoIdRef.current = merged.addedPhotoIds[0];
        setPhotos(merged.photos);
        setRecognitionResultsByPhoto(merged.recognitionResultsByPhoto);
        setWatermarkRecordsByPhoto(merged.watermarkRecordsByPhoto);
        setArchiveSuggestionsByPhoto(merged.archiveSuggestionsByPhoto);
        setSelectedIds(merged.selectedIds);
        setActivePhotoId(merged.activePhotoId);
        setFilter('all');
        setSearchText('');
        setSmartSortViewMode('statusFilter');
        setActiveSmartSortGroupId('');
        setHasUnsavedChanges(true);
      }

      let consumeResult;
      try {
        consumeResult = await markiApi.consumeImportBatch(batchId);
      } catch {
        consumeResult = { success: false };
      }
      if (!isSortWorkspaceMountedRef.current) return;
      if (consumeResult?.success !== true) {
        setStatus({
          type: 'warning',
          text: '照片已追加，但批次消费状态未更新；再次处理时会按 sourceKey 自动去重。'
        });
        return;
      }

      const { addedCount, duplicateCount, conflictCount } = merged.stats;
      if (addedCount === 0 && duplicateCount > 0 && conflictCount === 0) {
        setStatus({ type: 'success', text: '本批照片均已存在，未重复追加。' });
        return;
      }
      setStatus({
        type: conflictCount > 0 ? 'warning' : 'success',
        text: `已追加 ${addedCount} 张马克照片；跳过 ${duplicateCount} 张重复照片、${conflictCount} 张冲突照片。`
      });
    })();

    return undefined;
  }, [isSessionHydrated, navigationRequest]);

  useEffect(() => {
    if (photos.length === 0 && smartSortResult) {
      resetSmartSortState({ type: 'idle', text: '' });
    }
    if (
      photos.length === 0
      && (
        Object.keys(recognitionResultsByPhoto).length > 0
        || Object.keys(watermarkRecordsByPhoto).length > 0
        || Object.keys(archiveSuggestionsByPhoto).length > 0
      )
    ) {
      setRecognitionResultsByPhoto({});
      setWatermarkRecordsByPhoto({});
      setArchiveSuggestionsByPhoto({});
      setRecognitionMessage({ type: 'idle', text: '' });
    }
  }, [photos.length, smartSortResult, recognitionResultsByPhoto, watermarkRecordsByPhoto, archiveSuggestionsByPhoto]);

  useEffect(() => {
    setPhotos((current) => {
      let changed = false;
      const next = current.map((photo) => {
        if (isArchivedPhoto(photo) || isIgnoredPhoto(photo) || photo.archiveInfo) return photo;
        const outcome = getRecognitionOutcome(recognitionResultsByPhoto[photo.id]);
        const expectedStatus = outcome === 'failed'
          ? 'recognition_failed'
          : outcome === 'empty'
            ? 'needs_completion'
            : '';
        if (!expectedStatus || photo.sortStatus === expectedStatus) return photo;
        changed = true;
        return { ...photo, sortStatus: expectedStatus };
      });
      return changed ? next : current;
    });
  }, [recognitionResultsByPhoto]);

  useEffect(() => {
    if (!smartSortGroups.length) return;
    const hasInvalidGroupPhoto = smartSortGroups.some((group) => getSmartSortGroupKeys(group).some((key) => !currentPhotoKeySet.has(key)));
    const groupedPhotoCount = smartSortGroups.reduce((sum, group) => sum + getSmartSortGroupPhotoCount(group), 0);
    const expectedPhotoCount = Number(smartSortResult?.photoCount) || groupedPhotoCount || photos.length;
    const countMismatch = expectedPhotoCount > 0 && groupedPhotoCount > 0 && groupedPhotoCount !== expectedPhotoCount;
    if (photos.length === 0 || hasInvalidGroupPhoto || countMismatch) {
      resetSmartSortState({ type: 'idle', text: '当前照片列表已变化，请重新执行智能分拣。' });
    }
  }, [currentPhotoKeySet, photos.length, smartSortGroups, smartSortResult?.photoCount]);

  useEffect(() => {
    if (activeSmartSortGroupId && !activeSmartGroup) {
      setSmartSortViewMode('statusFilter');
      setActiveSmartSortGroupId('');
    }
  }, [activeSmartGroup, activeSmartSortGroupId]);

  useEffect(() => {
    if (rightPanelMode === 'recognition' && !currentRecognitionResult && !isRecognitionBusy) {
      setRightPanelMode('form');
    }
  }, [currentRecognitionResult, isRecognitionBusy, rightPanelMode]);

  useEffect(() => {
    if (!configs) return;
    if (!currentPanelPhoto) {
      setForm(reconcileForm(defaultForm, configs));
      setRightPanelMode('form');
      return;
    }
    const suggestion = archiveSuggestionsByPhoto[currentPanelPhoto.id];
    if (suggestion?.suggestedFields) {
      setForm(sanitizeDraftFields(suggestion.suggestedFields, configs));
      return;
    }
    if (currentPanelPhoto.archiveInfo) {
      setForm(sanitizeDraftFields(toArchiveForm(currentPanelPhoto.archiveInfo), configs));
      return;
    }
    setForm(reconcileForm(defaultForm, configs));
  }, [currentPanelPhoto, configs, archiveSuggestionsByPhoto]);

  useEffect(() => {
    rightPanelRef.current?.scrollTo({ top: 0 });
  }, []);

  function markChanged() {
    setHasUnsavedChanges(true);
  }

  // Only source-state mutations invalidate the one-step batch undo snapshot.
  function invalidateBatchPreparationUndo() {
    setBatchPreparationUndo(null);
  }

  async function synchronizePhotoFolderFromSettings() {
    try {
      const loadedSettings = await window.archiveAssistant.loadSettings();
      setSettings(loadedSettings);
      const resolvedPhotoFolder = resolveEffectivePhotoFolder(loadedSettings, sessionPhotoFolderRef.current);
      setPhotoFolder(resolvedPhotoFolder);
      return resolvedPhotoFolder;
    } catch {
      // Keep the current directory when settings cannot be refreshed.
      return resolveEffectivePhotoFolder(settings, sessionPhotoFolderRef.current);
    }
  }

  function rememberSessionPhotoFolder(folderPath) {
    const normalizedFolder = String(folderPath || '').trim();
    sessionPhotoFolderRef.current = normalizedFolder;
    if (normalizedFolder) window.sessionStorage.setItem(sortSessionPhotoFolderKey, normalizedFolder);
    else window.sessionStorage.removeItem(sortSessionPhotoFolderKey);
    setPhotoFolder(normalizedFolder);
  }

  function clearSessionPhotoFolder() {
    sessionPhotoFolderRef.current = '';
    window.sessionStorage.removeItem(sortSessionPhotoFolderKey);
    setPhotoFolder('');
  }

  function invalidatePreviewMessage() {
    return previewPhotos.length > 0 ? '分拣信息已变化，请重新生成归档预览。' : '';
  }

  function resetSmartSortState(nextMessage = null) {
    setSmartSortResult(null);
    setSmartSortViewMode('statusFilter');
    setActiveSmartSortGroupId('');
    if (nextMessage) setSmartSortMessage(nextMessage);
  }

  function resetPhotoPreview(photo, nextStatus = photo.sortStatus) {
    return {
      ...photo,
      sortStatus: nextStatus,
      previewInfo: null,
      archiveResult: null
    };
  }

  function clearGeneratedPreview(photo) {
    return photo.sortStatus === 'previewed' ? resetPhotoPreview(photo, 'assigned') : photo;
  }

  function switchStatusFilter(nextFilter) {
    setFilter(nextFilter);
  }

  function changePhotoViewMode(nextViewMode) {
    setViewMode(nextViewMode);
  }

  function rememberBatchPreparationUndo(actionLabel, affectedPhotoIds = []) {
    const normalizedPhotoIds = Array.from(new Set(affectedPhotoIds.filter(Boolean)));
    setBatchPreparationUndo({
      actionLabel,
      count: normalizedPhotoIds.length,
      affectedPhotoIds: normalizedPhotoIds,
      recognitionStageRestores: buildRecognitionStageRestores(normalizedPhotoIds, recognitionResultsByPhoto),
      photos,
      form,
      archiveSuggestionsByPhoto,
      recognitionResultsByPhoto,
      selectedIds: [...selectedIds],
      activePhotoId,
      filter,
      searchText,
      page,
      smartSortViewMode,
      activeSmartSortGroupId
    });
  }

  async function undoLastBatchPreparation() {
    if (!batchPreparationUndo) {
      setStatus({ type: 'warning', text: '当前没有可撤销的整理操作。' });
      return;
    }
    const snapshot = batchPreparationUndo;
    const affectedPhotoIds = snapshot.affectedPhotoIds?.length
      ? snapshot.affectedPhotoIds
      : inferUndoAffectedPhotoIds(snapshot.photos, photos);
    if (affectedPhotoIds.length === 0) {
      invalidateBatchPreparationUndo();
      setStatus({ type: 'warning', text: '撤销记录已失效，当前照片状态无需恢复。' });
      return;
    }
    const stageRestores = snapshot.recognitionStageRestores?.length
      ? snapshot.recognitionStageRestores
      : buildRecognitionStageRestores(affectedPhotoIds, snapshot.recognitionResultsByPhoto || {});
    setIsRecognitionBusy(true);
    try {
      const stageResults = await Promise.all(stageRestores.map(async (entry) => {
        try {
          const updated = await updateStagedResultStatus(entry.stagedResultId, entry.stageStatus);
          return { photoId: entry.photoId, success: Boolean(updated) };
        } catch {
          return { photoId: entry.photoId, success: false };
        }
      }));
      const failedPhotoIds = stageResults.filter((item) => !item.success).map((item) => item.photoId);
      const failedIdSet = new Set(failedPhotoIds);
      const restoredPhotoIds = affectedPhotoIds.filter((photoId) => !failedIdSet.has(photoId));
      if (restoredPhotoIds.length === 0) {
        setStatus({ type: 'error', text: '后台 OCR 记录未能恢复，套用结果尚未撤销，请稍后重试。' });
        return;
      }

      if (failedPhotoIds.length === 0) {
        setPhotos(snapshot.photos);
        setForm(snapshot.form);
        setArchiveSuggestionsByPhoto(snapshot.archiveSuggestionsByPhoto);
        setRecognitionResultsByPhoto(snapshot.recognitionResultsByPhoto || {});
        setSelectedIds(snapshot.selectedIds);
        setActivePhotoId(snapshot.activePhotoId);
        setFilter(snapshot.filter);
        setSmartSortViewMode(snapshot.smartSortViewMode);
        setActiveSmartSortGroupId(snapshot.activeSmartSortGroupId);
        invalidateBatchPreparationUndo();
        markChanged();
        setStatus({ type: 'success', text: `已撤销“${snapshot.actionLabel}”，恢复 ${restoredPhotoIds.length} 张照片整理前的状态。` });
        return;
      }

      const restoredIdSet = new Set(restoredPhotoIds);
      const snapshotPhotoMap = new Map((snapshot.photos || []).map((photo) => [photo.id, photo]));
      setPhotos((current) => current.map((photo) => restoredIdSet.has(photo.id) ? (snapshotPhotoMap.get(photo.id) || photo) : photo));
      setArchiveSuggestionsByPhoto((current) => restoreSnapshotEntries(current, snapshot.archiveSuggestionsByPhoto || {}, restoredIdSet));
      setRecognitionResultsByPhoto((current) => restoreSnapshotEntries(current, snapshot.recognitionResultsByPhoto || {}, restoredIdSet));
      setBatchPreparationUndo({
        ...snapshot,
        count: failedPhotoIds.length,
        affectedPhotoIds: failedPhotoIds,
        recognitionStageRestores: stageRestores.filter((entry) => failedIdSet.has(entry.photoId))
      });
      markChanged();
      setStatus({ type: 'warning', text: `已撤销 ${restoredPhotoIds.length} 张照片；另有 ${failedPhotoIds.length} 张因后台记录恢复失败仍保留套用结果，可稍后重试。` });
    } catch (error) {
      setStatus({ type: 'error', text: `撤销失败：${error.message || '后台 OCR 状态恢复失败'}` });
    } finally {
      setIsRecognitionBusy(false);
    }
  }

  function isArchivedPhoto(photo) {
    return hasArchivedPhotoState(photo);
  }

  function isIgnoredPhoto(photo) {
    return photo?.sortStatus === 'ignored';
  }

  function blockIgnoredSelectionAction() {
    if (!selectedPhotos.some(isIgnoredPhoto)) return false;
    setStatus({ type: 'warning', text: '当前选择包含已忽略照片，请先还原后再处理。' });
    return true;
  }

  function getEditableSelectedPhotos() {
    return selectedPhotos.filter((photo) => !isArchivedPhoto(photo) && !isIgnoredPhoto(photo) && !photo.originalMissing);
  }

  function updateForm(patch, options = {}) {
    invalidateBatchPreparationUndo();
    setForm((current) => {
      const next = { ...current, ...patch };
      if (patch.watermarkCategory) {
        const items = configs?.watermarkCategories?.[patch.watermarkCategory]?.items || [];
        if (!items.includes(next.workContent)) next.workContent = '';
      }
      if (!options.preserveKeywords && (patch.watermarkCategory || patch.workContent || patch.location)) {
        next.keywords = getSuggestedKeywords(toArchiveForm(next), configs);
      }
      if (currentPanelPhoto) {
        const sanitized = sanitizeDraftFields(next, configs);
        setArchiveSuggestionsByPhoto((currentSuggestions) => {
          const nextSuggestion = updateArchiveSuggestion(currentSuggestions[currentPanelPhoto.id], sanitized, {
            configs,
            photoId: currentPanelPhoto.id
          });
          return { ...currentSuggestions, [currentPanelPhoto.id]: nextSuggestion };
        });
      }
      return next;
    });
  }

  async function selectPhotoFolder({ scanAfterSelect = false } = {}) {
    const selected = await window.archiveAssistant.selectPhotoFolder();
    if (!selected) return false;
    if (scanAfterSelect && photos.length > 0 && !window.confirm('更换照片目录并扫描会覆盖当前列表和分拣状态，但不会删除、移动或修改原图。确定继续吗？')) {
      return false;
    }
    rememberSessionPhotoFolder(selected);
    const nextSettings = await window.archiveAssistant.updateLastPhotoFolder(selected);
    setSettings(nextSettings);
    if (scanAfterSelect) {
      await scanPhotos(true, selected);
    } else {
      setStatus({ type: 'idle', text: '照片来源目录已选择，请点击扫描。' });
    }
    return true;
  }

  async function selectArchiveRoot() {
    const selected = await window.archiveAssistant.selectArchiveRoot();
    if (!selected) return;
    const hadPreview = previewPhotos.length > 0;
    setArchiveRoot(selected);
    const nextSettings = await window.archiveAssistant.updateLastArchiveRoot(selected);
    setSettings(nextSettings);
    archiveState?.setCurrentArchiveRoot?.(selected, nextSettings);
    if (hadPreview) {
      setPhotos((current) => current.map(clearGeneratedPreview));
    }
    markChanged();
    setStatus({ type: hadPreview ? 'warning' : 'success', text: hadPreview ? '归档根目录已变更，分拣信息已变化，请重新生成归档预览。' : '归档根目录已选择，分拣预览和台账将写入该目录。' });
  }

  async function scanPhotos(force = false, folder = photoFolder) {
    if (!folder) {
      setStatus({ type: 'error', text: '请先选择照片文件夹。' });
      return;
    }
    if (!force && photos.length > 0 && !window.confirm('重新扫描会覆盖当前列表和分拣状态，但不会删除、移动或修改原图。确定继续吗？')) {
      return;
    }
    setIsBusy(true);
    try {
      const scanned = await window.archiveAssistant.scanImages(folder);
      let archivedMatches = {};
      let archiveMatchWarning = '';
      if (archiveRoot) {
        try {
          if (typeof window.archiveAssistant.matchArchivedPhotos !== 'function') {
            throw new Error('当前程序尚未加载照片指纹核对服务，请重启软件');
          }
          const matchResult = await window.archiveAssistant.matchArchivedPhotos(archiveRoot, scanned);
          archivedMatches = matchResult?.matches || {};
        } catch (error) {
          archiveMatchWarning = error.message || '照片指纹核对失败';
          void recordRuntimeLog({
            page: '照片分拣工作台',
            operation: '扫描时核对照片指纹',
            errorType: '归档状态核对',
            summary: archiveMatchWarning,
            error
          });
        }
      }
      const reconciledPhotos = reconcileScannedPhotoStatuses(scanned, photos, archivedMatches);
      const archivedCount = reconciledPhotos.filter(hasArchivedPhotoState).length;
      invalidateBatchPreparationUndo();
      resetSmartSortState({ type: 'idle', text: '' });
      setRecognitionResultsByPhoto({});
      setWatermarkRecordsByPhoto({});
      setArchiveSuggestionsByPhoto({});
      setRecognitionMessage({ type: 'idle', text: '' });
      void clearSmartSortGroups();
      setPhotos(reconciledPhotos);
      setSelectedIds([]);
      setActivePhotoId(reconciledPhotos[0]?.id || '');
      setPage(1);
      switchStatusFilter('all');
      setSmartSortViewMode('statusFilter');
      setActiveSmartSortGroupId('');
      setEditingPhotoId('');
      markChanged();
      setStatus({
        type: archiveMatchWarning ? 'warning' : 'success',
        text: archiveMatchWarning
          ? `扫描完成，共找到 ${scanned.length} 张照片；内容指纹核对失败，“未归档”状态可能不完整。`
          : `扫描完成，共找到 ${scanned.length} 张照片，其中 ${archivedCount} 张已有归档记录。`
      });
    } catch (error) {
      recordRuntimeLog({ page: '照片分拣工作台', operation: '扫描照片', errorType: '扫描照片失败', summary: error.message, error });
      setStatus({ type: 'error', text: `扫描失败：${error.message}` });
    } finally {
      setIsBusy(false);
    }
  }

  async function importOrScanPhotos() {
    if (effectivePhotoFolder) {
      await scanPhotos(false, effectivePhotoFolder);
      return;
    }
    await selectPhotoFolder({ scanAfterSelect: true });
  }

  function clearList() {
    if (photos.length === 0) return;
    if (!window.confirm('仅清空当前分拣列表和分拣状态，不会删除原始照片。确定清空吗？')) return;
    sortWorkspaceSessionCache = null;
    sessionSnapshotRef.current = null;
    setPhotos([]);
    setSelectedIds([]);
    setActivePhotoId('');
    setRecognitionResultsByPhoto({});
    setWatermarkRecordsByPhoto({});
    setArchiveSuggestionsByPhoto({});
    setRecognitionMessage({ type: 'idle', text: '' });
    setPage(1);
    resetSmartSortState({ type: 'idle', text: '' });
    void clearSmartSortGroups();
    setEditingPhotoId('');
    clearSessionPhotoFolder();
    invalidateBatchPreparationUndo();
    markChanged();
    void synchronizePhotoFolderFromSettings();
    setStatus({ type: 'success', text: '已清空当前分拣列表，原始照片未受影响。' });
  }

  async function generateSmartGroups(
    targetPhotos = photos,
    recognitionMap = recognitionResultsByPhoto,
    options = {},
    suggestionMap = archiveSuggestionsByPhoto,
    watermarkMap = watermarkRecordsByPhoto
  ) {
    if (isBusy || isSmartSortBusy) {
      setSmartSortMessage({ type: 'warning', text: '照片扫描或智能分拣正在进行，请稍候。' });
      return;
    }
    if (targetPhotos.length === 0) {
      setSmartSortMessage({ type: 'warning', text: '请先选择目录并扫描照片。' });
      return;
    }
    setIsSmartSortBusy(true);
    setSmartSortMessage({ type: 'idle', text: '正在整理智能分拣分组...' });
    try {
      const result = await generateSmartSortGroups(normalizePhotosForSmartSort(targetPhotos, recognitionMap, suggestionMap, watermarkMap), {
        timeWindowMinutes: 30,
        maxPhotosPerGroup: 10,
        source: options.source || 'selected_photos'
      });
      setSmartSortResult(result);
      setSmartSortViewMode('statusFilter');
      setActiveSmartSortGroupId('');
      if (result.status === 'failed') {
        setSmartSortMessage({ type: 'error', text: result.errors?.[0]?.message || '分拣组生成失败，手动归档流程不受影响。' });
      } else if (result.groupCount > 0) {
        const groupedPhotoCount = Number(result.photoCount) || targetPhotos.length;
        setSmartSortMessage({ type: 'success', text: `智拣完成：已处理 ${groupedPhotoCount} 张照片，生成 ${result.groupCount} 个分组。` });
      } else {
        setSmartSortMessage({ type: 'warning', text: '当前照片缺少足够识别信息，暂未形成有效分组，您仍可手动选择照片进行归档。' });
      }
    } catch (error) {
      setSmartSortMessage({ type: 'error', text: `分拣组生成失败：${error.message}` });
    } finally {
      setIsSmartSortBusy(false);
    }
  }

  async function recognizeSelected({ alsoSort = false, photoIds = null, confirmRerun = true } = {}) {
    if (isBusy || isSmartSortBusy || isRecognitionBusy) {
      setRecognitionMessage({ type: 'warning', text: '照片扫描、识别或智能分拣正在进行，请稍候。' });
      return;
    }
    const selectedPhotoIdsSnapshot = Array.isArray(photoIds) ? [...photoIds] : [...selectedIds];
    const selectedSnapshotSet = new Set(selectedPhotoIdsSnapshot);
    const targets = photos.filter((photo) => (
      selectedSnapshotSet.has(photo.id)
      && !isIgnoredPhoto(photo)
      && !isArchivedPhoto(photo)
      && !photo.originalMissing
    ));
    if (targets.length === 0) {
      setRecognitionMessage({ type: 'warning', text: '请先选择需要处理的照片。' });
      return;
    }
    const rerunCount = targets.filter((photo) => recognitionResultsByPhoto[photo.id]).length;
    if (alsoSort && confirmRerun && rerunCount > 0 && !window.confirm(`已选照片中有 ${rerunCount} 张已有智拣结果。\n\n重新智拣将替换这些照片的识别结果和归档建议，并重新生成分组。是否继续？`)) return;
    const latestServiceStatus = await getRecognitionStatus();
    setRecognitionServiceStatus(latestServiceStatus);
    if (!latestServiceStatus?.available) {
      const reason = latestServiceStatus?.reason || '未检测到可用 OCR 引擎。';
      setRecognitionMessage({ type: 'error', text: reason });
      setSmartSortMessage({ type: 'error', text: `OCR 引擎不可用：${reason}` });
      void recordRuntimeLog({
        page: '照片分拣工作台',
        operation: 'OCR 引擎检测',
        errorType: 'OCR 识别',
        summary: reason,
        level: 'error'
      });
      return;
    }
    const previousStagedIdByPhotoId = new Map(targets.map((photo) => [
      photo.id,
      recognitionResultsByPhoto[photo.id]?.stagedResultId || ''
    ]));
    let supersedeSyncFailedCount = 0;
    invalidateBatchPreparationUndo();
    setIsRecognitionBusy(true);
    setRecognitionProgress({ current: 0, total: targets.length });
    setRecognitionMessage({ type: 'idle', text: `正在识别 0 / ${targets.length}` });
    try {
      const results = [];
      for (let index = 0; index < targets.length; index += 1) {
        setRecognitionProgress({ current: index + 1, total: targets.length });
        setRecognitionMessage({ type: 'idle', text: `正在识别 ${index + 1} / ${targets.length}` });
        const result = await recognizePhoto(toRecognitionPhoto(targets[index]), { allowCloudUpload: false });
        results.push(result);
        const previousStagedId = previousStagedIdByPhotoId.get(targets[index].id);
        if (previousStagedId && result?.stagedResultId && previousStagedId !== result.stagedResultId) {
          const updatedPreviousRecord = await updateStagedResultStatus(previousStagedId, 'superseded');
          if (!updatedPreviousRecord) supersedeSyncFailedCount += 1;
        }
      }
      const resultEntries = Object.fromEntries(results.map((result, index) => [targets[index].id, result]));
      const nextMap = {
        ...recognitionResultsByPhoto,
        ...resultEntries
      };
      setRecognitionResultsByPhoto(nextMap);
      const watermarkEntries = Object.fromEntries(results.map((result, index) => {
        const photo = targets[index];
        return [photo.id, parseWatermarkRecord({ ...result, photoId: photo.id })];
      }));
      const suggestionEntries = Object.fromEntries(results.map((result, index) => {
        const photo = targets[index];
        const watermarkRecord = watermarkEntries[photo.id];
        return [photo.id, buildArchiveSuggestion(watermarkRecord, buildArchiveSuggestionContext({ configs, form, photoFolder, archiveRoot, photo }))];
      }));
      setWatermarkRecordsByPhoto((current) => ({ ...current, ...watermarkEntries }));
      setArchiveSuggestionsByPhoto((current) => ({ ...current, ...suggestionEntries }));
      setPhotos((current) => current.map((photo) => {
        const suggestion = suggestionEntries[photo.id];
        if (!suggestion || isIgnoredPhoto(photo) || isArchivedPhoto(photo)) return photo;
        return {
          ...photo,
          sortStatus: getPhotoRecognitionSortStatus(resultEntries[photo.id], suggestion),
          previewInfo: null,
          archiveResult: null
        };
      }));
      const panelPhotoId = currentPanelPhoto?.id || targets[0]?.id;
      if (panelPhotoId && suggestionEntries[panelPhotoId]) {
        setForm(sanitizeDraftFields(suggestionEntries[panelPhotoId].suggestedFields, configs));
      }
      const batchSummary = summarizeRecognitionBatch(results);
      const recognitionNeedsAttention = batchSummary.empty > 0 || batchSummary.failed > 0 || supersedeSyncFailedCount > 0;
      setRecognitionMessage({
        type: recognitionNeedsAttention ? 'warning' : 'success',
        text: `识别完成：成功 ${batchSummary.success} 张，未检测到水印文字 ${batchSummary.empty} 张（已转待补充），失败 ${batchSummary.failed} 张${batchSummary.pending ? `，待确认 ${batchSummary.pending} 张` : ''}。${supersedeSyncFailedCount ? `另有 ${supersedeSyncFailedCount} 条旧记录未能标记为已替代，请在数据中心核对。` : ''}`
      });
      setRightPanelMode('form');
      if (!currentPanelPhoto?.id || !selectedSnapshotSet.has(currentPanelPhoto.id)) {
        setActivePhotoId(targets[0]?.id || '');
      }
      if (alsoSort) {
        const hasExecutedOcr = results.some(hasLocalOcrExecuted);
        if (!hasExecutedOcr && batchSummary.success === 0 && batchSummary.empty === 0) {
          setSmartSortMessage({ type: 'error', text: '未检测到可用 OCR 引擎，无法执行智能识别分拣。' });
          return;
        }
        await generateSmartGroups(targets, nextMap, { source: 'selected_photos' }, suggestionEntries, watermarkEntries);
      } else if (smartSortResult) {
        await clearSmartSortGroups();
        resetSmartSortState({ type: 'warning', text: '识别结果已更新，原智能分组已失效；可重新智拣生成分组。' });
      }
    } catch (error) {
      setRecognitionMessage({ type: 'error', text: `识别失败：${error.message || '未知错误'}` });
      void recordRuntimeLog({ page: '照片分拣工作台', operation: 'OCR 识别', errorType: 'OCR 识别', summary: error.message || '未知错误', error });
    } finally {
      setIsRecognitionBusy(false);
      setRecognitionProgress({ current: 0, total: 0 });
    }
  }

  async function clearSelectedRecognitionResults() {
    const targetPhotos = selectedPhotos.filter((photo) => !isArchivedPhoto(photo) && !isIgnoredPhoto(photo));
    if (targetPhotos.length === 0) {
      setRecognitionMessage({ type: 'warning', text: '请先选择需要清空识别结果的照片。' });
      return;
    }
    if (!window.confirm('清除已选照片的 OCR 结果、识别建议并恢复为初始未归档状态？\n\n智能分组会同时失效，但不会删除、移动或修改原始照片。')) return;
    const selectedSet = new Set(targetPhotos.map((photo) => photo.id));
    setRecognitionResultsByPhoto((current) => Object.fromEntries(Object.entries(current).filter(([photoId]) => !selectedSet.has(photoId))));
    setWatermarkRecordsByPhoto((current) => Object.fromEntries(Object.entries(current).filter(([photoId]) => !selectedSet.has(photoId))));
    setArchiveSuggestionsByPhoto((current) => Object.fromEntries(Object.entries(current).filter(([photoId]) => !selectedSet.has(photoId))));
    setPhotos((current) => current.map((photo) => {
      if (!selectedSet.has(photo.id) || isArchivedPhoto(photo) || isIgnoredPhoto(photo)) return photo;
      return {
        ...photo,
        sortStatus: 'unassigned',
        archiveInfo: null,
        previewInfo: null,
        archiveResult: null
      };
    }));
    if (currentPanelPhoto?.id && selectedSet.has(currentPanelPhoto.id)) {
      setForm(reconcileForm(defaultForm, configs));
    }
    await Promise.allSettled(targetPhotos.map(clearRecognitionPipelineForPhoto));
    await clearSmartSortGroups();
    resetSmartSortState({ type: 'idle', text: '识别结果已清除，已选照片已恢复为初始未归档状态；请重新“智拣”后生成分组。' });
    const firstAllPhoto = getVisiblePhotosSnapshot({
      photos,
      activeSmartGroupPhotoKeys: null,
      filter: 'all',
      searchText: '',
      selectedIds: [],
      sortMode
    })[0];
    switchStatusFilter('all');
    setSearchText('');
    setSelectedIds([]);
    setActivePhotoId(firstAllPhoto?.id || '');
    setPage(1);
    window.requestAnimationFrame(() => photoBrowserRef.current?.scrollTo({ top: 0, left: 0 }));
    setRecognitionMessage({ type: 'success', text: `已清除 ${targetPhotos.length} 张照片的 OCR 结果、识别建议和后台暂存记录。` });
    setStatus({ type: 'success', text: '已选照片已恢复为初始未归档状态，并返回全部照片；原始照片和台账未受影响。' });
    setRightPanelMode('form');
    invalidateBatchPreparationUndo();
    markChanged();
  }

  async function syncRecognitionStageStatuses(photoIds = [], stageStatus = 'reviewed', outcomes = ['empty', 'failed', 'manual_pending']) {
    const outcomeSet = new Set(outcomes);
    const entries = photoIds
      .map((photoId) => ({ photoId, result: recognitionResultsByPhoto[photoId] }))
      .filter(({ result }) => result && outcomeSet.has(getRecognitionOutcome(result)));
    const syncResults = await Promise.all(entries.map(async ({ photoId, result }) => {
      if (!result.stagedResultId) return { photoId, success: true };
      const updated = await updateStagedResultStatus(result.stagedResultId, stageStatus);
      return { photoId, success: Boolean(updated) };
    }));
    return {
      syncedPhotoIds: syncResults.filter((item) => item.success).map((item) => item.photoId),
      failedPhotoIds: syncResults.filter((item) => !item.success).map((item) => item.photoId)
    };
  }

  async function resolveRecognitionIssues(photoIds = [], resolution = 'manual', stageStatus = 'reviewed') {
    const syncResult = await syncRecognitionStageStatuses(photoIds, stageStatus);
    const resolvedIds = new Set(syncResult.syncedPhotoIds);
    const resolvedAt = new Date().toISOString();
    if (resolvedIds.size > 0) {
      setRecognitionResultsByPhoto((current) => Object.fromEntries(Object.entries(current).map(([photoId, result]) => {
        if (!resolvedIds.has(photoId) || !['empty', 'failed', 'manual_pending'].includes(getRecognitionOutcome(result))) {
          return [photoId, result];
        }
        return [photoId, {
          ...result,
          resolution,
          resolvedAt,
          manualPendingAt: resolution === 'manual' ? '' : result.manualPendingAt,
          handlingMode: resolution === 'manual' ? '' : result.handlingMode
        }];
      })));
    }
    return {
      resolvedPhotoIds: syncResult.syncedPhotoIds,
      failedPhotoIds: syncResult.failedPhotoIds
    };
  }

  function retryCurrentRecognition() {
    if (!currentPanelPhoto || isArchivedPhoto(currentPanelPhoto) || isIgnoredPhoto(currentPanelPhoto)) {
      setRecognitionMessage({ type: 'warning', text: '当前照片不能重新识别。' });
      return;
    }
    void recognizeSelected({ photoIds: [currentPanelPhoto.id], confirmRerun: false });
  }

  async function continueCurrentPhotoManually() {
    if (!currentPanelPhoto || isArchivedPhoto(currentPanelPhoto) || isIgnoredPhoto(currentPanelPhoto)) {
      setStatus({ type: 'warning', text: '当前照片不能转为手工整理。' });
      return;
    }
    const photoId = currentPanelPhoto.id;
    setIsRecognitionBusy(true);
    try {
      const stageSync = await syncRecognitionStageStatuses([photoId], 'pending_review', ['failed']);
      const manualPendingAt = new Date().toISOString();
      setRecognitionResultsByPhoto((current) => ({
        ...current,
        [photoId]: current[photoId]
          ? { ...current[photoId], handlingMode: 'manual', manualPendingAt }
          : current[photoId]
      }));
      setSelectedIds((current) => current.includes(photoId) ? current : [...current, photoId]);
      setPhotos((current) => current.map((photo) => photo.id === photoId
        ? { ...photo, sortStatus: 'needs_completion', previewInfo: null, archiveResult: null }
        : photo));
      setRightPanelMode('form');
      invalidateBatchPreparationUndo();
      markChanged();
      const stageSyncFailed = stageSync.failedPhotoIds.length > 0;
      setRecognitionMessage({ type: 'warning', text: stageSyncFailed ? '已转为手工整理，但后台记录未能更新为待复核，请稍后重试或查看记录。' : '当前照片未采用 OCR 结果，已转为手工整理并保留待复核记录。' });
      setStatus({ type: 'warning', text: '已转为手工整理，请补齐右侧必填字段后套用表单；完成前不会关闭识别异常记录。' });
      void recordRuntimeLog({
        page: '照片分拣工作台',
        operation: 'OCR 异常转手工整理',
        errorType: 'OCR 识别',
        summary: `照片“${currentPanelPhoto.originalName || '未命名照片'}”已转为手工整理。`,
        level: 'warning'
      });
    } catch (error) {
      setRecognitionMessage({ type: 'error', text: `转为手工整理失败：${error.message || '后台记录更新失败'}` });
      setStatus({ type: 'error', text: '当前照片尚未转为手工整理，请稍后重试。' });
      void recordRuntimeLog({
        page: '照片分拣工作台',
        operation: 'OCR 异常转手工整理失败',
        errorType: 'OCR 识别',
        summary: error.message || '后台记录更新失败',
        level: 'error'
      });
    } finally {
      setIsRecognitionBusy(false);
    }
  }

  function openCurrentRecognitionRecord() {
    if (!currentPanelPhoto) return;
    onNavigate({
      page: PAGE_KEYS.dataMaintenance,
      action: 'openOcrRecords',
      payload: {
        recordId: currentRecognitionResult?.stagedResultId || '',
        keyword: currentPanelPhoto.originalName || ''
      }
    });
  }

  function activatePhotoFromPreview(photo) {
    if (!photo) return;
    setActivePhotoId(photo.id);
    window.requestAnimationFrame(() => {
      const browser = photoBrowserRef.current;
      if (!browser) return;
      const target = Array.from(browser.querySelectorAll('[data-photo-id]'))
        .find((element) => element.dataset.photoId === photo.id);
      target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }

  function showPreviousPhoto() {
    if (!canShowPreviousPhoto) return;
    const previousPhoto = pagePhotos[currentPagePhotoIndex - 1];
    if (!previousPhoto) return;
    activatePhotoFromPreview(previousPhoto);
  }

  function showNextPhoto() {
    if (!canShowNextPhoto) return;
    const nextPhoto = pagePhotos[currentPagePhotoIndex + 1];
    if (!nextPhoto) return;
    activatePhotoFromPreview(nextPhoto);
  }

  function applyStatusFilter(nextFilter) {
    const nextVisiblePhotos = getVisiblePhotosSnapshot({
      photos,
      activeSmartGroupPhotoKeys: null,
      filter: nextFilter,
      searchText,
      selectedIds: [],
      sortMode
    });
    switchStatusFilter(nextFilter);
    setSmartSortViewMode('statusFilter');
    setActiveSmartSortGroupId('');
    setSelectedIds([]);
    setActivePhotoId(nextVisiblePhotos[0]?.id || '');
    setPage(1);
  }

  function viewSmartGroup(groupId) {
    if (activeSmartSortGroupId === groupId && smartSortViewMode === 'smartSortGroup') {
      const nextVisiblePhotos = getVisiblePhotosSnapshot({
        photos,
        activeSmartGroupPhotoKeys: null,
        filter,
        searchText,
        selectedIds: [],
        sortMode
      });
      setSmartSortViewMode('statusFilter');
      setActiveSmartSortGroupId('');
      setSelectedIds([]);
      setActivePhotoId(nextVisiblePhotos[0]?.id || '');
      setPage(1);
      setSmartSortMessage({ type: 'idle', text: '已取消当前分组筛选，恢复按状态筛选查看。' });
      return;
    }
    const group = smartSortGroups.find((item) => item.id === groupId);
    const groupKeys = new Set(getSmartSortGroupKeys(group));
    const nextVisiblePhotos = getVisiblePhotosSnapshot({
      photos,
      activeSmartGroupPhotoKeys: groupKeys,
      filter,
      searchText: '',
      selectedIds: [],
      sortMode
    });
    const selectableGroupPhotos = nextVisiblePhotos.filter(isSmartGroupBatchSelectable);
    const excludedCount = nextVisiblePhotos.length - selectableGroupPhotos.length;
    setSmartSortViewMode('smartSortGroup');
    setActiveSmartSortGroupId(groupId);
    setSearchText('');
    setSelectedIds(selectableGroupPhotos.map((photo) => photo.id));
    setActivePhotoId(selectableGroupPhotos[0]?.id || nextVisiblePhotos[0]?.id || '');
    setPage(1);
    if (group) {
      setSmartSortMessage({
        type: excludedCount ? 'warning' : 'success',
        text: `已进入“${group.title}”并选中 ${selectableGroupPhotos.length} 张可处理照片。${excludedCount ? `另有 ${excludedCount} 张因已归档、已忽略、原图缺失或已生成预览而未选中。` : ''}`
      });
    }
  }

  function handleSearchTextChange(nextSearchText) {
    const nextVisiblePhotos = getVisiblePhotosSnapshot({
      photos,
      activeSmartGroupPhotoKeys,
      filter,
      searchText: nextSearchText,
      selectedIds: [],
      sortMode
    });
    setSearchText(nextSearchText);
    setSelectedIds([]);
    setActivePhotoId(nextVisiblePhotos[0]?.id || '');
    setPage(1);
  }

  function handlePhotoClick(photo, event) {
    const visibleIds = visiblePhotos.map((item) => item.id);
    if (event.shiftKey && lastClickedId && visibleIds.includes(lastClickedId)) {
      const start = visibleIds.indexOf(lastClickedId);
      const end = visibleIds.indexOf(photo.id);
      const range = visibleIds.slice(Math.min(start, end), Math.max(start, end) + 1);
      setSelectedIds((current) => Array.from(new Set([...current, ...range])));
    } else if (event.ctrlKey || event.metaKey) {
      setSelectedIds((current) => current.includes(photo.id) ? current.filter((id) => id !== photo.id) : [...current, photo.id]);
    } else {
      setActivePhotoId(photo.id);
    }
    setLastClickedId(photo.id);
  }

  function togglePhotoSelection(photoId) {
    setSelectedIds((current) => current.includes(photoId) ? current.filter((id) => id !== photoId) : [...current, photoId]);
  }

  function selectCurrentScope() {
    if (smartSortViewMode === 'smartSortGroup' && activeSmartGroup) {
      const selectableGroupPhotos = visiblePhotos.filter(isSmartGroupBatchSelectable);
      setSelectedIds(selectableGroupPhotos.map((photo) => photo.id));
      setActivePhotoId(selectableGroupPhotos[0]?.id || visiblePhotos[0]?.id || '');
      setStatus({ type: 'success', text: `已重新选中当前组 ${selectableGroupPhotos.length} 张可处理照片。` });
      return;
    }
    setSelectedIds((current) => Array.from(new Set([...current, ...pagePhotos.map((photo) => photo.id)])));
  }

  function invertCurrentScope() {
    if (smartSortViewMode === 'smartSortGroup' && activeSmartGroup) {
      const selectableIds = new Set(visiblePhotos.filter(isSmartGroupBatchSelectable).map((photo) => photo.id));
      setSelectedIds((current) => {
        const currentSet = new Set(current);
        return Array.from(selectableIds).filter((id) => !currentSet.has(id));
      });
      return;
    }
    const pageIds = new Set(pagePhotos.map((photo) => photo.id));
    setSelectedIds((current) => {
      const currentSet = new Set(current);
      pageIds.forEach((id) => {
        if (currentSet.has(id)) currentSet.delete(id);
        else currentSet.add(id);
      });
      return Array.from(currentSet);
    });
  }

  function selectUnassigned() {
    setSelectedIds(visiblePhotos.filter((photo) => photo.sortStatus === 'unassigned').map((photo) => photo.id));
  }

  async function markIgnored() {
    if (selectedIds.length === 0) {
      setStatus({ type: 'error', text: '请先选择需要标记忽略的照片。' });
      return;
    }
    const targetPhotos = selectedPhotos.filter((photo) => !isArchivedPhoto(photo) && !isIgnoredPhoto(photo));
    if (targetPhotos.length === 0) {
      setStatus({ type: 'warning', text: '当前没有可标记忽略的照片。' });
      return;
    }
    await markPhotosIgnored(targetPhotos);
  }

  async function ignoreCurrentPhoto() {
    if (!currentPanelPhoto || isArchivedPhoto(currentPanelPhoto) || isIgnoredPhoto(currentPanelPhoto)) {
      setStatus({ type: 'warning', text: '当前照片不能标记忽略。' });
      return;
    }
    await markPhotosIgnored([currentPanelPhoto]);
  }

  async function markPhotosIgnored(targetPhotos) {
    setIsRecognitionBusy(true);
    try {
      const targetIds = targetPhotos.map((photo) => photo.id);
      const stageSync = await syncRecognitionStageStatuses(
        targetIds,
        'dismissed',
        ['success', 'empty', 'failed', 'manual_pending', 'pending', 'resolved']
      );
      const failedIdSet = new Set(stageSync.failedPhotoIds);
      const appliedPhotos = targetPhotos.filter((photo) => !failedIdSet.has(photo.id));
      if (appliedPhotos.length === 0) {
        setStatus({ type: 'error', text: '后台 OCR 记录未能更新，照片尚未标记忽略，请稍后重试。' });
        return;
      }
      const appliedIdSet = new Set(appliedPhotos.map((photo) => photo.id));
      const resolvedAt = new Date().toISOString();
      const recognitionIssueCount = appliedPhotos.filter((photo) => getRecognitionOutcome(recognitionResultsByPhoto[photo.id]) === 'failed').length;
      setRecognitionResultsByPhoto((current) => Object.fromEntries(Object.entries(current).map(([photoId, result]) => {
        if (!appliedIdSet.has(photoId) || !result) return [photoId, result];
        const previousOutcome = getRecognitionOutcome(result);
        return [photoId, {
          ...result,
          ignoredPreviousResolution: result.resolution || '',
          ignoredPreviousResolvedAt: result.resolvedAt || '',
          ignoredPreviousStageStatus: previousOutcome === 'manual_pending'
            ? 'pending_review'
            : previousOutcome === 'resolved' ? 'reviewed' : 'staged',
          resolution: 'ignored',
          resolvedAt
        }];
      })));
      const invalidTip = invalidatePreviewMessage();
      setPhotos((current) => current.map((photo) => {
        if (appliedIdSet.has(photo.id)) {
          return {
            ...photo,
            ignoredPreviousSortStatus: photo.sortStatus,
            sortStatus: 'ignored',
            previewInfo: null,
            archiveResult: null
          };
        }
        return invalidTip ? clearGeneratedPreview(photo) : photo;
      }));
      if (recognitionIssueCount > 0) {
        setRecognitionMessage({ type: 'warning', text: `已忽略 ${recognitionIssueCount} 张识别异常照片，后台记录已保留并标记为已忽略。` });
      }
      setSelectedIds((current) => current.filter((id) => failedIdSet.has(id)));
      setEditingPhotoId((current) => appliedIdSet.has(current) ? '' : current);
      invalidateBatchPreparationUndo();
      markChanged();
      const failedTip = failedIdSet.size ? `另有 ${failedIdSet.size} 张因后台记录更新失败而保持原状态。` : '';
      setStatus({
        type: invalidTip || failedTip ? 'warning' : 'success',
        text: `已标记忽略 ${appliedPhotos.length} 张照片，原图未受影响。${invalidTip}${failedTip}`
      });
    } finally {
      setIsRecognitionBusy(false);
    }
  }

  async function cancelIgnored() {
    const targetPhotos = selectedPhotos.filter(isIgnoredPhoto);
    if (targetPhotos.length === 0) {
      setStatus({ type: 'warning', text: '请先在已忽略列表中选择需要还原的照片。' });
      return;
    }
    setIsRecognitionBusy(true);
    try {
      const restoreEntries = targetPhotos.map((photo) => {
        const result = recognitionResultsByPhoto[photo.id];
        return {
          photo,
          result,
          stageStatus: result?.ignoredPreviousStageStatus || (result?.manualPendingAt ? 'pending_review' : 'staged')
        };
      });
      const stageResults = await Promise.all(restoreEntries.map(async ({ photo, result, stageStatus }) => {
        if (result?.resolution !== 'ignored' || !result.stagedResultId) return { photoId: photo.id, success: true };
        const updated = await updateStagedResultStatus(result.stagedResultId, stageStatus);
        return { photoId: photo.id, success: Boolean(updated) };
      }));
      const failedIdSet = new Set(stageResults.filter((item) => !item.success).map((item) => item.photoId));
      const restoredPhotos = targetPhotos.filter((photo) => !failedIdSet.has(photo.id));
      if (restoredPhotos.length === 0) {
        setStatus({ type: 'error', text: '后台 OCR 记录未能恢复，照片仍保持已忽略状态，请稍后重试。' });
        return;
      }
      const restoredIdSet = new Set(restoredPhotos.map((photo) => photo.id));
      const nextRecognitionResults = { ...recognitionResultsByPhoto };
      restoredPhotos.forEach((photo) => {
        const result = recognitionResultsByPhoto[photo.id];
        if (result?.resolution !== 'ignored') return;
        const reopenedResult = {
          ...result,
          resolution: result.ignoredPreviousResolution || '',
          resolvedAt: result.ignoredPreviousResolvedAt || ''
        };
        delete reopenedResult.ignoredPreviousResolution;
        delete reopenedResult.ignoredPreviousResolvedAt;
        delete reopenedResult.ignoredPreviousStageStatus;
        nextRecognitionResults[photo.id] = reopenedResult;
      });
      setRecognitionResultsByPhoto(nextRecognitionResults);
      const invalidTip = invalidatePreviewMessage();
      setPhotos((current) => current.map((photo) => {
        if (restoredIdSet.has(photo.id)) {
          const result = nextRecognitionResults[photo.id];
          const derivedStatus = result
            ? getPhotoRecognitionSortStatus(result, archiveSuggestionsByPhoto[photo.id])
            : 'unassigned';
          const previousStatus = photo.ignoredPreviousSortStatus;
          const restoredStatus = ['assigned', 'previewed'].includes(previousStatus) && photo.archiveInfo
            ? 'assigned'
            : previousStatus && previousStatus !== 'ignored' ? previousStatus : derivedStatus;
          const { ignoredPreviousSortStatus, ...restoredPhoto } = photo;
          return { ...restoredPhoto, sortStatus: restoredStatus, previewInfo: null, archiveResult: null };
        }
        return invalidTip ? clearGeneratedPreview(photo) : photo;
      }));
      setRecognitionMessage({ type: 'warning', text: `已恢复 ${restoredPhotos.length} 张照片的识别处理状态，请选择后继续整理。` });
      setSelectedIds((current) => current.filter((id) => failedIdSet.has(id)));
      setEditingPhotoId((current) => restoredIdSet.has(current) ? '' : current);
      invalidateBatchPreparationUndo();
      markChanged();
      const failedTip = failedIdSet.size ? `另有 ${failedIdSet.size} 张因后台记录恢复失败而继续保持已忽略。` : '';
      setStatus({
        type: invalidTip || failedTip ? 'warning' : 'success',
        text: `已还原 ${restoredPhotos.length} 张已忽略照片，并恢复忽略前状态。${invalidTip}${failedTip}`
      });
    } finally {
      setIsRecognitionBusy(false);
    }
  }

  function applyRecognitionSuggestionToForm() {
    const target = currentPanelPhoto;
    if (!target || !currentWatermarkRecord) {
      setStatus({ type: 'warning', text: '当前照片暂无水印事实记录，无法重新生成归档建议。' });
      return;
    }
    const nextSuggestion = regenerateArchiveSuggestion(
      currentWatermarkRecord,
      buildArchiveSuggestionContext({ configs, form, photoFolder, archiveRoot, photo: target }),
      archiveSuggestionsByPhoto[target.id]
    );
    setArchiveSuggestionsByPhoto((current) => ({ ...current, [target.id]: nextSuggestion }));
    setForm(sanitizeDraftFields(nextSuggestion.suggestedFields, configs));
    setRightPanelMode('form');
    invalidateBatchPreparationUndo();
    markChanged();
    setStatus({ type: nextSuggestion.conflictFields.length ? 'warning' : 'success', text: nextSuggestion.conflictFields.length ? `已重新生成当前照片归档建议，保留人工字段：${nextSuggestion.conflictFields.join('、')}` : '已重新生成当前照片归档建议，请确认后预览。' });
  }

  async function confirmCurrentArchiveDraft() {
    const target = currentPanelPhoto;
    if (!target) {
      setStatus({ type: 'warning', text: '请先选择需要确认建议的照片。' });
      return;
    }
    if (isArchivedPhoto(target) || isIgnoredPhoto(target)) {
      setStatus({ type: 'warning', text: '已归档或已忽略照片不能确认归档建议。' });
      return;
    }
    const currentSuggestion = updateArchiveSuggestion(
      archiveSuggestionsByPhoto[target.id],
      sanitizeDraftFields(form, configs),
      { configs, photoId: target.id }
    );
    const result = confirmArchiveSuggestion(currentSuggestion, configs);
    setArchiveSuggestionsByPhoto((current) => ({
      ...current,
      [target.id]: {
        ...currentSuggestion,
        status: result.ok ? 'confirmed' : currentSuggestion.status,
        missingRequiredFields: result.missingRequiredFields || currentSuggestion.missingRequiredFields
      }
    }));
    setForm(sanitizeDraftFields(currentSuggestion.suggestedFields, configs));
    if (!result.ok) {
      setStatus({ type: 'error', text: `请补全归档建议字段：${(result.missingRequiredFields || []).join('、')}` });
      return;
    }
    const resolutionSync = await resolveRecognitionIssues([target.id], 'manual', 'reviewed');
    if (resolutionSync.failedPhotoIds.length > 0) {
      setStatus({ type: 'error', text: '后台 OCR 记录未能标记为已复核，当前表单已保留但尚未应用，请稍后重试。' });
      return;
    }
    const invalidTip = invalidatePreviewMessage();
    setPhotos((current) => current.map((photo) => {
      if (photo.id === target.id) return { ...photo, sortStatus: 'assigned', archiveInfo: result.archiveInfo, previewInfo: null, archiveResult: null };
      return invalidTip ? clearGeneratedPreview(photo) : photo;
    }));
    invalidateBatchPreparationUndo();
    markChanged();
    setStatus({ type: invalidTip ? 'warning' : 'success', text: `当前照片归档建议已确认，可生成预览。${invalidTip}` });
  }

  function saveCurrentArchiveSuggestion() {
    const target = currentPanelPhoto;
    if (!target) {
      setStatus({ type: 'warning', text: '请先选择需要保存建议的照片。' });
      return;
    }
    const nextSuggestion = updateArchiveSuggestion(
      archiveSuggestionsByPhoto[target.id],
      sanitizeDraftFields(form, configs),
      { configs, photoId: target.id }
    );
    setArchiveSuggestionsByPhoto((current) => ({ ...current, [target.id]: nextSuggestion }));
    setForm(sanitizeDraftFields(nextSuggestion.suggestedFields, configs));
    invalidateBatchPreparationUndo();
    markChanged();
    setStatus({ type: nextSuggestion.missingRequiredFields.length ? 'warning' : 'success', text: nextSuggestion.missingRequiredFields.length ? `归档建议已保存，仍待补充：${nextSuggestion.missingRequiredFields.join('、')}` : '归档建议已保存，请确认后预览。' });
  }

  async function clearCurrentRecognitionOnly() {
    const target = currentRecognitionPhoto;
    if (!target) return;
    if (!window.confirm('确定清除当前照片的 OCR 结果吗？\n\n归档建议仍会保留，但已删除的后台识别记录无法撤销。')) return;
    const cleared = clearRecognitionForPhoto({ recognitionResultsByPhoto, watermarkRecordsByPhoto, photoId: target.id });
    setRecognitionResultsByPhoto(cleared.recognitionResultsByPhoto);
    setWatermarkRecordsByPhoto(cleared.watermarkRecordsByPhoto);
    await clearStagedResultsByPhoto(toRecognitionPhoto(target));
    setRightPanelMode('form');
    invalidateBatchPreparationUndo();
    markChanged();
    setRecognitionMessage({ type: 'success', text: '已清除当前照片识别结果，归档建议未受影响。' });
    setStatus({ type: 'success', text: '已清除当前照片识别结果，归档建议仍保留。' });
  }

  function clearCurrentArchiveDraft() {
    const target = currentPanelPhoto;
    if (!target) {
      setStatus({ type: 'warning', text: '请先选择需要清除建议的照片。' });
      return;
    }
    if (!window.confirm('确定清除当前照片的归档建议吗？\n\n不会清除 OCR 原文。\n不会删除、移动或修改原图。')) return;
    const cleared = clearArchiveSuggestionForPhoto({ archiveSuggestionsByPhoto, photoId: target.id });
    setArchiveSuggestionsByPhoto(cleared.archiveSuggestionsByPhoto);
    const invalidTip = invalidatePreviewMessage();
    setPhotos((current) => current.map((photo) => {
      if (photo.id === target.id && !isArchivedPhoto(photo) && !isIgnoredPhoto(photo)) {
        return { ...photo, sortStatus: 'unassigned', archiveInfo: null, previewInfo: null, archiveResult: null };
      }
      return invalidTip ? clearGeneratedPreview(photo) : photo;
    }));
    setForm(reconcileForm(defaultForm, configs));
    invalidateBatchPreparationUndo();
    markChanged();
    setStatus({ type: invalidTip ? 'warning' : 'success', text: `已清除当前照片归档建议，OCR 结果未受影响。${invalidTip}` });
  }

  function editCurrentPhotoInfo() {
    if (!primaryPhoto?.archiveInfo) return;
    setEditingPhotoId(primaryPhoto.id);
    setForm(reconcileForm({
      ...defaultForm,
      ...primaryPhoto.archiveInfo,
      workContent: primaryPhoto.archiveInfo.workContent || '',
      location: primaryPhoto.archiveInfo.location || ''
    }, configs));
    setStatus({ type: 'idle', text: `已载入当前照片的归档信息，可修改后保存到当前照片。` });
  }

  function saveCurrentPhotoInfo() {
    if (!editingPhoto) {
      setStatus({ type: 'error', text: '请先选择已套用归档信息的待预览照片。' });
      return;
    }
    const missing = validateSortForm(form, configs);
    if (missing.length) {
      setStatus({ type: 'error', text: `请补全必填项：${missing.join('、')}` });
      return;
    }
    const invalidTip = invalidatePreviewMessage();
    const archiveInfo = normalizeArchiveInfo(form);
    setPhotos((current) => current.map((photo) => {
      if (photo.id === editingPhoto.id) return { ...photo, sortStatus: 'assigned', archiveInfo, previewInfo: null, archiveResult: null };
      return invalidTip ? clearGeneratedPreview(photo) : photo;
    }));
    setEditingPhotoId('');
    invalidateBatchPreparationUndo();
    markChanged();
    setStatus({ type: invalidTip ? 'warning' : 'success', text: `当前照片归档信息已修改。${invalidTip || '仅当前照片被更新。'}` });
  }

  async function saveDraft() {
    if (photos.length === 0) {
      setStatus({ type: 'error', text: '当前没有可保存的分拣内容。' });
      return;
    }
    const savedAt = new Date().toISOString();
    const payload = {
      version: '1.3.3',
      savedAt,
      photoFolder,
      archiveRoot,
      filter,
      selectedIds,
      sortMode,
      pageSize,
      rightPanelMode,
      recognitionResultsByPhoto,
      watermarkRecordsByPhoto,
      archiveSuggestionsByPhoto,
      photos: photos.map(({ previewUrl, thumbnailPath, ...photo }) => photo)
    };
    const result = await window.archiveAssistant.saveSortDraft(payload);
    if (result?.success) {
      setLastDraftSavedAt(savedAt);
      setHasSavedDraft(true);
      window.localStorage.setItem(sortDraftAvailableKey, 'true');
      setHasUnsavedChanges(false);
      setStatus({ type: 'success', text: '分拣进度已保存。' });
    }
  }

  async function loadDraft() {
    if (hasUnsavedChanges && !window.confirm('当前分拣进度尚未保存，恢复已保存进度将覆盖当前页面状态。是否继续？')) {
      return;
    }
    const result = await window.archiveAssistant.loadSortDraft();
    if (!result?.success || !result.draft) return;
    const loadedPhotos = await Promise.all((result.draft.photos || []).map(async (photo, index) => {
      const exists = await window.archiveAssistant.validatePathExists(photo.originalPath);
      return {
        ...photo,
        id: photo.id || `draft-${Date.now()}-${index}`,
        previewUrl: `local-photo://image/${encodeURIComponent(photo.originalPath)}`,
        thumbnailPath: `local-photo://image/${encodeURIComponent(photo.originalPath)}`,
        originalMissing: !exists,
        missingSortStatus: exists ? undefined : (photo.missingSortStatus || photo.sortStatus || 'unassigned'),
        sortStatus: photo.missingSortStatus || photo.sortStatus || 'unassigned'
      };
    }));
    rememberSessionPhotoFolder(result.draft.photoFolder || '');
    const restoredArchiveRoot = result.draft.archiveRoot || '';
    setArchiveRoot(restoredArchiveRoot);
    if (restoredArchiveRoot) archiveState?.setCurrentArchiveRoot?.(restoredArchiveRoot);
    setFilter(normalizeStatusFilter(result.draft.filter));
    setSmartSortViewMode('statusFilter');
    setActiveSmartSortGroupId('');
    setRecognitionMessage({ type: 'idle', text: '' });
    setRecognitionResultsByPhoto(result.draft.recognitionResultsByPhoto || {});
    setWatermarkRecordsByPhoto(result.draft.watermarkRecordsByPhoto || {});
    setArchiveSuggestionsByPhoto(result.draft.archiveSuggestionsByPhoto || {});
    setRightPanelMode(['form', 'recognition'].includes(result.draft.rightPanelMode) ? result.draft.rightPanelMode : 'form');
    setSortMode(result.draft.sortMode || 'timeAsc');
    const restoredPageSize = Number(result.draft.pageSize);
    setPageSize([50, 100, 200].includes(restoredPageSize) ? restoredPageSize : 50);
    setPhotos(loadedPhotos);
    invalidateBatchPreparationUndo();
    setSelectedIds((result.draft.selectedIds || []).filter((id) => loadedPhotos.some((photo) => photo.id === id)));
    setPage(1);
    setEditingPhotoId('');
    setLastDraftSavedAt(result.draft.savedAt || '');
    setHasSavedDraft(true);
    window.localStorage.setItem(sortDraftAvailableKey, 'true');
    setHasUnsavedChanges(false);
    const missingCount = loadedPhotos.filter((photo) => photo.originalMissing).length;
    setStatus({ type: missingCount ? 'warning' : 'success', text: `分拣进度已恢复，共 ${loadedPhotos.length} 张照片。${missingCount ? `其中 ${missingCount} 张原图缺失，请核对。` : ''}` });
  }

  async function relocateMissingPhotos() {
    const missingPhotos = photos.filter((photo) => photo.originalMissing);
    if (missingPhotos.length === 0) {
      setStatus({ type: 'idle', text: '当前没有原图缺失记录。' });
      return;
    }
    const selected = await window.archiveAssistant.selectPhotoFolder();
    if (!selected) return;
    setIsBusy(true);
    try {
      const scanned = await window.archiveAssistant.scanImages(selected);
      const available = [...scanned];
      let restoredCount = 0;
      const restored = photos.map((photo) => {
        if (!photo.originalMissing) return photo;
        const matchIndex = findBestPhotoMatch(photo, available);
        if (matchIndex < 0) return photo;
        const matched = available.splice(matchIndex, 1)[0];
        restoredCount += 1;
        return {
          ...photo,
          originalPath: matched.path,
          originalName: matched.name,
          extension: matched.extension,
          size: matched.size,
          modifiedAt: matched.modifiedAt,
          thumbnailPath: matched.previewUrl,
          previewUrl: matched.previewUrl,
          originalMissing: false,
          sortStatus: photo.missingSortStatus || photo.sortStatus,
          missingSortStatus: undefined
        };
      });
      setPhotos(restored);
      rememberSessionPhotoFolder(selected);
      const nextSettings = await window.archiveAssistant.updateLastPhotoFolder(selected);
      setSettings(nextSettings);
      invalidateBatchPreparationUndo();
      markChanged();
      setStatus({ type: restoredCount === missingPhotos.length ? 'success' : 'warning', text: `已重新匹配 ${restoredCount} 张照片，仍有 ${missingPhotos.length - restoredCount} 张原图缺失。` });
    } catch (error) {
      recordRuntimeLog({ page: '照片分拣工作台', operation: '重新定位照片文件夹', errorType: '读取目录失败', summary: error.message, error });
      setStatus({ type: 'error', text: `重新定位照片文件夹失败：${error.message}` });
    } finally {
      setIsBusy(false);
    }
  }

  async function applyCurrentInfoAndBuildPreview() {
    if (selectedIds.length === 0) {
      setStatus({ type: 'warning', text: '请先选择需要套用表单的照片。' });
      return;
    }
    if (blockIgnoredSelectionAction()) return;
    const targets = getEditableSelectedPhotos();
    if (targets.length === 0) {
      setStatus({ type: 'warning', text: '当前选择中没有可更新的照片。' });
      return;
    }
    const missing = validateRequiredArchiveFields(form, configs);
    if (missing.length > 0) {
      setStatus({ type: 'warning', text: `请先补齐当前照片必填字段：${missing.join('、')}` });
      return;
    }
    if (!archiveRoot) {
      setStatus({ type: 'warning', text: '请先选择归档根目录。' });
      return;
    }
    const confirmed = window.confirm(`确定把右侧当前表单套用到已选 ${targets.length} 张照片并生成预览吗？\n\n这些照片原有的归档建议将被当前表单覆盖，但不会修改 OCR 原文和原始照片。`);
    if (!confirmed) return;

    const serviceForm = buildCurrentPhotoArchiveServiceForm(normalizeArchiveInfo(form), configs);
    const archiveInfo = normalizeArchiveInfo(serviceForm);
    setIsBusy(true);
    try {
      const preview = await window.archiveAssistant.buildArchivePreview({
        form: serviceForm,
        archiveRoot,
        photos: targets.map((photo) => ({
          ...serviceForm,
          id: photo.id,
          path: photo.originalPath,
          name: photo.originalName,
          extension: photo.extension,
          size: photo.size,
          previewUrl: photo.previewUrl,
          sourceType: photo.sourceType,
          sourceKey: photo.sourceKey,
          sourceMetadataRef: photo.sourceMetadataRef
        }))
      });
      const previewMap = new Map(preview.map((item) => [item.id, item]));
      const previewTargets = targets.filter((photo) => previewMap.has(photo.id));
      if (previewTargets.length === 0) {
        setStatus({ type: 'warning', text: '当前表单未能生成有效预览，照片尚未套用，请检查归档目录和表单内容。' });
        return;
      }

      const resolutionSync = await resolveRecognitionIssues(previewTargets.map((photo) => photo.id), 'manual', 'reviewed');
      const failedIdSet = new Set(resolutionSync.failedPhotoIds);
      const appliedTargets = previewTargets.filter((photo) => !failedIdSet.has(photo.id));
      if (appliedTargets.length === 0) {
        setStatus({ type: 'error', text: '后台 OCR 记录未能标记为已复核，当前表单和预览均未套用，请稍后重试。' });
        return;
      }

      rememberBatchPreparationUndo('套用表单并生成预览', appliedTargets.map((photo) => photo.id));
      const targetIds = new Set(appliedTargets.map((photo) => photo.id));
      setArchiveSuggestionsByPhoto((current) => {
        const next = { ...current };
        appliedTargets.forEach((photo) => {
          const suggestion = updateArchiveSuggestion(current[photo.id], sanitizeDraftFields(serviceForm, configs), {
            configs,
            photoId: photo.id
          });
          next[photo.id] = { ...suggestion, status: 'confirmed', missingRequiredFields: [] };
        });
        return next;
      });
      setPhotos((current) => current.map((photo) => targetIds.has(photo.id)
        ? { ...photo, sortStatus: 'previewed', archiveInfo, previewInfo: previewMap.get(photo.id), archiveResult: null }
        : photo));
      setHasUnsavedChanges(true);
      switchStatusFilter('previewed');
      setSmartSortViewMode('statusFilter');
      setActiveSmartSortGroupId('');
      setSearchText('');
      setSelectedIds([]);
      setActivePhotoId(appliedTargets[0]?.id || '');
      setPage(1);
      window.requestAnimationFrame(() => photoBrowserRef.current?.scrollTo({ top: 0, left: 0 }));
      markChanged();
      const skippedCount = targets.length - appliedTargets.length;
      const skippedTip = skippedCount ? `另有 ${skippedCount} 张未能完成预览，仍保持原状态。` : '';
      setStatus({
        type: skippedCount ? 'warning' : 'success',
        text: `已将当前表单套用到 ${appliedTargets.length} 张照片并生成归档预览。${skippedTip}`
      });
    } catch (error) {
      recordRuntimeLog({ page: '照片分拣工作台', operation: '套用表单并生成预览', errorType: '生成预览失败', summary: error.message, error });
      setStatus({ type: 'error', text: `套用表单并生成预览失败：${error.message}` });
    } finally {
      setIsBusy(false);
    }
  }

  async function buildSortPreview() {
    if (blockIgnoredSelectionAction()) return;
    if (photos.length === 0) {
      setStatus({ type: 'error', text: '当前没有照片，无法生成归档预览。' });
      return;
    }
    if (!archiveRoot) {
      setStatus({ type: 'error', text: '请先选择归档根目录。' });
      return;
    }
    const assigned = photos.filter((photo) => photo.sortStatus === 'assigned' && photo.archiveInfo);
    if (assigned.length === 0) {
      setStatus({ type: 'error', text: '当前没有待预览照片，无法生成归档预览。' });
      return;
    }
    const missingAssigned = assigned.filter((photo) => photo.originalMissing);
    if (missingAssigned.length > 0) {
      setStatus({ type: 'error', text: `存在 ${missingAssigned.length} 张原图缺失的待预览照片，无法生成归档预览。请重新定位照片文件夹或清除相关记录。` });
      return;
    }
    const normalizedAssigned = assigned.map((photo) => ({
      photo,
      serviceForm: buildCurrentPhotoArchiveServiceForm(photo.archiveInfo, configs)
    }));
    const invalidPhotos = normalizedAssigned.filter(({ serviceForm }) => validateRequiredArchiveFields(serviceForm, configs).length > 0);
    if (invalidPhotos.length > 0) {
      setStatus({ type: 'error', text: `有 ${invalidPhotos.length} 张待预览照片缺少必填字段，请编辑补全后再生成预览。` });
      return;
    }
    setIsBusy(true);
    try {
      const preview = await window.archiveAssistant.buildArchivePreview({
        form: normalizedAssigned[0].serviceForm,
        archiveRoot,
        photos: normalizedAssigned.map(({ photo, serviceForm }) => ({
          ...serviceForm,
          id: photo.id,
          path: photo.originalPath,
          name: photo.originalName,
          extension: photo.extension,
          size: photo.size,
          previewUrl: photo.previewUrl,
          sourceType: photo.sourceType,
          sourceKey: photo.sourceKey,
          sourceMetadataRef: photo.sourceMetadataRef
        }))
      });
      const previewMap = new Map(preview.map((item) => [item.id, item]));
      if (preview.length === 0) {
        setStatus({ type: 'warning', text: '当前没有可预览的照片，请先选择照片并应用归档信息。' });
        return;
      }
      setPhotos((current) => current.map((photo) => previewMap.has(photo.id)
        ? { ...photo, sortStatus: 'previewed', previewInfo: previewMap.get(photo.id), archiveResult: null }
        : photo));
      setHasUnsavedChanges(true);
      switchStatusFilter('previewed');
      setSmartSortViewMode('statusFilter');
      setActiveSmartSortGroupId('');
      setSearchText('');
      setSelectedIds([]);
      setActivePhotoId(preview[0]?.id || '');
      setPage(1);
      window.requestAnimationFrame(() => photoBrowserRef.current?.scrollTo({ top: 0, left: 0 }));
      setStatus({ type: (pendingCount || ignoredCount) ? 'warning' : 'success', text: `已生成 ${preview.length} 张照片的归档预览。另有 ${pendingCount} 张尚未进入预览，${ignoredCount} 张已忽略。` });
    } catch (error) {
      recordRuntimeLog({ page: '照片分拣工作台', operation: '生成分拣归档预览', errorType: '生成预览失败', summary: error.message, error });
      setStatus({ type: 'error', text: `生成分拣归档预览失败：${error.message}` });
    } finally {
      setIsBusy(false);
    }
  }

  function cancelSortPreview() {
    if (previewPhotos.length === 0) {
      setStatus({ type: 'warning', text: '当前没有可取消的归档预览。' });
      return;
    }
    const pendingLedgerCount = previewPhotos.filter((photo) => photo.archiveResult?.stage === 'ledger_pending').length;
    if (pendingLedgerCount > 0) {
      setStatus({ type: 'warning', text: `有 ${pendingLedgerCount} 张照片已经复制、台账待补记，请先重新归档完成恢复。` });
      return;
    }
    const cancelledCount = previewPhotos.length;
    const restoredPhotos = photos.map(clearGeneratedPreview);
    const previewPhotoIds = new Set(previewPhotos.map((photo) => photo.id));
    const undoAffectedIds = batchPreparationUndo?.affectedPhotoIds || [];
    const canRestorePreviousGroup = batchPreparationUndo?.smartSortViewMode === 'smartSortGroup'
      && smartSortGroups.some((group) => group.id === batchPreparationUndo.activeSmartSortGroupId)
      && undoAffectedIds.some((photoId) => previewPhotoIds.has(photoId));

    setPhotos(restoredPhotos);
    setShowConfirm(false);
    if (canRestorePreviousGroup) {
      const previousGroup = smartSortGroups.find((group) => group.id === batchPreparationUndo.activeSmartSortGroupId);
      const groupKeys = new Set(getSmartSortGroupKeys(previousGroup));
      const restoredGroupPhotos = getVisiblePhotosSnapshot({
        photos: restoredPhotos,
        activeSmartGroupPhotoKeys: groupKeys,
        filter: batchPreparationUndo.filter || filter,
        searchText: batchPreparationUndo.searchText || '',
        selectedIds: [],
        sortMode
      });
      const selectableIds = new Set(restoredGroupPhotos.filter(isSmartGroupBatchSelectable).map((photo) => photo.id));
      const restoredSelectedIds = (batchPreparationUndo.selectedIds || []).filter((photoId) => selectableIds.has(photoId));
      const restoredActivePhotoId = restoredGroupPhotos.some((photo) => photo.id === batchPreparationUndo.activePhotoId)
        ? batchPreparationUndo.activePhotoId
        : restoredSelectedIds[0] || restoredGroupPhotos[0]?.id || '';
      setFilter(batchPreparationUndo.filter || filter);
      setSearchText(batchPreparationUndo.searchText || '');
      setSmartSortViewMode('smartSortGroup');
      setActiveSmartSortGroupId(previousGroup.id);
      setSelectedIds(restoredSelectedIds);
      setActivePhotoId(restoredActivePhotoId);
      setPage(Number(batchPreparationUndo.page) || 1);
      setSmartSortMessage({ type: 'success', text: `已取消预览并返回“${previousGroup.title}”，恢复原选择。` });
    } else {
      switchStatusFilter('unarchived');
      setSmartSortViewMode('statusFilter');
      setActiveSmartSortGroupId('');
      setPage(1);
    }
    markChanged();
    setStatus({
      type: 'success',
      text: canRestorePreviousGroup
        ? `已取消 ${cancelledCount} 张照片的归档预览，并返回之前选择的智能分组。`
        : `已取消 ${cancelledCount} 张照片的归档预览，照片恢复为待预览状态。`
    });
  }

  function requestArchive() {
    if (blockIgnoredSelectionAction()) return;
    if (previewPhotos.length === 0) {
      setStatus({ type: 'error', text: '请先生成分拣归档预览。' });
      return;
    }
    const missingPreview = previewPhotos.filter((photo) => photo.originalMissing);
    if (missingPreview.length > 0) {
      setStatus({ type: 'error', text: `存在 ${missingPreview.length} 张原图缺失照片，无法确认归档。请重新定位照片文件夹后再操作。` });
      return;
    }
    setShowConfirm(true);
  }

  async function archivePreviewedPhotos() {
    invalidateBatchPreparationUndo();
    setIsBusy(true);
    try {
      const archiveGroups = groupPreviewPhotosByTransaction(previewPhotos);
      const groupResults = [];
      for (const group of archiveGroups) {
        const result = await window.archiveAssistant.archivePhotos({
          archiveRoot,
          transactionId: group.transactionId,
          items: group.photos.map((photo) => photo.previewInfo)
        });
        groupResults.push(result);
      }
      const result = mergeArchiveTransactionResults(groupResults);
      const resultMap = new Map(result.items.map((item) => [item.photoId || item.id, item]));
      const archivedAt = new Date().toISOString();
      setPhotos((current) => current.map((photo) => {
        const item = resultMap.get(photo.id);
        if (!item) return photo;
        const committed = item.stage === 'committed' || item.status === '归档成功';
        return {
          ...photo,
          sortStatus: committed ? 'archived' : 'previewed',
          archiveResult: item,
          previewInfo: committed ? item : { ...photo.previewInfo, transactionId: item.transactionId },
          archiveMethod: committed ? '手动分拣' : photo.archiveMethod,
          archivedAt: committed ? archivedAt : photo.archivedAt
        };
      }));
      setSelectedIds([]);
      setShowConfirm(false);
      const firstCommittedItem = result.items.find((item) => item.stage === 'committed');
      const firstPendingItem = result.items.find((item) => item.stage === 'ledger_pending');
      const firstFailedItem = result.items.find((item) => ['copy_failed', 'target_conflict'].includes(item.stage));
      switchStatusFilter(firstCommittedItem ? 'archived' : 'previewed');
      setSmartSortViewMode('statusFilter');
      setActiveSmartSortGroupId('');
      setActivePhotoId(firstCommittedItem?.photoId || firstPendingItem?.photoId || firstFailedItem?.photoId || '');
      setPage(1);
      setHasUnsavedChanges(true);
      const fingerprintWarning = String(result.fingerprintIndexWarning || '').trim();
      const summary = result.pendingLedgerCount > 0
        ? `照片复制已完成 ${result.copiedCount} 张，其中 ${result.pendingLedgerCount} 张台账待补记；可直接重新点击归档恢复。`
        : result.status === 'partial'
          ? `归档部分完成：成功 ${result.committedCount} 张，复制失败 ${result.failedCount} 张，目标冲突 ${result.conflictCount} 张。`
          : result.status === 'committed'
            ? `归档完成，已复制 ${result.committedCount} 张照片并安全追加 Excel 台账，原图仍保留。`
            : `归档未完成：复制失败 ${result.failedCount} 张，目标冲突 ${result.conflictCount} 张。`;
      setStatus({
        type: result.status === 'committed' && !fingerprintWarning
          ? 'success'
          : (result.committedCount > 0 || result.pendingLedgerCount > 0 ? 'warning' : 'error'),
        text: `${summary}${fingerprintWarning ? ` ${fingerprintWarning}` : ''}`
      });
    } catch (error) {
      recordRuntimeLog({ page: '照片分拣工作台', operation: '确认归档', errorType: '确认归档失败', summary: error.message, error });
      setStatus({ type: 'error', text: `确认归档失败：${error.message}` });
    } finally {
      setIsBusy(false);
    }
  }

  function openSelectedFolder() {
    if (primaryPhoto?.originalPath) {
      window.archiveAssistant.openPath(primaryPhoto.originalPath);
    } else if (photoFolder) {
      window.archiveAssistant.openPath(photoFolder);
    }
  }

  if (!configs) {
    return <section className="panel">正在加载照片分拣工作台...</section>;
  }

  return (
    <div className="sort-workbench unified-sort-workbench">
      <section className="sort-unified-header panel">
        <div>
          <p className="eyebrow">照片分拣工作台</p>
          <h1>选照片 → 填归档信息 → 预览 → 归档</h1>
        </div>
      </section>
      <>
      <div className="sort-main-grid">
        <aside className="sort-left-panel panel">
          <SortSection title="状态筛选">
            {statusFilters.filter(([key, label]) => key && label).map(([key, label]) => (
              <button type="button" key={key} className={smartSortViewMode === 'statusFilter' && filter === key ? 'active' : ''} onClick={() => applyStatusFilter(key)} disabled={photos.length === 0}>
                <span>{label}</span>
                <strong>{getFilterCount(key, photos, selectedIds)}</strong>
              </button>
            ))}
          </SortSection>
          <SortSection title="智能分拣分组" description="辅助整理照片分组，便于按组查看、核对和后续处理。" scrollable>
            <SmartSortGroupNav
              groups={smartSortGroups}
              activeGroupId={activeSmartSortGroupId}
              onSelectGroup={viewSmartGroup}
            />
          </SortSection>
        </aside>

        <main className="sort-center-panel panel">
          <div className="sort-toolbar-panel sort-toolbar-adaptive">
            <div className="sort-toolbar-main-row">
              <div className="sort-toolbar-group sort-toolbar-import-group">
              <button type="button" className="primary orange" title={effectivePhotoFolder ? '扫描当前照片目录' : '导入照片文件夹并自动扫描'} disabled={batchActionsBusy} onClick={importOrScanPhotos}>{effectivePhotoFolder ? '扫描' : '导入'}</button>
              <button type="button" title="清空当前照片列表" onClick={clearList} disabled={photos.length === 0 || batchActionsBusy}>清空</button>
              </div>
              <div className="sort-toolbar-group sort-toolbar-select-group">
              <button type="button" className="icon-action" title={pagePhotos.length > 0 ? (smartSortViewMode === 'smartSortGroup' ? '重新选择当前智能分组内所有可处理照片' : '全选当前页照片') : '当前没有可选择的照片'} aria-label={smartSortViewMode === 'smartSortGroup' ? '重选本组照片' : '全选当前页照片'} onClick={selectCurrentScope} disabled={batchActionsBusy || pagePhotos.length === 0}>{smartSortViewMode === 'smartSortGroup' ? '重选本组' : '全选'}</button>
              <button type="button" className="icon-action" title={pagePhotos.length > 0 ? (smartSortViewMode === 'smartSortGroup' ? '反选当前智能分组内可处理照片' : '反选当前页照片') : '当前没有可选择的照片'} aria-label={smartSortViewMode === 'smartSortGroup' ? '反选本组照片' : '反选当前页照片'} onClick={invertCurrentScope} disabled={batchActionsBusy || pagePhotos.length === 0}>{smartSortViewMode === 'smartSortGroup' ? '反选本组' : '反选'}</button>
              <button type="button" className="icon-action" title={selectedPhotos.length > 0 ? '取消当前选择' : '当前没有已选照片'} aria-label="取消选择" onClick={() => setSelectedIds([])} disabled={batchActionsBusy || selectedPhotos.length === 0}>取消</button>
              </div>
              <div className="sort-toolbar-group sort-toolbar-state-group">
              <button type="button" className="icon-action" title={selectedIgnorableCount > 0 ? `忽略 ${selectedIgnorableCount} 张已选照片` : '请先选择未归档且未忽略的照片'} aria-label="忽略选中照片" onClick={markIgnored} disabled={batchActionsBusy || selectedIgnorableCount === 0}>忽略</button>
              <button type="button" className="icon-action" title={selectedIgnoredCount > 0 ? `还原 ${selectedIgnoredCount} 张已忽略照片` : '请先选择已忽略照片'} aria-label="还原选中照片" onClick={cancelIgnored} disabled={batchActionsBusy || selectedIgnoredCount === 0}>还原</button>
              </div>
              <div className="sort-toolbar-group sort-toolbar-smart-group">
              <button type="button" className="primary orange" title={selectedEditablePhotos.length > 0 ? smartSortActionTitle : '请先选择未归档且未忽略的照片'} onClick={() => recognizeSelected({ alsoSort: true })} disabled={batchActionsBusy || selectedEditablePhotos.length === 0}>{smartSortActionLabel}</button>
              <button type="button" title={selectedSmartResultCount > 0 ? '清除已选照片的智拣结果与归档建议，并恢复为初始未归档状态' : '已选照片没有可重置的智拣结果'} onClick={clearSelectedRecognitionResults} disabled={batchActionsBusy || selectedSmartResultCount === 0}>重置智拣结果</button>
              </div>
              <details className="sort-toolbar-more">
                <summary>更多</summary>
                <div className="sort-toolbar-more-menu">
                  <span className="sort-toolbar-more-label">目录</span>
                  <button type="button" className="wide" title="更换照片目录" onClick={() => selectPhotoFolder({ scanAfterSelect: true })} disabled={batchActionsBusy}>照片目录</button>
                  <button type="button" className="wide" title="更换归档目录" onClick={selectArchiveRoot} disabled={batchActionsBusy}>归档目录</button>
                  <span className="sort-toolbar-more-label">归档进度</span>
                  <button type="button" title="保存当前分拣进度" onClick={saveDraft} disabled={photos.length === 0 || batchActionsBusy}>保存</button>
                  <button type="button" title="恢复已保存的分拣进度" onClick={loadDraft} disabled={!hasSavedDraft || batchActionsBusy}>恢复</button>
                </div>
              </details>
            </div>
            <div className="sort-toolbar-view-row">
              <div className="sort-toolbar-view-left">
                <div className="sort-view-tabs">
                {viewModes.map((mode) => (
                  <button type="button" key={mode.key} title={isPreviewStatusView ? '已生成预览固定使用列表视图' : mode.title} className={effectiveViewMode === mode.key ? 'active' : ''} onClick={() => changePhotoViewMode(mode.key)} disabled={photos.length === 0 || isPreviewStatusView}>
                    {mode.label}
                  </button>
                ))}
                </div>
                <select value={sortMode} onChange={(event) => setSortMode(event.target.value)} aria-label="排序方式" disabled={photos.length === 0}>
                  <option value="timeAsc">时间升序</option>
                  <option value="timeDesc">时间降序</option>
                  <option value="nameAsc">文件名升序</option>
                  <option value="nameDesc">文件名降序</option>
                </select>
              </div>
              <div className="sort-toolbar-view-right">
                <label className="sort-search">
                  <input value={searchText} placeholder="搜索" title="搜索文件名" onChange={(event) => handleSearchTextChange(event.target.value)} disabled={photos.length === 0} />
                </label>
              </div>
            </div>
          </div>

          <div ref={photoBrowserRef} className={`sort-photo-browser ${effectiveViewMode} thumb-standard`}>
            {pagePhotos.length === 0 ? (
              <div className="sort-empty-state">
                <strong>{effectivePhotoFolder ? '点击扫描读取当前照片目录。' : '请选择照片文件夹并扫描照片。'}</strong>
                <span>{visiblePhotos.length === 0 && photos.length > 0
                  ? (smartSortViewMode === 'smartSortGroup' ? '当前分组暂无匹配照片，可切换分组或重新执行智能分拣。' : '当前筛选条件下没有照片，可调整左侧筛选。')
                  : '原始照片只读取，不移动、不删除、不压缩。'}</span>
                {photos.length === 0 && <button type="button" className="primary orange" disabled={batchActionsBusy} onClick={importOrScanPhotos}>{effectivePhotoFolder ? '扫描' : '导入'}</button>}
              </div>
            ) : effectiveViewMode === 'grid' ? pagePhotos.map((photo) => (
              <PhotoCard
                key={photo.id}
                photo={photo}
                recognitionResult={recognitionResultsByPhoto[photo.id]}
                selected={selectedIds.includes(photo.id)}
                current={currentPanelPhoto?.id === photo.id}
                onClick={(event) => handlePhotoClick(photo, event)}
                onSelect={() => togglePhotoSelection(photo.id)}
              />
            )) : (
              <table className={`sort-photo-list ${isPreviewAuditList ? 'preview-audit-list' : ''}`}>
                <thead>
                  <tr><th>状态</th><th>文件名</th><th>{isPreviewAuditList ? '归档日期' : '时间'}</th><th>大小</th><th>分拣信息</th></tr>
                </thead>
                <tbody>
                  {pagePhotos.map((photo) => (
                    <tr
                      key={photo.id}
                      data-photo-id={photo.id}
                      className={[selectedIds.includes(photo.id) ? 'selected' : '', currentPanelPhoto?.id === photo.id ? 'current' : ''].filter(Boolean).join(' ')}
                      aria-current={currentPanelPhoto?.id === photo.id ? 'true' : undefined}
                      onClick={(event) => handlePhotoClick(photo, event)}
                    >
                      <td>
                        <div className="sort-list-status-cell">
                          {currentPanelPhoto?.id === photo.id && <span className="sort-list-current-marker">当前</span>}
                          <StatusBadge photo={photo} recognitionResult={recognitionResultsByPhoto[photo.id]} />
                        </div>
                      </td>
                      <td aria-label={photo.originalName}>{isPreviewAuditList ? <PreviewFileNames photo={photo} /> : photo.originalName}</td>
                      <td>{isPreviewAuditList ? (photo.previewInfo?.date || photo.archiveInfo?.date || '-') : formatDateTime(photo.modifiedAt)}</td>
                      <td>{formatFileSize(photo.size)}</td>
                      <td>{isPreviewAuditList
                        ? <PreviewSortSummary photo={photo} />
                        : photo.archiveInfo ? `${photo.archiveInfo.watermarkCategory} / ${photo.archiveInfo.workContent}` : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="sort-pagination">
            <span>显示 {visiblePhotos.length ? (safePage - 1) * pageSize + 1 : 0}-{Math.min(safePage * pageSize, visiblePhotos.length)} / {visiblePhotos.length}</span>
            <div>
              <button type="button" disabled={safePage <= 1} onClick={() => setPage(1)}>首页</button>
              <button type="button" disabled={safePage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button>
              <strong>第 {safePage} / {totalPages} 页</strong>
              <button type="button" disabled={safePage >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>下一页</button>
              <button type="button" disabled={safePage >= totalPages} onClick={() => setPage(totalPages)}>末页</button>
              <label className="ui-page-size">每页
                <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                  <option value={200}>200</option>
                </select>
              </label>
            </div>
          </div>
        </main>

        <aside className="sort-right-panel panel" ref={rightPanelRef}>
          <div className="sort-right-summary">
            <strong>已选 {selectedIds.length} 张</strong>
            <span>
              {rightWorkbenchStage === 'empty'
                  ? '暂无当前照片'
                  : rightWorkbenchStage === 'scanned'
                  ? '当前：待智拣'
                  : `当前：${currentPhotoStatusText}`}
            </span>
          </div>

          {smartSortProgressVisible && (
            <section className={`sort-right-progress ${isSmartSortBusy ? 'grouping' : 'recognizing'}`} role="status" aria-live="polite">
              <header>
                <strong>{isSmartSortBusy ? '正在生成智能分组' : '正在识别照片'}</strong>
                <span>{isSmartSortBusy
                  ? `正在整理 ${recognitionProgress.total || selectedIds.length} 张`
                  : `${recognitionProgress.current} / ${recognitionProgress.total}`}</span>
              </header>
              <div
                className="sort-right-progress-track"
                role="progressbar"
                aria-label={isSmartSortBusy ? '智能分组进度' : '照片识别进度'}
                aria-valuemin="0"
                aria-valuemax="100"
                aria-valuenow={smartSortProgressPercent}
              >
                <span style={{ width: `${smartSortProgressPercent}%` }} />
              </div>
            </section>
          )}

          <div className="sort-right-body">
            {rightWorkbenchStage === 'empty' ? (
              <section className="sort-right-card sort-right-empty-state">
                <h3>暂无当前照片</h3>
                <p>请先导入照片，并点击照片卡片查看识别结果、归档建议和确认信息。</p>
              </section>
            ) : rightWorkbenchStage === 'scanned' ? (
              <>
                <section className="sort-right-card sort-current-photo-card">
                  <div className="sort-current-photo-nav-main">
                    <span className="sort-current-photo-count">当前照片 {currentPagePhotoIndex >= 0 ? currentPagePhotoIndex + 1 : 0} / {pagePhotos.length}</span>
                    <span className="sort-current-photo-name">{currentPanelPhoto ? currentPanelPhoto.originalName : '暂无当前照片'}</span>
                    <small>当前状态：待智拣</small>
                  </div>
                  {currentPanelPhoto ? (
                    <div className="sort-current-preview">
                      {currentPanelPhoto.previewUrl ? (
                        <div className="sort-current-preview-media">
                          <img src={currentPanelPhoto.previewUrl} alt={currentPanelPhoto.originalName} />
                          <div className="sort-current-preview-nav" aria-hidden={false}>
                            <button type="button" className="sort-current-preview-nav-btn sort-current-preview-nav-prev" onClick={showPreviousPhoto} disabled={!canShowPreviousPhoto} aria-label="上一张" title="上一张">‹</button>
                            <button type="button" className="sort-current-preview-nav-btn sort-current-preview-nav-next" onClick={showNextPhoto} disabled={!canShowNextPhoto} aria-label="下一张" title="下一张">›</button>
                          </div>
                        </div>
                      ) : (
                        <span className="sort-current-preview-empty">暂无预览</span>
                      )}
                    </div>
                  ) : null}
                </section>
                <section className="sort-right-card sort-right-guide-card">
                  <h3>当前照片尚未识别</h3>
                  <p>请勾选照片后点击“智拣”，系统将自动识别水印并生成归档建议。</p>
                </section>
              </>
            ) : (
              <>
                <section className="sort-right-card sort-current-photo-card">
                  <div className="sort-current-photo-nav-main">
                    <span className="sort-current-photo-count">当前照片 {currentPagePhotoIndex >= 0 ? currentPagePhotoIndex + 1 : 0} / {pagePhotos.length}</span>
                    <span className="sort-current-photo-name">{currentPanelPhoto ? currentPanelPhoto.originalName : '暂无当前照片'}</span>
                    <small>当前状态：{currentPhotoStatusText}</small>
                  </div>
                  {currentPanelPhoto ? (
                    <div className="sort-current-preview">
                      {currentPanelPhoto.previewUrl ? (
                        <div className="sort-current-preview-media">
                          <img src={currentPanelPhoto.previewUrl} alt={currentPanelPhoto.originalName} />
                          <div className="sort-current-preview-nav" aria-hidden={false}>
                            <button type="button" className="sort-current-preview-nav-btn sort-current-preview-nav-prev" onClick={showPreviousPhoto} disabled={!canShowPreviousPhoto} aria-label="上一张" title="上一张">‹</button>
                            <button type="button" className="sort-current-preview-nav-btn sort-current-preview-nav-next" onClick={showNextPhoto} disabled={!canShowNextPhoto} aria-label="下一张" title="下一张">›</button>
                          </div>
                        </div>
                      ) : (
                        <span className="sort-current-preview-empty">暂无预览</span>
                      )}
                    </div>
                  ) : null}
                </section>

                <section className="sort-right-card sort-suggestion-card sort-correction-card">
                  <header className="sort-draft-header">
                    <div>
                      <h3>识别结果校正</h3>
                      <small>状态：{currentPhotoStatusText}</small>
                    </div>
                  </header>
                  {currentPhotoOriginalMissing ? (
                    <div className="sort-recognition-recovery failed" role="alert">
                      <div className="sort-recognition-recovery-copy">
                        <strong>当前照片原图缺失</strong>
                        <p>请重新定位照片文件夹后再继续识别、整理或归档。</p>
                      </div>
                      <div className="sort-recognition-recovery-actions">
                        <button type="button" className="orange" onClick={relocateMissingPhotos} disabled={batchActionsBusy}>重新定位照片</button>
                      </div>
                    </div>
                  ) : currentPhotoArchived ? (
                    <p className="sort-correction-tip success">当前照片已归档，可在“归档记录”中查看。</p>
                  ) : currentPhotoArchiveFailed ? (
                    <p className="sort-correction-tip warning">当前照片上次归档失败，请核对字段和归档目录后重试。</p>
                  ) : currentPhotoIgnored ? (
                    <p className="sort-correction-tip">当前照片已忽略。如需继续处理，请勾选照片后点击顶部“还原”。</p>
                  ) : currentPhotoPreviewed ? (
                    <p className="sort-correction-tip success">当前照片已生成归档预览。如需修改分拣信息，请先取消预览。</p>
                  ) : currentPhotoAssigned ? (
                    <p className="sort-correction-tip success">当前照片已套用归档信息，可以生成归档预览。</p>
                  ) : currentRecognitionManualPending ? (
                    <p className="sort-correction-tip warning">当前照片已转为手工整理；补齐必填字段并套用表单后，识别异常记录才会标记为已复核。</p>
                  ) : currentRecognitionIssue ? (
                    <div className={`sort-recognition-recovery ${currentRecognitionIssue.outcome}`} role="alert">
                      <div className="sort-recognition-recovery-copy">
                        <strong>{currentRecognitionIssue.title}</strong>
                        <p>{currentRecognitionIssue.message}</p>
                        <small>本次识别没有正常完成，建议先重新识别；仍无法识别时可转为手工整理。</small>
                      </div>
                      <div className="sort-recognition-recovery-actions">
                        <button type="button" className="orange" onClick={retryCurrentRecognition} disabled={batchActionsBusy}>重新识别</button>
                        <button type="button" onClick={continueCurrentPhotoManually} disabled={batchActionsBusy}>手工整理</button>
                        <button type="button" onClick={openCurrentRecognitionRecord} disabled={batchActionsBusy}>查看记录</button>
                        <button type="button" onClick={ignoreCurrentPhoto} disabled={batchActionsBusy}>忽略照片</button>
                      </div>
                    </div>
                  ) : currentRecognitionEmpty ? (
                    <p className="sort-correction-tip">未检测到可识别的水印文字，照片本身可能没有水印。请直接补充归档信息，无需处理识别异常。</p>
                  ) : currentRequiredFieldsComplete ? (
                    <p className="sort-correction-tip">识别结果已生成，请核对必填字段。</p>
                  ) : (
                    <p className="sort-correction-tip warning">请先补齐必填字段：{currentMissingRequiredFields.join('、')}。</p>
                  )}
                  <div className="sort-field-section sort-required-fields-section">
                    <h4>必填字段</h4>
                    <div className="sort-form-grid sort-core-fields-grid">
                      <InputField label="日期" type="date" value={form.date} onChange={(date) => updateForm({ date })} required disabled={currentFormLocked} />
                      <SelectField label="归档分类" value={form.watermarkCategory} options={Object.keys(configs.watermarkCategories)} onChange={(watermarkCategory) => updateForm({ watermarkCategory, workContent: '' })} required disabled={currentFormLocked} />
                      <SelectField label="工作内容" value={form.workContent} options={configs.watermarkCategories?.[form.watermarkCategory]?.items || []} onChange={(workContent) => updateForm({ workContent })} required disabled={currentFormLocked || !form.watermarkCategory} wide />
                    </div>
                  </div>
                  <div className="sort-field-section sort-suggested-fields-section">
                    <h4>建议项目</h4>
                    <div className="sort-form-grid sort-suggested-fields-grid">
                      <InputField label="位置/区域" value={form.location} placeholder="不填则默认现场" onChange={(location) => updateForm({ location })} disabled={currentFormLocked} />
                      <InputField label="关键词" value={form.keywords} onChange={(keywords) => updateForm({ keywords }, { preserveKeywords: true })} disabled={currentFormLocked} />
                      <TextAreaField label="备注" value={form.remark} onChange={(remark) => updateForm({ remark })} disabled={currentFormLocked} />
                    </div>
                  </div>
                </section>

              </>
            )}
          </div>

          <section className="sort-right-fixed-actions" aria-label="选中照片批量操作">
            <header>
              <div className="sort-right-fixed-actions-title">
                <strong>批量操作</strong>
                <span>{smartSortViewMode === 'smartSortGroup' && activeSmartGroup ? `本组 ${activeSmartSortGroupPhotoCount} 张 · 已选 ${selectedIds.length} 张` : `已选 ${selectedIds.length} 张`}</span>
              </div>
              <button type="button" className="sort-right-undo-action" title={previewPhotos.length > 0 && batchPreparationUndo ? '请先取消预览，再撤销最近一次套用' : batchPreparationUndo ? `撤销“${batchPreparationUndo.actionLabel}”并恢复 ${batchPreparationUndo.count} 张照片` : '套用表单后可在这里撤销'} onClick={undoLastBatchPreparation} disabled={batchActionsBusy || previewPhotos.length > 0 || !batchPreparationUndo}>撤销套用</button>
            </header>
            <div className="sort-right-action-buttons compact">
              <button
                type="button"
                className="primary apply-form-action"
                title={currentFormLocked
                  ? `当前照片状态为“${currentPhotoStatusText}”，不能整理`
                  : selectedHasIgnored
                    ? '当前选择包含已忽略照片，请先还原或取消选择'
                    : selectedEditablePhotos.length === 0
                      ? '请先选择需要整理的照片'
                      : !archiveRoot
                        ? '请先选择归档根目录'
                        : !currentRequiredFieldsComplete
                          ? `请先补齐必填字段：${currentMissingRequiredFields.join('、')}`
                          : `将右侧当前表单套用到 ${selectedEditablePhotos.length} 张已选照片并生成预览`}
                onClick={applyCurrentInfoAndBuildPreview}
                disabled={batchActionsBusy
                  || currentFormLocked
                  || selectedHasIgnored
                  || selectedEditablePhotos.length === 0
                  || !archiveRoot
                  || !currentRequiredFieldsComplete}
              >
                <span>套用并预览</span>
                <b>{selectedEditablePhotos.length}</b>
              </button>
              <button type="button" className="cancel-preview-action" title={previewPhotos.length > 0 ? `取消全部 ${previewPhotos.length} 张照片的归档预览` : archiveRoot ? `为已有的 ${assignedCount} 张待预览照片重新生成归档预览` : '请先选择归档目录'} onClick={previewPhotos.length > 0 ? cancelSortPreview : buildSortPreview} disabled={batchActionsBusy || (previewPhotos.length === 0 && (!archiveRoot || assignedCount === 0))}><span>{previewPhotos.length > 0 ? '取消预览' : '生成待预览'}</span><b>{previewPhotos.length > 0 ? previewPhotos.length : assignedCount}</b></button>
              <button type="button" className="orange" title={previewPhotos.length > 0 ? `归档全部 ${previewPhotos.length} 张已生成预览照片` : '请先生成归档预览'} onClick={requestArchive} disabled={batchActionsBusy || previewPhotos.length === 0}><span>归档照片</span><b>{previewPhotos.length}</b></button>
            </div>
          </section>
        </aside>
      </div>

      <footer className="sort-bottom-bar sort-batch-action-bar">
        <div className="sort-bottom-status">
          <span><small>已选</small><strong>{selectedIds.length}</strong></span>
          <span><small>建议可用</small><strong>{selectedSuggestionReadyCount}</strong></span>
          <span><small>待预览</small><strong>{assignedCount}</strong></span>
          <span><small>已生成预览</small><strong>{previewPhotos.length}</strong></span>
        </div>
        <div className="sort-bottom-feedback">
          <div className="sort-bottom-feedback-main" title={status.text}>
            <span>操作状态</span>
            <strong className={`sort-bottom-message ${status.type}`}>{status.text}</strong>
          </div>
          <div className="sort-bottom-feedback-detail">
            <div title={selectedStateText}>
              <span>选择</span>
              <strong>{selectedStateText}</strong>
            </div>
            <div title={recognitionMessage?.text || smartSortMessage?.text || smartSortEngineText}>
              <span>识别</span>
              <strong>{recognitionMessage?.text || smartSortMessage?.text || smartSortEngineText}</strong>
            </div>
            <div title={smartSortBottomText}>
              <span>当前视图</span>
              <strong>{smartSortBottomText}</strong>
            </div>
          </div>
        </div>
      </footer>

      {showConfirm && (
        <SortArchiveConfirm
          count={previewPhotos.length}
          pendingCount={pendingCount}
          ignoredCount={ignoredCount}
          archiveRoot={archiveRoot}
          photos={previewPhotos}
          onCancel={() => setShowConfirm(false)}
          onConfirm={archivePreviewedPhotos}
          isBusy={isBusy}
        />
      )}
      </>
    </div>
  );
}

function SmartSortGroupNav({ groups, activeGroupId, onSelectGroup }) {
  const hasGroups = groups.length > 0;
  return (
    <div className="smart-sort-nav-list">
      {!hasGroups ? (
        <p className="smart-sort-nav-empty">
          <strong>暂无分组</strong>
          <span>点击顶部“智拣”后，将在这里显示分组结果。</span>
        </p>
      ) : groups.map((group) => (
        <button
          type="button"
          key={group.id}
          className={activeGroupId === group.id ? 'active smart-sort-nav-item' : 'smart-sort-nav-item'}
          onClick={() => onSelectGroup(group.id)}
          title={group.title}
        >
          <span className="smart-sort-nav-main">
            <b className="smart-sort-nav-name">{group.title}</b>
            <strong className="smart-sort-nav-count">{getSmartSortGroupPhotoCount(group)}</strong>
          </span>
          <small className="smart-sort-nav-meta">{SMART_SORT_GROUP_STATUS_LABELS[group.status] || '待处理'}｜可靠度：{SMART_SORT_CONFIDENCE_LABELS[group.summary?.confidenceLabel] || '低'}</small>
        </button>
      ))}
    </div>
  );
}

function OcrResultPreview({ photo, result, onOpenRecognitionDetails }) {
  if (!photo) {
    return (
      <section className="sort-ocr-preview">
        <strong>识别结果</strong>
        <p>请选择照片后查看 OCR 原文、解析字段和水印裁剪状态。</p>
      </section>
    );
  }
  if (!result) {
    return (
      <section className="sort-ocr-preview">
        <strong>识别结果</strong>
        <p>当前照片暂无识别结果。请勾选照片后点击“智拣”。</p>
      </section>
    );
  }
  const rawText = result.rawText || result.adoptedOcrText || '';
  const statusLabel = getRecognitionStatusLabel(result);
  return (
    <section className="sort-ocr-preview">
      <header>
        <strong>识别结果</strong>
        <small>{statusLabel}｜{rawText ? `${rawText.length} 字` : '0 字'}</small>
      </header>
      {result.cropResult?.croppedPreviewUrl && (
        <a href={result.cropResult.croppedPreviewUrl} target="_blank" rel="noreferrer" title="点击放大查看裁剪后的水印区域">
          <img className="sort-ocr-crop-preview" src={result.cropResult.croppedPreviewUrl} alt="裁剪后的水印区域预览" />
        </a>
      )}
      <div className="sort-ocr-text-header">
        <span>OCR 原文</span>
        <button type="button" disabled={!rawText} onClick={() => navigator.clipboard?.writeText(rawText)}>复制原文</button>
      </div>
      <textarea readOnly rows={4} value={rawText || '未识别到有效文字'} />
      <button type="button" className="sort-detail-link" onClick={onOpenRecognitionDetails}>查看详情</button>
    </section>
  );
}

function RecognitionSuggestionPanel({ suggestion }) {
  return (
    <section className="sort-recognition-suggestion">
      <header>
        <strong>识别建议</strong>
        <small>{suggestion.sourceText}</small>
      </header>
      {suggestion.applicableDisplayFields.length > 0 ? (
        <div className="sort-suggestion-block">
          <h4>可应用字段</h4>
          {suggestion.applicableDisplayFields.map((field) => (
            <p key={field.key}><span>{field.label}</span><strong>{field.displayValue}</strong></p>
          ))}
        </div>
      ) : (
        <p className="sort-suggestion-empty">暂无可应用字段，请手动完善归档信息。</p>
      )}
      {suggestion.missingFields.length > 0 && (
        <div className="sort-suggestion-block muted">
          <h4>待补充字段</h4>
          <p>{suggestion.missingFields.join('、')}</p>
        </div>
      )}
      {suggestion.conflictFields.length > 0 && (
        <div className="sort-suggestion-block warning">
          <h4>冲突字段</h4>
          <p>{suggestion.conflictFields.join('、')}</p>
        </div>
      )}
      <small>{suggestion.description}</small>
    </section>
  );
}

function WatermarkRecordPanel({ record }) {
  if (!record) {
    return <p className="sort-suggestion-empty">暂无水印事实记录。</p>;
  }
  const rows = [
    ['拍摄日期', record.captureDate],
    ['拍摄时间', record.captureTime],
    ['项目文本', record.projectText],
    ['地点文本', record.locationText],
    ['工作内容文本', record.workContentText],
    ['备注文本', record.remarkText]
  ].filter(([, value]) => String(value || '').trim());
  return (
    <section className="sort-recognition-suggestion">
      <header>
        <strong>水印事实记录</strong>
        <small>置信度：{Math.round((record.confidence || 0) * 100)}%</small>
      </header>
      {rows.length > 0 ? (
        <div className="sort-suggestion-block">
          {rows.map(([label, value]) => <p key={label}><span>{label}</span><strong>{value}</strong></p>)}
        </div>
      ) : (
        <p className="sort-suggestion-empty">未提取到可用水印事实。</p>
      )}
      {(record.parseWarnings || []).length > 0 && <small>{record.parseWarnings.join('；')}</small>}
    </section>
  );
}

function DraftStatusSummary({ draft }) {
  if (!draft) {
    return <p className="sort-suggestion-empty">当前照片暂无归档建议。可先点击“智拣”，或直接补充字段后保存建议。</p>;
  }
  const missing = draft.missingRequiredFields || draft.missingFields || [];
  const candidates = Object.entries(draft.candidateFields || {});
  return (
    <section className="sort-recognition-suggestion">
      <header>
        <strong>建议状态</strong>
        <small>{draft.status === 'confirmed' ? '已确认' : missing.length ? '待补充' : '待确认'}</small>
      </header>
      {missing.length > 0 && (
        <div className="sort-suggestion-block warning">
          <h4>待补充字段</h4>
          <p>{missing.join('、')}</p>
        </div>
      )}
      {candidates.length > 0 && (
        <div className="sort-suggestion-block muted">
          <h4>候选字段</h4>
          {candidates.map(([key, values]) => <p key={key}>{key}：{(values || []).join('、')}</p>)}
        </div>
      )}
      {(draft.conflictFields || []).length > 0 && (
        <div className="sort-suggestion-block muted">
          <h4>保留人工字段</h4>
          <p>{(draft.conflictFields || []).join('、')}</p>
        </div>
      )}
      {!missing.length && !(draft.conflictFields || []).length && <small>字段已具备确认条件，请核对后点击“确认建议”。</small>}
    </section>
  );
}

function getRecognitionStatusLabel(result = {}) {
  if (!result) return '未执行';
  if (result.status === 'success' && (result.rawText || result.adoptedOcrText)) return '识别成功';
  if (result.status === 'empty' || result.status === 'success') return '未检测到水印文字';
  if (['failed', 'error', 'provider_unavailable', 'not_configured', 'disabled'].includes(result.status)) return '识别失败';
  return '待人工确认';
}

function getRecognitionEngineLabel(engine = {}, result = {}) {
  const provider = result.providerId || '';
  const source = engine.source || '';
  if (engine.ocrEngine === 'rapidocr' || source.includes('rapidocr')) return 'RapidOCR 本地';
  if (provider.includes('local')) return '本地 OCR';
  if (provider.includes('cloud')) return '云端 OCR';
  return 'OCR 引擎';
}

function getRecognitionEngineSourceLabel(engine = {}, result = {}) {
  const source = engine.source || '';
  if (source === 'rapidocr-bundled-production') return 'RapidOCR 本地引擎';
  if (source === 'rapidocr-bundled-dev') return 'RapidOCR 本地引擎';
  if (source === 'external-config') return '外部 OCR 工具';
  if (source === 'system-path') return '系统 OCR 工具';
  if (result.providerId?.includes('cloud')) return '云端 OCR';
  return '未检测到可用 OCR 引擎';
}

function EngineResult({ title, result }) {
  if (!result) return <span className="sort-ocr-engine-empty">{title}：未执行</span>;
  const text = result.rawText || result.text || '';
  const error = result.error || result.errorMessage || result.errors?.[0]?.message || '';
  return (
    <article className={text ? 'sort-ocr-engine-result success' : 'sort-ocr-engine-result'}>
      <strong>{title}</strong>
      <small>{text ? `已识别 ${text.length} 字` : (error || '无文本')}</small>
    </article>
  );
}

function SortSection({ title, action, description = '', children, scrollable = false }) {
  return (
    <section className={`sort-filter-section ${scrollable ? 'scrollable' : ''}`}>
      <header><h3>{title}</h3>{action}</header>
      {description && <p className="sort-section-hint">{description}</p>}
      <div>{children}</div>
    </section>
  );
}

function PhotoCard({ photo, recognitionResult, selected, current, onClick, onSelect }) {
  const gridSummary = buildGridPhotoSummary(photo);
  const newName = photo.previewInfo?.newName || photo.previewInfo?.newFileName || photo.previewInfo?.targetName || '';
  const handleSelectClick = (event) => {
    event.stopPropagation();
    onSelect();
  };
  const handleSelectKeyDown = (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    onSelect();
  };
  return (
    <button
      type="button"
      data-photo-id={photo.id}
      className={`sort-photo-card ${photo.sortStatus || ''} ${selected ? 'selected' : ''} ${current ? 'current' : ''}`}
      onClick={onClick}
      aria-label={photo.originalName || '照片卡片'}
      aria-current={current ? 'true' : undefined}
    >
      <div className="sort-thumb-wrap">
        {photo.originalMissing ? <span className="sort-missing-thumb">原图缺失</span> : <ThumbnailHoverPreview src={photo.previewUrl} alt={photo.originalName} />}
        {current && <span className="sort-current-marker">当前</span>}
        <span className="sort-ext">{photo.extension?.replace('.', '').toUpperCase()}</span>
        <span
          className={`sort-check ${selected ? 'selected' : 'idle'}`}
          role="checkbox"
          aria-checked={selected}
          tabIndex={0}
          title={selected ? '取消勾选' : '勾选照片'}
          onClick={handleSelectClick}
          onKeyDown={handleSelectKeyDown}
        >
          {selected ? '✓' : ''}
        </span>
      </div>
      <strong>{photo.originalName}</strong>
      <span>{formatDateTime(photo.modifiedAt)}</span>
      {gridSummary && (
        <p className="sort-grid-summary" aria-label={gridSummary.full}>
          <b>{gridSummary.main}</b>
          {gridSummary.sub && <small>{gridSummary.sub}</small>}
        </p>
      )}
      {newName && <p className="sort-grid-new-name" aria-label={newName}>新名：{newName}</p>}
      <footer>
        <StatusBadge photo={photo} recognitionResult={recognitionResult} />
        <small>{formatFileSize(photo.size)}</small>
      </footer>
    </button>
  );
}

function SortArchiveConfirm({ count, pendingCount, ignoredCount, archiveRoot, photos, onCancel, onConfirm, isBusy }) {
  const projects = unique(photos.map((photo) => photo.archiveInfo?.project));
  const categories = unique(photos.map((photo) => photo.archiveInfo?.watermarkCategory));
  const contents = unique(photos.map((photo) => photo.archiveInfo?.workContent));
  return (
    <div className="archive-confirm-backdrop">
      <section className="archive-confirm-dialog" role="dialog" aria-modal="true">
        <header className="archive-confirm-heading">
          <div>
            <p className="eyebrow">照片分拣工作台</p>
            <h2>确认执行归档？</h2>
          </div>
          <strong>{count} 张</strong>
        </header>
        <section className="archive-confirm-section">
          <h3>本次归档范围</h3>
          <dl className="archive-confirm-grid">
            <div><dt>将归档照片</dt><dd>{count} 张</dd></div>
            <div><dt>尚未进入预览</dt><dd>{pendingCount} 张</dd></div>
            <div><dt>不参与归档</dt><dd>{ignoredCount} 张已忽略</dd></div>
            <div><dt>归档根目录</dt><dd title={archiveRoot}>{archiveRoot}</dd></div>
            <div><dt>涉及项目</dt><dd>{projects.join('、') || '-'}</dd></div>
            <div><dt>归档分类</dt><dd>{categories.join('、') || '-'}</dd></div>
            <div><dt>工作内容</dt><dd>{contents.join('、') || '-'}</dd></div>
          </dl>
        </section>
        <section className="archive-confirm-section safe">
          <h3>安全说明</h3>
          <ul>
            <li>原始照片将保留，不移动、不删除、不压缩。</li>
            <li>本次只归档已生成预览的照片。</li>
            <li>未分拣照片不会归档。</li>
            <li>已忽略照片不会归档。</li>
            <li>归档成功后将追加 Excel 台账记录。</li>
          </ul>
        </section>
        <footer className="archive-confirm-actions">
          <button type="button" onClick={onCancel} disabled={isBusy}>返回修改</button>
          <button type="button" className="primary" disabled={isBusy} onClick={onConfirm}>{isBusy ? '正在归档...' : '确认归档'}</button>
        </footer>
      </section>
    </div>
  );
}

function SelectField({ label, value, options, onChange, required = false, disabled = false, wide = false }) {
  const placeholder = label === '归档分类'
    ? '请选择归档分类'
    : label === '工作内容'
      ? '请选择工作内容'
      : required
        ? `请选择${label}`
        : '';
  return (
    <label className={`field ${wide ? 'wide' : ''}`}>
      <span>{label}{required && <b>*</b>}</span>
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  );
}

function InputField({ label, value, onChange, type = 'text', placeholder = '', required = false, wide = false, disabled = false }) {
  return (
    <label className={`field ${wide ? 'wide' : ''}`}>
      <span>{label}{required && <b>*</b>}</span>
      <input type={type} value={value} placeholder={placeholder} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function TextAreaField({ label, value, onChange, disabled = false }) {
  return (
    <label className="field wide">
      <span>{label}</span>
      <textarea rows={2} value={value} placeholder="建议填写：问题点 + 处理动作 + 结果/状态" disabled={disabled} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function PreviewFileNames({ photo }) {
  const originalName = photo.originalName || photo.previewInfo?.originalName || '未命名照片';
  const newFileName = photo.previewInfo?.newFileName || photo.previewInfo?.newName || '';
  const targetPath = photo.previewInfo?.targetPath || photo.previewInfo?.targetDirectory || '';
  return (
    <div className="sort-preview-file-names" title={targetPath || newFileName || originalName}>
      <strong>{originalName}</strong>
      {newFileName && <span>→ {newFileName}</span>}
    </div>
  );
}

function PreviewSortSummary({ photo }) {
  const info = photo.previewInfo || photo.archiveInfo;
  if (!info) return '-';
  const workContent = info.workContent || '未填写工作内容';
  const location = info.location || '现场';
  const keywords = Array.isArray(info.keywords) ? info.keywords.join('、') : String(info.keywords || '').trim();
  const primary = [info.watermarkCategory, workContent].filter(Boolean).join(' / ') || '未填写分拣信息';
  const scene = `位置：${location}`;
  const supplemental = [keywords ? `关键词：${keywords}` : '', info.remark ? `备注：${info.remark}` : ''].filter(Boolean).join(' ｜ ');
  const fullText = [primary, scene, supplemental].filter(Boolean).join('\n');
  return (
    <div className="sort-preview-summary" title={fullText}>
      <strong>{primary}</strong>
      {scene && <span>{scene}</span>}
      {supplemental && <small>{supplemental}</small>}
    </div>
  );
}

function StatusBadge({ photo, recognitionResult }) {
  const status = photo?.sortStatus || '';
  return <span className={`sort-status-badge ${photo?.originalMissing ? 'failed' : status}`}>{getPhotoWorkflowStatus(photo, { recognitionResult })}</span>;
}

function reconcileForm(current, configs) {
  const categories = Object.keys(configs.watermarkCategories || {});
  const watermarkCategory = categories.includes(current.watermarkCategory) ? current.watermarkCategory : '';
  return {
    ...current,
    project: (configs.projects || []).includes(current.project) ? current.project : '',
    watermarkCategory,
    workContent: (configs.watermarkCategories?.[watermarkCategory]?.items || []).includes(current.workContent) ? current.workContent : ''
  };
}

function normalizeArchiveInfo(form) {
  return {
    project: form.project,
    watermarkCategory: form.watermarkCategory,
    archiveCategory: form.watermarkCategory,
    workContent: form.workContent,
    location: form.location,
    date: form.date,
    keywords: form.keywords,
    remark: form.remark
  };
}

function toArchiveForm(value) {
  return {
    ...value,
    location: value.location ?? ''
  };
}

function isIgnoredPhoto(photo) {
  return photo?.sortStatus === 'ignored';
}

function buildRecognitionStageRestores(photoIds = [], recognitionMap = {}) {
  return photoIds.map((photoId) => {
    const result = recognitionMap[photoId];
    const stagedResultId = result?.stagedResultId;
    const outcome = getRecognitionOutcome(result);
    if (!stagedResultId || !['empty', 'failed', 'manual_pending'].includes(outcome)) return null;
    return {
      photoId,
      stagedResultId,
      stageStatus: outcome === 'manual_pending' ? 'pending_review' : 'staged'
    };
  }).filter(Boolean);
}

function inferUndoAffectedPhotoIds(snapshotPhotos = [], currentPhotos = []) {
  const currentPhotoMap = new Map(currentPhotos.map((photo) => [photo.id, photo]));
  return snapshotPhotos.filter((photo) => {
    const current = currentPhotoMap.get(photo.id);
    if (!current) return false;
    return photo.sortStatus !== current.sortStatus
      || JSON.stringify(photo.archiveInfo || null) !== JSON.stringify(current.archiveInfo || null);
  }).map((photo) => photo.id);
}

function restoreSnapshotEntries(currentEntries = {}, snapshotEntries = {}, photoIds = new Set()) {
  const next = { ...currentEntries };
  photoIds.forEach((photoId) => {
    if (Object.prototype.hasOwnProperty.call(snapshotEntries, photoId)) next[photoId] = snapshotEntries[photoId];
    else delete next[photoId];
  });
  return next;
}

function groupPreviewPhotosByTransaction(photos = []) {
  const groups = new Map();
  photos.forEach((photo) => {
    const transactionId = String(
      photo.archiveResult?.transactionId
      || photo.previewInfo?.transactionId
      || ''
    ).trim();
    const key = transactionId || '__new__';
    const group = groups.get(key) || { transactionId, photos: [] };
    group.photos.push(photo);
    groups.set(key, group);
  });
  return Array.from(groups.values());
}

function mergeArchiveTransactionResults(results = []) {
  const safeResults = results.filter(Boolean);
  const items = safeResults.flatMap((result) => (result.items || []).map((item) => ({
    ...item,
    transactionId: item.transactionId || result.transactionId || ''
  })));
  const committedCount = safeResults.reduce((sum, result) => sum + Number(result.committedCount || 0), 0);
  const pendingLedgerCount = safeResults.reduce((sum, result) => sum + Number(result.pendingLedgerCount || 0), 0);
  const failedCount = safeResults.reduce((sum, result) => sum + Number(result.failedCount || 0), 0);
  const conflictCount = safeResults.reduce((sum, result) => sum + Number(result.conflictCount || 0), 0);
  const copiedCount = safeResults.reduce((sum, result) => sum + Number(result.copiedCount || 0), 0);
  const inputCount = safeResults.reduce((sum, result) => sum + Number(result.inputCount || result.total || 0), 0);
  const status = pendingLedgerCount > 0
    ? 'ledger_pending'
    : committedCount === inputCount && inputCount > 0
      ? 'committed'
      : committedCount > 0
        ? 'partial'
        : 'failed';
  return {
    success: status === 'committed',
    recoverable: pendingLedgerCount > 0,
    status,
    inputCount,
    copiedCount,
    committedCount,
    successCount: committedCount,
    pendingLedgerCount,
    failedCount,
    conflictCount,
    message: safeResults.find((result) => result.message)?.message || '',
    fingerprintIndexWarning: safeResults.map((result) => result.fingerprintIndexWarning).filter(Boolean).join(' '),
    items
  };
}

function getPhotoWorkflowStatus(photo, { recognitionResult = null, requiredFieldsComplete } = {}) {
  if (!photo) return '暂无当前照片';
  if (photo.originalMissing) return '原图缺失';
  const status = photo.sortStatus || 'unassigned';
  if (status === 'archived' || photo.archiveResult?.status === '归档成功' || photo.archiveResult?.success === true) return '已归档';
  if (photo.archiveResult?.stage === 'ledger_pending') return '台账待补记';
  if (photo.archiveResult?.stage === 'target_conflict') return '目标冲突';
  if (status === 'ignored') return '已忽略';
  if (status === 'failed' || status === 'archive_failed' || photo.archiveResult?.status === '归档失败' || photo.archiveResult?.success === false) return '归档失败';
  if (status === 'previewed') return '已生成预览';
  if (status === 'assigned') return '待预览';
  if (status === 'recognition_failed') return '识别失败';
  if (status === 'recognizing') return '识别中';
  if (pendingSortStatuses.has(status)) return '待智拣';
  if (getRecognitionOutcome(recognitionResult) === 'manual_pending') return '待手工整理';
  if (pendingOrganizeStatuses.has(status)) {
    if (requiredFieldsComplete === false || (requiredFieldsComplete === undefined && ['recognition_empty', 'needs_completion'].includes(status))) return '待补充';
    return '待整理';
  }
  return statusLabels[status] || status;
}

function hasArchivedPhotoState(photo = {}) {
  return photo.sortStatus === 'archived'
    || photo.archiveResult?.status === '归档成功'
    || photo.archiveResult?.success === true;
}

function reconcileScannedPhotoStatuses(scanned = [], previousPhotos = [], archivedMatches = {}) {
  const previousArchivedByPath = new Map(
    previousPhotos
      .filter(hasArchivedPhotoState)
      .map((photo) => [normalizePhotoPathKey(photo.originalPath), photo])
      .filter(([key]) => Boolean(key))
  );

  return scanned.map((photo) => {
    const basePhoto = createScannedPhotoState(photo);
    const previous = previousArchivedByPath.get(normalizePhotoPathKey(basePhoto.originalPath));
    if (previous && isSameScannedFile(basePhoto, previous)) {
      return {
        ...basePhoto,
        sortStatus: 'archived',
        archiveInfo: previous.archiveInfo || null,
        previewInfo: previous.previewInfo || null,
        archiveResult: previous.archiveResult || null,
        archiveMethod: previous.archiveMethod || '照片分拣',
        archivedAt: previous.archivedAt || ''
      };
    }
    const ledgerRecord = archivedMatches[photo.id];
    return ledgerRecord ? buildArchivedScannedPhoto(basePhoto, ledgerRecord) : basePhoto;
  });
}

function createScannedPhotoState(photo = {}) {
  return {
    id: photo.id,
    originalPath: photo.path,
    originalName: photo.name,
    extension: photo.extension,
    size: photo.size,
    modifiedAt: photo.modifiedAt,
    thumbnailPath: photo.previewUrl,
    previewUrl: photo.previewUrl,
    selected: false,
    sortStatus: 'unassigned',
    archiveInfo: null,
    previewInfo: null,
    archiveResult: null,
    originalMissing: false
  };
}

function buildArchivedScannedPhoto(photo, record = {}) {
  const archiveInfo = {
    project: record.project || '',
    watermarkCategory: record.watermarkCategory || '',
    workContent: record.workContent || '',
    date: record.date || '',
    location: record.location || '',
    keywords: record.keywords || '',
    remark: record.remark || ''
  };
  const archiveResult = {
    id: photo.id,
    status: '归档成功',
    targetPath: record.archivePath || '',
    newFileName: record.newFileName || '',
    originalName: record.originalName || photo.originalName
  };
  return {
    ...photo,
    sortStatus: 'archived',
    archiveInfo,
    previewInfo: { ...archiveInfo, ...archiveResult },
    archiveResult,
    archiveMethod: '归档台账',
    archivedAt: record.archivedAt || ''
  };
}

function normalizePhotoPathKey(value = '') {
  return String(value || '').trim().replaceAll('/', '\\').toLocaleLowerCase('zh-CN');
}

function isSameScannedFile(nextPhoto, previousPhoto) {
  return Number(nextPhoto.size) === Number(previousPhoto.size)
    && String(nextPhoto.modifiedAt || '') === String(previousPhoto.modifiedAt || '');
}

function getFilterCount(key, photos, selectedIds) {
  if (key === 'all') return photos.length;
  if (key === 'unarchived') return photos.filter((photo) => !hasArchivedPhotoState(photo) && photo.sortStatus !== 'ignored').length;
  if (key === 'pending_sort') return photos.filter((photo) => pendingSortStatuses.has(photo.sortStatus)).length;
  if (key === 'pending_organize') return photos.filter((photo) => pendingOrganizeStatuses.has(photo.sortStatus)).length;
  if (key === 'selected') return photos.filter((photo) => selectedIds.includes(photo.id)).length;
  if (key === 'recognition_issue') return photos.filter((photo) => photo.sortStatus === 'recognition_failed').length;
  if (key === 'original_missing') return photos.filter((photo) => photo.originalMissing).length;
  if (key === 'failed') return photos.filter((photo) => ['failed', 'archive_failed'].includes(photo.sortStatus) && !photo.originalMissing).length;
  if (key === 'archived') return photos.filter(hasArchivedPhotoState).length;
  return photos.filter((photo) => photo.sortStatus === key).length;
}

function getSelectedStateText(selectedPhotos) {
  if (!selectedPhotos.length) return '请先在照片区选择照片';
  if (selectedPhotos.every((photo) => photo.sortStatus === 'ignored')) return '已忽略';
  if (selectedPhotos.some((photo) => photo.sortStatus === 'ignored')) return '包含已忽略照片';
  if (selectedPhotos.every((photo) => photo.sortStatus === 'archived')) return '已归档';
  if (selectedPhotos.some((photo) => photo.sortStatus === 'recognition_failed')) return '包含识别异常照片';
  if (selectedPhotos.some((photo) => photo.originalMissing)) return '包含原图缺失照片';
  if (selectedPhotos.some((photo) => ['failed', 'archive_failed'].includes(photo.sortStatus))) return '包含归档失败照片';
  if (selectedPhotos.some((photo) => photo.sortStatus === 'previewed')) return '已生成预览';
  if (selectedPhotos.some((photo) => photo.archiveInfo || photo.sortStatus === 'assigned')) return '待生成预览';
  return '尚未应用归档信息';
}

function buildGridPhotoSummary(photo) {
  if (photo.originalMissing) {
    return { main: '原图缺失', sub: '请重新定位照片文件夹', full: '原图缺失，请重新定位照片文件夹后再预览或归档。' };
  }
  if (photo.sortStatus === 'archived') {
    return {
      main: '已归档',
      sub: [photo.archiveMethod || '照片分拣', formatDateTime(photo.archivedAt)].filter(Boolean).join(' · '),
      full: [photo.archiveMethod || '照片分拣', photo.archiveResult?.targetPath].filter(Boolean).join(' / ')
    };
  }
  if (photo.sortStatus === 'failed') {
    return {
      main: '归档失败',
      sub: photo.archiveResult?.error || '请核对归档结果',
      full: photo.archiveResult?.error || '归档失败，请核对归档结果。'
    };
  }
  const info = photo.archiveInfo;
  if (!info) return null;
  const workContent = info.workContent || '待预览';
  const location = info.location || '现场';
  return {
    main: workContent,
    sub: location,
    full: [workContent, location].filter(Boolean).join(' / ')
  };
}

function findBestPhotoMatch(photo, candidates) {
  const originalName = getBaseName(photo.originalName || photo.originalPath);
  let index = candidates.findIndex((candidate) => candidate.name === originalName && Number(candidate.size) === Number(photo.size));
  if (index >= 0) return index;
  const originalTime = new Date(photo.modifiedAt).getTime();
  if (!Number.isNaN(originalTime)) {
    index = candidates.findIndex((candidate) => {
      if (candidate.name !== originalName) return false;
      const candidateTime = new Date(candidate.modifiedAt).getTime();
      return !Number.isNaN(candidateTime) && Math.abs(candidateTime - originalTime) <= 60 * 1000;
    });
    if (index >= 0) return index;
  }
  const sameName = candidates
    .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
    .filter(({ candidate }) => candidate.name === originalName);
  return sameName.length === 1 ? sameName[0].candidateIndex : -1;
}

function getBaseName(value) {
  return String(value || '').split(/[\\/]/).pop();
}

function formatDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function normalizePhotosForSmartSort(photos, recognitionMap = {}, suggestionMap = {}, watermarkMap = {}) {
  return photos.map((photo, index) => ({
    photoId: photo.id,
    filePath: photo.originalPath,
    fileName: photo.originalName,
    index,
    capturedAt: photo.capturedAt || null,
    modifiedAt: photo.modifiedAt || null,
    sortStatus: photo.sortStatus || '',
    archiveInfo: photo.archiveInfo || null,
    previewInfo: photo.previewInfo || null,
    archiveResult: photo.archiveResult || null,
    archiveSuggestion: suggestionMap[photo.id] || null,
    watermarkRecord: watermarkMap[photo.id] || null,
    recognition: recognitionMap[photo.id] || null
  }));
}

function toRecognitionPhoto(photo) {
  return {
    id: photo.id,
    photoId: photo.id,
    filePath: photo.originalPath,
    originalPath: photo.originalPath,
    fileName: photo.originalName,
    name: photo.originalName,
    size: photo.size,
    modifiedAt: photo.modifiedAt
  };
}

async function clearRecognitionPipelineForPhoto(photo) {
  const photoInput = toRecognitionPhoto(photo);
  await Promise.all([
    clearFormPatchDraftsByPhoto(photoInput),
    clearReviewDecisionsByPhoto(photoInput),
    clearReviewDraftsByPhoto(photoInput),
    clearCandidateFieldSetsByPhoto(photoInput),
    clearStagedResultsByPhoto(photoInput)
  ]);
}

function hasLocalOcrExecuted(result = {}) {
  const candidates = [
    result.engineResult,
    result.localResult?.engineResult,
    result.compareResults?.local?.engineResult
  ].filter(Boolean);
  return candidates.some((item) => item.ocrEngine === 'rapidocr' && item.source && item.source !== 'none');
}

function getRecognitionOutcome(result = null) {
  if (!result) return 'unrecognized';
  if (result.resolution) return 'resolved';
  if (result.manualPendingAt || result.handlingMode === 'manual') return 'manual_pending';
  if (result.status === 'recognized') return 'success';
  const rawText = String(result.rawText || result.adoptedOcrText || result.text || '').trim();
  if (result.status === 'success' && rawText) return hasValidWatermarkEvidence(result) ? 'success' : 'empty';
  if (result.status === 'empty' || (result.status === 'success' && !rawText)) return 'empty';
  if (recognitionFailureStatuses.has(result.status)) return 'failed';
  return 'pending';
}

function hasValidWatermarkEvidence(result = {}) {
  const text = String(result.rawText || result.adoptedOcrText || result.text || '').trim();
  if (!text) return false;
  const parsedWatermark = result.parsedWatermark || {};
  const parsedFields = result.parsedFields || {};
  const hasDate = Boolean(parsedWatermark.date || parsedFields.date);
  const hasTime = Boolean(parsedWatermark.time || parsedFields.time);
  const watermarkMarkers = [
    '物业公司',
    '小区名称',
    '防伪',
    '佳恒物业',
    'JIAHENG SERVICE',
    '天气',
    '星期',
    '工作内容',
    '违停类型'
  ];
  const normalizedText = text.toUpperCase();
  const markerCount = watermarkMarkers.filter((marker) => normalizedText.includes(marker.toUpperCase())).length;
  return (hasDate && hasTime) || (hasDate && markerCount >= 1) || (hasTime && markerCount >= 2) || markerCount >= 3;
}

function getRecognitionRecoveryIssue(result = null) {
  const outcome = getRecognitionOutcome(result);
  if (outcome !== 'failed') return null;
  return {
    outcome,
    statusLabel: '识别失败',
    title: '照片识别失败',
    message: result?.error || result?.errors?.[0]?.message || result?.warnings?.[0] || 'OCR 没有正常完成识别，请重新识别或查看后台记录。',
    primaryAction: '重新识别'
  };
}

function getPhotoRecognitionSortStatus(result, suggestion) {
  const outcome = getRecognitionOutcome(result);
  if (outcome === 'empty') return 'needs_completion';
  if (outcome === 'failed') return 'recognition_failed';
  return suggestion?.status === 'needs_completion' ? 'needs_completion' : 'suggestion_ready';
}

function summarizeRecognitionBatch(results = []) {
  return results.reduce((summary, result) => {
    const outcome = getRecognitionOutcome(result);
    const key = ['success', 'empty', 'failed'].includes(outcome) ? outcome : 'pending';
    summary[key] += 1;
    return summary;
  }, { success: 0, empty: 0, failed: 0, pending: 0 });
}

function getSmartSortResultStatusText(result) {
  if (!result) return '暂无分组';
  if (result.status === 'failed') return '生成失败';
  if (result.status === 'empty') return '暂无照片';
  if (result.status === 'cleared') return '已清除';
  if (result.groupCount > 0) return '已生成';
  return '暂无分组';
}

function getSmartSortGroupPhotoCount(group) {
  if (!group) return 0;
  const countKeys = ['photoCount', 'count', 'total'];
  for (const key of countKeys) {
    const explicitCount = Number(group[key]);
    if (Number.isFinite(explicitCount) && explicitCount >= 0) return explicitCount;
  }
  const collectionKeys = ['photos', 'photoIds', 'photoPaths', 'items', 'groupPhotos', 'photoList'];
  for (const key of collectionKeys) {
    if (Array.isArray(group[key])) return group[key].length;
  }
  return 0;
}

function getSmartSortGroupPhotoIds(group) {
  if (!group) return [];
  if (Array.isArray(group.photoIds)) return group.photoIds.map((value) => String(value || '').trim()).filter(Boolean);
  const photos = Array.isArray(group.photos) ? group.photos : [];
  const items = Array.isArray(group.items) ? group.items : [];
  const groupPhotos = Array.isArray(group.groupPhotos) ? group.groupPhotos : [];
  const photoList = Array.isArray(group.photoList) ? group.photoList : [];
  return [...photos, ...items, ...groupPhotos, ...photoList]
    .map((photo) => photo?.photoId || photo?.id)
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function getSmartSortGroupPhotoPaths(group) {
  if (!group) return [];
  const rawPaths = Array.isArray(group.photoPaths) ? group.photoPaths : [];
  const photos = Array.isArray(group.photos) ? group.photos : [];
  const items = Array.isArray(group.items) ? group.items : [];
  const groupPhotos = Array.isArray(group.groupPhotos) ? group.groupPhotos : [];
  const photoList = Array.isArray(group.photoList) ? group.photoList : [];
  const objectPaths = [...photos, ...items, ...groupPhotos, ...photoList]
    .map((photo) => photo?.filePath || photo?.originalPath || photo?.path)
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  return [...rawPaths.map((value) => String(value || '').trim()).filter(Boolean), ...objectPaths];
}

function getSmartSortGroupKeys(group) {
  return [...getSmartSortGroupPhotoIds(group), ...getSmartSortGroupPhotoPaths(group)].filter(Boolean);
}

function isSmartGroupBatchSelectable(photo) {
  return Boolean(photo)
    && !hasArchivedPhotoState(photo)
    && !isIgnoredPhoto(photo)
    && !photo.originalMissing
    && photo.sortStatus !== 'previewed';
}

function getVisiblePhotosSnapshot({
  photos = [],
  activeSmartGroupPhotoKeys = null,
  filter = 'all',
  searchText = '',
  selectedIds = [],
  sortMode = 'timeAsc'
}) {
  const keyword = searchText.trim().toLowerCase();
  return [...photos]
    .filter((photo) => {
      if (activeSmartGroupPhotoKeys) return activeSmartGroupPhotoKeys.has(photo.id) || activeSmartGroupPhotoKeys.has(photo.originalPath);
      if (filter === 'all') return true;
      if (filter === 'unarchived') return !hasArchivedPhotoState(photo) && photo.sortStatus !== 'ignored';
      if (filter === 'pending_sort') return pendingSortStatuses.has(photo.sortStatus);
      if (filter === 'pending_organize') return pendingOrganizeStatuses.has(photo.sortStatus);
      if (filter === 'selected') return selectedIds.includes(photo.id);
      if (filter === 'recognition_issue') return photo.sortStatus === 'recognition_failed';
      if (filter === 'original_missing') return photo.originalMissing;
      if (filter === 'failed') return ['failed', 'archive_failed'].includes(photo.sortStatus) && !photo.originalMissing;
      if (filter === 'ignored') return isIgnoredPhoto(photo);
      if (filter === 'archived') return hasArchivedPhotoState(photo);
      return photo.sortStatus === filter;
    })
    .filter((photo) => {
      if (!keyword) return true;
      return [photo.originalName, photo.archiveInfo?.remark, photo.archiveInfo?.workContent, photo.archiveInfo?.location, photo.archiveInfo?.keywords]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(keyword));
    })
    .sort((a, b) => {
      if (sortMode === 'nameAsc') return a.originalName.localeCompare(b.originalName, 'zh-CN');
      if (sortMode === 'nameDesc') return b.originalName.localeCompare(a.originalName, 'zh-CN');
      if (sortMode === 'timeDesc') return String(b.modifiedAt || '').localeCompare(String(a.modifiedAt || ''));
      return String(a.modifiedAt || '').localeCompare(String(b.modifiedAt || ''));
    });
}

function summarizeRecognitionResults(recognitionMap = {}) {
  const results = Object.values(recognitionMap || {});
  const summary = summarizeRecognitionBatch(results);
  const firstEngine = results.map((result) => result?.engineResult || result?.localResult?.engineResult || result?.compareResults?.local?.engineResult).find(Boolean) || {};
  return { total: results.length, ...summary, engine: firstEngine };
}

function buildSmartSortEngineText({ recognitionSummary, result, serviceStatus }) {
  const summary = recognitionSummary || {};
  const resultEngine = result?.engineResult || result?.localResult?.engineResult || result?.compareResults?.local?.engineResult || summary.engine || {};
  const localProvider = serviceStatus?.providers?.find((provider) => provider.providerId === 'local_ocr' || provider.id === 'local_ocr') || {};
  const diagnosedEngine = localProvider.available
    ? {
        ocrEngine: localProvider.engine || 'rapidocr',
        source: localProvider.source || '',
        componentVersion: localProvider.componentVersion || OCR_COMPONENT_VERSION
      }
    : {};
  const localEngine = resultEngine.source && resultEngine.source !== 'none' ? resultEngine : diagnosedEngine;
  const engineText = !serviceStatus
    ? '正在检测 OCR 引擎'
    : getRecognitionEngineSourceLabel(localEngine, result || {});
  const componentVersion = localEngine.componentVersion || localProvider.componentVersion || OCR_COMPONENT_VERSION;
  const versionText = localProvider.available || localEngine.source ? `（组件 ${componentVersion}）` : '';
  const statusText = summary.total > 0
    ? `OCR：成功 ${summary.success}、未检测到水印 ${summary.empty}、失败 ${summary.failed}、待确认 ${summary.pending}`
    : 'OCR：成功 0、未检测到水印 0、失败 0、待确认 0';
  return `${statusText}｜引擎：${engineText}${versionText}`;
}

function buildSmartSortBottomText({ result, viewMode, activeGroup, activeGroupName, activeGroupPhotoCount, filter, photos }) {
  if (viewMode === 'smartSortGroup' && activeGroup) {
    const basis = activeGroup.summary?.basisLabel || '智能分拣分组';
    return `智能分拣：当前查看 ${activeGroupName || activeGroup.title}｜${activeGroupPhotoCount} 张｜依据：${basis}`;
  }
  const filterLabel = statusLabels[filter] || statusFilters.find(([key]) => key === filter)?.[1] || '全部照片';
  if (!result?.groupCount) {
    return `扫描：${photos.length} 张｜分组：0 个｜智拣：暂无分组｜点击顶部“智拣”可辅助整理照片分组。`;
  }
  const totalPhotos = Number(result.photoCount);
  const photoSummary = Number.isFinite(totalPhotos) && totalPhotos > 0 ? `｜照片 ${totalPhotos || photos.length} 张` : '';
  return `扫描：${photos.length} 张${photoSummary}｜分组：${result.groupCount} 个｜智拣：已完成｜当前查看：状态筛选 - ${filterLabel}`;
}

function buildArchiveSuggestionContext({ configs, form, photoFolder, archiveRoot, photo }) {
  return {
    configs,
    currentProject: form.project,
    photoFolder,
    archiveRoot,
    photo
  };
}

function buildRecognitionSuggestion(result) {
  const parsed = result?.parsedWatermark || result?.parsedFields || {};
  const rawText = String(result?.rawText || result?.adoptedOcrText || '').trim();
  const applicable = [];
  const push = (key, label, value, options = {}) => {
    const normalized = String(value || '').trim();
    if (!normalized) return;
    applicable.push({
      key,
      label,
      value: options.value || normalized,
      displayValue: options.displayValue || normalized
    });
  };
  const normalizedDate = normalizeOcrDate(parsed.date || parsed.capturedAt || parsed.dateTime);
  push('date', '日期', normalizedDate, { displayValue: formatDisplayDate(normalizedDate) });
  if (parsed.time) {
    applicable.push({ key: 'time-display-only', label: '时间', value: String(parsed.time), displayValue: String(parsed.time) });
  }
  push('project', '项目', parsed.projectName || parsed.project);
  push('watermarkCategory', '归档分类', parsed.watermarkCategory || parsed.category);
  push('workContent', '工作内容', parsed.workContent);
  push('location', '位置/区域', parsed.location);
  if (Array.isArray(parsed.keywords) && parsed.keywords.length) push('keywords', '关键词', parsed.keywords.join('、'));
  push('remark', '备注', parsed.remark);
  const applicableDisplayFields = applicable;
  const applicableFormFields = applicable.filter((field) => field.key !== 'time-display-only');
  const presentKeys = new Set(applicableFormFields.map((field) => field.key));
  const missingFields = ['date', 'watermarkCategory', 'workContent']
    .filter((key) => !presentKeys.has(key))
    .map((key) => ({ date: '日期', watermarkCategory: '归档分类', workContent: '工作内容' }[key]));
  return {
    applicableDisplayFields,
    applicableFormFields,
    missingFields: rawText ? missingFields : [],
    conflictFields: [],
    sourceText: rawText ? '来源：OCR 水印识别' : '暂无 OCR 水印识别结果',
    description: rawText
      ? '已识别 OCR 文本，待人工确认字段。'
      : '请先选择照片并点击“智拣”。'
  };
}

function normalizeOcrDate(value = '') {
  const text = String(value || '').trim();
  const match = text.match(/(?<year>\d{4})[-/.年](?<month>\d{1,2})[-/.月](?<day>\d{1,2})/);
  if (!match?.groups) return '';
  return `${match.groups.year}-${match.groups.month.padStart(2, '0')}-${match.groups.day.padStart(2, '0')}`;
}

function formatDisplayDate(value = '') {
  return String(value || '').replaceAll('-', '/');
}

function getSafeMarkiImportMessage(result, fallback) {
  const message = typeof result?.error?.message === 'string' ? result.error.message.trim() : '';
  return message || fallback;
}

function normalizeCompareText(value) {
  return String(value || '').trim().replace(/\s+/g, '').toLowerCase();
}

function unique(values) {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
}

function groupColor(index) {
  return ['#2f80ed', '#f2994a', '#27ae60', '#eb5757', '#9b51e0', '#00a889', '#8f6b32'][index % 7];
}
