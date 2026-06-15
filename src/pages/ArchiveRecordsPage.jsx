import { useEffect, useMemo, useState } from 'react';

const defaultFilters = {
  project: '',
  department: '',
  photoSource: '',
  watermarkCategory: '',
  workContent: '',
  photoStage: '',
  processStatus: '',
  startDate: '',
  endDate: '',
  keyword: '',
  location: '',
  fileName: '',
  remark: ''
};

const pageSizeOptions = [50, 100, 200];

export default function ArchiveRecordsPage({ archiveState }) {
  const [archiveRoot, setArchiveRoot] = useState(archiveState?.archiveRoot || '');
  const [ledgerPath, setLedgerPath] = useState('');
  const [records, setRecords] = useState([]);
  const [filters, setFilters] = useState(defaultFilters);
  const [selectedId, setSelectedId] = useState('');
  const [status, setStatus] = useState({ type: 'idle', text: '请选择归档根目录并加载照片归档台账。' });
  const [isLoading, setIsLoading] = useState(false);
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [sortDirection, setSortDirection] = useState('desc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  useEffect(() => {
    window.archiveAssistant.loadSettings().then((settings) => {
      const root = archiveState?.archiveRoot || settings.lastArchiveRoot || settings.defaultArchiveRoot || '';
      if (root) setArchiveRoot(root);
    }).catch(() => {});
  }, [archiveState?.archiveRoot]);

  const options = useMemo(() => ({
    project: unique(records.map((record) => record.project)),
    department: unique(records.map((record) => record.department)),
    photoSource: unique(records.map((record) => record.photoSource)),
    watermarkCategory: unique(records.map((record) => record.watermarkCategory)),
    workContent: unique(records.map((record) => record.workContent)),
    photoStage: unique(records.map((record) => record.photoStage)),
    processStatus: unique(records.map((record) => record.processStatus))
  }), [records]);

  const filteredRecords = useMemo(() => {
    const result = records.filter((record) => matchesFilters(record, filters));
    return result.sort((a, b) => {
      const left = Date.parse(a.date || a.archivedAt || '') || 0;
      const right = Date.parse(b.date || b.archivedAt || '') || 0;
      return sortDirection === 'desc' ? right - left : left - right;
    });
  }, [records, filters, sortDirection]);

  const totalPages = Math.max(1, Math.ceil(filteredRecords.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRecords = filteredRecords.slice((safePage - 1) * pageSize, safePage * pageSize);
  const selectedRecord = filteredRecords.find((record) => record.id === selectedId) || null;
  const existsCount = filteredRecords.filter((record) => record.fileExists).length;
  const missingCount = filteredRecords.length - existsCount;

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  async function chooseArchiveRoot() {
    const selected = await window.archiveAssistant.selectArchiveRoot();
    if (!selected) return;
    setArchiveRoot(selected);
    await window.archiveAssistant.updateLastArchiveRoot(selected);
    await loadLedger(selected);
  }

  async function loadLedger(root = archiveRoot) {
    if (!root) {
      setStatus({ type: 'error', text: '请先选择归档根目录。' });
      return;
    }
    setIsLoading(true);
    try {
      const result = await window.archiveAssistant.loadLedgerRecords(root);
      setLedgerPath(result.ledgerPath || '');
      setRecords(result.records || []);
      setSelectedId('');
      setPage(1);
      if (result.missingLedger) {
        setStatus({ type: 'warning', text: '当前归档目录下未找到照片归档台账，请先完成归档或重新选择归档目录。' });
      } else {
        setStatus({ type: 'success', text: `已加载 ${result.records.length} 条归档记录。` });
      }
    } catch (error) {
      setStatus({ type: 'error', text: `台账读取失败：${error.message}` });
    } finally {
      setIsLoading(false);
    }
  }

  function updateFilter(key, value) {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(1);
  }

  async function openPhoto(record) {
    if (!record?.fileExists) return;
    const result = await window.archiveAssistant.openPath(record.archivePath);
    if (!result?.success) setStatus({ type: 'error', text: `打开照片失败：${result?.message || '未知错误'}` });
  }

  async function showInFolder(record) {
    if (!record?.fileExists) return;
    const result = await window.archiveAssistant.showItemInFolder(record.archivePath);
    if (!result?.success) setStatus({ type: 'error', text: `打开所在文件夹失败：${result?.message || '未知错误'}` });
  }

  async function copyPath(record) {
    if (!record?.archivePath) return;
    const result = await window.archiveAssistant.copyText(record.archivePath);
    setStatus(result?.success
      ? { type: 'success', text: '已复制归档文件路径。' }
      : { type: 'error', text: '复制文件路径失败。' });
  }

  async function copySummary(record) {
    if (!record) return;
    const summary = [
      `日期：${record.date || '-'}`,
      `项目：${record.project || '-'}`,
      `水印分类：${record.watermarkCategory || '-'}`,
      `工作内容：${record.workContent || '-'}`,
      `位置/区域：${record.location || '-'}`,
      `照片阶段：${record.photoStage || '-'}`,
      `处理状态：${record.processStatus || '-'}`,
      `关键词：${record.keywords || '-'}`,
      `新文件名：${record.newFileName || '-'}`,
      `文件路径：${record.archivePath || '-'}`
    ].join('\n');
    const result = await window.archiveAssistant.copyText(summary);
    setStatus(result?.success
      ? { type: 'success', text: '已复制记录摘要。' }
      : { type: 'error', text: '复制记录摘要失败。' });
  }

  async function exportResults() {
    if (filteredRecords.length === 0) {
      setStatus({ type: 'error', text: '当前没有可导出的记录。' });
      return;
    }
    const result = await window.archiveAssistant.exportLedgerRecords(filteredRecords);
    if (result?.canceled) return;
    setStatus(result?.success
      ? { type: 'success', text: `导出成功：${result.filePath}` }
      : { type: 'error', text: `导出失败：${result?.message || '未知错误'}` });
  }

  return (
    <div className="archive-records-page">
      <section className="archive-query-toolbar panel">
        <div className="archive-root-box">
          <span>归档根目录</span>
          <strong title={archiveRoot}>{archiveRoot || '请选择归档根目录'}</strong>
        </div>
        <button type="button" className="primary" onClick={chooseArchiveRoot}>选择归档根目录</button>
        <button type="button" onClick={() => loadLedger()} disabled={!archiveRoot || isLoading}>{isLoading ? '加载中...' : '加载台账'}</button>
        <button type="button" onClick={() => loadLedger()} disabled={!archiveRoot || isLoading}>刷新</button>
        <button type="button" onClick={exportResults} disabled={filteredRecords.length === 0}>导出结果</button>
        <span className="archive-ledger-path" title={ledgerPath}>{ledgerPath || '尚未加载台账'}</span>
      </section>

      <section className="archive-query-summary">
        <StatCard label="台账总记录" value={records.length} />
        <StatCard label="筛选结果" value={filteredRecords.length} />
        <StatCard label="文件存在" value={existsCount} />
        <StatCard label="文件缺失" value={missingCount} tone={missingCount ? 'warning' : ''} />
      </section>
      {missingCount > 0 && (
        <div className="archive-missing-banner">
          当前筛选结果中有 {missingCount} 条文件缺失，可能是照片被移动、删除或归档目录发生变化。
        </div>
      )}

      <div className="archive-query-layout">
        <main className="archive-query-main panel">
          <section className="archive-filters">
            <header className="archive-filter-heading">
              <strong>常用筛选</strong>
              <div>
                <button type="button" onClick={() => setShowMoreFilters((value) => !value)}>{showMoreFilters ? '收起更多筛选' : '展开更多筛选'}</button>
                <button type="button" onClick={() => { setFilters(defaultFilters); setPage(1); }}>重置筛选</button>
              </div>
            </header>
            <div className="archive-filter-grid common">
              <FilterSelect label="项目" value={filters.project} options={options.project} onChange={(value) => updateFilter('project', value)} />
              <FilterSelect label="水印分类" value={filters.watermarkCategory} options={options.watermarkCategory} onChange={(value) => updateFilter('watermarkCategory', value)} />
              <FilterSelect label="工作内容" value={filters.workContent} options={options.workContent} onChange={(value) => updateFilter('workContent', value)} />
              <InputFilter label="开始日期" type="date" value={filters.startDate} onChange={(value) => updateFilter('startDate', value)} />
              <InputFilter label="结束日期" type="date" value={filters.endDate} onChange={(value) => updateFilter('endDate', value)} />
              <InputFilter label="关键词" value={filters.keyword} onChange={(value) => updateFilter('keyword', value)} />
              <InputFilter label="文件名" value={filters.fileName} onChange={(value) => updateFilter('fileName', value)} />
            </div>
            {showMoreFilters && (
              <div className="archive-filter-grid more">
                <FilterSelect label="部门" value={filters.department} options={options.department} onChange={(value) => updateFilter('department', value)} />
                <FilterSelect label="照片来源" value={filters.photoSource} options={options.photoSource} onChange={(value) => updateFilter('photoSource', value)} />
                <FilterSelect label="照片阶段" value={filters.photoStage} options={options.photoStage} onChange={(value) => updateFilter('photoStage', value)} />
                <FilterSelect label="处理状态" value={filters.processStatus} options={options.processStatus} onChange={(value) => updateFilter('processStatus', value)} />
                <InputFilter label="位置/区域" value={filters.location} onChange={(value) => updateFilter('location', value)} />
                <InputFilter label="备注" value={filters.remark} onChange={(value) => updateFilter('remark', value)} />
              </div>
            )}
          </section>

          <div className={`archive-query-status ${status.type}`}>{status.text}</div>

          <div className="archive-results-table-wrap">
            <table className="archive-results-table">
              <thead>
                <tr>
                  <th><button type="button" onClick={() => setSortDirection((value) => value === 'desc' ? 'asc' : 'desc')}>日期 {sortDirection === 'desc' ? '↓' : '↑'}</button></th>
                  <th>项目</th>
                  <th>水印分类</th>
                  <th>工作内容</th>
                  <th>位置/区域</th>
                  <th>照片阶段</th>
                  <th>处理状态</th>
                  <th>关键词</th>
                  <th>新文件名</th>
                  <th>文件状态</th>
                </tr>
              </thead>
              <tbody>
                {pageRecords.map((record) => (
                  <tr key={record.id} className={selectedRecord?.id === record.id ? 'selected' : ''} onClick={() => setSelectedId(record.id)}>
                    <Cell value={record.date} />
                    <Cell value={record.project} />
                    <Cell value={record.watermarkCategory} />
                    <Cell value={record.workContent} />
                    <Cell value={record.location} />
                    <Cell value={record.photoStage} />
                    <Cell value={record.processStatus} />
                    <Cell value={record.keywords} />
                    <Cell value={record.newFileName} />
                    <td><span className={`archive-file-status ${record.fileExists ? 'exists' : 'missing'}`}>{record.fileStatus}</span></td>
                  </tr>
                ))}
                {pageRecords.length === 0 && (
                  <tr><td colSpan="10" className="archive-empty-cell">当前没有匹配的归档记录。</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <footer className="archive-pagination">
            <span>第 {filteredRecords.length ? (safePage - 1) * pageSize + 1 : 0}-{Math.min(safePage * pageSize, filteredRecords.length)} 条 / 共 {filteredRecords.length} 条</span>
            <div>
              <button type="button" disabled={safePage <= 1} onClick={() => setPage(1)}>首页</button>
              <button type="button" disabled={safePage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button>
              <strong>{safePage} / {totalPages}</strong>
              <button type="button" disabled={safePage >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>下一页</button>
              <button type="button" disabled={safePage >= totalPages} onClick={() => setPage(totalPages)}>末页</button>
              <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}>
                {pageSizeOptions.map((value) => <option key={value} value={value}>{value} / 页</option>)}
              </select>
            </div>
          </footer>
        </main>

        <ArchiveRecordDetail record={selectedRecord} onOpen={openPhoto} onShowFolder={showInFolder} onCopy={copyPath} onCopySummary={copySummary} />
      </div>
    </div>
  );
}

function ArchiveRecordDetail({ record, onOpen, onShowFolder, onCopy, onCopySummary }) {
  if (!record) {
    return <aside className="archive-detail-panel panel archive-empty-detail">请选择一条归档记录查看详情。</aside>;
  }
  return (
    <aside className="archive-detail-panel panel">
      <h2>归档记录详情</h2>
      {record.fileExists ? (
        <img src={record.previewUrl} alt={record.newFileName || record.originalName} />
      ) : (
        <div className="archive-missing-preview">
          <strong>归档文件未找到。</strong>
          <span>可能原因：照片被移动或删除；归档根目录发生变化；台账记录路径与当前电脑路径不一致。</span>
        </div>
      )}
      <div className="archive-detail-actions">
        <button type="button" onClick={() => onOpen(record)} disabled={!record.fileExists}>打开照片</button>
        <button type="button" onClick={() => onShowFolder(record)} disabled={!record.fileExists}>打开所在文件夹</button>
        <button type="button" onClick={() => onCopy(record)} disabled={!record.archivePath}>复制文件路径</button>
        <button type="button" onClick={() => onCopySummary(record)}>复制记录摘要</button>
      </div>
      <dl>
        {[
          ['原文件名', record.originalName],
          ['新文件名', record.newFileName],
          ['归档日期', record.date],
          ['项目', record.project],
          ['部门', record.department],
          ['照片来源', record.photoSource],
          ['水印分类', record.watermarkCategory],
          ['工作内容', record.workContent],
          ['位置/区域', record.location],
          ['事项名称', record.itemName],
          ['照片阶段', record.photoStage],
          ['处理状态', record.processStatus],
          ['关键词', record.keywords],
          ['备注', record.remark],
          ['归档文件路径', record.archivePath],
          ['原始文件路径', record.originalPath]
        ].map(([label, value]) => (
          <div key={label}><dt>{label}</dt><dd title={value || '-'}>{value || '-'}</dd></div>
        ))}
      </dl>
    </aside>
  );
}

function StatCard({ label, value, tone = '' }) {
  return <span className={`archive-stat-card ${tone}`}><small>{label}</small><strong>{value}</strong></span>;
}

function FilterSelect({ label, value, options, onChange }) {
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

function Cell({ value }) {
  return <td title={value || ''}>{value || '-'}</td>;
}

function matchesFilters(record, filters) {
  const exactKeys = ['project', 'department', 'photoSource', 'watermarkCategory', 'workContent', 'photoStage', 'processStatus'];
  if (exactKeys.some((key) => filters[key] && record[key] !== filters[key])) return false;
  if (filters.startDate && String(record.date || '') < filters.startDate) return false;
  if (filters.endDate && String(record.date || '') > filters.endDate) return false;
  if (!contains(record.keywords, filters.keyword)) return false;
  if (!contains(record.location, filters.location)) return false;
  if (filters.fileName && !contains(`${record.originalName} ${record.newFileName}`, filters.fileName)) return false;
  if (!contains(record.remark, filters.remark)) return false;
  return true;
}

function contains(value, keyword) {
  if (!keyword) return true;
  return String(value || '').toLowerCase().includes(String(keyword).trim().toLowerCase());
}

function unique(values) {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN'));
}
