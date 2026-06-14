import { useEffect, useRef, useState } from 'react';
import ArchiveForm from '../components/ArchiveForm.jsx';
import { buildRemarkTemplates, formatFileSize, getSuggestedKeywords, splitKeywords, toggleKeyword } from '../utils/formatters.js';

const TAB_KEYS = {
  photos: 'photos',
  preview: 'preview',
  result: 'result'
};

const THUMB_SIZE_CLASS = {
  small: 'thumb-small',
  medium: 'thumb-medium',
  large: 'thumb-large'
};

const PAGE_SIZE_OPTIONS = [10, 30, 50, 100];

const PREVIEW_COLUMNS = [
  { key: 'index', label: '序号', width: 56, minWidth: 48, maxWidth: 70 },
  { key: 'originalName', label: '原文件名', width: 220, minWidth: 160, maxWidth: 380, getValue: (item) => item.originalName },
  { key: 'newFileName', label: '新文件名', width: 420, minWidth: 260, maxWidth: 520, getValue: (item) => item.newFileName },
  { key: 'summary', label: '归档摘要', width: 320, minWidth: 220, maxWidth: 420, getValue: (item) => `${item.watermarkCategory} ${item.workContent} ${item.location} ${item.workItem} ${item.photoStage} ${item.processStatus}` },
  { key: 'actions', label: '操作', width: 140, minWidth: 120, maxWidth: 160 }
];

const RESULT_COLUMNS = [
  { key: 'originalName', label: '原文件名', width: 220, minWidth: 160, maxWidth: 380, getValue: (item) => item.originalName },
  { key: 'newFileName', label: '新文件名', width: 420, minWidth: 260, maxWidth: 520, getValue: (item) => item.newFileName },
  { key: 'targetPath', label: '目标路径', width: 320, minWidth: 220, maxWidth: 520, getValue: (item) => item.targetPath },
  { key: 'status', label: '状态', width: 90, minWidth: 80, maxWidth: 110, getValue: (item) => item.status },
  { key: 'error', label: '失败原因', width: 110, minWidth: 90, maxWidth: 180, getValue: (item) => item.error || '-' },
  { key: 'actions', label: '操作', width: 150, minWidth: 130, maxWidth: 170 }
];

const PHOTO_COLUMNS = [
  { key: 'index', label: '序号', width: 56, minWidth: 48, maxWidth: 70 },
  { key: 'thumb', label: '缩略图', width: 96, minWidth: 72, maxWidth: 140 },
  { key: 'name', label: '原文件名', width: 360, minWidth: 220, maxWidth: 560, getValue: (photo) => photo.name },
  { key: 'extension', label: '格式', width: 80, minWidth: 64, maxWidth: 100, getValue: (photo) => photo.extension },
  { key: 'size', label: '大小', width: 90, minWidth: 76, maxWidth: 110, getValue: (photo) => formatFileSize(photo.size) },
  { key: 'status', label: '状态', width: 96, minWidth: 84, maxWidth: 120 }
];

export default function QuickArchivePage({ archiveState }) {
  const [activeTab, setActiveTab] = useState(TAB_KEYS.photos);
  const [assistTab, setAssistTab] = useState('scene');
  const [moreActionsOpen, setMoreActionsOpen] = useState(false);
  const [photoAreaMode, setPhotoAreaMode] = useState('expanded');
  const [thumbSize, setThumbSize] = useState('medium');
  const [photoPagination, setPhotoPagination] = useState({ page: 1, pageSize: 10 });
  const [previewPagination, setPreviewPagination] = useState({ page: 1, pageSize: 10 });
  const [resultPagination, setResultPagination] = useState({ page: 1, pageSize: 10 });
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const workAreaRef = useRef(null);
  const resultItems = archiveState.previewItems.filter((item) => item.status === '归档成功' || item.status === '归档失败');
  const resultStats = getResultStats(resultItems);
  const currentStep = getCurrentStep(archiveState, resultItems);
  const hasArchiveResult = resultItems.length > 0;
  const archiveButtonLabel = getArchiveButtonLabel(archiveState.previewItems.length, resultStats, hasArchiveResult);
  const rightPanelHint = getRightPanelHint(archiveState, resultStats, hasArchiveResult);
  const confirmation = getArchiveConfirmationData(archiveState);

  useEffect(() => {
    setPhotoPagination((current) => clampPagination(current, archiveState.photos.length));
  }, [archiveState.photos.length]);

  useEffect(() => {
    setPreviewPagination((current) => clampPagination(current, archiveState.previewItems.length));
  }, [archiveState.previewItems.length]);

  useEffect(() => {
    setResultPagination((current) => clampPagination(current, resultItems.length));
  }, [resultItems.length]);

  async function scanAndShowPhotos() {
    const success = await archiveState.scanPhotos();
    if (success) {
      setPhotoPagination((current) => ({ ...current, page: 1 }));
      setPreviewPagination((current) => ({ ...current, page: 1 }));
      setResultPagination((current) => ({ ...current, page: 1 }));
      setActiveTab(TAB_KEYS.photos);
      setPhotoAreaMode('expanded');
      scrollWorkAreaIntoView();
    }
  }

  async function rescanAndShowPhotos() {
    const success = await archiveState.rescanPhotos();
    if (success) {
      setPhotoPagination((current) => ({ ...current, page: 1 }));
      setPreviewPagination((current) => ({ ...current, page: 1 }));
      setResultPagination((current) => ({ ...current, page: 1 }));
      setActiveTab(TAB_KEYS.photos);
      setPhotoAreaMode('expanded');
      scrollWorkAreaIntoView();
    }
  }

  async function buildPreviewAndShowTab() {
    const success = await archiveState.buildPreview();
    if (success) {
      setPreviewPagination((current) => ({ ...current, page: 1 }));
      setActiveTab(TAB_KEYS.preview);
      setPhotoAreaMode('expanded');
      scrollWorkAreaIntoView();
    }
  }

  async function archiveAndShowResult() {
    const success = await archiveState.archivePhotos();
    if (success) {
      setConfirmDialogOpen(false);
      setResultPagination((current) => ({ ...current, page: 1 }));
      setActiveTab(TAB_KEYS.result);
      setPhotoAreaMode('expanded');
      scrollWorkAreaIntoView();
    }
  }

  function requestArchiveConfirmation() {
    if (archiveState.previewItems.length === 0) {
      archiveState.setStatus({ type: 'error', text: '请先生成归档预览。' });
      return;
    }
    if (hasArchiveResult) return;
    setConfirmDialogOpen(true);
  }

  function collapsePhotoArea() {
    setPhotoAreaMode((value) => (value === 'collapsed' ? 'expanded' : 'collapsed'));
  }

  function scrollWorkAreaIntoView() {
    window.setTimeout(() => workAreaRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 50);
  }

  function clearPhotosAndResetPages() {
    archiveState.clearScannedPhotos();
    setPhotoPagination((current) => ({ ...current, page: 1 }));
    setPreviewPagination((current) => ({ ...current, page: 1 }));
    setResultPagination((current) => ({ ...current, page: 1 }));
  }

  return (
    <div className="quick-archive-workbench">
      <section className={`quick-final-workspace ${photoAreaMode === 'maximized' ? 'photo-maximized' : ''}`} ref={workAreaRef}>
        <section className="quick-command-bar quick-directory-bar">
          <QuickFlowSteps currentStep={currentStep} />

          <div className="quick-path-summary">
            <PathSummary label="照片文件夹" value={archiveState.photoFolder || '尚未选择'} />
            <PathSummary label="归档根目录" value={archiveState.archiveRoot || '尚未选择'} />
          </div>

          <div className="quick-main-actions">
            <button onClick={archiveState.selectPhotoFolder}>选择照片文件夹</button>
            <button className="secondary" onClick={archiveState.selectArchiveRoot}>选择归档根目录</button>
            <button className="primary" onClick={scanAndShowPhotos} disabled={archiveState.isBusy || !archiveState.photoFolder}>
              扫描照片 <span>{archiveState.photos.length}</span>
            </button>
            <button className="ghost" onClick={() => setMoreActionsOpen((value) => !value)}>{moreActionsOpen ? '收起目录操作' : '更多目录操作'}</button>
          </div>

        {moreActionsOpen && (
          <div className="quick-secondary-groups">
            <DirectoryActionGroup title="照片来源目录">
              <button className="ghost" onClick={() => archiveState.useSavedPhotoFolder(archiveState.settings?.lastPhotoFolder)} disabled={!archiveState.settings?.lastPhotoFolder}>使用上次照片文件夹</button>
              <select value="" onChange={(event) => event.target.value && archiveState.useSavedPhotoFolder(event.target.value)}>
                <option value="">最近照片文件夹</option>
                {(archiveState.settings?.recentPhotoFolders || []).map((folderPath) => <option key={folderPath} value={folderPath}>{folderPath}</option>)}
              </select>
              <button className="ghost" onClick={() => archiveState.photoFolder && window.archiveAssistant.openPath(archiveState.photoFolder)} disabled={!archiveState.photoFolder}>打开照片目录</button>
            </DirectoryActionGroup>
            <DirectoryActionGroup title="归档根目录">
              <button className="ghost" onClick={() => archiveState.useSavedArchiveRoot(archiveState.settings?.defaultArchiveRoot, '默认归档根目录')} disabled={!archiveState.settings?.defaultArchiveRoot}>使用默认归档根目录</button>
              <select value="" onChange={(event) => event.target.value && archiveState.useSavedArchiveRoot(event.target.value, '最近归档根目录')}>
                <option value="">最近归档根目录</option>
                {(archiveState.settings?.recentArchiveRoots || []).map((folderPath) => <option key={folderPath} value={folderPath}>{folderPath}</option>)}
              </select>
              <button className="ghost" onClick={archiveState.setCurrentArchiveRootAsDefault} disabled={!archiveState.archiveRoot}>设为默认归档根目录</button>
              <button className="ghost" onClick={() => archiveState.archiveRoot && window.archiveAssistant.openPath(archiveState.archiveRoot)} disabled={!archiveState.archiveRoot}>打开归档目录</button>
            </DirectoryActionGroup>
          </div>
        )}
        </section>

        <main className={`quick-left-workspace ${photoAreaMode === 'collapsed' ? 'collapsed' : ''}`}>
          <div className="quick-tabs quick-workspace-tabs">
            <button className={activeTab === TAB_KEYS.photos ? 'active' : ''} onClick={() => setActiveTab(TAB_KEYS.photos)}>照片列表 <span>{archiveState.photos.length}</span></button>
            <button className={activeTab === TAB_KEYS.preview ? 'active' : ''} onClick={() => setActiveTab(TAB_KEYS.preview)}>归档预览 <span>{archiveState.previewItems.length}</span></button>
            <button className={activeTab === TAB_KEYS.result ? 'active' : ''} onClick={() => setActiveTab(TAB_KEYS.result)}>归档结果 <span>{resultItems.length}</span></button>
            <button className="ghost quick-bottom-toggle" onClick={collapsePhotoArea}>{photoAreaMode === 'collapsed' ? '展开照片区域' : '收起照片区域'}</button>
            <button className="ghost quick-bottom-toggle" onClick={() => setPhotoAreaMode((value) => (value === 'maximized' ? 'expanded' : 'maximized'))}>
              {photoAreaMode === 'maximized' ? '恢复工作区' : '最大化照片区域'}
            </button>
          </div>

          {photoAreaMode === 'collapsed' ? (
            <div className="quick-collapsed-summary">
              <span>照片数：{archiveState.photos.length}</span>
              <span>预览数：{archiveState.previewItems.length}</span>
              <span>成功：{resultStats.success}</span>
              <span>失败：{resultStats.failed}</span>
            </div>
          ) : (
            <div className={`quick-tab-body quick-workspace-body ${archiveState.photos.length || archiveState.previewItems.length ? 'expanded' : 'compact-empty'} ${activeTab === TAB_KEYS.photos && archiveState.photos.length === 0 ? 'photo-empty' : ''}`}>
              {activeTab === TAB_KEYS.photos && (
                <PhotoList
                  photos={archiveState.photos}
                  pagination={photoPagination}
                  setPagination={setPhotoPagination}
                  thumbSize={thumbSize}
                  setThumbSize={setThumbSize}
                  onClear={clearPhotosAndResetPages}
                  onRescan={rescanAndShowPhotos}
                  onOpenPhotoFolder={() => archiveState.photoFolder && window.archiveAssistant.openPath(archiveState.photoFolder)}
                  disabled={archiveState.isBusy}
                  hasPhotoFolder={Boolean(archiveState.photoFolder)}
                />
              )}
              {activeTab === TAB_KEYS.preview && <ArchivePreviewPanel items={archiveState.previewItems} pagination={previewPagination} setPagination={setPreviewPagination} />}
              {activeTab === TAB_KEYS.result && (
                <ArchiveResultPanel
                  items={resultItems}
                  stats={resultStats}
                  pagination={resultPagination}
                  setPagination={setResultPagination}
                  onOpenArchiveRoot={archiveState.openArchiveRoot}
                  onOpenLedger={archiveState.openLedger}
                />
              )}
            </div>
          )}
        </main>

        <aside className="quick-right-operations quick-form-module">
          <ArchiveForm configs={archiveState.configs} form={archiveState.form} updateForm={archiveState.updateForm} compact />
          <div className="quick-inline-assist">
            <div className="quick-assist-header">
              <div>
                <p className="eyebrow">辅助填写</p>
                <h2>场景、关键词、备注</h2>
              </div>
            </div>
            <div className="assist-tabs">
              {[
                ['scene', '常见场景'],
                ['keyword', '关键词'],
                ['remark', '备注模板'],
                ['recent', '最近记录']
              ].map(([key, label]) => (
                <button key={key} className={assistTab === key ? 'active' : ''} onClick={() => setAssistTab(key)}>{label}</button>
              ))}
            </div>
            <div className="quick-helper-content">
              <QuickAssistContent
                activeTab={assistTab}
                archiveState={archiveState}
              />
            </div>
          </div>

          <div className="quick-operation-card quick-inline-actions">
            <button onClick={buildPreviewAndShowTab} disabled={archiveState.isBusy || !archiveState.archiveRoot || archiveState.photos.length === 0}>
              生成归档预览 <span>{archiveState.previewItems.length}</span>
            </button>
            <button className="primary" onClick={requestArchiveConfirmation} disabled={archiveState.isBusy || !archiveState.archiveRoot || archiveState.previewItems.length === 0 || hasArchiveResult}>
              {archiveButtonLabel}
            </button>
            {rightPanelHint && <div className={`operation-status ${archiveState.status.type}`}>{rightPanelHint}</div>}
          </div>
        </aside>
      </section>
      {confirmDialogOpen && (
        <ArchiveConfirmDialog
          confirmation={confirmation}
          isBusy={archiveState.isBusy}
          onCancel={() => setConfirmDialogOpen(false)}
          onConfirm={archiveAndShowResult}
        />
      )}
    </div>
  );
}

function DirectoryActionGroup({ title, children }) {
  return (
    <div className="directory-action-group">
      <h3>{title}</h3>
      <div>{children}</div>
    </div>
  );
}

function QuickFlowSteps({ currentStep }) {
  const steps = [
    ['paths', '选择目录'],
    ['scan', '扫描照片'],
    ['form', '填写信息'],
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

function useResizableColumns(storageKey, columns) {
  const defaultWidths = Object.fromEntries(columns.map((column) => [column.key, column.width]));
  const [widths, setWidths] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
      return { ...defaultWidths, ...saved };
    } catch {
      return defaultWidths;
    }
  });

  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(widths));
  }, [storageKey, widths]);

  function resizeColumn(key, nextWidth) {
    const column = columns.find((item) => item.key === key);
    const minWidth = column?.minWidth || 80;
    const maxWidth = column?.maxWidth || 720;
    setWidths((current) => ({ ...current, [key]: clampWidth(nextWidth, minWidth, maxWidth) }));
  }

  function resetColumn(key) {
    setWidths((current) => ({ ...current, [key]: defaultWidths[key] }));
  }

  function resetAll() {
    setWidths(defaultWidths);
  }

  function autoFit(rows) {
    const nextWidths = Object.fromEntries(columns.map((column) => {
      const values = rows.slice(0, 80).map((row, index) => String(column.getValue?.(row, index) || column.label || ''));
      const longest = Math.max(column.label.length, ...values.map((value) => getDisplayLength(value)));
      const estimatedWidth = longest * 8 + 34;
      return [column.key, clampWidth(estimatedWidth, column.minWidth || 80, column.maxWidth || 720)];
    }));
    setWidths(nextWidths);
  }

  return { widths, resizeColumn, resetColumn, resetAll, autoFit };
}

function clampWidth(width, minWidth, maxWidth) {
  return Math.max(minWidth, Math.min(maxWidth, Math.round(width)));
}

function getDisplayLength(value) {
  return Array.from(value).reduce((total, char) => total + (/[\u4e00-\u9fa5]/.test(char) ? 2 : 1), 0);
}

function ResizableHeader({ column, width, onResize, onReset }) {
  function startResize(event) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;

    function handleMove(moveEvent) {
      onResize(startWidth + moveEvent.clientX - startX);
    }

    function stopResize() {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', stopResize);
      document.body.classList.remove('is-resizing-column');
    }

    document.body.classList.add('is-resizing-column');
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', stopResize);
  }

  return (
    <th style={{ width }}>
      <span>{column.label}</span>
      <button
        type="button"
        className="column-resizer"
        title="拖动调整列宽，双击恢复默认"
        onMouseDown={startResize}
        onDoubleClick={(event) => {
          event.preventDefault();
          onReset();
        }}
      />
    </th>
  );
}

function ResizableColGroup({ columns, widths }) {
  return (
    <colgroup>
      {columns.map((column) => <col key={column.key} style={{ width: widths[column.key] }} />)}
    </colgroup>
  );
}

function getTableWidthStyle(tableWidth) {
  return `max(100%, ${tableWidth}px)`;
}

function paginateItems(items, pagination) {
  const total = items.length;
  const pageSize = pagination.pageSize;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, pagination.page), totalPages);
  const startIndex = total === 0 ? 0 : (page - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, total);

  return {
    page,
    pageSize,
    total,
    totalPages,
    startIndex,
    endIndex,
    pageItems: items.slice(startIndex, endIndex)
  };
}

function clampPagination(pagination, total) {
  const totalPages = Math.max(1, Math.ceil(total / pagination.pageSize));
  const nextPage = Math.min(Math.max(1, pagination.page), totalPages);
  return nextPage === pagination.page ? pagination : { ...pagination, page: nextPage };
}

function PaginationBar({ paginationInfo, setPagination, scopeLabel }) {
  const { page, pageSize, total, totalPages, startIndex, endIndex } = paginationInfo;

  return (
    <div className="pagination-bar">
      <div className="pagination-summary">
        <span>当前显示：{total === 0 ? '0' : `第 ${startIndex + 1}-${endIndex} 条`} / 共 {total} 条</span>
        <span>当前页：第 {page} / {totalPages} 页</span>
        {scopeLabel && <span>{scopeLabel}</span>}
      </div>
      <div className="pagination-actions">
        <button type="button" className="mini-button" onClick={() => setPagination((current) => ({ ...current, page: 1 }))} disabled={page <= 1}>首页</button>
        <button type="button" className="mini-button" onClick={() => setPagination((current) => ({ ...current, page: Math.max(1, page - 1) }))} disabled={page <= 1}>上一页</button>
        <button type="button" className="mini-button" onClick={() => setPagination((current) => ({ ...current, page: Math.min(totalPages, page + 1) }))} disabled={page >= totalPages}>下一页</button>
        <button type="button" className="mini-button" onClick={() => setPagination((current) => ({ ...current, page: totalPages }))} disabled={page >= totalPages}>末页</button>
        <label>
          每页
          <select
            value={pageSize}
            onChange={(event) => setPagination({ page: 1, pageSize: Number(event.target.value) })}
          >
            {PAGE_SIZE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
          条
        </label>
      </div>
    </div>
  );
}

function ArchiveConfirmDialog({ confirmation, isBusy, onCancel, onConfirm }) {
  return (
    <div className="archive-confirm-backdrop" role="presentation">
      <section className="archive-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="archive-confirm-title">
        <div className="archive-confirm-heading">
          <div>
            <p className="eyebrow">归档前确认</p>
            <h2 id="archive-confirm-title">确认执行归档？</h2>
          </div>
          <strong>{confirmation.count} 张</strong>
        </div>

        <div className="archive-confirm-section">
          <h3>本次归档信息</h3>
          <dl className="archive-confirm-grid">
            {confirmation.fields.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd title={value}>{value || '未填写'}</dd>
              </div>
            ))}
          </dl>
        </div>

        {confirmation.fallbackNotes.length > 0 && (
          <div className="archive-confirm-section warning">
            <h3>字段兜底提示</h3>
            <ul>
              {confirmation.fallbackNotes.map((note) => <li key={note}>{note}</li>)}
            </ul>
          </div>
        )}

        <div className="archive-confirm-section safe">
          <h3>安全说明</h3>
          <ul>
            <li>原始照片将保留，不移动、不删除、不压缩。</li>
            <li>分页只影响查看，本次将归档全部已生成预览记录，不只是当前页。</li>
            <li>归档成功后将追加 Excel 台账记录。</li>
          </ul>
        </div>

        <div className="archive-confirm-actions">
          <button type="button" className="ghost" onClick={onCancel} disabled={isBusy}>返回修改</button>
          <button type="button" className="primary" onClick={onConfirm} disabled={isBusy}>
            {isBusy ? '正在归档...' : '确认归档'}
          </button>
        </div>
      </section>
    </div>
  );
}

function QuickAssistContent({ activeTab, archiveState }) {
  if (!archiveState.configs) return <p className="muted">正在加载配置...</p>;

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
          <span className="muted">填写事项名称或位置/区域后会出现更多推荐关键词。</span>
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

  if (activeTab === 'recent') {
    return (
      <div className="recent-list quick-template-list">
        {archiveState.recentRecords.length === 0 ? (
          <span className="muted">完成归档后会自动保存最近使用记录。</span>
        ) : archiveState.recentRecords.map((record) => (
          <button type="button" key={record.id} className="recent-card" onClick={() => archiveState.applyRecentRecord(record)}>
            <strong>{record.project} / {record.department}</strong>
            <span>{record.watermarkCategory} / {record.workContent}</span>
            <small>{record.location || '未填写位置/区域'} - {record.workItem || '未填写事项名称'}</small>
          </button>
        ))}
        {archiveState.recentRecords.length > 0 && <button type="button" className="mini-button danger" onClick={archiveState.clearRecentRecordList}>清空最近记录</button>}
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

function PhotoList({ photos, pagination, setPagination, thumbSize, setThumbSize, onClear, onRescan, onOpenPhotoFolder, disabled, hasPhotoFolder }) {
  const { widths, resizeColumn, resetColumn, resetAll, autoFit } = useResizableColumns('archiveAssistant.photoColumnWidths', PHOTO_COLUMNS);
  const tableWidth = PHOTO_COLUMNS.reduce((total, column) => total + widths[column.key], 0);
  const paginationInfo = paginateItems(photos, pagination);

  return (
    <div className={`photo-list-panel ${photos.length === 0 ? 'empty' : ''}`}>
      <div className="photo-list-toolbar">
        <div>
          <strong>照片列表</strong>
        </div>
        <div className="photo-toolbar-actions">
          <div className="table-toolbar-group">
            <button className="ghost" onClick={onClear} disabled={disabled || photos.length === 0}>清空列表</button>
            <button className="ghost" onClick={onRescan} disabled={disabled || !hasPhotoFolder}>重新扫描</button>
            <button className="ghost" onClick={onOpenPhotoFolder} disabled={!hasPhotoFolder}>打开照片目录</button>
          </div>
          <div className="table-toolbar-group">
            <button className="ghost" onClick={() => autoFit(photos)} disabled={photos.length === 0}>自动列宽</button>
            <button className="ghost" onClick={resetAll}>恢复默认列宽</button>
          </div>
          <div className="table-toolbar-group">
            <div className="thumb-size-control" aria-label="缩略图大小">
              {[
                ['small', '小'],
                ['medium', '中'],
                ['large', '大']
              ].map(([key, label]) => (
                <button key={key} className={thumbSize === key ? 'active' : ''} onClick={() => setThumbSize(key)}>{label}</button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {photos.length === 0 ? (
        <div className="photo-list-empty-state" role="status">请选择照片文件夹并扫描照片。</div>
      ) : (
        <div className="quick-table-scroll">
          <table className={`quick-table photo-table resizable-table ${THUMB_SIZE_CLASS[thumbSize]}`} style={{ width: getTableWidthStyle(tableWidth) }}>
            <ResizableColGroup columns={PHOTO_COLUMNS} widths={widths} />
            <thead>
              <tr>
                {PHOTO_COLUMNS.map((column) => (
                  <ResizableHeader
                    key={column.key}
                    column={column}
                    width={widths[column.key]}
                    onResize={(nextWidth) => resizeColumn(column.key, nextWidth)}
                    onReset={() => resetColumn(column.key)}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {paginationInfo.pageItems.map((photo, index) => (
                <tr key={photo.id}>
                  <td>{paginationInfo.startIndex + index + 1}</td>
                  <td><img src={photo.previewUrl} alt={photo.name} /></td>
                  <td className="filename table-cell-ellipsis" title={photo.name}>{photo.name}</td>
                  <td>{photo.extension}</td>
                  <td>{formatFileSize(photo.size)}</td>
                  <td><span className="row-status">已扫描</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {photos.length > 0 && (
        <PaginationBar
          paginationInfo={paginationInfo}
          setPagination={setPagination}
          scopeLabel={`本次预览/归档范围：全部 ${photos.length} 张`}
        />
      )}
    </div>
  );
}

function ArchivePreviewPanel({ items, pagination, setPagination }) {
  const { widths, resizeColumn, resetColumn, resetAll, autoFit } = useResizableColumns('archiveAssistant.previewColumnWidths', PREVIEW_COLUMNS);
  const tableWidth = PREVIEW_COLUMNS.reduce((total, column) => total + widths[column.key], 0);
  const paginationInfo = paginateItems(items, pagination);

  if (items.length === 0) {
    return <div className="empty-state compact">生成归档预览后显示新文件名和归档摘要。</div>;
  }

  return (
    <div className="table-panel">
      <div className="table-panel-toolbar">
        <span className="table-toolbar-note">可拖动表头分隔线调整列宽</span>
        <div className="table-toolbar-group">
          <button type="button" className="mini-button" onClick={() => autoFit(items)}>自动列宽</button>
          <button type="button" className="mini-button" onClick={resetAll}>恢复默认列宽</button>
        </div>
      </div>
      <div className="quick-table-scroll">
      <table className="quick-table preview-summary-table resizable-table" style={{ width: getTableWidthStyle(tableWidth) }}>
        <ResizableColGroup columns={PREVIEW_COLUMNS} widths={widths} />
        <thead>
          <tr>
            {PREVIEW_COLUMNS.map((column) => (
              <ResizableHeader
                key={column.key}
                column={column}
                width={widths[column.key]}
                onResize={(nextWidth) => resizeColumn(column.key, nextWidth)}
                onReset={() => resetColumn(column.key)}
              />
            ))}
          </tr>
        </thead>
        <tbody>
          {paginationInfo.pageItems.map((item, index) => (
            <tr key={item.id}>
              <td>{paginationInfo.startIndex + index + 1}</td>
              <td className="filename table-cell-ellipsis" title={item.originalName}>{item.originalName}</td>
              <td className="new-filename table-cell-ellipsis" title={item.newFileName}>{item.newFileName}</td>
              <td className="archive-summary" title={item.targetPath}>
                <span>{item.watermarkCategory} / {item.workContent}</span>
                <small>{item.location || '现场'} / {item.workItem || item.workContent} / {item.photoStage} / {item.processStatus || '未填写状态'}</small>
              </td>
              <td>
                <div className="row-actions compact">
                  <button className="mini-button" onClick={() => copyText(item.newFileName)}>复制文件名</button>
                  <button className="mini-button" onClick={() => copyText(item.targetPath)}>复制路径</button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <PaginationBar
        paginationInfo={paginationInfo}
        setPagination={setPagination}
        scopeLabel={`本次预览总数：${items.length}`}
      />
    </div>
  );
}

function ArchiveResultPanel({ items, stats, pagination, setPagination, onOpenArchiveRoot, onOpenLedger }) {
  const { widths, resizeColumn, resetColumn, resetAll, autoFit } = useResizableColumns('archiveAssistant.resultColumnWidths', RESULT_COLUMNS);
  const tableWidth = RESULT_COLUMNS.reduce((total, column) => total + widths[column.key], 0);
  const paginationInfo = paginateItems(items, pagination);

  if (items.length === 0) {
    return <div className="empty-state compact">确认归档后显示成功、失败和路径操作。</div>;
  }

  return (
    <div className="result-panel">
      <div className="result-summary">
        <div className="table-toolbar-stats">
          <span>成功：{stats.success}</span>
          <span>失败：{stats.failed}</span>
        </div>
        <div className="table-toolbar-group">
          <button className="ghost" onClick={onOpenArchiveRoot}>打开归档文件夹</button>
          <button className="ghost" onClick={onOpenLedger}>打开照片台账</button>
        </div>
        <div className="table-toolbar-group">
          <button className="ghost" onClick={() => autoFit(items)}>自动列宽</button>
          <button className="ghost" onClick={resetAll}>恢复默认列宽</button>
        </div>
      </div>
      <div className="quick-table-scroll">
        <table className="quick-table result-table resizable-table" style={{ width: getTableWidthStyle(tableWidth) }}>
          <ResizableColGroup columns={RESULT_COLUMNS} widths={widths} />
          <thead>
            <tr>
              {RESULT_COLUMNS.map((column) => (
                <ResizableHeader
                  key={column.key}
                  column={column}
                  width={widths[column.key]}
                  onResize={(nextWidth) => resizeColumn(column.key, nextWidth)}
                  onReset={() => resetColumn(column.key)}
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {paginationInfo.pageItems.map((item) => (
              <tr key={item.id}>
                <td className="filename table-cell-ellipsis" title={item.originalName}>{item.originalName}</td>
                <td className="new-filename table-cell-ellipsis" title={item.newFileName}>{item.newFileName}</td>
                <td className="path-cell table-cell-ellipsis" title={item.targetPath}>{item.targetPath}</td>
                <td><span className={`row-status ${item.status === '归档失败' ? 'failed' : ''}`}>{item.status === '归档成功' ? '已归档' : '归档失败'}</span></td>
                <td className="error-cell">{item.error || '-'}</td>
                <td>
                  <div className="row-actions compact">
                    <button className="mini-button" onClick={() => openContainingFolder(item.targetPath)}>打开所在目录</button>
                    <button className="mini-button" onClick={() => copyText(item.targetPath)}>复制路径</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <PaginationBar
        paginationInfo={paginationInfo}
        setPagination={setPagination}
        scopeLabel={`本次归档结果：全部 ${items.length} 条`}
      />
    </div>
  );
}

function getResultStats(items) {
  return {
    success: items.filter((item) => item.status === '归档成功').length,
    failed: items.filter((item) => item.status === '归档失败').length
  };
}

function getArchiveButtonLabel(previewCount, resultStats, hasArchiveResult) {
  if (!hasArchiveResult) {
    return <>确认归档 <span>{previewCount}</span></>;
  }

  if (resultStats.failed > 0) {
    return <>成功 {resultStats.success} / 失败 {resultStats.failed}</>;
  }

  return <>已归档 <span>{resultStats.success}/{previewCount}</span></>;
}

function getRightPanelHint(archiveState, resultStats, hasArchiveResult) {
  if (hasArchiveResult) {
    if (resultStats.failed > 0) return `有失败项：成功 ${resultStats.success} / 失败 ${resultStats.failed}`;
    return `已归档 ${resultStats.success}/${archiveState.previewItems.length}`;
  }

  if (archiveState.previewItems.length > 0) return '预览已生成，请核对后确认';
  if (archiveState.photos.length > 0) return `已扫描 ${archiveState.photos.length} 张`;
  return '';
}

function getArchiveConfirmationData(archiveState) {
  const form = archiveState.form;
  const locationFilled = Boolean(String(form.location || '').trim());
  const workItemFilled = Boolean(String(form.workItem || '').trim());
  const finalLocation = locationFilled ? form.location : '现场';
  const finalWorkItem = workItemFilled ? form.workItem : form.workContent;

  return {
    count: archiveState.previewItems.length,
    fallbackNotes: [
      !locationFilled && '位置/区域未填写，已默认使用“现场”。',
      !workItemFilled && '事项名称未填写，已默认使用“工作内容”。'
    ].filter(Boolean),
    fields: [
      ['本次归档照片数量', `${archiveState.previewItems.length} 张`],
      ['项目', form.project],
      ['部门', form.department],
      ['照片来源', form.photoSource],
      ['水印分类', form.watermarkCategory],
      ['工作内容', form.workContent],
      ['位置/区域', finalLocation],
      ['事项名称', finalWorkItem],
      ['照片阶段', form.photoStage],
      ['处理状态', form.processStatus],
      ['关键词', form.keywords || '未填写'],
      ['备注', form.remark || '未填写'],
      ['归档根目录', archiveState.archiveRoot || '未选择'],
      ['Excel 台账', '归档成功后追加写入照片归档台账.xlsx']
    ]
  };
}

function getCurrentStep(archiveState, resultItems) {
  if (!archiveState.photoFolder || !archiveState.archiveRoot) return 'paths';
  if (archiveState.photos.length === 0) return 'scan';
  if (archiveState.previewItems.length === 0) return 'form';
  if (resultItems.length === 0) return 'preview';
  return 'archive';
}

function fillTemplate(template, form) {
  return template
    .replaceAll('具体位置', form.location || '位置/区域')
    .replaceAll('位置/区域', form.location || '位置/区域')
    .replaceAll('工作事项', form.workItem || form.workContent || '事项名称')
    .replaceAll('事项名称', form.workItem || form.workContent || '事项名称');
}

function copyText(value) {
  if (!value) return;
  navigator.clipboard?.writeText(String(value));
}

function openContainingFolder(targetPath) {
  const folderPath = String(targetPath || '').replace(/[\\/][^\\/]*$/, '');
  if (folderPath) window.archiveAssistant.openPath(folderPath);
}
