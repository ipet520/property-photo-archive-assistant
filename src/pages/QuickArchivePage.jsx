import { useState } from 'react';
import ArchiveForm from '../components/ArchiveForm.jsx';
import PhotoPreviewTable from '../components/PhotoPreviewTable.jsx';
import SceneHintBox from '../components/SceneHintBox.jsx';
import { buildRemarkTemplates, formatFileSize, getSuggestedKeywords, splitKeywords, toggleKeyword } from '../utils/formatters.js';

const TAB_KEYS = {
  photos: 'photos',
  preview: 'preview',
  result: 'result'
};

export default function QuickArchivePage({ archiveState }) {
  const [activeTab, setActiveTab] = useState(TAB_KEYS.photos);
  const [assistOpen, setAssistOpen] = useState(true);
  const [assistTab, setAssistTab] = useState('scene');
  const [moreActionsOpen, setMoreActionsOpen] = useState(false);
  const [bottomOpen, setBottomOpen] = useState(false);
  const selectedCategoryConfig = archiveState.configs?.watermarkCategories?.[archiveState.form.watermarkCategory];
  const resultStats = getResultStats(archiveState.previewItems);
  const currentStep = getCurrentStep(archiveState);

  async function buildPreviewAndShowTab() {
    await archiveState.buildPreview();
    setActiveTab(TAB_KEYS.preview);
    setBottomOpen(true);
  }

  async function archiveAndShowResult() {
    await archiveState.archivePhotos();
    setActiveTab(TAB_KEYS.result);
    setBottomOpen(true);
  }

  async function scanAndShowPhotos() {
    await archiveState.scanPhotos();
    setActiveTab(TAB_KEYS.photos);
    setBottomOpen(true);
  }

  return (
    <div className="quick-archive-workbench">
      <QuickFlowSteps currentStep={currentStep} />

      <section className="quick-command-bar">
        <div className="quick-path-summary">
          <PathSummary label="照片文件夹" value={archiveState.photoFolder || '尚未选择'} />
          <PathSummary label="归档根目录" value={archiveState.archiveRoot || '尚未选择'} />
        </div>

        <div className="quick-main-actions">
          <button onClick={archiveState.selectPhotoFolder}>选择照片文件夹</button>
          <button className="secondary" onClick={archiveState.selectArchiveRoot}>选择归档根目录</button>
          <button className="ghost" onClick={() => setMoreActionsOpen((value) => !value)}>{moreActionsOpen ? '收起更多' : '更多目录操作'}</button>
        </div>

        <div className="quick-primary-actions">
          <button onClick={scanAndShowPhotos} disabled={archiveState.isBusy || !archiveState.photoFolder}>
            扫描照片 <span>{archiveState.photos.length}</span>
          </button>
          <button onClick={buildPreviewAndShowTab} disabled={archiveState.isBusy || !archiveState.archiveRoot || archiveState.photos.length === 0}>
            生成预览 <span>{archiveState.previewItems.length}</span>
          </button>
          <button className="primary" onClick={archiveAndShowResult} disabled={archiveState.isBusy || !archiveState.archiveRoot || archiveState.previewItems.length === 0}>
            确认归档 <span>{resultStats.success} / {resultStats.failed}</span>
          </button>
        </div>

        {moreActionsOpen && (
          <div className="quick-secondary-actions">
            <button className="ghost" onClick={() => archiveState.useSavedPhotoFolder(archiveState.settings?.lastPhotoFolder)} disabled={!archiveState.settings?.lastPhotoFolder}>使用上次照片文件夹</button>
            <select value="" onChange={(event) => event.target.value && archiveState.useSavedPhotoFolder(event.target.value)}>
              <option value="">最近照片文件夹</option>
              {(archiveState.settings?.recentPhotoFolders || []).map((folderPath) => <option key={folderPath} value={folderPath}>{folderPath}</option>)}
            </select>
            <button className="ghost" onClick={() => archiveState.photoFolder && window.archiveAssistant.openPath(archiveState.photoFolder)} disabled={!archiveState.photoFolder}>打开照片目录</button>
            <button className="ghost" onClick={() => archiveState.useSavedArchiveRoot(archiveState.settings?.defaultArchiveRoot, '默认归档根目录')} disabled={!archiveState.settings?.defaultArchiveRoot}>使用默认归档根目录</button>
            <select value="" onChange={(event) => event.target.value && archiveState.useSavedArchiveRoot(event.target.value, '最近归档根目录')}>
              <option value="">最近归档根目录</option>
              {(archiveState.settings?.recentArchiveRoots || []).map((folderPath) => <option key={folderPath} value={folderPath}>{folderPath}</option>)}
            </select>
            <button className="ghost" onClick={archiveState.setCurrentArchiveRootAsDefault} disabled={!archiveState.archiveRoot}>设为默认归档根目录</button>
            <button className="ghost" onClick={() => archiveState.archiveRoot && window.archiveAssistant.openPath(archiveState.archiveRoot)} disabled={!archiveState.archiveRoot}>打开归档目录</button>
          </div>
        )}
      </section>

      <section className={`quick-main-grid ${assistOpen ? '' : 'assist-collapsed'}`}>
        <div className="quick-form-column">
          <ArchiveForm configs={archiveState.configs} form={archiveState.form} updateForm={archiveState.updateForm} compact />
        </div>

        <aside className="quick-assist-column">
          <div className="quick-assist-header">
            <div>
              <p className="eyebrow">辅助填写</p>
              <h2>提示、场景、关键词、备注</h2>
            </div>
            <button className="ghost" onClick={() => setAssistOpen((value) => !value)}>{assistOpen ? '折叠' : '展开'}</button>
          </div>
          {assistOpen && (
            <>
              <div className="assist-tabs">
                {[
                  ['hint', '归档提示'],
                  ['scene', '常见场景'],
                  ['keyword', '关键词'],
                  ['remark', '备注模板']
                ].map(([key, label]) => (
                  <button key={key} className={assistTab === key ? 'active' : ''} onClick={() => setAssistTab(key)}>{label}</button>
                ))}
              </div>
              <QuickAssistContent
                activeTab={assistTab}
                archiveState={archiveState}
                selectedCategoryConfig={selectedCategoryConfig}
              />
            </>
          )}
        </aside>
      </section>

      <section className="quick-bottom-panel">
        <div className="quick-tabs">
          <button className={activeTab === TAB_KEYS.photos ? 'active' : ''} onClick={() => setActiveTab(TAB_KEYS.photos)}>照片列表 <span>{archiveState.photos.length}</span></button>
          <button className={activeTab === TAB_KEYS.preview ? 'active' : ''} onClick={() => setActiveTab(TAB_KEYS.preview)}>归档预览 <span>{archiveState.previewItems.length}</span></button>
          <button className={activeTab === TAB_KEYS.result ? 'active' : ''} onClick={() => setActiveTab(TAB_KEYS.result)}>归档结果 <span>{resultStats.success}/{resultStats.failed}</span></button>
          <button className="ghost quick-bottom-toggle" onClick={() => setBottomOpen((value) => !value)}>{bottomOpen ? '收起底部区域' : '展开底部区域'}</button>
        </div>
        <div className={`quick-tab-body ${bottomOpen || archiveState.photos.length > 0 || archiveState.previewItems.length > 0 ? 'expanded' : 'compact-empty'}`}>
          {activeTab === TAB_KEYS.photos && <PhotoList photos={archiveState.photos} />}
          {activeTab === TAB_KEYS.preview && (
            <PhotoPreviewTable
              items={archiveState.previewItems}
              photos={[]}
              photoStages={archiveState.configs?.photoStages || []}
              onChangeItem={archiveState.updatePreviewItem}
              compact
            />
          )}
          {activeTab === TAB_KEYS.result && (
            <ArchiveResultPanel
              items={archiveState.previewItems}
              stats={resultStats}
              onOpenArchiveRoot={archiveState.openArchiveRoot}
              onOpenLedger={archiveState.openLedger}
            />
          )}
        </div>
      </section>
    </div>
  );
}

function QuickFlowSteps({ currentStep }) {
  const steps = [
    ['paths', '选择目录'],
    ['form', '填写信息'],
    ['scan', '扫描照片'],
    ['preview', '生成预览'],
    ['archive', '确认归档']
  ];

  return (
    <section className="quick-flow-steps">
      {steps.map(([key, label], index) => (
        <div key={key} className={`flow-step ${currentStep === key ? 'active' : ''}`}>
          <span>{index + 1}</span>
          <strong>{label}</strong>
        </div>
      ))}
    </section>
  );
}

function PathSummary({ label, value }) {
  return (
    <div className="quick-path-item">
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </div>
  );
}

function QuickAssistContent({ activeTab, archiveState, selectedCategoryConfig }) {
  if (!archiveState.configs) return <p className="muted">正在加载配置...</p>;

  if (activeTab === 'hint') {
    return (
      <SceneHintBox
        form={archiveState.form}
        categoryConfig={selectedCategoryConfig}
        sceneExamples={archiveState.configs.sceneExamples || []}
      />
    );
  }

  if (activeTab === 'scene') {
    return (
      <div className="quick-scene-list">
        {archiveState.configs.sceneExamples.map((scene) => (
          <button type="button" className="scene-chip" key={scene.title} onClick={() => archiveState.applyScene(scene)}>
            <strong>{scene.title}</strong>
            <small>{scene.watermarkCategory} / {scene.workContent}</small>
          </button>
        ))}
      </div>
    );
  }

  if (activeTab === 'keyword') {
    const suggestedKeywords = splitKeywords(getSuggestedKeywords(archiveState.form, archiveState.configs));
    const activeKeywords = splitKeywords(archiveState.form.keywords);
    return (
      <div className="keyword-cloud quick-keyword-cloud">
        <button type="button" className="mini-button" onClick={() => archiveState.updateForm({ keywords: '' }, { preserveKeywords: true })}>清空关键词</button>
        {suggestedKeywords.length === 0 ? (
          <span className="muted">填写工作事项后会出现更多推荐关键词。</span>
        ) : suggestedKeywords.map((keyword) => (
          <button
            type="button"
            key={keyword}
            className={`keyword-chip ${activeKeywords.includes(keyword) ? 'active' : ''}`}
            onClick={() => archiveState.updateForm({ keywords: toggleKeyword(archiveState.form.keywords, keyword) }, { preserveKeywords: true })}
          >
            {keyword}
          </button>
        ))}
      </div>
    );
  }

  const remarkTemplates = buildRemarkTemplates(archiveState.form, archiveState.configs.sceneExamples, archiveState.configs);
  return (
    <div className="template-list quick-template-list">
      {remarkTemplates.map((template) => (
        <button
          type="button"
          key={template}
          className="template-card"
          onClick={() => archiveState.updateForm({ remark: fillTemplate(template, archiveState.form) })}
        >
          {fillTemplate(template, archiveState.form)}
        </button>
      ))}
    </div>
  );
}

function PhotoList({ photos }) {
  if (photos.length === 0) {
    return <div className="empty-state">还没有照片。请选择照片文件夹后点击“扫描照片”。</div>;
  }

  return (
    <div className="quick-table-scroll">
      <table className="quick-table">
        <thead>
          <tr>
            <th>序号</th>
            <th>缩略图</th>
            <th>原文件名</th>
            <th>格式</th>
            <th>大小</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {photos.map((photo, index) => (
            <tr key={photo.id}>
              <td>{index + 1}</td>
              <td><img src={photo.previewUrl} alt={photo.name} /></td>
              <td className="filename" title={photo.name}>{photo.name}</td>
              <td>{photo.extension}</td>
              <td>{formatFileSize(photo.size)}</td>
              <td><span className="row-status">已扫描</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ArchiveResultPanel({ items, stats, onOpenArchiveRoot, onOpenLedger }) {
  if (items.length === 0) {
    return <div className="empty-state">确认归档后，这里会显示成功和失败结果。</div>;
  }

  return (
    <div className="result-panel">
      <div className="result-summary">
        <span>成功：{stats.success}</span>
        <span>失败：{stats.failed}</span>
        <button className="ghost" onClick={onOpenArchiveRoot}>打开归档文件夹</button>
        <button className="ghost" onClick={onOpenLedger}>打开照片台账</button>
      </div>
      <div className="quick-table-scroll">
        <table className="quick-table">
          <thead>
            <tr>
              <th>原文件名</th>
              <th>新文件名</th>
              <th>目标路径</th>
              <th>状态</th>
              <th>失败原因</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td className="filename" title={item.originalName}>{item.originalName}</td>
                <td className="filename" title={item.newFileName}>{item.newFileName}</td>
                <td className="path-cell" title={item.targetPath}>{item.targetPath}</td>
                <td><span className={`row-status ${item.status === '归档失败' ? 'failed' : ''}`}>{item.status || '待归档'}</span></td>
                <td>{item.error || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function getResultStats(items) {
  return {
    success: items.filter((item) => item.status === '归档成功').length,
    failed: items.filter((item) => item.status === '归档失败').length
  };
}

function getCurrentStep(archiveState) {
  if (!archiveState.photoFolder || !archiveState.archiveRoot) return 'paths';
  if (!archiveState.form.location || !archiveState.form.workItem) return 'form';
  if (archiveState.photos.length === 0) return 'scan';
  if (archiveState.previewItems.length === 0) return 'preview';
  return 'archive';
}

function fillTemplate(template, form) {
  return template
    .replaceAll('具体位置', form.location || '具体位置')
    .replaceAll('工作事项', form.workItem || '工作事项');
}
