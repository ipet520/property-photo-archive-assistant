import { useEffect, useMemo, useState } from 'react';
import { PAGE_KEYS } from '../constants/app.js';
import { getUsableArchiveRoot } from '../utils/runtimeConfig.js';
import { recordRuntimeLog } from '../utils/runtimeLogger.js';

const TEMPLATE_OPTIONS = [
  { key: 'owner', label: '业主群简洁版' },
  { key: 'public', label: '朋友圈 / 公众号短文版' },
  { key: 'internal', label: '内部留痕版' }
];

const GRAPHIC_TEMPLATE_OPTIONS = [
  { key: 'ownerGraphic', label: '业主群图文简洁版' },
  { key: 'publicGraphic', label: '朋友圈 / 公众号图文版' },
  { key: 'internalGraphic', label: '内部留痕图文版' }
];

const PROJECT_CONTACTS = {
  曲靖潇湘新区二期: {
    phone: '0874-3296029',
    sign: '佳恒物业潇湘新区二期客服中心'
  },
  曲靖香辰康园: {
    phone: '0874-3956880',
    sign: '佳恒物业香辰康园客服中心'
  }
};

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
  const [template, setTemplate] = useState('owner');
  const [graphicTemplate, setGraphicTemplate] = useState('ownerGraphic');
  const [status, setStatus] = useState({ type: 'idle', text: '正在读取归档根目录设置...' });
  const [isLoading, setIsLoading] = useState(false);
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
  const selectedPhotoRecords = useMemo(() => selectedItems.flatMap((item) => item.records.filter((record) => selectedPhotoIds.has(getPhotoId(record)) && record.fileExists && record.archivePath)), [selectedItems, selectedPhotoIds]);
  const briefText = useMemo(() => {
    try {
      return buildBriefText(selectedItems, filters, template);
    } catch (error) {
      recordRuntimeLog({ page: '每日服务简报', operation: '生成简报', errorType: '简报生成失败', summary: error.message, error });
      return '简报生成失败，请检查已选择事项。';
    }
  }, [selectedItems, filters, template]);
  const graphicHtml = useMemo(() => {
    try {
      return buildGraphicBriefHtml(selectedItems, selectedPhotoIds, filters, graphicTemplate, false);
    } catch (error) {
      recordRuntimeLog({ page: '每日服务简报', operation: '生成图文预览', errorType: '图文预览失败', summary: error.message, error });
      return '<div class="brief-empty">图文预览生成失败，请检查已选择事项和照片。</div>';
    }
  }, [selectedItems, selectedPhotoIds, filters, graphicTemplate]);

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
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
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
      setStatus({ type: 'warning', text: '该照片文件缺失，无法用于图文简报导出。' });
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

  async function copyBrief() {
    if (selectedItems.length === 0) {
      setStatus({ type: 'warning', text: '请先勾选需要展示的服务事项。' });
      return;
    }
    try {
      const result = await window.archiveAssistant.copyText(briefText);
      if (result?.success === false) throw new Error(result.message || '系统剪贴板写入失败');
      setStatus({ type: 'success', text: '简报文本已复制，可粘贴到业主群或公众号编辑器中。' });
    } catch (error) {
      recordRuntimeLog({ page: '每日服务简报', operation: '复制简报', errorType: '复制失败', summary: error.message, error });
      setStatus({ type: 'error', text: `复制简报失败：${error.message}` });
    }
  }

  async function exportGraphicBrief() {
    if (!filters.date) {
      setStatus({ type: 'warning', text: '请先选择日期。' });
      return;
    }
    if (selectedItems.length === 0) {
      setStatus({ type: 'warning', text: '请先勾选需要展示的服务事项。' });
      return;
    }
    if (selectedPhotoRecords.length === 0) {
      setStatus({ type: 'warning', text: '请至少选择一张用于展示的照片。' });
      return;
    }
    const missingCount = selectedItems.flatMap((item) => item.records.filter((record) => selectedPhotoIds.has(getPhotoId(record)) && (!record.fileExists || !record.archivePath))).length;
    if (missingCount > 0) {
      setStatus({ type: 'warning', text: '部分照片文件缺失，已自动跳过；请检查后再导出。' });
    }
    try {
      const html = buildGraphicBriefHtml(selectedItems, selectedPhotoIds, filters, graphicTemplate, true);
      const folderName = `每日服务简报_${sanitizeFileName(getProjectTitle(selectedItems, filters))}_${filters.date}`;
      const images = selectedPhotoRecords.map((record) => ({
        id: getPhotoId(record),
        sourcePath: record.archivePath,
        fileName: record.newFileName || record.originalName || ''
      }));
      const result = await window.archiveAssistant.exportServiceBriefPackage({ folderName, html, images });
      if (result?.canceled) return;
      if (!result?.success) throw new Error(result?.message || '导出图文简报失败');
      setExportResult(result);
      setStatus({
        type: result.skippedCount > 0 ? 'warning' : 'success',
        text: `图文简报导出成功：${result.packageDir}${result.skippedCount > 0 ? `；已跳过 ${result.skippedCount} 张缺失照片。` : ''}`
      });
    } catch (error) {
      recordRuntimeLog({ page: '每日服务简报', operation: '导出图文简报', errorType: '图文资料包导出失败', summary: error.message, error });
      setStatus({ type: 'error', text: `导出图文简报失败：${error.message}` });
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
      <section className="module-hero service-brief-hero">
        <div>
          <p className="eyebrow">每日服务简报</p>
          <h1>从归档照片生成业主版服务简报</h1>
          <p>按日期和项目读取已归档照片记录，人工勾选适合公开展示的服务事项和照片，生成可复制文字与 HTML 图文资料包。</p>
        </div>
        <div className="service-brief-actions">
          <button type="button" className="primary" onClick={() => loadLedger()} disabled={!archiveRoot || isLoading}>{isLoading ? '读取中...' : '刷新台账'}</button>
          <button type="button" onClick={() => onNavigate({ page: PAGE_KEYS.settings, action: 'settings-default-paths' })}>去系统设置</button>
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
        <span>已选 {selectedItems.length}</span>
        <span className={status.type}>{status.text}</span>
      </section>

      <main className="service-brief-workspace">
        <section className="service-brief-list-panel">
          <header className="service-brief-panel-head">
            <div>
              <h2>当天事项汇总</h2>
              <p>事项默认不公开，需人工勾选后进入简报。</p>
            </div>
            <div className="service-brief-toolbar">
              <button type="button" onClick={selectAllVisible} disabled={visibleItems.length === 0}>全选当前筛选结果</button>
              <button type="button" onClick={clearSelection} disabled={selectedItems.length === 0}>清空选择</button>
              <button type="button" onClick={selectFirstPhotoPerItem} disabled={selectedItems.length === 0}>每项选首图</button>
              <button type="button" onClick={clearPhotoSelection} disabled={selectedPhotoIds.size === 0}>清空照片</button>
              <button type="button" className={showSelectedOnly ? 'active' : ''} onClick={() => setShowSelectedOnly((value) => !value)}>只显示已选</button>
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
                        <em>{selected ? '已选择' : '待选择'}</em>
                      </span>
                    </label>
                    <div className="service-item-tags">
                      {[item.project, item.department, item.watermarkCategory, item.workContent, item.processStatus, item.photoStage].filter(Boolean).slice(0, 6).map((tag) => <span key={tag}>{tag}</span>)}
                    </div>
                    <button type="button" className="text-button" onClick={() => toggleExpanded(item.id)}>{expanded ? '收起照片记录' : '展开照片记录'}</button>
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

        <aside className="service-brief-preview-panel">
          <header className="service-brief-panel-head">
            <div>
              <h2>简报生成区</h2>
              <p>当前模板：{TEMPLATE_OPTIONS.find((item) => item.key === template)?.label}</p>
            </div>
          </header>
          <div className="service-brief-template-tabs">
            {TEMPLATE_OPTIONS.map((item) => <button type="button" className={template === item.key ? 'active' : ''} key={item.key} onClick={() => setTemplate(item.key)}>{item.label}</button>)}
          </div>
          <div className="service-brief-template-tabs graphic">
            {GRAPHIC_TEMPLATE_OPTIONS.map((item) => <button type="button" className={graphicTemplate === item.key ? 'active' : ''} key={item.key} onClick={() => setGraphicTemplate(item.key)}>{item.label}</button>)}
          </div>
          <div className="service-brief-safety">
            发布前请人工检查：不要公开业主姓名、电话、详细门牌号、完整车牌、投诉纠纷细节、内部备注和责任认定内容。
          </div>
          <textarea className="service-brief-preview" readOnly value={selectedItems.length === 0 ? '请先勾选需要展示的服务事项。' : briefText} />
          <div className="service-brief-graphic-preview" dangerouslySetInnerHTML={{ __html: selectedItems.length === 0 ? '<div class="brief-empty">请先勾选需要展示的服务事项。</div>' : selectedPhotoRecords.length === 0 ? '<div class="brief-empty">请在已选事项中选择用于图文简报展示的照片。</div>' : graphicHtml }} />
          <div className="service-brief-export-actions">
            <button type="button" className="primary" onClick={copyBrief} disabled={selectedItems.length === 0}>复制简报</button>
            <button type="button" className="primary" onClick={exportGraphicBrief} disabled={selectedItems.length === 0 || selectedPhotoRecords.length === 0}>导出图文简报</button>
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

function buildBriefText(items, filters, template) {
  if (items.length === 0) return '请先勾选需要展示的服务事项。';
  if (template === 'internal') return buildInternalBrief(items, filters);
  if (template === 'public') return buildPublicBrief(items, filters);
  return buildOwnerBrief(items, filters);
}

function buildGraphicBriefHtml(items, selectedPhotoIds, filters, template, exportMode) {
  if (items.length === 0) return '<div class="brief-empty">请先勾选需要展示的服务事项。</div>';
  const title = template === 'internalGraphic' ? '每日服务简报 - 内部留痕版' : '每日服务简报';
  const intro = template === 'publicGraphic'
    ? '我们从今日物业服务记录中整理了部分服务事项，供各位业主了解。'
    : template === 'internalGraphic'
      ? '以下内容来源于已归档照片台账，供内部留痕和复核使用。'
      : '今日物业服务事项简要汇总如下。';
  const grouped = groupItemsByProject(items, filters);
  const body = grouped.map(([project, projectItems]) => {
    const contact = getContactByProject(project);
    const itemBlocks = projectItems.map((item, index) => {
      const selectedPhotos = item.records.filter((record) => selectedPhotoIds.has(getPhotoId(record)) && record.fileExists && record.archivePath);
      const photoGrid = selectedPhotos.length > 0
        ? `<div class="brief-photo-grid">${selectedPhotos.map((record) => {
            const photoId = getPhotoId(record);
            const src = exportMode ? `__IMAGE_${photoId}__` : record.previewUrl;
            return `<figure><div class="brief-image-box"><img src="${escapeHtml(src)}" alt="${escapeHtml(record.newFileName || record.originalName || item.title)}" /></div><figcaption>${escapeHtml(record.photoStage || record.processStatus || record.newFileName || '')}</figcaption></figure>`;
          }).join('')}</div>`
        : '<p class="brief-photo-empty">请在该事项下选择展示照片。</p>';
      const internalMeta = template === 'internalGraphic'
        ? `<p class="brief-meta">部门：${escapeHtml(item.department || '未填写')}｜分类：${escapeHtml(item.watermarkCategory || '未分类')}｜工作内容：${escapeHtml(item.workContent || '未填写')}｜照片数量：${item.records.length}</p>`
        : '';
      return `<section class="brief-item"><h3>${toChineseNumber(index + 1)}、${escapeHtml(item.title)}</h3>${internalMeta}<p>${escapeHtml(buildItemSentence(item))}</p>${photoGrid}</section>`;
    }).join('');
    return `<section class="brief-project"><h2>${escapeHtml(project)}</h2><p class="brief-date">日期：${escapeHtml(filters.date || formatDateInput(new Date()))}</p>${itemBlocks}<footer><p>感谢各位业主对物业服务工作的理解与支持。</p><p>客服电话：${escapeHtml(contact.phone)}</p><p>${escapeHtml(contact.sign)}</p></footer></section>`;
  }).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body{margin:0;background:#f3f6fb;color:#17375e;font-family:"Microsoft YaHei",Arial,sans-serif;line-height:1.7}
    .brief-page{max-width:920px;margin:0 auto;padding:28px 22px 36px}
    .brief-cover,.brief-project,.brief-safety{background:#fff;border:1px solid #dce8f5;border-radius:18px;padding:22px;margin-bottom:18px;box-shadow:0 10px 24px rgba(21,54,92,.06)}
    h1{margin:0 0 8px;font-size:30px;color:#0f2e52}.brief-cover p{margin:0;color:#5f7188}
    .brief-project h2{margin:0;color:#1f67c7;font-size:22px}.brief-date,.brief-meta{color:#6b7c93;font-size:14px}
    .brief-item{border-top:1px solid #e7eef7;padding-top:16px;margin-top:16px}.brief-item h3{margin:0 0 8px;font-size:18px;color:#17375e}.brief-item p{margin:0 0 12px}
    .brief-photo-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.brief-photo-grid figure{margin:0;border:1px solid #dce8f5;border-radius:14px;overflow:hidden;background:#f8fbff}.brief-image-box{min-height:160px;display:flex;align-items:center;justify-content:center;background:#f8fafc}.brief-photo-grid img{display:block;max-width:100%;max-height:320px;width:auto;height:auto;object-fit:contain}.brief-photo-grid figcaption{padding:7px 9px;color:#6b7c93;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    footer{margin-top:18px;color:#17375e}.brief-safety{color:#8a5a12;background:#fff8e8;border-color:#f0d7a9}.brief-photo-empty,.brief-empty{color:#8a5a12;background:#fff8e8;border:1px dashed #f0d7a9;border-radius:12px;padding:12px}
    @media print{body{background:#fff}.brief-page{max-width:none;padding:0}.brief-cover,.brief-project,.brief-safety{box-shadow:none;break-inside:avoid}}
  </style>
</head>
<body>
  <main class="brief-page">
    <section class="brief-cover"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(intro)}</p></section>
    ${body}
    <section class="brief-safety">导出前请人工检查：不要公开业主姓名、电话、详细门牌号、完整车牌、投诉纠纷细节、内部备注和责任认定内容。</section>
  </main>
</body>
</html>`;
}

function buildOwnerBrief(items, filters) {
  const projectTitle = getProjectTitle(items, filters);
  const contact = getBriefContact(items, filters);
  return [
    '【每日服务简报】',
    `项目：${projectTitle}`,
    `日期：${filters.date || formatDateInput(new Date())}`,
    '',
    '今日物业服务事项：',
    ...items.map((item, index) => `${index + 1}. ${item.title}\n   ${buildItemSentence(item)}`),
    '',
    '感谢各位业主对物业服务工作的理解与支持。如有需要，请联系物业服务中心。',
    `客服电话：${contact.phone}`,
    `落款：${contact.sign}`
  ].join('\n');
}

function buildPublicBrief(items, filters) {
  const projectTitle = getProjectTitle(items, filters);
  const contact = getBriefContact(items, filters);
  return [
    '【每日服务简报】',
    `${filters.date || formatDateInput(new Date())}，${projectTitle}物业服务工作有序开展。我们从今日已归档照片记录中整理了以下服务事项，供各位业主了解。`,
    '',
    ...items.map((item, index) => `${index + 1}. ${item.title}\n   ${buildItemSentence(item)}`),
    '',
    '我们将持续做好公共区域维护与服务跟进，感谢各位业主的理解与支持。',
    `客服电话：${contact.phone}`,
    `${contact.sign}`
  ].join('\n');
}

function buildInternalBrief(items, filters) {
  return [
    '【每日服务简报 - 内部留痕版】',
    `日期：${filters.date || formatDateInput(new Date())}`,
    `项目：${getProjectTitle(items, filters)}`,
    `选入事项：${items.length} 项`,
    `涉及照片：${items.reduce((sum, item) => sum + item.records.length, 0)} 张`,
    '',
    ...items.map((item, index) => [
      `${index + 1}. ${item.title}`,
      `   项目：${item.project || '未识别项目'}；部门：${item.department || '未填写'}；分类：${item.watermarkCategory || '未分类'}；工作内容：${item.workContent || '未填写'}；位置：${item.location || '未填写'}；阶段：${item.photoStage || '未填写'}；状态：${item.processStatus || '未填写'}；照片：${item.records.length} 张。`,
      `   说明：${buildItemSentence(item)}`
    ].join('\n')),
    '',
    '公开发布前仍需人工复核敏感信息。'
  ].join('\n');
}

function buildItemSentence(item) {
  const title = item.workContent || item.itemName || item.watermarkCategory || item.title;
  const location = item.location ? `在${item.location}` : '';
  const status = item.processStatus;
  if (status && /完成|已处理|已归档/.test(status)) {
    return `工作人员${location}开展${title}相关服务，事项已记录并完成处理。`;
  }
  if (status) {
    return `工作人员${location}开展${title}相关服务，当前状态为${status}，后续将持续跟进。`;
  }
  return `工作人员${location}开展${title}相关服务，事项已记录并跟进处理。`;
}

function getBriefContact(items, filters) {
  const projects = unique(items.map((item) => item.project).filter(Boolean));
  const targetProject = filters.project || (projects.length === 1 ? projects[0] : '');
  if (targetProject && PROJECT_CONTACTS[targetProject]) return PROJECT_CONTACTS[targetProject];
  if (targetProject && !PROJECT_CONTACTS[targetProject]) {
    recordRuntimeLog({ page: '每日服务简报', operation: '匹配项目电话落款', errorType: '项目未识别', summary: `未识别项目：${targetProject}`, level: 'warn' });
  }
  return { phone: '请填写物业服务中心电话', sign: '物业服务中心' };
}

function getContactByProject(project) {
  if (project && PROJECT_CONTACTS[project]) return PROJECT_CONTACTS[project];
  if (project && project !== '未识别项目') {
    recordRuntimeLog({ page: '每日服务简报', operation: '匹配项目电话落款', errorType: '项目未识别', summary: `未识别项目：${project}`, level: 'warn' });
  }
  return { phone: '请填写物业服务中心电话', sign: '物业服务中心' };
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
  return '全部项目（请发布前按项目拆分核对）';
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

function toChineseNumber(value) {
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  if (value <= 10) return digits[value];
  if (value < 20) return `十${digits[value - 10]}`;
  const tens = Math.floor(value / 10);
  const ones = value % 10;
  return `${digits[tens]}十${ones ? digits[ones] : ''}`;
}

function sanitizeFileName(value) {
  return String(value || '全部项目')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || '全部项目';
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
