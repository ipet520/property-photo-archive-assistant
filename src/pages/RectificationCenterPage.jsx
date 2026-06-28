import { useEffect, useMemo, useState } from 'react';
import { recordRuntimeLog } from '../utils/runtimeLogger.js';

const RECTIFICATION_STATUSES = ['待整改', '整改中', '已完成', '已关闭'];
const PHOTO_STAGES = [
  { key: 'before', label: '整改前照片' },
  { key: 'during', label: '整改中照片' },
  { key: 'after', label: '整改后照片' }
];

const defaultFilters = {
  project: '',
  department: '',
  status: '',
  overdueOnly: false,
  deadlineStart: '',
  deadlineEnd: '',
  keyword: ''
};

const defaultLedgerFilters = {
  project: '',
  category: '',
  workContent: '',
  startDate: '',
  endDate: '',
  keyword: ''
};

const defaultForm = {
  id: '',
  rectificationNo: '',
  project: '',
  responsibleDepartment: '',
  watermarkCategory: '',
  workContent: '',
  location: '',
  title: '',
  description: '',
  requirement: '',
  deadline: '',
  status: '待整改',
  owner: '',
  keywords: '',
  remark: '',
  photos: { before: [], during: [], after: [] },
  sourceRecords: [],
  closeNote: ''
};

export default function RectificationCenterPage({ archiveState, navigationRequest }) {
  const [items, setItems] = useState([]);
  const [configs, setConfigs] = useState(null);
  const [selectedId, setSelectedId] = useState('');
  const [filters, setFilters] = useState(defaultFilters);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [form, setForm] = useState(defaultForm);
  const [isEditing, setIsEditing] = useState(false);
  const [showLedgerPicker, setShowLedgerPicker] = useState(false);
  const [ledgerRecords, setLedgerRecords] = useState([]);
  const [ledgerSelectedIds, setLedgerSelectedIds] = useState(() => new Set());
  const [ledgerFilters, setLedgerFilters] = useState(defaultLedgerFilters);
  const [ledgerArchiveRoot, setLedgerArchiveRoot] = useState(archiveState?.archiveRoot || '');
  const [status, setStatus] = useState({ type: 'idle', text: '整改闭环中心已就绪。' });
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    loadInitialData();
  }, []);

  useEffect(() => {
    if (!navigationRequest?.nonce || !items.length) return;
    if (navigationRequest.action === 'select-rectification') {
      const target = navigationRequest.payload || {};
      const matched = items.find((item) => item.id === target.id)
        || items.find((item) => item.rectificationNo && item.rectificationNo === target.rectificationNo);
      if (matched) setSelectedId(matched.id);
    }
  }, [navigationRequest?.nonce, items.length]);

  const configOptions = useMemo(() => normalizeConfigOptions(configs), [configs]);
  const selectedItem = useMemo(() => items.find((item) => item.id === selectedId) || null, [items, selectedId]);
  const workContentOptions = useMemo(() => getWorkContentOptions(configs, form.watermarkCategory), [configs, form.watermarkCategory]);

  const filteredItems = useMemo(() => {
    return items
      .filter((item) => matchesFilters(item, filters))
      .sort((a, b) => (Date.parse(b.updatedAt || b.createdAt || '') || 0) - (Date.parse(a.updatedAt || a.createdAt || '') || 0));
  }, [items, filters]);

  const stats = useMemo(() => ({
    total: items.length,
    pending: items.filter((item) => item.status === '待整改').length,
    doing: items.filter((item) => item.status === '整改中').length,
    done: items.filter((item) => item.status === '已完成').length,
    closed: items.filter((item) => item.status === '已关闭').length,
    overdue: items.filter(isOverdue).length
  }), [items]);

  const totalPages = Math.max(1, Math.ceil(filteredItems.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageItems = filteredItems.slice((safePage - 1) * pageSize, safePage * pageSize);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  async function loadInitialData() {
    setIsLoading(true);
    try {
      const [configResult, itemResult, settings] = await Promise.all([
        window.archiveAssistant.loadConfigs().catch(() => null),
        window.archiveAssistant.loadRectificationItems(),
        window.archiveAssistant.loadSettings().catch(() => null)
      ]);
      const nextItems = itemResult.items || [];
      setConfigs(configResult);
      setItems(nextItems);
      setLedgerArchiveRoot(archiveState?.archiveRoot || settings?.defaultArchiveRoot || settings?.lastArchiveRoot || '');
      setSelectedId(nextItems[0]?.id || '');
      setStatus({ type: 'success', text: `已加载 ${nextItems.length} 条整改事项。` });
    } catch (error) {
      recordRuntimeLog({ page: '整改闭环中心', operation: '加载整改事项', errorType: '整改事项加载失败', summary: error.message, error });
      setStatus({ type: 'error', text: `整改事项读取失败：${error.message}` });
    } finally {
      setIsLoading(false);
    }
  }

  function updateFilter(key, value) {
    setFilters((current) => ({
      ...current,
      [key]: value,
      ...(key === 'status' ? { overdueOnly: false } : {})
    }));
    setPage(1);
  }

  function applyStatFilter(statusValue = '', overdueOnly = false) {
    setFilters((current) => ({ ...current, status: statusValue, overdueOnly }));
    setPage(1);
  }

  function startCreate() {
    setForm(defaultForm);
    setIsEditing(true);
    setStatus({ type: 'idle', text: '正在新建整改事项，保存后才会生成正式整改编号。' });
  }

  function startEdit(item = selectedItem) {
    if (!item) {
      setStatus({ type: 'warning', text: '请先选择一条整改事项。' });
      return;
    }
    setForm({
      ...defaultForm,
      ...item,
      keywords: Array.isArray(item.keywords) ? item.keywords.join('、') : item.keywords || ''
    });
    setIsEditing(true);
  }

  async function saveForm() {
    try {
      const result = await window.archiveAssistant.saveRectificationItem({
        ...form,
        keywords: splitKeywords(form.keywords),
        photos: form.photos || { before: [], during: [], after: [] }
      });
      setItems(result.items || []);
      setSelectedId(result.item.id);
      setIsEditing(false);
      setStatus({ type: 'success', text: `已保存整改事项：${result.item.rectificationNo}` });
    } catch (error) {
      recordRuntimeLog({ page: '整改闭环中心', operation: '保存整改事项', errorType: '整改事项保存失败', summary: error.message || '保存失败', error });
      setStatus({ type: 'error', text: error.message || '保存失败。' });
    }
  }

  async function addPhotos(stage) {
    const photos = await window.archiveAssistant.selectRectificationPhotos();
    if (!photos?.length) return;
    const nextPhotos = photos.map((photo) => ({
      ...photo,
      id: `photo-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
      stage,
      sourceType: '手动添加'
    }));
    setForm((current) => ({
      ...current,
      photos: {
        ...current.photos,
        [stage]: [...(current.photos?.[stage] || []), ...nextPhotos]
      }
    }));
  }

  async function addPhotosToSelected(stage) {
    if (!selectedItem) return;
    const photos = await window.archiveAssistant.selectRectificationPhotos();
    if (!photos?.length) return;
    const nextItem = {
      ...selectedItem,
      photos: {
        ...selectedItem.photos,
        [stage]: [
          ...(selectedItem.photos?.[stage] || []),
          ...photos.map((photo) => ({
            ...photo,
            id: `photo-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
            stage,
            sourceType: '手动添加'
          }))
        ]
      }
    };
    const result = await window.archiveAssistant.saveRectificationItem(nextItem);
    setItems(result.items || []);
    setSelectedId(result.item.id);
    setStatus({ type: 'success', text: '已关联照片路径，原照片未移动、未删除、未压缩。' });
  }

  async function updateSelectedStatus(nextStatus) {
    if (!selectedItem) return;
    try {
      const result = await window.archiveAssistant.saveRectificationItem({ ...selectedItem, status: nextStatus });
      setItems(result.items || []);
      setSelectedId(result.item.id);
      setStatus({ type: 'success', text: `状态已更新为：${nextStatus}` });
    } catch (error) {
      recordRuntimeLog({ page: '整改闭环中心', operation: '更新整改状态', errorType: '整改事项保存失败', summary: error.message || '状态更新失败', error });
      setStatus({ type: 'error', text: error.message || '状态更新失败。' });
    }
  }

  async function exportItems() {
    const result = await window.archiveAssistant.exportRectificationItems(filteredItems);
    if (result?.canceled) return;
    setStatus(result.success
      ? { type: 'success', text: `整改台账已导出：${result.filePath}` }
      : { type: 'warning', text: result.message || '导出失败。' });
  }

  async function copySummary(item = selectedItem) {
    if (!item) return;
    await window.archiveAssistant.copyText(buildSummary(item));
    setStatus({ type: 'success', text: '整改事项摘要已复制。' });
  }

  async function openPhoto(photo) {
    const result = await window.archiveAssistant.openPath(photo.filePath);
    if (!result.success) setStatus({ type: 'error', text: result.message || '打开照片失败。' });
  }

  async function showPhoto(photo) {
    const result = await window.archiveAssistant.showItemInFolder(photo.filePath);
    if (!result.success) setStatus({ type: 'error', text: result.message || '打开所在文件夹失败。' });
  }

  async function chooseArchiveRoot() {
    const selected = await window.archiveAssistant.selectArchiveRoot();
    if (selected) {
      setLedgerArchiveRoot(selected);
      await window.archiveAssistant.updateLastArchiveRoot(selected);
    }
  }

  async function loadLedger() {
    if (!ledgerArchiveRoot) {
      setStatus({ type: 'warning', text: '请先选择或填写归档根目录。' });
      return;
    }
    try {
      const result = await window.archiveAssistant.loadLedgerRecords(ledgerArchiveRoot);
      setLedgerRecords(result.records || []);
      setLedgerSelectedIds(new Set());
      setStatus({ type: 'success', text: `已加载 ${result.records?.length || 0} 条归档记录，可选择照片创建整改事项。` });
    } catch (error) {
      recordRuntimeLog({ page: '整改闭环中心', operation: '读取归档记录', errorType: '加载台账失败', summary: error.message, error });
      setStatus({ type: 'error', text: `归档记录读取失败：${error.message}` });
    }
  }

  function toggleLedgerRecord(recordId, checked) {
    setLedgerSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(recordId);
      else next.delete(recordId);
      return next;
    });
  }

  function createFromLedger() {
    const selected = ledgerRecords.filter((record) => ledgerSelectedIds.has(record.id));
    if (selected.length === 0) {
      setStatus({ type: 'warning', text: '请先选择至少一条归档记录。' });
      return;
    }
    const first = selected[0];
    setForm({
      ...defaultForm,
      project: first.project || '',
      responsibleDepartment: first.department || '',
      watermarkCategory: first.watermarkCategory || '',
      workContent: first.workContent || '',
      location: first.location || '',
      title: first.workContent ? `${first.workContent}整改` : '现场问题整改',
      description: first.remark || first.itemName || '',
      requirement: '请责任部门核实现问题并按要求完成整改。',
      keywords: first.keywords || '',
      photos: {
        before: selected.map((record) => ({
          id: `ledger-photo-${record.id}`,
          filePath: record.archivePath || '',
          fileName: record.newFileName || record.originalName || '',
          sourceType: '归档记录',
          stage: 'before',
          addedAt: new Date().toISOString(),
          fileExists: Boolean(record.fileExists)
        })),
        during: [],
        after: []
      },
      sourceRecords: selected.map((record) => ({
        id: record.id,
        rowNumber: record.rowNumber,
        archivePath: record.archivePath,
        newFileName: record.newFileName
      }))
    });
    setIsEditing(true);
    setShowLedgerPicker(false);
    setStatus({ type: 'success', text: `已带入 ${selected.length} 张整改前照片，请补全标题、描述、要求和截止日期后保存。` });
  }

  const ledgerFilteredRecords = useMemo(() => {
    return ledgerRecords.filter((record) => matchesLedgerFilters(record, ledgerFilters)).slice(0, 200);
  }, [ledgerRecords, ledgerFilters]);

  return (
    <div className="rectification-page">
      <section className="page-hero compact">
        <div>
          <p className="eyebrow">整改闭环中心</p>
          <h1>整改事项跟踪台账</h1>
          <p>把已归档照片转化为可跟踪、可核对、可导出的整改事项。原始照片和原始归档台账不会被修改。</p>
        </div>
        <div className="rectification-hero-actions">
          <button onClick={startCreate}>新建整改事项</button>
          <button className="ghost" onClick={() => setShowLedgerPicker(true)}>从归档记录创建</button>
          <button className="ghost" onClick={exportItems} disabled={filteredItems.length === 0}>导出整改台账</button>
          <button className="ghost" onClick={loadInitialData} disabled={isLoading}>刷新</button>
        </div>
      </section>

      <section className="rectification-stats">
        <Stat label="全部" value={stats.total} active={!filters.status && !filters.overdueOnly} onClick={() => applyStatFilter()} />
        <Stat label="待整改" value={stats.pending} active={filters.status === '待整改' && !filters.overdueOnly} onClick={() => applyStatFilter('待整改')} />
        <Stat label="整改中" value={stats.doing} active={filters.status === '整改中' && !filters.overdueOnly} onClick={() => applyStatFilter('整改中')} />
        <Stat label="已完成" value={stats.done} active={filters.status === '已完成' && !filters.overdueOnly} onClick={() => applyStatFilter('已完成')} />
        <Stat label="已关闭" value={stats.closed} active={filters.status === '已关闭' && !filters.overdueOnly} onClick={() => applyStatFilter('已关闭')} />
        <Stat label="逾期提醒" value={stats.overdue} warning active={filters.overdueOnly} onClick={() => applyStatFilter('', true)} />
      </section>

      <section className="rectification-toolbar panel">
        <SelectField label="项目" value={filters.project} onChange={(value) => updateFilter('project', value)} options={unique(items.map((item) => item.project))} />
        <SelectField label="责任部门" value={filters.department} onChange={(value) => updateFilter('department', value)} options={unique(items.map((item) => item.responsibleDepartment))} />
        <SelectField label="整改状态" value={filters.status} onChange={(value) => updateFilter('status', value)} options={RECTIFICATION_STATUSES} />
        <label>
          <span>截止开始</span>
          <input type="date" value={filters.deadlineStart} onChange={(event) => updateFilter('deadlineStart', event.target.value)} />
        </label>
        <label>
          <span>截止结束</span>
          <input type="date" value={filters.deadlineEnd} onChange={(event) => updateFilter('deadlineEnd', event.target.value)} />
        </label>
        <label className="wide">
          <span>关键词 / 问题搜索</span>
          <input value={filters.keyword} onChange={(event) => updateFilter('keyword', event.target.value)} placeholder="搜索标题、描述、要求、关键词、位置" />
        </label>
        <button className="ghost" onClick={() => { setFilters(defaultFilters); setPage(1); }}>重置筛选</button>
      </section>

      <div className={`archive-query-status ${status.type}`}>{status.text}</div>

      <section className="rectification-layout">
        <main className="rectification-list-panel panel">
          <header>
            <div>
              <h2>整改事项列表</h2>
              <span>当前筛选 {filteredItems.length} 条</span>
            </div>
            <label className="ui-page-size">
              每页
              <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}>
                {[50, 100, 200].map((size) => <option key={size} value={size}>{size}</option>)}
              </select>
            </label>
          </header>
          <div className="rectification-table-wrap">
            <table className="rectification-table">
              <thead>
                <tr>
                  <th>整改编号</th>
                  <th>创建日期</th>
                  <th>项目</th>
                  <th>责任部门</th>
                  <th>问题标题</th>
                  <th>位置 / 区域</th>
                  <th>状态</th>
                  <th>截止日期</th>
                  <th>照片数</th>
                  <th>更新时间</th>
                </tr>
              </thead>
              <tbody>
                {pageItems.length === 0 ? (
                  <tr><td colSpan="10" className="archive-empty-cell">当前暂无整改事项，可新建或从归档记录创建。</td></tr>
                ) : pageItems.map((item) => (
                  <tr key={item.id} className={item.id === selectedId ? 'selected' : ''} onClick={() => setSelectedId(item.id)}>
                    <td>{item.rectificationNo}</td>
                    <td>{formatDate(item.createdAt)}</td>
                    <td title={item.project}>{item.project}</td>
                    <td title={item.responsibleDepartment}>{item.responsibleDepartment}</td>
                    <td title={item.title}>{item.title}</td>
                    <td title={item.location}>{item.location}</td>
                    <td><StatusBadge status={item.status} /></td>
                    <td className={isOverdue(item) ? 'rectification-overdue' : ''}>{item.deadline}</td>
                    <td>{photoCount(item)}</td>
                    <td>{formatDateTime(item.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <footer className="archive-pagination">
            <span>当前显示：第 {filteredItems.length === 0 ? 0 : (safePage - 1) * pageSize + 1}-{Math.min(safePage * pageSize, filteredItems.length)} 条 / 共 {filteredItems.length} 条</span>
            <div>
              <button className="mini-button" onClick={() => setPage(1)} disabled={safePage === 1}>首页</button>
              <button className="mini-button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={safePage === 1}>上一页</button>
              <strong>第 {safePage} / {totalPages} 页</strong>
              <button className="mini-button" onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={safePage === totalPages}>下一页</button>
              <button className="mini-button" onClick={() => setPage(totalPages)} disabled={safePage === totalPages}>末页</button>
            </div>
          </footer>
        </main>

        <aside className="rectification-detail panel">
          {isEditing ? (
            <RectificationForm
              form={form}
              setForm={setForm}
              configOptions={configOptions}
              workContentOptions={workContentOptions}
              onCancel={() => setIsEditing(false)}
              onSave={saveForm}
              onAddPhotos={addPhotos}
            />
          ) : selectedItem ? (
            <DetailPanel
              item={selectedItem}
              onEdit={() => startEdit(selectedItem)}
              onUpdateStatus={updateSelectedStatus}
              onAddPhotos={addPhotosToSelected}
              onOpenPhoto={openPhoto}
              onShowPhoto={showPhoto}
              onCopySummary={() => copySummary(selectedItem)}
            />
          ) : (
            <div className="archive-empty-detail">请选择一条整改事项查看详情。</div>
          )}
        </aside>
      </section>

      {showLedgerPicker ? (
        <LedgerPickerDialog
          archiveRoot={ledgerArchiveRoot}
          setArchiveRoot={setLedgerArchiveRoot}
          filters={ledgerFilters}
          setFilters={setLedgerFilters}
          records={ledgerFilteredRecords}
          allRecords={ledgerRecords}
          selectedIds={ledgerSelectedIds}
          onToggle={toggleLedgerRecord}
          onChooseArchiveRoot={chooseArchiveRoot}
          onLoadLedger={loadLedger}
          onCreate={createFromLedger}
          onClose={() => setShowLedgerPicker(false)}
        />
      ) : null}
    </div>
  );
}

function RectificationForm({ form, setForm, configOptions, workContentOptions, onCancel, onSave, onAddPhotos }) {
  function update(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }
  function updateCategory(value) {
    setForm((current) => ({ ...current, watermarkCategory: value, workContent: '' }));
  }
  return (
    <div className="rectification-form">
      <header>
        <h2>{form.id ? '编辑整改事项' : '新建整改事项'}</h2>
        <p>保存后写入本地整改事项数据，不修改原始归档台账和照片。</p>
      </header>
      <div className="rectification-form-grid">
        <FormSelect label="项目 *" value={form.project} onChange={(value) => update('project', value)} options={configOptions.projects} />
        <FormSelect label="责任部门 *" value={form.responsibleDepartment} onChange={(value) => update('responsibleDepartment', value)} options={configOptions.departments} />
        <FormSelect label="水印分类" value={form.watermarkCategory} onChange={updateCategory} options={configOptions.watermarkCategories} />
        <FormSelect label="工作内容" value={form.workContent} onChange={(value) => update('workContent', value)} options={workContentOptions} />
        <FormInput label="问题位置 / 区域 *" value={form.location} onChange={(value) => update('location', value)} />
        <FormInput label="截止日期 *" type="date" value={form.deadline} onChange={(value) => update('deadline', value)} />
        <FormInput label="问题标题 *" value={form.title} onChange={(value) => update('title', value)} wide />
        <FormTextarea label="问题描述 *" value={form.description} onChange={(value) => update('description', value)} />
        <FormTextarea label="整改要求 *" value={form.requirement} onChange={(value) => update('requirement', value)} />
        <FormSelect label="整改状态" value={form.status} onChange={(value) => update('status', value)} options={RECTIFICATION_STATUSES} />
        <FormInput label="处理人 / 跟进人" value={form.owner} onChange={(value) => update('owner', value)} />
        <FormInput label="关键词" value={form.keywords} onChange={(value) => update('keywords', value)} wide />
        <FormTextarea label="备注" value={form.remark} onChange={(value) => update('remark', value)} />
        {form.status === '已关闭' ? <FormTextarea label="关闭说明" value={form.closeNote} onChange={(value) => update('closeNote', value)} /> : null}
      </div>
      <PhotoStageEditor photos={form.photos} onAddPhotos={onAddPhotos} />
      <footer>
        <button className="ghost" onClick={onCancel}>返回列表</button>
        <button onClick={onSave}>保存整改事项</button>
      </footer>
    </div>
  );
}

function DetailPanel({ item, onEdit, onUpdateStatus, onAddPhotos, onOpenPhoto, onShowPhoto, onCopySummary }) {
  return (
    <div className="rectification-detail-content">
      <header>
        <div>
          <span>{item.rectificationNo}</span>
          <h2>{item.title}</h2>
        </div>
        <StatusBadge status={item.status} />
      </header>
      <div className="rectification-detail-actions">
        <button onClick={onEdit}>编辑事项</button>
        <select value={item.status} onChange={(event) => onUpdateStatus(event.target.value)}>
          {RECTIFICATION_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
        </select>
        <button className="ghost" onClick={onCopySummary}>复制事项摘要</button>
      </div>
      <dl>
        <InfoRow label="项目" value={item.project} />
        <InfoRow label="责任部门" value={item.responsibleDepartment} />
        <InfoRow label="分类 / 内容" value={`${item.watermarkCategory || '-'} / ${item.workContent || '-'}`} />
        <InfoRow label="位置 / 区域" value={item.location} />
        <InfoRow label="问题描述" value={item.description} />
        <InfoRow label="整改要求" value={item.requirement} />
        <InfoRow label="截止日期" value={item.deadline} />
        <InfoRow label="处理人" value={item.owner || '-'} />
        <InfoRow label="关键词" value={(item.keywords || []).join('、') || '-'} />
        <InfoRow label="备注" value={item.remark || '-'} />
        <InfoRow label="创建时间" value={formatDateTime(item.createdAt)} />
        <InfoRow label="更新时间" value={formatDateTime(item.updatedAt)} />
        {item.closedAt ? <InfoRow label="关闭时间" value={formatDateTime(item.closedAt)} /> : null}
        {item.closeNote ? <InfoRow label="关闭说明" value={item.closeNote} /> : null}
      </dl>
      {PHOTO_STAGES.map((stage) => (
        <PhotoGroup
          key={stage.key}
          title={stage.label}
          photos={item.photos?.[stage.key] || []}
          onAdd={() => onAddPhotos(stage.key)}
          onOpenPhoto={onOpenPhoto}
          onShowPhoto={onShowPhoto}
        />
      ))}
    </div>
  );
}

function PhotoStageEditor({ photos = {}, onAddPhotos }) {
  return (
    <div className="rectification-photo-editor">
      {PHOTO_STAGES.map((stage) => (
        <section key={stage.key}>
          <header>
            <strong>{stage.label}</strong>
            <button className="ghost" onClick={() => onAddPhotos(stage.key)}>添加照片</button>
          </header>
          <p>{photos?.[stage.key]?.length || 0} 张。仅记录路径，不复制、不移动、不删除照片。</p>
        </section>
      ))}
    </div>
  );
}

function PhotoGroup({ title, photos, onAdd, onOpenPhoto, onShowPhoto }) {
  return (
    <section className="rectification-photo-group">
      <header>
        <strong>{title}（{photos.length}）</strong>
        <button className="ghost" onClick={onAdd}>添加</button>
      </header>
      {photos.length === 0 ? <p className="maintenance-muted">暂未关联照片。</p> : (
        <div className="rectification-photo-grid">
          {photos.map((photo) => (
            <article key={photo.id || photo.filePath}>
              {photo.fileExists ? <img src={`local-photo://image/${encodeURIComponent(photo.filePath)}`} alt="" /> : <div className="missing-photo">文件缺失</div>}
              <strong title={photo.fileName}>{photo.fileName}</strong>
              <span>{photo.sourceType} · {photo.fileExists ? '文件存在' : '文件缺失'}</span>
              <footer>
                <button className="ghost" onClick={() => onOpenPhoto(photo)} disabled={!photo.fileExists}>打开</button>
                <button className="ghost" onClick={() => onShowPhoto(photo)} disabled={!photo.fileExists}>所在目录</button>
              </footer>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function LedgerPickerDialog({ archiveRoot, setArchiveRoot, filters, setFilters, records, allRecords, selectedIds, onToggle, onChooseArchiveRoot, onLoadLedger, onCreate, onClose }) {
  function updateFilter(key, value) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  return (
    <div className="archive-confirm-backdrop">
      <section className="archive-confirm-dialog rectification-ledger-dialog">
        <header>
          <h2>从归档记录创建整改事项</h2>
          <button className="ghost" onClick={onClose}>关闭</button>
        </header>
        <div className="rectification-ledger-toolbar">
          <label className="wide">
            <span>归档根目录</span>
            <input value={archiveRoot} onChange={(event) => setArchiveRoot(event.target.value)} />
          </label>
          <button className="ghost" onClick={onChooseArchiveRoot}>选择目录</button>
          <button onClick={onLoadLedger}>加载台账</button>
          <SelectField label="项目" value={filters.project} onChange={(value) => updateFilter('project', value)} options={unique(allRecords.map((record) => record.project))} />
          <SelectField label="分类" value={filters.category} onChange={(value) => updateFilter('category', value)} options={unique(allRecords.map((record) => record.watermarkCategory))} />
          <SelectField label="工作内容" value={filters.workContent} onChange={(value) => updateFilter('workContent', value)} options={unique(allRecords.map((record) => record.workContent))} />
          <label>
            <span>开始日期</span>
            <input type="date" value={filters.startDate} onChange={(event) => updateFilter('startDate', event.target.value)} />
          </label>
          <label>
            <span>结束日期</span>
            <input type="date" value={filters.endDate} onChange={(event) => updateFilter('endDate', event.target.value)} />
          </label>
          <label className="wide">
            <span>搜索</span>
            <input value={filters.keyword} onChange={(event) => updateFilter('keyword', event.target.value)} placeholder="项目、分类、工作内容、文件名、关键词" />
          </label>
        </div>
        <div className="rectification-ledger-list">
          {records.length === 0 ? <div className="empty-state">暂无归档记录，请先加载台账或调整筛选条件。</div> : records.map((record) => (
            <label key={record.id} className="rectification-ledger-row">
              <input
                type="checkbox"
                checked={selectedIds.has(record.id)}
                onChange={(event) => onToggle(record.id, event.target.checked)}
              />
              <span title={record.newFileName || record.originalName}>{record.newFileName || record.originalName}</span>
              <small>{record.project || '-'} / {record.watermarkCategory || '-'} / {record.workContent || '-'}</small>
              <b className={record.fileExists ? 'exists' : 'missing'}>{record.fileExists ? '文件存在' : '文件缺失'}</b>
            </label>
          ))}
        </div>
        <footer className="archive-confirm-actions">
          <button className="ghost" onClick={onClose}>返回</button>
          <button onClick={onCreate}>创建整改事项（{selectedIds.size}）</button>
        </footer>
      </section>
    </div>
  );
}

function SelectField({ label, value, onChange, options }) {
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

function FormSelect({ label, value, onChange, options }) {
  return (
    <label>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">请选择</option>
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  );
}

function FormInput({ label, value, onChange, type = 'text', wide = false }) {
  return (
    <label className={wide ? 'wide' : ''}>
      <span>{label}</span>
      <input type={type} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function FormTextarea({ label, value, onChange }) {
  return (
    <label className="wide">
      <span>{label}</span>
      <textarea value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function InfoRow({ label, value }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd title={String(value || '')}>{value}</dd>
    </div>
  );
}

function StatusBadge({ status }) {
  const statusClass = {
    待整改: 'pending',
    整改中: 'doing',
    已完成: 'done',
    已关闭: 'closed'
  }[status] || 'pending';
  return <span className={`rectification-status ${statusClass}`}>{status}</span>;
}

function Stat({ label, value, warning, active, onClick }) {
  return (
    <button type="button" className={`${warning ? 'warning' : ''} ${active ? 'active' : ''}`} onClick={onClick}>
      <span>{label}</span>
      <strong>{value}</strong>
    </button>
  );
}

function matchesFilters(item, filters) {
  if (filters.project && item.project !== filters.project) return false;
  if (filters.department && item.responsibleDepartment !== filters.department) return false;
  if (filters.status && item.status !== filters.status) return false;
  if (filters.overdueOnly && !isOverdue(item)) return false;
  if (filters.deadlineStart && item.deadline < filters.deadlineStart) return false;
  if (filters.deadlineEnd && item.deadline > filters.deadlineEnd) return false;
  const keyword = filters.keyword.trim().toLowerCase();
  if (keyword) {
    const haystack = [
      item.rectificationNo,
      item.project,
      item.responsibleDepartment,
      item.location,
      item.title,
      item.description,
      item.requirement,
      item.owner,
      item.remark,
      ...(item.keywords || [])
    ].join(' ').toLowerCase();
    if (!haystack.includes(keyword)) return false;
  }
  return true;
}

function matchesLedgerFilters(record, filters) {
  if (filters.project && record.project !== filters.project) return false;
  if (filters.category && record.watermarkCategory !== filters.category) return false;
  if (filters.workContent && record.workContent !== filters.workContent) return false;
  const recordDate = normalizeDateInput(record.date || record.archiveDate || record.createdAt);
  if (filters.startDate && recordDate && recordDate < filters.startDate) return false;
  if (filters.endDate && recordDate && recordDate > filters.endDate) return false;
  const keyword = filters.keyword.trim().toLowerCase();
  if (keyword) {
    const haystack = [
      record.project,
      record.department,
      record.watermarkCategory,
      record.workContent,
      record.location,
      record.keywords,
      record.newFileName,
      record.originalName,
      record.remark
    ].join(' ').toLowerCase();
    if (!haystack.includes(keyword)) return false;
  }
  return true;
}

function normalizeConfigOptions(configs) {
  return {
    projects: normalizeOptionList(configs?.projects),
    departments: normalizeOptionList(configs?.departments),
    watermarkCategories: Object.keys(configs?.watermarkCategories || {}),
    keywords: normalizeOptionList(configs?.keywords)
  };
}

function normalizeOptionList(values) {
  if (!Array.isArray(values)) return [];
  return values.map((item) => {
    if (typeof item === 'string') return item;
    return item.name || item.label || item.value || '';
  }).filter(Boolean);
}

function getWorkContentOptions(configs, watermarkCategory) {
  if (!watermarkCategory) return [];
  const category = configs?.watermarkCategories?.[watermarkCategory];
  if (!category) return [];
  return normalizeOptionList(category.items || []);
}

function unique(values) {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function splitKeywords(text) {
  return String(text || '').split(/[、，,;\s]+/).map((item) => item.trim()).filter(Boolean);
}

function photoCount(item) {
  return (item.photos?.before?.length || 0) + (item.photos?.during?.length || 0) + (item.photos?.after?.length || 0);
}

function isOverdue(item) {
  if (!item.deadline || ['已完成', '已关闭'].includes(item.status)) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(item.deadline).getTime() < today.getTime();
}

function buildSummary(item) {
  return [
    `整改编号：${item.rectificationNo}`,
    `项目：${item.project}`,
    `责任部门：${item.responsibleDepartment}`,
    `问题位置：${item.location}`,
    `问题标题：${item.title}`,
    `问题描述：${item.description}`,
    `整改要求：${item.requirement}`,
    `截止日期：${item.deadline}`,
    `当前状态：${item.status}`,
    `整改前/中/后照片：${item.photos?.before?.length || 0}/${item.photos?.during?.length || 0}/${item.photos?.after?.length || 0}`,
    `跟进人：${item.owner || '-'}`
  ].join('\n');
}

function normalizeDateInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatDate(value) {
  return normalizeDateInput(value);
}

function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
