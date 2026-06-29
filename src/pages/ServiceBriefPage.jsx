import { useEffect, useMemo, useState } from 'react';
import { PAGE_KEYS } from '../constants/app.js';
import { getUsableArchiveRoot } from '../utils/runtimeConfig.js';
import { recordRuntimeLog } from '../utils/runtimeLogger.js';

const IMAGE_TEMPLATE = {
  key: 'serviceBriefImage',
  label: '每日服务简报图',
  width: 1080,
  minHeight: 1440,
  maxHeight: 5000,
  maxItemsPerPage: 5,
  maxPhotosPerItem: 2,
  headline: '每日服务简报',
  intro: '今日物业服务事项简要汇总如下'
};

const PROJECT_INFO = [
  {
    name: '曲靖潇湘新区二期',
    phone: '0874-3296029',
    serviceCenter: '佳恒物业潇湘新区二期客服中心',
    shortName: '潇湘新区二期',
    aliases: ['曲靖潇湘新区二期', '潇湘新区二期', '潇湘', '新区二期']
  },
  {
    name: '曲靖香辰康园',
    phone: '0874-3956880',
    serviceCenter: '佳恒物业香辰康园客服中心',
    shortName: '香辰康园',
    aliases: ['曲靖香辰康园', '香辰康园', '香辰']
  }
];

const defaultFilters = {
  date: formatDateInput(new Date()),
  project: '',
  department: '',
  watermarkCategory: '',
  workContent: '',
  keyword: ''
};

export default function ServiceBriefPage({ archiveState, onNavigate }) {
  const [archiveRoot, setArchiveRoot] = useState(archiveState?.archiveRoot || '');
  const [ledgerPath, setLedgerPath] = useState('');
  const [records, setRecords] = useState([]);
  const [filters, setFilters] = useState(defaultFilters);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [selectedPhotoIds, setSelectedPhotoIds] = useState(() => new Set());
  const [showSelectedOnly, setShowSelectedOnly] = useState(false);
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const [status, setStatus] = useState({ type: 'idle', text: '正在读取归档根目录设置...' });
  const [isLoading, setIsLoading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportResult, setExportResult] = useState(null);

  useEffect(() => {
    let alive = true;
    window.archiveAssistant.loadSettings().then((settings) => {
      if (!alive) return;
      const root = archiveState?.archiveRoot || getUsableArchiveRoot(settings) || '';
      setArchiveRoot(root);
      if (!root) {
        setStatus({ type: 'warning', text: '请先到系统设置中设置归档根目录。' });
      }
    }).catch((error) => {
      recordRuntimeLog({ page: '每日服务简报', operation: '读取系统设置', errorType: '设置读取失败', summary: error.message, error });
      setStatus({ type: 'error', text: `读取系统设置失败：${error.message}` });
    });
    return () => {
      alive = false;
    };
  }, [archiveState?.archiveRoot]);

  useEffect(() => {
    if (archiveRoot) loadLedger(archiveRoot);
  }, [archiveRoot]);

  const options = useMemo(() => ({
    project: unique(records.map((record) => record.project || '未识别项目')),
    department: unique(records.map((record) => record.department)),
    watermarkCategory: unique(records.map((record) => record.watermarkCategory)),
    workContent: unique(records.map((record) => record.workContent))
  }), [records]);

  const filteredRecords = useMemo(() => {
    try {
      return records.filter((record) => matchesFilters(record, filters));
    } catch (error) {
      recordRuntimeLog({ page: '每日服务简报', operation: '筛选数据', errorType: '筛选失败', summary: error.message, error });
      setStatus({ type: 'error', text: `筛选数据失败：${error.message}` });
      return [];
    }
  }, [records, filters]);

  const serviceItems = useMemo(() => summarizeServiceItems(filteredRecords), [filteredRecords]);
  const visibleItems = showSelectedOnly ? serviceItems.filter((item) => selectedIds.has(item.id)) : serviceItems;
  const selectedItems = serviceItems.filter((item) => selectedIds.has(item.id));
  const selectedPhotoRecords = useMemo(() => selectedItems.flatMap((item) => (
    item.records.filter((record) => selectedPhotoIds.has(getPhotoId(record)) && record.fileExists && record.archivePath)
  )), [selectedItems, selectedPhotoIds]);
  const previewPages = useMemo(() => {
    try {
      return buildImagePages(selectedItems, selectedPhotoIds, filters, IMAGE_TEMPLATE, true);
    } catch (error) {
      recordRuntimeLog({ page: '每日服务简报', operation: '生成图片预览', errorType: '图片预览失败', summary: error.message, error });
      return [];
    }
  }, [selectedItems, selectedPhotoIds, filters]);
  const captionText = useMemo(() => buildCaptionText(selectedItems, filters), [selectedItems, filters]);

  function updateFilter(key, value) {
    setFilters((current) => ({ ...current, [key]: value }));
    setSelectedIds(new Set());
    setSelectedPhotoIds(new Set());
    setExpandedIds(new Set());
    setExportResult(null);
  }

  async function loadLedger(root = archiveRoot) {
    if (!root) {
      setStatus({ type: 'warning', text: '请先到系统设置中设置归档根目录。' });
      return;
    }
    setIsLoading(true);
    try {
      const result = await window.archiveAssistant.loadLedgerRecords(root);
      setLedgerPath(result.ledgerPath || '');
      setRecords(result.records || []);
      setSelectedIds(new Set());
      setSelectedPhotoIds(new Set());
      setExpandedIds(new Set());
      setExportResult(null);
      if (result.missingLedger) {
        setStatus({ type: 'warning', text: '当前归档根目录下未找到照片台账，请先完成照片归档。' });
      } else {
        setStatus({ type: 'success', text: `已读取 ${result.records.length} 条归档照片记录。` });
      }
    } catch (error) {
      recordRuntimeLog({ page: '每日服务简报', operation: '读取台账', errorType: '台账读取失败', summary: error.message, error });
      setStatus({ type: 'error', text: `读取台账失败：${error.message}` });
    } finally {
      setIsLoading(false);
    }
  }

  function toggleSelected(itemId) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) {
        next.delete(itemId);
        setSelectedPhotoIds((photoCurrent) => {
          const photoNext = new Set(photoCurrent);
          const targetItem = serviceItems.find((item) => item.id === itemId);
          targetItem?.records.forEach((record) => photoNext.delete(getPhotoId(record)));
          return photoNext;
        });
      } else {
        next.add(itemId);
      }
      return next;
    });
  }

  function selectAllVisible() {
    setSelectedIds((current) => {
      const next = new Set(current);
      visibleItems.forEach((item) => next.add(item.id));
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
    setSelectedPhotoIds(new Set());
    setShowSelectedOnly(false);
  }

  function togglePhotoSelected(record) {
    if (!record.fileExists || !record.archivePath) {
      setStatus({ type: 'warning', text: '该照片文件缺失，无法用于图片导出。' });
      return;
    }
    setSelectedPhotoIds((current) => {
      const next = new Set(current);
      const photoId = getPhotoId(record);
      if (next.has(photoId)) next.delete(photoId);
      else next.add(photoId);
      return next;
    });
  }

  function selectFirstPhotoPerItem() {
    const next = new Set();
    selectedItems.forEach((item) => {
      const first = item.records.find((record) => record.fileExists && record.archivePath);
      if (first) next.add(getPhotoId(first));
    });
    setSelectedPhotoIds(next);
    setStatus(next.size > 0
      ? { type: 'success', text: `已为 ${next.size} 个事项各选择 1 张展示照片。` }
      : { type: 'warning', text: '当前已选事项中没有可用于展示的照片。' });
  }

  function keepTwoPhotosPerItem() {
    const next = new Set();
    selectedItems.forEach((item) => {
      item.records.filter((record) => record.fileExists && record.archivePath).slice(0, 2).forEach((record) => next.add(getPhotoId(record)));
    });
    setSelectedPhotoIds(next);
    setStatus(next.size > 0
      ? { type: 'success', text: `已按每项最多 2 张照片整理，共选择 ${next.size} 张。` }
      : { type: 'warning', text: '当前已选事项中没有可用于展示的照片。' });
  }

  function clearPhotoSelection() {
    setSelectedPhotoIds(new Set());
  }

  function toggleExpanded(itemId) {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  async function copyCaption() {
    try {
      const result = await window.archiveAssistant.copyText(captionText);
      if (result?.success === false) throw new Error(result.message || '系统剪贴板写入失败');
      setStatus({ type: 'success', text: '配图文案已复制，可粘贴到业主群、朋友圈或公众号编辑器中。' });
    } catch (error) {
      recordRuntimeLog({ page: '每日服务简报', operation: '复制配图文案', errorType: '复制配图文案失败', summary: error.message, error });
      setStatus({ type: 'error', text: `复制配图文案失败：${error.message}` });
    }
  }

  async function exportImages() {
    const validation = validateExportReady(filters, selectedItems, selectedPhotoRecords);
    if (!validation.ok) {
      setStatus({ type: 'warning', text: validation.message });
      return;
    }

    const missingCount = selectedItems.flatMap((item) => item.records.filter((record) => selectedPhotoIds.has(getPhotoId(record)) && (!record.fileExists || !record.archivePath))).length;
    if (missingCount > 0) {
      setStatus({ type: 'warning', text: '部分照片文件缺失，已自动跳过。' });
    }

    setIsExporting(true);
    try {
      const pages = buildImagePages(selectedItems, selectedPhotoIds, filters, IMAGE_TEMPLATE, false);
      if (pages.length === 0) throw new Error('当前没有可导出的图片内容，请检查事项和照片选择。');
      const folderName = buildExportFolderName(selectedItems, filters);
      const result = await window.archiveAssistant.exportServiceBriefImages({
        folderName,
        pages,
        captionText
      });
      if (result?.canceled) return;
      if (!result?.success) throw new Error(result?.message || '图片导出失败');
      setExportResult(result);
      setStatus({ type: 'success', text: `图片成品导出成功：${result.packageDir}；已生成 ${result.imageCount} 张 PNG 和配图文案。` });
    } catch (error) {
      recordRuntimeLog({ page: '每日服务简报', operation: '生成发布图片', errorType: '生成发布图片失败', summary: error.message, error });
      setStatus({ type: 'error', text: `图片导出失败：${error.message}` });
    } finally {
      setIsExporting(false);
    }
  }

  async function openExportDir() {
    if (!exportResult?.packageDir) return;
    const result = await window.archiveAssistant.openPath(exportResult.packageDir);
    if (!result?.success) {
      recordRuntimeLog({ page: '每日服务简报', operation: '打开导出目录', errorType: '打开导出目录失败', summary: result?.message || '系统未能打开导出目录', technicalDetail: exportResult.packageDir });
      setStatus({ type: 'error', text: `打开导出目录失败：${result?.message || '请手动打开导出目录'}` });
    }
  }

  const noRoot = !archiveRoot;
  const currentDateRecords = records.filter((record) => normalizeRecordDate(record) === filters.date);
  const emptyText = noRoot
    ? '请先到系统设置中设置归档根目录。'
    : records.length === 0
      ? '当前归档根目录下未找到照片台账，请先完成照片归档。'
      : currentDateRecords.length === 0
        ? '当前日期暂无归档照片记录，可切换日期查看。'
        : '当前筛选条件下暂无可汇总事项。';

  return (
    <div className="service-brief-page">
      <section className="module-hero service-brief-hero compact">
        <div>
          <p className="eyebrow">每日服务简报</p>
          <h1>从归档照片生成可直接发布的图片成品</h1>
          <p>人工勾选适合公开展示的事项和照片，统一导出每日服务简报图，并附带简短配图文案。</p>
        </div>
        <div className="service-brief-actions">
          <button type="button" className="primary" onClick={() => loadLedger()} disabled={!archiveRoot || isLoading}>{isLoading ? '读取中...' : '刷新台账'}</button>
          <button type="button" onClick={() => onNavigate({ page: PAGE_KEYS.settings, action: 'settings-default-paths' })}>设置归档目录</button>
        </div>
      </section>

      <section className="service-brief-filterbar">
        <label>日期<input type="date" value={filters.date} onChange={(event) => updateFilter('date', event.target.value)} /></label>
        <label>项目<select value={filters.project} onChange={(event) => updateFilter('project', event.target.value)}><option value="">全部项目</option>{options.project.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>部门<select value={filters.department} onChange={(event) => updateFilter('department', event.target.value)}><option value="">全部部门</option>{options.department.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>水印分类<select value={filters.watermarkCategory} onChange={(event) => updateFilter('watermarkCategory', event.target.value)}><option value="">全部分类</option>{options.watermarkCategory.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>工作内容<select value={filters.workContent} onChange={(event) => updateFilter('workContent', event.target.value)}><option value="">全部工作内容</option>{options.workContent.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label className="service-brief-keyword">关键词<input type="search" value={filters.keyword} placeholder="搜索关键词、位置、事项名称" onChange={(event) => updateFilter('keyword', event.target.value)} /></label>
      </section>

      <section className="service-brief-statusbar">
        <span>台账：<strong title={ledgerPath}>{ledgerPath || '尚未加载台账'}</strong></span>
        <span>照片记录 {filteredRecords.length}</span>
        <span>服务事项 {serviceItems.length}</span>
        <span>已选事项 {selectedItems.length}</span>
        <span>已选照片 {selectedPhotoRecords.length}</span>
        <span className={status.type}>{status.text}</span>
      </section>

      <main className="service-brief-workspace image-workbench">
        <section className="service-brief-list-panel">
          <header className="service-brief-panel-head">
            <div>
              <h2>服务事项与照片选择</h2>
              <p>默认不公开任何照片，请人工勾选适合展示的事项和照片。</p>
            </div>
            <div className="service-brief-toolbar">
              <button type="button" onClick={selectAllVisible} disabled={visibleItems.length === 0}>全选事项</button>
              <button type="button" onClick={clearSelection} disabled={selectedItems.length === 0}>清空选择</button>
              <button type="button" onClick={selectFirstPhotoPerItem} disabled={selectedItems.length === 0}>每项首图</button>
              <button type="button" onClick={keepTwoPhotosPerItem} disabled={selectedItems.length === 0}>每项最多 2 张</button>
              <button type="button" onClick={clearPhotoSelection} disabled={selectedPhotoIds.size === 0}>清空照片</button>
              <button type="button" className={showSelectedOnly ? 'active' : ''} onClick={() => setShowSelectedOnly((value) => !value)}>只看已选</button>
            </div>
          </header>

          {visibleItems.length === 0 ? (
            <div className="service-brief-empty">
              <strong>{emptyText}</strong>
              {noRoot ? <button type="button" onClick={() => onNavigate({ page: PAGE_KEYS.settings, action: 'settings-default-paths' })}>去系统设置</button> : null}
            </div>
          ) : (
            <div className="service-item-list">
              {visibleItems.map((item) => {
                const selected = selectedIds.has(item.id);
                const expanded = expandedIds.has(item.id);
                const itemSelectedPhotoCount = item.records.filter((record) => selectedPhotoIds.has(getPhotoId(record))).length;
                return (
                  <article className={`service-item-card ${selected ? 'selected' : ''}`} key={item.id}>
                    <label className="service-item-main">
                      <input type="checkbox" checked={selected} onChange={() => toggleSelected(item.id)} />
                      <span className="service-item-copy">
                        <strong title={item.title}>{item.title}</strong>
                        <small title={item.subtitle}>{item.subtitle}</small>
                      </span>
                      <span className="service-item-meta">
                        <b>{item.records.length} 张</b>
                        <em>{itemSelectedPhotoCount > 0 ? `已选 ${itemSelectedPhotoCount}` : selected ? '待选照片' : '待选择'}</em>
                      </span>
                    </label>
                    <div className="service-item-tags">
                      {[item.project, item.department, item.watermarkCategory, item.workContent, item.processStatus, item.photoStage].filter(Boolean).slice(0, 6).map((tag) => <span key={tag}>{tag}</span>)}
                    </div>
                    <button type="button" className="text-button" onClick={() => toggleExpanded(item.id)}>{expanded ? '收起照片' : '展开照片'}</button>
                    {expanded ? (
                      <div className="service-item-records">
                        {item.records.map((record) => {
                          const photoId = getPhotoId(record);
                          const photoSelected = selectedPhotoIds.has(photoId);
                          return (
                            <label className={`service-photo-option ${photoSelected ? 'selected' : ''} ${!record.fileExists ? 'missing' : ''}`} key={record.id}>
                              <input type="checkbox" checked={photoSelected} disabled={!record.fileExists || !record.archivePath} onChange={() => togglePhotoSelected(record)} />
                              <span className="service-photo-thumb">
                                {record.fileExists && record.previewUrl ? <img src={record.previewUrl} alt={record.newFileName || record.originalName || '展示照片'} /> : <em>照片文件缺失</em>}
                              </span>
                              <span className="service-photo-copy">
                                <strong title={record.newFileName || record.originalName}>{record.newFileName || record.originalName || '未记录文件名'}</strong>
                                <small>{[record.photoStage, record.processStatus, sanitizePublicLocation(record.location)].filter(Boolean).join(' · ') || '未填写阶段 / 状态 / 位置'}</small>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <aside className="service-brief-preview-panel image-output-panel">
          <header className="service-brief-panel-head">
            <div>
              <h2>图片成品预览</h2>
              <p>每日服务简报图：适合业主群、朋友圈、公众号配图和内部留痕共用。</p>
            </div>
          </header>

          <div className="service-brief-template-tip">
            建议选择 3～10 个事项，每个事项 1～2 张照片；内容较多时会自动分页导出多张 PNG。
          </div>

          <div className="service-brief-image-preview">
            {selectedItems.length === 0 ? (
              <div className="brief-empty">请先勾选需要展示的服务事项。</div>
            ) : selectedPhotoRecords.length === 0 ? (
              <div className="brief-empty">请在已选事项中选择用于图片展示的照片。</div>
            ) : previewPages.length === 0 ? (
              <div className="brief-empty">当前没有可导出的图片内容，请检查事项和照片选择。</div>
            ) : (
              <div dangerouslySetInnerHTML={{ __html: previewPages[0].previewHtml }} />
            )}
          </div>

          <div className="service-caption-panel">
            <div>
              <h3>配图文案</h3>
              <p>配文只作为图片发布辅助，不再生成长篇文字日报。</p>
            </div>
            <textarea readOnly value={captionText} />
            <button type="button" onClick={copyCaption}>复制配图文案</button>
          </div>

          <div className="service-brief-safety compact">
            导出前请人工检查：不要公开业主姓名、电话、详细门牌号、完整车牌、投诉纠纷细节、内部备注和责任认定内容。照片内容是否适合公开，请人工确认后再发布。
          </div>

          <div className="service-brief-export-actions">
            <button type="button" className="primary" onClick={exportImages} disabled={isExporting || selectedItems.length === 0 || selectedPhotoRecords.length === 0}>{isExporting ? '导出中...' : '导出简报图片'}</button>
            <button type="button" onClick={openExportDir} disabled={!exportResult?.packageDir}>打开导出目录</button>
          </div>
        </aside>
      </main>
    </div>
  );
}

function matchesFilters(record, filters) {
  const recordDate = normalizeRecordDate(record);
  if (filters.date && recordDate !== filters.date) return false;
  const project = record.project || '未识别项目';
  if (filters.project && project !== filters.project) return false;
  if (filters.department && record.department !== filters.department) return false;
  if (filters.watermarkCategory && record.watermarkCategory !== filters.watermarkCategory) return false;
  if (filters.workContent && record.workContent !== filters.workContent) return false;
  const keyword = normalizeText(filters.keyword);
  if (keyword) {
    const haystack = normalizeText([record.keywords, record.location, record.itemName, record.workContent, record.watermarkCategory, record.remark, record.newFileName].join(' '));
    if (!haystack.includes(keyword)) return false;
  }
  return true;
}

function summarizeServiceItems(records) {
  const groups = new Map();
  records.forEach((record) => {
    const project = record.project || '未识别项目';
    const title = getItemTitle(record);
    const keyParts = [
      project,
      normalizeRecordDate(record),
      record.watermarkCategory || '',
      record.workContent || '',
      record.itemName || '',
      record.location || ''
    ];
    const key = keyParts.map((value) => value || '-').join('|');
    if (!groups.has(key)) {
      groups.set(key, {
        id: `item-${groups.size + 1}-${hashKey(key)}`,
        title,
        project,
        department: record.department || '',
        watermarkCategory: record.watermarkCategory || '',
        workContent: record.workContent || '',
        location: sanitizePublicLocation(record.location || ''),
        itemName: record.itemName || '',
        photoStage: record.photoStage || '',
        processStatus: record.processStatus || '',
        keywords: new Set(),
        records: []
      });
    }
    const item = groups.get(key);
    item.records.push(record);
    splitKeywords(record.keywords).forEach((keyword) => item.keywords.add(keyword));
    if (!item.department && record.department) item.department = record.department;
    if (!item.photoStage && record.photoStage) item.photoStage = record.photoStage;
    if (!item.processStatus && record.processStatus) item.processStatus = record.processStatus;
  });
  return Array.from(groups.values()).map((item) => ({
    ...item,
    keywords: Array.from(item.keywords).join('、'),
    subtitle: [item.location, item.watermarkCategory, item.workContent, item.processStatus].filter(Boolean).join(' · ') || '未分类服务事项'
  }));
}

function buildImagePages(items, selectedPhotoIds, filters, template, previewMode) {
  const grouped = groupItemsByProject(items, filters);
  const pages = [];
  grouped.forEach(([project, projectItems]) => {
    const projectInfo = resolveProjectInfo(project);
    const projectChunks = chunkArray(projectItems, template.maxItemsPerPage);
    projectChunks.forEach((chunk, pageIndex) => {
      const width = previewMode ? 390 : template.width;
      const exportHeight = getTemplateHeight(template, chunk);
      const height = previewMode ? Math.round(exportHeight * (width / template.width)) : exportHeight;
      const pageData = {
        project,
        items: chunk,
        pageIndex,
        totalPages: projectChunks.length,
        width,
        height,
        template,
        filters,
        selectedPhotoIds,
        projectInfo,
        previewMode
      };
      const html = buildImagePageHtml(pageData);
      const fileName = `每日服务简报图_${projectInfo.shortName}_${filters.date || formatDateInput(new Date())}_${String(pageIndex + 1).padStart(3, '0')}.png`;
      pages.push({
        templateKey: template.key,
        project,
        fileName,
        width: previewMode ? template.width : width,
        height: previewMode ? exportHeight : height,
        html: previewMode ? buildImagePageHtml({ ...pageData, width: template.width, height: exportHeight, previewMode: false }) : html,
        previewHtml: html
      });
    });
  });
  return pages;
}

function buildImagePageHtml({ project, projectInfo = resolveProjectInfo(project), items, pageIndex, totalPages, width, height, template, filters, selectedPhotoIds, previewMode }) {
  const dateText = filters.date || formatDateInput(new Date());
  const itemHtml = items.map((item, index) => buildImageItemHtml(item, index, selectedPhotoIds, template, previewMode)).join('');
  const pageMarkup = `<main class="brief-image-page ${template.key}">
    <header class="brief-image-cover">
      <div><h1>${escapeHtml(template.headline)}</h1><span>${escapeHtml(template.intro)}</span></div>
      <strong>${escapeHtml(projectInfo.shortName)}<br />${escapeHtml(dateText)}</strong>
    </header>
    <section class="brief-image-items">${itemHtml}</section>
    <footer class="brief-image-footer">
      <span>客服电话：${escapeHtml(projectInfo.phone)}</span>
      <span>${escapeHtml(projectInfo.serviceCenter)}</span>
      ${totalPages > 1 ? `<span>第 ${pageIndex + 1} / ${totalPages} 页</span>` : ''}
    </footer>
  </main>`;
  if (previewMode) return pageMarkup;
  return `<!doctype html><html><head><meta charset="utf-8" /><style>${buildImageCss(width, height, template, previewMode)}</style></head><body>${pageMarkup}</body></html>`;
}

function buildImageItemHtml(item, index, selectedPhotoIds, template, previewMode) {
  const photos = item.records
    .filter((record) => selectedPhotoIds.has(getPhotoId(record)) && record.fileExists && record.archivePath)
    .slice(0, template.maxPhotosPerItem);
  const photoHtml = photos.map((record) => {
    const src = previewMode ? record.previewUrl : `local-photo://image/${encodeURIComponent(record.archivePath)}`;
    return `<figure><div class="brief-publish-photo-box"><img src="${escapeHtml(src)}" alt="${escapeHtml(record.newFileName || record.originalName || item.title)}" /></div></figure>`;
  }).join('');
  return `<article class="brief-image-item">
    <div class="brief-image-item-copy">
      <em>${String(index + 1).padStart(2, '0')}</em>
      <div><h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(buildItemSentence(item))}</p></div>
    </div>
    <div class="brief-image-photo-grid photo-count-${Math.max(photos.length, 1)}">${photoHtml || '<div class="brief-image-missing">请在该事项下选择展示照片</div>'}</div>
  </article>`;
}

function buildImageCss(width, height, template, previewMode) {
  const scale = previewMode ? Math.max(0.28, width / template.width) : 1;
  const fontScale = previewMode ? 1 / scale : 1;
  return `
    *{box-sizing:border-box}html,body{margin:0;padding:0;background:#eef4fb;font-family:"Microsoft YaHei",Arial,sans-serif;color:#17375e}
    .brief-image-page{width:${width}px;height:${height}px;overflow:hidden;background:linear-gradient(180deg,#f8fbff 0%,#ffffff 45%,#f4f8fd 100%);padding:${Math.round(48 * scale)}px;display:flex;flex-direction:column;gap:${Math.round(24 * scale)}px}
    .brief-image-cover{display:flex;align-items:flex-start;justify-content:space-between;gap:${Math.round(24 * scale)}px;padding:${Math.round(30 * scale)}px;border-radius:${Math.round(28 * scale)}px;background:linear-gradient(135deg,#123a63,#1f67c7);color:#fff}
    .brief-image-cover h1{margin:0;font-size:${Math.round(52 * scale * fontScale)}px;line-height:1.12}.brief-image-cover span{display:block;margin-top:${Math.round(12 * scale)}px;font-size:${Math.round(25 * scale * fontScale)}px;opacity:.9}.brief-image-cover strong{text-align:right;font-size:${Math.round(26 * scale * fontScale)}px;line-height:1.5;white-space:nowrap}
    .brief-image-items{display:grid;gap:${Math.round(18 * scale)}px;min-height:0;overflow:hidden}.brief-image-item{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(${Math.round(340 * scale)}px,.95fr);gap:${Math.round(18 * scale)}px;padding:${Math.round(20 * scale)}px;border:1px solid #dce8f5;border-radius:${Math.round(24 * scale)}px;background:#fff;box-shadow:0 ${Math.round(10 * scale)}px ${Math.round(24 * scale)}px rgba(21,54,92,.08)}
    .brief-image-item-copy{display:flex;gap:${Math.round(14 * scale)}px;min-width:0}.brief-image-item-copy em{flex:0 0 ${Math.round(52 * scale)}px;height:${Math.round(52 * scale)}px;border-radius:${Math.round(16 * scale)}px;background:#e7f0ff;color:#1f67c7;display:flex;align-items:center;justify-content:center;font-style:normal;font-size:${Math.round(24 * scale * fontScale)}px;font-weight:800}.brief-image-item-copy h2{margin:0 0 ${Math.round(8 * scale)}px;font-size:${Math.round(34 * scale * fontScale)}px;line-height:1.2;color:#0f2e52}.brief-image-item-copy p{margin:0;color:#41556d;font-size:${Math.round(24 * scale * fontScale)}px;line-height:1.55}.brief-item-meta{margin-top:${Math.round(10 * scale)}px!important;color:#6b7c93!important;font-size:${Math.round(19 * scale * fontScale)}px!important}
    .brief-image-photo-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(${Math.round(160 * scale)}px,1fr));gap:${Math.round(12 * scale)}px;min-width:0}.brief-publish-photo-box{width:100%;height:${Math.round(230 * scale)}px;display:flex;align-items:center;justify-content:center;border-radius:${Math.round(18 * scale)}px;background:#f8fafc;border:1px solid #dce8f5;overflow:hidden}.brief-publish-photo-box img{display:block;max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain}.brief-image-missing{display:flex;align-items:center;justify-content:center;min-height:${Math.round(160 * scale)}px;border:1px dashed #f0d7a9;border-radius:${Math.round(18 * scale)}px;background:#fff8e8;color:#986017;font-size:${Math.round(22 * scale * fontScale)}px}
    .brief-image-footer{margin-top:auto;display:flex;align-items:center;justify-content:space-between;gap:${Math.round(16 * scale)}px;padding-top:${Math.round(16 * scale)}px;border-top:1px solid #dce8f5;color:#17375e;font-size:${Math.round(24 * scale * fontScale)}px}
  `;
}

function getTemplateHeight(template, items) {
  return Math.min(template.maxHeight, Math.max(template.minHeight, 520 + items.length * 330));
}

function validateExportReady(filters, selectedItems, selectedPhotoRecords) {
  if (!filters.date) return { ok: false, message: '请先选择日期。' };
  if (selectedItems.length === 0) return { ok: false, message: '请至少选择一个服务事项。' };
  if (selectedPhotoRecords.length === 0) return { ok: false, message: '请至少选择一张用于展示的照片。' };
  return { ok: true };
}

function buildCaptionText(items, filters) {
  const projectInfos = getCaptionProjectInfos(items, filters);
  const primaryInfo = projectInfos[0] || resolveProjectInfo('');
  const contactLines = projectInfos.map((info) => `${info.shortName}：${info.phone}，${info.serviceCenter}`).join('\n');
  const projectPhrase = projectInfos.length === 1 ? primaryInfo.shortName : '各项目';
  return [
    '【业主群配文】',
    '各位业主/住户：',
    `今日${projectPhrase}物业服务中心已整理服务简报图，具体服务事项请查看图片。如有需要，请联系对应物业服务中心。`,
    contactLines,
    '',
    '【朋友圈配文】',
    `服务在日常，细节见用心。今日${projectPhrase}物业服务简报已整理完成，感谢各位业主对物业服务工作的理解与支持。`,
    contactLines
  ].join('\n');
}

function buildExportFolderName(items, filters) {
  const projectInfo = resolveProjectInfo(getProjectTitle(items, filters));
  return `每日服务简报图片_${sanitizeFileName(projectInfo.shortName)}_${filters.date || formatDateInput(new Date())}`;
}

function buildItemSentence(item) {
  const title = item.workContent || item.itemName || item.watermarkCategory || item.title;
  const location = item.location ? `在${item.location}` : '';
  const status = item.processStatus;
  if (status && /完成|已处理|已归档/.test(status)) {
    return `工作人员${location}开展${title}相关服务，保障园区公共环境和日常秩序。`;
  }
  if (status) {
    return `工作人员${location}开展${title}相关服务，事项已记录并持续跟进。`;
  }
  return `工作人员${location}开展${title}相关服务，做好现场记录和后续维护。`;
}

function resolveProjectInfo(projectName) {
  const raw = String(projectName || '').trim();
  const normalized = raw.replace(/\s+/g, '');
  const matched = PROJECT_INFO.find((project) => (
    project.aliases.some((alias) => normalized.includes(String(alias).replace(/\s+/g, '')))
  ));
  if (matched) return matched;
  if (raw && raw !== '未识别项目' && !raw.includes('全部项目')) {
    recordRuntimeLog({ page: '每日服务简报', operation: '匹配项目电话落款', errorType: '项目未识别', summary: `未识别项目：${raw}`, level: 'warn' });
  }
  return {
    name: raw || '未识别项目',
    shortName: raw && raw !== '未识别项目' ? raw : '物业服务中心',
    phone: '请填写物业服务中心电话',
    serviceCenter: '物业服务中心',
    isFallback: true
  };
}

function getCaptionProjectInfos(items, filters) {
  const projects = filters.project
    ? [filters.project]
    : unique(items.map((item) => item.project).filter(Boolean));
  const targets = projects.length > 0 ? projects : [''];
  const seen = new Set();
  return targets.map(resolveProjectInfo).filter((info) => {
    const key = `${info.shortName}|${info.phone}|${info.serviceCenter}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function groupItemsByProject(items, filters) {
  const groups = new Map();
  items.forEach((item) => {
    const project = filters.project || item.project || '未识别项目';
    if (!groups.has(project)) groups.set(project, []);
    groups.get(project).push(item);
  });
  return Array.from(groups.entries());
}

function getProjectTitle(items, filters) {
  if (filters.project) return filters.project;
  const projects = unique(items.map((item) => item.project).filter(Boolean));
  if (projects.length === 1) return projects[0];
  if (projects.length > 1) return '全部项目（按项目分别生成）';
  return '未识别项目';
}

function getItemTitle(record) {
  return record.itemName || record.workContent || record.watermarkCategory || '未分类服务事项';
}

function normalizeRecordDate(record) {
  return normalizeDate(record.date || record.archivedAt);
}

function normalizeDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    const match = String(value).match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/);
    return match ? match[0].replaceAll('/', '-').split('-').map((part, index) => index === 0 ? part : part.padStart(2, '0')).join('-') : String(value);
  }
  return formatDateInput(date);
}

function formatDateInput(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatLocalDateTime(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function unique(values) {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function splitKeywords(value) {
  return String(value || '').split(/[、,，;\s]+/).map((item) => item.trim()).filter(Boolean);
}

function getPhotoId(record) {
  return String(record.id || record.archivePath || record.newFileName || record.originalName || '');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function sanitizeFileName(value) {
  return String(value || '每日服务简报')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || '每日服务简报';
}

function sanitizePublicLocation(value) {
  return String(value || '')
    .replace(/\d{1,3}栋\d{1,4}室/g, '相关楼栋')
    .replace(/\d{1,2}单元\d{1,4}室/g, '相关单元')
    .replace(/[A-Z][A-Z0-9]?[-·]?[A-Z0-9]{4,6}/gi, '相关车辆')
    .trim();
}

function hashKey(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
