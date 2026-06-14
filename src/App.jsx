import { useEffect, useState } from 'react';
import dayjs from 'dayjs';
import ArchiveForm from './components/ArchiveForm.jsx';
import PhotoPreviewTable from './components/PhotoPreviewTable.jsx';
import StatusBar from './components/StatusBar.jsx';
import SceneHintBox from './components/SceneHintBox.jsx';
import SmartAssistPanel from './components/SmartAssistPanel.jsx';
import { getSuggestedKeywords } from './utils/formatters.js';
import { addRecentRecord, clearRecentRecords, loadRecentRecords } from './utils/recentRecords.js';
import { validateArchiveReady } from './utils/validators.js';

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
  remark: ''
};

export default function App() {
  const [configs, setConfigs] = useState(null);
  const [form, setForm] = useState(defaultForm);
  const [photoFolder, setPhotoFolder] = useState('');
  const [archiveRoot, setArchiveRoot] = useState('');
  const [settings, setSettings] = useState(null);
  const [photos, setPhotos] = useState([]);
  const [previewItems, setPreviewItems] = useState([]);
  const [recentRecords, setRecentRecords] = useState([]);
  const [status, setStatus] = useState({ type: 'idle', text: '请选择照片文件夹和归档根目录。' });
  const [isBusy, setIsBusy] = useState(false);

  useEffect(() => {
    setRecentRecords(loadRecentRecords());
    Promise.all([window.archiveAssistant.loadConfigs(), window.archiveAssistant.loadSettings()])
      .then(([loadedConfigs, loadedSettings]) => {
        setConfigs(loadedConfigs);
        setSettings(loadedSettings);
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
      text: notices.length ? `${notices.join('；')}。` : '默认配置已加载，可以开始归档。请先选择照片文件夹和归档根目录。'
    });
  }

  function updateForm(nextPatch, options = {}) {
    setForm((current) => {
      const next = { ...current, ...nextPatch };
      if (nextPatch.watermarkCategory && !nextPatch.workContent && configs?.watermarkCategories?.[nextPatch.watermarkCategory]) {
        next.workContent = configs.watermarkCategories[nextPatch.watermarkCategory].items[0] || '';
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
      workItem: scene.workItemSuggestion || scene.title,
      processStatus: scene.processStatusSuggestion || form.processStatus,
      photoStage: scene.photoStageSuggestion || form.photoStage,
      keywords: (scene.keywords || []).join('、'),
      remark: fillSceneTemplate(scene.remarkTemplate || '', form, scene)
    }, { preserveKeywords: true });
    setStatus({ type: 'success', text: `已套用常见场景：${scene.title}。请补充具体位置后生成预览。` });
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
      setPhotoFolder(selected);
      const nextSettings = await window.archiveAssistant.updateLastPhotoFolder(selected);
      setSettings(nextSettings);
      setPhotos([]);
      setPreviewItems([]);
      setStatus({ type: 'idle', text: '照片文件夹已选择，请点击“扫描照片”。' });
    }
  }

  async function selectArchiveRoot() {
    const selected = await window.archiveAssistant.selectArchiveRoot();
    if (selected) {
      setArchiveRoot(selected);
      const nextSettings = await window.archiveAssistant.updateLastArchiveRoot(selected);
      setSettings(nextSettings);
      setPreviewItems([]);
      setStatus({ type: 'idle', text: '归档根目录已选择，台账将保存在该目录下。' });
    }
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
    setPhotoFolder(folderPath);
    setPhotos([]);
    setPreviewItems([]);
    const nextSettings = await window.archiveAssistant.updateLastPhotoFolder(folderPath);
    setSettings(nextSettings);
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
    setArchiveRoot(folderPath);
    setPreviewItems([]);
    const nextSettings = await window.archiveAssistant.updateLastArchiveRoot(folderPath);
    setSettings(nextSettings);
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
      return;
    }

    setIsBusy(true);
    try {
      const scanned = await window.archiveAssistant.scanImages(photoFolder);
      setPhotos(scanned);
      setPreviewItems([]);
      setStatus({ type: 'success', text: `扫描完成，共找到 ${scanned.length} 张图片。` });
    } catch (error) {
      setStatus({ type: 'error', text: `扫描失败：${error.message}` });
    } finally {
      setIsBusy(false);
    }
  }

  async function buildPreview() {
    const validation = validateArchiveReady(form, photos, archiveRoot, photoFolder);
    if (!validation.valid) {
      setStatus({ type: 'error', text: validation.message });
      return;
    }

    setIsBusy(true);
    try {
      const preview = await window.archiveAssistant.buildArchivePreview({ form, photos, archiveRoot });
      setPreviewItems(preview);
      setStatus({ type: 'success', text: `预览已生成，共 ${preview.length} 张照片。请检查新文件名、目标路径和照片阶段后再确认归档。` });
    } catch (error) {
      setStatus({ type: 'error', text: `预览生成失败：${error.message}` });
    } finally {
      setIsBusy(false);
    }
  }

  async function archivePhotos() {
    if (previewItems.length === 0) {
      setStatus({ type: 'error', text: '请先生成归档预览，确认后再归档。' });
      return;
    }

    const confirmed = window.confirm('确认开始归档？系统只会复制照片，不会移动或删除原图。');
    if (!confirmed) return;

    setIsBusy(true);
    try {
      const result = await window.archiveAssistant.archivePhotos({ archiveRoot, items: previewItems });
      setPreviewItems(result.items);
      if (result.successCount > 0) {
        setRecentRecords((records) => addRecentRecord(records, form));
      }
      setStatus({
        type: result.success ? 'success' : 'warning',
        text: result.success
          ? `归档成功：已复制 ${result.successCount} 张照片，原图仍保留在原文件夹，台账已追加。`
          : `归档完成但有失败：成功 ${result.successCount} 张，失败 ${result.failedCount} 张。请查看预览表格中的失败原因。`
      });
    } catch (error) {
      setStatus({ type: 'error', text: `归档失败：${error.message}` });
    } finally {
      setIsBusy(false);
    }
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

  const selectedCategoryConfig = configs?.watermarkCategories?.[form.watermarkCategory];

  return (
    <main className="app-shell">
      <section className="hero-card">
        <div>
          <p className="eyebrow">本地安全归档 · 只复制不破坏原图</p>
          <h1>物业工作照片归档助手</h1>
          <p className="hero-text">
            将马克水印相机、手机相册、微信导出的工作照片，按项目、部门、分类、位置和日期标准化归档，并自动生成照片台账。
          </p>
        </div>
      </section>

      <StatusBar status={status} isBusy={isBusy} />

      <section className="path-grid">
        <div className="path-card">
          <span>照片文件夹</span>
          <strong>{photoFolder || '尚未选择'}</strong>
          <div className="path-actions">
            <button onClick={selectPhotoFolder}>选择照片文件夹</button>
            <button className="ghost" onClick={() => useSavedPhotoFolder(settings?.lastPhotoFolder)} disabled={!settings?.lastPhotoFolder}>使用上次照片文件夹</button>
            <button className="ghost" onClick={() => photoFolder && window.archiveAssistant.openPath(photoFolder)} disabled={!photoFolder}>打开当前照片文件夹</button>
          </div>
          <select
            className="path-select"
            value=""
            onChange={(event) => event.target.value && useSavedPhotoFolder(event.target.value)}
          >
            <option value="">最近照片文件夹</option>
            {(settings?.recentPhotoFolders || []).map((folderPath) => (
              <option key={folderPath} value={folderPath}>{folderPath}</option>
            ))}
          </select>
        </div>
        <div className="path-card">
          <span>归档根目录</span>
          <strong>{archiveRoot || '尚未选择'}</strong>
          <div className="path-actions">
            <button onClick={selectArchiveRoot} className="secondary">选择归档根目录</button>
            <button className="ghost" onClick={() => useSavedArchiveRoot(settings?.defaultArchiveRoot, '默认归档根目录')} disabled={!settings?.defaultArchiveRoot}>使用默认归档根目录</button>
            <button className="ghost" onClick={() => archiveRoot && window.archiveAssistant.openPath(archiveRoot)} disabled={!archiveRoot}>打开当前归档根目录</button>
            <button className="ghost" onClick={setCurrentArchiveRootAsDefault} disabled={!archiveRoot}>设为默认归档根目录</button>
          </div>
          <select
            className="path-select"
            value=""
            onChange={(event) => event.target.value && useSavedArchiveRoot(event.target.value, '最近归档根目录')}
          >
            <option value="">最近归档根目录</option>
            {(settings?.recentArchiveRoots || []).map((folderPath) => (
              <option key={folderPath} value={folderPath}>{folderPath}</option>
            ))}
          </select>
        </div>
      </section>

      <section className="workspace-grid">
        <ArchiveForm configs={configs} form={form} updateForm={updateForm} />
        <SceneHintBox form={form} categoryConfig={selectedCategoryConfig} sceneExamples={configs?.sceneExamples || []} />
      </section>

      <SmartAssistPanel
        configs={configs}
        form={form}
        updateForm={updateForm}
        recentRecords={recentRecords}
        onApplyScene={applyScene}
        onApplyRecent={applyRecentRecord}
        onClearRecent={clearRecentRecordList}
      />

      <section className="action-strip">
        <button onClick={scanPhotos} disabled={isBusy || !photoFolder}>扫描照片</button>
        <button onClick={buildPreview} disabled={isBusy || photos.length === 0}>生成归档预览</button>
        <button onClick={archivePhotos} disabled={isBusy || previewItems.length === 0} className="primary">确认归档</button>
        <button onClick={openArchiveRoot} disabled={!archiveRoot} className="ghost">打开归档文件夹</button>
        <button onClick={openLedger} disabled={!archiveRoot} className="ghost">打开照片台账</button>
      </section>

      <PhotoPreviewTable
        items={previewItems}
        photos={photos}
        photoStages={configs?.photoStages || []}
        onChangeItem={updatePreviewItem}
      />
    </main>
  );
}

function fillSceneTemplate(template, currentForm, scene) {
  return String(template)
    .replaceAll('具体位置', currentForm.location || '具体位置')
    .replaceAll('工作事项', scene.workItemSuggestion || currentForm.workItem || '工作事项');
}
