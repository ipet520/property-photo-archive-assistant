import { useEffect, useMemo, useRef, useState } from 'react';

const defaultFilters = {
  project: '',
  department: '',
  watermarkCategory: '',
  workContent: '',
  startDate: '',
  endDate: '',
  keyword: '',
  includeRectification: true
};

const pageSizeOptions = [50, 100, 200];
const detailTabs = [
  { key: 'photos', label: '照片明细' },
  { key: 'rectifications', label: '整改明细' }
];

export default function SummaryCenterPage({ archiveState, navigationRequest }) {
  const handledNavigationRef = useRef(0);
  const [archiveRoot, setArchiveRoot] = useState(archiveState?.archiveRoot || '');
  const [ledgerPath, setLedgerPath] = useState('');
  const [rectificationPath, setRectificationPath] = useState('');
  const [photoRecords, setPhotoRecords] = useState([]);
  const [rectificationItems, setRectificationItems] = useState([]);
  const [filters, setFilters] = useState(defaultFilters);
  const [activeSummary, setActiveSummary] = useState('category');
  const [activeDetailTab, setActiveDetailTab] = useState('photos');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [status, setStatus] = useState({ type: 'idle', text: '请选择归档根目录并加载资料汇总数据。' });
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    window.archiveAssistant.loadSettings?.().then((settings) => {
      const usableRoot = archiveState?.archiveRoot
        || (settings?.pathStatus?.lastArchiveRootExists ? settings.lastArchiveRoot : '')
        || (settings?.pathStatus?.defaultArchiveRootExists ? settings.defaultArchiveRoot : '')
        || settings?.lastArchiveRoot
        || settings?.defaultArchiveRoot
        || '';
      if (usableRoot) setArchiveRoot(usableRoot);
    }).catch(() => {});
  }, [archiveState?.archiveRoot]);

  useEffect(() => {
    if (!archiveRoot || navigationRequest?.action !== 'load-summary' || handledNavigationRef.current === navigationRequest.nonce) return;
    handledNavigationRef.current = navigationRequest.nonce;
    loadSummary(archiveRoot);
  }, [archiveRoot, navigationRequest?.nonce]);

  const options = useMemo(() => ({
    project: unique([
      ...photoRecords.map((record) => record.project),
      ...rectificationItems.map((item) => item.project)
    ]),
    department: unique([
      ...photoRecords.map((record) => record.department),
      ...rectificationItems.map((item) => item.responsibleDepartment)
    ]),
    watermarkCategory: unique([
      ...photoRecords.map((record) => record.watermarkCategory),
      ...rectificationItems.map((item) => item.watermarkCategory)
    ]),
    workContent: unique([
      ...photoRecords.map((record) => record.workContent),
      ...rectificationItems.map((item) => item.workContent)
    ])
  }), [photoRecords, rectificationItems]);

  const filteredPhotos = useMemo(() => {
    return photoRecords
      .filter((record) => matchesPhoto(record, filters))
      .sort((a, b) => parseTime(b.date || b.archivedAt) - parseTime(a.date || a.archivedAt));
  }, [photoRecords, filters]);

  const filteredRectifications = useMemo(() => {
    if (!filters.includeRectification) return [];
    return rectificationItems
      .filter((item) => matchesRectification(item, filters))
      .sort((a, b) => parseTime(b.updatedAt || b.createdAt) - parseTime(a.updatedAt || a.createdAt));
  }, [rectificationItems, filters]);

  const metrics = useMemo(() => buildMetrics(filteredPhotos, filteredRectifications), [filteredPhotos, filteredRectifications]);
  const categorySummary = useMemo(() => buildCategorySummary(filteredPhotos), [filteredPhotos]);
  const projectSummary = useMemo(() => buildProjectSummary(filteredPhotos, filteredRectifications), [filteredPhotos, filteredRectifications]);
  const departmentSummary = useMemo(() => buildDepartmentSummary(filteredPhotos, filteredRectifications), [filteredPhotos, filteredRectifications]);
  const rectificationSummary = useMemo(() => buildRectificationSummary(filteredRectifications), [filteredRectifications]);

  const activeDetails = activeDetailTab === 'photos' ? filteredPhotos : filteredRectifications;
  const totalPages = Math.max(1, Math.ceil(activeDetails.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageDetails = activeDetails.slice((safePage - 1) * pageSize, safePage * pageSize);

  useEffect(() => {
    setPage(1);
  }, [activeDetailTab, filters, pageSize]);

  async function chooseArchiveRoot() {
    const selected = await window.archiveAssistant.selectArchiveRoot();
    if (!selected) return;
    setArchiveRoot(selected);
    await window.archiveAssistant.updateLastArchiveRoot?.(selected);
    await loadSummary(selected);
  }

  async function loadSummary(root = archiveRoot) {
    if (!root) {
      setStatus({ type: 'error', text: '请先选择归档根目录。' });
      return;
    }
    setIsLoading(true);
    try {
      const result = await window.archiveAssistant.loadSummaryData(root);
      setLedgerPath(result.ledgerPath || '');
      setRectificationPath(result.rectificationSourcePath || '');
      setPhotoRecords(result.photoRecords || []);
      setRectificationItems(result.rectificationItems || []);
      setPage(1);
      if (result.missingLedger) {
        setStatus({ type: 'warning', text: '当前归档目录下未找到照片归档台账，请先完成归档或重新选择归档目录。' });
      } else if (result.rectificationError) {
        setStatus({ type: 'warning', text: `已加载照片台账，但整改事项读取失败：${result.rectificationError}` });
      } else {
        setStatus({ type: 'success', text: `已加载 ${result.photoRecords.length} 条照片记录、${result.rectificationItems.length} 条整改事项。` });
      }
    } catch (error) {
      setStatus({ type: 'error', text: `资料汇总数据读取失败：${error.message}` });
    } finally {
      setIsLoading(false);
    }
  }

  function updateFilter(key, value) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  function resetFilters() {
    setFilters(defaultFilters);
    setPage(1);
  }

  function applyQuickRange(type) {
    const now = new Date();
    const start = new Date(now);
    const end = new Date(now);
    if (type === 'all') {
      setFilters((current) => ({ ...current, startDate: '', endDate: '' }));
      return;
    }
    if (type === 'month') {
      start.setDate(1);
    }
    if (type === 'lastMonth') {
      start.setMonth(now.getMonth() - 1, 1);
      end.setDate(0);
    }
    if (type === 'quarter') {
      const quarterStartMonth = Math.floor(now.getMonth() / 3) * 3;
      start.setMonth(quarterStartMonth, 1);
    }
    if (type === 'year') {
      start.setMonth(0, 1);
    }
    setFilters((current) => ({
      ...current,
      startDate: formatDate(start),
      endDate: formatDate(end)
    }));
  }

  function applyRowFilter(key, value) {
    if (!value) return;
    setFilters((current) => ({ ...current, [key]: value }));
    setActiveDetailTab('photos');
  }

  async function exportWorkbook() {
    if (filteredPhotos.length === 0 && filteredRectifications.length === 0) {
      setStatus({ type: 'warning', text: '当前没有可导出的汇总数据。' });
      return;
    }
    const result = await window.archiveAssistant.exportSummaryWorkbook(buildExportPayload({
      archiveRoot,
      ledgerPath,
      rectificationPath,
      metrics,
      categorySummary,
      projectSummary,
      departmentSummary,
      rectificationSummary,
      filteredPhotos,
      filteredRectifications
    }));
    if (result?.canceled) return;
    setStatus(result?.success
      ? { type: 'success', text: `资料汇总台账已导出：${result.filePath}` }
      : { type: 'error', text: result?.message || '资料汇总台账导出失败。' });
  }

  async function copySummary() {
    const text = [
      '资料汇总摘要',
      `归档根目录：${archiveRoot || '-'}`,
      `照片记录：${metrics.photoTotal} 条`,
      `文件存在：${metrics.fileExists} 条`,
      `文件缺失：${metrics.fileMissing} 条`,
      `项目数量：${metrics.projectCount}`,
      `部门数量：${metrics.departmentCount}`,
      `分类数量：${metrics.categoryCount}`,
      `整改事项：${metrics.rectificationTotal} 条`,
      `待整改/整改中：${metrics.rectificationOpen} 条`,
      `已完成/已关闭：${metrics.rectificationClosed} 条`
    ].join('\n');
    const result = await window.archiveAssistant.copyText(text);
    setStatus(result?.success
      ? { type: 'success', text: '已复制资料汇总摘要。' }
      : { type: 'error', text: '复制资料汇总摘要失败。' });
  }

  return (
    <div className="summary-center-page">
      <section className="page-hero compact">
        <div>
          <p className="eyebrow">资料汇总</p>
          <h1>资料汇总中心</h1>
          <p>汇总照片归档台账与整改闭环事项，生成项目、部门、分类和整改维度的本地资料统计。</p>
        </div>
        <div className="summary-hero-actions">
          <button type="button" className="primary" onClick={() => loadSummary()} disabled={!archiveRoot || isLoading}>{isLoading ? '加载中...' : '加载汇总数据'}</button>
          <button type="button" onClick={exportWorkbook} disabled={filteredPhotos.length === 0 && filteredRectifications.length === 0}>导出汇总台账</button>
          <button type="button" onClick={copySummary} disabled={filteredPhotos.length === 0 && filteredRectifications.length === 0}>复制汇总摘要</button>
        </div>
      </section>

      <section className="summary-toolbar panel">
        <div className="summary-path-box">
          <span>归档根目录</span>
          <strong title={archiveRoot}>{archiveRoot || '请选择归档根目录'}</strong>
        </div>
        <button type="button" onClick={chooseArchiveRoot}>选择归档根目录</button>
        <button type="button" onClick={() => loadSummary()} disabled={!archiveRoot || isLoading}>刷新</button>
        <div className="summary-path-box secondary">
          <span>照片台账</span>
          <strong title={ledgerPath}>{ledgerPath || '尚未加载'}</strong>
        </div>
        <div className="summary-path-box secondary">
          <span>整改数据</span>
          <strong title={rectificationPath}>{rectificationPath || '未找到或尚未加载'}</strong>
        </div>
      </section>

      <section className="summary-filter-panel panel">
        <header>
          <strong>汇总条件</strong>
          <div>
            <button type="button" onClick={() => applyQuickRange('month')}>本月</button>
            <button type="button" onClick={() => applyQuickRange('lastMonth')}>上月</button>
            <button type="button" onClick={() => applyQuickRange('quarter')}>本季度</button>
            <button type="button" onClick={() => applyQuickRange('year')}>今年</button>
            <button type="button" onClick={() => applyQuickRange('all')}>全部日期</button>
            <button type="button" onClick={resetFilters}>重置</button>
          </div>
        </header>
        <div className="summary-filter-grid">
          <SelectFilter label="项目" value={filters.project} options={options.project} onChange={(value) => updateFilter('project', value)} />
          <SelectFilter label="部门" value={filters.department} options={options.department} onChange={(value) => updateFilter('department', value)} />
          <SelectFilter label="水印分类" value={filters.watermarkCategory} options={options.watermarkCategory} onChange={(value) => updateFilter('watermarkCategory', value)} />
          <SelectFilter label="工作内容" value={filters.workContent} options={options.workContent} onChange={(value) => updateFilter('workContent', value)} />
          <InputFilter label="开始日期" type="date" value={filters.startDate} onChange={(value) => updateFilter('startDate', value)} />
          <InputFilter label="结束日期" type="date" value={filters.endDate} onChange={(value) => updateFilter('endDate', value)} />
          <InputFilter label="关键词" value={filters.keyword} onChange={(value) => updateFilter('keyword', value)} />
          <label className="summary-checkbox">
            <input type="checkbox" checked={filters.includeRectification} onChange={(event) => updateFilter('includeRectification', event.target.checked)} />
            <span>纳入整改事项</span>
          </label>
        </div>
      </section>

      <section className="summary-stats">
        <StatCard label="照片记录" value={metrics.photoTotal} />
        <StatCard label="文件存在" value={metrics.fileExists} />
        <StatCard label="文件缺失" value={metrics.fileMissing} tone={metrics.fileMissing ? 'warning' : ''} />
        <StatCard label="项目数量" value={metrics.projectCount} />
        <StatCard label="部门数量" value={metrics.departmentCount} />
        <StatCard label="整改事项" value={metrics.rectificationTotal} />
      </section>

      {metrics.fileMissing > 0 && (
        <div className="summary-warning">
          当前筛选结果中有 {metrics.fileMissing} 条归档照片文件缺失，可能是照片被移动、删除或归档目录发生变化。本中心只统计和导出，不会移动、删除或修改照片。
        </div>
      )}

      <div className="summary-layout">
        <main className="summary-main panel">
          <nav className="summary-tabs">
            <button type="button" className={activeSummary === 'category' ? 'active' : ''} onClick={() => setActiveSummary('category')}>分类汇总</button>
            <button type="button" className={activeSummary === 'project' ? 'active' : ''} onClick={() => setActiveSummary('project')}>项目汇总</button>
            <button type="button" className={activeSummary === 'department' ? 'active' : ''} onClick={() => setActiveSummary('department')}>部门汇总</button>
            <button type="button" className={activeSummary === 'rectification' ? 'active' : ''} onClick={() => setActiveSummary('rectification')}>整改汇总</button>
          </nav>
          <SummaryTable
            active={activeSummary}
            categorySummary={categorySummary}
            projectSummary={projectSummary}
            departmentSummary={departmentSummary}
            rectificationSummary={rectificationSummary}
            onFilter={applyRowFilter}
          />
        </main>

        <aside className="summary-side panel">
          <h2>汇总说明</h2>
          <p>本页仅读取已有照片归档台账和整改事项运行数据，导出时生成新的汇总 Excel，不会修改原始台账、照片或整改数据。</p>
          <dl>
            <div><dt>统计范围</dt><dd>{filters.includeRectification ? '照片台账 + 整改事项' : '仅照片台账'}</dd></div>
            <div><dt>当前照片结果</dt><dd>{filteredPhotos.length} 条</dd></div>
            <div><dt>当前整改结果</dt><dd>{filteredRectifications.length} 条</dd></div>
            <div><dt>资料包用途</dt><dd>适合迎检前核对项目、部门、分类、整改闭环覆盖情况。</dd></div>
          </dl>
        </aside>
      </div>

      <section className="summary-detail-panel panel">
        <header>
          <div>
            <h2>明细核对</h2>
            <span>分页只影响查看，导出汇总时使用当前筛选后的全部结果。</span>
          </div>
          <div className="summary-detail-tabs">
            {detailTabs.map((tab) => (
              <button key={tab.key} type="button" className={activeDetailTab === tab.key ? 'active' : ''} onClick={() => setActiveDetailTab(tab.key)}>
                {tab.label}
              </button>
            ))}
          </div>
        </header>
        <DetailTable type={activeDetailTab} rows={pageDetails} />
        <footer className="summary-pagination">
          <span>第 {activeDetails.length ? (safePage - 1) * pageSize + 1 : 0}-{Math.min(safePage * pageSize, activeDetails.length)} 条 / 共 {activeDetails.length} 条</span>
          <div>
            <button type="button" disabled={safePage <= 1} onClick={() => setPage(1)}>首页</button>
            <button type="button" disabled={safePage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button>
            <strong>{safePage} / {totalPages}</strong>
            <button type="button" disabled={safePage >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>下一页</button>
            <button type="button" disabled={safePage >= totalPages} onClick={() => setPage(totalPages)}>末页</button>
            <label className="ui-page-size">每页
              <select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>
                {pageSizeOptions.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
          </div>
        </footer>
      </section>

      <div className={`summary-status ${status.type}`}>{status.text}</div>
    </div>
  );
}

function SummaryTable({ active, categorySummary, projectSummary, departmentSummary, rectificationSummary, onFilter }) {
  if (active === 'project') {
    return (
      <TableWrap emptyText="当前没有项目汇总数据。">
        {projectSummary.map((row) => (
          <tr key={row.project} onClick={() => onFilter('project', row.project)}>
            <Cell value={row.project} />
            <Cell value={row.photoCount} />
            <Cell value={row.categoryCount} />
            <Cell value={row.workContentCount} />
            <Cell value={row.rectificationCount} />
            <Cell value={row.missingCount} />
            <Cell value={row.latestDate} />
          </tr>
        ))}
      </TableWrap>
    );
  }
  if (active === 'department') {
    return (
      <TableWrap headers={['部门', '照片数', '整改数', '待整改/整改中', '已完成/关闭', '最近日期']} emptyText="当前没有部门汇总数据。">
        {departmentSummary.map((row) => (
          <tr key={row.department} onClick={() => onFilter('department', row.department)}>
            <Cell value={row.department} />
            <Cell value={row.photoCount} />
            <Cell value={row.rectificationCount} />
            <Cell value={row.openCount} />
            <Cell value={row.closedCount} />
            <Cell value={row.latestDate} />
          </tr>
        ))}
      </TableWrap>
    );
  }
  if (active === 'rectification') {
    return (
      <TableWrap headers={['整改状态', '事项数', '逾期数', '整改前照片', '整改中照片', '整改后照片']} emptyText="当前没有整改汇总数据。">
        {rectificationSummary.map((row) => (
          <tr key={row.status}>
            <Cell value={row.status} />
            <Cell value={row.count} />
            <Cell value={row.overdueCount} />
            <Cell value={row.beforeCount} />
            <Cell value={row.duringCount} />
            <Cell value={row.afterCount} />
          </tr>
        ))}
      </TableWrap>
    );
  }
  return (
    <TableWrap headers={['水印分类', '工作内容', '照片数', '文件存在', '文件缺失', '涉及项目', '最近日期']} emptyText="当前没有分类汇总数据。">
      {categorySummary.map((row) => (
        <tr key={`${row.watermarkCategory}-${row.workContent}`} onClick={() => onFilter('watermarkCategory', row.watermarkCategory)}>
          <Cell value={row.watermarkCategory} />
          <Cell value={row.workContent} />
          <Cell value={row.photoCount} />
          <Cell value={row.existsCount} />
          <Cell value={row.missingCount} />
          <Cell value={row.projectCount} />
          <Cell value={row.latestDate} />
        </tr>
      ))}
    </TableWrap>
  );
}

function TableWrap({ children, headers = ['项目', '照片数', '分类数', '工作内容数', '整改数', '文件缺失', '最近日期'], emptyText }) {
  const hasRows = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <div className="summary-table-wrap">
      <table className="summary-table">
        <thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead>
        <tbody>
          {hasRows ? children : <tr><td colSpan={headers.length} className="summary-empty-cell">{emptyText}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function DetailTable({ type, rows }) {
  const isPhotos = type === 'photos';
  const headers = isPhotos
    ? ['日期', '项目', '部门', '水印分类', '工作内容', '位置/区域', '阶段', '状态', '关键词', '新文件名', '文件状态']
    : ['创建日期', '项目', '责任部门', '分类', '工作内容', '位置', '问题标题', '整改状态', '截止日期', '照片数'];
  return (
    <div className="summary-detail-table-wrap">
      <table className="summary-table detail">
        <thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead>
        <tbody>
          {rows.map((row) => isPhotos ? (
            <tr key={row.id}>
              <Cell value={row.date} />
              <Cell value={row.project} />
              <Cell value={row.department} />
              <Cell value={row.watermarkCategory} />
              <Cell value={row.workContent} />
              <Cell value={row.location} />
              <Cell value={row.photoStage} />
              <Cell value={row.processStatus} />
              <Cell value={row.keywords} />
              <Cell value={row.newFileName} />
              <td><span className={`summary-file-status ${row.fileExists ? 'exists' : 'missing'}`}>{row.fileExists ? '文件存在' : '文件缺失'}</span></td>
            </tr>
          ) : (
            <tr key={row.id}>
              <Cell value={row.createdDate} />
              <Cell value={row.project} />
              <Cell value={row.responsibleDepartment} />
              <Cell value={row.watermarkCategory} />
              <Cell value={row.workContent} />
              <Cell value={row.location} />
              <Cell value={row.title} />
              <Cell value={row.status} />
              <Cell value={row.deadline} />
              <Cell value={row.totalPhotoCount} />
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={headers.length} className="summary-empty-cell">当前没有明细数据。</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function SelectFilter({ label, value, options, onChange }) {
  return (
    <label>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">全部</option>
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  );
}

function InputFilter({ label, value, onChange, type = 'text' }) {
  return (
    <label>
      <span>{label}</span>
      <input type={type} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function StatCard({ label, value, tone = '' }) {
  return <article className={tone}><span>{label}</span><strong>{value}</strong></article>;
}

function Cell({ value }) {
  return <td title={String(value ?? '')}>{value || '-'}</td>;
}

function matchesPhoto(record, filters) {
  if (filters.project && record.project !== filters.project) return false;
  if (filters.department && record.department !== filters.department) return false;
  if (filters.watermarkCategory && record.watermarkCategory !== filters.watermarkCategory) return false;
  if (filters.workContent && record.workContent !== filters.workContent) return false;
  if (filters.startDate && String(record.date || '') < filters.startDate) return false;
  if (filters.endDate && String(record.date || '') > filters.endDate) return false;
  if (filters.keyword && !contains([
    record.keywords,
    record.newFileName,
    record.originalName,
    record.remark,
    record.location,
    record.itemName
  ].join(' '), filters.keyword)) return false;
  return true;
}

function matchesRectification(item, filters) {
  if (filters.project && item.project !== filters.project) return false;
  if (filters.department && item.responsibleDepartment !== filters.department) return false;
  if (filters.watermarkCategory && item.watermarkCategory !== filters.watermarkCategory) return false;
  if (filters.workContent && item.workContent !== filters.workContent) return false;
  const date = item.createdDate || item.deadline || '';
  if (filters.startDate && date && date < filters.startDate) return false;
  if (filters.endDate && date && date > filters.endDate) return false;
  if (filters.keyword && !contains([
    item.keywords,
    item.title,
    item.description,
    item.requirement,
    item.remark,
    item.location,
    item.rectificationNo
  ].join(' '), filters.keyword)) return false;
  return true;
}

function buildMetrics(photos, rectifications) {
  const fileExists = photos.filter((record) => record.fileExists).length;
  const openStatuses = ['待整改', '整改中'];
  const closedStatuses = ['已完成', '已关闭'];
  return {
    photoTotal: photos.length,
    fileExists,
    fileMissing: photos.length - fileExists,
    projectCount: unique([...photos.map((record) => record.project), ...rectifications.map((item) => item.project)]).length,
    departmentCount: unique([...photos.map((record) => record.department), ...rectifications.map((item) => item.responsibleDepartment)]).length,
    categoryCount: unique([...photos.map((record) => record.watermarkCategory), ...rectifications.map((item) => item.watermarkCategory)]).length,
    workContentCount: unique([...photos.map((record) => record.workContent), ...rectifications.map((item) => item.workContent)]).length,
    rectificationTotal: rectifications.length,
    rectificationOpen: rectifications.filter((item) => openStatuses.includes(item.status)).length,
    rectificationClosed: rectifications.filter((item) => closedStatuses.includes(item.status)).length
  };
}

function buildCategorySummary(photos) {
  return Object.values(groupBy(photos, (record) => `${record.watermarkCategory || '未填写'}|${record.workContent || '未填写'}`, (items) => ({
    watermarkCategory: items[0].watermarkCategory || '未填写',
    workContent: items[0].workContent || '未填写',
    photoCount: items.length,
    existsCount: items.filter((item) => item.fileExists).length,
    missingCount: items.filter((item) => !item.fileExists).length,
    projectCount: unique(items.map((item) => item.project)).length,
    latestDate: latestDate(items.map((item) => item.date || item.archivedAt))
  }))).sort((a, b) => b.photoCount - a.photoCount);
}

function buildProjectSummary(photos, rectifications) {
  const projects = unique([...photos.map((record) => record.project), ...rectifications.map((item) => item.project)]);
  return projects.map((project) => {
    const projectPhotos = photos.filter((record) => record.project === project);
    const projectRects = rectifications.filter((item) => item.project === project);
    return {
      project: project || '未填写',
      photoCount: projectPhotos.length,
      categoryCount: unique(projectPhotos.map((record) => record.watermarkCategory)).length,
      workContentCount: unique(projectPhotos.map((record) => record.workContent)).length,
      rectificationCount: projectRects.length,
      missingCount: projectPhotos.filter((record) => !record.fileExists).length,
      latestDate: latestDate([...projectPhotos.map((record) => record.date), ...projectRects.map((item) => item.updatedAt || item.createdAt)])
    };
  }).sort((a, b) => b.photoCount - a.photoCount);
}

function buildDepartmentSummary(photos, rectifications) {
  const departments = unique([...photos.map((record) => record.department), ...rectifications.map((item) => item.responsibleDepartment)]);
  return departments.map((department) => {
    const departmentPhotos = photos.filter((record) => record.department === department);
    const departmentRects = rectifications.filter((item) => item.responsibleDepartment === department);
    return {
      department: department || '未填写',
      photoCount: departmentPhotos.length,
      rectificationCount: departmentRects.length,
      openCount: departmentRects.filter((item) => ['待整改', '整改中'].includes(item.status)).length,
      closedCount: departmentRects.filter((item) => ['已完成', '已关闭'].includes(item.status)).length,
      latestDate: latestDate([...departmentPhotos.map((record) => record.date), ...departmentRects.map((item) => item.updatedAt || item.createdAt)])
    };
  }).sort((a, b) => b.photoCount - a.photoCount);
}

function buildRectificationSummary(rectifications) {
  return Object.values(groupBy(rectifications, (item) => item.status || '未填写', (items) => ({
    status: items[0].status || '未填写',
    count: items.length,
    overdueCount: items.filter(isOverdue).length,
    beforeCount: sum(items, 'beforeCount'),
    duringCount: sum(items, 'duringCount'),
    afterCount: sum(items, 'afterCount')
  }))).sort((a, b) => b.count - a.count);
}

function buildExportPayload(data) {
  return {
    overviewRows: [
      ['项目', '内容'],
      ['归档根目录', data.archiveRoot || ''],
      ['照片台账路径', data.ledgerPath || ''],
      ['整改数据路径', data.rectificationPath || ''],
      ['照片记录数', data.metrics.photoTotal],
      ['文件存在数', data.metrics.fileExists],
      ['文件缺失数', data.metrics.fileMissing],
      ['项目数量', data.metrics.projectCount],
      ['部门数量', data.metrics.departmentCount],
      ['分类数量', data.metrics.categoryCount],
      ['工作内容数量', data.metrics.workContentCount],
      ['整改事项数', data.metrics.rectificationTotal],
      ['待整改/整改中', data.metrics.rectificationOpen],
      ['已完成/已关闭', data.metrics.rectificationClosed],
      ['导出时间', new Date().toLocaleString()]
    ],
    categorySummary: data.categorySummary.map((row) => ({
      水印分类: row.watermarkCategory,
      工作内容: row.workContent,
      照片数: row.photoCount,
      文件存在: row.existsCount,
      文件缺失: row.missingCount,
      涉及项目数: row.projectCount,
      最近日期: row.latestDate
    })),
    projectSummary: data.projectSummary.map((row) => ({
      项目: row.project,
      照片数: row.photoCount,
      分类数: row.categoryCount,
      工作内容数: row.workContentCount,
      整改数: row.rectificationCount,
      文件缺失: row.missingCount,
      最近日期: row.latestDate
    })),
    departmentSummary: data.departmentSummary.map((row) => ({
      部门: row.department,
      照片数: row.photoCount,
      整改数: row.rectificationCount,
      待整改或整改中: row.openCount,
      已完成或已关闭: row.closedCount,
      最近日期: row.latestDate
    })),
    rectificationSummary: data.rectificationSummary.map((row) => ({
      整改状态: row.status,
      事项数: row.count,
      逾期数: row.overdueCount,
      整改前照片: row.beforeCount,
      整改中照片: row.duringCount,
      整改后照片: row.afterCount
    })),
    photoDetails: data.filteredPhotos.map((record) => ({
      日期: record.date,
      项目: record.project,
      部门: record.department,
      照片来源: record.photoSource,
      水印分类: record.watermarkCategory,
      工作内容: record.workContent,
      位置区域: record.location,
      事项名称: record.itemName,
      照片阶段: record.photoStage,
      处理状态: record.processStatus,
      关键词: record.keywords,
      备注: record.remark,
      原文件名: record.originalName,
      新文件名: record.newFileName,
      归档文件路径: record.archivePath,
      文件状态: record.fileExists ? '文件存在' : '文件缺失'
    })),
    rectificationDetails: data.filteredRectifications.map((item) => ({
      整改编号: item.rectificationNo,
      创建日期: item.createdDate,
      项目: item.project,
      责任部门: item.responsibleDepartment,
      水印分类: item.watermarkCategory,
      工作内容: item.workContent,
      位置区域: item.location,
      问题标题: item.title,
      问题描述: item.description,
      整改要求: item.requirement,
      截止日期: item.deadline,
      整改状态: item.status,
      处理人: item.owner,
      关键词: item.keywords,
      备注: item.remark,
      整改前照片数: item.beforeCount,
      整改中照片数: item.duringCount,
      整改后照片数: item.afterCount,
      关闭说明: item.closeNote
    }))
  };
}

function groupBy(items, keyGetter, mapper) {
  const groups = {};
  items.forEach((item) => {
    const key = keyGetter(item);
    groups[key] = groups[key] || [];
    groups[key].push(item);
  });
  return Object.fromEntries(Object.entries(groups).map(([key, groupItems]) => [key, mapper(groupItems)]));
}

function unique(values) {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function contains(value, keyword) {
  return String(value || '').toLowerCase().includes(String(keyword || '').trim().toLowerCase());
}

function parseTime(value) {
  return Date.parse(value || '') || 0;
}

function latestDate(values) {
  const latest = values.map(parseTime).filter(Boolean).sort((a, b) => b - a)[0];
  return latest ? formatDate(new Date(latest)) : '';
}

function formatDate(date) {
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function isOverdue(item) {
  if (!item.deadline || ['已完成', '已关闭'].includes(item.status)) return false;
  const deadline = Date.parse(item.deadline);
  return Boolean(deadline && deadline < Date.now());
}

function sum(items, key) {
  return items.reduce((total, item) => total + (Number(item[key]) || 0), 0);
}
