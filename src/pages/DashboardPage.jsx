import { useCallback, useEffect, useState } from 'react';
import { APP_NAME, APP_VERSION, PAGE_KEYS } from '../constants/app.js';

const QUICK_ENTRIES = [
  { key: PAGE_KEYS.quickArchive, marker: '归', title: '快速批量归档', text: '同一批照片使用同一套信息时快速归档。' },
  { key: PAGE_KEYS.sortWorkspace, marker: '拣', title: '照片分拣工作台', text: '整理混合照片，分组套用归档信息。' },
  { key: PAGE_KEYS.searchCenter, marker: '查', title: '归档记录', text: '查询、核对历史照片并导出筛选结果。' },
  { key: PAGE_KEYS.reportCenter, marker: '汇', title: '资料汇总中心', text: '按项目、部门、分类和整改状态汇总资料。' },
  { key: PAGE_KEYS.rectificationCenter, marker: '改', title: '整改闭环中心', text: '建立整改事项，关联整改前中后照片。' },
  { key: PAGE_KEYS.dataMaintenance, marker: '维', title: '数据维护中心', text: '只读检查配置、目录、台账和本地进度。' },
  { key: PAGE_KEYS.settings, marker: '设', title: '系统设置', text: '维护基础数据、默认目录和资料包偏好。' }
];

export default function DashboardPage({ archiveState, onNavigate }) {
  const [data, setData] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [notice, setNotice] = useState({ type: 'idle', text: '正在加载首页数据…' });

  const refreshDashboard = useCallback(async () => {
    setIsLoading(true);
    setNotice((current) => ({ type: 'loading', text: current.text || '正在加载首页数据…' }));
    try {
      const result = await window.archiveAssistant.loadDashboardData();
      setData(result);
      const errorCount = Object.values(result?.errors || {}).filter(Boolean).length;
      setNotice({
        type: errorCount ? 'warning' : 'success',
        text: errorCount ? '首页部分数据读取失败，已保留可用内容。' : `首页数据已更新：${formatDateTime(result.loadedAt)}`
      });
    } catch (error) {
      setNotice({ type: 'error', text: `首页数据读取失败：${error.message}` });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshDashboard();
  }, [refreshDashboard]);

  const settings = data?.settings || archiveState.settings || {};
  const archiveRoot = data?.archiveRoot || settings.defaultArchiveRoot || settings.lastArchiveRoot || '';
  const archiveMetrics = data?.archiveMetrics || emptyArchiveMetrics;
  const rectificationMetrics = data?.rectificationMetrics || emptyRectificationMetrics;

  return (
    <div className="dashboard-page">
      <section className="dashboard-hero">
        <div className="dashboard-hero-copy">
          <p className="eyebrow">首页总览</p>
          <h1>今天的物业照片工作，从这里开始</h1>
          <p>{APP_NAME} · V{APP_VERSION}，集中管理照片归档、查询、整改闭环、资料汇总与资料包导出。</p>
          <div className="dashboard-current-root">
            <span>当前归档根目录</span>
            <strong title={archiveRoot}>{archiveRoot || '暂未设置归档根目录，请到系统设置中配置。'}</strong>
          </div>
        </div>
        <div className="dashboard-hero-actions">
          <div className="dashboard-date"><span>今日</span><strong>{formatCurrentDate()}</strong></div>
          <button type="button" className="primary-button" onClick={refreshDashboard} disabled={isLoading}>{isLoading ? '正在刷新…' : '刷新首页数据'}</button>
          <button type="button" className="secondary-button" onClick={() => onNavigate(PAGE_KEYS.settings)}>打开系统设置</button>
        </div>
      </section>

      <section className="dashboard-section">
        <SectionHeader eyebrow="常用功能" title="快速进入工作模块" hint="不打开新窗口，直接切换到对应页面。" />
        <div className="dashboard-entry-grid">
          {QUICK_ENTRIES.map((entry) => (
            <button type="button" className="dashboard-entry-card" key={entry.key} onClick={() => onNavigate(entry.key)}>
              <span className="dashboard-entry-marker">{entry.marker}</span>
              <span className="dashboard-entry-copy"><strong>{entry.title}</strong><small>{entry.text}</small></span>
              <span className="dashboard-entry-arrow">进入</span>
            </button>
          ))}
        </div>
      </section>

      <div className="dashboard-two-column">
        <section className="dashboard-section dashboard-overview-panel">
          <SectionHeader eyebrow="归档数据" title="工作数据总览" hint={archiveMetrics.message} actions={(
            <><button type="button" className="text-button" onClick={() => onNavigate(PAGE_KEYS.searchCenter)}>查看归档记录</button><button type="button" className="text-button" onClick={() => onNavigate(PAGE_KEYS.reportCenter)}>打开资料汇总</button></>
          )} />
          <div className="dashboard-metric-grid archive">
            <MetricCard label="归档照片总数" value={archiveMetrics.total} tone="primary" />
            <MetricCard label="文件存在" value={archiveMetrics.existsCount} tone="success" />
            <MetricCard label="文件缺失" value={archiveMetrics.missingCount} tone={archiveMetrics.missingCount ? 'warning' : 'neutral'} />
            <MetricCard label="涉及项目" value={archiveMetrics.projectCount} />
            <MetricCard label="水印分类" value={archiveMetrics.categoryCount} />
            <MetricCard label="最近归档日期" value={archiveMetrics.latestDate || '-'} compact />
          </div>
          {!isLoading && archiveMetrics.total === 0 ? <EmptyState text="当前暂无归档数据。完成一次快速归档或照片分拣归档后，首页将显示统计信息。" /> : null}
        </section>

        <section className="dashboard-section dashboard-rectification-panel">
          <SectionHeader eyebrow="整改闭环" title="整改事项概览" hint="逾期仅按截止日期只读判断，不自动修改事项状态。" actions={<button type="button" className="text-button" onClick={() => onNavigate(PAGE_KEYS.rectificationCenter)}>查看整改闭环中心</button>} />
          <div className="dashboard-metric-grid rectification">
            <MetricCard label="事项总数" value={rectificationMetrics.total} tone="primary" />
            <MetricCard label="待整改" value={rectificationMetrics.pendingCount} />
            <MetricCard label="整改中" value={rectificationMetrics.doingCount} />
            <MetricCard label="已完成" value={rectificationMetrics.doneCount} tone="success" />
            <MetricCard label="已关闭" value={rectificationMetrics.closedCount} />
            <MetricCard label="已逾期" value={rectificationMetrics.overdueCount} tone={rectificationMetrics.overdueCount ? 'warning' : 'neutral'} />
          </div>
          {!isLoading && rectificationMetrics.total === 0 ? <EmptyState text="当前暂无整改事项，可在整改闭环中心新建事项。" /> : null}
        </section>
      </div>

      <div className="dashboard-two-column activity">
        <section className="dashboard-section">
          <SectionHeader eyebrow="工作动态" title="最近归档记录" hint="最多显示 5 条，只读展示。" />
          <RecentArchiveList records={data?.recentArchiveRecords || []} loading={isLoading} onOpen={() => onNavigate(PAGE_KEYS.searchCenter)} />
        </section>
        <section className="dashboard-section">
          <SectionHeader eyebrow="工作动态" title="最近整改事项" hint="按最近更新时间显示。" />
          <RecentRectificationList items={data?.recentRectificationItems || []} loading={isLoading} onOpen={() => onNavigate(PAGE_KEYS.rectificationCenter)} />
        </section>
      </div>

      <div className="dashboard-lower-grid">
        <section className="dashboard-section">
          <SectionHeader eyebrow="数据健康" title="需要关注的提醒" hint="仅提示风险，不自动修复或清理。" />
          <HealthAlerts alerts={data?.healthAlerts || []} loading={isLoading} onNavigate={onNavigate} />
        </section>
        <section className="dashboard-section">
          <SectionHeader eyebrow="本地状态" title="当前目录与系统状态" hint={`版本 ${APP_VERSION}`} />
          <SystemStatusList status={data?.systemStatus} onNavigate={onNavigate} />
        </section>
      </div>

      <div className={`dashboard-notice ${notice.type}`} role="status">
        <span>{notice.text}</span>
        <small>{data?.safetyNotice || '首页只读，不会修改任何业务数据。'}</small>
      </div>
    </div>
  );
}

function SectionHeader({ eyebrow, title, hint, actions }) {
  return <header className="dashboard-section-header"><div><p>{eyebrow}</p><h2>{title}</h2>{hint ? <small>{hint}</small> : null}</div>{actions ? <div className="dashboard-section-actions">{actions}</div> : null}</header>;
}

function MetricCard({ label, value, tone = 'neutral', compact = false }) {
  return <article className={`dashboard-metric ${tone} ${compact ? 'compact' : ''}`}><span>{label}</span><strong title={String(value)}>{value}</strong></article>;
}

function RecentArchiveList({ records, loading, onOpen }) {
  if (loading && records.length === 0) return <LoadingRows />;
  if (records.length === 0) return <EmptyState text="暂无最近归档记录。" />;
  return <div className="dashboard-activity-list">{records.map((record) => <button type="button" key={record.id} onClick={onOpen}><span><strong>{record.project || '未填写项目'}</strong><small>{record.watermarkCategory || '未分类'} · {record.workContent || '未填写工作内容'}</small></span><span><b>{record.archivedAt || record.date || '-'}</b><small title={record.newFileName}>{record.newFileName || '未记录文件名'}</small></span></button>)}</div>;
}

function RecentRectificationList({ items, loading, onOpen }) {
  if (loading && items.length === 0) return <LoadingRows />;
  if (items.length === 0) return <EmptyState text="暂无最近整改事项。" />;
  return <div className="dashboard-activity-list">{items.map((item) => <button type="button" key={item.id} onClick={onOpen}><span><strong>{item.rectificationNo || '未编号'} · {item.project || '未填写项目'}</strong><small>{item.title || '未填写问题标题'}</small></span><span><b className={`dashboard-status-tag ${statusTone(item.status)}`}>{item.status || '待整改'}</b><small>{formatDateTime(item.updatedAt || item.createdAt)}</small></span></button>)}</div>;
}

function HealthAlerts({ alerts, loading, onNavigate }) {
  if (loading && alerts.length === 0) return <LoadingRows count={3} />;
  if (alerts.length === 0) return <div className="dashboard-health-ok"><span>✓</span><strong>当前暂无明显数据异常</strong><small>目录、台账与配置仍建议定期在数据维护中心检查。</small></div>;
  return <div className="dashboard-alert-list">{alerts.map((alert) => <article className={alert.level} key={alert.title}><span className="dashboard-alert-dot" /><div><strong>{alert.title}</strong><p>{alert.text}</p></div>{alert.targetPage ? <button type="button" onClick={() => onNavigate(alert.targetPage)}>去查看</button> : null}</article>)}</div>;
}

function SystemStatusList({ status, onNavigate }) {
  const rows = [
    ['当前照片导入目录', status?.photoFolder, status?.photoFolderStatus],
    ['当前归档根目录', status?.archiveRoot, status?.archiveRootStatus],
    ['默认资料包导出目录', status?.packageRoot, status?.packageRootStatus],
    ['整改事项数据', status?.rectificationPath, status?.rectificationStatus],
    ['分拣进度', status?.sortDraftPath, status?.sortDraftStatus],
    ['配置文件', status?.configPath, status?.configStatus]
  ];

  async function copyPath(value) {
    if (value) await window.archiveAssistant.copyText(value);
  }

  async function openPath(value) {
    if (value) await window.archiveAssistant.openPath(value);
  }

  return <div className="dashboard-system-list">{rows.map(([label, value, description]) => <article key={label}><div><span>{label}</span><strong title={value || description}>{value || description || '未配置'}</strong></div><div className="dashboard-path-actions"><button type="button" disabled={!value} onClick={() => copyPath(value)}>复制</button><button type="button" disabled={!value} onClick={() => openPath(value)}>打开</button></div></article>)}<footer><button type="button" onClick={() => onNavigate(PAGE_KEYS.settings)}>系统设置</button><button type="button" onClick={() => onNavigate(PAGE_KEYS.dataMaintenance)}>数据维护中心</button></footer></div>;
}

function EmptyState({ text }) {
  return <div className="dashboard-empty">{text}</div>;
}

function LoadingRows({ count = 4 }) {
  return <div className="dashboard-loading" aria-label="正在加载">{Array.from({ length: count }, (_, index) => <span key={index} />)}</div>;
}

function statusTone(status) {
  return { 待整改: 'pending', 整改中: 'doing', 已完成: 'done', 已关闭: 'closed' }[status] || 'pending';
}

function formatCurrentDate() {
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }).format(new Date());
}

function formatDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

const emptyArchiveMetrics = { total: 0, existsCount: 0, missingCount: 0, projectCount: 0, categoryCount: 0, latestDate: '', message: '正在读取归档台账…' };
const emptyRectificationMetrics = { total: 0, pendingCount: 0, doingCount: 0, doneCount: 0, closedCount: 0, overdueCount: 0 };
