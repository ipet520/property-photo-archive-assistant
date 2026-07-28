import { useEffect, useMemo, useRef, useState } from 'react';
import MarkiRehydrateDialog from '../components/MarkiRehydrateDialog.jsx';
import ThumbnailHoverPreview from '../components/ThumbnailHoverPreview.jsx';
import {
  SMART_SORT_CONFIDENCE_LABELS,
  SMART_SORT_GROUP_STATUS_LABELS
} from '../constants/smartSort.js';
import { OCR_COMPONENT_VERSION, PAGE_KEYS } from '../constants/app.js';
import { formatFileSize, getSuggestedKeywords } from '../utils/formatters.js';
import { mergeMarkiWorkbenchImportPackage } from '../utils/markiWorkbenchImport.js';
import { recordRuntimeLog } from '../utils/runtimeLogger.js';
import { withRuntimeConfigFallback } from '../utils/runtimeConfig.js';
import {
  beginSmartSortExecution,
  buildSmartSortGroupMembershipByPhotoId,
  buildSourceAwareRecognitionNotice,
  buildSourceAwareSmartSortPresentation,
  completeSmartSortExecution,
  failSmartSortExecution,
  hasPhotoSmartSortResult,
  orchestrateSourceAwareRecognition,
  resetSelectedSmartSortResults
} from '../utils/sourceAwareRecognition.js';
import {
  getIgnoredRecognitionStageStatus,
  ignorePhotosInWorkspace,
  restoreIgnoredPhotosInWorkspace
} from '../utils/ignoredPhotoState.js';
import { mergeScannedLocalPhotoSubpool } from '../utils/unifiedPhotoPool.js';
import {
  buildRelinkedLocalPhoto,
  selectLocalPhotoRelinkCandidate
} from '../utils/photoRelink.js';
import {
  getVisibleWorkflowPhotos,
  getWorkflowFilterCount,
  getPhotoWorkflowStageLabel,
  hasArchivedPhotoState,
  isPhotoWorkflowActionable
} from '../utils/photoWorkflowStage.js';
import {
  buildMarkiRecoveryCompletionNotice,
  summarizeMarkiRecoveryCandidates
} from '../utils/markiRecoveryDialog.js';
import { prepareMarkiWorkspaceFileRepairs } from '../utils/markiImportLifecycle.js';
import {
  buildSortWorkspaceManualDraft,
  buildSortWorkspaceSnapshotWorkspace,
  createDebouncedSnapshotSaver,
  getEmptySortWorkspaceSnapshotWorkspace,
  persistLocalPhotoRelinks,
  persistMarkiWorkbenchImport,
  prepareWorkspaceAfterPhotoAppend,
  readSortWorkspaceManualDraft
} from '../utils/sortWorkspaceSnapshot.js';
import {
  buildArchiveFormSeed,
  buildArchiveSuggestion,
  buildBatchArchiveFormPatch,
  buildCurrentPhotoArchiveServiceForm,
  buildPerPhotoArchivePreviewInputs,
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
  buildGroupCanonical,
  buildSourceCanonical,
  resolveEffectivePhotoArchiveInfo
} from '../utils/photoCanonical.js';
import {
  applyActiveProjectToArchiveInfo,
  stripReadonlyProjectPatch,
  validatePhotosForActiveProject
} from '../utils/activeProjectContext.js';
import {
  migrateGroupDraftsByGroupKey,
  rebuildSmartSortResult
} from '../utils/smartGroupBuilder.js';
import {
  ENGINEERING_ARCHIVE_CATEGORY,
  getAvailableConstructionUnits,
  NOT_APPLICABLE_WORK_CONTENT,
  WATERMARK_TEMPLATE_TYPES
} from '../utils/watermarkTemplateAdapter.js';

const defaultForm = {
  watermarkTemplateType: WATERMARK_TEMPLATE_TYPES.UNRESOLVED,
  project: '',
  projectId: '',
  projectName: '',
  projectOriginalText: '',
  projectConfirmed: false,
  projectSource: '',
  archiveCategory: '',
  watermarkCategory: '',
  workContent: '',
  date: new Date().toISOString().slice(0, 10),
  location: '',
  locationArea: '',
  keywords: '',
  remark: '',
  remarks: '',
  propertyCompany: '',
  communityName: '',
  vehiclePlate: '',
  violationType: '',
  constructionUnitId: '',
  constructionUnitName: '',
  constructionUnitOriginalText: '',
  constructionUnitConfirmed: false,
  constructionUnitSource: '',
  fieldSources: {},
  unresolvedFields: []
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
const sortWorkspaceSessionCacheByProject = new Map();

function normalizeStatusFilter(filter) {
  return filter === 'assigned' ? 'unarchived' : (filter || 'all');
}

function restoreAutomaticSnapshotPhotos(snapshotPhotos) {
  return (Array.isArray(snapshotPhotos) ? snapshotPhotos : []).map((photo) => {
    const localPreviewUrl = photo.originalPath
      ? `local-photo://image/${encodeURIComponent(photo.originalPath)}`
      : '';
    return {
      ...photo,
      previewUrl: localPreviewUrl,
      thumbnailPath: localPreviewUrl
    };
  });
}

export default function SortWorkspacePage({ archiveState, onNavigate, navigationRequest }) {
  const activeProject = archiveState?.activeProject;
  const projectCacheKey = activeProject?.projectId || '';
  const rightPanelRef = useRef(null);
  const photoBrowserRef = useRef(null);
  const cachedSessionRef = useRef(sortWorkspaceSessionCacheByProject.get(projectCacheKey) || null);
  const sessionSnapshotRef = useRef(cachedSessionRef.current);
  const hasHydratedSessionRef = useRef(false);
  const recoveredArchiveRootsRef = useRef(new Set());
  const processedMarkiImportRequestNoncesRef = useRef(new Set());
  const pendingMarkiFocusPhotoIdRef = useRef('');
  const markiWorkbenchStateRef = useRef(null);
  const automaticSnapshotSaverRef = useRef(null);
  const isSortWorkspaceMountedRef = useRef(true);
  const moreMenuRef = useRef(null);
  const editedArchiveFormFieldsRef = useRef(new Set());
  if (!automaticSnapshotSaverRef.current) {
    automaticSnapshotSaverRef.current = createDebouncedSnapshotSaver({
      delayMs: 500,
      save: async (workspace) => {
        try {
          if (typeof window.archiveAssistant?.saveSortWorkspaceSnapshot !== 'function') {
            return {
              success: false,
              error: {
                code: 'sort_workspace_snapshot_unavailable',
                message: '工作台自动快照服务暂不可用。'
              }
            };
          }
          return await window.archiveAssistant.saveSortWorkspaceSnapshot(activeProject, workspace);
        } catch {
          return {
            success: false,
            error: {
              code: 'sort_workspace_snapshot_unavailable',
              message: '工作台自动快照服务暂不可用。'
            }
          };
        }
      }
    });
  }
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
  const [photoDraftByPhotoId, setPhotoDraftByPhotoId] = useState(() => cachedSession.photoDraftByPhotoId || {});
  const [groupDraftByGroupId, setGroupDraftByGroupId] = useState(() => cachedSession.groupDraftByGroupId || {});
  const [archivePreviewPlan, setArchivePreviewPlan] = useState(() => cachedSession.archivePreviewPlan || null);
  const [isRecognitionBusy, setIsRecognitionBusy] = useState(false);
  const [recognitionMessage, setRecognitionMessage] = useState(() => cachedSession.recognitionMessage || { type: 'idle', text: '' });
  const [recognitionProgress, setRecognitionProgress] = useState({ current: 0, total: 0 });
  const [recognitionServiceStatus, setRecognitionServiceStatus] = useState(null);
  const [rightPanelMode, setRightPanelMode] = useState(() => ['form', 'recognition'].includes(cachedSession.rightPanelMode) ? cachedSession.rightPanelMode : 'form');
  const [batchPreparationUndo, setBatchPreparationUndo] = useState(() => cachedSession.batchPreparationUndo || null);
  const [showMarkiRecovery, setShowMarkiRecovery] = useState(false);
  const [markiRecoveryCandidates, setMarkiRecoveryCandidates] = useState([]);
  const [selectedMarkiRecoveryTokens, setSelectedMarkiRecoveryTokens] = useState([]);
  const [isMarkiRecoveryBusy, setIsMarkiRecoveryBusy] = useState(false);
  const [markiRecoveryNotice, setMarkiRecoveryNotice] = useState({ type: 'idle', text: '' });

  markiWorkbenchStateRef.current = buildSortWorkspaceSnapshotWorkspace({
    activeProject,
    photoFolder,
    archiveRoot,
    photos,
    recognitionResultsByPhoto,
    watermarkRecordsByPhoto,
    archiveSuggestionsByPhoto,
    photoDraftByPhotoId,
    groupDraftByGroupId,
    archivePreviewPlan,
    selectedIds,
    activePhotoId,
    smartSortResult,
    smartSortViewMode,
    activeSmartSortGroupId,
    filter,
    sortMode,
    pageSize,
    rightPanelMode,
    form,
    searchText,
    page,
    viewMode
  });

  useEffect(() => {
    isSortWorkspaceMountedRef.current = true;
    return () => {
      isSortWorkspaceMountedRef.current = false;
      void automaticSnapshotSaverRef.current?.flush();
      automaticSnapshotSaverRef.current?.setEnabled(false);
    };
  }, []);

  async function loadActiveProjectSnapshot() {
    const loaded = await window.archiveAssistant.loadSortWorkspaceSnapshot(activeProject);
    if (loaded?.success !== true || loaded.found === true) return loaded;
    if (typeof window.archiveAssistant.inspectLegacySortWorkspaceSnapshot !== 'function') return loaded;
    const legacy = await window.archiveAssistant.inspectLegacySortWorkspaceSnapshot(activeProject);
    if (legacy?.success !== true || legacy.found !== true || legacy.canMigrate !== true) {
      if (legacy?.found && legacy?.error?.message) {
        setStatus({ type: 'warning', text: legacy.error.message });
      }
      return loaded;
    }
    const confirmed = window.confirm(
      `检测到升级前的旧工作台。\n是否将旧工作台归属到当前项目“${activeProject.projectName}”？`
    );
    if (!confirmed) return loaded;
    const migrated = await window.archiveAssistant.migrateLegacySortWorkspaceSnapshot(activeProject);
    if (migrated?.success !== true) return migrated;
    return window.archiveAssistant.loadSortWorkspaceSnapshot(activeProject);
  }

  useEffect(() => {
    const runtimeConfiguration = archiveState?.runtimeConfiguration;
    if (!runtimeConfiguration?.revision) return;
    setConfigs(withRuntimeConfigFallback(runtimeConfiguration.configs));
    setSettings(runtimeConfiguration.settings || {});
    setPhotoFolder(runtimeConfiguration.photoSourceDirectory || '');
    setArchiveRoot(runtimeConfiguration.archiveRootDirectory || '');
    setArchivePreviewPlan((current) => (
      current?.archiveRoot === runtimeConfiguration.archiveRootDirectory
        ? current
        : null
    ));
  }, [archiveState?.runtimeConfiguration?.revision]);

  useEffect(() => {
    Promise.all([
      window.archiveAssistant.loadRuntimeConfiguration()
        .then((value) => ({ success: true, value }))
        .catch(() => ({ success: false, value: null })),
      typeof window.archiveAssistant.loadSortWorkspaceSnapshot === 'function'
        ? loadActiveProjectSnapshot().catch(() => ({
            success: false,
            found: true,
            error: {
              code: 'sort_workspace_snapshot_load_failed',
              message: '工作台快照读取失败，已使用空工作台。'
            }
          }))
        : Promise.resolve({ success: true, found: false, snapshot: null })
    ]).then(([runtimeResult, snapshotResult]) => {
      const cachedSession = cachedSessionRef.current;
      const loadedRuntimeConfiguration = runtimeResult.value;
      const loadedConfigs = loadedRuntimeConfiguration?.configs;
      const loadedSettings = loadedRuntimeConfiguration?.settings;
      const safeConfigs = withRuntimeConfigFallback(loadedConfigs);
      const restoredPhotoFolder = loadedRuntimeConfiguration?.photoSourceDirectory || '';
      const restoredArchiveRoot = loadedRuntimeConfiguration?.archiveRootDirectory || '';
      const restoredFromSnapshot = !cachedSession && snapshotResult?.success === true && snapshotResult?.found === true;
      const restoredWorkspace = cachedSession || snapshotResult?.snapshot?.workspace || {};
      const restoredPhotos = restoredFromSnapshot
        ? restoreAutomaticSnapshotPhotos(restoredWorkspace.photos)
        : (Array.isArray(restoredWorkspace.photos) ? restoredWorkspace.photos : []);
      const restoredSelectedIds = Array.isArray(restoredWorkspace.selectedIds)
        ? restoredWorkspace.selectedIds.filter((id) => restoredPhotos.some((photo) => photo.id === id))
        : [];
      const restoredActivePhotoId = restoredPhotos.some((photo) => photo.id === restoredWorkspace.activePhotoId)
        ? restoredWorkspace.activePhotoId
        : restoredSelectedIds[0] || restoredPhotos[0]?.id || '';
      const restoredRecognitionMap = restoredWorkspace.recognitionResultsByPhoto || {};
      const restoredWatermarkMap = restoredWorkspace.watermarkRecordsByPhoto || {};
      const restoredSuggestionMap = restoredWorkspace.archiveSuggestionsByPhoto || {};
      const restoredPhotoDrafts = restoredWorkspace.photoDraftByPhotoId || {};
      const restoredSourceCanonicalMap = Object.fromEntries(restoredPhotos.map((photo) => [
        photo.id,
        buildSourceCanonical({
          photo,
          recognitionResult: restoredRecognitionMap[photo.id],
          watermarkRecord: restoredWatermarkMap[photo.id],
          sourceAwareProcessing: restoredRecognitionMap[photo.id]?.sourceAwareProcessing,
          configs: safeConfigs,
          activeProject
        })
      ]));
      const restoredEffectiveMap = Object.fromEntries(restoredPhotos.map((photo) => [
        photo.id,
        resolveEffectivePhotoArchiveInfo({
          photo,
          sourceCanonical: restoredSourceCanonicalMap[photo.id],
          sourceAwareProcessing: restoredRecognitionMap[photo.id]?.sourceAwareProcessing,
          photoDraft: restoredPhotoDrafts[photo.id],
          activeProject
        })
      ]));
      const restoredSmartSortResult = restoredWorkspace.smartSortResult
        ? rebuildSmartSortResult({
            photos: restoredPhotos,
            sourceCanonicalByPhotoId: restoredSourceCanonicalMap,
            effectiveArchiveInfoByPhotoId: restoredEffectiveMap,
            previousSmartSortResult: restoredWorkspace.smartSortResult
          })
        : null;
      const restoredGroupIds = new Set((restoredSmartSortResult?.groups || []).map((group) => group.id));
      const restoredGroupDrafts = migrateGroupDraftsByGroupKey(
        restoredWorkspace.smartSortResult,
        restoredSmartSortResult,
        restoredWorkspace.groupDraftByGroupId || {}
      );
      const restoredActiveGroupId = restoredGroupIds.has(restoredWorkspace.activeSmartSortGroupId)
        ? restoredWorkspace.activeSmartSortGroupId
        : restoredSmartSortResult?.groups?.[0]?.id || '';
      setConfigs(safeConfigs);
      setSettings(loadedSettings);
      setForm(reconcileForm(restoredWorkspace.form || defaultForm, safeConfigs, activeProject));
      window.sessionStorage.removeItem(sortSessionPhotoFolderKey);
      setPhotoFolder(restoredPhotoFolder);
      setArchiveRoot(restoredArchiveRoot);
      setPhotos(restoredPhotos);
      setRecognitionResultsByPhoto(restoredRecognitionMap);
      setWatermarkRecordsByPhoto(restoredWatermarkMap);
      setArchiveSuggestionsByPhoto(restoredSuggestionMap);
      setPhotoDraftByPhotoId(restoredPhotoDrafts);
      setGroupDraftByGroupId(restoredGroupDrafts);
      setArchivePreviewPlan(
        restoredWorkspace.archivePreviewPlan?.archiveRoot === restoredArchiveRoot
          ? restoredWorkspace.archivePreviewPlan
          : null
      );
      setSelectedIds(restoredSelectedIds);
      setActivePhotoId(restoredActivePhotoId);
      setFilter(normalizeStatusFilter(restoredWorkspace.filter));
      setSortMode(restoredWorkspace.sortMode || 'timeAsc');
      setPageSize([50, 100, 200].includes(Number(restoredWorkspace.pageSize)) ? Number(restoredWorkspace.pageSize) : 50);
      setRightPanelMode(['form', 'recognition'].includes(restoredWorkspace.rightPanelMode) ? restoredWorkspace.rightPanelMode : 'form');
      setSmartSortResult(restoredSmartSortResult);
      setSmartSortViewMode(restoredWorkspace.smartSortViewMode || 'statusFilter');
      setActiveSmartSortGroupId(restoredActiveGroupId);
      setSearchText(restoredWorkspace.searchText || '');
      setPage(Math.max(1, Number(restoredWorkspace.page) || 1));
      setViewMode(restoredWorkspace.viewMode || 'grid');
      if (restoredFromSnapshot) {
        const missingCount = restoredPhotos.filter((photo) => photo.originalMissing).length;
        setStatus({
          type: missingCount > 0 ? 'warning' : 'success',
          text: `已自动恢复工作台，共 ${restoredPhotos.length} 张照片。${missingCount > 0 ? `其中 ${missingCount} 张原图缺失，请核对。` : ''}`
        });
      } else if (!cachedSession && snapshotResult?.success === false) {
        setStatus({
          type: 'warning',
          text: snapshotResult?.error?.message || '工作台快照读取失败，已使用空工作台。'
        });
      } else if (!runtimeResult.success) {
        setStatus({ type: 'warning', text: '部分基础配置暂未加载，工作台已使用安全默认值。' });
      } else if (!cachedSession?.status && restoredPhotoFolder) {
        setStatus({ type: 'idle', text: '点击扫描读取当前照片目录。' });
      }
      hasHydratedSessionRef.current = true;
      automaticSnapshotSaverRef.current?.setEnabled(Boolean(cachedSession) || snapshotResult?.success === true);
      setIsSessionHydrated(true);
    }).catch(() => {
      const safeConfigs = withRuntimeConfigFallback(null);
      setConfigs(safeConfigs);
      setForm(reconcileForm(cachedSessionRef.current?.form || defaultForm, safeConfigs, activeProject));
      setStatus({ type: 'error', text: '配置或工作台状态加载失败，已使用安全默认值。' });
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
      const recovery = await window.archiveAssistant.recoverPendingArchiveTransactions();
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
      projectId: activeProject.projectId,
      projectName: activeProject.projectName,
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
      photoDraftByPhotoId,
      groupDraftByGroupId,
      archivePreviewPlan,
      recognitionMessage,
      rightPanelMode,
      batchPreparationUndo
    };
    sessionSnapshotRef.current = snapshot;
    sortWorkspaceSessionCacheByProject.set(projectCacheKey, snapshot);
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
    photoDraftByPhotoId,
    groupDraftByGroupId,
    archivePreviewPlan,
    recognitionMessage,
    rightPanelMode,
    batchPreparationUndo,
    isSessionHydrated
  ]);

  useEffect(() => () => {
    if (sessionSnapshotRef.current) {
      sortWorkspaceSessionCacheByProject.set(projectCacheKey, sessionSnapshotRef.current);
    }
  }, []);

  useEffect(() => archiveState?.registerProjectWorkspaceController?.({
    isBusy: () => Boolean(
      isBusy
      || isSmartSortBusy
      || isRecognitionBusy
      || isMarkiRecoveryBusy
    ),
    flush: async () => {
      const workspace = markiWorkbenchStateRef.current;
      if (!workspace) return { success: true };
      return saveAutomaticSnapshotImmediately(workspace);
    },
    clear: () => {
      sortWorkspaceSessionCacheByProject.delete(projectCacheKey);
      sessionSnapshotRef.current = null;
      markiWorkbenchStateRef.current = null;
    }
  }), [
    archiveState?.registerProjectWorkspaceController,
    isBusy,
    isMarkiRecoveryBusy,
    isRecognitionBusy,
    isSmartSortBusy,
    projectCacheKey
  ]);

  useEffect(() => {
    if (!isSessionHydrated || !hasHydratedSessionRef.current) return;
    automaticSnapshotSaverRef.current?.schedule(buildSortWorkspaceSnapshotWorkspace({
      activeProject,
      photoFolder,
      archiveRoot,
      photos,
      selectedIds,
      activePhotoId,
      recognitionResultsByPhoto,
      watermarkRecordsByPhoto,
      archiveSuggestionsByPhoto,
      photoDraftByPhotoId,
      groupDraftByGroupId,
      archivePreviewPlan,
      smartSortResult,
      smartSortViewMode,
      activeSmartSortGroupId,
      filter,
      sortMode,
      pageSize,
      rightPanelMode,
      form,
      searchText,
      page,
      viewMode
    }));
  }, [
    photoFolder,
    archiveRoot,
    photos,
    selectedIds,
    activePhotoId,
    recognitionResultsByPhoto,
    watermarkRecordsByPhoto,
    archiveSuggestionsByPhoto,
    photoDraftByPhotoId,
    groupDraftByGroupId,
    archivePreviewPlan,
    smartSortResult,
    smartSortViewMode,
    activeSmartSortGroupId,
    filter,
    sortMode,
    pageSize,
    rightPanelMode,
    form,
    searchText,
    page,
    viewMode,
    isSessionHydrated
  ]);

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
  const sourceCanonicalByPhotoId = useMemo(() => Object.fromEntries(photos.map((photo) => [
    photo.id,
    buildSourceCanonical({
      photo,
      recognitionResult: recognitionResultsByPhoto[photo.id],
      watermarkRecord: watermarkRecordsByPhoto[photo.id],
      sourceAwareProcessing: recognitionResultsByPhoto[photo.id]?.sourceAwareProcessing,
      configs: configs || {},
      activeProject
    })
  ])), [activeProject, photos, recognitionResultsByPhoto, watermarkRecordsByPhoto, configs]);
  const effectiveArchiveInfoByPhotoId = useMemo(() => Object.fromEntries(photos.map((photo) => [
    photo.id,
    resolveEffectivePhotoArchiveInfo({
      photo,
      sourceCanonical: sourceCanonicalByPhotoId[photo.id],
      sourceAwareProcessing: recognitionResultsByPhoto[photo.id]?.sourceAwareProcessing,
      photoDraft: photoDraftByPhotoId[photo.id],
      activeProject
    })
  ])), [activeProject, photos, recognitionResultsByPhoto, sourceCanonicalByPhotoId, photoDraftByPhotoId]);
  const smartSortGroupMembershipByPhotoId = useMemo(
    () => buildSmartSortGroupMembershipByPhotoId(smartSortResult),
    [smartSortResult]
  );
  const smartSortGroupPhotoIds = useMemo(
    () => new Set(smartSortGroupMembershipByPhotoId.keys()),
    [smartSortGroupMembershipByPhotoId]
  );
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
    return getVisibleWorkflowPhotos({
      photos,
      activeSmartGroupPhotoKeys,
      groupMembershipByPhotoId: smartSortGroupMembershipByPhotoId,
      filter,
      searchText,
      selectedIds,
      sortMode
    });
  }, [photos, activeSmartGroupPhotoKeys, smartSortGroupMembershipByPhotoId, filter, searchText, selectedIds, sortMode]);

  const totalPages = Math.max(1, Math.ceil(visiblePhotos.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pagePhotos = visiblePhotos.slice((safePage - 1) * pageSize, safePage * pageSize);
  const selectedPhotos = photos.filter((photo) => selectedIds.includes(photo.id));
  const activePhoto = pagePhotos.find((photo) => photo.id === activePhotoId) || null;
  const selectedPagePhoto = pagePhotos.find((photo) => selectedIds.includes(photo.id)) || null;
  const primaryPhoto = activePhoto || selectedPagePhoto || pagePhotos[0] || null;
  const assignedCount = photos.filter((photo) => photo.sortStatus === 'assigned').length;
  const previewPhotos = photos.filter((photo) => photo.sortStatus === 'previewed' && photo.previewInfo);
  const pendingCount = getWorkflowFilterCount(
    'pending_sort',
    photos,
    [],
    smartSortGroupMembershipByPhotoId
  );
  const ignoredCount = photos.filter((photo) => photo.sortStatus === 'ignored').length;
  const missingOriginalCount = photos.filter((photo) => photo.originalMissing).length;
  const editingPhoto = photos.find((photo) => photo.id === editingPhotoId) || null;
  const effectivePhotoFolder = photoFolder;
  const selectedStateText = getSelectedStateText(selectedPhotos);
  const selectedHasIgnored = selectedPhotos.some(isIgnoredPhoto);
  const selectedEditablePhotos = selectedPhotos.filter((photo) => (
    isPhotoWorkflowActionable(photo, smartSortGroupPhotoIds.has(photo.id))
  ));
  const selectedIgnorableCount = selectedPhotos.filter((photo) => (
    !isArchivedPhoto(photo)
    && !isIgnoredPhoto(photo)
    && !photo.originalMissing
    && photo.sortStatus !== 'archiving'
  )).length;
  const selectedSmartResultCount = selectedEditablePhotos.filter((photo) => (
    hasPhotoSmartSortResult(photo, smartSortGroupPhotoIds.has(photo.id))
  )).length;
  const smartSortActionLabel = selectedSmartResultCount > 0 ? '重新智拣' : '智拣';
  const smartSortActionTitle = selectedSmartResultCount > 0
    ? '重新评估已选照片，复用可信平台数据和已有补充，并重新生成智能分组。'
    : '按照片来源处理已选照片，并生成智能分组。';
  const selectedIgnoredCount = selectedPhotos.filter(isIgnoredPhoto).length;
  const selectedSuggestionReadyCount = selectedEditablePhotos.filter((photo) => {
    const suggestion = archiveSuggestionsByPhoto[photo.id];
    return suggestion?.suggestedFields && validateRequiredArchiveFields(
      suggestion.suggestedFields,
      configs,
      activeProject
    ).length === 0;
  }).length;
  const currentPanelPhoto = primaryPhoto;
  const currentPanelSmartGroup = currentPanelPhoto
    ? smartSortGroups.find((group) => (
        getSmartSortGroupPhotoIds(group).includes(currentPanelPhoto.id)
      )) || null
    : null;
  const currentPanelGroupCanonical = useMemo(() => buildGroupCanonical(
    (currentPanelSmartGroup ? getSmartSortGroupPhotoIds(currentPanelSmartGroup) : [])
      .map((photoId) => ({
        photoId,
        effectiveInfo: effectiveArchiveInfoByPhotoId[photoId]
      }))
  ), [currentPanelSmartGroup, effectiveArchiveInfoByPhotoId]);
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
  const currentMissingRequiredFields = validateRequiredArchiveFields(form, configs, activeProject);
  const currentRequiredFieldsComplete = currentMissingRequiredFields.length === 0;
  const currentTemplateType = form.watermarkTemplateType;
  const currentIsTimeLocation = currentTemplateType === WATERMARK_TEMPLATE_TYPES.TIME_LOCATION;
  const currentIsVehicleViolation = currentTemplateType === WATERMARK_TEMPLATE_TYPES.VEHICLE_VIOLATION;
  const currentIsEngineering = currentTemplateType === WATERMARK_TEMPLATE_TYPES.STANDARD_WORK_RECORD
    && form.watermarkCategory === ENGINEERING_ARCHIVE_CATEGORY;
  const safeRuntimeConfigs = configs || {};
  const currentConstructionUnits = getAvailableConstructionUnits(
    safeRuntimeConfigs,
    form.projectId,
    form.constructionUnitId
  );
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
    requiredFieldsComplete: currentRequiredFieldsComplete,
    smartSortGroupMember: smartSortGroupPhotoIds.has(currentPanelPhoto?.id)
  });
  const recognitionSummary = useMemo(() => summarizeRecognitionResults(recognitionResultsByPhoto), [recognitionResultsByPhoto]);
  const batchActionsBusy = isBusy || isRecognitionBusy || isSmartSortBusy || isMarkiRecoveryBusy;
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
        batchResult = await markiApi.getImportBatch(batchId, activeProject);
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

      let transactionResult;
      const repairPreparation = prepareMarkiWorkspaceFileRepairs(
        markiWorkbenchStateRef.current,
        batchResult.workbenchImportPackage
      );
      try {
        transactionResult = await persistMarkiWorkbenchImport({
          currentWorkspace: repairPreparation.workspace,
          workbenchImportPackage: batchResult.workbenchImportPackage,
          mergeWorkbenchImport: (workspace, importPackage) => (
            mergeMarkiWorkbenchImportPackage(workspace, importPackage, { activeProject })
          ),
          prepareWorkspace: ({ merged, workspace }) => (
            prepareWorkspaceAfterPhotoAppend({
              workspace,
              addedPhotoIds: merged.addedPhotoIds,
              repairedPhotoIds: repairPreparation.repairedPhotoIds
            })
          ),
          saveSnapshot: (workspace) => saveAutomaticSnapshotImmediately(workspace),
          consumeBatch: () => markiApi.consumeImportBatch(batchId, activeProject),
          commitWorkspace: (merged, workspace) => {
            if (!isSortWorkspaceMountedRef.current) return;
            markiWorkbenchStateRef.current = workspace;
            const nextSession = {
              ...(sessionSnapshotRef.current || {}),
              ...workspace,
              hasUnsavedChanges: merged.stats.addedCount > 0 || repairPreparation.repairedCount > 0
                ? true
                : Boolean(sessionSnapshotRef.current?.hasUnsavedChanges)
            };
            sessionSnapshotRef.current = nextSession;
            sortWorkspaceSessionCacheByProject.set(projectCacheKey, nextSession);
            if (
              merged.stats.addedCount > 0
              && workspace.smartSortViewMode !== 'smartSortGroup'
            ) {
              pendingMarkiFocusPhotoIdRef.current = merged.addedPhotoIds[0];
            }
            setPhotos(workspace.photos);
            setRecognitionResultsByPhoto(workspace.recognitionResultsByPhoto);
            setWatermarkRecordsByPhoto(workspace.watermarkRecordsByPhoto);
            setArchiveSuggestionsByPhoto(workspace.archiveSuggestionsByPhoto);
            setPhotoDraftByPhotoId(workspace.photoDraftByPhotoId || {});
            setGroupDraftByGroupId(workspace.groupDraftByGroupId || {});
            setArchivePreviewPlan(workspace.archivePreviewPlan || null);
            setSelectedIds(workspace.selectedIds);
            setActivePhotoId(workspace.activePhotoId);
            setFilter(workspace.filter);
            setSearchText(workspace.searchText);
            setSmartSortViewMode(workspace.smartSortViewMode);
            setActiveSmartSortGroupId(workspace.activeSmartSortGroupId);
            if (merged.stats.addedCount > 0 || repairPreparation.repairedCount > 0) {
              setHasUnsavedChanges(true);
            }
          }
        });
      } catch {
        setStatus({ type: 'error', text: '马克工作台导入包校验失败，未修改当前工作台。' });
        return;
      }
      if (!isSortWorkspaceMountedRef.current) return;
      if (transactionResult.stage === 'snapshot') {
        setStatus({
          type: 'error',
          text: '马克照片尚未加入工作台：自动快照保存失败，导入批次仍可重试。'
        });
        return;
      }
      if (transactionResult.consumeResult?.success !== true) {
        setStatus({
          type: 'warning',
          text: '照片已追加，但批次消费状态未更新；再次处理时会按 sourceKey 自动去重。'
        });
        return;
      }

      const merged = transactionResult.merged;
      const { addedCount, duplicateCount, conflictCount } = merged.stats;
      if (repairPreparation.repairedCount > 0 && addedCount === 0 && conflictCount === 0) {
        setStatus({
          type: 'success',
          text: `已修复 ${repairPreparation.repairedCount} 张马克照片文件；照片编号、识别结果和人工草稿保持不变。`
        });
        return;
      }
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
      setForm(reconcileForm(defaultForm, configs, activeProject));
      setRightPanelMode('form');
      return;
    }
    setForm(buildArchiveFormSeed({
      photo: currentPanelPhoto,
      recognitionResult: recognitionResultsByPhoto[currentPanelPhoto.id],
      watermarkRecord: watermarkRecordsByPhoto[currentPanelPhoto.id],
      archiveSuggestion: archiveSuggestionsByPhoto[currentPanelPhoto.id],
      group: currentPanelSmartGroup,
      groupCanonical: currentPanelGroupCanonical,
      sourceCanonical: sourceCanonicalByPhotoId[currentPanelPhoto.id],
      groupDraft: currentPanelSmartGroup
        ? groupDraftByGroupId[currentPanelSmartGroup.id]
        : null,
      photoDraft: photoDraftByPhotoId[currentPanelPhoto.id],
      configs,
      activeProject
    }));
  }, [
    currentPanelPhoto,
    currentPanelSmartGroup,
    currentPanelGroupCanonical,
    configs,
    recognitionResultsByPhoto,
    watermarkRecordsByPhoto,
    archiveSuggestionsByPhoto,
    sourceCanonicalByPhotoId,
    groupDraftByGroupId,
    photoDraftByPhotoId,
    activeProject
  ]);

  useEffect(() => {
    editedArchiveFormFieldsRef.current.clear();
  }, [currentPanelPhoto?.id, currentPanelSmartGroup?.id]);

  useEffect(() => {
    rightPanelRef.current?.scrollTo({ top: 0 });
  }, []);

  function markChanged() {
    setHasUnsavedChanges(true);
  }

  async function saveAutomaticSnapshotImmediately(workspace) {
    const result = await automaticSnapshotSaverRef.current.flush(workspace);
    if (result?.success === true) {
      automaticSnapshotSaverRef.current.setEnabled(true);
    }
    return result;
  }

  function applyAutomaticSnapshotWorkspace(workspace) {
    const restoredPhotos = restoreAutomaticSnapshotPhotos(workspace?.photos);
    const restoredPhotoIds = new Set(restoredPhotos.map((photo) => photo.id));
    const restoredSelectedIds = Array.isArray(workspace?.selectedIds)
      ? workspace.selectedIds.filter((photoId) => restoredPhotoIds.has(photoId))
      : [];
    const restoredActivePhotoId = restoredPhotoIds.has(workspace?.activePhotoId)
      ? workspace.activePhotoId
      : restoredSelectedIds[0] || restoredPhotos[0]?.id || '';
    const restoredRecognitionMap = workspace?.recognitionResultsByPhoto || {};
    const restoredWatermarkMap = workspace?.watermarkRecordsByPhoto || {};
    const restoredPhotoDrafts = workspace?.photoDraftByPhotoId || {};
    const restoredSourceCanonicalMap = Object.fromEntries(restoredPhotos.map((photo) => [
      photo.id,
      buildSourceCanonical({
        photo,
        recognitionResult: restoredRecognitionMap[photo.id],
        watermarkRecord: restoredWatermarkMap[photo.id],
        sourceAwareProcessing: restoredRecognitionMap[photo.id]?.sourceAwareProcessing,
        configs: configs || {},
        activeProject
      })
    ]));
    const restoredEffectiveMap = Object.fromEntries(restoredPhotos.map((photo) => [
      photo.id,
      resolveEffectivePhotoArchiveInfo({
        photo,
        sourceCanonical: restoredSourceCanonicalMap[photo.id],
        sourceAwareProcessing: restoredRecognitionMap[photo.id]?.sourceAwareProcessing,
        photoDraft: restoredPhotoDrafts[photo.id],
        activeProject
      })
    ]));
    const restoredSmartSortResult = workspace?.smartSortResult
      ? rebuildSmartSortResult({
          photos: restoredPhotos,
          sourceCanonicalByPhotoId: restoredSourceCanonicalMap,
          effectiveArchiveInfoByPhotoId: restoredEffectiveMap,
          previousSmartSortResult: workspace.smartSortResult
        })
      : null;
    const restoredGroupIds = new Set((restoredSmartSortResult?.groups || []).map((group) => group.id));
    const restoredGroupDrafts = migrateGroupDraftsByGroupKey(
      workspace?.smartSortResult,
      restoredSmartSortResult,
      workspace?.groupDraftByGroupId || {}
    );
    const restoredWorkspace = {
      ...workspace,
      photos: restoredPhotos,
      selectedIds: restoredSelectedIds,
      activePhotoId: restoredActivePhotoId,
      smartSortResult: restoredSmartSortResult,
      groupDraftByGroupId: restoredGroupDrafts,
      activeSmartSortGroupId: restoredGroupIds.has(workspace?.activeSmartSortGroupId)
        ? workspace.activeSmartSortGroupId
        : restoredSmartSortResult?.groups?.[0]?.id || ''
    };
    markiWorkbenchStateRef.current = restoredWorkspace;
    const nextSession = {
      ...(sessionSnapshotRef.current || {}),
      ...restoredWorkspace,
      hasUnsavedChanges: true
    };
    sessionSnapshotRef.current = nextSession;
    sortWorkspaceSessionCacheByProject.set(projectCacheKey, nextSession);
    if (restoredActivePhotoId) pendingMarkiFocusPhotoIdRef.current = restoredActivePhotoId;
    setPhotos(restoredPhotos);
    setRecognitionResultsByPhoto(restoredWorkspace.recognitionResultsByPhoto || {});
    setWatermarkRecordsByPhoto(restoredWorkspace.watermarkRecordsByPhoto || {});
    setArchiveSuggestionsByPhoto(restoredWorkspace.archiveSuggestionsByPhoto || {});
    setPhotoDraftByPhotoId(restoredWorkspace.photoDraftByPhotoId || {});
    setGroupDraftByGroupId(restoredWorkspace.groupDraftByGroupId || {});
    setArchivePreviewPlan(
      restoredWorkspace.archivePreviewPlan?.archiveRoot === archiveRoot
        ? restoredWorkspace.archivePreviewPlan
        : null
    );
    setSelectedIds(restoredSelectedIds);
    setActivePhotoId(restoredActivePhotoId);
    setFilter(normalizeStatusFilter(restoredWorkspace.filter));
    setSearchText(restoredWorkspace.searchText || '');
    setSmartSortResult(restoredWorkspace.smartSortResult || null);
    setSmartSortViewMode(restoredWorkspace.smartSortViewMode || 'statusFilter');
    setActiveSmartSortGroupId(restoredWorkspace.activeSmartSortGroupId || '');
    setSortMode(restoredWorkspace.sortMode || 'timeAsc');
    setPageSize([50, 100, 200].includes(Number(restoredWorkspace.pageSize))
      ? Number(restoredWorkspace.pageSize)
      : 50);
    setRightPanelMode(['form', 'recognition'].includes(restoredWorkspace.rightPanelMode)
      ? restoredWorkspace.rightPanelMode
      : 'form');
    setForm(reconcileForm(restoredWorkspace.form || defaultForm, configs, activeProject));
    setViewMode(restoredWorkspace.viewMode || 'grid');
    setPage(Math.max(1, Number(restoredWorkspace.page) || 1));
    setHasUnsavedChanges(true);
  }

  async function scanDownloadedMarkiPhotos() {
    if (isMarkiRecoveryBusy) return;
    setIsMarkiRecoveryBusy(true);
    setShowMarkiRecovery(true);
    setMarkiRecoveryNotice({ type: 'idle', text: '正在核对本机已下载照片...' });
    setStatus({ type: 'idle', text: '正在核对已下载的马克照片...' });
    try {
      const snapshotResult = await saveAutomaticSnapshotImmediately(
        markiWorkbenchStateRef.current
      );
      if (snapshotResult?.success !== true) {
        setStatus({
          type: 'error',
          text: '当前工作台快照保存失败，已停止扫描以避免重复照片。'
        });
        setMarkiRecoveryNotice({
          type: 'error',
          text: '当前工作台快照保存失败，已停止核对以避免重复照片。'
        });
        return;
      }
      const markiApi = window.archiveAssistant?.marki;
      if (typeof markiApi?.scanWorkbenchRecoveryCandidates !== 'function') {
        setStatus({ type: 'error', text: '马克照片恢复服务暂不可用，请重新打开软件后再试。' });
        setMarkiRecoveryNotice({
          type: 'error',
          text: 'Marki 照片恢复服务暂不可用，请重新打开软件后再试。'
        });
        return;
      }
      const result = await markiApi.scanWorkbenchRecoveryCandidates(activeProject);
      if (result?.success !== true) {
        setMarkiRecoveryCandidates([]);
        setSelectedMarkiRecoveryTokens([]);
        setStatus({
          type: 'error',
          text: result?.error?.message || '已下载马克照片扫描失败，请重试。'
        });
        setMarkiRecoveryNotice({
          type: 'error',
          text: result?.error?.message || '已下载 Marki 照片核对失败，请重试。'
        });
        return;
      }
      const items = Array.isArray(result.items) ? result.items : [];
      const summary = summarizeMarkiRecoveryCandidates(items);
      const recoverableCount = summary.recoverable;
      const abnormalCount = summary.missingFile + summary.abnormal;
      setMarkiRecoveryCandidates(items);
      setSelectedMarkiRecoveryTokens([]);
      setMarkiRecoveryNotice({
        type: abnormalCount > 0 ? 'warning' : 'success',
        text: recoverableCount > 0
          ? `发现 ${recoverableCount} 张可恢复照片${abnormalCount > 0 ? `，另有 ${abnormalCount} 项异常` : ''}。`
          : `当前没有可恢复照片${abnormalCount > 0 ? `，检测到 ${abnormalCount} 项异常` : ''}。`
      });
      setStatus({
        type: abnormalCount > 0 ? 'warning' : 'success',
        text: recoverableCount > 0
          ? `发现 ${recoverableCount} 张已下载但不在工作台的马克照片${abnormalCount > 0 ? `，另有 ${abnormalCount} 项异常需核对` : ''}。`
          : `没有发现可恢复的马克照片${abnormalCount > 0 ? `；检测到 ${abnormalCount} 项异常来源资料` : ''}。`
      });
    } catch {
      setMarkiRecoveryNotice({ type: 'error', text: '已下载 Marki 照片核对失败，请重试。' });
      setStatus({ type: 'error', text: '已下载马克照片扫描失败，请重试。' });
    } finally {
      setIsMarkiRecoveryBusy(false);
    }
  }

  function openMarkiRecoveryDialog() {
    if (moreMenuRef.current) moreMenuRef.current.open = false;
    if (showMarkiRecovery) return;
    setShowMarkiRecovery(true);
    setMarkiRecoveryNotice({ type: 'idle', text: '正在核对本机已下载照片...' });
    void scanDownloadedMarkiPhotos();
  }

  function closeMarkiRecoveryDialog() {
    if (isMarkiRecoveryBusy) return;
    setShowMarkiRecovery(false);
  }

  function toggleMarkiRecoverySelection(recoveryToken) {
    setSelectedMarkiRecoveryTokens((current) => (
      current.includes(recoveryToken)
        ? current.filter((token) => token !== recoveryToken)
        : [...current, recoveryToken]
    ));
  }

  async function recoverDownloadedMarkiPhotos(recoveryTokens = selectedMarkiRecoveryTokens) {
    const safeRecoveryTokens = Array.from(new Set(
      (Array.isArray(recoveryTokens) ? recoveryTokens : [])
        .map((token) => String(token || '').trim())
        .filter(Boolean)
    ));
    if (isMarkiRecoveryBusy || safeRecoveryTokens.length === 0) return;
    setIsMarkiRecoveryBusy(true);
    setMarkiRecoveryNotice({ type: 'idle', text: '正在恢复选中的 Marki 照片...' });
    setStatus({ type: 'idle', text: '正在恢复已下载的马克照片...' });
    try {
      const markiApi = window.archiveAssistant?.marki;
      const result = await markiApi?.recoverWorkbenchCandidates?.({
        recoveryTokens: safeRecoveryTokens,
        activeProject
      });
      if (result?.success !== true) {
        setMarkiRecoveryNotice({
          type: 'error',
          text: result?.error?.message || '恢复已下载 Marki 照片失败，请重试。'
        });
        setStatus({
          type: 'error',
          text: result?.error?.message || '恢复已下载马克照片失败，请重试。'
        });
        return;
      }
      if (result.status === 'nothing_to_recover') {
        const recoveredTokens = new Set(safeRecoveryTokens);
        setMarkiRecoveryCandidates((current) => current.map((item) => (
          recoveredTokens.has(item.recoveryToken)
            ? { ...item, status: 'already_in_workbench' }
            : item
        )));
        setSelectedMarkiRecoveryTokens([]);
        setMarkiRecoveryNotice({ type: 'success', text: '所选照片已在当前工作台中，未重复恢复。' });
        setStatus({ type: 'success', text: '所选马克照片已在当前工作台中，未重复恢复。' });
        return;
      }
      const snapshotResult = await window.archiveAssistant.loadSortWorkspaceSnapshot(activeProject);
      if (
        snapshotResult?.success !== true
        || snapshotResult?.found !== true
        || !snapshotResult.snapshot?.workspace
      ) {
        setStatus({
          type: 'warning',
          text: '马克照片已写入自动快照，但界面刷新失败；重新进入工作台即可恢复。'
        });
        setMarkiRecoveryNotice({
          type: 'warning',
          text: '照片已写入自动快照，但界面刷新失败；重新进入工作台即可恢复。'
        });
        return;
      }
      applyAutomaticSnapshotWorkspace(snapshotResult.snapshot.workspace);
      const recoveredTokens = new Set(safeRecoveryTokens);
      setMarkiRecoveryCandidates((current) => current.map((item) => (
        recoveredTokens.has(item.recoveryToken)
          ? { ...item, status: 'already_in_workbench' }
          : item
      )));
      setSelectedMarkiRecoveryTokens([]);
      const completionNotice = buildMarkiRecoveryCompletionNotice(result);
      setMarkiRecoveryNotice({
        type: Number(result.conflictCount) > 0 ? 'warning' : 'success',
        text: completionNotice
      });
      setStatus({
        type: Number(result.conflictCount) > 0 ? 'warning' : 'success',
        text: completionNotice
      });
    } catch {
      setMarkiRecoveryNotice({ type: 'error', text: '恢复已下载 Marki 照片失败，请重试。' });
      setStatus({ type: 'error', text: '恢复已下载马克照片失败，请重试。' });
    } finally {
      setIsMarkiRecoveryBusy(false);
    }
  }

  // Only source-state mutations invalidate the one-step batch undo snapshot.
  function invalidateBatchPreparationUndo() {
    setBatchPreparationUndo(null);
  }

  async function synchronizePhotoFolderFromSettings() {
    try {
      const runtimeConfiguration = await window.archiveAssistant.loadRuntimeConfiguration();
      setSettings(runtimeConfiguration.settings || {});
      setConfigs(withRuntimeConfigFallback(runtimeConfiguration.configs));
      setPhotoFolder(runtimeConfiguration.photoSourceDirectory || '');
      setArchiveRoot(runtimeConfiguration.archiveRootDirectory || '');
      setArchivePreviewPlan((current) => (
        current?.archiveRoot === runtimeConfiguration.archiveRootDirectory
          ? current
          : null
      ));
      return runtimeConfiguration.photoSourceDirectory || '';
    } catch {
      // Keep the current directory when settings cannot be refreshed.
      return photoFolder;
    }
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
      photoDraftByPhotoId,
      groupDraftByGroupId,
      archivePreviewPlan,
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
        setPhotoDraftByPhotoId(snapshot.photoDraftByPhotoId || {});
        setGroupDraftByGroupId(snapshot.groupDraftByGroupId || {});
        setArchivePreviewPlan(snapshot.archivePreviewPlan || null);
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
      setPhotoDraftByPhotoId((current) => restoreSnapshotEntries(current, snapshot.photoDraftByPhotoId || {}, restoredIdSet));
      setRecognitionResultsByPhoto((current) => restoreSnapshotEntries(current, snapshot.recognitionResultsByPhoto || {}, restoredIdSet));
      setArchivePreviewPlan(null);
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

  function blockProjectMismatch(targetPhotos, operationLabel) {
    const validation = validatePhotosForActiveProject(targetPhotos, activeProject);
    if (validation.valid) return false;
    setStatus({
      type: 'error',
      text: `${operationLabel}已停止（${validation.code}）：${validation.message}`
    });
    return true;
  }

  function updateForm(patch, options = {}) {
    const readonlyResult = stripReadonlyProjectPatch(patch);
    if (readonlyResult.warning) {
      setStatus({ type: 'warning', text: readonlyResult.warning.message });
    }
    patch = readonlyResult.patch;
    if (Object.keys(patch).length === 0) return;
    invalidateBatchPreparationUndo();
    Object.keys(patch || {}).forEach((field) => {
      editedArchiveFormFieldsRef.current.add(field);
    });
    setForm((current) => {
      let normalizedPatch = { ...patch };
      if (Object.hasOwn(patch, 'watermarkCategory')) {
        normalizedPatch.archiveCategory = patch.watermarkCategory;
      }
      if (Object.hasOwn(patch, 'location')) {
        normalizedPatch.locationArea = patch.location;
      }
      if (Object.hasOwn(patch, 'remark')) {
        normalizedPatch.remarks = patch.remark;
      }
      if (Object.hasOwn(patch, 'violationType')) {
        normalizedPatch.workContent = patch.violationType;
      }
      if (Object.hasOwn(patch, 'constructionUnitName')) {
        const unit = (configs.constructionUnits || [])
          .find((item) => item.name === patch.constructionUnitName);
        normalizedPatch = {
          ...normalizedPatch,
          constructionUnitId: unit?.id || '',
          constructionUnitName: unit?.name || '',
          constructionUnitConfirmed: Boolean(unit),
          constructionUnitSource: unit ? 'manual' : ''
        };
      }
      const next = { ...current, ...normalizedPatch };
      if (patch.watermarkCategory) {
        const items = configs?.watermarkCategories?.[patch.watermarkCategory]?.items || [];
        if (!items.includes(next.workContent)) next.workContent = '';
        if (patch.watermarkCategory !== ENGINEERING_ARCHIVE_CATEGORY) {
          next.constructionUnitId = '';
          next.constructionUnitName = '';
          next.constructionUnitOriginalText = '';
          next.constructionUnitConfirmed = false;
          next.constructionUnitSource = '';
        }
      }
      if (!options.preserveKeywords && (patch.watermarkCategory || patch.workContent || patch.location)) {
        next.keywords = getSuggestedKeywords(toArchiveForm(next), configs);
      }
      if (currentPanelPhoto) {
        const sanitized = sanitizeDraftFields(next, configs, activeProject);
        setPhotoDraftByPhotoId((currentDrafts) => {
          const nextDrafts = {
            ...currentDrafts,
            [currentPanelPhoto.id]: sanitized
          };
          if (smartSortResult && ['date', 'watermarkCategory', 'workContent', 'watermarkTemplateType'].some((key) => Object.hasOwn(normalizedPatch, key))) {
            const nextEffectiveMap = Object.fromEntries(photos.map((photo) => [
              photo.id,
              resolveEffectivePhotoArchiveInfo({
                photo,
                sourceCanonical: sourceCanonicalByPhotoId[photo.id],
                sourceAwareProcessing: recognitionResultsByPhoto[photo.id]?.sourceAwareProcessing,
                photoDraft: nextDrafts[photo.id],
                activeProject
              })
            ]));
            const rebuilt = rebuildSmartSortResult({
              photos,
              sourceCanonicalByPhotoId,
              effectiveArchiveInfoByPhotoId: nextEffectiveMap,
              previousSmartSortResult: smartSortResult
            });
            setSmartSortResult(rebuilt);
            const nextGroupId = buildSmartSortGroupMembershipByPhotoId(rebuilt).get(currentPanelPhoto.id) || '';
            setActiveSmartSortGroupId(nextGroupId);
          }
          return nextDrafts;
        });
        if (options.scope === 'group' && currentPanelSmartGroup) {
          setGroupDraftByGroupId((currentDrafts) => ({
            ...currentDrafts,
            [currentPanelSmartGroup.id]: {
              ...(currentDrafts[currentPanelSmartGroup.id] || {}),
              ...normalizedPatch
            }
          }));
        }
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
    if (scanAfterSelect && photos.length > 0 && !window.confirm('更换照片目录后会把新目录中的照片追加到统一照片池；已有本地照片、马克照片及全部处理状态都会保留，重复内容会自动跳过。确定继续吗？')) {
      return false;
    }
    const runtimeConfiguration = await window.archiveAssistant.saveRuntimeDirectory('photoSource', selected);
    archiveState?.applySavedSettings?.(runtimeConfiguration);
    setSettings(runtimeConfiguration.settings || {});
    window.sessionStorage.removeItem(sortSessionPhotoFolderKey);
    setPhotoFolder(runtimeConfiguration.photoSourceDirectory || '');
    if (scanAfterSelect) {
      await scanPhotos(true);
    } else {
      setStatus({ type: 'idle', text: '照片来源目录已选择，请点击扫描。' });
    }
    return true;
  }

  async function scanPhotos(force = false) {
    if (!force && photos.length > 0 && !window.confirm('重新扫描会把尚未存在的新照片追加到统一照片池；已有本地照片、马克照片及全部处理状态都会保留，重复内容会自动跳过。确定继续吗？')) {
      return;
    }
    setIsBusy(true);
    try {
      const scanResult = await window.archiveAssistant.scanConfiguredImages();
      if (scanResult?.success !== true) {
        setStatus({ type: 'error', text: scanResult?.message || scanResult?.error?.message || '照片来源目录当前不可用。' });
        return;
      }
      const scanned = scanResult.photos || [];
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
      const mergedPool = mergeScannedLocalPhotoSubpool({
        currentPhotos: photos,
        scannedPhotos: scanned,
        archivedMatches,
        recognitionResultsByPhoto,
        watermarkRecordsByPhoto,
        archiveSuggestionsByPhoto,
        selectedIds,
        activePhotoId,
        activeProject
      });
      const nextSmartSortResult = smartSortResult;
      const nextSmartSortViewMode = smartSortViewMode;
      const nextActiveSmartSortGroupId = activeSmartSortGroupId;
      const archivedCount = mergedPool.photos.filter((photo) => (
        photo.sourceType === 'local_file' && hasArchivedPhotoState(photo)
      )).length;
      const scannedWorkspace = buildSortWorkspaceSnapshotWorkspace({
        activeProject,
        ...markiWorkbenchStateRef.current,
        photos: mergedPool.photos,
        selectedIds: mergedPool.selectedIds,
        activePhotoId: mergedPool.activePhotoId,
        recognitionResultsByPhoto: mergedPool.recognitionResultsByPhoto,
        watermarkRecordsByPhoto: mergedPool.watermarkRecordsByPhoto,
        archiveSuggestionsByPhoto: mergedPool.archiveSuggestionsByPhoto,
        smartSortResult: nextSmartSortResult,
        smartSortViewMode: nextSmartSortViewMode,
        activeSmartSortGroupId: nextActiveSmartSortGroupId,
        archivePreviewPlan,
        filter: 'all',
        page: 1
      });
      const snapshotResult = await saveAutomaticSnapshotImmediately(scannedWorkspace);
      if (snapshotResult?.success !== true) {
        setStatus({ type: 'error', text: '扫描结果未载入：自动快照保存失败，请重试。' });
        return;
      }
      invalidateBatchPreparationUndo();
      setRecognitionResultsByPhoto(mergedPool.recognitionResultsByPhoto);
      setWatermarkRecordsByPhoto(mergedPool.watermarkRecordsByPhoto);
      setArchiveSuggestionsByPhoto(mergedPool.archiveSuggestionsByPhoto);
      setRecognitionMessage({ type: 'idle', text: '' });
      setPhotos(mergedPool.photos);
      setSelectedIds(mergedPool.selectedIds);
      setActivePhotoId(mergedPool.activePhotoId);
      setPage(1);
      switchStatusFilter('all');
      setSmartSortViewMode(nextSmartSortViewMode);
      setActiveSmartSortGroupId(nextActiveSmartSortGroupId);
      setEditingPhotoId('');
      markiWorkbenchStateRef.current = scannedWorkspace;
      sessionSnapshotRef.current = {
        ...(sessionSnapshotRef.current || {}),
        ...scannedWorkspace,
        hasUnsavedChanges: true
      };
      sortWorkspaceSessionCacheByProject.set(projectCacheKey, sessionSnapshotRef.current);
      markChanged();
      const {
        retainedMarkiCount,
        addedLocalCount,
        retainedLocalCount,
        duplicateCount,
        projectConflictCount,
        rejectedCount
      } = mergedPool.stats;
      setStatus({
        type: archiveMatchWarning || projectConflictCount || rejectedCount || scanResult.failures?.length ? 'warning' : 'success',
        text: archiveMatchWarning
          ? `本地照片扫描完成；已保留 ${retainedMarkiCount} 张马克照片。内容指纹核对失败，“未归档”状态可能不完整。`
          : `本次扫描照片已归属当前项目“${activeProject.projectName}”：新增 ${addedLocalCount} 张、跳过重复 ${duplicateCount} 张；保留原有 ${retainedLocalCount} 张本地照片和 ${retainedMarkiCount} 张马克照片，其中 ${archivedCount} 张本地照片已有归档记录。${projectConflictCount ? `另有 ${projectConflictCount} 张内容指纹已归属其他项目，未加入当前项目。` : ''}${rejectedCount ? `另有 ${rejectedCount} 条缺少有效内容指纹或来源异常的扫描结果未加入照片池。` : ''}${scanResult.failures?.length ? `另有 ${scanResult.failures.length} 个文件未通过健康检查。` : ''}`
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
      await scanPhotos(false);
      return;
    }
    await selectPhotoFolder({ scanAfterSelect: true });
  }

  async function clearList() {
    if (photos.length === 0) return;
    if (!window.confirm('仅清空当前分拣列表和分拣状态，不会删除原始照片。确定清空吗？')) return;
    const emptyWorkspace = getEmptySortWorkspaceSnapshotWorkspace({
      activeProject,
      archiveRoot,
      form,
      sortMode,
      pageSize,
      rightPanelMode,
      viewMode
    });
    const snapshotResult = await saveAutomaticSnapshotImmediately(emptyWorkspace);
    if (snapshotResult?.success !== true) {
      setStatus({ type: 'error', text: '工作台未清空：自动快照保存失败，请重试。' });
      return;
    }
    sortWorkspaceSessionCacheByProject.delete(projectCacheKey);
    sessionSnapshotRef.current = null;
    setPhotos([]);
    setSelectedIds([]);
    setActivePhotoId('');
    setRecognitionResultsByPhoto({});
    setWatermarkRecordsByPhoto({});
    setArchiveSuggestionsByPhoto({});
    setPhotoDraftByPhotoId({});
    setGroupDraftByGroupId({});
    setArchivePreviewPlan(null);
    setRecognitionMessage({ type: 'idle', text: '' });
    setPage(1);
    resetSmartSortState({ type: 'idle', text: '' });
    setEditingPhotoId('');
    invalidateBatchPreparationUndo();
    markChanged();
    void synchronizePhotoFolderFromSettings();
    setStatus({ type: 'success', text: '已清空当前分拣列表，原始照片未受影响。' });
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
    if (blockProjectMismatch(targets, '智拣')) return;
    const rerunCount = targets.filter((photo) => (
      hasPhotoSmartSortResult(photo, smartSortGroupPhotoIds.has(photo.id))
    )).length;
    if (alsoSort && confirmRerun && rerunCount > 0 && !window.confirm(`已选照片中有 ${rerunCount} 张已有智拣结果。\n\n系统会保留完整的马克平台结构化数据，仅对本地照片或缺少必要字段的马克照片执行 OCR。是否继续？`)) return;
    const previousStagedIdByPhotoId = new Map(targets.map((photo) => [
      photo.id,
      recognitionResultsByPhoto[photo.id]?.stagedResultId || ''
    ]));
    let supersedeSyncFailedCount = 0;
    invalidateBatchPreparationUndo();
    setIsRecognitionBusy(true);
    setRecognitionProgress({ current: 0, total: targets.length });
    setRecognitionMessage({ type: 'idle', text: `正在智拣 0 / ${targets.length}` });
    const runningPhotos = alsoSort
      ? beginSmartSortExecution(photos, selectedPhotoIdsSnapshot)
      : photos;
    if (alsoSort) setPhotos(runningPhotos);
    try {
      const orchestration = await orchestrateSourceAwareRecognition({
        photos: targets,
        recognitionResultsByPhoto,
        watermarkRecordsByPhoto,
        archiveSuggestionsByPhoto,
        configs,
        activeProject,
        getOcrAvailability: async () => {
          const latestServiceStatus = await getRecognitionStatus();
          setRecognitionServiceStatus(latestServiceStatus);
          if (!latestServiceStatus?.available) {
            const reason = latestServiceStatus?.reason || '未检测到可用 OCR 引擎。';
            void recordRuntimeLog({
              page: '照片分拣工作台',
              operation: 'OCR 引擎检测',
              errorType: 'OCR 识别',
              summary: reason,
              level: 'error'
            });
          }
          return latestServiceStatus;
        },
        recognizePhoto: (photo) => recognizePhoto(toRecognitionPhoto(photo), { allowCloudUpload: false }),
        buildOcrArtifacts: ({ photo, route, recognitionResult }) => {
          const watermarkRecord = parseWatermarkRecord({ ...recognitionResult, photoId: photo.id });
          const suggestionContext = buildArchiveSuggestionContext({ configs, form, photoFolder, archiveRoot, photo });
          return {
            recognitionResult,
            watermarkRecord,
            archiveSuggestion: buildArchiveSuggestion(
              watermarkRecord,
              route === 'marki_ocr_fallback'
                ? { ...suggestionContext, currentProject: '' }
                : suggestionContext
            )
          };
        },
        getPhotoSortStatus: getPhotoRecognitionSortStatus,
        onProgress: ({ current, total, route }) => {
          const routeText = ['marki_platform_only', 'marki_existing_supplement'].includes(route)
            ? '正在使用已有可信数据'
            : '正在识别';
          setRecognitionProgress({ current, total });
          setRecognitionMessage({ type: 'idle', text: `${routeText} ${current} / ${total}` });
        },
        onOcrResult: async ({ photo, result }) => {
          const previousStagedId = previousStagedIdByPhotoId.get(photo.id);
          if (previousStagedId && result?.stagedResultId && previousStagedId !== result.stagedResultId) {
            const updatedPreviousRecord = await updateStagedResultStatus(previousStagedId, 'superseded');
            if (!updatedPreviousRecord) supersedeSyncFailedCount += 1;
          }
        },
        generateGroups: null
      });
      const processedPhotoById = new Map(orchestration.photos.map((photo) => [photo.id, photo]));
      const processedWorkspacePhotos = runningPhotos.map((photo) => processedPhotoById.get(photo.id) || photo);
      let nextSmartSortResult = null;
      let smartSortError = null;
      if (alsoSort) {
        try {
          const canonicalMaps = buildSmartSortCanonicalMaps({
            photos: processedWorkspacePhotos,
            recognitionResultsByPhoto: orchestration.recognitionResultsByPhoto,
            watermarkRecordsByPhoto: orchestration.watermarkRecordsByPhoto,
            photoDraftByPhotoId,
            configs,
            activeProject
          });
          nextSmartSortResult = rebuildSmartSortResult({
            photos: processedWorkspacePhotos,
            ...canonicalMaps,
            previousSmartSortResult: smartSortResult,
            includePhotoIds: orchestration.processingResults
              .filter((result) => result.status === 'completed')
              .map((result) => result.photoId)
          });
          orchestration.stats.groupCallCount += 1;
        } catch {
          smartSortError = {
            code: 'smart_sort_failed',
            message: '智能分组生成失败，识别结果已保留。'
          };
        }
      }
      const nextPhotos = alsoSort
        ? completeSmartSortExecution({
            photos: processedWorkspacePhotos,
            targetPhotoIds: selectedPhotoIdsSnapshot,
            processingResults: orchestration.processingResults,
            smartSortResult: nextSmartSortResult,
            smartSortError
          })
        : processedWorkspacePhotos;
      const currentTargetActivePhotoId = (
        !currentPanelPhoto?.id || !selectedSnapshotSet.has(currentPanelPhoto.id)
      )
        ? targets[0]?.id || ''
        : activePhotoId;
      const smartSortPresentation = alsoSort && nextSmartSortResult
        ? buildSourceAwareSmartSortPresentation({
            smartSortResult: nextSmartSortResult,
            currentActivePhotoId: currentTargetActivePhotoId
          })
        : null;
      const nextSmartSortViewMode = smartSortPresentation?.smartSortViewMode
        || (alsoSort ? smartSortViewMode : 'statusFilter');
      const nextActiveSmartSortGroupId = smartSortPresentation
        ? smartSortPresentation.activeSmartSortGroupId
        : alsoSort
          ? activeSmartSortGroupId
          : '';
      const nextActivePhotoId = smartSortPresentation?.activePhotoId || currentTargetActivePhotoId;

      setRecognitionResultsByPhoto(orchestration.recognitionResultsByPhoto);
      setWatermarkRecordsByPhoto(orchestration.watermarkRecordsByPhoto);
      setArchiveSuggestionsByPhoto(orchestration.archiveSuggestionsByPhoto);
      setPhotos(nextPhotos);
      const panelPhotoId = currentPanelPhoto?.id && selectedSnapshotSet.has(currentPanelPhoto.id)
        ? currentPanelPhoto.id
        : targets[0]?.id;
      let nextForm = form;
      const panelPhoto = nextPhotos.find((photo) => photo.id === panelPhotoId) || null;
      if (panelPhoto) {
        const panelGroupId = buildSmartSortGroupMembershipByPhotoId(nextSmartSortResult)
          .get(panelPhoto.id);
        const panelGroup = Array.isArray(nextSmartSortResult?.groups)
          ? nextSmartSortResult.groups.find((group) => group.id === panelGroupId) || null
          : null;
        nextForm = buildArchiveFormSeed({
          photo: panelPhoto,
          recognitionResult: orchestration.recognitionResultsByPhoto[panelPhoto.id],
          watermarkRecord: orchestration.watermarkRecordsByPhoto[panelPhoto.id],
          archiveSuggestion: orchestration.archiveSuggestionsByPhoto[panelPhoto.id],
          group: panelGroup,
          configs,
          activeProject
        });
        setForm(nextForm);
      }
      const { stats } = orchestration;
      const recognitionNeedsAttention = stats.failedCount > 0
        || stats.needsManualCount > 0
        || stats.ocrUnavailableCount > 0
        || supersedeSyncFailedCount > 0;
      setRecognitionMessage({
        type: recognitionNeedsAttention ? 'warning' : 'success',
        text: buildSourceAwareRecognitionNotice(stats, { supersedeSyncFailedCount })
      });
      setRightPanelMode('form');
      setActivePhotoId(nextActivePhotoId);
      if (alsoSort) {
        setSmartSortResult(nextSmartSortResult);
        setSmartSortViewMode(nextSmartSortViewMode);
        setActiveSmartSortGroupId(nextActiveSmartSortGroupId);
        if (nextSmartSortResult) {
          if (smartSortPresentation?.hasVisibleGroup) {
            setSearchText(smartSortPresentation.searchText);
            setPage(smartSortPresentation.page);
          }
          if (nextSmartSortResult.status === 'failed') {
            setSmartSortMessage({
              type: 'error',
              text: orchestration.smartSortResult.errors?.[0]?.message || '分拣组生成失败，识别结果已保留。'
            });
          } else if (nextSmartSortResult.groupCount > 0) {
            setSmartSortMessage({
              type: recognitionNeedsAttention ? 'warning' : 'success',
              text: `智拣完成：已处理 ${Number(nextSmartSortResult.photoCount) || targets.length} 张照片，生成 ${nextSmartSortResult.groupCount} 个分组，已显示第一个分组。`
            });
          } else {
            setSmartSortMessage({ type: 'warning', text: '当前照片缺少足够识别信息，暂未形成有效分组，您仍可手动选择照片进行归档。' });
          }
        } else if (smartSortError) {
          setSmartSortMessage({ type: 'error', text: smartSortError.message });
        } else {
          const unavailableReason = orchestration.ocrAvailability?.reason || '未检测到可用 OCR 引擎。';
          setSmartSortMessage({ type: 'error', text: `OCR 引擎不可用：${unavailableReason}` });
        }
      } else if (smartSortResult) {
        resetSmartSortState({ type: 'warning', text: '识别结果已更新，原智能分组已失效；可重新智拣生成分组。' });
      }
      const nextWorkspace = buildSortWorkspaceSnapshotWorkspace({
        activeProject,
        ...markiWorkbenchStateRef.current,
        photos: nextPhotos,
        recognitionResultsByPhoto: orchestration.recognitionResultsByPhoto,
        watermarkRecordsByPhoto: orchestration.watermarkRecordsByPhoto,
        archiveSuggestionsByPhoto: orchestration.archiveSuggestionsByPhoto,
        smartSortResult: nextSmartSortResult,
        smartSortViewMode: nextSmartSortViewMode,
        activeSmartSortGroupId: nextActiveSmartSortGroupId,
        searchText: smartSortPresentation?.hasVisibleGroup ? smartSortPresentation.searchText : searchText,
        page: smartSortPresentation?.hasVisibleGroup ? smartSortPresentation.page : page,
        form: nextForm,
        activePhotoId: nextActivePhotoId
      });
      markiWorkbenchStateRef.current = nextWorkspace;
      sessionSnapshotRef.current = {
        ...(sessionSnapshotRef.current || {}),
        ...nextWorkspace,
        hasUnsavedChanges: true
      };
      sortWorkspaceSessionCacheByProject.set(projectCacheKey, sessionSnapshotRef.current);
      const snapshotResult = await saveAutomaticSnapshotImmediately(nextWorkspace);
      if (snapshotResult?.success !== true) {
        setStatus({ type: 'warning', text: '智拣结果已保留在当前工作台，但自动快照保存失败，请稍后重试。' });
      }
      setHasUnsavedChanges(true);
      markChanged();
    } catch (error) {
      const failedPhotos = alsoSort
        ? failSmartSortExecution(photos, selectedPhotoIdsSnapshot)
        : photos;
      if (alsoSort) {
        const failedCanonicalMaps = buildSmartSortCanonicalMaps({
          photos: failedPhotos,
          recognitionResultsByPhoto,
          watermarkRecordsByPhoto,
          photoDraftByPhotoId,
          configs,
          activeProject
        });
        const failedSmartSortResult = rebuildSmartSortResult({
          photos: failedPhotos,
          ...failedCanonicalMaps,
          previousSmartSortResult: smartSortResult,
        });
        setPhotos(failedPhotos);
        setSmartSortResult(failedSmartSortResult);
        setSmartSortViewMode('statusFilter');
        setActiveSmartSortGroupId('');
      }
      setRecognitionMessage({ type: 'error', text: '智拣失败，请重试或手工完善归档信息。' });
      void recordRuntimeLog({
        page: '照片分拣工作台',
        operation: '来源感知智拣',
        errorType: '智拣',
        summary: '来源感知智拣未能完成。',
        level: 'error'
      });
    } finally {
      setIsRecognitionBusy(false);
      setRecognitionProgress({ current: 0, total: 0 });
    }
  }

  async function clearSelectedRecognitionResults() {
    const resetResult = resetSelectedSmartSortResults({
      photos,
      selectedPhotoIds: selectedIds,
      recognitionResultsByPhoto,
      watermarkRecordsByPhoto,
      archiveSuggestionsByPhoto,
      smartSortResult
    });
    if (resetResult.targetPhotos.length === 0) {
      setRecognitionMessage({ type: 'warning', text: '已选照片没有可重置的智拣结果。' });
      return;
    }
    if (!window.confirm('重置已选照片的智拣执行状态并清除当前智能分组？\n\n马克平台原始结构化数据会保留；本地照片的 OCR 结果会清除。原始照片不会被删除、移动或修改。')) return;
    const selectedSet = new Set(resetResult.targetPhotoIds);
    let nextForm = form;
    if (currentPanelPhoto?.id && selectedSet.has(currentPanelPhoto.id)) {
      const nextPanelPhoto = resetResult.photos.find((photo) => photo.id === currentPanelPhoto.id)
        || currentPanelPhoto;
      nextForm = buildArchiveFormSeed({
        photo: nextPanelPhoto,
        recognitionResult: resetResult.recognitionResultsByPhoto[currentPanelPhoto.id],
        watermarkRecord: resetResult.watermarkRecordsByPhoto[currentPanelPhoto.id],
        archiveSuggestion: resetResult.archiveSuggestionsByPhoto[currentPanelPhoto.id],
        group: null,
        configs,
        activeProject
      });
    }

    await Promise.allSettled(resetResult.localTargetPhotos.map(clearRecognitionPipelineForPhoto));
    const remainingGroupIds = new Set(
      (resetResult.smartSortResult?.groups || []).map((group) => group?.id).filter(Boolean)
    );
    const nextActiveSmartSortGroupId = remainingGroupIds.has(activeSmartSortGroupId)
      ? activeSmartSortGroupId
      : '';
    const nextSmartSortViewMode = nextActiveSmartSortGroupId
      ? smartSortViewMode
      : 'statusFilter';
    const nextWorkspace = buildSortWorkspaceSnapshotWorkspace({
      activeProject,
      ...markiWorkbenchStateRef.current,
      photos: resetResult.photos,
      recognitionResultsByPhoto: resetResult.recognitionResultsByPhoto,
      watermarkRecordsByPhoto: resetResult.watermarkRecordsByPhoto,
      archiveSuggestionsByPhoto: resetResult.archiveSuggestionsByPhoto,
      smartSortResult: resetResult.smartSortResult,
      smartSortViewMode: nextSmartSortViewMode,
      activeSmartSortGroupId: nextActiveSmartSortGroupId,
      form: nextForm,
      selectedIds,
      activePhotoId
    });
    const snapshotResult = await saveAutomaticSnapshotImmediately(nextWorkspace);
    if (snapshotResult?.success !== true) {
      setStatus({ type: 'error', text: '智拣结果未重置：自动快照保存失败，请重试。' });
      return;
    }

    setRecognitionResultsByPhoto(resetResult.recognitionResultsByPhoto);
    setWatermarkRecordsByPhoto(resetResult.watermarkRecordsByPhoto);
    setArchiveSuggestionsByPhoto(resetResult.archiveSuggestionsByPhoto);
    setPhotos(resetResult.photos);
    setSmartSortResult(resetResult.smartSortResult);
    setSmartSortViewMode(nextSmartSortViewMode);
    setActiveSmartSortGroupId(nextActiveSmartSortGroupId);
    setForm(nextForm);
    markiWorkbenchStateRef.current = nextWorkspace;
    sessionSnapshotRef.current = {
      ...(sessionSnapshotRef.current || {}),
      ...nextWorkspace,
      hasUnsavedChanges: true
    };
    sortWorkspaceSessionCacheByProject.set(projectCacheKey, sessionSnapshotRef.current);
    setSmartSortMessage({ type: 'idle', text: '已选照片的智拣结果已重置；未选中照片及其分组保持不变。' });
    setRecognitionMessage({
      type: 'success',
      text: `已重置 ${resetResult.targetPhotos.length} 张照片的智拣状态；保留 ${resetResult.markiTargetPhotos.length} 张 Marki 平台数据，清除 ${resetResult.localTargetPhotos.length} 张本地照片的 OCR 派生结果。`
    });
    setStatus({ type: 'success', text: '局部重置完成；选择、当前照片和未选中分组保持不变。' });
    setRightPanelMode('form');
    invalidateBatchPreparationUndo();
    setHasUnsavedChanges(true);
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
    switchStatusFilter(nextFilter);
    setSmartSortViewMode('statusFilter');
    setActiveSmartSortGroupId('');
    setPage(1);
  }

  function viewSmartGroup(groupId) {
    if (activeSmartSortGroupId === groupId && smartSortViewMode === 'smartSortGroup') {
      const nextVisiblePhotos = getVisibleWorkflowPhotos({
        photos,
        activeSmartGroupPhotoKeys: null,
        groupMembershipByPhotoId: smartSortGroupMembershipByPhotoId,
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
    const nextVisiblePhotos = getVisibleWorkflowPhotos({
      photos,
      activeSmartGroupPhotoKeys: groupKeys,
      groupMembershipByPhotoId: smartSortGroupMembershipByPhotoId,
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
    setSearchText(nextSearchText);
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
    const targetPhotos = selectedPhotos.filter((photo) => (
      !isArchivedPhoto(photo)
      && !isIgnoredPhoto(photo)
      && !photo.originalMissing
      && photo.sortStatus !== 'archiving'
    ));
    if (targetPhotos.length === 0) {
      setStatus({ type: 'warning', text: '当前没有可标记忽略的照片。' });
      return;
    }
    await markPhotosIgnored(targetPhotos);
  }

  async function ignoreCurrentPhoto() {
    if (
      !currentPanelPhoto
      || isArchivedPhoto(currentPanelPhoto)
      || isIgnoredPhoto(currentPanelPhoto)
      || currentPanelPhoto.originalMissing
      || currentPanelPhoto.sortStatus === 'archiving'
    ) {
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
      const recognitionStageStatusByPhotoId = Object.fromEntries(
        appliedPhotos.map((photo) => [
          photo.id,
          getRecognitionStageStatusBeforeIgnore(recognitionResultsByPhoto[photo.id])
        ])
      );
      const transition = ignorePhotosInWorkspace({
        photos,
        smartSortResult,
        targetPhotoIds: appliedPhotos.map((photo) => photo.id),
        recognitionStageStatusByPhotoId
      });
      const appliedIdSet = new Set(transition.ignoredPhotoIds);
      if (appliedIdSet.size === 0) {
        setStatus({ type: 'warning', text: '当前照片处于归档、归档中或原图缺失状态，不能标记忽略。' });
        return;
      }
      const recognitionIssueCount = appliedPhotos.filter((photo) => getRecognitionOutcome(recognitionResultsByPhoto[photo.id]) === 'failed').length;
      const nextSelectedIds = selectedIds.filter((photoId) => !appliedIdSet.has(photoId));
      const nextMembershipByPhotoId = buildSmartSortGroupMembershipByPhotoId(
        transition.smartSortResult
      );
      const nextActivePhotoId = appliedIdSet.has(activePhotoId)
        ? nextSelectedIds.find((photoId) => transition.photos.some((photo) => (
            photo.id === photoId && !isIgnoredPhoto(photo)
          )))
          || transition.photos.find((photo) => (
            nextMembershipByPhotoId.get(photo.id) === activeSmartSortGroupId
            && !isIgnoredPhoto(photo)
          ))?.id
          || transition.photos.find((photo) => (
            !isIgnoredPhoto(photo)
            && !photo.originalMissing
            && !isArchivedPhoto(photo)
          ))?.id
          || ''
        : activePhotoId;
      const activeGroupStillExists = Array.isArray(transition.smartSortResult?.groups)
        && transition.smartSortResult.groups.some((group) => group.id === activeSmartSortGroupId);
      const nextSmartSortViewMode = activeGroupStillExists
        ? smartSortViewMode
        : 'statusFilter';
      const nextActiveSmartSortGroupId = activeGroupStillExists
        ? activeSmartSortGroupId
        : '';
      const nextWorkspace = buildSortWorkspaceSnapshotWorkspace({
        activeProject,
        photoFolder,
        archiveRoot,
        photos: transition.photos,
        selectedIds: nextSelectedIds,
        activePhotoId: nextActivePhotoId,
        recognitionResultsByPhoto,
        watermarkRecordsByPhoto,
        archiveSuggestionsByPhoto,
        smartSortResult: transition.smartSortResult,
        smartSortViewMode: nextSmartSortViewMode,
        activeSmartSortGroupId: nextActiveSmartSortGroupId,
        filter,
        sortMode,
        pageSize,
        rightPanelMode,
        form,
        searchText,
        page,
        viewMode
      });
      const snapshotResult = await saveAutomaticSnapshotImmediately(nextWorkspace);
      if (snapshotResult?.success !== true) {
        await rollbackIgnoredRecognitionStages(
          appliedPhotos,
          recognitionResultsByPhoto,
          recognitionStageStatusByPhotoId
        );
        setStatus({
          type: 'error',
          text: snapshotResult?.error?.message || '忽略状态未能保存，照片保持原状态，请稍后重试。'
        });
        return;
      }
      markiWorkbenchStateRef.current = nextWorkspace;
      setPhotos(transition.photos);
      setSmartSortResult(transition.smartSortResult);
      setSmartSortViewMode(nextSmartSortViewMode);
      setActiveSmartSortGroupId(nextActiveSmartSortGroupId);
      setSelectedIds(nextSelectedIds);
      setActivePhotoId(nextActivePhotoId);
      if (recognitionIssueCount > 0) {
        setRecognitionMessage({ type: 'warning', text: `已忽略 ${recognitionIssueCount} 张识别异常照片，后台记录已保留并标记为已忽略。` });
      }
      setEditingPhotoId((current) => appliedIdSet.has(current) ? '' : current);
      invalidateBatchPreparationUndo();
      markChanged();
      const failedTip = failedIdSet.size ? `另有 ${failedIdSet.size} 张因后台记录更新失败而保持原状态。` : '';
      setStatus({
        type: failedTip ? 'warning' : 'success',
        text: `已标记忽略 ${appliedIdSet.size} 张照片，来源数据、识别结果、人工信息和原图均已保留。${failedTip}`
      });
    } finally {
      setIsRecognitionBusy(false);
    }
  }

  async function cancelIgnored() {
    const targetPhotos = selectedPhotos.filter((photo) => (
      isIgnoredPhoto(photo)
      && !photo.originalMissing
      && !isArchivedPhoto(photo)
      && photo?.ignoredPreviousState?.sortStatus !== 'archiving'
    ));
    if (targetPhotos.length === 0) {
      setStatus({ type: 'warning', text: '请先选择可还原的已忽略照片；归档中、已归档或原图缺失照片不能普通还原。' });
      return;
    }
    setIsRecognitionBusy(true);
    try {
      const restoreEntries = targetPhotos.map((photo) => {
        const result = recognitionResultsByPhoto[photo.id];
        return {
          photo,
          result,
          stageStatus: getIgnoredRecognitionStageStatus(photo)
        };
      });
      const stageResults = await Promise.all(restoreEntries.map(async ({ photo, result, stageStatus }) => {
        if (!result?.stagedResultId) return { photoId: photo.id, success: true };
        const updated = await updateStagedResultStatus(result.stagedResultId, stageStatus);
        return { photoId: photo.id, success: Boolean(updated) };
      }));
      const failedIdSet = new Set(stageResults.filter((item) => !item.success).map((item) => item.photoId));
      const restoredPhotos = targetPhotos.filter((photo) => !failedIdSet.has(photo.id));
      if (restoredPhotos.length === 0) {
        setStatus({ type: 'error', text: '后台 OCR 记录未能恢复，照片仍保持已忽略状态，请稍后重试。' });
        return;
      }
      const transition = restoreIgnoredPhotosInWorkspace({
        photos,
        smartSortResult,
        targetPhotoIds: restoredPhotos.map((photo) => photo.id)
      });
      const restoredIdSet = new Set(transition.restoredPhotoIds);
      if (restoredIdSet.size === 0) {
        setStatus({ type: 'warning', text: '当前已忽略照片处于归档或原图缺失状态，不能普通还原。' });
        return;
      }
      const nextSelectedIds = selectedIds.filter((photoId) => !restoredIdSet.has(photoId));
      const nextWorkspace = buildSortWorkspaceSnapshotWorkspace({
        activeProject,
        photoFolder,
        archiveRoot,
        photos: transition.photos,
        selectedIds: nextSelectedIds,
        activePhotoId,
        recognitionResultsByPhoto,
        watermarkRecordsByPhoto,
        archiveSuggestionsByPhoto,
        smartSortResult: transition.smartSortResult,
        smartSortViewMode,
        activeSmartSortGroupId,
        filter,
        sortMode,
        pageSize,
        rightPanelMode,
        form,
        searchText,
        page,
        viewMode
      });
      const snapshotResult = await saveAutomaticSnapshotImmediately(nextWorkspace);
      if (snapshotResult?.success !== true) {
        await Promise.all(restoredPhotos.map(async (photo) => {
          const result = recognitionResultsByPhoto[photo.id];
          if (!result?.stagedResultId) return;
          try {
            await updateStagedResultStatus(result.stagedResultId, 'dismissed');
          } catch {
            // Snapshot failure remains the user-visible source of truth.
          }
        }));
        setStatus({
          type: 'error',
          text: snapshotResult?.error?.message || '还原状态未能保存，照片继续保持已忽略，请稍后重试。'
        });
        return;
      }
      markiWorkbenchStateRef.current = nextWorkspace;
      setPhotos(transition.photos);
      setSmartSortResult(transition.smartSortResult);
      setSelectedIds(nextSelectedIds);
      setRecognitionMessage({ type: 'warning', text: `已恢复 ${restoredPhotos.length} 张照片的识别处理状态，请选择后继续整理。` });
      setEditingPhotoId((current) => restoredIdSet.has(current) ? '' : current);
      invalidateBatchPreparationUndo();
      markChanged();
      const failedTip = failedIdSet.size ? `另有 ${failedIdSet.size} 张因后台记录恢复失败而继续保持已忽略。` : '';
      const expiredTip = transition.membershipExpiredPhotoIds.length
        ? `另有 ${transition.membershipExpiredPhotoIds.length} 张的原分组已失效，已安全恢复为待智拣。`
        : '';
      setStatus({
        type: failedTip || expiredTip ? 'warning' : 'success',
        text: `已还原 ${restoredIdSet.size} 张已忽略照片，并恢复可用的忽略前阶段和分组。${expiredTip}${failedTip}`
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
    setForm(sanitizeDraftFields(nextSuggestion.suggestedFields, configs, activeProject));
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
      sanitizeDraftFields(form, configs, activeProject),
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
    setForm(sanitizeDraftFields(currentSuggestion.suggestedFields, configs, activeProject));
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
      sanitizeDraftFields(form, configs, activeProject),
      { configs, photoId: target.id }
    );
    setArchiveSuggestionsByPhoto((current) => ({ ...current, [target.id]: nextSuggestion }));
    setForm(sanitizeDraftFields(nextSuggestion.suggestedFields, configs, activeProject));
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
    setForm(reconcileForm(defaultForm, configs, activeProject));
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
    }, configs, activeProject));
    setStatus({ type: 'idle', text: `已载入当前照片的归档信息，可修改后保存到当前照片。` });
  }

  function saveCurrentPhotoInfo() {
    if (!editingPhoto) {
      setStatus({ type: 'error', text: '请先选择已套用归档信息的待预览照片。' });
      return;
    }
    const missing = validateSortForm(form, configs, activeProject);
    if (missing.length) {
      setStatus({ type: 'error', text: `请补全必填项：${missing.join('、')}` });
      return;
    }
    const invalidTip = invalidatePreviewMessage();
    const archiveInfo = normalizeArchiveInfo(form, activeProject);
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
    try {
      const payload = buildSortWorkspaceManualDraft(
        markiWorkbenchStateRef.current,
        { savedAt }
      );
      const result = await window.archiveAssistant.saveSortDraft(payload);
      if (result?.success) {
        setLastDraftSavedAt(savedAt);
        setHasSavedDraft(true);
        window.localStorage.setItem(sortDraftAvailableKey, 'true');
        setHasUnsavedChanges(false);
        setStatus({ type: 'success', text: '工作台草稿已完整保存。' });
      } else if (!result?.canceled) {
        setStatus({ type: 'error', text: '工作台草稿保存失败，请重试。' });
      }
    } catch {
      setStatus({ type: 'error', text: '工作台草稿包含不可保存的数据，未写入文件。' });
    }
  }

  async function loadDraft() {
    if (
      (photos.length > 0 || hasUnsavedChanges)
      && !window.confirm('恢复手工草稿将完整替换当前工作台，并立即同步自动快照。是否继续？')
    ) {
      return;
    }
    try {
      const result = await window.archiveAssistant.loadSortDraft();
      if (!result?.success || !result.draft) {
        if (!result?.canceled) setStatus({ type: 'error', text: '工作台草稿读取失败，请重试。' });
        return;
      }
      const parsedDraft = readSortWorkspaceManualDraft(result.draft);
      const draftWorkspace = parsedDraft.workspace;
      const loadedPhotos = await Promise.all(draftWorkspace.photos.map(async (photo, index) => {
        const exists = await window.archiveAssistant.validatePathExists(photo.originalPath);
        const photoId = photo.id || `legacy-draft-${index + 1}`;
        return {
          ...photo,
          id: photoId,
          previewUrl: `local-photo://image/${encodeURIComponent(photo.originalPath)}`,
          thumbnailPath: `local-photo://image/${encodeURIComponent(photo.originalPath)}`,
          originalMissing: !exists,
          missingSortStatus: exists
            ? undefined
            : (photo.missingSortStatus || photo.sortStatus || 'unassigned'),
          sortStatus: photo.missingSortStatus || photo.sortStatus || 'unassigned'
        };
      }));
      if (
        draftWorkspace.projectId !== activeProject.projectId
        || draftWorkspace.projectName !== activeProject.projectName
      ) {
        throw Object.assign(new Error('所选草稿属于其他项目，未恢复。'), {
          code: 'workspace_project_mismatch'
        });
      }
      const draftProjectValidation = validatePhotosForActiveProject(loadedPhotos, activeProject);
      if (!draftProjectValidation.valid) {
        throw Object.assign(new Error(draftProjectValidation.message), {
          code: draftProjectValidation.code
        });
      }
      const restoredPhotoIds = new Set(loadedPhotos.map((photo) => photo.id));
      if (restoredPhotoIds.size !== loadedPhotos.length) {
        throw new TypeError('分拣草稿包含重复照片');
      }
      const restoredSelectedIds = draftWorkspace.selectedIds.filter((id) => restoredPhotoIds.has(id));
      const restoredActivePhotoId = restoredPhotoIds.has(draftWorkspace.activePhotoId)
        ? draftWorkspace.activePhotoId
        : restoredSelectedIds[0] || loadedPhotos[0]?.id || '';
      const restoredRecognitionMap = filterPhotoMapByIds(
        draftWorkspace.recognitionResultsByPhoto,
        restoredPhotoIds
      );
      const restoredWatermarkMap = filterPhotoMapByIds(
        draftWorkspace.watermarkRecordsByPhoto,
        restoredPhotoIds
      );
      const restoredPhotoDrafts = filterPhotoMapByIds(
        draftWorkspace.photoDraftByPhotoId,
        restoredPhotoIds
      );
      const restoredSourceCanonicalMap = Object.fromEntries(loadedPhotos.map((photo) => [
        photo.id,
        buildSourceCanonical({
          photo,
          recognitionResult: restoredRecognitionMap[photo.id],
          watermarkRecord: restoredWatermarkMap[photo.id],
          sourceAwareProcessing: restoredRecognitionMap[photo.id]?.sourceAwareProcessing,
          configs,
          activeProject
        })
      ]));
      const restoredEffectiveMap = Object.fromEntries(loadedPhotos.map((photo) => [
        photo.id,
        resolveEffectivePhotoArchiveInfo({
          photo,
          sourceCanonical: restoredSourceCanonicalMap[photo.id],
          sourceAwareProcessing: restoredRecognitionMap[photo.id]?.sourceAwareProcessing,
          photoDraft: restoredPhotoDrafts[photo.id],
          activeProject
        })
      ]));
      const restoredSmartSortResult = draftWorkspace.smartSortResult
        ? rebuildSmartSortResult({
            photos: loadedPhotos,
            sourceCanonicalByPhotoId: restoredSourceCanonicalMap,
            effectiveArchiveInfoByPhotoId: restoredEffectiveMap,
            previousSmartSortResult: draftWorkspace.smartSortResult
          })
        : null;
      const restoredGroupIds = new Set(
        (restoredSmartSortResult?.groups || []).map((group) => group?.id).filter(Boolean)
      );
      const restoredActiveGroupId = restoredGroupIds.has(draftWorkspace.activeSmartSortGroupId)
        ? draftWorkspace.activeSmartSortGroupId
        : '';
      const restoredGroupDrafts = migrateGroupDraftsByGroupKey(
        draftWorkspace.smartSortResult,
        restoredSmartSortResult,
        draftWorkspace.groupDraftByGroupId || {}
      );
      const restoredWorkspace = buildSortWorkspaceSnapshotWorkspace({
        activeProject,
        ...draftWorkspace,
        photos: loadedPhotos,
        selectedIds: restoredSelectedIds,
        activePhotoId: restoredActivePhotoId,
        recognitionResultsByPhoto: restoredRecognitionMap,
        watermarkRecordsByPhoto: restoredWatermarkMap,
        archiveSuggestionsByPhoto: filterPhotoMapByIds(
          draftWorkspace.archiveSuggestionsByPhoto,
          restoredPhotoIds
        ),
        photoDraftByPhotoId: restoredPhotoDrafts,
        groupDraftByGroupId: restoredGroupDrafts,
        smartSortResult: restoredSmartSortResult,
        smartSortViewMode: restoredActiveGroupId
          ? draftWorkspace.smartSortViewMode
          : 'statusFilter',
        activeSmartSortGroupId: restoredActiveGroupId,
        filter: normalizeStatusFilter(draftWorkspace.filter),
        form: reconcileForm(draftWorkspace.form || defaultForm, configs, activeProject)
      });
      const snapshotResult = await saveAutomaticSnapshotImmediately(restoredWorkspace);
      if (snapshotResult?.success !== true) {
        setStatus({ type: 'error', text: '工作台草稿未恢复：自动快照保存失败，请重试。' });
        return;
      }
      applyAutomaticSnapshotWorkspace(restoredWorkspace);
      invalidateBatchPreparationUndo();
      setEditingPhotoId('');
      setRecognitionMessage({ type: 'idle', text: '' });
      setLastDraftSavedAt(parsedDraft.savedAt || '');
      setHasSavedDraft(true);
      window.localStorage.setItem(sortDraftAvailableKey, 'true');
      setHasUnsavedChanges(false);
      sessionSnapshotRef.current = {
        ...(sessionSnapshotRef.current || {}),
        ...restoredWorkspace,
        hasUnsavedChanges: false
      };
      sortWorkspaceSessionCacheByProject.set(projectCacheKey, sessionSnapshotRef.current);
      const missingCount = loadedPhotos.filter((photo) => photo.originalMissing).length;
      setStatus({
        type: missingCount ? 'warning' : 'success',
        text: `工作台草稿已完整恢复，共 ${loadedPhotos.length} 张照片。${missingCount ? `其中 ${missingCount} 张原图缺失，请核对。` : ''}`
      });
    } catch {
      setStatus({ type: 'error', text: '工作台草稿损坏或不兼容，当前工作台未被修改。' });
    }
  }

  async function relocateMissingPhotos() {
    const missingPhotos = photos.filter((photo) => photo.originalMissing);
    if (missingPhotos.length === 0) {
      setStatus({ type: 'idle', text: '当前没有原图缺失记录。' });
      return;
    }
    const missingLocalPhotos = missingPhotos.filter((photo) => photo.sourceType === 'local_file');
    const missingMarkiCount = missingPhotos.filter((photo) => photo.sourceType === 'marki_api').length;
    if (missingLocalPhotos.length === 0) {
      setStatus({
        type: 'warning',
        text: '缺失项均为 Marki 照片，请回到“马克照片导入”重新查询并执行可信修复。'
      });
      return;
    }
    const selected = await window.archiveAssistant.selectPhotoFolder();
    if (!selected) return;
    setIsBusy(true);
    try {
      const scanned = await window.archiveAssistant.scanImages(selected);
      const available = [...scanned];
      let restoredCount = 0;
      let missingFingerprintCount = 0;
      let healthRejectedCount = 0;
      const restoredByPhotoId = new Map();
      for (const photo of missingLocalPhotos) {
        const match = selectLocalPhotoRelinkCandidate(photo, available);
        if (!match.success) {
          if (match.reason === 'historical_fingerprint_missing') missingFingerprintCount += 1;
          continue;
        }
        const health = await window.archiveAssistant.inspectPhotoSourceFile({
          path: match.candidate.path,
          expectedSha256: match.expectedSha256
        });
        const restoredPhoto = buildRelinkedLocalPhoto(photo, match.candidate, health);
        if (!restoredPhoto) {
          healthRejectedCount += 1;
          continue;
        }
        restoredByPhotoId.set(photo.id, restoredPhoto);
        const candidateIndex = available.indexOf(match.candidate);
        if (candidateIndex >= 0) available.splice(candidateIndex, 1);
        restoredCount += 1;
      }
      const restored = photos.map((photo) => restoredByPhotoId.get(photo.id) || photo);
      let relocatedWorkspace = null;
      const relinkResult = await persistLocalPhotoRelinks({
        currentWorkspace: markiWorkbenchStateRef.current,
        nextPhotos: restored,
        saveSnapshot: saveAutomaticSnapshotImmediately,
        commitWorkspace: (workspace) => {
          relocatedWorkspace = workspace;
        }
      });
      if (!relinkResult.success) {
        setStatus({
          type: 'error',
          text: '重新定位结果未载入：自动快照保存失败，请重试。'
        });
        return;
      }
      const runtimeConfiguration = await window.archiveAssistant.saveRuntimeDirectory('photoSource', selected);
      archiveState?.applySavedSettings?.(runtimeConfiguration);
      setSettings(runtimeConfiguration.settings || {});
      window.sessionStorage.removeItem(sortSessionPhotoFolderKey);
      setPhotoFolder(runtimeConfiguration.photoSourceDirectory || '');
      setPhotos(restored);
      markiWorkbenchStateRef.current = relocatedWorkspace;
      sessionSnapshotRef.current = {
        ...(sessionSnapshotRef.current || {}),
        ...relocatedWorkspace,
        hasUnsavedChanges: true
      };
      sortWorkspaceSessionCacheByProject.set(projectCacheKey, sessionSnapshotRef.current);
      invalidateBatchPreparationUndo();
      markChanged();
      const remainingLocalCount = missingLocalPhotos.length - restoredCount;
      const details = [
        missingFingerprintCount ? `${missingFingerprintCount} 张缺少历史指纹` : '',
        healthRejectedCount ? `${healthRejectedCount} 张未通过文件健康校验` : '',
        missingMarkiCount ? `${missingMarkiCount} 张 Marki 照片需可信修复` : ''
      ].filter(Boolean).join('；');
      setStatus({
        type: remainingLocalCount === 0 && missingMarkiCount === 0 ? 'success' : 'warning',
        text: `已安全重新定位 ${restoredCount} 张本地照片，仍有 ${remainingLocalCount + missingMarkiCount} 张原图缺失。${details ? ` ${details}。` : ''}`
      });
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
    if (blockProjectMismatch(targets, '生成预览')) return;
    if (!archiveRoot) {
      setStatus({ type: 'warning', text: '请先选择归档根目录。' });
      return;
    }
    const confirmed = window.confirm(`确定把右侧当前表单套用到已选 ${targets.length} 张照片并生成预览吗？\n\n这些照片原有的归档建议将被当前表单覆盖，但不会修改 OCR 原文和原始照片。`);
    if (!confirmed) return;

    const batchPatch = buildBatchArchiveFormPatch(
      normalizeArchiveInfo(form, activeProject),
      { editedFields: [...editedArchiveFormFieldsRef.current] }
    );
    const perPhotoInputs = buildPerPhotoArchivePreviewInputs({
      photos: targets,
      effectiveArchiveInfoByPhotoId,
      photoDraftByPhotoId,
      batchPatch,
      configs,
      activeProject
    });
    const invalidInputs = perPhotoInputs.filter((item) => item.missingFields.length > 0);
    if (invalidInputs.length > 0) {
      const missing = [...new Set(invalidInputs.flatMap((item) => item.missingFields))];
      setStatus({
        type: 'warning',
        text: `有 ${invalidInputs.length} 张照片缺少各自模板必填字段：${missing.join('、')}`
      });
      return;
    }
    const perPhotoInputById = new Map(
      perPhotoInputs.map((item) => [item.photo.id, item])
    );
    setIsBusy(true);
    try {
      const resolutionSync = await resolveRecognitionIssues(
        targets.map((photo) => photo.id),
        'manual',
        'reviewed'
      );
      const failedIdSet = new Set(resolutionSync.failedPhotoIds);
      const appliedTargets = targets.filter((photo) => !failedIdSet.has(photo.id));
      if (appliedTargets.length === 0) {
        setStatus({ type: 'error', text: '后台 OCR 记录未能标记为已复核，当前表单和预览均未套用，请稍后重试。' });
        return;
      }

      const appliedInputs = appliedTargets.map((photo) => perPhotoInputById.get(photo.id));
      const previewResult = await window.archiveAssistant.buildArchivePreview({
        activeProject,
        form: appliedInputs[0].serviceForm,
        photos: appliedInputs.map(({ photo, serviceForm }) => ({
          ...serviceForm,
          id: photo.id,
          path: photo.originalPath,
          name: photo.originalName,
          extension: photo.extension,
          size: photo.size,
          previewUrl: photo.previewUrl,
          sourceType: photo.sourceType,
          sourceKey: photo.sourceKey,
          sourceMetadataRef: photo.sourceMetadataRef,
          watermarkTemplateType: serviceForm.watermarkTemplateType,
          processingMode: recognitionResultsByPhoto[photo.id]?.sourceAwareProcessing?.strategy
        }))
      });
      assertSuccessfulBusinessResult(previewResult, '生成归档预览失败。');
      const previewItems = previewResult.items || [];
      const previewMap = new Map(previewItems.map((item) => [item.id, item]));
      const previewTargets = appliedTargets.filter((photo) => previewMap.has(photo.id));
      if (previewTargets.length === 0) {
        setStatus({ type: 'warning', text: '当前表单未能生成有效预览，照片尚未套用，请检查归档目录和表单内容。' });
        return;
      }

      rememberBatchPreparationUndo('套用表单并生成预览', previewTargets.map((photo) => photo.id));
      const targetIds = new Set(previewTargets.map((photo) => photo.id));
      setArchiveSuggestionsByPhoto((current) => {
        const next = { ...current };
        previewTargets.forEach((photo) => {
          const serviceForm = perPhotoInputById.get(photo.id).serviceForm;
          const suggestion = updateArchiveSuggestion(current[photo.id], sanitizeDraftFields(serviceForm, configs, activeProject), {
            configs,
            photoId: photo.id
          });
          next[photo.id] = { ...suggestion, status: 'confirmed', missingRequiredFields: [] };
        });
        return next;
      });
      setPhotos((current) => current.map((photo) => targetIds.has(photo.id)
        ? {
            ...photo,
            sortStatus: 'previewed',
            archiveInfo: { ...perPhotoInputById.get(photo.id).archiveInfo },
            previewInfo: previewMap.get(photo.id),
            archiveResult: null
          }
        : photo));
      setArchivePreviewPlan(previewResult.previewPlan);
      setHasUnsavedChanges(true);
      switchStatusFilter('previewed');
      setSmartSortViewMode('statusFilter');
      setActiveSmartSortGroupId('');
      setSearchText('');
      setSelectedIds([]);
      setActivePhotoId(previewTargets[0]?.id || '');
      setPage(1);
      window.requestAnimationFrame(() => photoBrowserRef.current?.scrollTo({ top: 0, left: 0 }));
      markChanged();
      const skippedCount = targets.length - previewTargets.length;
      const skippedTip = skippedCount ? `另有 ${skippedCount} 张未能完成预览，仍保持原状态。` : '';
      setStatus({
        type: skippedCount ? 'warning' : 'success',
        text: `已将当前表单套用到 ${previewTargets.length} 张照片并生成归档预览。${skippedTip}`
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
    if (blockProjectMismatch(assigned, '生成预览')) return;
    const normalizedAssigned = assigned.map((photo) => ({
      photo,
      serviceForm: buildCurrentPhotoArchiveServiceForm(photo.archiveInfo, configs, activeProject)
    }));
    const invalidPhotos = normalizedAssigned.filter(({ serviceForm }) => (
      validateRequiredArchiveFields(serviceForm, configs, activeProject).length > 0
    ));
    if (invalidPhotos.length > 0) {
      setStatus({ type: 'error', text: `有 ${invalidPhotos.length} 张待预览照片缺少必填字段，请编辑补全后再生成预览。` });
      return;
    }
    setIsBusy(true);
    try {
      const previewResult = await window.archiveAssistant.buildArchivePreview({
        activeProject,
        form: normalizedAssigned[0].serviceForm,
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
          sourceMetadataRef: photo.sourceMetadataRef,
          watermarkTemplateType: serviceForm.watermarkTemplateType,
          processingMode: recognitionResultsByPhoto[photo.id]?.sourceAwareProcessing?.strategy
        }))
      });
      assertSuccessfulBusinessResult(previewResult, '生成归档预览失败。');
      const previewItems = previewResult.items || [];
      const previewMap = new Map(previewItems.map((item) => [item.id, item]));
      if (previewItems.length === 0) {
        setStatus({ type: 'warning', text: '当前没有可预览的照片，请先选择照片并应用归档信息。' });
        return;
      }
      setPhotos((current) => current.map((photo) => previewMap.has(photo.id)
        ? { ...photo, sortStatus: 'previewed', previewInfo: previewMap.get(photo.id), archiveResult: null }
        : photo));
      setArchivePreviewPlan(previewResult.previewPlan);
      setHasUnsavedChanges(true);
      switchStatusFilter('previewed');
      setSmartSortViewMode('statusFilter');
      setActiveSmartSortGroupId('');
      setSearchText('');
      setSelectedIds([]);
      setActivePhotoId(previewItems[0]?.id || '');
      setPage(1);
      window.requestAnimationFrame(() => photoBrowserRef.current?.scrollTo({ top: 0, left: 0 }));
      setStatus({ type: (pendingCount || ignoredCount) ? 'warning' : 'success', text: `已生成 ${previewItems.length} 张照片的归档预览。另有 ${pendingCount} 张尚未进入预览，${ignoredCount} 张已忽略。` });
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
    setArchivePreviewPlan(null);
    setShowConfirm(false);
    if (canRestorePreviousGroup) {
      const previousGroup = smartSortGroups.find((group) => group.id === batchPreparationUndo.activeSmartSortGroupId);
      const groupKeys = new Set(getSmartSortGroupKeys(previousGroup));
      const restoredGroupPhotos = getVisibleWorkflowPhotos({
        photos: restoredPhotos,
        activeSmartGroupPhotoKeys: groupKeys,
        groupMembershipByPhotoId: smartSortGroupMembershipByPhotoId,
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
    if (previewPhotos.length === 0 || !archivePreviewPlan) {
      setStatus({ type: 'error', text: '请先生成分拣归档预览。' });
      return;
    }
    const missingPreview = previewPhotos.filter((photo) => photo.originalMissing);
    if (missingPreview.length > 0) {
      setStatus({ type: 'error', text: `存在 ${missingPreview.length} 张原图缺失照片，无法确认归档。请重新定位照片文件夹后再操作。` });
      return;
    }
    if (blockProjectMismatch(previewPhotos, '归档')) return;
    setShowConfirm(true);
  }

  async function archivePreviewedPhotos() {
    invalidateBatchPreparationUndo();
    setIsBusy(true);
    try {
      if (!archivePreviewPlan) {
        setStatus({ type: 'error', text: '归档预览计划已失效，请重新生成预览。' });
        return;
      }
      const result = await window.archiveAssistant.archivePhotos({
        activeProject,
        previewPlan: archivePreviewPlan
      });
      assertSuccessfulBusinessResult(result, '执行归档失败。');
      const resultMap = new Map(result.items.map((item) => [item.photoId || item.id, item]));
      const archivedAt = new Date().toISOString();
      const archivedPhotos = photos.map((photo) => {
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
      });
      const firstCommittedItem = result.items.find((item) => item.stage === 'committed');
      const firstPendingItem = result.items.find((item) => item.stage === 'ledger_pending');
      const firstFailedItem = result.items.find((item) => ['copy_failed', 'target_conflict'].includes(item.stage));
      const nextFilter = firstCommittedItem ? 'archived' : 'previewed';
      const nextActivePhotoId = firstCommittedItem?.photoId || firstPendingItem?.photoId || firstFailedItem?.photoId || '';
      const archivedWorkspace = buildSortWorkspaceSnapshotWorkspace({
        activeProject,
        ...markiWorkbenchStateRef.current,
        photos: archivedPhotos,
        selectedIds: [],
        activePhotoId: nextActivePhotoId,
        archivePreviewPlan: result.status === 'committed' ? null : archivePreviewPlan,
        filter: nextFilter,
        smartSortViewMode: 'statusFilter',
        activeSmartSortGroupId: '',
        page: 1
      });
      const snapshotResult = await saveAutomaticSnapshotImmediately(archivedWorkspace);
      setPhotos(archivedPhotos);
      setArchivePreviewPlan(result.status === 'committed' ? null : archivePreviewPlan);
      setSelectedIds([]);
      setShowConfirm(false);
      switchStatusFilter(nextFilter);
      setSmartSortViewMode('statusFilter');
      setActiveSmartSortGroupId('');
      setActivePhotoId(nextActivePhotoId);
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
        type: snapshotResult?.success !== true
          ? 'warning'
          : result.status === 'committed' && !fingerprintWarning
          ? 'success'
          : (result.committedCount > 0 || result.pendingLedgerCount > 0 ? 'warning' : 'error'),
        text: `${summary}${fingerprintWarning ? ` ${fingerprintWarning}` : ''}${snapshotResult?.success !== true ? ' 工作台自动快照暂未更新，软件将继续重试保存。' : ''}`
      });
    } catch (error) {
      recordRuntimeLog({ page: '照片分拣工作台', operation: '确认归档', errorType: '确认归档失败', summary: error.message, error });
      setStatus({ type: 'error', text: `确认归档失败：${error.message}` });
    } finally {
      setIsBusy(false);
    }
  }

  async function openPhotoDirectory() {
    try {
      const result = await window.archiveAssistant.openConfiguredDirectory('photoSource');
      setStatus({
        type: result?.success ? 'success' : 'error',
        text: result?.success
          ? '已打开当前照片来源目录。'
          : result?.message || '照片目录打开失败，请核对目录权限。'
      });
    } catch {
      setStatus({ type: 'error', text: '照片目录打开失败，请核对目录权限。' });
    }
  }

  async function openArchiveDirectory() {
    try {
      const result = await window.archiveAssistant.openConfiguredDirectory('archiveRoot');
      setStatus({
        type: result?.success ? 'success' : 'error',
        text: result?.success
          ? '已打开当前归档根目录。'
          : result?.message || '归档目录打开失败，请核对目录权限。'
      });
    } catch {
      setStatus({ type: 'error', text: '归档目录打开失败，请核对目录权限。' });
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
                <strong>{getWorkflowFilterCount(key, photos, selectedIds, smartSortGroupMembershipByPhotoId)}</strong>
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
              <button type="button" title={selectedSmartResultCount > 0 ? '清除已选照片的智拣执行状态与当前分组；马克平台数据会保留' : '已选照片没有可重置的智拣结果'} onClick={clearSelectedRecognitionResults} disabled={batchActionsBusy || selectedSmartResultCount === 0}>重置智拣结果</button>
              </div>
              <details ref={moreMenuRef} className="sort-toolbar-more">
                <summary>更多</summary>
                <div className="sort-toolbar-more-menu">
                  <span className="sort-toolbar-more-label">目录</span>
                  <button type="button" className="wide" title="打开当前照片目录" onClick={openPhotoDirectory} disabled={batchActionsBusy}>打开照片目录</button>
                  <button type="button" className="wide" title="打开当前归档目录" onClick={openArchiveDirectory} disabled={batchActionsBusy}>打开归档目录</button>
                  <span className="sort-toolbar-more-label">归档进度</span>
                  <button type="button" title="保存当前分拣进度" onClick={saveDraft} disabled={photos.length === 0 || batchActionsBusy}>保存</button>
                  <button type="button" title="恢复已保存的分拣进度" onClick={loadDraft} disabled={!hasSavedDraft || batchActionsBusy}>恢复</button>
                  <span className="sort-toolbar-more-label">马克照片</span>
                  <button type="button" className="wide marki-recovery-menu-action" title="核对并恢复已下载、但未进入工作台的 Marki 照片" onClick={openMarkiRecoveryDialog} disabled={batchActionsBusy}>恢复 Marki 照片</button>
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
                smartSortGroupMember={smartSortGroupPhotoIds.has(photo.id)}
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
                          <StatusBadge
                            photo={photo}
                            recognitionResult={recognitionResultsByPhoto[photo.id]}
                            smartSortGroupMember={smartSortGroupPhotoIds.has(photo.id)}
                          />
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
                      {currentTemplateType === WATERMARK_TEMPLATE_TYPES.UNRESOLVED && (
                        <label className="field wide">
                          <span>水印模板<b>*</b></span>
                          <select
                            value=""
                            disabled={currentFormLocked}
                            onChange={(event) => {
                              const watermarkTemplateType = event.target.value;
                              const fixedCategory = watermarkTemplateType === WATERMARK_TEMPLATE_TYPES.TIME_LOCATION
                                ? '时间地点水印'
                                : watermarkTemplateType === WATERMARK_TEMPLATE_TYPES.VEHICLE_VIOLATION
                                  ? '机动车违规管理'
                                  : '';
                              updateForm({
                                watermarkTemplateType,
                                ...(fixedCategory && Object.hasOwn(configs.watermarkCategories, fixedCategory)
                                  ? {
                                      watermarkCategory: fixedCategory,
                                      archiveCategory: fixedCategory,
                                      workContent: watermarkTemplateType === WATERMARK_TEMPLATE_TYPES.TIME_LOCATION
                                        ? NOT_APPLICABLE_WORK_CONTENT
                                        : ''
                                    }
                                  : {})
                              });
                            }}
                          >
                            <option value="">请选择水印模板</option>
                            <option value={WATERMARK_TEMPLATE_TYPES.STANDARD_WORK_RECORD}>正常工作记录水印</option>
                            <option value={WATERMARK_TEMPLATE_TYPES.TIME_LOCATION}>时间地点水印</option>
                            <option value={WATERMARK_TEMPLATE_TYPES.VEHICLE_VIOLATION}>机动车违规管理水印</option>
                          </select>
                        </label>
                      )}
                      <InputField label="日期" type="date" value={form.date} onChange={(date) => updateForm({ date })} required disabled={currentFormLocked} />
                      <div className="field">
                        <span>当前项目<b>*</b></span>
                        <strong>{activeProject.projectName}</strong>
                        <small>项目由当前工作上下文确定，不可在表单中修改。</small>
                      </div>
                      <SelectField
                        label="归档分类"
                        value={form.watermarkCategory}
                        options={Object.keys(configs.watermarkCategories)}
                        onChange={(watermarkCategory) => updateForm({ watermarkCategory, workContent: '' })}
                        required
                        disabled={currentFormLocked || currentIsTimeLocation || currentIsVehicleViolation}
                      />
                      {!currentIsTimeLocation && !currentIsVehicleViolation && (
                        <SelectField
                          label="工作内容"
                          value={form.workContent}
                          options={includeCurrentFormOption(
                            configs.watermarkCategories?.[form.watermarkCategory]?.items,
                            form.workContent
                          )}
                          onChange={(workContent) => updateForm({ workContent })}
                          required
                          disabled={currentFormLocked || !form.watermarkCategory}
                          wide
                        />
                      )}
                      {currentIsTimeLocation && (
                        <InputField label="工作内容" value="不适用" onChange={() => {}} disabled wide />
                      )}
                      {currentIsVehicleViolation && (
                        <>
                          <SelectField
                            label="违停类型"
                            value={form.violationType}
                            options={configs.watermarkCategories?.[form.watermarkCategory]?.items || []}
                            onChange={(violationType) => updateForm({ violationType })}
                            required
                            disabled={currentFormLocked}
                            wide
                          />
                          <InputField
                            label="车牌号码"
                            value={form.vehiclePlate}
                            onChange={(vehiclePlate) => updateForm({ vehiclePlate: vehiclePlate.toUpperCase() })}
                            required
                            disabled={currentFormLocked}
                          />
                        </>
                      )}
                      {currentIsEngineering && (
                        <SelectField
                          label="施工单位"
                          value={form.constructionUnitName}
                          options={currentConstructionUnits.map((item) => item.name)}
                          onChange={(constructionUnitName) => updateForm({ constructionUnitName })}
                          required
                          disabled={currentFormLocked || !form.projectId}
                          wide
                        />
                      )}
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
      <MarkiRehydrateDialog
        open={showMarkiRecovery}
        items={markiRecoveryCandidates}
        selectedTokens={selectedMarkiRecoveryTokens}
        busy={isMarkiRecoveryBusy}
        notice={markiRecoveryNotice}
        onToggle={toggleMarkiRecoverySelection}
        onRefresh={scanDownloadedMarkiPhotos}
        onRecoverSelected={() => recoverDownloadedMarkiPhotos(selectedMarkiRecoveryTokens)}
        onRecoverAll={recoverDownloadedMarkiPhotos}
        onClose={closeMarkiRecoveryDialog}
      />
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

function PhotoCard({ photo, recognitionResult, smartSortGroupMember, selected, current, onClick, onSelect }) {
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
        <StatusBadge
          photo={photo}
          recognitionResult={recognitionResult}
          smartSortGroupMember={smartSortGroupMember}
        />
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

function StatusBadge({ photo, recognitionResult, smartSortGroupMember = false }) {
  const status = photo?.sortStatus || '';
  return (
    <span className={`sort-status-badge ${photo?.originalMissing ? 'failed' : status}`}>
      {getPhotoWorkflowStatus(photo, { recognitionResult, smartSortGroupMember })}
    </span>
  );
}

function reconcileForm(current, configs, activeProject) {
  const categories = Object.keys(configs.watermarkCategories || {});
  const watermarkCategory = categories.includes(current.watermarkCategory) ? current.watermarkCategory : '';
  return applyActiveProjectToArchiveInfo({
    ...defaultForm,
    ...current,
    watermarkCategory,
    archiveCategory: watermarkCategory,
    workContent: current.watermarkTemplateType === WATERMARK_TEMPLATE_TYPES.TIME_LOCATION
      ? NOT_APPLICABLE_WORK_CONTENT
      : String(current.workContent || '').trim()
  }, activeProject, current.projectAssignmentSource || current.projectSource);
}

function includeCurrentFormOption(options, currentValue) {
  const values = Array.isArray(options) ? [...options] : [];
  const current = String(currentValue || '').trim();
  if (current && !values.includes(current)) values.push(current);
  return values;
}

function normalizeArchiveInfo(form, activeProject) {
  return applyActiveProjectToArchiveInfo({
    ...form,
    watermarkCategory: form.watermarkCategory,
    archiveCategory: form.watermarkCategory,
    workContent: form.watermarkTemplateType === WATERMARK_TEMPLATE_TYPES.TIME_LOCATION
      ? NOT_APPLICABLE_WORK_CONTENT
      : form.watermarkTemplateType === WATERMARK_TEMPLATE_TYPES.VEHICLE_VIOLATION
        ? form.violationType
        : form.workContent,
    location: form.locationArea || form.location,
    locationArea: form.locationArea || form.location,
    date: form.date,
    keywords: form.keywords,
    remark: form.remarks || form.remark,
    remarks: form.remarks || form.remark
  }, activeProject, form.projectAssignmentSource || form.projectSource);
}

function buildSmartSortCanonicalMaps({
  photos = [],
  recognitionResultsByPhoto = {},
  watermarkRecordsByPhoto = {},
  photoDraftByPhotoId = {},
  configs = {},
  activeProject = null
} = {}) {
  const sourceCanonicalByPhotoId = Object.fromEntries(photos.map((photo) => [
    photo.id,
    buildSourceCanonical({
      photo,
      recognitionResult: recognitionResultsByPhoto[photo.id],
      watermarkRecord: watermarkRecordsByPhoto[photo.id],
      sourceAwareProcessing: recognitionResultsByPhoto[photo.id]?.sourceAwareProcessing,
      configs,
      activeProject
    })
  ]));
  const effectiveArchiveInfoByPhotoId = Object.fromEntries(photos.map((photo) => [
    photo.id,
    resolveEffectivePhotoArchiveInfo({
      photo,
      sourceCanonical: sourceCanonicalByPhotoId[photo.id],
      sourceAwareProcessing: recognitionResultsByPhoto[photo.id]?.sourceAwareProcessing,
      photoDraft: photoDraftByPhotoId[photo.id],
      activeProject
    })
  ]));
  return { sourceCanonicalByPhotoId, effectiveArchiveInfoByPhotoId };
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

function getRecognitionStageStatusBeforeIgnore(result = null) {
  const outcome = getRecognitionOutcome(result);
  if (outcome === 'manual_pending') return 'pending_review';
  if (outcome === 'resolved') return 'reviewed';
  return 'staged';
}

async function rollbackIgnoredRecognitionStages(
  photos = [],
  recognitionMap = {},
  stageStatusByPhotoId = {}
) {
  await Promise.all(photos.map(async (photo) => {
    const result = recognitionMap[photo?.id];
    if (!result?.stagedResultId) return;
    try {
      await updateStagedResultStatus(
        result.stagedResultId,
        stageStatusByPhotoId?.[photo.id] || 'staged'
      );
    } catch {
      // The snapshot error is reported by the caller; rollback is best effort.
    }
  }));
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

function getPhotoWorkflowStatus(
  photo,
  {
    recognitionResult = null,
    requiredFieldsComplete,
    smartSortGroupMember = false
  } = {}
) {
  if (!photo) return '暂无当前照片';
  const sharedStageLabel = getPhotoWorkflowStageLabel(photo, smartSortGroupMember);
  if (sharedStageLabel) return sharedStageLabel;
  const status = photo.sortStatus || 'unassigned';
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

function filterPhotoMapByIds(input = {}, photoIds = new Set()) {
  return Object.fromEntries(
    Object.entries(input || {}).filter(([photoId]) => photoIds.has(photoId))
  );
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

function assertSuccessfulBusinessResult(result, fallbackMessage) {
  if (result?.success !== false) return result;
  const error = new Error(String(result?.message || result?.error?.message || fallbackMessage).trim());
  error.code = String(result?.errorCode || result?.error?.code || 'business_operation_failed').trim();
  throw error;
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
