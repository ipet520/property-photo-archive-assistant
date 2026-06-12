import { useEffect, useState } from 'react';
import dayjs from 'dayjs';
import ArchiveForm from './components/ArchiveForm.jsx';
import PhotoPreviewTable from './components/PhotoPreviewTable.jsx';
import StatusBar from './components/StatusBar.jsx';
import SceneHintBox from './components/SceneHintBox.jsx';
import { getSuggestedKeywords } from './utils/formatters.js';
import { validateArchiveReady } from './utils/validators.js';

const defaultForm = {
  photoSource: '马克水印相机',
  project: '澜湾新区二期',
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
  const [photos, setPhotos] = useState([]);
  const [previewItems, setPreviewItems] = useState([]);
  const [status, setStatus] = useState({ type: 'idle', text: '请选择照片文件夹和归档根目录。' });
  const [isBusy, setIsBusy] = useState(false);

  useEffect(() => {
    window.archiveAssistant
      .loadConfigs()
      .then((loadedConfigs) => {
        setConfigs(loadedConfigs);
        setStatus({ type: 'success', text: '默认配置已加载，可以开始归档。' });
      })
      .catch((error) => setStatus({ type: 'error', text: `配置加载失败：${error.message}` }));
  }, []);

  function updateForm(nextPatch) {
    setForm((current) => {
      const next = { ...current, ...nextPatch };
      if (nextPatch.watermarkCategory && configs?.watermarkCategories?.[nextPatch.watermarkCategory]) {
        next.workContent = configs.watermarkCategories[nextPatch.watermarkCategory].items[0] || '';
      }
      if (nextPatch.workContent || nextPatch.watermarkCategory) {
        next.keywords = getSuggestedKeywords(next, configs);
      }
      return next;
    });
    setPreviewItems([]);
  }

  async function selectPhotoFolder() {
    const selected = await window.archiveAssistant.selectPhotoFolder();
    if (selected) {
      setPhotoFolder(selected);
      setPhotos([]);
      setPreviewItems([]);
      setStatus({ type: 'idle', text: '照片文件夹已选择，请点击“扫描照片”。' });
    }
  }

  async function selectArchiveRoot() {
    const selected = await window.archiveAssistant.selectArchiveRoot();
    if (selected) {
      setArchiveRoot(selected);
      setPreviewItems([]);
      setStatus({ type: 'idle', text: '归档根目录已选择，台账将保存在该目录下。' });
    }
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
    const validation = validateArchiveReady(form, photos, archiveRoot);
    if (!validation.valid) {
      setStatus({ type: 'error', text: validation.message });
      return;
    }

    setIsBusy(true);
    try {
      const preview = await window.archiveAssistant.buildArchivePreview({ form, photos, archiveRoot });
      setPreviewItems(preview);
      setStatus({ type: 'success', text: `预览已生成，请确认 ${preview.length} 张照片的目标路径。` });
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
      setStatus({
        type: result.success ? 'success' : 'warning',
        text: `归档完成：成功 ${result.successCount} 张，失败 ${result.failedCount} 张。`
      });
    } catch (error) {
      setStatus({ type: 'error', text: `归档失败：${error.message}` });
    } finally {
      setIsBusy(false);
    }
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
        <div className="hero-actions">
          <button onClick={selectPhotoFolder}>选择照片文件夹</button>
          <button onClick={selectArchiveRoot} className="secondary">选择归档根目录</button>
        </div>
      </section>

      <StatusBar status={status} isBusy={isBusy} />

      <section className="path-grid">
        <div className="path-card">
          <span>照片文件夹</span>
          <strong>{photoFolder || '尚未选择'}</strong>
        </div>
        <div className="path-card">
          <span>归档根目录</span>
          <strong>{archiveRoot || '尚未选择'}</strong>
        </div>
      </section>

      <section className="workspace-grid">
        <ArchiveForm configs={configs} form={form} updateForm={updateForm} />
        <SceneHintBox form={form} categoryConfig={selectedCategoryConfig} sceneExamples={configs?.sceneExamples || []} />
      </section>

      <section className="action-strip">
        <button onClick={scanPhotos} disabled={isBusy}>扫描照片</button>
        <button onClick={buildPreview} disabled={isBusy || photos.length === 0}>生成归档预览</button>
        <button onClick={archivePhotos} disabled={isBusy || previewItems.length === 0} className="primary">确认归档</button>
        <button onClick={() => archiveRoot && window.archiveAssistant.openPath(archiveRoot)} className="ghost">打开归档文件夹</button>
        <button onClick={() => archiveRoot && window.archiveAssistant.openLedger(archiveRoot)} className="ghost">打开照片台账</button>
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
