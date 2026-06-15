import { useEffect, useMemo, useState } from 'react';
import ConfigManager from '../components/ConfigManager.jsx';
import { APP_NAME, APP_VERSION } from '../constants/app.js';

const SETTING_TABS = [
  { key: 'baseData', label: '基础数据' },
  { key: 'defaultPaths', label: '默认目录' },
  { key: 'packageSettings', label: '资料包设置' },
  { key: 'backup', label: '设置备份与恢复' },
  { key: 'systemInfo', label: '系统信息' }
];

const PACKAGE_GROUPING_OPTIONS = [
  { value: 'project/category/workContent', label: '项目 / 水印分类 / 工作内容' },
  { value: 'category/workContent', label: '水印分类 / 工作内容' },
  { value: 'project/workContent', label: '项目 / 工作内容' },
  { value: 'date/category', label: '日期 / 水印分类' },
  { value: 'none', label: '不分组' }
];

export default function SettingsPage({ archiveState }) {
  const [activeTab, setActiveTab] = useState('baseData');
  const [settings, setSettings] = useState(archiveState.settings || null);
  const [message, setMessage] = useState({ type: 'idle', text: '系统设置已就绪。' });
  const appPaths = archiveState.appPaths || {};
  const configPaths = archiveState.configPaths || {};

  useEffect(() => {
    window.archiveAssistant.loadSettings()
      .then((loaded) => setSettings(loaded))
      .catch((error) => setMessage({ type: 'error', text: `设置加载失败：${error.message}` }));
  }, []);

  const pathRows = useMemo(() => ([
    { key: 'defaultPhotoFolder', label: '默认照片导入目录', value: settings?.defaultPhotoFolder || '' },
    { key: 'defaultArchiveRoot', label: '默认归档根目录', value: settings?.defaultArchiveRoot || '' },
    { key: 'defaultArchivePackageRoot', label: '默认资料包导出目录', value: settings?.defaultArchivePackageRoot || '' }
  ]), [settings]);

  function updateSettings(patch) {
    setSettings((current) => ({ ...(current || {}), ...patch }));
  }

  function updatePackageSettings(patch) {
    setSettings((current) => ({
      ...(current || {}),
      archivePackageSettings: {
        ...(current?.archivePackageSettings || {}),
        ...patch
      }
    }));
  }

  async function saveSettings() {
    try {
      const saved = await window.archiveAssistant.saveSettings(settings);
      setSettings(saved);
      setMessage({ type: 'success', text: '系统设置已保存到本地。' });
    } catch (error) {
      setMessage({ type: 'error', text: `保存失败：${error.message}` });
    }
  }

  async function choosePath(key) {
    const selected = key === 'defaultPhotoFolder'
      ? await window.archiveAssistant.selectPhotoFolder()
      : await window.archiveAssistant.selectArchiveRoot();
    if (!selected) return;
    updateSettings({ [key]: selected });
    setMessage({ type: 'idle', text: '目录已选择，请点击“保存设置”写入本地。' });
  }

  async function openDirectory(pathValue) {
    if (!pathValue) return;
    await window.archiveAssistant.openPath(pathValue);
  }

  async function copyText(text, label = '内容') {
    if (!text) return;
    const result = await window.archiveAssistant.copyText(text);
    setMessage(result?.success
      ? { type: 'success', text: `${label}已复制。` }
      : { type: 'error', text: `${label}复制失败。` });
  }

  async function exportConfigs() {
    try {
      const result = await window.archiveAssistant.exportConfigs();
      if (result?.canceled) return;
      setMessage({ type: 'success', text: `设置已导出：${result.filePath}` });
    } catch (error) {
      setMessage({ type: 'error', text: `导出失败：${error.message}` });
    }
  }

  async function importConfigs() {
    if (!window.confirm('导入设置将覆盖当前系统基础配置，是否继续？')) return;
    try {
      const result = await window.archiveAssistant.importConfigs();
      if (result?.canceled) return;
      await archiveState.handleConfigsSaved(result.runtimeConfigs);
      setMessage({ type: 'success', text: '设置已导入，主界面配置已刷新。' });
    } catch (error) {
      setMessage({ type: 'error', text: `导入失败：${error.message}` });
    }
  }

  async function backupConfigs() {
    try {
      const result = await window.archiveAssistant.backupConfigs();
      setMessage({ type: 'success', text: `已生成设置备份：${result.backupFile}` });
    } catch (error) {
      setMessage({ type: 'error', text: `备份失败：${error.message}` });
    }
  }

  async function resetConfigs() {
    if (!window.confirm('恢复默认配置会先备份当前配置，再覆盖基础数据配置。是否继续？')) return;
    try {
      const result = await window.archiveAssistant.resetConfigsToDefault();
      await archiveState.handleConfigsSaved(result.runtimeConfigs);
      setMessage({ type: 'success', text: '已恢复默认配置，主界面配置已刷新。' });
    } catch (error) {
      setMessage({ type: 'error', text: `恢复默认失败：${error.message}` });
    }
  }

  return (
    <div className="settings-center-page">
      <section className="page-hero compact">
        <div>
          <p className="eyebrow">系统设置</p>
          <h1>系统设置</h1>
          <p>统一维护基础数据、默认目录、资料包设置、设置备份与恢复、系统信息等本地配置。</p>
        </div>
        <button className="primary" type="button" onClick={saveSettings} disabled={!settings}>保存设置</button>
      </section>

      <div className={`config-message ${message.type}`}>{message.text}</div>
      <div className="settings-impact-note">
        基础数据会影响快速归档和照片分拣的下拉选项；关键词库和常见场景会影响分拣工作台辅助填写；默认目录会影响快速归档、分拣工作台、归档记录和资料包导出；资料包设置会影响后续资料包默认选项。历史台账和已归档照片不会因为设置修改而改变。
      </div>

      <section className="settings-center-layout">
        <nav className="settings-center-nav">
          {SETTING_TABS.map((tab) => (
            <button
              type="button"
              key={tab.key}
              className={activeTab === tab.key ? 'active' : ''}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <main className="settings-center-content panel">
          {activeTab === 'baseData' && (
            <div className="settings-module">
              <header>
                <p className="eyebrow">基础数据</p>
                <h2>项目、部门、来源、分类、工作内容、关键词和常见场景</h2>
                <p>这里复用现有配置管理能力，支持新增、编辑、停用、排序、导入导出和恢复默认。</p>
              </header>
              <ConfigManager open embedded onClose={() => {}} onSaved={archiveState.handleConfigsSaved} />
            </div>
          )}

          {activeTab === 'defaultPaths' && (
            <div className="settings-module">
              <header>
                <p className="eyebrow">默认目录</p>
                <h2>常用目录与路径记忆</h2>
                <p>目录不存在时不会崩溃，对应页面会继续提示重新选择。</p>
              </header>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={settings?.rememberLastPaths !== false}
                  onChange={(event) => updateSettings({ rememberLastPaths: event.target.checked })}
                />
                启动时尽量记住并恢复上次目录
              </label>
              <div className="settings-path-list">
                {pathRows.map((row) => (
                  <article className="settings-path-row" key={row.key}>
                    <div>
                      <span>{row.label}</span>
                      <strong title={row.value}>{row.value || '未设置'}</strong>
                    </div>
                    <button type="button" onClick={() => choosePath(row.key)}>选择目录</button>
                    <button type="button" onClick={() => updateSettings({ [row.key]: '' })} disabled={!row.value}>清空</button>
                    <button type="button" onClick={() => openDirectory(row.value)} disabled={!row.value}>打开</button>
                  </article>
                ))}
              </div>
              <div className="recent-path-grid">
                <RecentPathList title="最近照片文件夹" items={settings?.recentPhotoFolders || []} onClear={() => updateSettings({ recentPhotoFolders: [] })} />
                <RecentPathList title="最近归档根目录" items={settings?.recentArchiveRoots || []} onClear={() => updateSettings({ recentArchiveRoots: [] })} />
              </div>
            </div>
          )}

          {activeTab === 'packageSettings' && (
            <div className="settings-module">
              <header>
                <p className="eyebrow">资料包设置</p>
                <h2>资料包导出的默认偏好</h2>
                <p>这些设置为后续资料包导出提供默认值；缺失时仍使用安全默认值，不影响 V1.5.0 已有资料包生成功能。</p>
              </header>
              <div className="settings-form-grid">
                <label>
                  <span>默认资料包分组规则</span>
                  <select
                    value={settings?.archivePackageSettings?.groupingRule || 'project/category/workContent'}
                    onChange={(event) => updatePackageSettings({ groupingRule: event.target.value })}
                  >
                    {PACKAGE_GROUPING_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
                <label>
                  <span>资料包名称前缀</span>
                  <input
                    value={settings?.archivePackageSettings?.packageNamePrefix || '物业照片资料包'}
                    onChange={(event) => updatePackageSettings({ packageNamePrefix: event.target.value })}
                  />
                </label>
              </div>
              <div className="settings-check-grid">
                <CheckField label="生成资料包说明 txt" checked={settings?.archivePackageSettings?.generateReadme !== false} onChange={(value) => updatePackageSettings({ generateReadme: value })} />
                <CheckField label="生成资料目录 Excel" checked={settings?.archivePackageSettings?.generateCatalog !== false} onChange={(value) => updatePackageSettings({ generateCatalog: value })} />
                <CheckField label="生成完成后提示打开资料包" checked={settings?.archivePackageSettings?.promptOpenAfterGenerated !== false} onChange={(value) => updatePackageSettings({ promptOpenAfterGenerated: value })} />
              </div>
            </div>
          )}

          {activeTab === 'backup' && (
            <div className="settings-module">
              <header>
                <p className="eyebrow">设置备份与恢复</p>
                <h2>导出、导入、备份与恢复默认</h2>
                <p>只处理基础配置和设置数据，不导出照片、不导出台账、不导出资料包文件。</p>
              </header>
              <div className="settings-action-grid">
                <button type="button" onClick={backupConfigs}>立即备份当前配置</button>
                <button type="button" onClick={exportConfigs}>导出设置 JSON</button>
                <button type="button" onClick={importConfigs}>导入设置 JSON</button>
                <button type="button" className="danger" onClick={resetConfigs}>恢复默认配置</button>
              </div>
              <div className="settings-info-list">
                <InfoRow label="用户配置目录" value={configPaths.userConfigDir} onCopy={copyText} onOpen={openDirectory} />
                <InfoRow label="配置备份目录" value={configPaths.backupDir} onCopy={copyText} onOpen={openDirectory} />
                <InfoRow label="settings.json" value={settings?.settingsPath} onCopy={copyText} onOpen={(value) => openDirectory(parentDir(value))} />
              </div>
            </div>
          )}

          {activeTab === 'systemInfo' && (
            <div className="settings-module">
              <header>
                <p className="eyebrow">系统信息</p>
                <h2>运行环境与数据保护说明</h2>
                <p>以下信息只读，可用于排查路径和备份位置。</p>
              </header>
              <div className="settings-info-list">
                <InfoRow label="软件名称" value={APP_NAME} onCopy={copyText} />
                <InfoRow label="当前版本" value={APP_VERSION} onCopy={copyText} />
                <InfoRow label="当前运行环境" value={import.meta.env.DEV ? '开发环境' : '打包环境'} onCopy={copyText} />
                <InfoRow label="配置文件位置" value={configPaths.userConfigDir} onCopy={copyText} onOpen={openDirectory} />
                <InfoRow label="分拣进度保存位置" value="用户选择的本地 JSON 文件；默认建议保存到本地文档目录。" onCopy={copyText} />
                <InfoRow label="是否为打包版" value={import.meta.env.DEV ? '否' : '是'} onCopy={copyText} />
                <InfoRow label="运行数据目录" value={appPaths.userData} onCopy={copyText} onOpen={openDirectory} />
              </div>
              <div className="settings-protection-note">
                本软件仅在本机处理照片与台账数据，不会自动上传文件。归档和资料包导出操作均以复制为主，不移动、不删除、不压缩原始照片。
              </div>
            </div>
          )}
        </main>
      </section>
    </div>
  );
}

function RecentPathList({ title, items, onClear }) {
  return (
    <div className="recent-path-card">
      <div className="config-row-actions">
        <h3>{title}</h3>
        <button className="mini-button" type="button" onClick={onClear}>清空</button>
      </div>
      {items.length === 0 ? <p className="muted">暂无记录。</p> : items.map((item) => <small key={item} title={item}>{item}</small>)}
    </div>
  );
}

function CheckField({ label, checked, onChange }) {
  return (
    <label className="settings-toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}

function InfoRow({ label, value, onCopy, onOpen }) {
  return (
    <article className="settings-info-row">
      <span>{label}</span>
      <strong title={value || '-'}>{value || '-'}</strong>
      {onCopy && <button type="button" onClick={() => onCopy(value, label)} disabled={!value}>复制</button>}
      {onOpen && <button type="button" onClick={() => onOpen(value)} disabled={!value}>打开</button>}
    </article>
  );
}

function parentDir(filePath) {
  if (!filePath) return '';
  return String(filePath).replace(/[\\/][^\\/]*$/, '');
}
