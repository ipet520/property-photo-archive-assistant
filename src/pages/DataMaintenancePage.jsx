import { useEffect, useMemo, useState } from 'react';
import { APP_VERSION, PAGE_KEYS } from '../constants/app.js';

const SECTIONS = [
  { key: 'overview', label: '总览' },
  { key: 'config', label: '配置状态' },
  { key: 'directories', label: '目录状态' },
  { key: 'ledger', label: '台账状态' },
  { key: 'sortProgress', label: '分拣进度' },
  { key: 'packages', label: '资料包记录' },
  { key: 'suggestions', label: '维护建议' }
];

const STATUS_LABELS = {
  normal: '正常',
  warning: '提醒',
  error: '异常',
  unset: '未配置',
  info: '提示',
  success: '正常'
};

export default function DataMaintenancePage({ onNavigate }) {
  const [activeSection, setActiveSection] = useState('overview');
  const [report, setReport] = useState(null);
  const [status, setStatus] = useState({ type: 'idle', text: '数据维护中心已就绪。' });
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    loadReport();
  }, []);

  const sectionTitle = useMemo(() => SECTIONS.find((item) => item.key === activeSection)?.label || '总览', [activeSection]);

  async function loadReport() {
    setIsLoading(true);
    try {
      const result = await window.archiveAssistant.getDataMaintenanceReport();
      setReport(result);
      setStatus({ type: 'success', text: `检查完成：${formatDateTime(result.checkedAt)}。` });
    } catch (error) {
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
          <span>当前版本 {APP_VERSION}</span>
          <button onClick={loadReport} disabled={isLoading}>{isLoading ? '检查中...' : '重新检查'}</button>
        </div>
      </section>

      <div className={`archive-query-status ${status.type}`}>{status.text}</div>
      <div className="maintenance-safety-note">安全边界：本页只读取状态并提供打开目录、复制路径、跳转页面，不删除、不移动、不修改任何照片、台账、配置或资料包。</div>

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

          {!report ? (
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
        <button type="button" onClick={() => onNavigate({ page: PAGE_KEYS.settings, action: 'settings-default-paths' })}>设置默认目录</button>
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
          ['启用部门', `${configStatus.stats.enabledDepartments} 个`],
          ['启用水印分类', `${configStatus.stats.enabledCategories} 个`],
          ['启用工作内容', `${configStatus.stats.enabledWorkItems} 个`],
          ['启用关键词', `${configStatus.stats.enabledKeywords} 个`],
          ['启用常见场景', `${configStatus.stats.enabledScenes} 个`]
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
      <Distribution title="水印分类分布" items={ledger.categoryTop} />
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
          ['疑似资料包数量', `${packageStatus.packageCount} 个`],
          ['最近资料包', packageStatus.latestPackage || '暂无'],
          ['最近生成时间', formatDateTime(packageStatus.latestTime) || '暂无']
        ]}
      />
      <ActionRow
        label="默认资料包导出目录"
        value={packageStatus.root || '未配置'}
        status={packageStatus.status}
        description={packageStatus.message}
        onOpen={() => onOpen(packageStatus.root)}
        onCopy={() => onCopy(packageStatus.root)}
        extraAction={{ label: '生成资料包', onClick: () => onNavigate({ page: PAGE_KEYS.searchCenter, action: 'package' }) }}
      />
      <p className="maintenance-muted">资料包状态只检查默认导出目录的直接子目录，不扫描整盘，也不会删除、移动或压缩资料包。</p>
    </div>
  );
}

function SuggestionSection({ report, onNavigate }) {
  return (
    <div className="maintenance-suggestion-list">
      {report.suggestions.map((suggestion, index) => (
        <article key={`${suggestion.title}-${index}`} className={`maintenance-suggestion ${suggestion.level}`}>
          <StatusBadge status={suggestion.level} />
          <div>
            <strong>{suggestion.title}</strong>
            <p>{suggestion.text}</p>
          </div>
          <button type="button" onClick={() => onNavigate(getSuggestionTarget(suggestion))}>去处理</button>
        </article>
      ))}
    </div>
  );
}

function getDirectoryAction(key, onNavigate) {
  const actions = {
    defaultPhotoFolder: { label: '设置照片目录', action: 'settings-default-paths', settingKey: 'defaultPhotoFolder' },
    defaultArchiveRoot: { label: '设置归档目录', action: 'settings-default-paths', settingKey: 'defaultArchiveRoot' },
    defaultArchivePackageRoot: { label: '设置资料包目录', action: 'settings-default-paths', settingKey: 'defaultArchivePackageRoot' },
    sortDrafts: { label: '打开分拣工作台', action: null },
    configBackup: { label: '管理设置备份', action: 'settings-backup' }
  };
  const target = actions[key] || { label: '打开系统设置', action: 'settings-default-paths' };
  return {
    label: target.label,
    onClick: () => onNavigate(target.action
      ? { page: PAGE_KEYS.settings, action: target.action, payload: { settingKey: target.settingKey || '' } }
      : PAGE_KEYS.sortWorkspace)
  };
}

function getSuggestionTarget(suggestion) {
  const text = `${suggestion.title || ''} ${suggestion.text || ''}`;
  if (text.includes('文件缺失') || text.includes('台账')) return { page: PAGE_KEYS.searchCenter, action: text.includes('文件缺失') ? 'missing-files' : 'load-ledger' };
  if (text.includes('资料包')) return { page: PAGE_KEYS.searchCenter, action: 'package' };
  if (text.includes('整改')) return { page: PAGE_KEYS.rectificationCenter, action: 'load-rectifications' };
  if (text.includes('配置')) return { page: PAGE_KEYS.settings, action: 'settings-base-data' };
  return { page: PAGE_KEYS.settings, action: 'settings-default-paths' };
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

function ActionRow({ label, value, description, status, onOpen, onCopy, extraAction }) {
  return (
    <article className="maintenance-action-row">
      <div>
        <span>{label}</span>
        {status ? <StatusBadge status={status} /> : null}
      </div>
      <strong title={value}>{value}</strong>
      {description ? <p>{description}</p> : null}
      <footer>
        <button className="ghost" onClick={onOpen} disabled={!value || value === '未配置' || value === '未找到台账'}>打开</button>
        <button className="ghost" onClick={onCopy} disabled={!value || value === '未配置' || value === '未找到台账'}>复制路径</button>
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
