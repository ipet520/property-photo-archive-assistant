import { useEffect, useState } from 'react';
import dayjs from 'dayjs';
import { getSuggestedKeywords } from '../utils/formatters.js';
import { addRecentRecord, clearRecentRecords, loadRecentRecords } from '../utils/recentRecords.js';
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
  const [recentRecords, setRecentRecords] = useState([]);
  const [status, setStatus] = useState({ type: 'idle', text: '请选择照片文件夹和归档根目录。' });
  const [isBusy, setIsBusy] = useState(false);

  useEffect(() => {
    setRecentRecords(loadRecentRecords());
    Promise.all([
      window.archiveAssistant.loadConfigs(),
      window.archiveAssistant.loadSettings(),
      window.archiveAssistant.getAppPaths(),
      window.archiveAssistant.getConfigPaths()
    ])
      .then(([loadedConfigs, loadedSettings, loadedAppPaths, loadedConfigPaths]) => {
        setConfigs(loadedConfigs);
        setForm((current) => reconcileFormWithConfigs(current, loadedConfigs));
        setSettings(loadedSettings);
        setAppPaths(loadedAppPaths);
        setConfigPaths(loadedConfigPaths);
        restoreSavedPaths(loadedSettings);
      })
      .catch((error) => setStatus({ type: 'error', text: `配置加载失败：${error.message}` }));
  }, []);

  function restoreSavedPaths(loadedSettings) {
    const notices = [];
    if (loadedSettings.pathStatus?.lastPhotoFolderExists) {
      setPhotoFolder(loadedSettings.lastPhotoFolder);
      notices.push('已恢复上次照片文件夹');
    } else if (loadedSettings.lastPhotoFolder) {
      notices.push('上次照片文件夹不存在，请重新选择');
    }

    if (loadedSettings.pathStatus?.lastArchiveRootExists) {
      setArchiveRoot(loadedSettings.lastArchiveRoot);
      notices.push('已恢复上次归档根目录');
    } else if (loadedSettings.pathStatus?.defaultArchiveRootExists) {
      setArchiveRoot(loadedSettings.defaultArchiveRoot);
      notices.push('已使用默认归档根目录');
    } else if (loadedSettings.lastArchiveRoot || loadedSettings.defaultArchiveRoot) {
      notices.push('上次归档目录不存在，请重新选择');
    }

    setStatus({
      type: notices.some((item) => item.includes('不存在')) ? 'warning' : 'success',
      text: notices.length ? `${notices.join('；')}。` : '默认配置已加载，可以开始归档。'
    });
  }

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
  }

  function applyScene(scene) {
    updateForm({
      watermarkCategory: scene.watermarkCategory,
      workContent: scene.workContent,
      workItem: scene.itemName || '',
      location: '',
      locationPlaceholder: scene.locationPlaceholder || '',
      processStatus: scene.processStatusSuggestion || scene.processStatus || form.processStatus,
      photoStage: scene.photoStageSuggestion || scene.photoStage || form.photoStage,
      keywords: (scene.keywords || []).join('、'),
      remark: fillSceneTemplate(scene.remarkTemplate || '', form, scene)
    }, { preserveKeywords: true });
    setStatus({ type: 'success', text: `已套用常见场景：${scene.title}。建议补充位置/区域；不填写将默认使用“现场”。` });
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
    setPhotoFolder(folderPath);
    const nextSettings = await window.archiveAssistant.updateLastPhotoFolder(folderPath);
    setSettings(nextSettings);
    setPhotos([]);
    setPreviewItems([]);
  }

  async function setArchiveRootAndRemember(folderPath) {
    setArchiveRoot(folderPath);
    const nextSettings = await window.archiveAssistant.updateLastArchiveRoot(folderPath);
    setSettings(nextSettings);
    setPreviewItems([]);
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
    const nextSettings = await window.archiveAssistant.setDefaultArchiveRoot(archiveRoot);
    setSettings(nextSettings);
    setStatus({ type: 'success', text: '已设为默认归档根目录。' });
  }

  async function scanPhotos() {
    if (!photoFolder) {
      setStatus({ type: 'error', text: '请先选择照片文件夹。' });
      return false;
    }

    setIsBusy(true);
    try {
      const scanned = await window.archiveAssistant.scanImages(photoFolder);
      setPhotos(scanned);
      setPreviewItems([]);
      setStatus({ type: 'success', text: `扫描完成，共找到 ${scanned.length} 张图片。` });
      return true;
    } catch (error) {
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
    setStatus({ type: 'success', text: '已清空当前照片列表，原始照片未受影响。' });
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
      const preview = await window.archiveAssistant.buildArchivePreview({ form: archiveForm, photos, archiveRoot });
      setPreviewItems(preview);
      const fallbackNotes = [
        !String(form.workItem || '').trim() && '事项名称未填写，已默认使用工作内容',
        !String(form.location || '').trim() && '位置/区域未填写，已默认使用“现场”'
      ].filter(Boolean);
      setStatus({
        type: 'success',
        text: `预览已生成，共 ${preview.length} 张照片。${fallbackNotes.length ? `${fallbackNotes.join('；')}。` : ''}请核对新文件名和归档摘要后再确认归档。`
      });
      return true;
    } catch (error) {
      setStatus({ type: 'error', text: `预览生成失败：${error.message}` });
    } finally {
      setIsBusy(false);
    }
    return false;
  }

  async function archivePhotos() {
    if (previewItems.length === 0) {
      setStatus({ type: 'error', text: '请先生成归档预览，确认后再归档。' });
      return false;
    }

    const confirmed = window.confirm('确认开始归档？系统只会复制照片，不会移动或删除原图。');
    if (!confirmed) return false;

    setIsBusy(true);
    try {
      const result = await window.archiveAssistant.archivePhotos({ archiveRoot, items: previewItems });
      setPreviewItems(result.items);
      if (result.successCount > 0) {
        setRecentRecords((records) => addRecentRecord(records, withArchiveFallbacks(form)));
      }
      setStatus({
        type: result.success ? 'success' : 'warning',
        text: result.success
          ? `归档成功：已复制 ${result.successCount} 张照片，原图仍保留在原文件夹，台账已追加。`
          : `归档完成但有失败：成功 ${result.successCount} 张，失败 ${result.failedCount} 张。请查看预览表格中的失败原因。`
      });
      return true;
    } catch (error) {
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
        archiveRoot,
        photos: nextItems.map((item) => ({
          ...item,
          path: item.sourcePath,
          name: item.originalName
        }))
      });
      setPreviewItems(rebuilt);
    } catch {
      setPreviewItems(nextItems);
    }
  }

  async function handleConfigsSaved(runtimeConfigs) {
    setConfigs(runtimeConfigs);
    setForm((current) => reconcileFormWithConfigs(current, runtimeConfigs));
    setPreviewItems([]);
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
    buildPreview,
    archivePhotos,
    openArchiveRoot,
    openLedger,
    updatePreviewItem,
    handleConfigsSaved,
    clearRecentPhotoFolders,
    clearRecentArchiveRoots,
    setStatus
  };
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
