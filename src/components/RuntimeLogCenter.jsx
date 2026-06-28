import { useEffect, useMemo, useState } from 'react';
import { recordRuntimeLog } from '../utils/runtimeLogger.js';

const PAGE_OPTIONS = ['首页总览', '照片分拣工作台', '归档记录', '整改闭环中心', '资料汇总中心', '数据维护中心', '系统设置', '其它'];
const TYPE_OPTIONS = ['界面显示', '文件目录', '扫描照片', '生成预览', '确认归档', '台账记录', '查询筛选', '删除记录', '打开文件', '数据异常', '配置读取', '配置保存', '资料包生成', '页面异常', 'IPC 调用失败', '其它'];
const LEVEL_OPTIONS = [
  ['info', '信息'],
  ['warn', '警告'],
  ['error', '错误']
];
const STATUS_OPTIONS = [
  ['open', '未处理'],
  ['handled', '已处理'],
  ['ignored', '已忽略']
];
const TYPE_FILTERS = [
  ['all', '全部记录'],
  ['auto', '自动运行日志'],
  ['manual', '手动问题反馈']
];

export default function RuntimeLogCenter() {
  const [items, setItems] = useState([]);
  const [paths, setPaths] = useState(null);
  const [filters, setFilters] = useState({ logType: 'all', level: '', status: '', page: '', keyword: '' });
  const [selectedId, setSelectedId] = useState('');
  const [form, setForm] = useState(null);
  const [notice, setNotice] = useState({ type: 'idle', text: '正在读取运行日志与问题反馈...' });
  const [isBusy, setIsBusy] = useState(false);
  const [exportFormat, setExportFormat] = useState('xlsx');
  const [detailExpanded, setDetailExpanded] = useState(false);

  useEffect(() => {
    loadItems();
  }, []);

  const filteredItems = useMemo(() => items.filter((item) => {
    if (filters.logType !== 'all' && item.logType !== filters.logType) return false;
    if (filters.level && item.level !== filters.level) return false;
    if (filters.status && item.status !== filters.status) return false;
    if (filters.page && item.page !== filters.page) return false;
    const keyword = filters.keyword.trim().toLowerCase();
    if (keyword) {
      const haystack = `${item.page} ${item.operation} ${item.errorType} ${item.summary} ${item.suggestion} ${item.handledNote} ${item.technicalDetail}`.toLowerCase();
      if (!haystack.includes(keyword)) return false;
    }
    return true;
  }), [items, filters]);

  const selectedItem = useMemo(
    () => filteredItems.find((item) => item.id === selectedId) || filteredItems[0] || null,
    [filteredItems, selectedId]
  );

  const stats = useMemo(() => ({
    total: items.length,
    auto: items.filter((item) => item.logType === 'auto').length,
    manual: items.filter((item) => item.logType === 'manual').length,
    open: items.filter((item) => item.status === 'open').length,
    error: items.filter((item) => item.level === 'error').length,
    handled: items.filter((item) => item.status === 'handled').length
  }), [items]);

  async function loadItems() {
    setIsBusy(true);
    try {
      const result = await window.archiveAssistant.loadTrialIssues();
      const nextItems = result.items || [];
      setItems(nextItems);
      setPaths(result.paths || null);
      setSelectedId((current) => current || nextItems[0]?.id || '');
      setNotice({ type: 'success', text: `已加载 ${nextItems.length} 条运行日志与问题反馈。` });
    } catch (error) {
      setNotice({ type: 'error', text: `运行日志读取失败：${error?.message || '数据文件可能损坏'}。请先备份 trial-issues.json 后再排查。` });
    } finally {
      setIsBusy(false);
    }
  }

  function startCreate() {
    setForm({
      id: '',
      logType: 'manual',
      occurredAt: toDateTimeInput(new Date()),
      page: '照片分拣工作台',
      operation: '手动问题反馈',
      errorType: '操作体验',
      level: 'warn',
      summary: '',
      suggestion: '',
      technicalDetail: '',
      status: 'open',
      handledNote: ''
    });
  }

  function updateForm(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function saveManualFeedback() {
    if (!form?.summary?.trim()) {
      setNotice({ type: 'error', text: '问题描述不能为空。' });
      return;
    }
    setIsBusy(true);
    try {
      const result = await window.archiveAssistant.saveTrialIssue({
        ...form,
        logType: 'manual',
        occurredAt: String(form.occurredAt || '').replace('T', ' ')
      });
      setItems(result.items || []);
      setPaths(result.paths || paths);
      setForm(null);
      setNotice({ type: 'success', text: '手动问题反馈已保存。' });
    } catch (error) {
      setNotice({ type: 'error', text: `手动问题反馈保存失败：${error?.message || '本地数据文件无法写入'}。` });
      recordRuntimeLog({ page: '数据维护中心', operation: '保存手动问题反馈', errorType: '问题反馈保存失败', summary: error?.message || '保存失败', error });
    } finally {
      setIsBusy(false);
    }
  }

  async function updateItemStatus(item, status) {
    if (!item) return;
    setIsBusy(true);
    try {
      const result = await window.archiveAssistant.saveTrialIssue({ ...item, status });
      setItems(result.items || []);
      setNotice({ type: 'success', text: status === 'handled' ? '已标记为已处理。' : '已标记为已忽略。' });
    } catch (error) {
      setNotice({ type: 'error', text: `状态更新失败：${error?.message || '请检查数据文件权限'}。` });
    } finally {
      setIsBusy(false);
    }
  }

  async function saveHandledNote(item, handledNote) {
    if (!item) return;
    setIsBusy(true);
    try {
      const result = await window.archiveAssistant.saveTrialIssue({ ...item, handledNote });
      setItems(result.items || []);
      setNotice({ type: 'success', text: '处理备注已保存。' });
    } catch (error) {
      setNotice({ type: 'error', text: `处理备注保存失败：${error?.message || '请检查数据文件权限'}。` });
    } finally {
      setIsBusy(false);
    }
  }

  async function removeItem(item) {
    if (!item || !window.confirm('确定要删除这条运行日志或问题反馈吗？删除后不可恢复。')) return;
    setIsBusy(true);
    try {
      const result = await window.archiveAssistant.deleteTrialIssue(item.id);
      setItems(result.items || []);
      setSelectedId(result.items?.[0]?.id || '');
      setNotice({ type: 'success', text: '记录已删除。' });
    } catch (error) {
      setNotice({ type: 'error', text: `删除记录失败：${error?.message || '请重新加载后再试'}。` });
    } finally {
      setIsBusy(false);
    }
  }

  async function clearHandled() {
    if (!window.confirm('确定清空所有已处理记录吗？自动日志和未处理反馈不会被删除。')) return;
    setIsBusy(true);
    try {
      const result = await window.archiveAssistant.clearHandledTrialIssues();
      setItems(result.items || []);
      setSelectedId(result.items?.[0]?.id || '');
      setNotice({ type: 'success', text: '已处理记录已清空。' });
    } catch (error) {
      setNotice({ type: 'error', text: `清空已处理记录失败：${error?.message || '请检查数据文件权限'}。` });
    } finally {
      setIsBusy(false);
    }
  }

  async function exportItems() {
    if (filteredItems.length === 0) return;
    setIsBusy(true);
    try {
      const result = await window.archiveAssistant.exportTrialIssues(filteredItems, exportFormat);
      if (result?.canceled) return;
      setNotice(result?.success
        ? { type: 'success', text: `运行日志已导出：${result.filePath}` }
        : { type: 'error', text: `运行日志导出失败：${result?.message || '未生成导出文件'}。` });
      if (!result?.success) {
        await recordRuntimeLog({ page: '数据维护中心', operation: '导出运行日志', errorType: '导出日志失败', summary: result?.message || '未生成导出文件' });
      }
    } catch (error) {
      setNotice({ type: 'error', text: `运行日志导出失败：${error?.message || '请检查目标目录权限'}。` });
      await recordRuntimeLog({ page: '数据维护中心', operation: '导出运行日志', errorType: '导出日志失败', summary: error?.message || '导出失败', error });
    } finally {
      setIsBusy(false);
    }
  }

  function applyStatFilter(key) {
    const next = {
      total: { logType: 'all', level: '', status: '' },
      auto: { logType: 'auto', level: '', status: '' },
      manual: { logType: 'manual', level: '', status: '' },
      open: { logType: 'all', level: '', status: 'open' },
      error: { logType: 'all', level: 'error', status: '' },
      handled: { logType: 'all', level: '', status: 'handled' }
    }[key];
    if (next) setFilters((current) => ({ ...current, ...next }));
  }

  return (
    <div className="runtime-log-center">
      <header className="runtime-log-heading">
        <div>
          <h3>运行日志与问题反馈中心</h3>
          <p>自动记录关键异常，手动反馈作为补充；用于排查扫描、归档、台账、导出、资料包和配置问题。</p>
          {paths?.dataFile && <small title={paths.dataFile}>数据文件：{paths.dataFile}</small>}
        </div>
        <div>
          <button type="button" className="primary orange" onClick={startCreate} disabled={isBusy}>新增反馈</button>
          <select value={exportFormat} onChange={(event) => setExportFormat(event.target.value)} aria-label="导出格式">
            <option value="xlsx">Excel</option>
            <option value="csv">CSV</option>
          </select>
          <button type="button" onClick={exportItems} disabled={isBusy || filteredItems.length === 0}>导出日志</button>
          <button type="button" onClick={clearHandled} disabled={isBusy || stats.handled === 0}>清空已处理</button>
        </div>
      </header>

      <div className={`archive-query-status ${notice.type}`}>{notice.text}</div>

      <div className="runtime-log-stats">
        <RuntimeStat label="全部" value={stats.total} active={filters.logType === 'all' && !filters.level && !filters.status} onClick={() => applyStatFilter('total')} />
        <RuntimeStat label="自动日志" value={stats.auto} active={filters.logType === 'auto'} onClick={() => applyStatFilter('auto')} />
        <RuntimeStat label="手动反馈" value={stats.manual} active={filters.logType === 'manual'} onClick={() => applyStatFilter('manual')} />
        <RuntimeStat label="未处理" value={stats.open} active={filters.status === 'open'} onClick={() => applyStatFilter('open')} />
        <RuntimeStat label="错误" value={stats.error} active={filters.level === 'error'} onClick={() => applyStatFilter('error')} />
        <RuntimeStat label="已处理" value={stats.handled} active={filters.status === 'handled'} onClick={() => applyStatFilter('handled')} />
      </div>

      <div className="runtime-log-filters">
        <label><span>记录类型</span><select value={filters.logType} onChange={(event) => setFilters((current) => ({ ...current, logType: event.target.value }))}>{TYPE_FILTERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>级别</span><select value={filters.level} onChange={(event) => setFilters((current) => ({ ...current, level: event.target.value }))}><option value="">全部</option>{LEVEL_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>处理状态</span><select value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}><option value="">全部</option>{STATUS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>页面</span><select value={filters.page} onChange={(event) => setFilters((current) => ({ ...current, page: event.target.value }))}><option value="">全部</option>{PAGE_OPTIONS.map((page) => <option key={page} value={page}>{page}</option>)}</select></label>
        <label className="wide"><span>关键词搜索</span><input value={filters.keyword} placeholder="搜索摘要、建议、备注或技术详情" onChange={(event) => setFilters((current) => ({ ...current, keyword: event.target.value }))} /></label>
      </div>

      {form && (
        <section className="runtime-feedback-form">
          <header><h3>新增手动问题反馈</h3></header>
          <div className="runtime-feedback-grid">
            <label><span>问题时间</span><input type="datetime-local" value={form.occurredAt} onChange={(event) => updateForm('occurredAt', event.target.value)} /></label>
            <label><span>问题页面</span><input list="runtime-page-options" value={form.page} onChange={(event) => updateForm('page', event.target.value)} /></label>
            <label><span>问题类型</span><select value={form.errorType} onChange={(event) => updateForm('errorType', event.target.value)}>{TYPE_OPTIONS.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
            <label><span>影响程度</span><select value={form.level} onChange={(event) => updateForm('level', event.target.value)}><option value="info">一般</option><option value="warn">重要</option><option value="error">严重</option></select></label>
            <label className="wide"><span>问题描述 *</span><textarea value={form.summary} onChange={(event) => updateForm('summary', event.target.value)} /></label>
            <label className="wide"><span>处理备注</span><textarea value={form.handledNote} onChange={(event) => updateForm('handledNote', event.target.value)} /></label>
          </div>
          <datalist id="runtime-page-options">{PAGE_OPTIONS.map((page) => <option key={page} value={page} />)}</datalist>
          <footer><button type="button" onClick={() => setForm(null)} disabled={isBusy}>取消</button><button type="button" className="primary orange" onClick={saveManualFeedback} disabled={isBusy}>保存反馈</button></footer>
        </section>
      )}

      <div className="runtime-log-layout">
        <div className="runtime-log-table-wrap">
          <table className="runtime-log-table">
            <thead><tr><th>类型</th><th>时间</th><th>页面</th><th>操作</th><th>级别</th><th>状态</th><th>摘要</th><th>操作</th></tr></thead>
            <tbody>
              {filteredItems.map((item) => (
                <tr key={item.id} className={selectedItem?.id === item.id ? 'selected' : ''} onClick={() => setSelectedId(item.id)}>
                  <td><span className={`runtime-tag ${item.logType}`}>{item.logType === 'auto' ? '自动日志' : '手动反馈'}</span></td>
                  <td>{formatDateTime(item.occurredAt || item.issueTime)}</td>
                  <td title={item.page}>{item.page}</td>
                  <td title={item.operation}>{item.operation || '-'}</td>
                  <td><span className={`runtime-tag level-${item.level}`}>{levelLabel(item.level)}</span></td>
                  <td><span className={`runtime-tag status-${item.status}`}>{statusLabel(item.status)}</span></td>
                  <td><span className="trial-two-line" title={item.summary || item.description}>{item.summary || item.description}</span></td>
                  <td><div className="trial-row-actions"><button type="button" onClick={(event) => { event.stopPropagation(); updateItemStatus(item, 'handled'); }}>处理</button><button type="button" className="danger" onClick={(event) => { event.stopPropagation(); removeItem(item); }}>删除</button></div></td>
                </tr>
              ))}
              {filteredItems.length === 0 && <tr><td colSpan="8" className="maintenance-empty">暂无运行日志或问题反馈</td></tr>}
            </tbody>
          </table>
        </div>

        <aside className="runtime-log-detail">
          {selectedItem ? (
            <RuntimeLogDetail
              item={selectedItem}
              expanded={detailExpanded}
              setExpanded={setDetailExpanded}
              onStatus={updateItemStatus}
              onSaveNote={saveHandledNote}
              onDelete={removeItem}
            />
          ) : (
            <div className="empty-state">请选择一条运行日志或问题反馈查看详情。</div>
          )}
        </aside>
      </div>
    </div>
  );
}

function RuntimeLogDetail({ item, expanded, setExpanded, onStatus, onSaveNote, onDelete }) {
  const [note, setNote] = useState(item.handledNote || item.handlingNote || '');

  useEffect(() => {
    setNote(item.handledNote || item.handlingNote || '');
  }, [item.id, item.handledNote, item.handlingNote]);

  return (
    <>
      <header>
        <span className={`runtime-tag ${item.logType}`}>{item.logType === 'auto' ? '自动日志' : '手动反馈'}</span>
        <h3>{item.summary || item.description || '未填写摘要'}</h3>
      </header>
      <dl className="runtime-detail-grid">
        <div><dt>时间</dt><dd>{formatDateTime(item.occurredAt || item.issueTime)}</dd></div>
        <div><dt>页面</dt><dd>{item.page || '-'}</dd></div>
        <div><dt>操作</dt><dd>{item.operation || '-'}</dd></div>
        <div><dt>级别</dt><dd>{levelLabel(item.level)}</dd></div>
        <div><dt>错误类型</dt><dd>{item.errorType || item.type || '-'}</dd></div>
        <div><dt>处理状态</dt><dd>{statusLabel(item.status)}</dd></div>
      </dl>
      <section><h4>处理建议</h4><p>{item.suggestion || '请记录当前操作步骤，并导出运行日志交给维护人员排查。'}</p></section>
      <label className="runtime-note-editor"><span>处理备注</span><textarea value={note} onChange={(event) => setNote(event.target.value)} /></label>
      <div className="runtime-detail-actions">
        <button type="button" onClick={() => onSaveNote(item, note)}>保存备注</button>
        <button type="button" onClick={() => onStatus(item, 'handled')}>标记已处理</button>
        <button type="button" onClick={() => onStatus(item, 'ignored')}>标记已忽略</button>
        <button type="button" className="danger" onClick={() => onDelete(item)}>删除</button>
      </div>
      <section className="runtime-technical-detail">
        <button type="button" onClick={() => setExpanded(!expanded)}>{expanded ? '收起技术详情' : '展开技术详情'}</button>
        <button type="button" onClick={() => window.archiveAssistant.copyText(item.technicalDetail || '')} disabled={!item.technicalDetail}>复制技术详情</button>
        {expanded && <pre>{item.technicalDetail || '暂无技术详情。'}</pre>}
      </section>
    </>
  );
}

function RuntimeStat({ label, value, active, onClick }) {
  return <button type="button" className={active ? 'active' : ''} onClick={onClick}><span>{label}</span><strong>{value}</strong></button>;
}

function levelLabel(value) {
  return { info: '信息', warn: '警告', error: '错误' }[value] || '信息';
}

function statusLabel(value) {
  return { open: '未处理', handled: '已处理', ignored: '已忽略' }[value] || '未处理';
}

function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toDateTimeInput(value) {
  const date = value instanceof Date ? value : new Date(String(value || '').replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return String(value || '').slice(0, 16).replace(' ', 'T');
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
