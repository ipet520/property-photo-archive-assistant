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
  const [selectedPackageIds, setSelectedPackageIds] = useState(() => new Set());
  const [status, setStatus] = useState({ type: 'idle', text: '请选择归档根目录并加载照片归档台账。' });
  const [isLoading, setIsLoading] = useState(false);
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [sortDirection, setSortDirection] = useState('desc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [packagePlan, setPackagePlan] = useState(null);
  const [packageResult, setPackageResult] = useState(null);
  const [isPackageGenerating, setIsPackageGenerating] = useState(false);

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
  const selectedPackageRecords = filteredRecords.filter((record) => selectedPackageIds.has(record.id));
  const packageSourceRecords = selectedPackageRecords.length > 0 ? selectedPackageRecords : filteredRecords;
  const packageSourceLabel = selectedPackageRecords.length > 0 ? '已勾选记录' : '当前筛选结果';
  const packageCopyableCount = packageSourceRecords.filter((record) => record.fileExists).length;
  const existsCount = filteredRecords.filter((record) => record.fileExists).length;
  const missingCount = filteredRecords.length - existsCount;

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  useEffect(() => {
    if (!window.archiveAssistant.onArchivePackageProgress) return undefined;
    return window.archiveAssistant.onArchivePackageProgress((progress) => {
      setStatus({ type: 'idle', text: `正在生成资料包：${progress.current} / ${progress.total}` });
    });
  }, []);

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
      setSelectedPackageIds(new Set());
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
    setSelectedPackageIds(new Set());
    setPage(1);
  }

  function resetFilters() {
    setFilters(defaultFilters);
    setSelectedPackageIds(new Set());
    setPage(1);
  }

  function togglePackageRecord(recordId) {
    setSelectedPackageIds((current) => {
      const next = new Set(current);
      if (next.has(recordId)) {
        next.delete(recordId);
      } else {
        next.add(recordId);
      }
      return next;
    });
  }

  function toggleCurrentPageSelection() {
    const pageIds = pageRecords.map((record) => record.id);
    const isAllSelected = pageIds.length > 0 && pageIds.every((id) => selectedPackageIds.has(id));
    setSelectedPackageIds((current) => {
      const next = new Set(current);
      pageIds.forEach((id) => {
        if (isAllSelected) {
          next.delete(id);
        } else {
          next.add(id);
        }
      });
      return next;
    });
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

  async function startPackageFlow() {
    if (packageSourceRecords.length === 0) {
      setStatus({ type: 'error', text: '当前没有可生成资料包的记录，请调整筛选条件。' });
      return;
    }
    if (packageCopyableCount === 0) {
      setStatus({ type: 'error', text: '当前记录没有任何可复制照片，无法生成资料包。' });
      return;
    }
    const targetRoot = await window.archiveAssistant.selectArchivePackageTargetRoot();
    if (!targetRoot) return;
    try {
      const plan = await window.archiveAssistant.buildArchivePackagePlan(packageSourceRecords, targetRoot);
      setPackagePlan({ ...plan, sourceLabel: packageSourceLabel, records: packageSourceRecords });
    } catch (error) {
      setStatus({ type: 'error', text: `生成资料包预检查失败：${error.message}` });
    }
  }

  async function confirmGeneratePackage() {
    if (!packagePlan) return;
    setIsPackageGenerating(true);
    setStatus({ type: 'idle', text: `正在生成资料包：0 / ${packagePlan.total}` });
    try {
      const result = await window.archiveAssistant.generateArchivePackage(packagePlan.records, {
        targetRoot: packagePlan.targetRoot,
        packagePath: packagePlan.packagePath
      });
      setPackageResult(result);
      setPackagePlan(null);
      setStatus({
        type: result.failedCount > 0 || result.missingCount > 0 ? 'warning' : 'success',
        text: `资料包生成完成：成功 ${result.copiedCount}，缺失 ${result.missingCount}，失败 ${result.failedCount}。`
      });
    } catch (error) {
      setStatus({ type: 'error', text: `资料包生成失败：${error.message}` });
    } finally {
      setIsPackageGenerating(false);
    }
  }

  const allPageSelected = pageRecords.length > 0 && pageRecords.every((record) => selectedPackageIds.has(record.id));

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
        <button type="button" className="primary subtle" onClick={startPackageFlow} disabled={packageSourceRecords.length === 0 || isPackageGenerating}>生成资料包</button>
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
          当前筛选结果中有 {missingCount} 条文件缺失，可能是照片被移动、删除或归档目录发生变化。生成资料包时会跳过缺失文件，并写入资料包目录。
        </div>
      )}

      <div className="archive-query-layout">
        <main className="archive-query-main panel">
          <section className="archive-filters">
            <header className="archive-filter-heading">
              <strong>常用筛选</strong>
              <div>
                <button type="button" onClick={() => setShowMoreFilters((value) => !value)}>{showMoreFilters ? '收起更多筛选' : '展开更多筛选'}</button>
                <button type="button" onClick={resetFilters}>重置筛选</button>
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

          <div className="archive-selection-toolbar">
            <span>已选择 {selectedPackageIds.size} 条；当前筛选结果 {filteredRecords.length} 条。{selectedPackageIds.size > 0 ? '生成资料包将优先使用已勾选记录。' : '未勾选时使用当前筛选结果。'}</span>
            <div>
              <button type="button" onClick={toggleCurrentPageSelection} disabled={pageRecords.length === 0}>{allPageSelected ? '取消当前页全选' : '当前页全选'}</button>
              <button type="button" onClick={() => setSelectedPackageIds(new Set())} disabled={selectedPackageIds.size === 0}>清空选择</button>
            </div>
          </div>

          <div className="archive-results-table-wrap">
            <table className="archive-results-table">
              <thead>
                <tr>
                  <th className="archive-check-column">选择</th>
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
                    <td className="archive-check-column">
                      <input
                        type="checkbox"
                        checked={selectedPackageIds.has(record.id)}
                        onChange={() => togglePackageRecord(record.id)}
                        onClick={(event) => event.stopPropagation()}
                        aria-label={`选择 ${record.newFileName || record.originalName || '归档记录'}`}
                      />
                    </td>
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
                  <tr><td colSpan="11" className="archive-empty-cell">当前没有匹配的归档记录。</td></tr>
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

      {packagePlan && (
        <ArchivePackageConfirmDialog
          plan={packagePlan}
          isGenerating={isPackageGenerating}
          onCancel={() => setPackagePlan(null)}
          onConfirm={confirmGeneratePackage}
        />
      )}

      {packageResult && (
        <ArchivePackageResultDialog
          result={packageResult}
          onClose={() => setPackageResult(null)}
          onOpenPackage={() => window.archiveAssistant.openPath(packageResult.packagePath)}
          onOpenCatalog={() => window.archiveAssistant.showItemInFolder(packageResult.catalogPath)}
        />
      )}
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

function ArchivePackageConfirmDialog({ plan, isGenerating, onCancel, onConfirm }) {
  return (
    <div className="archive-confirm-backdrop">
      <section className="archive-confirm-dialog archive-package-dialog" role="dialog" aria-modal="true" aria-label="生成资料包确认">
        <header className="archive-confirm-heading">
          <div>
            <span>资料包生成前确认</span>
            <h2>确认生成资料包？</h2>
          </div>
          <strong>{plan.total} 条</strong>
        </header>
        <section className="archive-confirm-section">
          <h3>生成范围</h3>
          <dl className="archive-confirm-grid">
            <div><dt>来源范围</dt><dd>{plan.sourceLabel}</dd></div>
            <div><dt>记录总数</dt><dd>{plan.total}</dd></div>
            <div><dt>文件存在</dt><dd>{plan.existsCount}</dd></div>
            <div><dt>文件缺失</dt><dd>{plan.missingCount}</dd></div>
            <div><dt>目标保存位置</dt><dd title={plan.targetRoot}>{plan.targetRoot}</dd></div>
            <div><dt>预计资料包名称</dt><dd title={plan.packageName}>{plan.packageName}</dd></div>
            <div><dt>分组规则</dt><dd>{plan.groupingRule}</dd></div>
          </dl>
        </section>
        {plan.missingCount > 0 && (
          <section className="archive-confirm-section warning">
            存在 {plan.missingCount} 条文件缺失记录。生成资料包时不会复制缺失文件，但会在资料包目录 Excel 中标记“文件缺失”。
          </section>
        )}
        <section className="archive-confirm-section safe">
          本次操作只复制照片，不移动、不删除、不压缩原图或归档照片，不修改原始台账。
        </section>
        <footer className="archive-confirm-actions">
          <button type="button" onClick={onCancel} disabled={isGenerating}>取消</button>
          <button type="button" className="primary" onClick={onConfirm} disabled={isGenerating || plan.existsCount === 0}>
            {isGenerating ? `正在生成资料包：0 / ${plan.total}` : '确认生成'}
          </button>
        </footer>
      </section>
    </div>
  );
}

function ArchivePackageResultDialog({ result, onClose, onOpenPackage, onOpenCatalog }) {
  return (
    <div className="archive-confirm-backdrop">
      <section className="archive-confirm-dialog archive-package-dialog" role="dialog" aria-modal="true" aria-label="资料包生成结果">
        <header className="archive-confirm-heading">
          <div>
            <span>资料包生成结果</span>
            <h2>{result.failedCount > 0 || result.missingCount > 0 ? '资料包已生成，存在需核对项' : '资料包生成成功'}</h2>
          </div>
          <strong>{result.copiedCount}/{result.total}</strong>
        </header>
        <section className="archive-confirm-section">
          <dl className="archive-confirm-grid">
            <div><dt>资料包路径</dt><dd title={result.packagePath}>{result.packagePath}</dd></div>
            <div><dt>资料目录</dt><dd title={result.catalogPath}>{result.catalogPath}</dd></div>
            <div><dt>总记录数</dt><dd>{result.total}</dd></div>
            <div><dt>成功复制</dt><dd>{result.copiedCount}</dd></div>
            <div><dt>文件缺失</dt><dd>{result.missingCount}</dd></div>
            <div><dt>复制失败</dt><dd>{result.failedCount}</dd></div>
          </dl>
        </section>
        <footer className="archive-confirm-actions">
          <button type="button" onClick={onOpenPackage}>打开资料包</button>
          <button type="button" onClick={onOpenCatalog}>打开资料目录</button>
          <button type="button" className="primary" onClick={onClose}>关闭</button>
        </footer>
      </section>
    </div>
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
