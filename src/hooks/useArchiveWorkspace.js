import { useEffect, useState } from 'react';
import dayjs from 'dayjs';
import { buildArchiveSuggestion, filterEmptyPatch, suggestionToFormPatch } from '../utils/archiveSuggestionRules.js';
import { getSuggestedKeywords } from '../utils/formatters.js';
import { addRecentRecord, clearRecentRecords, loadRecentRecords } from '../utils/recentRecords.js';
import { recordRuntimeLog } from '../utils/runtimeLogger.js';
import { withRuntimeConfigFallback } from '../utils/runtimeConfig.js';
import { validateArchiveReady } from '../utils/validators.js';

const defaultForm = {
  photoSource: '马克水印相机',
  project: '潇湘新区二期',
  department: '工程',
  watermarkCategory: '工程类专用',
  workContent: '公共设施设备维修',
  date: dayjs().format('YYYY-MM-DD'),
  location: '',
  workItem: '',
  photoStage: '现场照片',
  processStatus: '待处理',
  keywords: '',
  remark: '',
  locationPlaceholder: ''
};

export function useArchiveWorkspace() {
  const [configs, setConfigs] = useState(null);
  const [form, setForm] = useState(defaultForm);
  const [photoFolder, setPhotoFolder] = useState('');
  const [archiveRoot, setArchiveRoot] = useState('');
  const [settings, setSettings] = useState(null);
  const [appPaths, setAppPaths] = useState(null);
  const [configPaths, setConfigPaths] = useState(null);
  const [photos, setPhotos] = useState([]);
  const [previewItems, setPreviewItems] = useState([]);
  const [previewPlan, setPreviewPlan] = useState(null);
  const [recentRecords, setRecentRecords] = useState([]);
  const [status, setStatus] = useState({ type: 'idle', text: '请选择照片文件夹和归档根目录。' });
  const [isBusy, setIsBusy] = useState(false);
  const [archiveSuggestion, setArchiveSuggestion] = useState(null);
  const [ignoredSuggestionKey, setIgnoredSuggestionKey] = useState('');

  useEffect(() => {
    setRecentRecords(loadRecentRecords());
    Promise.all([
      window.archiveAssistant.loadRuntimeConfiguration(),
      window.archiveAssistant.getAppPaths(),
      window.archiveAssistant.getConfigPaths()
    ])
      .then(([runtimeConfiguration, loadedAppPaths, loadedConfigPaths]) => {
        const safeConfigs = withRuntimeConfigFallback(runtimeConfiguration.configs);
        setConfigs(safeConfigs);
        setForm((current) => reconcileFormWithConfigs(current, safeConfigs));
        setSettings(runtimeConfiguration.settings || {});
        setAppPaths(loadedAppPaths);
        setConfigPaths(loadedConfigPaths);
        setPhotoFolder(runtimeConfiguration.photoSourceDirectory || '');
        setArchiveRoot(runtimeConfiguration.archiveRootDirectory || '');
        setStatus({
          type: 'success',
          text: runtimeConfiguration.photoSourceDirectory || runtimeConfiguration.archiveRootDirectory
            ? '统一运行配置已加载，可以继续归档。'
            : '请选择照片文件夹和归档根目录。'
        });
      })
      .catch((error) => {
        recordRuntimeLog({ page: '快速归档', operation: '配置读取', errorType: '配置读取失败', summary: error.message, error });
        setStatus({ type: 'error', text: `配置加载失败：${error.message}` });
      });
  }, []);

  useEffect(() => {
    if (!configs) return;
    const suggestion = buildSuggestion(form);
    const suggestionKey = getSuggestionKey(suggestion);
    if (!suggestionKey || suggestionKey === ignoredSuggestionKey || suggestion.isEmpty) {
      setArchiveSuggestion(null);
      return;
    }
    setArchiveSuggestion(suggestion);
  }, [
    configs,
    form.department,
    form.watermarkCategory,
    form.workContent,
    form.workItem,
    form.location,
    form.processStatus,
    form.photoStage,
    photos.length,
    recentRecords,
    ignoredSuggestionKey
  ]);

  function updateForm(nextPatch, options = {}) {
    setForm((current) => {
      const next = { ...current, ...nextPatch };
      if (nextPatch.watermarkCategory && configs?.watermarkCategories?.[nextPatch.watermarkCategory]) {
        const items = configs.watermarkCategories[nextPatch.watermarkCategory].items || [];
        if (!items.includes(next.workContent)) {
          next.workContent = items[0] || '';
        }
      }
      if (!options.preserveKeywords && (nextPatch.workContent || nextPatch.watermarkCategory || nextPatch.workItem || nextPatch.location || nextPatch.processStatus)) {
        next.keywords = getSuggestedKeywords(next, configs);
      }
      return next;
    });
    setPreviewItems([]);
    setPreviewPlan(null);
  }

  function applyScene(scene) {
    const suggestion = buildSuggestion({ ...form, watermarkCategory: scene.watermarkCategory, workContent: scene.workContent }, { scene });
    setArchiveSuggestion(suggestion);
    setIgnoredSuggestionKey('');
    setStatus({ type: 'success', text: `已生成“${scene.title}”归档建议，请确认后再应用到表单。` });
  }

  function applyRecentRecord(record) {
    updateForm({
      project: record.project,
      department: record.department,
      photoSource: record.photoSource,
      watermarkCategory: record.watermarkCategory,
      workContent: record.workContent,
      location: record.location,
      workItem: record.workItem,
      photoStage: record.photoStage,
      processStatus: record.processStatus,
      keywords: record.keywords,
      remark: record.remark
    }, { preserveKeywords: true });
    setStatus({ type: 'success', text: '已套用最近使用记录，可继续修改后生成预览。' });
  }

  function buildSuggestion(nextForm = form, extra = {}) {
    return buildArchiveSuggestion({
      ...nextForm,
      workContent: nextForm.workContent,
      workItem: nextForm.workItem,
      historyRecords: recentRecords,
      photoCount: photos.length,
      mode: 'quick',
      ...extra
    }, configs || {});
  }

  function applyArchiveSuggestion(options = {}) {
    if (!archiveSuggestion || archiveSuggestion.isEmpty) return;
    const patch = suggestionToFormPatch(archiveSuggestion, 'quick');
    const nextPatch = options.onlyEmpty ? filterEmptyPatch(patch, form) : patch;
    if (Object.keys(nextPatch).length === 0) {
      setStatus({ type: 'idle', text: '当前表单没有需要自动填充的空字段。' });
      return;
    }
    updateForm(nextPatch, { preserveKeywords: true });
    setStatus({ type: 'success', text: options.onlyEmpty ? '已将建议填入空字段，请核对后生成预览。' : '已应用归档建议，请核对后生成预览。' });
  }

  function ignoreArchiveSuggestion() {
    setIgnoredSuggestionKey(getSuggestionKey(archiveSuggestion));
    setArchiveSuggestion(null);
    setStatus({ type: 'idle', text: '已忽略本次归档建议，仍可手动填写归档信息。' });
  }

  function clearRecentRecordList() {
    const next = clearRecentRecords();
    setRecentRecords(next);
    setStatus({ type: 'success', text: '最近使用记录已清空。' });
  }

  async function selectPhotoFolder() {
    const selected = await window.archiveAssistant.selectPhotoFolder();
    if (selected) {
      await setPhotoFolderAndRemember(selected);
      setStatus({ type: 'idle', text: '照片文件夹已选择，请点击“扫描照片”。' });
    }
  }

  async function selectArchiveRoot() {
    const selected = await window.archiveAssistant.selectArchiveRoot();
    if (selected) {
      await setArchiveRootAndRemember(selected);
      setStatus({ type: 'idle', text: '归档根目录已选择，台账将保存在该目录下。' });
    }
  }

  async function setPhotoFolderAndRemember(folderPath) {
    const runtimeConfiguration = await window.archiveAssistant.saveRuntimeDirectory('photoSource', folderPath);
    setPhotoFolder(runtimeConfiguration.photoSourceDirectory || '');
    setSettings(runtimeConfiguration.settings || {});
    setPhotos([]);
    setPreviewItems([]);
    setPreviewPlan(null);
  }

  async function setArchiveRootAndRemember(folderPath) {
    const runtimeConfiguration = await window.archiveAssistant.saveRuntimeDirectory('archiveRoot', folderPath);
    setArchiveRoot(runtimeConfiguration.archiveRootDirectory || '');
    setSettings(runtimeConfiguration.settings || {});
    setPreviewItems([]);
    setPreviewPlan(null);
  }

  async function useSavedPhotoFolder(folderPath) {
    if (!folderPath) {
      setStatus({ type: 'error', text: '没有可用的上次照片文件夹。' });
      return;
    }
    const exists = await window.archiveAssistant.validatePathExists(folderPath);
    if (!exists) {
      setStatus({ type: 'warning', text: '上次目录不存在，请重新选择。' });
      return;
    }
    await setPhotoFolderAndRemember(folderPath);
    setStatus({ type: 'success', text: '已使用保存的照片文件夹。' });
  }

  async function useSavedArchiveRoot(folderPath, label = '归档根目录') {
    if (!folderPath) {
      setStatus({ type: 'error', text: `没有可用的${label}。` });
      return;
    }
    const exists = await window.archiveAssistant.validatePathExists(folderPath);
    if (!exists) {
      setStatus({ type: 'warning', text: '上次目录不存在，请重新选择。' });
      return;
    }
    await setArchiveRootAndRemember(folderPath);
    setStatus({ type: 'success', text: `已使用${label}。` });
  }

  async function setCurrentArchiveRootAsDefault() {
    if (!archiveRoot) {
      setStatus({ type: 'error', text: '请先选择归档根目录。' });
      return;
    }
    const exists = await window.archiveAssistant.validatePathExists(archiveRoot);
    if (!exists) {
      setStatus({ type: 'warning', text: '当前归档根目录不存在，请重新选择。' });
      return;
    }
    const runtimeConfiguration = await window.archiveAssistant.saveRuntimeDirectory('archiveRoot', archiveRoot);
    setSettings(runtimeConfiguration.settings || {});
    setStatus({ type: 'success', text: '已设为默认归档根目录。' });
  }

  async function scanPhotos() {
    if (!photoFolder) {
      setStatus({ type: 'error', text: '请先选择照片文件夹。' });
      return false;
    }

    setIsBusy(true);
    try {
      const scanResult = await window.archiveAssistant.scanConfiguredImages();
      if (scanResult?.success !== true) {
        setStatus({ type: 'error', text: scanResult?.message || '照片来源目录当前不可用。' });
        return false;
      }
      const scanned = scanResult.photos || [];
      setPhotos(scanned);
      setPreviewItems([]);
      setPreviewPlan(null);
      setStatus({
        type: scanResult.failures?.length ? 'warning' : 'success',
        text: `扫描完成，共找到 ${scanned.length} 张健康图片。${scanResult.failures?.length ? `另有 ${scanResult.failures.length} 个文件未通过健康检查。` : ''}`
      });
      return true;
    } catch (error) {
      recordRuntimeLog({ page: '快速归档', operation: '扫描照片', errorType: '扫描照片失败', summary: error.message, error });
      setStatus({ type: 'error', text: `扫描失败：${error.message}` });
    } finally {
      setIsBusy(false);
    }
    return false;
  }

  async function rescanPhotos() {
    if (!photoFolder) {
      setStatus({ type: 'error', text: '请先选择照片文件夹。' });
      return false;
    }
    if ((photos.length > 0 || previewItems.length > 0) && !window.confirm('重新扫描会覆盖当前照片列表，并清空归档预览和归档结果，但不会删除、移动或修改原图。确定继续吗？')) {
      return false;
    }
    return scanPhotos();
  }

  function clearScannedPhotos() {
    if (photos.length === 0 && previewItems.length === 0) {
      setStatus({ type: 'idle', text: '当前没有需要清空的照片列表。' });
      return;
    }
    const confirmed = window.confirm('仅清空当前扫描列表，不会删除原始照片。确定清空吗？');
    if (!confirmed) return;
    setPhotos([]);
    setPreviewItems([]);
    setPreviewPlan(null);
    setStatus({ type: 'success', text: '已清空当前照片列表，原始照片未受影响。' });
  }

  function clearArchivePreview() {
    if (previewItems.length === 0) return;
    setPreviewItems([]);
    setPreviewPlan(null);
    setStatus({ type: 'success', text: '已清除本次归档预览和结果显示，照片列表与归档信息保持不变。' });
  }

  async function buildPreview() {
    const validation = validateArchiveReady(form, photos, archiveRoot, photoFolder);
    if (!validation.valid) {
      setStatus({ type: 'error', text: validation.message });
      return false;
    }

    setIsBusy(true);
    try {
      const archiveForm = withArchiveFallbacks(form);
      const preview = await window.archiveAssistant.buildArchivePreview({ form: archiveForm, photos });
      setPreviewItems(preview.items);
      setPreviewPlan(preview.previewPlan);
      const fallbackNotes = [
        !String(form.workItem || '').trim() && '事项名称未填写，已默认使用工作内容',
        !String(form.location || '').trim() && '位置/区域未填写，已默认使用“现场”'
      ].filter(Boolean);
      setStatus({
        type: 'success',
        text: `预览已生成，共 ${preview.items.length} 张照片。${fallbackNotes.length ? `${fallbackNotes.join('；')}。` : ''}请核对新文件名和归档摘要后再确认归档。`
      });
      return true;
    } catch (error) {
      recordRuntimeLog({ page: '快速归档', operation: '生成预览', errorType: '生成预览失败', summary: error.message, error });
      setStatus({ type: 'error', text: `预览生成失败：${error.message}` });
    } finally {
      setIsBusy(false);
    }
    return false;
  }

  async function archivePhotos() {
    if (previewItems.length === 0 || !previewPlan) {
      setStatus({ type: 'error', text: '请先生成归档预览，确认后再归档。' });
      return false;
    }

    setIsBusy(true);
    try {
      const result = await window.archiveAssistant.archivePhotos({ previewPlan });
      setPreviewItems(result.items);
      if (result.success) setPreviewPlan(null);
      if (result.successCount > 0) {
        setRecentRecords((records) => addRecentRecord(records, withArchiveFallbacks(form)));
      }
      setStatus({
        type: result.success ? 'success' : 'warning',
        text: result.success
          ? `归档成功：已复制 ${result.successCount} 张照片，原图仍保留在原文件夹，台账已追加。`
          : `归档完成但有失败：成功 ${result.successCount} 张，失败 ${result.failedCount} 张。请查看预览表格中的失败原因。`
      });
      return result;
    } catch (error) {
      recordRuntimeLog({ page: '快速归档', operation: '确认归档', errorType: '确认归档失败', summary: error.message, error });
      setStatus({ type: 'error', text: `归档失败：${error.message}` });
    } finally {
      setIsBusy(false);
    }
    return false;
  }

  async function openArchiveRoot() {
    if (!archiveRoot) {
      setStatus({ type: 'error', text: '请先选择归档根目录。' });
      return;
    }
    const result = await window.archiveAssistant.openPath(archiveRoot);
    setStatus(result.success
      ? { type: 'success', text: '已打开归档文件夹。' }
      : { type: 'error', text: `打开归档文件夹失败：${result.message || '请检查目录是否存在。'}` });
  }

  async function openLedger() {
    if (!archiveRoot) {
      setStatus({ type: 'error', text: '请先选择归档根目录。' });
      return;
    }
    const result = await window.archiveAssistant.openLedger(archiveRoot);
    setStatus(result.success
      ? { type: 'success', text: '已打开照片归档台账。' }
      : { type: 'error', text: `打开照片台账失败：${result.message || '请先完成一次归档生成台账。'}` });
  }

  async function updatePreviewItem(id, patch) {
    const nextItems = previewItems.map((item) => (item.id === id ? { ...item, ...patch } : item));
    setPreviewItems(nextItems);

    try {
      const rebuilt = await window.archiveAssistant.buildArchivePreview({
        form,
        photos: nextItems.map((item) => ({
          ...item,
          path: item.sourcePath,
          name: item.originalName
        }))
      });
      setPreviewItems(rebuilt.items);
      setPreviewPlan(rebuilt.previewPlan);
    } catch {
      setPreviewItems(nextItems);
      setPreviewPlan(null);
    }
  }

  async function handleConfigsSaved(runtimeConfigs) {
    const safeConfigs = withRuntimeConfigFallback(runtimeConfigs);
    setConfigs(safeConfigs);
    setForm((current) => reconcileFormWithConfigs(current, safeConfigs));
    setPreviewItems([]);
    setPreviewPlan(null);
    setStatus({ type: 'success', text: '配置已更新，归档表单已刷新。' });
  }

  async function clearRecentPhotoFolders() {
    const nextSettings = await window.archiveAssistant.saveSettings({ ...settings, recentPhotoFolders: [] });
    setSettings(nextSettings);
    setStatus({ type: 'success', text: '最近照片文件夹记录已清空。' });
  }

  async function clearRecentArchiveRoots() {
    const nextSettings = await window.archiveAssistant.saveSettings({ ...settings, recentArchiveRoots: [] });
    setSettings(nextSettings);
    setStatus({ type: 'success', text: '最近归档根目录记录已清空。' });
  }

  return {
    configs,
    form,
    photoFolder,
    archiveRoot,
    settings,
    appPaths,
    configPaths,
    photos,
    previewItems,
    previewPlan,
    recentRecords,
    status,
    isBusy,
    updateForm,
    applyScene,
    applyRecentRecord,
    clearRecentRecordList,
    selectPhotoFolder,
    selectArchiveRoot,
    useSavedPhotoFolder,
    useSavedArchiveRoot,
    setCurrentArchiveRootAsDefault,
    scanPhotos,
    rescanPhotos,
    clearScannedPhotos,
    clearArchivePreview,
    buildPreview,
    archivePhotos,
    openArchiveRoot,
    openLedger,
    updatePreviewItem,
    handleConfigsSaved,
    clearRecentPhotoFolders,
    clearRecentArchiveRoots,
    archiveSuggestion,
    applyArchiveSuggestion,
    ignoreArchiveSuggestion,
    setStatus
  };
}

function getSuggestionKey(suggestion) {
  if (!suggestion) return '';
  return [
    suggestion.watermarkCategory,
    suggestion.workContent,
    suggestion.itemName,
    suggestion.location || suggestion.locationPlaceholder
  ].filter(Boolean).join('|');
}

function fillSceneTemplate(template, currentForm, scene) {
  return String(template)
    .replaceAll('具体位置', currentForm.location || '位置/区域')
    .replaceAll('位置/区域', currentForm.location || '位置/区域')
    .replaceAll('工作事项', scene.itemName || currentForm.workItem || currentForm.workContent || '事项名称')
    .replaceAll('事项名称', scene.itemName || currentForm.workItem || currentForm.workContent || '事项名称');
}

function withArchiveFallbacks(currentForm) {
  return {
    ...currentForm,
    workItem: String(currentForm.workItem || '').trim() || currentForm.workContent,
    location: String(currentForm.location || '').trim() || '现场'
  };
}

function reconcileFormWithConfigs(current, configs) {
  if (!configs) return current;
  const next = { ...current };
  next.photoSource = pickValid(next.photoSource, configs.photoSources);
  next.project = pickValid(next.project, configs.projects);
  next.department = pickValid(next.department, configs.departments);
  next.watermarkCategory = pickValid(next.watermarkCategory, Object.keys(configs.watermarkCategories || {}));
  next.workContent = pickValid(next.workContent, configs.watermarkCategories?.[next.watermarkCategory]?.items || []);
  next.photoStage = pickValid(next.photoStage, configs.photoStages);
  next.processStatus = pickValid(next.processStatus, configs.processStatuses);
  return next;
}

function pickValid(value, options = []) {
  return options.includes(value) ? value : (options[0] || value || '');
}
