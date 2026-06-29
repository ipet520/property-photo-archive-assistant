import { useEffect, useMemo, useState } from 'react';
import { PAGE_KEYS } from '../constants/app.js';
import { getUsableArchiveRoot } from '../utils/runtimeConfig.js';
import { recordRuntimeLog } from '../utils/runtimeLogger.js';

const TEMPLATE_OPTIONS = [
  { key: 'owner', label: '业主群简洁版' },
  { key: 'public', label: '朋友圈 / 公众号短文版' },
  { key: 'internal', label: '内部留痕版' }
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
  const [showSelectedOnly, setShowSelectedOnly] = useState(false);
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const [template, setTemplate] = useState('owner');
  const [status, setStatus] = useState({ type: 'idle', text: '正在读取归档根目录设置...' });
  const [isLoading, setIsLoading] = useState(false);

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
  const briefText = useMemo(() => {
    try {
      return buildBriefText(selectedItems, filters, template);
    } catch (error) {
      recordRuntimeLog({ page: '每日服务简报', operation: '生成简报', errorType: '简报生成失败', summary: error.message, error });
      return '简报生成失败，请检查已选择事项。';
    }
  }, [selectedItems, filters, template]);

  function updateFilter(key, value) {
    setFilters((current) => ({ ...current, [key]: value }));
    setSelectedIds(new Set());
    setExpandedIds(new Set());
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
      setExpandedIds(new Set());
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
    setShowSelectedOnly(false);
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
          <p>按日期和项目读取已归档照片记录，人工勾选适合公开展示的服务事项，生成可复制的文字简报。</p>
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
                        {item.records.map((record) => <p key={record.id}><span>{record.newFileName || record.originalName || '未记录文件名'}</span><small>{record.keywords || record.remark || '无关键词 / 备注'}</small></p>)}
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
          <div className="service-brief-safety">
            发布前请人工检查：不要公开业主姓名、电话、详细门牌号、完整车牌、投诉纠纷细节、内部备注和责任认定内容。
          </div>
          <textarea className="service-brief-preview" readOnly value={selectedItems.length === 0 ? '请先勾选需要展示的服务事项。' : briefText} />
          <button type="button" className="primary service-brief-copy" onClick={copyBrief} disabled={selectedItems.length === 0}>复制简报</button>
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
