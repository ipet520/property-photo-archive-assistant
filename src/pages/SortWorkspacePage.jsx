import { useEffect, useMemo, useRef, useState } from 'react';
import ThumbnailHoverPreview from '../components/ThumbnailHoverPreview.jsx';
import {
  SMART_SORT_CONFIDENCE_LABELS,
  SMART_SORT_GROUP_STATUS_LABELS
} from '../constants/smartSort.js';
import { PAGE_KEYS } from '../constants/app.js';
import { formatFileSize, getSuggestedKeywords } from '../utils/formatters.js';
import { recordRuntimeLog } from '../utils/runtimeLogger.js';
import { getUsableArchiveRoot, withRuntimeConfigFallback } from '../utils/runtimeConfig.js';
import {
  buildArchiveSuggestion,
  clearArchiveSuggestionForPhoto,
  clearRecognitionForPhoto,
  confirmArchiveSuggestion,
  getSuggestionSourceLabel,
  getPreviewDisabledReason,
  parseWatermarkRecord,
  regenerateArchiveSuggestion,
  sanitizeDraftFields,
  updateArchiveSuggestion,
  validateSortForm
} from '../utils/sortRightPanelState.js';
import {
  clearStagedResultsByPhoto,
  recognizePhoto
} from '../utils/recognitionClient.js';
import {
  clearSmartSortGroups,
  generateSmartSortGroups
} from '../utils/smartSortClient.js';

const defaultForm = {
  photoSource: '工作照片',
  project: '',
  department: '',
  watermarkCategory: '',
  workContent: '',
  date: new Date().toISOString().slice(0, 10),
  location: '',
  itemName: '',
  photoStage: '',
  processStatus: '',
  keywords: '',
  remark: '',
  locationPlaceholder: ''
};

const statusLabels = {
  unassigned: '未归档',
  unrecognized: '未识别',
  recognizing: '识别中',
  recognition_failed: '识别失败',
  recognized: '已识别',
  suggestion_ready: '已有建议',
  needs_completion: '待补充',
  confirmed: '已确认',
  assigned: '已分拣',
  previewed: '已预览',
  archived: '已归档',
  failed: '归档失败',
  archive_failed: '归档失败',
  ignored: '已忽略'
};

const statusFilters = [
  ['all', '全部照片'],
  ['unassigned', '未归档'],
  ['selected', '已选择'],
  ['assigned', '已分拣'],
  ['previewed', '已生成预览'],
  ['archived', '已归档'],
  ['failed', '归档失败'],
  ['ignored', '已忽略']
];

const viewModes = [
  { key: 'grid', label: '网格', title: '网格视图' },
  { key: 'list', label: '列表', title: '列表视图' }
];

const sortDraftAvailableKey = 'property-photo-sort-draft-available';
const sortSessionPhotoFolderKey = 'property-photo-sort-session-folder';

function resolveEffectivePhotoFolder(loadedSettings, sessionPhotoFolder) {
  const defaultPhotoFolder = loadedSettings?.pathStatus?.defaultPhotoFolderExists
    ? String(loadedSettings.defaultPhotoFolder || '').trim()
    : '';
  return defaultPhotoFolder || String(sessionPhotoFolder || '').trim();
}

export default function SortWorkspacePage({ archiveState, onNavigate }) {
  const rightPanelRef = useRef(null);
  const photoBrowserRef = useRef(null);
  const sessionPhotoFolderRef = useRef(window.sessionStorage.getItem(sortSessionPhotoFolderKey) || '');
  const [configs, setConfigs] = useState(null);
  const [settings, setSettings] = useState(null);
  const [photoFolder, setPhotoFolder] = useState('');
  const [archiveRoot, setArchiveRoot] = useState('');
  const [photos, setPhotos] = useState([]);
  const [form, setForm] = useState(defaultForm);
  const [filter, setFilter] = useState('all');
  const [searchText, setSearchText] = useState('');
  const [viewMode, setViewMode] = useState('grid');
  const [sortMode, setSortMode] = useState('timeAsc');
  const [selectedIds, setSelectedIds] = useState([]);
  const [activePhotoId, setActivePhotoId] = useState('');
  const [lastClickedId, setLastClickedId] = useState(null);
  const [editingPhotoId, setEditingPhotoId] = useState('');
  const [lastDraftSavedAt, setLastDraftSavedAt] = useState('');
  const [hasSavedDraft, setHasSavedDraft] = useState(() => window.localStorage.getItem(sortDraftAvailableKey) === 'true');
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [status, setStatus] = useState({ type: 'idle', text: '请选择照片文件夹并扫描照片。' });
  const [isBusy, setIsBusy] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [smartSortResult, setSmartSortResult] = useState(null);
  const [smartSortViewMode, setSmartSortViewMode] = useState('statusFilter');
  const [activeSmartSortGroupId, setActiveSmartSortGroupId] = useState('');
  const [smartSortMessage, setSmartSortMessage] = useState({ type: 'idle', text: '' });
  const [isSmartSortBusy, setIsSmartSortBusy] = useState(false);
  const [recognitionResultsByPhoto, setRecognitionResultsByPhoto] = useState({});
  const [watermarkRecordsByPhoto, setWatermarkRecordsByPhoto] = useState({});
  const [archiveSuggestionsByPhoto, setArchiveSuggestionsByPhoto] = useState({});
  const [isRecognitionBusy, setIsRecognitionBusy] = useState(false);
  const [recognitionMessage, setRecognitionMessage] = useState({ type: 'idle', text: '' });
  const [rightPanelMode, setRightPanelMode] = useState('form');

  useEffect(() => {
    Promise.all([
      window.archiveAssistant.loadConfigs(),
      window.archiveAssistant.loadSettings()
    ]).then(([loadedConfigs, loadedSettings]) => {
      const safeConfigs = withRuntimeConfigFallback(loadedConfigs);
      const restoredPhotoFolder = resolveEffectivePhotoFolder(loadedSettings, sessionPhotoFolderRef.current);
      const restoredArchiveRoot = getUsableArchiveRoot(loadedSettings);
      setConfigs(safeConfigs);
      setSettings(loadedSettings);
      setForm(reconcileForm(defaultForm, safeConfigs));
      setPhotoFolder(restoredPhotoFolder);
      if (restoredPhotoFolder) {
        setStatus({ type: 'idle', text: '点击扫描读取当前照片目录。' });
      }
      if (restoredArchiveRoot) setArchiveRoot(restoredArchiveRoot);
    }).catch((error) => {
      const safeConfigs = withRuntimeConfigFallback(null);
      setConfigs(safeConfigs);
      setForm(reconcileForm(defaultForm, safeConfigs));
      setStatus({ type: 'error', text: `配置加载失败：${error.message}` });
    });
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
    const keyword = searchText.trim().toLowerCase();
    return photos
      .filter((photo) => {
        if (activeSmartGroupPhotoKeys) return activeSmartGroupPhotoKeys.has(photo.id) || activeSmartGroupPhotoKeys.has(photo.originalPath);
        if (filter === 'all') return !isIgnoredPhoto(photo);
        if (filter === 'selected') return selectedIds.includes(photo.id) && !isIgnoredPhoto(photo);
        if (filter === 'ignored') return isIgnoredPhoto(photo);
        if (filter === 'assigned') return ['assigned', 'confirmed'].includes(photo.sortStatus);
        if (filter === 'failed') return ['failed', 'archive_failed'].includes(photo.sortStatus);
        return photo.sortStatus === filter;
      })
      .filter((photo) => {
        if (!keyword) return true;
        return [photo.originalName, photo.archiveInfo?.remark, photo.archiveInfo?.workContent, photo.archiveInfo?.itemName]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(keyword));
      })
      .sort((a, b) => {
        if (sortMode === 'nameAsc') return a.originalName.localeCompare(b.originalName, 'zh-CN');
        if (sortMode === 'nameDesc') return b.originalName.localeCompare(a.originalName, 'zh-CN');
        if (sortMode === 'timeDesc') return String(b.modifiedAt || '').localeCompare(String(a.modifiedAt || ''));
        return String(a.modifiedAt || '').localeCompare(String(b.modifiedAt || ''));
      });
  }, [photos, activeSmartGroupPhotoKeys, filter, searchText, selectedIds, sortMode]);

  const totalPages = Math.max(1, Math.ceil(visiblePhotos.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pagePhotos = visiblePhotos.slice((safePage - 1) * pageSize, safePage * pageSize);
  const selectedPhotos = photos.filter((photo) => selectedIds.includes(photo.id));
  const visiblePhotoIds = useMemo(() => new Set(visiblePhotos.map((photo) => photo.id)), [visiblePhotos]);
  const activePhoto = photos.find((photo) => photo.id === activePhotoId) || null;
  const assignedCount = photos.filter((photo) => ['assigned', 'confirmed'].includes(photo.sortStatus) && photo.archiveInfo).length;
  const previewPhotos = selectedPhotos.filter((photo) => photo.sortStatus === 'previewed' && photo.previewInfo);
  const unassignedCount = photos.filter((photo) => photo.sortStatus === 'unassigned').length;
  const ignoredCount = photos.filter((photo) => photo.sortStatus === 'ignored').length;
  const missingOriginalCount = photos.filter((photo) => photo.originalMissing).length;
  const editingPhoto = photos.find((photo) => photo.id === editingPhotoId) || null;
  const effectivePhotoFolder = resolveEffectivePhotoFolder(settings, sessionPhotoFolderRef.current);
  const selectedStateText = getSelectedStateText(selectedPhotos);
  const selectedHasIgnored = selectedPhotos.some(isIgnoredPhoto);
  const selectedAssignedCount = selectedPhotos.filter((photo) => photo.archiveInfo && ['assigned', 'confirmed'].includes(photo.sortStatus) && !isArchivedPhoto(photo) && !isIgnoredPhoto(photo)).length;
  const selectedPreviewCount = selectedPhotos.filter((photo) => photo.sortStatus === 'previewed' && photo.previewInfo && !isIgnoredPhoto(photo)).length;
  const selectedRecognitionCount = selectedPhotos.filter((photo) => recognitionResultsByPhoto[photo.id]).length;
  const currentPanelPhoto = activePhoto && visiblePhotoIds.has(activePhoto.id) ? activePhoto : null;
  const currentRecognitionPhoto = currentPanelPhoto;
  const currentRecognitionResult = currentRecognitionPhoto ? recognitionResultsByPhoto[currentRecognitionPhoto.id] : null;
  const currentWatermarkRecord = currentPanelPhoto ? watermarkRecordsByPhoto[currentPanelPhoto.id] : null;
  const currentArchiveSuggestion = currentPanelPhoto ? archiveSuggestionsByPhoto[currentPanelPhoto.id] : null;
  const currentPhotoIndex = currentPanelPhoto ? visiblePhotos.findIndex((photo) => photo.id === currentPanelPhoto.id) : -1;
  const currentPhotoPosition = currentPhotoIndex >= 0 ? `${currentPhotoIndex + 1} / ${visiblePhotos.length}` : `0 / ${visiblePhotos.length}`;
  const currentPhotoStatusText = getCurrentPhotoStatusText({
    photo: currentPanelPhoto,
    recognitionResult: currentRecognitionResult,
    suggestion: currentArchiveSuggestion,
    isRecognitionBusy
  });
  const currentOcrStatusText = getCurrentOcrStatusText({
    recognitionResult: currentRecognitionResult,
    suggestion: currentArchiveSuggestion,
    isRecognitionBusy
  });
  const recognitionSuggestion = useMemo(() => buildRecognitionSuggestion(currentRecognitionResult), [currentRecognitionResult]);
  const recognitionSummary = useMemo(() => summarizeRecognitionResults(recognitionResultsByPhoto), [recognitionResultsByPhoto]);
  const previewDisabledReason = getPreviewDisabledReason({
    isBusy,
    selectedIds,
    selectedHasIgnored,
    selectedAssignedCount,
    assignedCount,
    suggestion: currentArchiveSuggestion
  });
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
    result: currentRecognitionResult
  });
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  useEffect(() => {
    if (photos.length === 0 && smartSortResult) {
      resetSmartSortState({ type: 'idle', text: '' });
    }
    if (photos.length === 0 && activePhotoId) {
      setActivePhotoId('');
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
    if (!smartSortGroups.length) return;
    const hasInvalidGroupPhoto = smartSortGroups.some((group) => getSmartSortGroupKeys(group).some((key) => !currentPhotoKeySet.has(key)));
    const groupedPhotoCount = smartSortGroups.reduce((sum, group) => sum + getSmartSortGroupPhotoCount(group), 0);
    const expectedPhotoCount = Number(smartSortResult?.photoCount) || photos.length;
    const countMismatch = expectedPhotoCount > 0 && groupedPhotoCount > 0 && groupedPhotoCount !== expectedPhotoCount;
    if (photos.length === 0 || hasInvalidGroupPhoto || countMismatch) {
      resetSmartSortState({ type: 'idle', text: '当前照片列表已变化，请重新执行智能分拣。' });
    }
  }, [currentPhotoKeySet, photos.length, smartSortGroups, smartSortResult?.photoCount]);

  useEffect(() => {
    if (visiblePhotos.length === 0) {
      if (activePhotoId) setActivePhotoId('');
      return;
    }
    if (!activePhotoId || !visiblePhotoIds.has(activePhotoId)) {
      setActivePhotoId(visiblePhotos[0].id);
    }
  }, [activePhotoId, visiblePhotoIds, visiblePhotos]);

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
  }, [currentPanelPhoto?.id, configs, archiveSuggestionsByPhoto]);

  useEffect(() => {
    rightPanelRef.current?.scrollTo({ top: 0 });
  }, []);

  function markChanged() {
    setHasUnsavedChanges(true);
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
    return photo.sortStatus === 'previewed' ? resetPhotoPreview(photo, 'confirmed') : photo;
  }

  function isArchivedPhoto(photo) {
    return photo.sortStatus === 'archived';
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
    return selectedPhotos.filter((photo) => !isArchivedPhoto(photo) && !isIgnoredPhoto(photo));
  }

  function updateForm(patch, options = {}) {
    setForm((current) => {
      const next = { ...current, ...patch };
      if (patch.watermarkCategory) {
        const items = configs?.watermarkCategories?.[patch.watermarkCategory]?.items || [];
        if (!items.includes(next.workContent)) next.workContent = '';
      }
      if (!options.preserveKeywords && (patch.watermarkCategory || patch.workContent || patch.itemName || patch.location || patch.processStatus)) {
        next.keywords = getSuggestedKeywords({ ...toArchiveForm(next), workItem: next.itemName }, configs);
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
    resetSmartSortState({ type: 'idle', text: '' });
    setRecognitionResultsByPhoto({});
    setWatermarkRecordsByPhoto({});
    setArchiveSuggestionsByPhoto({});
    setRecognitionMessage({ type: 'idle', text: '' });
    void clearSmartSortGroups();
    try {
      const scanned = await window.archiveAssistant.scanImages(folder);
      setPhotos(scanned.map((photo) => ({
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
      })));
      setSelectedIds([]);
      setActivePhotoId(scanned[0]?.id || '');
      setPage(1);
      setFilter('all');
      setSmartSortViewMode('statusFilter');
      setActiveSmartSortGroupId('');
      setEditingPhotoId('');
      markChanged();
      setStatus({ type: 'success', text: `扫描完成，共找到 ${scanned.length} 张照片。` });
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
    markChanged();
    void synchronizePhotoFolderFromSettings();
    setStatus({ type: 'success', text: '已清空当前分拣列表，原始照片未受影响。' });
  }

  async function generateSmartGroups(targetPhotos = photos, recognitionMap = recognitionResultsByPhoto, options = {}) {
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
      const result = await generateSmartSortGroups(normalizePhotosForSmartSort(targetPhotos, recognitionMap, options.suggestionMap || archiveSuggestionsByPhoto), {
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
        setSmartSortMessage({ type: 'success', text: `已分拣 ${groupedPhotoCount} 张照片，生成 ${result.groupCount} 个分组。` });
      } else {
        setSmartSortMessage({ type: 'warning', text: '当前照片缺少足够识别信息，暂未形成有效分组，您仍可手动选择照片进行归档。' });
      }
    } catch (error) {
      setSmartSortMessage({ type: 'error', text: `分拣组生成失败：${error.message}` });
    } finally {
      setIsSmartSortBusy(false);
    }
  }

  async function recognizeSelected({ alsoSort = false } = {}) {
    if (isBusy || isSmartSortBusy || isRecognitionBusy) {
      setRecognitionMessage({ type: 'warning', text: '照片扫描、识别或智能分拣正在进行，请稍候。' });
      return;
    }
    const targets = selectedPhotos.filter((photo) => !isIgnoredPhoto(photo));
    if (targets.length === 0) {
      setRecognitionMessage({ type: 'warning', text: '请先选择需要处理的照片。' });
      return;
    }
    setIsRecognitionBusy(true);
    setRecognitionMessage({ type: 'idle', text: `正在识别 0 / ${targets.length}` });
    try {
      const results = [];
      for (let index = 0; index < targets.length; index += 1) {
        setRecognitionMessage({ type: 'idle', text: `正在识别 ${index + 1} / ${targets.length}` });
        const result = await recognizePhoto(toRecognitionPhoto(targets[index]), { allowCloudUpload: false });
        results.push(result);
      }
      const nextMap = {
        ...recognitionResultsByPhoto,
        ...Object.fromEntries(results.map((result, index) => [targets[index].id, result]))
      };
      setRecognitionResultsByPhoto(nextMap);
      const watermarkEntries = Object.fromEntries(results.map((result, index) => {
        const photo = targets[index];
        return [photo.id, parseWatermarkRecord({ ...result, photoId: photo.id })];
      }));
      const suggestionEntries = Object.fromEntries(results.map((result, index) => {
        const photo = targets[index];
        const watermarkRecord = watermarkEntries[photo.id];
        const isSuccess = result.status === 'success' || result.success === true;
        if (!isSuccess) return null;
        return [photo.id, buildArchiveSuggestion(watermarkRecord, buildArchiveSuggestionContext({ configs, form, photoFolder, archiveRoot, photo }))];
      }).filter(Boolean));
      setWatermarkRecordsByPhoto((current) => ({ ...current, ...watermarkEntries }));
      setArchiveSuggestionsByPhoto((current) => ({ ...current, ...suggestionEntries }));
      setPhotos((current) => current.map((photo) => {
        const suggestion = suggestionEntries[photo.id];
        const recognizedResult = nextMap[photo.id];
        if (isIgnoredPhoto(photo) || isArchivedPhoto(photo)) return photo;
        if (recognizedResult && !suggestion) {
          return {
            ...photo,
            sortStatus: recognizedResult.status === 'success' || recognizedResult.success === true ? 'recognized' : 'recognition_failed',
            previewInfo: null,
            archiveResult: null
          };
        }
        if (!suggestion) return photo;
        return {
          ...photo,
          sortStatus: suggestion.status === 'needs_completion'
            ? 'needs_completion'
            : (recognizedResult?.status === 'success' || recognizedResult?.success === true ? 'suggestion_ready' : 'recognition_failed'),
          previewInfo: null,
          archiveResult: null
        };
      }));
      const panelPhotoId = currentPanelPhoto?.id || targets[0]?.id;
      if (panelPhotoId && suggestionEntries[panelPhotoId]) {
        setForm(sanitizeDraftFields(suggestionEntries[panelPhotoId].suggestedFields, configs));
      }
      const successCount = results.filter((result) => result.status === 'success' && result.rawText).length;
      const failedCount = results.length - successCount;
      setRecognitionMessage({ type: failedCount ? 'warning' : 'success', text: `识别完成：成功 ${successCount} 张，待确认/失败 ${failedCount} 张。` });
      setRightPanelMode('form');
      if (!currentPanelPhoto || !targets.some((photo) => photo.id === currentPanelPhoto.id)) {
        setActivePhotoId(targets[0]?.id || '');
      }
      setSelectedIds([]);
      if (alsoSort) {
        const hasExecutedOcr = results.some(hasLocalOcrExecuted);
        if (!hasExecutedOcr && successCount === 0) {
          setSmartSortMessage({ type: 'error', text: '未检测到可用 OCR 引擎，无法执行智能识别分拣。' });
          return;
        }
        await generateSmartGroups(targets, nextMap, { source: 'selected_photos', suggestionMap: { ...archiveSuggestionsByPhoto, ...suggestionEntries } });
      }
    } catch (error) {
      setRecognitionMessage({ type: 'error', text: `识别失败：${error.message || '未知错误'}` });
    } finally {
      setIsRecognitionBusy(false);
    }
  }

  async function clearSelectedRecognitionResults() {
    if (selectedPhotos.length === 0) {
      setRecognitionMessage({ type: 'warning', text: '请先选择需要清空识别结果的照片。' });
      return;
    }
    const selectedSet = new Set(selectedPhotos.map((photo) => photo.id));
    setRecognitionResultsByPhoto((current) => Object.fromEntries(Object.entries(current).filter(([photoId]) => !selectedSet.has(photoId))));
    setWatermarkRecordsByPhoto((current) => Object.fromEntries(Object.entries(current).filter(([photoId]) => !selectedSet.has(photoId))));
    await Promise.allSettled(selectedPhotos.map((photo) => clearStagedResultsByPhoto(toRecognitionPhoto(photo))));
    resetSmartSortState({ type: 'idle', text: '已清空已选照片识别结果，请重新识别后再分拣。' });
    setRecognitionMessage({ type: 'success', text: '已清空已选照片识别结果和水印事实，未修改归档建议、照片或台账。' });
    setRightPanelMode('form');
  }

  async function clearSmartGroups() {
    const success = await clearSmartSortGroups();
    if (success) {
      resetSmartSortState({ type: 'success', text: '已清除智能分拣分组结果，照片和归档信息未受影响。' });
    } else {
      setSmartSortMessage({ type: 'error', text: '清空分组失败，照片和归档信息未受影响。' });
    }
  }

  function applyStatusFilter(nextFilter) {
    setFilter(nextFilter);
    setSmartSortViewMode('statusFilter');
    setActiveSmartSortGroupId('');
    setSelectedIds([]);
    setPage(1);
  }

  function viewSmartGroup(groupId) {
    if (activeSmartSortGroupId === groupId && smartSortViewMode === 'smartSortGroup') {
      setSmartSortViewMode('statusFilter');
      setActiveSmartSortGroupId('');
      setSelectedIds([]);
      setPage(1);
      setSmartSortMessage({ type: 'idle', text: '已取消当前分组筛选，恢复按状态筛选查看。' });
      return;
    }
    setSmartSortViewMode('smartSortGroup');
    setActiveSmartSortGroupId(groupId);
    setSelectedIds([]);
    setPage(1);
    const group = smartSortGroups.find((item) => item.id === groupId);
    if (group) {
      setSmartSortMessage({ type: 'idle', text: `当前查看“${group.title}”，未自动选择照片、未填表、未归档。` });
    }
  }

  function goToAdjacentPhoto(offset) {
    if (visiblePhotos.length === 0) return;
    const currentIndex = currentPhotoIndex >= 0 ? currentPhotoIndex : 0;
    const nextIndex = Math.min(visiblePhotos.length - 1, Math.max(0, currentIndex + offset));
    setActivePhotoId(visiblePhotos[nextIndex]?.id || '');
  }

  function createManualArchiveSuggestion() {
    const target = currentPanelPhoto;
    if (!target) {
      setStatus({ type: 'warning', text: '请先点击一张照片作为当前照片。' });
      return;
    }
    const nextSuggestion = updateArchiveSuggestion(archiveSuggestionsByPhoto[target.id], {
      photoSource: '工作照片',
      project: form.project || configs.projects?.[0] || '',
      date: form.date || new Date().toISOString().slice(0, 10)
    }, {
      configs,
      photoId: target.id
    });
    setArchiveSuggestionsByPhoto((current) => ({ ...current, [target.id]: nextSuggestion }));
    setForm(sanitizeDraftFields(nextSuggestion.suggestedFields, configs));
    setPhotos((current) => current.map((photo) => {
      if (photo.id !== target.id || isArchivedPhoto(photo) || isIgnoredPhoto(photo) || photo.archiveInfo) return photo;
      return { ...photo, sortStatus: nextSuggestion.status === 'needs_completion' ? 'needs_completion' : 'suggestion_ready' };
    }));
    setRightPanelMode('form');
    markChanged();
    setStatus({ type: 'success', text: '已为当前照片新建归档建议，请补充核心字段后确认。' });
  }

  function handlePhotoClick(photo) {
    setActivePhotoId(photo.id);
  }

  function togglePhotoSelection(photo, event = {}) {
    const visibleIds = visiblePhotos.map((item) => item.id);
    if (event.shiftKey && lastClickedId && visibleIds.includes(lastClickedId)) {
      const start = visibleIds.indexOf(lastClickedId);
      const end = visibleIds.indexOf(photo.id);
      const range = visibleIds.slice(Math.min(start, end), Math.max(start, end) + 1);
      setSelectedIds((current) => Array.from(new Set([...current, ...range])));
    } else if (event.ctrlKey || event.metaKey) {
      setSelectedIds((current) => current.includes(photo.id) ? current.filter((id) => id !== photo.id) : [...current, photo.id]);
    } else {
      setSelectedIds((current) => current.includes(photo.id) ? current.filter((id) => id !== photo.id) : [photo.id]);
    }
    setLastClickedId(photo.id);
  }

  function selectCurrentPage() {
    setSelectedIds((current) => Array.from(new Set([...current, ...pagePhotos.map((photo) => photo.id)])));
  }

  function invertCurrentPage() {
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

  function markIgnored() {
    if (selectedIds.length === 0) {
      setStatus({ type: 'error', text: '请先选择需要标记忽略的照片。' });
      return;
    }
    const targetPhotos = selectedPhotos.filter((photo) => !isArchivedPhoto(photo) && !isIgnoredPhoto(photo));
    if (targetPhotos.length === 0) {
      setStatus({ type: 'warning', text: '当前没有可标记忽略的照片。' });
      return;
    }
    const targetIdSet = new Set(targetPhotos.map((photo) => photo.id));
    const invalidTip = invalidatePreviewMessage();
    setPhotos((current) => current.map((photo) => {
      if (targetIdSet.has(photo.id)) return { ...photo, sortStatus: 'ignored', previewInfo: null, archiveResult: null };
      return invalidTip ? clearGeneratedPreview(photo) : photo;
    }));
    setSelectedIds((current) => current.filter((id) => !targetIdSet.has(id)));
    setEditingPhotoId((current) => targetIdSet.has(current) ? '' : current);
    markChanged();
    setStatus({ type: invalidTip ? 'warning' : 'success', text: `已标记忽略 ${targetPhotos.length} 张照片，原图未受影响。${invalidTip}` });
  }

  function cancelIgnored() {
    const targetPhotos = selectedPhotos.filter(isIgnoredPhoto);
    if (targetPhotos.length === 0) {
      setStatus({ type: 'warning', text: '请先在已忽略列表中选择需要还原的照片。' });
      return;
    }
    const targetIdSet = new Set(targetPhotos.map((photo) => photo.id));
    const invalidTip = invalidatePreviewMessage();
    setPhotos((current) => current.map((photo) => {
      if (targetIdSet.has(photo.id)) return { ...photo, sortStatus: 'unassigned', archiveInfo: null, previewInfo: null, archiveResult: null };
      return invalidTip ? clearGeneratedPreview(photo) : photo;
    }));
    setSelectedIds((current) => current.filter((id) => !targetIdSet.has(id)));
    setEditingPhotoId((current) => targetIdSet.has(current) ? '' : current);
    markChanged();
    setStatus({ type: invalidTip ? 'warning' : 'success', text: `已还原 ${targetPhotos.length} 张已忽略照片，状态恢复为未归档。${invalidTip}` });
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
    markChanged();
    setStatus({ type: nextSuggestion.conflictFields.length ? 'warning' : 'success', text: nextSuggestion.conflictFields.length ? `已重新生成当前照片归档建议，保留人工字段：${nextSuggestion.conflictFields.join('、')}` : '已重新生成当前照片归档建议，请确认后预览。' });
  }

  function confirmCurrentArchiveDraft() {
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
    const result = confirmArchiveSuggestion(currentSuggestion);
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
    const invalidTip = invalidatePreviewMessage();
    setPhotos((current) => current.map((photo) => {
      if (photo.id === target.id) return { ...photo, sortStatus: 'confirmed', archiveInfo: result.archiveInfo, previewInfo: null, archiveResult: null };
      return invalidTip ? clearGeneratedPreview(photo) : photo;
    }));
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
    markChanged();
    setStatus({ type: nextSuggestion.missingRequiredFields.length ? 'warning' : 'success', text: nextSuggestion.missingRequiredFields.length ? `归档建议已保存，仍待补充：${nextSuggestion.missingRequiredFields.join('、')}` : '归档建议已保存，请确认后预览。' });
  }

  async function clearCurrentRecognitionOnly() {
    const target = currentRecognitionPhoto;
    if (!target) return;
    const cleared = clearRecognitionForPhoto({ recognitionResultsByPhoto, watermarkRecordsByPhoto, photoId: target.id });
    setRecognitionResultsByPhoto(cleared.recognitionResultsByPhoto);
    setWatermarkRecordsByPhoto(cleared.watermarkRecordsByPhoto);
    await clearStagedResultsByPhoto(toRecognitionPhoto(target));
    setRightPanelMode('form');
    setRecognitionMessage({ type: 'success', text: '已清除当前照片识别结果，归档建议未受影响。' });
    setStatus({ type: 'success', text: '已清除当前照片识别结果，归档建议仍保留。' });
  }

  function clearCurrentArchiveDraft() {
    const target = currentPanelPhoto;
    if (!target) {
      setStatus({ type: 'warning', text: '请先选择需要清除建议的照片。' });
      return;
    }
    if (!window.confirm('确定清除当前照片的归档建议吗？\n\n不会清除 OCR 原文。\n不会清除已确认归档信息。\n不会删除、移动或修改原图。')) return;
    const cleared = clearArchiveSuggestionForPhoto({ archiveSuggestionsByPhoto, photoId: target.id });
    setArchiveSuggestionsByPhoto(cleared.archiveSuggestionsByPhoto);
    if (!target.archiveInfo) {
      setPhotos((current) => current.map((photo) => {
        if (photo.id === target.id && !isArchivedPhoto(photo) && !isIgnoredPhoto(photo)) {
          return { ...photo, sortStatus: currentRecognitionResult ? 'recognized' : 'unrecognized' };
        }
        return photo;
      }));
      setForm(reconcileForm(defaultForm, configs));
    }
    markChanged();
    setStatus({ type: 'success', text: '已清除当前照片归档建议，OCR 结果和已确认归档信息未受影响。' });
  }

  function editCurrentPhotoInfo() {
    if (!currentPanelPhoto?.archiveInfo) return;
    setEditingPhotoId(currentPanelPhoto.id);
    setForm(reconcileForm({
      ...defaultForm,
      ...currentPanelPhoto.archiveInfo,
      itemName: currentPanelPhoto.archiveInfo.itemName || currentPanelPhoto.archiveInfo.workItem || '',
      workContent: currentPanelPhoto.archiveInfo.workContent || '',
      location: currentPanelPhoto.archiveInfo.location || ''
    }, configs));
    setStatus({ type: 'idle', text: `已载入当前照片的归档信息，可修改后保存到当前照片。` });
  }

  function saveCurrentPhotoInfo() {
    if (!editingPhoto) {
      setStatus({ type: 'error', text: '请先选择要编辑的已分拣照片。' });
      return;
    }
    const missing = validateSortForm(form);
    if (missing.length) {
      setStatus({ type: 'error', text: `请补全必填项：${missing.join('、')}` });
      return;
    }
    const invalidTip = invalidatePreviewMessage();
    const archiveInfo = normalizeArchiveInfo(form);
    setPhotos((current) => current.map((photo) => {
      if (photo.id === editingPhoto.id) return { ...photo, sortStatus: 'confirmed', archiveInfo, previewInfo: null, archiveResult: null };
      return invalidTip ? clearGeneratedPreview(photo) : photo;
    }));
    setEditingPhotoId('');
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
      activePhotoId,
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
        missingSortStatus: exists ? undefined : photo.sortStatus,
        sortStatus: exists ? photo.sortStatus : 'failed'
      };
    }));
    setPhotoFolder(result.draft.photoFolder || '');
    setArchiveRoot(result.draft.archiveRoot || '');
    setFilter(result.draft.filter || 'all');
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
    setSelectedIds((result.draft.selectedIds || []).filter((id) => loadedPhotos.some((photo) => photo.id === id)));
    setActivePhotoId(result.draft.activePhotoId && loadedPhotos.some((photo) => photo.id === result.draft.activePhotoId)
      ? result.draft.activePhotoId
      : (loadedPhotos[0]?.id || ''));
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
      markChanged();
      setStatus({ type: restoredCount === missingPhotos.length ? 'success' : 'warning', text: `已重新匹配 ${restoredCount} 张照片，仍有 ${missingPhotos.length - restoredCount} 张原图缺失。` });
    } catch (error) {
      recordRuntimeLog({ page: '照片分拣工作台', operation: '重新定位照片文件夹', errorType: '读取目录失败', summary: error.message, error });
      setStatus({ type: 'error', text: `重新定位照片文件夹失败：${error.message}` });
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
    const assigned = selectedPhotos.filter((photo) => ['assigned', 'confirmed'].includes(photo.sortStatus) && photo.archiveInfo && !isIgnoredPhoto(photo) && !isArchivedPhoto(photo));
    if (assigned.length === 0) {
      setStatus({ type: 'error', text: '请先勾选已确认归档信息的照片，再生成归档预览。' });
      return;
    }
    if (assigned.length !== selectedIds.length) {
      setStatus({ type: 'error', text: '已选照片中存在未确认归档信息的照片，请先确认建议后再预览。' });
      return;
    }
    const missingAssigned = assigned.filter((photo) => photo.originalMissing);
    if (missingAssigned.length > 0) {
      setStatus({ type: 'error', text: `存在 ${missingAssigned.length} 张原图缺失的已分拣照片，无法生成归档预览。请重新定位照片文件夹或清除相关记录。` });
      return;
    }
    const invalidPhotos = assigned.filter((photo) => validateSortForm({ ...defaultForm, ...photo.archiveInfo }).length > 0);
    if (invalidPhotos.length > 0) {
      setStatus({ type: 'error', text: `有 ${invalidPhotos.length} 张已分拣照片缺少必填字段，请编辑补全后再生成预览。` });
      return;
    }
    setIsBusy(true);
    try {
      const preview = await window.archiveAssistant.buildArchivePreview({
        form: toArchiveForm(assigned[0].archiveInfo),
        archiveRoot,
        photos: assigned.map((photo) => ({
          ...toArchiveForm(photo.archiveInfo),
          id: photo.id,
          path: photo.originalPath,
          name: photo.originalName,
          extension: photo.extension,
          size: photo.size,
          previewUrl: photo.previewUrl
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
      setFilter('previewed');
      setSmartSortViewMode('statusFilter');
      setActiveSmartSortGroupId('');
      setPage(1);
      window.requestAnimationFrame(() => photoBrowserRef.current?.scrollTo({ top: 0, left: 0 }));
      setStatus({ type: (unassignedCount || ignoredCount) ? 'warning' : 'success', text: `已生成 ${preview.length} 张照片的归档预览，请检查无误后点击归档。未分拣 ${unassignedCount} 张，已忽略 ${ignoredCount} 张未纳入预览。` });
    } catch (error) {
      recordRuntimeLog({ page: '照片分拣工作台', operation: '生成分拣归档预览', errorType: '生成预览失败', summary: error.message, error });
      setStatus({ type: 'error', text: `生成分拣归档预览失败：${error.message}` });
    } finally {
      setIsBusy(false);
    }
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
    setIsBusy(true);
    try {
      const result = await window.archiveAssistant.archivePhotos({ archiveRoot, items: previewPhotos.map((photo) => photo.previewInfo) });
      const resultMap = new Map(result.items.map((item) => [item.id, item]));
      const archivedAt = new Date().toISOString();
      setPhotos((current) => current.map((photo) => {
        const item = resultMap.get(photo.id);
        if (!item) return photo;
        const success = item.status === '归档成功';
        return { ...photo, sortStatus: success ? 'archived' : 'failed', archiveResult: item, previewInfo: item, archiveMethod: '手动分拣', archivedAt: success ? archivedAt : '' };
      }));
      setShowConfirm(false);
      setFilter('archived');
      setPage(1);
      setHasUnsavedChanges(true);
      setStatus({
        type: result.success ? 'success' : 'warning',
        text: result.success
          ? `归档完成，已复制 ${result.successCount} 张照片并追加 Excel 台账，原图仍保留。`
          : `归档完成但存在失败：成功 ${result.successCount} 张，失败 ${result.failedCount} 张。`
      });
    } catch (error) {
      recordRuntimeLog({ page: '照片分拣工作台', operation: '确认归档', errorType: '确认归档失败', summary: error.message, error });
      setStatus({ type: 'error', text: `确认归档失败：${error.message}` });
    } finally {
      setIsBusy(false);
    }
  }

  function openSelectedFolder() {
    if (currentPanelPhoto?.originalPath) {
      window.archiveAssistant.openPath(currentPanelPhoto.originalPath);
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
              <button type="button" key={key} className={smartSortViewMode === 'statusFilter' && filter === key ? 'active' : ''} onClick={() => applyStatusFilter(key)}>
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
          <div className="sort-workspace-toolbar">
            <div className="sort-toolbar-row sort-toolbar-row-primary">
              <div className="sort-toolbar-group">
              <button type="button" className="primary orange" title={effectivePhotoFolder ? '扫描当前照片目录' : '导入照片文件夹并自动扫描'} disabled={isBusy} onClick={importOrScanPhotos}>{effectivePhotoFolder ? '扫描' : '导入'}</button>
              <button type="button" title="清空当前照片列表" onClick={clearList} disabled={photos.length === 0}>清空</button>
              </div>
              <div className="sort-toolbar-group">
              <button type="button" className="icon-action" title="全选当前照片" aria-label="全选当前照片" onClick={selectCurrentPage}>全选</button>
              <button type="button" className="icon-action" title="反选当前照片" aria-label="反选当前照片" onClick={invertCurrentPage}>反选</button>
              <button type="button" className="icon-action" title="取消选择" aria-label="取消选择" onClick={() => setSelectedIds([])}>取消</button>
              </div>
              <div className="sort-toolbar-group">
              <button type="button" className="icon-action" title="忽略选中照片" aria-label="忽略选中照片" onClick={markIgnored}>忽略</button>
              <button type="button" className="icon-action" title="还原选中照片" aria-label="还原选中照片" onClick={cancelIgnored}>还原</button>
              </div>
              <div className="sort-toolbar-group">
              <button type="button" className="primary" title="对已选照片执行水印识别、解析并生成智能分组。" onClick={() => recognizeSelected({ alsoSort: true })} disabled={isRecognitionBusy || isSmartSortBusy || selectedIds.length === 0}>智拣</button>
              <button type="button" title="清空当前已选照片的识别结果" onClick={clearSelectedRecognitionResults} disabled={isRecognitionBusy || selectedIds.length === 0 || selectedRecognitionCount === 0}>清空识别</button>
              <button type="button" title="清空全部智能分拣分组结果" onClick={clearSmartGroups} disabled={isSmartSortBusy || smartSortGroups.length === 0}>清空分组</button>
              </div>
              <div className="sort-toolbar-group sort-view-tools">
              <div className="sort-view-tabs">
              {viewModes.map((mode) => (
                <button type="button" key={mode.key} title={mode.title} className={viewMode === mode.key ? 'active' : ''} onClick={() => setViewMode(mode.key)}>
                  {mode.label}
                </button>
              ))}
              </div>
              <select value={sortMode} onChange={(event) => setSortMode(event.target.value)} aria-label="排序方式">
                <option value="timeAsc">时间升序</option>
                <option value="timeDesc">时间降序</option>
                <option value="nameAsc">文件名升序</option>
                <option value="nameDesc">文件名降序</option>
              </select>
              </div>
              <label className="sort-search">
                <input value={searchText} placeholder="搜索" title="搜索文件名" onChange={(event) => { setSearchText(event.target.value); setPage(1); }} />
              </label>
            </div>
            <div className="sort-toolbar-row sort-toolbar-row-secondary">
              <div className="sort-toolbar-group">
                <span className="sort-toolbar-label">目录</span>
                <button type="button" className="wide" onClick={() => selectPhotoFolder({ scanAfterSelect: true })}>更换照片目录</button>
                <button type="button" className="wide" onClick={selectArchiveRoot}>更换归档目录</button>
              </div>
              <div className="sort-toolbar-group">
                <span className="sort-toolbar-label">进度</span>
                <button type="button" title="保存当前分拣进度" onClick={saveDraft} disabled={photos.length === 0 || isBusy}>保存</button>
                <button type="button" title="恢复已保存的分拣进度" onClick={loadDraft} disabled={!hasSavedDraft || isBusy}>恢复</button>
              </div>
            </div>
          </div>

          <div ref={photoBrowserRef} className={`sort-photo-browser ${viewMode} thumb-standard`}>
            {pagePhotos.length === 0 ? (
              <div className="sort-empty-state">
                <strong>{effectivePhotoFolder ? '点击扫描读取当前照片目录。' : '请选择照片文件夹并扫描照片。'}</strong>
                <span>{visiblePhotos.length === 0 && photos.length > 0
                  ? (smartSortViewMode === 'smartSortGroup' ? '当前分组暂无匹配照片，可切换分组或重新执行智能分拣。' : '当前筛选条件下没有照片，可调整左侧筛选。')
                  : '原始照片只读取，不移动、不删除、不压缩。'}</span>
                {photos.length === 0 && <button type="button" className="primary orange" disabled={isBusy} onClick={importOrScanPhotos}>{effectivePhotoFolder ? '扫描' : '导入'}</button>}
              </div>
            ) : viewMode === 'grid' ? pagePhotos.map((photo) => (
              <PhotoCard
                key={photo.id}
                photo={photo}
                selected={selectedIds.includes(photo.id)}
                active={currentPanelPhoto?.id === photo.id}
                onClick={() => handlePhotoClick(photo)}
                onToggleSelected={(event) => togglePhotoSelection(photo, event)}
              />
            )) : (
              <table className="sort-photo-list">
                <thead>
                  <tr><th>状态</th><th>文件名</th><th>时间</th><th>大小</th><th>分拣信息</th></tr>
                </thead>
                <tbody>
                  {pagePhotos.map((photo) => (
                    <tr key={photo.id} className={`${selectedIds.includes(photo.id) ? 'selected' : ''} ${currentPanelPhoto?.id === photo.id ? 'active-photo' : ''}`} onClick={() => handlePhotoClick(photo)}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(photo.id)}
                          onChange={(event) => togglePhotoSelection(photo, event)}
                          onClick={(event) => event.stopPropagation()}
                          aria-label={`选择 ${photo.originalName}`}
                        />
                        <StatusBadge status={photo.sortStatus} missing={photo.originalMissing} />
                      </td>
                      <td aria-label={photo.originalName}>{photo.originalName}</td>
                      <td>{formatDateTime(photo.modifiedAt)}</td>
                      <td>{formatFileSize(photo.size)}</td>
                      <td>{photo.archiveInfo ? `${photo.archiveInfo.watermarkCategory} / ${photo.archiveInfo.workContent}` : '-'}</td>
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

        <aside className="sort-right-panel panel current-photo-workbench" ref={rightPanelRef}>
          <div className="sort-selected-summary sort-right-fixed-top">
            <div>
              <strong>已选 {selectedIds.length}｜当前：{currentPhotoStatusText}｜{currentOcrStatusText}</strong>
              <small>{selectedStateText}</small>
            </div>
          </div>
          <div className="current-photo-nav">
            <div>
              <strong>当前照片 {currentPhotoPosition}</strong>
              <small title={currentPanelPhoto?.originalName || ''}>{currentPanelPhoto?.originalName || '暂无当前照片'}</small>
            </div>
            <div>
              <button type="button" onClick={() => goToAdjacentPhoto(-1)} disabled={currentPhotoIndex <= 0}>上一张</button>
              <button type="button" onClick={() => goToAdjacentPhoto(1)} disabled={currentPhotoIndex < 0 || currentPhotoIndex >= visiblePhotos.length - 1}>下一张</button>
            </div>
          </div>
          <div className="sort-right-scroll">
            {!currentPanelPhoto ? (
              <section className="right-workbench-empty">
                <h2>暂无当前照片</h2>
                <p>请先导入照片，并点击照片卡片查看识别结果、归档建议和确认信息。</p>
              </section>
            ) : rightPanelMode === 'recognition' ? (
              <div className="sort-recognition-mode">
                {recognitionMessage.text && <div className={`sort-ocr-message ${recognitionMessage.type}`}>{recognitionMessage.text}</div>}
                <OcrResultPreview
                  photo={currentRecognitionPhoto}
                  result={currentRecognitionResult}
                  onBackToForm={() => setRightPanelMode('form')}
                  onOpenRecognitionDetails={() => onNavigate?.(PAGE_KEYS.dataMaintenance)}
                />
                <WatermarkRecordPanel record={currentWatermarkRecord} />
                <RecognitionSuggestionPanel suggestion={recognitionSuggestion} />
                <div className="right-stage-actions">
                  <button type="button" className="primary" title={currentWatermarkRecord ? '根据当前水印事实重新生成归档建议' : '暂无水印事实记录。'} onClick={applyRecognitionSuggestionToForm} disabled={!currentWatermarkRecord}>重新生成归档建议</button>
                  <button type="button" onClick={() => setRightPanelMode('form')}>返回归档建议</button>
                  <button type="button" className="danger" title="仅清除当前照片识别结果，保留归档建议" onClick={clearCurrentRecognitionOnly} disabled={!currentRecognitionPhoto || !currentRecognitionResult}>清除识别</button>
                </div>
              </div>
            ) : (
              <div className="current-photo-workbench-body">
                {!currentRecognitionResult && !currentArchiveSuggestion && !currentPanelPhoto.archiveInfo && (
                  <section className="right-workbench-empty">
                    <h2>当前照片尚未识别</h2>
                    <p>请勾选照片并点击“智拣”，或人工新建归档建议。</p>
                    <button type="button" className="primary" onClick={createManualArchiveSuggestion}>人工新建建议</button>
                  </section>
                )}
                {currentRecognitionResult && currentRecognitionResult.success === false && !currentArchiveSuggestion && !currentPanelPhoto.archiveInfo && (
                  <section className="right-workbench-empty error">
                    <h2>识别失败</h2>
                    <p>{currentRecognitionResult.error || currentRecognitionResult.errors?.[0]?.message || '未返回具体失败原因。'}</p>
                    <button type="button" className="primary" onClick={createManualArchiveSuggestion}>人工新建建议</button>
                  </section>
                )}
                {currentRecognitionResult && currentRecognitionResult.success !== false && !currentArchiveSuggestion && !currentPanelPhoto.archiveInfo && (
                  <section className="right-workbench-empty">
                    <h2>已识别水印</h2>
                    <p>当前照片已有识别结果，但尚未生成归档建议。</p>
                    <button type="button" onClick={() => setRightPanelMode('recognition')}>查看识别依据</button>
                    <button type="button" className="primary" onClick={createManualArchiveSuggestion}>人工新建建议</button>
                  </section>
                )}
                {currentArchiveSuggestion && !currentPanelPhoto.archiveInfo && (
                  <section className="sort-form-section suggestion-editor-section">
                    <header className="sort-draft-header">
                      <div>
                        <h2>归档建议</h2>
                        <small>{getSuggestionSourceLabel(currentArchiveSuggestion)}｜{currentArchiveSuggestion?.status || 'none'}</small>
                      </div>
                      {currentRecognitionResult && <button type="button" onClick={() => setRightPanelMode('recognition')}>查看识别依据</button>}
                    </header>
                    <DraftStatusSummary draft={currentArchiveSuggestion} />
                    <ArchiveSuggestionForm form={form} configs={configs} updateForm={updateForm} />
                    <div className="right-stage-actions">
                      <button type="button" title="保存当前照片归档建议，可不完整" onClick={saveCurrentArchiveSuggestion} disabled={isIgnoredPhoto(currentPanelPhoto) || isArchivedPhoto(currentPanelPhoto)}>保存建议</button>
                      <button type="button" className="primary" title="确认当前照片归档建议" onClick={confirmCurrentArchiveDraft} disabled={isIgnoredPhoto(currentPanelPhoto) || isArchivedPhoto(currentPanelPhoto) || currentArchiveSuggestion.status === 'needs_completion'}>确认建议</button>
                      <button type="button" className="danger" title="只清除当前照片归档建议，保留 OCR 原文和已确认信息" onClick={clearCurrentArchiveDraft}>清除建议</button>
                    </div>
                  </section>
                )}
                {currentPanelPhoto.archiveInfo && (
                  <section className="confirmed-archive-section">
                    <header className="sort-draft-header">
                      <div>
                        <h2>{editingPhoto?.id === currentPanelPhoto.id ? '编辑归档信息' : '已确认归档信息'}</h2>
                        <small>当前照片已确认，可勾选后生成预览。</small>
                      </div>
                      {currentRecognitionResult && <button type="button" onClick={() => setRightPanelMode('recognition')}>查看识别依据</button>}
                    </header>
                    {editingPhoto?.id === currentPanelPhoto.id ? (
                      <>
                        <ArchiveSuggestionForm form={form} configs={configs} updateForm={updateForm} />
                        <div className="right-stage-actions">
                          <button type="button" className="primary" onClick={saveCurrentPhotoInfo}>保存归档信息</button>
                        </div>
                      </>
                    ) : (
                      <>
                        <ConfirmedArchiveInfo info={currentPanelPhoto.archiveInfo} />
                        <div className="right-stage-actions">
                          <button type="button" onClick={editCurrentPhotoInfo}>编辑归档信息</button>
                          <button type="button" title={previewDisabledReason || '仅预览已勾选且已确认的照片'} onClick={buildSortPreview} disabled={Boolean(previewDisabledReason)}>预览</button>
                        </div>
                      </>
                    )}
                  </section>
                )}
                {currentPanelPhoto.previewInfo && (
                  <PreviewInfoPanel photo={currentPanelPhoto} onArchive={requestArchive} disabled={isBusy || selectedHasIgnored || selectedPreviewCount === 0 || previewPhotos.length === 0} />
                )}
                {currentPanelPhoto.archiveResult && (
                  <ArchiveResultPanel result={currentPanelPhoto.archiveResult} />
                )}
              </div>
            )}
          </div>
        </aside>
      </div>

      <footer className="sort-bottom-bar">
        <div className="sort-bottom-status">
          <span>显示 {visiblePhotos.length ? (safePage - 1) * pageSize + 1 : 0}-{Math.min(safePage * pageSize, visiblePhotos.length)} / {visiblePhotos.length}</span>
          <span>第 {safePage} / {totalPages} 页</span>
          <span>已选 {selectedIds.length}</span>
        </div>
        <strong className={`sort-bottom-message ${status.type}`} title={status.text}>{status.text}</strong>
        <div className="sort-bottom-meta">
          <span title={smartSortEngineText}>{smartSortEngineText}</span>
          <span title={smartSortBottomText}>{smartSortBottomText}</span>
          {smartSortMessage?.text && <span title={smartSortMessage.text}>{smartSortMessage.text}</span>}
        </div>
      </footer>

      {showConfirm && (
        <SortArchiveConfirm
          count={previewPhotos.length}
          unassignedCount={unassignedCount}
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

function OcrResultPreview({ photo, result, onBackToForm, onOpenRecognitionDetails }) {
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
        <small>{statusLabel}｜{rawText ? `${rawText.length} 字` : '0 字'}｜<button type="button" onClick={onBackToForm}>返回表单</button></small>
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

function ArchiveSuggestionForm({ form, configs, updateForm }) {
  const categoryOptions = Object.keys(configs.watermarkCategories || {});
  return (
    <>
      <div className="readonly-system-fields">
        <p><span>当前项目</span><strong>{form.project || configs.projects?.[0] || '-'}</strong></p>
        <p><span>照片来源</span><strong>工作照片</strong></p>
      </div>
      <div className="sort-form-grid core-fields">
        <InputField label="日期" type="date" value={form.date} onChange={(date) => updateForm({ date })} required />
        <InputField label="位置/区域" value={form.location} placeholder={form.locationPlaceholder || '请填写现场位置'} onChange={(location) => updateForm({ location })} required />
        <SelectField label="归档分类" value={form.watermarkCategory} options={categoryOptions} onChange={(watermarkCategory) => updateForm({ watermarkCategory, workContent: '' })} required />
        <SelectField label="工作内容" value={form.workContent} options={configs.watermarkCategories?.[form.watermarkCategory]?.items || []} onChange={(workContent) => updateForm({ workContent })} required disabled={!form.watermarkCategory} />
      </div>
      <details className="sort-more-fields">
        <summary>更多信息</summary>
        <div className="sort-form-grid">
          <SelectField label="部门" value={form.department} options={configs.departments} onChange={(department) => updateForm({ department })} />
          <InputField label="事项名称" value={form.itemName} placeholder="不填则默认使用工作内容" onChange={(itemName) => updateForm({ itemName })} />
          <SelectField label="照片阶段" value={form.photoStage} options={configs.photoStages} onChange={(photoStage) => updateForm({ photoStage })} />
          <SelectField label="处理状态" value={form.processStatus} options={configs.processStatuses} onChange={(processStatus) => updateForm({ processStatus })} />
          <InputField label="关键词" value={form.keywords} onChange={(keywords) => updateForm({ keywords }, { preserveKeywords: true })} wide />
          <TextAreaField label="备注" value={form.remark} onChange={(remark) => updateForm({ remark })} />
        </div>
      </details>
    </>
  );
}

function ConfirmedArchiveInfo({ info = {} }) {
  const rows = [
    ['日期', info.date],
    ['位置/区域', info.location],
    ['归档分类', info.watermarkCategory],
    ['工作内容', info.workContent],
    ['项目', info.project],
    ['照片来源', info.photoSource],
    ['部门', info.department],
    ['事项名称', info.itemName || info.workItem],
    ['照片阶段', info.photoStage],
    ['处理状态', info.processStatus],
    ['关键词', info.keywords],
    ['备注', info.remark]
  ].filter(([, value]) => String(value || '').trim());
  return (
    <dl className="confirmed-info-list">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function PreviewInfoPanel({ photo, onArchive, disabled }) {
  const preview = photo.previewInfo || {};
  return (
    <section className="right-preview-panel">
      <h2>预览结果</h2>
      <p>当前照片已预览，可勾选后正式归档。</p>
      <dl className="confirmed-info-list">
        <div><dt>目标路径</dt><dd title={preview.targetPath || preview.targetDir}>{preview.targetPath || preview.targetDir || '-'}</dd></div>
        <div><dt>拟归档文件名</dt><dd>{preview.newName || preview.newFileName || preview.targetName || '-'}</dd></div>
        <div><dt>台账摘要</dt><dd>{photo.archiveInfo ? `${photo.archiveInfo.watermarkCategory || ''} / ${photo.archiveInfo.workContent || ''}` : '-'}</dd></div>
      </dl>
      <div className="right-stage-actions">
        <button type="button" className="primary orange" onClick={onArchive} disabled={disabled}>归档</button>
      </div>
    </section>
  );
}

function ArchiveResultPanel({ result = {} }) {
  const success = result.success === true || result.status === '归档成功';
  return (
    <section className={success ? 'right-result-panel success' : 'right-result-panel error'}>
      <h2>{success ? '归档完成' : '归档失败'}</h2>
      <p>{success ? '照片已复制归档，并按现有流程写入台账。' : (result.error || result.message || '请修正信息后重新预览 / 归档。')}</p>
      <dl className="confirmed-info-list">
        <div><dt>归档路径</dt><dd title={result.targetPath}>{result.targetPath || '-'}</dd></div>
        <div><dt>台账结果</dt><dd>{result.ledgerStatus || result.status || '-'}</dd></div>
      </dl>
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
  if (result.status === 'success') return '未识别到有效文字';
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

function PhotoCard({ photo, selected, active, onClick, onToggleSelected }) {
  const gridSummary = buildGridPhotoSummary(photo);
  const newName = photo.previewInfo?.newName || photo.previewInfo?.newFileName || photo.previewInfo?.targetName || '';
  const handleKeyDown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onClick();
    }
  };
  return (
    <article
      role="button"
      tabIndex={0}
      className={`sort-photo-card ${photo.sortStatus || ''} ${selected ? 'selected' : ''} ${active ? 'active-photo' : ''}`}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      aria-label={photo.originalName || '照片卡片'}
    >
      <div className="sort-thumb-wrap">
        {photo.originalMissing ? <span className="sort-missing-thumb">原图缺失</span> : <ThumbnailHoverPreview src={photo.previewUrl} alt={photo.originalName} />}
        <span className="sort-ext">{photo.extension?.replace('.', '').toUpperCase()}</span>
        <label className="sort-select-check" onClick={(event) => event.stopPropagation()}>
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelected}
            aria-label={`选择 ${photo.originalName}`}
          />
          <span>{selected ? '✓' : ''}</span>
        </label>
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
        <StatusBadge status={photo.sortStatus} missing={photo.originalMissing} />
        <small>{formatFileSize(photo.size)}</small>
      </footer>
    </article>
  );
}

function SortArchiveConfirm({ count, unassignedCount, ignoredCount, archiveRoot, photos, onCancel, onConfirm, isBusy }) {
  const projects = unique(photos.map((photo) => photo.archiveInfo?.project));
  const departments = unique(photos.map((photo) => photo.archiveInfo?.department));
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
            <div><dt>未分拣照片</dt><dd>{unassignedCount} 张</dd></div>
            <div><dt>不参与归档</dt><dd>{ignoredCount} 张已忽略</dd></div>
            <div><dt>归档根目录</dt><dd title={archiveRoot}>{archiveRoot}</dd></div>
            <div><dt>涉及项目</dt><dd>{projects.join('、') || '-'}</dd></div>
            <div><dt>涉及部门</dt><dd>{departments.join('、') || '-'}</dd></div>
            <div><dt>水印分类</dt><dd>{categories.join('、') || '-'}</dd></div>
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
          <button type="button" onClick={onCancel}>返回修改</button>
          <button type="button" className="primary" disabled={isBusy} onClick={onConfirm}>{isBusy ? '正在归档...' : '确认归档'}</button>
        </footer>
      </section>
    </div>
  );
}

function SelectField({ label, value, options, onChange, required = false, disabled = false }) {
  const placeholder = label === '水印分类'
    ? '请选择水印分类'
    : label === '工作内容'
      ? '请选择工作内容'
      : required
        ? `请选择${label}`
        : '';
  return (
    <label className="field">
      <span>{label}{required && <b>*</b>}</span>
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  );
}

function InputField({ label, value, onChange, type = 'text', placeholder = '', required = false, wide = false }) {
  return (
    <label className={`field ${wide ? 'wide' : ''}`}>
      <span>{label}{required && <b>*</b>}</span>
      <input type={type} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function TextAreaField({ label, value, onChange }) {
  return (
    <label className="field wide">
      <span>{label}</span>
      <textarea rows={2} value={value} placeholder="建议填写：问题点 + 处理动作 + 结果/状态" onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function StatusBadge({ status, missing }) {
  return <span className={`sort-status-badge ${missing ? 'failed' : status}`}>{missing ? '原图缺失' : statusLabels[status] || status}</span>;
}

function reconcileForm(current, configs) {
  const categories = Object.keys(configs.watermarkCategories || {});
  const watermarkCategory = categories.includes(current.watermarkCategory) ? current.watermarkCategory : '';
  return {
    ...current,
    photoSource: current.photoSource || '工作照片',
    project: pick(current.project, configs.projects),
    department: pick(current.department, configs.departments),
    watermarkCategory,
    workContent: (configs.watermarkCategories?.[watermarkCategory]?.items || []).includes(current.workContent) ? current.workContent : '',
    photoStage: pick(current.photoStage, configs.photoStages),
    processStatus: pick(current.processStatus, configs.processStatuses)
  };
}

function pick(value, options = []) {
  return options.includes(value) ? value : (options[0] || value || '');
}

function normalizeArchiveInfo(form) {
  return {
    photoSource: form.photoSource,
    project: form.project,
    department: form.department,
    watermarkCategory: form.watermarkCategory,
    workContent: form.workContent,
    itemName: form.itemName,
    workItem: form.itemName,
    location: form.location,
    date: form.date,
    photoStage: form.photoStage,
    processStatus: form.processStatus,
    keywords: form.keywords,
    remark: form.remark
  };
}

function toArchiveForm(value) {
  return {
    ...value,
    workItem: value.itemName ?? value.workItem ?? '',
    location: value.location ?? ''
  };
}

function isIgnoredPhoto(photo) {
  return photo?.sortStatus === 'ignored';
}

function getFilterCount(key, photos, selectedIds) {
  if (key === 'all') return photos.filter((photo) => !isIgnoredPhoto(photo)).length;
  if (key === 'selected') return photos.filter((photo) => selectedIds.includes(photo.id) && !isIgnoredPhoto(photo)).length;
  if (key === 'assigned') return photos.filter((photo) => ['assigned', 'confirmed'].includes(photo.sortStatus)).length;
  if (key === 'failed') return photos.filter((photo) => ['failed', 'archive_failed'].includes(photo.sortStatus)).length;
  return photos.filter((photo) => photo.sortStatus === key).length;
}

function getSelectedStateText(selectedPhotos) {
  if (!selectedPhotos.length) return '请先在照片区选择照片';
  if (selectedPhotos.every((photo) => photo.sortStatus === 'archived')) return '已归档';
  if (selectedPhotos.some((photo) => photo.sortStatus === 'previewed')) return '已生成归档预览';
  if (selectedPhotos.some((photo) => photo.archiveInfo || photo.sortStatus === 'assigned')) return '已应用归档信息';
  return '尚未应用归档信息';
}

function getCurrentPhotoStatusText({ photo, recognitionResult, suggestion, isRecognitionBusy }) {
  if (!photo) return '无当前照片';
  if (isRecognitionBusy) return '识别中';
  if (photo.sortStatus === 'archived') return '已归档';
  if (photo.sortStatus === 'failed' || photo.sortStatus === 'archive_failed') return '归档失败';
  if (photo.sortStatus === 'previewed' && photo.previewInfo) return '已预览';
  if (photo.archiveInfo) return '已确认';
  if (suggestion?.status === 'needs_completion') return '待补充';
  if (suggestion?.status === 'suggestion_ready') return '待确认';
  if (recognitionResult?.success === false || ['failed', 'error'].includes(recognitionResult?.status)) return '识别失败';
  if (recognitionResult) return '已识别';
  return '未识别';
}

function getCurrentOcrStatusText({ recognitionResult, suggestion, isRecognitionBusy }) {
  if (isRecognitionBusy) return 'OCR 识别中';
  if (suggestion?.missingRequiredFields?.length) return '缺核心字段';
  if (suggestion?.status === 'suggestion_ready') return '可确认';
  if (recognitionResult?.success === false || ['failed', 'error'].includes(recognitionResult?.status)) return '识别失败';
  if (recognitionResult) return '已识别';
  return '待智拣';
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
  const workContent = info.workContent || info.itemName || info.workItem || '已分拣';
  const location = info.location || '现场';
  const stage = info.photoStage || '';
  const sub = [location, stage].filter(Boolean).join(' · ');
  return {
    main: workContent,
    sub,
    full: [workContent, location, stage, info.processStatus].filter(Boolean).join(' / ')
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

function normalizePhotosForSmartSort(photos, recognitionMap = {}, suggestionMap = {}) {
  return photos.map((photo, index) => ({
    photoId: photo.id,
    filePath: photo.originalPath,
    fileName: photo.originalName,
    index,
    capturedAt: photo.capturedAt || null,
    modifiedAt: photo.modifiedAt || null,
    recognition: normalizeRecognitionForSmartSort(recognitionMap[photo.id], suggestionMap[photo.id])
  }));
}

function normalizeRecognitionForSmartSort(recognition, suggestion) {
  if (!recognition && !suggestion) return null;
  const fields = suggestion?.suggestedFields || {};
  return {
    ...(recognition || {}),
    parsedFields: {
      ...(recognition?.parsedFields || {}),
      workContent: fields.workContent || '',
      watermarkCategory: fields.watermarkCategory || '',
      category: fields.watermarkCategory || '',
      location: fields.location || fields.area || '',
      remark: fields.remark || '',
      suggestionStatus: suggestion?.status || ''
    },
    parsedWatermark: {
      ...(recognition?.parsedWatermark || {}),
      workContent: fields.workContent || '',
      watermarkCategory: fields.watermarkCategory || '',
      location: fields.location || fields.area || ''
    }
  };
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

function hasLocalOcrExecuted(result = {}) {
  const candidates = [
    result.engineResult,
    result.localResult?.engineResult,
    result.compareResults?.local?.engineResult
  ].filter(Boolean);
  return candidates.some((item) => item.ocrEngine === 'rapidocr' && item.source && item.source !== 'none');
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

function summarizeRecognitionResults(recognitionMap = {}) {
  const results = Object.values(recognitionMap || {});
  const success = results.filter((result) => result?.status === 'success' && String(result.rawText || result.adoptedOcrText || '').trim()).length;
  const failed = results.filter((result) => ['failed', 'error', 'provider_unavailable', 'not_configured', 'disabled'].includes(result?.status)).length;
  const pending = Math.max(0, results.length - success - failed);
  const firstEngine = results.map((result) => result?.engineResult || result?.localResult?.engineResult || result?.compareResults?.local?.engineResult).find(Boolean) || {};
  return { total: results.length, success, failed, pending, engine: firstEngine };
}

function buildSmartSortEngineText({ recognitionSummary, result }) {
  const summary = recognitionSummary || {};
  const localEngine = result?.engineResult || result?.localResult?.engineResult || result?.compareResults?.local?.engineResult || summary.engine || {};
  const engineText = getRecognitionEngineSourceLabel(localEngine, result || {});
  const statusText = summary.total > 0
    ? `OCR：成功 ${summary.success}、待确认 ${summary.pending}、失败 ${summary.failed}`
    : 'OCR：成功 0、待确认 0、失败 0';
  return `${statusText}｜引擎：${engineText}`;
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
    defaultProject: configs.projects?.[0] || '',
    currentPhotoSource: '工作照片',
    defaultPhotoSource: '工作照片',
    defaultDepartment: form.department || configs.departments?.[0] || '',
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
  push('watermarkCategory', '水印分类', parsed.watermarkCategory || parsed.category);
  push('workContent', '工作内容', parsed.workContent);
  push('location', '位置/区域', parsed.location);
  push('itemName', '事项名称', parsed.itemName || parsed.workContent);
  push('photoStage', '照片阶段', parsed.stage);
  push('processStatus', '处理状态', parsed.processStatus);
  if (Array.isArray(parsed.keywords) && parsed.keywords.length) push('keywords', '关键词', parsed.keywords.join('、'));
  push('remark', '备注', parsed.remark);
  const applicableDisplayFields = applicable;
  const applicableFormFields = applicable.filter((field) => field.key !== 'time-display-only');
  const presentKeys = new Set(applicableFormFields.map((field) => field.key));
  const missingFields = ['workContent', 'location', 'itemName']
    .filter((key) => !presentKeys.has(key))
    .map((key) => ({ workContent: '工作内容', location: '位置/区域', itemName: '事项名称' }[key]));
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

function fillTemplate(template, form, scene = {}) {
  return String(template || '')
    .replaceAll('具体位置', form.location || '位置/区域')
    .replaceAll('位置/区域', form.location || '位置/区域')
    .replaceAll('工作事项', scene.itemName || form.itemName || form.workContent || '事项名称')
    .replaceAll('事项名称', scene.itemName || form.itemName || form.workContent || '事项名称');
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
