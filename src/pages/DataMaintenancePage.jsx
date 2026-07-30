import { useEffect, useMemo, useState } from 'react';
import { PAGE_KEYS, VERSION_SUMMARY } from '../constants/app.js';
import RuntimeLogCenter from '../components/RuntimeLogCenter.jsx';
import { listStagedResults } from '../utils/recognitionClient.js';
import { recordRuntimeLog } from '../utils/runtimeLogger.js';

const SECTIONS = [
  { key: 'overview', label: '总览' },
  { key: 'config', label: '配置状态' },
  { key: 'directories', label: '目录状态' },
  { key: 'ledger', label: '台账状态' },
  { key: 'sortProgress', label: '分拣进度' },
  { key: 'ocrRecords', label: 'OCR 识别记录' },
  { key: 'packages', label: '资料包记录' },
  { key: 'trialIssues', label: '运行日志与问题反馈' },
  { key: 'suggestions', label: '维护建议' }
];

const ISSUE_PAGES = ['首页总览', '照片分拣工作台', '归档记录', '整改闭环中心', '资料汇总中心', '每日服务简报', '数据维护中心', '系统设置', '其它'];
const ISSUE_TYPES = ['界面显示', '按钮状态', '文件目录', '扫描照片', '生成预览', '确认归档', '台账记录', '查询筛选', '删除记录', '打开文件', '数据异常', '操作体验', '其它'];
const ISSUE_IMPACTS = ['轻微', '一般', '严重'];
const ISSUE_STATUSES = ['未处理', '处理中', '已处理', '暂不处理'];

const STATUS_LABELS = {
  normal: '正常',
  warning: '提醒',
  error: '异常',
  unset: '未配置',
  info: '提示',
  success: '正常'
};

export default function DataMaintenancePage({ onNavigate, navigationRequest }) {
  const [activeSection, setActiveSection] = useState('overview');
  const [report, setReport] = useState(null);
  const [status, setStatus] = useState({ type: 'idle', text: '数据维护中心已就绪。' });
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    loadReport();
  }, []);

  useEffect(() => {
    if (navigationRequest?.action === 'openOcrRecords') setActiveSection('ocrRecords');
  }, [navigationRequest?.nonce]);

  const sectionTitle = useMemo(() => SECTIONS.find((item) => item.key === activeSection)?.label || '总览', [activeSection]);

  async function loadReport() {
    setIsLoading(true);
    try {
      const result = await window.archiveAssistant.getDataMaintenanceReport();
      setReport(result);
      setStatus({ type: 'success', text: `检查完成：${formatDateTime(result.checkedAt)}。` });
    } catch (error) {
      recordRuntimeLog({ page: '数据维护中心', operation: '数据维护检查', errorType: '数据维护检查失败', summary: error.message, error });
      setStatus({ type: 'error', text: `数据维护检查失败：${error.message}` });
    } finally {
      setIsLoading(false);
    }
  }

  async function openPath(targetPath) {
    if (!targetPath) {
      setStatus({ type: 'warning', text: '当前没有可打开的路径。' });
      return;
    }
    const result = await window.archiveAssistant.openPath(targetPath);
    setStatus(result.success
      ? { type: 'success', text: '已打开目录或文件。' }
      : { type: 'error', text: result.message || '打开失败。' });
  }

  async function copyPath(targetPath) {
    if (!targetPath) {
      setStatus({ type: 'warning', text: '当前没有可复制的路径。' });
      return;
    }
    await window.archiveAssistant.copyText(targetPath);
    setStatus({ type: 'success', text: '路径已复制。' });
  }

  return (
    <div className="data-maintenance-page">
      <section className="page-hero compact">
        <div>
          <p className="eyebrow">数据维护中心</p>
          <h1>本地数据健康检查</h1>
          <p>只读检查配置、目录、台账、分拣草稿和资料包目录状态，帮助确认当前数据是否可用。</p>
        </div>
        <div className="maintenance-hero-actions">
          <span>{VERSION_SUMMARY}</span>
          <button onClick={loadReport} disabled={isLoading}>{isLoading ? '检查中...' : '重新检查'}</button>
        </div>
      </section>

      <div className={`archive-query-status ${status.type}`}>{status.text}</div>
      <div className="maintenance-safety-note">安全边界：维护检查仍为只读；仅“运行日志与问题反馈”会读写独立的 trial-issues.json，不删除、不移动、不修改任何照片、台账、配置、整改数据或资料包。</div>

      <section className="maintenance-layout">
        <aside className="maintenance-nav">
          {SECTIONS.map((section) => (
            <button
              key={section.key}
              className={activeSection === section.key ? 'active' : ''}
              onClick={() => setActiveSection(section.key)}
            >
              {section.label}
            </button>
          ))}
        </aside>

        <main className="maintenance-content panel">
          <header className="maintenance-content-header">
            <div>
              <span>当前模块</span>
              <h2>{sectionTitle}</h2>
            </div>
            <small>最近检查：{formatDateTime(report?.checkedAt) || '尚未完成'}</small>
          </header>

          {activeSection === 'trialIssues' ? (
            <RuntimeLogCenter />
          ) : activeSection === 'ocrRecords' ? (
            <OcrRecordsSection
              initialKeyword={navigationRequest?.action === 'openOcrRecords' ? navigationRequest.payload?.keyword : ''}
              initialRecordId={navigationRequest?.action === 'openOcrRecords' ? navigationRequest.payload?.recordId : ''}
            />
          ) : !report ? (
            <div className="empty-state">{isLoading ? '正在读取本地维护状态...' : '暂无维护状态，请点击重新检查。'}</div>
          ) : (
            <>
              {activeSection === 'overview' && <OverviewSection report={report} onNavigate={onNavigate} />}
              {activeSection === 'config' && (
                <ConfigSection
                  report={report}
                  onOpen={openPath}
                  onCopy={copyPath}
                  onNavigate={onNavigate}
                />
              )}
              {activeSection === 'directories' && (
                <DirectoriesSection
                  report={report}
                  onOpen={openPath}
                  onCopy={copyPath}
                  onNavigate={onNavigate}
                />
              )}
              {activeSection === 'ledger' && (
                <LedgerSection
                  report={report}
                  onOpen={openPath}
                  onCopy={copyPath}
                  onNavigate={onNavigate}
                />
              )}
              {activeSection === 'sortProgress' && (
                <SortProgressSection
                  report={report}
                  onOpen={openPath}
                  onCopy={copyPath}
                  onNavigate={onNavigate}
                />
              )}
              {activeSection === 'packages' && (
                <PackageSection
                  report={report}
                  onOpen={openPath}
                  onCopy={copyPath}
                  onNavigate={onNavigate}
                />
              )}
              {activeSection === 'suggestions' && <SuggestionSection report={report} onNavigate={onNavigate} />}
            </>
          )}
        </main>
      </section>
    </div>
  );
}

function OcrRecordsSection({ initialKeyword = '', initialRecordId = '' }) {
  const [records, setRecords] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [keyword, setKeyword] = useState(initialKeyword);
  const [notice, setNotice] = useState({ type: 'idle', text: '正在读取后台 OCR 识别记录...' });
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    loadRecords();
  }, []);

  useEffect(() => {
    setKeyword(initialKeyword || '');
  }, [initialKeyword]);

  useEffect(() => {
    if (initialRecordId) setSelectedId(initialRecordId);
  }, [initialRecordId]);

  const filteredRecords = useMemo(() => {
    const normalizedKeyword = keyword.trim().toLowerCase();
    if (!normalizedKeyword) return records;
    return records.filter((record) => (
      (initialRecordId && record.id === initialRecordId)
      || [
        record.id,
        record.fileName,
        record.providerId,
        record.ocrEngine,
        record.recognitionStatus,
        record.stageStatus,
        record.rawText
      ].some((value) => String(value || '').toLowerCase().includes(normalizedKeyword))
    ));
  }, [initialRecordId, keyword, records]);

  const selectedRecord = useMemo(
    () => filteredRecords.find((record) => record.id === selectedId) || filteredRecords[0] || null,
    [filteredRecords, selectedId]
  );

  async function loadRecords() {
    setIsLoading(true);
    try {
      const nextRecords = await listStagedResults({ limit: 1000 });
      setRecords(nextRecords);
      setSelectedId((current) => {
        if (initialRecordId && nextRecords.some((record) => record.id === initialRecordId)) return initialRecordId;
        return nextRecords.some((record) => record.id === current) ? current : (nextRecords[0]?.id || '');
      });
      setNotice({ type: 'success', text: `已读取 ${nextRecords.length} 条后台 OCR 识别记录。` });
    } catch (error) {
      setNotice({ type: 'error', text: `OCR 识别记录读取失败：${error.message}` });
      void recordRuntimeLog({ page: '数据维护中心', operation: '读取 OCR 识别记录', errorType: 'OCR 识别', summary: error.message, error });
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="ocr-record-center">
      <header className="ocr-record-heading">
        <div>
          <h3>OCR 识别记录</h3>
          <p>查询本机识别暂存数据；原始照片不会在此处被删除、移动或修改。</p>
        </div>
        <button type="button" onClick={loadRecords} disabled={isLoading}>{isLoading ? '读取中...' : '刷新记录'}</button>
      </header>
      <div className={`archive-query-status ${notice.type}`}>{notice.text}</div>
      <div className="ocr-record-toolbar">
        <label>
          <span>搜索记录</span>
          <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="照片名、状态、引擎或 OCR 文字" />
        </label>
        <span>显示 {filteredRecords.length} / {records.length}</span>
      </div>
      <div className="ocr-record-layout">
        <div className="maintenance-table-wrap">
          <table className="maintenance-table ocr-record-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>照片</th>
                <th>识别状态</th>
                <th>暂存状态</th>
                <th>引擎</th>
                <th>文字数</th>
              </tr>
            </thead>
            <tbody>
              {filteredRecords.map((record) => (
                <tr key={record.id} className={selectedRecord?.id === record.id ? 'selected' : ''} onClick={() => setSelectedId(record.id)}>
                  <td>{formatDateTime(record.createdAt)}</td>
                  <td title={record.fileName}>{record.fileName || '未命名照片'}</td>
                  <td>{formatRecognitionStatus(record.recognitionStatus)}</td>
                  <td>{formatStageStatus(record.stageStatus)}</td>
                  <td>{record.ocrEngine || record.providerId || '-'}</td>
                  <td>{String(record.rawText || '').length}</td>
                </tr>
              ))}
              {filteredRecords.length === 0 && <tr><td colSpan="6" className="maintenance-empty">暂无可查询的 OCR 识别记录</td></tr>}
            </tbody>
          </table>
        </div>
        <aside className="ocr-record-detail">
          {selectedRecord ? (
            <>
              <header>
                <div>
                  <span>记录详情</span>
                  <h3 title={selectedRecord.fileName}>{selectedRecord.fileName || '未命名照片'}</h3>
                </div>
                <button type="button" onClick={() => window.archiveAssistant.copyText(selectedRecord.rawText || '')} disabled={!selectedRecord.rawText}>复制原文</button>
              </header>
              <dl>
                <div><dt>识别状态</dt><dd>{formatRecognitionStatus(selectedRecord.recognitionStatus)}</dd></div>
                <div><dt>Provider</dt><dd>{selectedRecord.providerId || '-'}</dd></div>
                <div><dt>引擎来源</dt><dd>{selectedRecord.engineSource || '-'}</dd></div>
                <div><dt>组件版本</dt><dd>{selectedRecord.componentVersion || '历史记录未标注'}</dd></div>
                <div><dt>耗时</dt><dd>{Number.isFinite(selectedRecord.durationMs) ? `${selectedRecord.durationMs} ms` : '-'}</dd></div>
                <div><dt>文字置信度</dt><dd>{formatRecognitionConfidence(selectedRecord.confidence)}</dd></div>
              </dl>
              <section>
                <h4>OCR 原文</h4>
                <pre>{selectedRecord.rawText || '未识别到有效文字。'}</pre>
              </section>
              {(selectedRecord.errors || []).length > 0 && (
                <section>
                  <h4>错误信息</h4>
                  <pre>{selectedRecord.errors.map((error) => error.message || String(error)).join('\n')}</pre>
                </section>
              )}
            </>
          ) : (
            <div className="empty-state">请选择一条 OCR 识别记录查看详情。</div>
          )}
        </aside>
      </div>
    </div>
  );
}

function formatRecognitionStatus(value = '') {
  return {
    success: '识别成功',
    empty: '未检测到水印文字',
    failed: '识别失败',
    error: '识别异常',
    disabled: '已禁用',
    provider_unavailable: '引擎不可用'
  }[value] || value || '待确认';
}

function formatStageStatus(value = '') {
  return {
    staged: '已暂存',
    pending_review: '待复核',
    reviewed: '已复核',
    superseded: '已被重新识别替代',
    dismissed: '已忽略',
    cleared: '已清除',
    expired: '已过期'
  }[value] || value || '-';
}

function formatRecognitionConfidence(value) {
  if (value === null || value === undefined || value === '') return '未记录';
  const confidence = Number(value);
  if (!Number.isFinite(confidence) || confidence <= 0) return '未记录';
  return `${Math.round(Math.min(confidence, 1) * 100)}%`;
}

function OverviewSection({ report, onNavigate }) {
  return (
    <div className="maintenance-overview-stack">
      <div className="maintenance-overview-grid">
        {report.overview.map((item) => (
          <article key={item.key} className="maintenance-card">
            <div>
              <span>{item.label}</span>
              <StatusBadge status={item.status} />
            </div>
            <strong title={item.summary}>{item.summary}</strong>
          </article>
        ))}
      </div>
      <div className="maintenance-direct-actions">
        <button type="button" onClick={() => onNavigate({ page: PAGE_KEYS.searchCenter, action: 'load-ledger' })}>核对归档台账</button>
        <button type="button" onClick={() => onNavigate({ page: PAGE_KEYS.searchCenter, action: 'package' })}>生成资料包</button>
        <button type="button" onClick={() => onNavigate({ page: PAGE_KEYS.rectificationCenter, action: 'load-rectifications' })}>查看整改事项数据</button>
        <button type="button" onClick={() => onNavigate({ page: PAGE_KEYS.sortWorkspace })}>管理照片来源</button>
      </div>
    </div>
  );
}

function ConfigSection({ report, onOpen, onCopy, onNavigate }) {
  const { configStatus } = report;
  return (
    <div className="maintenance-section-stack">
      <SummaryGrid
        items={[
          ['配置文件状态', configStatus.summary],
          ['配置模块数量', `${configStatus.files.length} 个`],
          ['启用项目', `${configStatus.stats.enabledProjects} 个`],
          ['启用责任部门', `${configStatus.stats.enabledDepartments} 个`],
          ['启用归档分类', `${configStatus.stats.enabledCategories} 个`],
          ['启用工作内容', `${configStatus.stats.enabledWorkItems} 个`],
          ['启用关键词', `${configStatus.stats.enabledKeywords} 个`]
        ]}
      />
      <ActionRow
        label="配置目录"
        value={configStatus.paths.userConfigDir}
        onOpen={() => onOpen(configStatus.paths.userConfigDir)}
        onCopy={() => onCopy(configStatus.paths.userConfigDir)}
        extraAction={{ label: '管理基础数据', onClick: () => onNavigate({ page: PAGE_KEYS.settings, action: 'settings-base-data' }) }}
      />
      <div className="maintenance-table-wrap">
        <table className="maintenance-table">
          <thead>
            <tr>
              <th>配置文件</th>
              <th>来源</th>
              <th>记录数</th>
              <th>状态</th>
              <th>路径</th>
            </tr>
          </thead>
          <tbody>
            {configStatus.files.map((file) => (
              <tr key={file.key}>
                <td>{file.fileName}</td>
                <td>{file.source}</td>
                <td>{file.itemCount}</td>
                <td><StatusBadge status={file.status} /></td>
                <td className="maintenance-path" title={file.path}>{file.path}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DirectoriesSection({ report, onOpen, onCopy, onNavigate }) {
  return (
    <div className="maintenance-section-stack">
      {report.directoryStatus.items.map((item) => (
        <ActionRow
          key={item.key}
          label={item.label}
          value={item.path || '未配置'}
          status={item.status}
          description={`${item.message} · 来源：${item.source}`}
          onOpen={() => onOpen(item.path)}
          onCopy={() => onCopy(item.path)}
          canOpen={Boolean(item.exists && item.readable)}
          canCopy={Boolean(item.exists && item.readable)}
          extraAction={getDirectoryAction(item.key, onNavigate)}
        />
      ))}
    </div>
  );
}

function LedgerSection({ report, onOpen, onCopy, onNavigate }) {
  const ledger = report.ledgerStatus;
  return (
    <div className="maintenance-section-stack">
      <SummaryGrid
        items={[
          ['记录总数', `${ledger.total} 条`],
          ['文件存在', `${ledger.existsCount} 条`],
          ['文件缺失', `${ledger.missingCount} 条`],
          ['路径缺失', `${ledger.missingPathCount} 条`],
          ['最近归档日期', ledger.latestDate || '暂无'],
          ['涉及项目', `${ledger.projectCount} 个`],
          ['涉及分类', `${ledger.categoryCount} 个`]
        ]}
      />
      <ActionRow
        label="照片归档台账"
        value={ledger.ledgerPath || '未找到台账'}
        status={ledger.status}
        description={ledger.message}
        onOpen={() => onOpen(ledger.ledgerPath || ledger.archiveRoot)}
        onCopy={() => onCopy(ledger.ledgerPath || ledger.archiveRoot)}
        extraAction={{ label: '加载归档台账', onClick: () => onNavigate({ page: PAGE_KEYS.searchCenter, action: 'load-ledger' }) }}
      />
      <Distribution title="项目分布" items={ledger.projectTop} />
      <Distribution title="归档分类分布" items={ledger.categoryTop} />
    </div>
  );
}

function SortProgressSection({ report, onOpen, onCopy, onNavigate }) {
  const progress = report.sortProgressStatus;
  return (
    <div className="maintenance-section-stack">
      <SummaryGrid
        items={[
          ['草稿文件数', `${progress.count} 个`],
          ['最近草稿', progress.latestFile || '暂无'],
          ['最近保存时间', formatDateTime(progress.latestTime) || '暂无'],
          ['较早草稿', `${progress.staleCount} 个`]
        ]}
      />
      <ActionRow
        label="分拣进度保存目录"
        value={progress.draftsDir}
        status={progress.status}
        description={progress.message}
        onOpen={() => onOpen(progress.draftsDir)}
        onCopy={() => onCopy(progress.draftsDir)}
        canOpen={Boolean(progress.directoryExists && progress.directoryReadable)}
        canCopy={Boolean(progress.directoryExists && progress.directoryReadable)}
        extraAction={{ label: '恢复分拣进度', onClick: () => onNavigate(PAGE_KEYS.sortWorkspace) }}
      />
      <p className="maintenance-muted">分拣草稿由用户手动保存和加载。本页仅检查本地草稿目录与文件数量，不会自动恢复、修改或清理草稿。</p>
    </div>
  );
}

function PackageSection({ report, onOpen, onCopy, onNavigate }) {
  const packageStatus = report.packageStatus;
  return (
    <div className="maintenance-section-stack">
      <SummaryGrid
        items={[
          ['管理方式', '按当前项目管理'],
          ['检查状态', packageStatus.message],
          ['业务入口', '归档记录']
        ]}
      />
      <ActionRow
        label="项目资料包输出目录"
        value="请在归档记录页查看当前项目目录"
        status={packageStatus.status}
        description={packageStatus.message}
        onOpen={() => {}}
        onCopy={() => {}}
        canOpen={false}
        canCopy={false}
        extraAction={{ label: '管理并生成资料包', onClick: () => onNavigate({ page: PAGE_KEYS.searchCenter, action: 'package' }) }}
      />
      <p className="maintenance-muted">资料包输出目录由归档记录页按当前项目管理；本页不读取或自动采用旧全局目录。</p>
    </div>
  );
}

function TrialIssuesSection() {
  const [items, setItems] = useState([]);
  const [paths, setPaths] = useState(null);
  const [filters, setFilters] = useState({ page: '', type: '', impact: '', status: '', keyword: '' });
  const [form, setForm] = useState(null);
  const [notice, setNotice] = useState({ type: 'idle', text: '正在读取试运行问题记录...' });
  const [isBusy, setIsBusy] = useState(false);
  const [exportFormat, setExportFormat] = useState('xlsx');

  useEffect(() => {
    loadItems();
  }, []);

  const filteredItems = useMemo(() => items.filter((item) => {
    if (filters.page && item.page !== filters.page) return false;
    if (filters.type && item.type !== filters.type) return false;
    if (filters.impact && item.impact !== filters.impact) return false;
    if (filters.status && item.status !== filters.status) return false;
    const keyword = filters.keyword.trim().toLowerCase();
    if (keyword && !`${item.description} ${item.handlingNote}`.toLowerCase().includes(keyword)) return false;
    return true;
  }), [items, filters]);

  const stats = useMemo(() => ({
    total: filteredItems.length,
    pending: filteredItems.filter((item) => item.status === '未处理').length,
    processing: filteredItems.filter((item) => item.status === '处理中').length,
    completed: filteredItems.filter((item) => item.status === '已处理').length,
    severe: filteredItems.filter((item) => item.impact === '严重').length
  }), [filteredItems]);

  async function loadItems() {
    setIsBusy(true);
    try {
      const result = await window.archiveAssistant.loadTrialIssues();
      setItems(result.items || []);
      setPaths(result.paths || null);
      setNotice({ type: 'success', text: `已加载 ${result.items?.length || 0} 条试运行问题记录。` });
    } catch (error) {
      setNotice({
        type: 'error',
        text: `问题：试运行问题记录读取失败，数据文件可能损坏。处理：请先备份当前数据文件，再联系维护人员检查 trial-issues.json。${error?.message ? ` 详情：${error.message}` : ''}`
      });
    } finally {
      setIsBusy(false);
    }
  }

  function startCreate() {
    setForm(createEmptyIssue());
  }

  function startEdit(item) {
    setForm({ ...item, issueTime: toDateTimeInput(item.issueTime) });
  }

  function updateForm(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function saveItem() {
    if (!form?.description?.trim()) {
      setNotice({ type: 'error', text: '问题描述不能为空。' });
      return;
    }
    setIsBusy(true);
    try {
      const result = await window.archiveAssistant.saveTrialIssue({
        ...form,
        issueTime: String(form.issueTime || '').replace('T', ' ')
      });
      setItems(result.items || []);
      setPaths(result.paths || paths);
      setForm(null);
      setNotice({ type: 'success', text: '问题记录已保存。' });
    } catch (error) {
      setNotice({ type: 'error', text: `问题：试运行问题记录保存失败，${error?.message || '本地数据文件无法写入'}。处理：请检查数据目录权限和磁盘空间后重试。` });
    } finally {
      setIsBusy(false);
    }
  }

  async function removeItem(item) {
    if (!window.confirm('确定要删除这条试运行问题记录吗？删除后不可恢复。')) return;
    setIsBusy(true);
    try {
      const result = await window.archiveAssistant.deleteTrialIssue(item.id);
      setItems(result.items || []);
      setPaths(result.paths || paths);
      if (form?.id === item.id) setForm(null);
      setNotice({ type: 'success', text: '试运行问题记录已删除。' });
    } catch (error) {
      setNotice({ type: 'error', text: `问题：试运行问题记录删除失败，${error?.message || '记录未能删除'}。处理：请重新加载记录并检查数据目录权限后重试。` });
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
        ? { type: 'success', text: `试运行问题记录已导出：${result.filePath}` }
        : { type: 'error', text: `问题：试运行问题记录导出失败，${result?.message || '未生成导出文件'}。处理：请选择可写目录后重试。` });
    } catch (error) {
      setNotice({ type: 'error', text: `问题：试运行问题记录导出失败，${error?.message || '未生成导出文件'}。处理：请检查目标目录权限后重试。` });
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <div className="trial-issues-section">
      <header className="trial-issues-heading">
        <div>
          <h3>试运行问题记录</h3>
          <p>记录软件试用期间发现的问题、影响程度、处理状态和修复备注，便于后续版本跟进。</p>
          {paths?.dataFile && <small title={paths.dataFile}>数据文件：{paths.dataFile}</small>}
        </div>
        <div>
          <button type="button" className="primary orange" onClick={startCreate} disabled={isBusy}>新增问题</button>
          <select value={exportFormat} onChange={(event) => setExportFormat(event.target.value)} aria-label="导出格式">
            <option value="xlsx">Excel</option>
            <option value="csv">CSV</option>
          </select>
          <button type="button" onClick={exportItems} disabled={isBusy || filteredItems.length === 0}>导出记录</button>
        </div>
      </header>

      <div className={`archive-query-status ${notice.type}`}>{notice.text}</div>

      <div className="trial-issue-stats">
        <TrialStat label="记录总数" value={stats.total} />
        <TrialStat label="未处理" value={stats.pending} tone="pending" />
        <TrialStat label="处理中" value={stats.processing} tone="processing" />
        <TrialStat label="已处理" value={stats.completed} tone="completed" />
        <TrialStat label="严重问题" value={stats.severe} tone="severe" />
      </div>

      <div className="trial-issue-filters">
        <TrialSelect label="问题页面" value={filters.page} options={ISSUE_PAGES} onChange={(value) => setFilters((current) => ({ ...current, page: value }))} />
        <TrialSelect label="问题类型" value={filters.type} options={ISSUE_TYPES} onChange={(value) => setFilters((current) => ({ ...current, type: value }))} />
        <TrialSelect label="影响程度" value={filters.impact} options={ISSUE_IMPACTS} onChange={(value) => setFilters((current) => ({ ...current, impact: value }))} />
        <TrialSelect label="处理状态" value={filters.status} options={ISSUE_STATUSES} onChange={(value) => setFilters((current) => ({ ...current, status: value }))} />
        <label className="wide"><span>关键词搜索</span><input value={filters.keyword} placeholder="搜索问题描述或处理备注" onChange={(event) => setFilters((current) => ({ ...current, keyword: event.target.value }))} /></label>
      </div>

      {form && (
        <section className="trial-issue-form">
          <header><h3>{form.id ? '编辑问题记录' : '新增问题记录'}</h3></header>
          <div className="trial-issue-form-grid">
            <label><span>问题时间</span><input type="datetime-local" value={form.issueTime} onChange={(event) => updateForm('issueTime', event.target.value)} /></label>
            <TrialSelect label="问题页面" value={form.page} options={ISSUE_PAGES} includeAll={false} onChange={(value) => updateForm('page', value)} />
            <TrialSelect label="问题类型" value={form.type} options={ISSUE_TYPES} includeAll={false} onChange={(value) => updateForm('type', value)} />
            <TrialSelect label="影响程度" value={form.impact} options={ISSUE_IMPACTS} includeAll={false} onChange={(value) => updateForm('impact', value)} />
            <TrialSelect label="处理状态" value={form.status} options={ISSUE_STATUSES} includeAll={false} onChange={(value) => updateForm('status', value)} />
            <label className="wide"><span>问题描述 *</span><textarea value={form.description} onChange={(event) => updateForm('description', event.target.value)} /></label>
            <label className="wide"><span>处理备注</span><textarea value={form.handlingNote} onChange={(event) => updateForm('handlingNote', event.target.value)} /></label>
          </div>
          <footer><button type="button" onClick={() => setForm(null)} disabled={isBusy}>取消</button><button type="button" className="primary orange" onClick={saveItem} disabled={isBusy}>保存记录</button></footer>
        </section>
      )}

      <div className="trial-issue-table-wrap">
        <table className="trial-issue-table">
          <thead><tr><th>问题时间</th><th>问题页面</th><th>问题类型</th><th>影响程度</th><th>处理状态</th><th>问题描述</th><th>处理备注</th><th>操作</th></tr></thead>
          <tbody>
            {filteredItems.map((item) => (
              <tr key={item.id}>
                <td>{formatDateTime(item.issueTime)}</td><td>{item.page}</td><td>{item.type}</td>
                <td><span className={`trial-tag impact-${impactTone(item.impact)}`}>{item.impact}</span></td>
                <td><span className={`trial-tag status-${statusTone(item.status)}`}>{item.status}</span></td>
                <td><span className="trial-two-line" title={item.description}>{item.description}</span></td>
                <td><span className="trial-two-line" title={item.handlingNote}>{item.handlingNote || '-'}</span></td>
                <td><div className="trial-row-actions"><button type="button" onClick={() => startEdit(item)}>编辑</button><button type="button" className="danger" onClick={() => removeItem(item)}>删除</button></div></td>
              </tr>
            ))}
            {filteredItems.length === 0 && <tr><td colSpan="8" className="maintenance-empty">暂无试运行问题记录</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TrialStat({ label, value, tone = '' }) {
  return <article className={tone}><span>{label}</span><strong>{value}</strong></article>;
}

function TrialSelect({ label, value, options, onChange, includeAll = true }) {
  return <label><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}>{includeAll && <option value="">全部</option>}{options.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>;
}

function createEmptyIssue() {
  return { id: '', issueTime: toDateTimeInput(new Date()), page: '首页总览', type: '界面显示', impact: '一般', status: '未处理', description: '', handlingNote: '', createdAt: '', updatedAt: '' };
}

function toDateTimeInput(value) {
  const date = value instanceof Date ? value : new Date(String(value || '').replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return String(value || '').slice(0, 16).replace(' ', 'T');
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function impactTone(value) {
  return { 轻微: 'minor', 一般: 'normal', 严重: 'severe' }[value] || 'normal';
}

function statusTone(value) {
  return { 未处理: 'pending', 处理中: 'processing', 已处理: 'completed', 暂不处理: 'deferred' }[value] || 'pending';
}

function SuggestionSection({ report, onNavigate }) {
  const suggestions = getVisibleSuggestions(report);
  return (
    <div className="maintenance-suggestion-list">
      {suggestions.map((suggestion, index) => {
        const target = getSuggestionTarget(suggestion);
        return (
          <article key={`${suggestion.title}-${index}`} className={`maintenance-suggestion ${suggestion.level}`}>
            <StatusBadge status={suggestion.level} />
            <div>
              <strong>{suggestion.title}</strong>
              <p>{suggestion.text}</p>
            </div>
            {target ? <button type="button" onClick={() => onNavigate(target)}>去处理</button> : null}
          </article>
        );
      })}
    </div>
  );
}

function getDirectoryAction(key, onNavigate) {
  const actions = {
    defaultPhotoFolder: { label: '管理项目照片来源', page: PAGE_KEYS.sortWorkspace },
    defaultArchiveRoot: { label: '管理项目归档目录', action: 'load-ledger', page: PAGE_KEYS.searchCenter },
    defaultArchivePackageRoot: { label: '管理资料包目录', action: 'load-ledger', page: PAGE_KEYS.searchCenter },
    sortDrafts: { label: '打开分拣工作台', page: PAGE_KEYS.sortWorkspace },
    configBackup: { label: '前往备份设置', action: 'settings-backup', page: PAGE_KEYS.settings }
  };
  const target = actions[key] || { label: '打开系统设置', action: 'settings-base-data', page: PAGE_KEYS.settings };
  return {
    label: target.label,
    onClick: () => onNavigate(target.action
      ? { page: target.page, action: target.action }
      : target.page)
  };
}

function getSuggestionTarget(suggestion) {
  const actionTargets = {
    'settings-base-data': { page: PAGE_KEYS.settings, action: 'settings-base-data' },
    'settings-default-paths': { page: PAGE_KEYS.sortWorkspace },
    'settings-default-photo': { page: PAGE_KEYS.sortWorkspace },
    'settings-default-archive': { page: PAGE_KEYS.searchCenter, action: 'load-ledger' },
    'settings-package': { page: PAGE_KEYS.searchCenter, action: 'load-ledger' },
    'settings-backup': { page: PAGE_KEYS.settings, action: 'settings-backup' },
    'sort-workspace': PAGE_KEYS.sortWorkspace,
    ledger: { page: PAGE_KEYS.searchCenter, action: 'load-ledger' },
    'missing-files': { page: PAGE_KEYS.searchCenter, action: 'missing-files' }
  };
  if (suggestion.action && actionTargets[suggestion.action]) return actionTargets[suggestion.action];
  if (suggestion.level === 'success') return null;
  const text = `${suggestion.title || ''} ${suggestion.text || ''}`;
  if (text.includes('资料包导出目录')) return { page: PAGE_KEYS.searchCenter, action: 'load-ledger' };
  if (text.includes('默认照片') || text.includes('照片导入目录')) return { page: PAGE_KEYS.sortWorkspace };
  if (text.includes('归档根目录')) return { page: PAGE_KEYS.searchCenter, action: 'load-ledger' };
  if (text.includes('设置备份') || text.includes('配置备份')) return { page: PAGE_KEYS.settings, action: 'settings-backup' };
  if (text.includes('配置')) return { page: PAGE_KEYS.settings, action: 'settings-base-data' };
  if (text.includes('文件缺失') || text.includes('台账')) return { page: PAGE_KEYS.searchCenter, action: text.includes('文件缺失') ? 'missing-files' : 'load-ledger' };
  if (text.includes('整改')) return { page: PAGE_KEYS.rectificationCenter, action: 'load-rectifications' };
  if (text.includes('资料包')) return { page: PAGE_KEYS.reportCenter, action: 'load-summary' };
  if (text.includes('分拣草稿') || text.includes('分拣进度')) return { page: PAGE_KEYS.sortWorkspace };
  return { page: PAGE_KEYS.sortWorkspace };
}

function getVisibleSuggestions(report) {
  const suggestions = report.suggestions || [];
  if (suggestions.length > 0) return suggestions;
  return [{
    level: 'success',
    title: '当前未发现明显维护风险',
    text: '配置、目录、台账和资料包状态暂未发现异常。建议定期进入本页刷新检查。'
  }];
}

function SummaryGrid({ items }) {
  return (
    <div className="maintenance-summary-grid">
      {items.map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <strong title={value}>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function ActionRow({ label, value, description, status, onOpen, onCopy, canOpen = true, canCopy = true, extraAction }) {
  return (
    <article className="maintenance-action-row">
      <div>
        <span>{label}</span>
        {status ? <StatusBadge status={status} /> : null}
      </div>
      <strong title={value}>{value}</strong>
      {description ? <p>{description}</p> : null}
      <footer>
        <button className="ghost" onClick={onOpen} disabled={!canOpen || !value || value === '未配置' || value === '未找到台账'}>打开</button>
        <button className="ghost" onClick={onCopy} disabled={!canCopy || !value || value === '未配置' || value === '未找到台账'}>复制路径</button>
        {extraAction ? <button className="ghost" onClick={extraAction.onClick}>{extraAction.label}</button> : null}
      </footer>
    </article>
  );
}

function Distribution({ title, items = [] }) {
  return (
    <section className="maintenance-distribution">
      <h3>{title}</h3>
      {items.length === 0 ? (
        <p className="maintenance-muted">暂无可统计数据。</p>
      ) : (
        items.map((item) => (
          <div key={item.name}>
            <span title={item.name}>{item.name}</span>
            <strong>{item.count}</strong>
          </div>
        ))
      )}
    </section>
  );
}

function StatusBadge({ status }) {
  return <span className={`maintenance-status ${status || 'info'}`}>{STATUS_LABELS[status] || '提示'}</span>;
}

function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
