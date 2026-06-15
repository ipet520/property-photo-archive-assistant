import { useEffect, useMemo, useRef, useState } from 'react';
import { APP_VERSION } from '../constants/app.js';
import { formatFileSize, getSuggestedKeywords, splitKeywords, toggleKeyword } from '../utils/formatters.js';
import { getUsableArchiveRoot, getUsablePhotoFolder, withRuntimeConfigFallback } from '../utils/runtimeConfig.js';

const defaultForm = {
  photoSource: '',
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
  unassigned: '未分拣',
  assigned: '已分拣',
  previewed: '已预览',
  archived: '已归档',
  failed: '失败',
  ignored: '已忽略'
};

const statusFilters = [
  ['all', '全部照片'],
  ['unassigned', '未分拣'],
  ['selected', '已选择'],
  ['assigned', '已分拣'],
  ['previewed', '已生成预览'],
  ['archived', '已归档'],
  ['failed', '失败'],
  ['ignored', '已忽略']
];

const groupExamples = ['楼道杂物清理', '飞线充电治理', '公共设施设备维修', '消防通道违停', '环境卫生保洁', '绿化养护', '其他自定义分组'];

const assistTabs = [
  ['scenes', '常见场景'],
  ['keywords', '关键词']
];

const viewModes = [
  { key: 'grid', label: '网格视图' },
  { key: 'list', label: '列表视图' }
];

export default function SortWorkspacePage() {
  const rightPanelRef = useRef(null);
  const [configs, setConfigs] = useState(null);
  const [settings, setSettings] = useState(null);
  const [photoFolder, setPhotoFolder] = useState('');
  const [archiveRoot, setArchiveRoot] = useState('');
  const [photos, setPhotos] = useState([]);
  const [form, setForm] = useState(defaultForm);
  const [filter, setFilter] = useState('all');
  const [activeGroup, setActiveGroup] = useState('all');
  const [searchText, setSearchText] = useState('');
  const [viewMode, setViewMode] = useState('grid');
  const [thumbSize, setThumbSize] = useState('standard');
  const [sortMode, setSortMode] = useState('timeAsc');
  const [selectedIds, setSelectedIds] = useState([]);
  const [lastClickedId, setLastClickedId] = useState(null);
  const [activeRightTab, setActiveRightTab] = useState('scenes');
  const [activeSceneTitle, setActiveSceneTitle] = useState('');
  const [editingPhotoId, setEditingPhotoId] = useState('');
  const [lastDraftSavedAt, setLastDraftSavedAt] = useState('');
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [status, setStatus] = useState({ type: 'idle', text: '请选择照片文件夹并扫描照片。' });
  const [isBusy, setIsBusy] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  useEffect(() => {
    Promise.all([
      window.archiveAssistant.loadConfigs(),
      window.archiveAssistant.loadSettings()
    ]).then(([loadedConfigs, loadedSettings]) => {
      const safeConfigs = withRuntimeConfigFallback(loadedConfigs);
      const restoredPhotoFolder = getUsablePhotoFolder(loadedSettings);
      const restoredArchiveRoot = getUsableArchiveRoot(loadedSettings);
      setConfigs(safeConfigs);
      setSettings(loadedSettings);
      setForm(reconcileForm(defaultForm, safeConfigs));
      if (restoredPhotoFolder) setPhotoFolder(restoredPhotoFolder);
      if (restoredArchiveRoot) setArchiveRoot(restoredArchiveRoot);
    }).catch((error) => {
      const safeConfigs = withRuntimeConfigFallback(null);
      setConfigs(safeConfigs);
      setForm(reconcileForm(defaultForm, safeConfigs));
      setStatus({ type: 'error', text: `配置加载失败：${error.message}` });
    });
  }, []);

  const visiblePhotos = useMemo(() => {
    const keyword = searchText.trim().toLowerCase();
    return photos
      .filter((photo) => {
        if (filter === 'all') return true;
        if (filter === 'selected') return selectedIds.includes(photo.id);
        return photo.sortStatus === filter;
      })
      .filter((photo) => {
        if (activeGroup === 'all') return true;
        return photo.archiveInfo?.itemName === activeGroup || photo.archiveInfo?.workContent === activeGroup;
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
  }, [photos, filter, activeGroup, searchText, selectedIds, sortMode]);

  const totalPages = Math.max(1, Math.ceil(visiblePhotos.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pagePhotos = visiblePhotos.slice((safePage - 1) * pageSize, safePage * pageSize);
  const selectedPhotos = photos.filter((photo) => selectedIds.includes(photo.id));
  const primaryPhoto = selectedPhotos[0] || pagePhotos[0] || photos[0] || null;
  const stats = getStats(photos, selectedIds);
  const suggestedKeywords = splitKeywords(getSuggestedKeywords({ ...toArchiveForm(form), workItem: form.itemName }, configs));
  const activeKeywords = splitKeywords(form.keywords);
  const assignedCount = photos.filter((photo) => photo.sortStatus === 'assigned').length;
  const previewPhotos = photos.filter((photo) => photo.sortStatus === 'previewed' && photo.previewInfo);
  const unassignedCount = photos.filter((photo) => photo.sortStatus === 'unassigned').length;
  const ignoredCount = photos.filter((photo) => photo.sortStatus === 'ignored').length;
  const missingOriginalCount = photos.filter((photo) => photo.originalMissing).length;
  const editingPhoto = photos.find((photo) => photo.id === editingPhotoId) || null;

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  useEffect(() => {
    rightPanelRef.current?.scrollTo({ top: 0 });
  }, []);

  useEffect(() => {
    if (!assistTabs.some(([key]) => key === activeRightTab)) {
      setActiveRightTab('scenes');
    }
  }, [activeRightTab]);

  function markChanged() {
    setHasUnsavedChanges(true);
  }

  function invalidatePreviewMessage() {
    return previewPhotos.length > 0 ? '分拣信息已变化，请重新生成归档预览。' : '';
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

  function updateForm(patch, options = {}) {
    setForm((current) => {
      const next = { ...current, ...patch };
      if (patch.watermarkCategory) {
        const items = configs?.watermarkCategories?.[patch.watermarkCategory]?.items || [];
        if (!items.includes(next.workContent)) next.workContent = items[0] || '';
      }
      if (!options.preserveKeywords && (patch.watermarkCategory || patch.workContent || patch.itemName || patch.location || patch.processStatus)) {
        next.keywords = getSuggestedKeywords({ ...toArchiveForm(next), workItem: next.itemName }, configs);
      }
      return next;
    });
  }

  async function selectPhotoFolder() {
    const selected = await window.archiveAssistant.selectPhotoFolder();
    if (!selected) return;
    setPhotoFolder(selected);
    const nextSettings = await window.archiveAssistant.updateLastPhotoFolder(selected);
    setSettings(nextSettings);
    setStatus({ type: 'idle', text: '照片来源目录已选择，请点击扫描照片。' });
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

  async function scanPhotos(force = false) {
    if (!photoFolder) {
      setStatus({ type: 'error', text: '请先选择照片文件夹。' });
      return;
    }
    if (!force && photos.some((photo) => photo.sortStatus !== 'unassigned') && !window.confirm('重新扫描会覆盖当前分拣状态，但不会删除、移动或修改原图。确定继续吗？')) {
      return;
    }
    setIsBusy(true);
    try {
      const scanned = await window.archiveAssistant.scanImages(photoFolder);
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
      setPage(1);
      setFilter('all');
      setActiveGroup('all');
      setEditingPhotoId('');
      markChanged();
      setStatus({ type: 'success', text: `扫描完成，共找到 ${scanned.length} 张照片。` });
    } catch (error) {
      setStatus({ type: 'error', text: `扫描失败：${error.message}` });
    } finally {
      setIsBusy(false);
    }
  }

  function clearList() {
    if (photos.length === 0) return;
    if (!window.confirm('仅清空当前分拣列表和分拣状态，不会删除原始照片。确定清空吗？')) return;
    setPhotos([]);
    setSelectedIds([]);
    setPage(1);
    setActiveGroup('all');
    setEditingPhotoId('');
    markChanged();
    setStatus({ type: 'success', text: '已清空当前分拣列表，原始照片未受影响。' });
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
    const invalidTip = invalidatePreviewMessage();
    setPhotos((current) => current.map((photo) => {
      if (selectedIds.includes(photo.id)) return { ...photo, sortStatus: 'ignored', previewInfo: null, archiveResult: null };
      return invalidTip ? clearGeneratedPreview(photo) : photo;
    }));
    markChanged();
    setStatus({ type: invalidTip ? 'warning' : 'success', text: `已标记忽略 ${selectedIds.length} 张照片，原图未受影响。${invalidTip}` });
  }

  function cancelIgnored() {
    const invalidTip = invalidatePreviewMessage();
    setPhotos((current) => current.map((photo) => {
      if (selectedIds.includes(photo.id) && photo.sortStatus === 'ignored') return { ...photo, sortStatus: 'unassigned' };
      return invalidTip ? clearGeneratedPreview(photo) : photo;
    }));
    markChanged();
    setStatus({ type: invalidTip ? 'warning' : 'success', text: `已取消选中照片的忽略状态。${invalidTip}` });
  }

  function applyInfoToSelected() {
    if (selectedIds.length === 0) {
      setStatus({ type: 'error', text: '请先选择需要分拣的照片。' });
      return;
    }
    const missing = validateSortForm(form);
    if (missing.length) {
      setStatus({ type: 'error', text: `请补全必填项：${missing.join('、')}` });
      return;
    }
    const alreadyAssignedCount = selectedPhotos.filter((photo) => photo.archiveInfo || photo.sortStatus === 'assigned' || photo.sortStatus === 'previewed').length;
    if (alreadyAssignedCount > 0 && !window.confirm(`当前选中照片中已有 ${alreadyAssignedCount} 张已分拣照片，继续操作将覆盖这些照片的归档信息。是否继续？`)) {
      return;
    }
    const invalidTip = invalidatePreviewMessage();
    const archiveInfo = normalizeArchiveInfo(form);
    setPhotos((current) => current.map((photo) => {
      if (selectedIds.includes(photo.id)) return { ...photo, sortStatus: 'assigned', archiveInfo, previewInfo: null, archiveResult: null };
      return invalidTip ? clearGeneratedPreview(photo) : photo;
    }));
    markChanged();
    setStatus({ type: invalidTip ? 'warning' : 'success', text: `已将归档信息应用到 ${selectedIds.length} 张照片。${invalidTip}` });
  }

  function editCurrentPhotoInfo() {
    if (!primaryPhoto?.archiveInfo) return;
    setEditingPhotoId(primaryPhoto.id);
    setForm(reconcileForm({
      ...defaultForm,
      ...primaryPhoto.archiveInfo,
      itemName: primaryPhoto.archiveInfo.itemName || primaryPhoto.archiveInfo.workItem || '',
      workContent: primaryPhoto.archiveInfo.workContent || '',
      location: primaryPhoto.archiveInfo.location || ''
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
      if (photo.id === editingPhoto.id) return { ...photo, sortStatus: 'assigned', archiveInfo, previewInfo: null, archiveResult: null };
      return invalidTip ? clearGeneratedPreview(photo) : photo;
    }));
    setEditingPhotoId('');
    markChanged();
    setStatus({ type: invalidTip ? 'warning' : 'success', text: `当前照片归档信息已修改。${invalidTip || '仅当前照片被更新。'}` });
  }

  function clearSelectedInfo() {
    if (selectedIds.length === 0) {
      setStatus({ type: 'error', text: '请先选择照片。' });
      return;
    }
    if (!window.confirm('确定要清除选中照片的归档信息吗？\n\n仅清除软件内的分拣信息。\n不会删除原始照片。\n不会移动原始照片。\n不会删除已归档文件。\n清除后这些照片将恢复为未分拣状态。')) return;
    const invalidTip = invalidatePreviewMessage();
    setPhotos((current) => current.map((photo) => {
      if (selectedIds.includes(photo.id)) return { ...photo, sortStatus: 'unassigned', archiveInfo: null, previewInfo: null, archiveResult: null };
      return invalidTip ? clearGeneratedPreview(photo) : photo;
    }));
    setEditingPhotoId((current) => selectedIds.includes(current) ? '' : current);
    markChanged();
    setStatus({ type: invalidTip ? 'warning' : 'success', text: `已清除 ${selectedIds.length} 张照片的归档信息，原始照片未受影响。${invalidTip}` });
  }

  function applyScene(scene) {
    setActiveSceneTitle(scene.title);
    updateForm({
      watermarkCategory: scene.watermarkCategory,
      workContent: scene.workContent,
      itemName: scene.itemName || '',
      location: '',
      locationPlaceholder: scene.locationPlaceholder || '',
      processStatus: scene.processStatusSuggestion || scene.processStatus || form.processStatus,
      photoStage: scene.photoStageSuggestion || scene.photoStage || form.photoStage,
      keywords: (scene.keywords || []).join('、'),
      remark: fillTemplate(scene.remarkTemplate || '', form, scene)
    }, { preserveKeywords: true });
    setStatus({ type: 'success', text: `已套用常见场景：${scene.title}。` });
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
      activeGroup,
      selectedIds,
      sortMode,
      thumbSize,
      pageSize,
      photos: photos.map(({ previewUrl, thumbnailPath, ...photo }) => photo)
    };
    const result = await window.archiveAssistant.saveSortDraft(payload);
    if (result?.success) {
      setLastDraftSavedAt(savedAt);
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
    setActiveGroup(result.draft.activeGroup || 'all');
    setThumbSize(normalizeThumbSize(result.draft.thumbSize));
    setSortMode(result.draft.sortMode || 'timeAsc');
    setPageSize(result.draft.pageSize || 50);
    setPhotos(loadedPhotos);
    setSelectedIds((result.draft.selectedIds || []).filter((id) => loadedPhotos.some((photo) => photo.id === id)));
    setPage(1);
    setEditingPhotoId('');
    setLastDraftSavedAt(result.draft.savedAt || '');
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
      setPhotoFolder(selected);
      const nextSettings = await window.archiveAssistant.updateLastPhotoFolder(selected);
      setSettings(nextSettings);
      markChanged();
      setStatus({ type: restoredCount === missingPhotos.length ? 'success' : 'warning', text: `已重新匹配 ${restoredCount} 张照片，仍有 ${missingPhotos.length - restoredCount} 张原图缺失。` });
    } catch (error) {
      setStatus({ type: 'error', text: `重新定位照片文件夹失败：${error.message}` });
    } finally {
      setIsBusy(false);
    }
  }

  async function buildSortPreview() {
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
      setStatus({ type: 'error', text: '当前没有已分拣照片，无法生成归档预览。' });
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
      setPhotos((current) => current.map((photo) => previewMap.has(photo.id)
        ? { ...photo, sortStatus: 'previewed', previewInfo: previewMap.get(photo.id), archiveResult: null }
        : photo));
      setHasUnsavedChanges(true);
      setStatus({ type: (unassignedCount || ignoredCount) ? 'warning' : 'success', text: `已生成 ${preview.length} 张照片的归档预览。未分拣 ${unassignedCount} 张，已忽略 ${ignoredCount} 张未纳入预览。` });
    } catch (error) {
      setStatus({ type: 'error', text: `生成分拣归档预览失败：${error.message}` });
    } finally {
      setIsBusy(false);
    }
  }

  function requestArchive() {
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
      setPhotos((current) => current.map((photo) => {
        const item = resultMap.get(photo.id);
        if (!item) return photo;
        const success = item.status === '归档成功';
        return { ...photo, sortStatus: success ? 'archived' : 'failed', archiveResult: item, previewInfo: item };
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
    <div className="sort-workbench">
      <section className="sort-topbar panel">
        <div className="sort-paths">
          <label>
            <span>照片来源目录</span>
            <strong title={photoFolder}>{photoFolder || '请选择照片文件夹'}</strong>
          </label>
          <label>
            <span>归档根目录</span>
            <strong title={archiveRoot}>{archiveRoot || '请选择归档根目录'}</strong>
          </label>
        </div>
        <div className="sort-top-actions">
          <div className="sort-action-group primary-group">
            <button type="button" className="primary" onClick={selectPhotoFolder}>选择照片文件夹</button>
            <button type="button" onClick={selectArchiveRoot}>选择归档目录</button>
            <button type="button" className="primary orange" disabled={!photoFolder || isBusy} onClick={() => scanPhotos(false)}>扫描照片</button>
          </div>
          <div className="sort-action-group maintenance-group">
            <button type="button" disabled={!photoFolder || isBusy} onClick={() => scanPhotos(false)}>重新扫描</button>
            <button type="button" onClick={clearList}>清空列表</button>
            <button type="button" onClick={saveDraft}>保存进度</button>
            <button type="button" onClick={loadDraft}>恢复进度</button>
            {missingOriginalCount > 0 && <button type="button" onClick={relocateMissingPhotos}>重新定位照片文件夹</button>}
          </div>
          <span className="sort-draft-chip">{lastDraftSavedAt ? `最近保存：${formatDateTime(lastDraftSavedAt)}` : '暂无保存进度'}</span>
        </div>
      </section>

      <div className="sort-main-grid">
        <aside className="sort-left-panel panel">
          <SortSection title="状态筛选">
            {statusFilters.map(([key, label]) => (
              <button type="button" key={key} className={filter === key ? 'active' : ''} onClick={() => { setFilter(key); setPage(1); }}>
                <span>{label}</span>
                <strong>{getFilterCount(key, photos, selectedIds)}</strong>
              </button>
            ))}
          </SortSection>
          <SortSection
            title="分组列表"
            action={(
              <button
                type="button"
                title="新增分组（后续版本开放）"
                onClick={() => setStatus({ type: 'idle', text: '自定义分组管理将在后续版本开放，当前可先按常见场景分组查看。' })}
              >
                + 分组
              </button>
            )}
            scrollable
          >
            <button type="button" className={activeGroup === 'all' ? 'active' : ''} onClick={() => { setActiveGroup('all'); setPage(1); }}>
              <span><i style={{ background: '#2f80ed' }} />全部分组</span>
              <strong>{photos.length}</strong>
            </button>
            {groupExamples.map((group, index) => (
              <button type="button" key={group} className={activeGroup === group ? 'active' : ''} onClick={() => { setActiveGroup(group); setPage(1); }}>
                <span><i style={{ background: groupColor(index) }} />{group}</span>
                <strong>{photos.filter((photo) => photo.archiveInfo?.itemName === group || photo.archiveInfo?.workContent === group).length}</strong>
              </button>
            ))}
          </SortSection>
        </aside>

        <main className="sort-center-panel panel">
          <div className="sort-grid-toolbar">
            <div className="sort-view-tabs">
              {viewModes.map((mode) => (
                <button type="button" key={mode.key} className={viewMode === mode.key ? 'active' : ''} onClick={() => setViewMode(mode.key)}>
                  {mode.label}
                </button>
              ))}
            </div>
            <label className="sort-thumb-control">
              <span>缩略图</span>
              <select value={thumbSize} onChange={(event) => setThumbSize(event.target.value)}>
                <option value="standard">标准</option>
                <option value="large">大图</option>
              </select>
            </label>
            <select value={sortMode} onChange={(event) => setSortMode(event.target.value)} aria-label="排序方式">
              <option value="timeAsc">按时间升序</option>
              <option value="timeDesc">按时间降序</option>
              <option value="nameAsc">按文件名升序</option>
              <option value="nameDesc">按文件名降序</option>
            </select>
            <label className="sort-search">
              <input value={searchText} placeholder="搜索文件名" onChange={(event) => { setSearchText(event.target.value); setPage(1); }} />
            </label>
          </div>

          <div className="sort-batch-toolbar">
            <button type="button" onClick={selectCurrentPage}>全选当前页</button>
            <button type="button" onClick={() => setSelectedIds([])}>取消选择</button>
            <button type="button" onClick={selectUnassigned}>选择未分拣</button>
            <button type="button" onClick={invertCurrentPage}>反选当前页</button>
            <button type="button" onClick={markIgnored}>标记忽略</button>
            <button type="button" onClick={cancelIgnored}>取消忽略</button>
            <span>已选择 <strong>{selectedIds.length}</strong> 张</span>
            <small className="sort-selection-help">单击选择/取消；Ctrl+单击多选；Shift+单击连续选择。</small>
          </div>

          <div className={`sort-photo-browser ${viewMode} thumb-${thumbSize}`}>
            {pagePhotos.length === 0 ? (
              <div className="sort-empty-state">暂无照片。请选择照片文件夹并扫描，或调整筛选条件。</div>
            ) : viewMode === 'grid' ? pagePhotos.map((photo) => (
              <PhotoCard key={photo.id} photo={photo} selected={selectedIds.includes(photo.id)} onClick={(event) => handlePhotoClick(photo, event)} />
            )) : (
              <table className="sort-photo-list">
                <thead>
                  <tr><th>状态</th><th>文件名</th><th>时间</th><th>大小</th><th>分拣信息</th></tr>
                </thead>
                <tbody>
                  {pagePhotos.map((photo) => (
                    <tr key={photo.id} className={selectedIds.includes(photo.id) ? 'selected' : ''} onClick={(event) => handlePhotoClick(photo, event)}>
                      <td><StatusBadge status={photo.sortStatus} missing={photo.originalMissing} /></td>
                      <td title={photo.originalName}>{photo.originalName}</td>
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
            <span>当前显示：第 {visiblePhotos.length ? (safePage - 1) * pageSize + 1 : 0}-{Math.min(safePage * pageSize, visiblePhotos.length)} 条 / 共 {visiblePhotos.length} 条</span>
            <div>
              <button type="button" disabled={safePage <= 1} onClick={() => setPage(1)}>首页</button>
              <button type="button" disabled={safePage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button>
              <strong>第 {safePage} / {totalPages} 页</strong>
              <button type="button" disabled={safePage >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>下一页</button>
              <button type="button" disabled={safePage >= totalPages} onClick={() => setPage(totalPages)}>末页</button>
              <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}>
                <option value={50}>50 / 页</option>
                <option value={100}>100 / 页</option>
              </select>
            </div>
          </div>
        </main>

        <aside className="sort-right-panel panel" ref={rightPanelRef}>
          <div className="sort-selected-summary">
            <span>当前选中：</span>
            <strong>{selectedIds.length} 张</strong>
            <small>{selectedIds.length ? '可将当前归档信息应用到选中照片。' : '请在左侧照片区选择照片后应用归档信息。'}</small>
          </div>
          <PhotoDetail photo={primaryPhoto} selectedCount={selectedIds.length} onEdit={editCurrentPhotoInfo} />
          <div className="sort-form-section">
            <h2>归档信息</h2>
            <div className="sort-form-grid">
              <SelectField label="照片来源" value={form.photoSource} options={configs.photoSources} onChange={(photoSource) => updateForm({ photoSource })} required />
              <SelectField label="项目" value={form.project} options={configs.projects} onChange={(project) => updateForm({ project })} required />
              <SelectField label="部门" value={form.department} options={configs.departments} onChange={(department) => updateForm({ department })} required />
              <SelectField label="水印分类" value={form.watermarkCategory} options={Object.keys(configs.watermarkCategories)} onChange={(watermarkCategory) => updateForm({ watermarkCategory })} required />
              <SelectField label="工作内容" value={form.workContent} options={configs.watermarkCategories?.[form.watermarkCategory]?.items || []} onChange={(workContent) => updateForm({ workContent })} required />
              <InputField label="日期" type="date" value={form.date} onChange={(date) => updateForm({ date })} required />
              <InputField label="位置/区域" value={form.location} placeholder={form.locationPlaceholder || '不填则默认“现场”'} onChange={(location) => updateForm({ location })} />
              <InputField label="事项名称" value={form.itemName} placeholder="不填则默认使用工作内容" onChange={(itemName) => updateForm({ itemName })} />
              <SelectField label="照片阶段" value={form.photoStage} options={configs.photoStages} onChange={(photoStage) => updateForm({ photoStage })} required />
              <SelectField label="处理状态" value={form.processStatus} options={configs.processStatuses} onChange={(processStatus) => updateForm({ processStatus })} />
              <InputField label="关键词" value={form.keywords} onChange={(keywords) => updateForm({ keywords }, { preserveKeywords: true })} wide />
              <TextAreaField label="备注" value={form.remark} onChange={(remark) => updateForm({ remark })} />
            </div>
          </div>

          <div className="sort-assist-section">
            <div className="sort-assist-tabs">
              {assistTabs.map(([key, label]) => (
                <button type="button" key={key} className={activeRightTab === key ? 'active' : ''} onClick={() => setActiveRightTab(key)}>{label}</button>
              ))}
            </div>
            <div className="sort-assist-content">
              {activeRightTab === 'scenes' && configs.sceneExamples.map((scene) => (
                <button type="button" className={`sort-scene-card ${activeSceneTitle === scene.title ? 'selected' : ''}`} key={scene.title} onClick={() => applyScene(scene)}>
                  <strong>{scene.title}</strong>
                  <span>{scene.watermarkCategory} / {scene.workContent}</span>
                </button>
              ))}
              {activeRightTab === 'keywords' && (
                <div className="sort-keyword-cloud">
                  {suggestedKeywords.map((keyword) => (
                    <button type="button" key={keyword} className={activeKeywords.includes(keyword) ? 'active' : ''} onClick={() => updateForm({ keywords: toggleKeyword(form.keywords, keyword) }, { preserveKeywords: true })}>{keyword}</button>
                  ))}
                  {suggestedKeywords.length === 0 && <span className="muted">填写位置/事项后会出现更多推荐关键词。</span>}
                </div>
              )}
            </div>
          </div>

          <div className="sort-main-actions">
            <section className="sort-action-section">
              <h3>当前照片</h3>
              <button type="button" className="sort-secondary-action" title="编辑当前照片" onClick={editCurrentPhotoInfo} disabled={!primaryPhoto?.archiveInfo}>编辑</button>
              <button type="button" className="primary sort-save-current-button" title="保存到当前照片" onClick={saveCurrentPhotoInfo} disabled={!editingPhoto}>保存</button>
            </section>
            <section className="sort-action-section batch">
              <h3>批量操作</h3>
              <button type="button" className="primary sort-apply-button" title={`应用到选中照片（${selectedIds.length}）`} onClick={applyInfoToSelected} disabled={selectedIds.length === 0}>应用（{selectedIds.length}）</button>
              <button type="button" className="sort-secondary-action" title="生成归档预览" onClick={buildSortPreview} disabled={isBusy || assignedCount === 0}>预览</button>
              <button type="button" className="primary orange" title={`确认归档（${previewPhotos.length}）`} onClick={requestArchive} disabled={isBusy || previewPhotos.length === 0}>归档（{previewPhotos.length}）</button>
              <button type="button" className="sort-secondary-action danger" title={`清除归档信息（${selectedIds.length}）`} onClick={clearSelectedInfo} disabled={selectedIds.length === 0}>清除（{selectedIds.length}）</button>
            </section>
            <p className={`sort-right-tip ${status.type}`}>{status.text}</p>
          </div>
        </aside>
      </div>

      <footer className="sort-bottom-bar">
        <div className="sort-stat-cards">
          <Stat label="全部" value={stats.total} />
          <Stat label="已选择" value={stats.selected} />
          <Stat label="未分拣" value={stats.unassigned} />
          <Stat label="已分拣" value={stats.assigned} />
          <Stat label="已预览" value={stats.previewed} />
          <Stat label="已归档" value={stats.archived} />
          <Stat label="失败" value={stats.failed} />
          <Stat label="已忽略" value={stats.ignored} />
        </div>
        <div className={`sort-status ${status.type}`}>{status.text} <span>版本：{APP_VERSION}</span></div>
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
    </div>
  );
}

function SortSection({ title, action, children, scrollable = false }) {
  return (
    <section className={`sort-filter-section ${scrollable ? 'scrollable' : ''}`}>
      <header><h3>{title}</h3>{action}</header>
      <div>{children}</div>
    </section>
  );
}

function PhotoCard({ photo, selected, onClick }) {
  const gridSummary = buildGridPhotoSummary(photo);
  const newName = photo.previewInfo?.newName || photo.previewInfo?.newFileName || photo.previewInfo?.targetName || '';
  return (
    <button type="button" className={`sort-photo-card ${selected ? 'selected' : ''}`} onClick={onClick} title={photo.originalPath}>
      <div className="sort-thumb-wrap">
        {photo.originalMissing ? <span className="sort-missing-thumb">原图缺失</span> : <img src={photo.previewUrl} alt={photo.originalName} />}
        <span className="sort-ext">{photo.extension?.replace('.', '').toUpperCase()}</span>
        {selected && <span className="sort-check">✓</span>}
      </div>
      <strong>{photo.originalName}</strong>
      <span>{formatDateTime(photo.modifiedAt)}</span>
      {gridSummary && (
        <p className="sort-grid-summary" title={gridSummary.full}>
          <b>{gridSummary.main}</b>
          {gridSummary.sub && <small>{gridSummary.sub}</small>}
        </p>
      )}
      {newName && <p className="sort-grid-new-name" title={newName}>新名：{newName}</p>}
      <footer>
        <StatusBadge status={photo.sortStatus} missing={photo.originalMissing} />
        <small>{formatFileSize(photo.size)}</small>
      </footer>
    </button>
  );
}

function PhotoDetail({ photo, selectedCount, onEdit }) {
  if (!photo) {
    return <section className="sort-detail-empty">请选择或扫描照片。</section>;
  }
  const info = photo.archiveInfo;
  return (
    <section className="sort-detail-card">
      <h2>照片详情</h2>
      {selectedCount === 1
        ? (photo.originalMissing ? <div className="sort-missing-detail">原始照片文件未找到。<br />请点击“重新定位照片文件夹”尝试恢复。</div> : <img src={photo.previewUrl} alt={photo.originalName} />)
        : <div className="sort-multi-selected">已选择 {selectedCount} 张照片，可批量应用右侧归档信息。</div>}
      <dl>
        <div><dt>文件名</dt><dd title={photo.originalName}>{photo.originalName}</dd></div>
        <div><dt>时间</dt><dd>{formatDateTime(photo.modifiedAt)}</dd></div>
        <div><dt>大小</dt><dd>{formatFileSize(photo.size)}</dd></div>
        <div><dt>当前状态</dt><dd><StatusBadge status={photo.sortStatus} missing={photo.originalMissing} /></dd></div>
        {photo.originalMissing && <div><dt>缺失说明</dt><dd>原始照片文件未找到，可能已被移动、删除或来源目录已变更。请点击“重新定位照片文件夹”尝试恢复。</dd></div>}
        {photo.previewInfo && <div><dt>新文件名</dt><dd title={photo.previewInfo.newName || photo.previewInfo.newFileName || photo.previewInfo.targetName || '-'}>{photo.previewInfo.newName || photo.previewInfo.newFileName || photo.previewInfo.targetName || '-'}</dd></div>}
        <div><dt>所属分组</dt><dd title={getPhotoGroupName(photo)}>{getPhotoGroupName(photo)}</dd></div>
        <div><dt>是否已分拣</dt><dd>{info ? '已应用归档信息' : '未分拣'}</dd></div>
      </dl>
      {info ? (
        <div className="sort-info-summary">
          <header>
            <strong>已应用归档信息</strong>
            <button type="button" onClick={onEdit}>编辑当前照片归档信息</button>
          </header>
          <dl>
            {[
              ['照片来源', info.photoSource],
              ['项目', info.project],
              ['部门', info.department],
              ['水印分类', info.watermarkCategory],
              ['工作内容', info.workContent],
              ['位置/区域', info.location || '现场'],
              ['事项名称', info.itemName || info.workItem || info.workContent],
              ['日期', info.date],
              ['照片阶段', info.photoStage],
              ['处理状态', info.processStatus],
              ['关键词', info.keywords],
              ['备注', info.remark]
            ].map(([label, value]) => (
              <div key={label}><dt>{label}</dt><dd title={value || '-'}>{value || '-'}</dd></div>
            ))}
          </dl>
        </div>
      ) : (
        <p className="sort-unassigned-note">该照片尚未应用归档信息。</p>
      )}
    </section>
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

function SelectField({ label, value, options, onChange, required = false }) {
  return (
    <label className="field">
      <span>{label}{required && <b>*</b>}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
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

function Stat({ label, value }) {
  return <span><small>{label}</small><strong>{value}</strong></span>;
}

function reconcileForm(current, configs) {
  const categories = Object.keys(configs.watermarkCategories || {});
  const watermarkCategory = pick(current.watermarkCategory, categories);
  return {
    ...current,
    photoSource: pick(current.photoSource, configs.photoSources),
    project: pick(current.project, configs.projects),
    department: pick(current.department, configs.departments),
    watermarkCategory,
    workContent: pick(current.workContent, configs.watermarkCategories?.[watermarkCategory]?.items || []),
    photoStage: pick(current.photoStage, configs.photoStages),
    processStatus: pick(current.processStatus, configs.processStatuses)
  };
}

function pick(value, options = []) {
  return options.includes(value) ? value : (options[0] || value || '');
}

function validateSortForm(form) {
  return [
    ['照片来源', form.photoSource],
    ['项目', form.project],
    ['部门', form.department],
    ['水印分类', form.watermarkCategory],
    ['工作内容', form.workContent],
    ['日期', form.date],
    ['照片阶段', form.photoStage]
  ].filter(([, value]) => !String(value || '').trim()).map(([label]) => label);
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

function getStats(photos, selectedIds) {
  return {
    total: photos.length,
    selected: selectedIds.length,
    unassigned: photos.filter((photo) => photo.sortStatus === 'unassigned').length,
    assigned: photos.filter((photo) => photo.sortStatus === 'assigned').length,
    previewed: photos.filter((photo) => photo.sortStatus === 'previewed').length,
    archived: photos.filter((photo) => photo.sortStatus === 'archived').length,
    failed: photos.filter((photo) => photo.sortStatus === 'failed').length,
    ignored: photos.filter((photo) => photo.sortStatus === 'ignored').length
  };
}

function getFilterCount(key, photos, selectedIds) {
  if (key === 'all') return photos.length;
  if (key === 'selected') return selectedIds.length;
  return photos.filter((photo) => photo.sortStatus === key).length;
}

function getPhotoGroupName(photo) {
  return photo.archiveInfo?.itemName || photo.archiveInfo?.workContent || '未分组';
}

function buildGridPhotoSummary(photo) {
  if (photo.originalMissing) {
    return { main: '原图缺失', sub: '请重新定位照片文件夹', full: '原图缺失，请重新定位照片文件夹后再预览或归档。' };
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

function normalizeThumbSize(value) {
  if (value === 'large') return 'large';
  return 'standard';
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

function fillTemplate(template, form, scene = {}) {
  return String(template || '')
    .replaceAll('具体位置', form.location || '位置/区域')
    .replaceAll('位置/区域', form.location || '位置/区域')
    .replaceAll('工作事项', scene.itemName || form.itemName || form.workContent || '事项名称')
    .replaceAll('事项名称', scene.itemName || form.itemName || form.workContent || '事项名称');
}

function unique(values) {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
}

function groupColor(index) {
  return ['#2f80ed', '#f2994a', '#27ae60', '#eb5757', '#9b51e0', '#00a889', '#8f6b32'][index % 7];
}
