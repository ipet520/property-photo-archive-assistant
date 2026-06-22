import { useEffect, useState } from 'react';

const CONFIG_TABS = [
  { key: 'projects', label: '项目管理', type: 'simple', defaultable: true },
  { key: 'departments', label: '部门管理', type: 'simple', defaultable: true },
  { key: 'photoSources', label: '照片来源', type: 'simple' },
  { key: 'watermarkCategories', label: '水印分类与工作内容', type: 'watermark' },
  { key: 'photoStages', label: '照片阶段', type: 'simple', defaultable: true },
  { key: 'processStatuses', label: '处理状态', type: 'simple', defaultable: true },
  { key: 'keywords', label: '关键词', type: 'keywords' },
  { key: 'sceneExamples', label: '常见场景', type: 'scenes' },
  { key: 'backup', label: '配置备份/导入导出', type: 'backup' }
];

const CONFIG_LABELS = Object.fromEntries(CONFIG_TABS.map((tab) => [tab.key, tab.label]));

export default function ConfigManager({ open, embedded = false, onClose, onSaved }) {
  const [activeTab, setActiveTab] = useState('projects');
  const [configs, setConfigs] = useState(null);
  const [paths, setPaths] = useState(null);
  const [selectedCategoryId, setSelectedCategoryId] = useState('');
  const [message, setMessage] = useState({ type: 'idle', text: '' });
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    loadConfigs();
  }, [open]);

  useEffect(() => {
    if (!configs?.watermarkCategories?.length) return;
    if (!selectedCategoryId || !configs.watermarkCategories.some((item) => item.id === selectedCategoryId)) {
      setSelectedCategoryId(configs.watermarkCategories[0].id);
    }
  }, [configs, selectedCategoryId]);

  if (!open) return null;

  async function loadConfigs() {
    try {
      const result = await window.archiveAssistant.loadUserConfigs();
      setConfigs(result.editableConfigs);
      setPaths(result.paths);
      setMessage({ type: 'success', text: '配置已加载。' });
    } catch (error) {
      setMessage({ type: 'error', text: `配置加载失败：${error.message}` });
    }
  }

  function updateConfig(key, updater) {
    setConfigs((current) => ({
      ...current,
      [key]: typeof updater === 'function' ? updater(current[key]) : updater
    }));
  }

  async function saveAll() {
    setIsSaving(true);
    try {
      const result = await window.archiveAssistant.saveAllUserConfigs(configs);
      setConfigs(result.editableConfigs);
      setPaths(result.paths);
      await onSaved(result.runtimeConfigs);
      setMessage({ type: 'success', text: '配置已保存，主界面已刷新。' });
    } catch (error) {
      setMessage({ type: 'error', text: `保存失败：${error.message}` });
    } finally {
      setIsSaving(false);
    }
  }

  async function resetToDefault() {
    if (!window.confirm('确认恢复默认配置？当前自定义配置会先自动备份。')) return;
    setIsSaving(true);
    try {
      const result = await window.archiveAssistant.resetConfigsToDefault();
      setConfigs(result.editableConfigs);
      setPaths(result.paths);
      await onSaved(result.runtimeConfigs);
      setMessage({ type: 'success', text: '已恢复默认配置，主界面已刷新。' });
    } catch (error) {
      setMessage({ type: 'error', text: `恢复默认失败：${error.message}` });
    } finally {
      setIsSaving(false);
    }
  }

  async function exportAll() {
    try {
      const result = await window.archiveAssistant.exportConfigs();
      if (result.canceled) return;
      setMessage({ type: 'success', text: `配置已导出：${result.filePath}` });
    } catch (error) {
      setMessage({ type: 'error', text: `导出失败：${error.message}` });
    }
  }

  async function importAll() {
    if (!window.confirm('确认导入配置？导入前会自动备份当前配置。')) return;
    try {
      const result = await window.archiveAssistant.importConfigs();
      if (result.canceled) return;
      setConfigs(result.editableConfigs);
      setPaths(result.paths);
      await onSaved(result.runtimeConfigs);
      setMessage({ type: 'success', text: '配置已导入，主界面已刷新。' });
    } catch (error) {
      setMessage({ type: 'error', text: `导入失败：${error.message}` });
    }
  }

  async function backupNow() {
    try {
      const result = await window.archiveAssistant.backupConfigs();
      setMessage({ type: 'success', text: `已生成配置备份：${result.backupFile}` });
    } catch (error) {
      setMessage({ type: 'error', text: `备份失败：${error.message}` });
    }
  }

  const active = CONFIG_TABS.find((tab) => tab.key === activeTab);

  const content = (
    <section className={`config-manager ${embedded ? 'embedded' : ''}`}>
        <header className="config-header">
          <div>
            <p className="eyebrow">基础数据管理</p>
            <h2>配置数据管理</h2>
            <p>维护项目、部门、分类、关键词和常见场景。暂时不用的配置，建议停用而不是删除。</p>
          </div>
          <div className="config-header-actions">
            <button className="ghost" onClick={loadConfigs} disabled={isSaving}>重新加载</button>
            <button className="primary" onClick={saveAll} disabled={!configs || isSaving}>保存并刷新主界面</button>
            {!embedded && <button className="ghost" onClick={onClose}>关闭</button>}
          </div>
        </header>

        {message.text && <div className={`config-message ${message.type}`}>{message.text}</div>}

        <div className="config-layout">
          <nav className="config-nav">
            {CONFIG_TABS.map((tab) => (
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

          <div className="config-content">
            {!configs ? (
              <p className="muted">正在加载配置...</p>
            ) : active.type === 'simple' ? (
              <SimpleConfigEditor
                title={active.label}
                items={configs[active.key]}
                defaultable={active.defaultable}
                onChange={(items) => updateConfig(active.key, items)}
              />
            ) : active.type === 'keywords' ? (
              <KeywordEditor items={configs.keywords} onChange={(items) => updateConfig('keywords', items)} />
            ) : active.type === 'watermark' ? (
              <WatermarkCategoryEditor
                categories={configs.watermarkCategories}
                selectedCategoryId={selectedCategoryId}
                onSelectCategory={setSelectedCategoryId}
                onChange={(items) => updateConfig('watermarkCategories', items)}
              />
            ) : active.type === 'scenes' ? (
              <SceneEditor
                scenes={configs.sceneExamples}
                configs={configs}
                onChange={(items) => updateConfig('sceneExamples', items)}
              />
            ) : (
              <BackupPanel
                paths={paths}
                onBackup={backupNow}
                onExport={exportAll}
                onImport={importAll}
                onReset={resetToDefault}
              />
            )}
          </div>
        </div>
      </section>
  );

  if (embedded) return content;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      {content}
    </div>
  );
}

function SimpleConfigEditor({ title, items, onChange, defaultable = false }) {
  const nameSize = title === '部门管理' || title === '照片阶段' || title === '处理状态' ? 'short' : 'medium';
  return (
    <ConfigSection title={title} onAdd={() => onChange([...items, createSimpleItem(`新${title}`)])}>
      <EditableTable
        items={items}
        onChange={onChange}
        defaultable={defaultable}
        columns={[
          { key: 'name', label: '名称', type: 'text', size: nameSize },
          { key: 'description', label: '说明', type: 'text', size: 'text' }
        ]}
      />
    </ConfigSection>
  );
}

function KeywordEditor({ items, onChange }) {
  function importKeywords() {
    const value = window.prompt('请输入关键词，多个关键词可用顿号、逗号、空格或换行分隔。');
    if (!value) return;
    const nextNames = value.split(/[、,，;；\s]+/).map((item) => item.trim()).filter(Boolean);
    const existing = new Set(items.map((item) => item.name));
    const nextItems = [
      ...items,
      ...nextNames.filter((name) => !existing.has(name)).map((name) => createSimpleItem(name))
    ];
    onChange(sortItems(nextItems));
  }

  function dedupe() {
    const seen = new Set();
    onChange(items.filter((item) => {
      if (seen.has(item.name)) return false;
      seen.add(item.name);
      return true;
    }));
  }

  return (
    <ConfigSection title="关键词" onAdd={() => onChange([...items, createSimpleItem('新关键词')])}>
      <div className="config-toolbar">
        <button className="ghost" onClick={importKeywords}>批量导入关键词</button>
        <button className="ghost" onClick={dedupe}>关键词去重</button>
      </div>
      <EditableTable
        items={items}
        onChange={onChange}
        columns={[
          { key: 'name', label: '关键词', type: 'text', size: 'medium' },
          { key: 'group', label: '分组', type: 'text', size: 'short' },
          { key: 'description', label: '说明', type: 'text', size: 'text' }
        ]}
      />
    </ConfigSection>
  );
}

function WatermarkCategoryEditor({ categories, selectedCategoryId, onSelectCategory, onChange }) {
  const selectedCategory = categories.find((item) => item.id === selectedCategoryId) || categories[0];

  function updateCategory(categoryId, patch) {
    onChange(categories.map((category) => (
      category.id === categoryId ? { ...category, ...patch } : category
    )));
  }

  function updateWorkItems(items) {
    onChange(categories.map((category) => (
      category.id === selectedCategory.id ? { ...category, items } : category
    )));
  }

  function addCategory() {
    const nextCategory = createCategory('新水印分类');
    onChange([...categories, nextCategory]);
    onSelectCategory(nextCategory.id);
  }

  function deleteCategory(category) {
    const message = category.items?.length
      ? `分类“${category.name}”下还有 ${category.items.length} 个工作内容，删除会一并影响下属工作内容。确认删除？`
      : `确认删除分类“${category.name}”？如果只是暂时不用，建议停用，不建议删除。`;
    if (!window.confirm(message)) return;
    const nextCategories = categories.filter((item) => item.id !== category.id);
    onChange(nextCategories);
    onSelectCategory(nextCategories[0]?.id || '');
  }

  function moveCategory(category, delta) {
    onChange(swapSort(categories, category, delta));
  }

  return (
    <ConfigSection title="水印分类与工作内容" onAdd={addCategory}>
      <div className="watermark-tree-editor">
        <aside className="category-side-list">
          <div className="category-side-title">
            <strong>水印分类</strong>
            <span>工作内容必须归属于某个分类</span>
          </div>
          {sortItems(categories).map((category) => (
            <button
              type="button"
              key={category.id}
              className={`category-side-card ${selectedCategory?.id === category.id ? 'active' : ''} ${category.enabled === false ? 'disabled' : ''}`}
              onClick={() => onSelectCategory(category.id)}
            >
              <strong>{category.name}</strong>
              <small>{category.enabled === false ? '已停用' : '已启用'} · {category.items?.length || 0} 个工作内容</small>
            </button>
          ))}
        </aside>

        <section className="category-detail-panel">
          {!selectedCategory ? (
            <p className="muted">请先新增水印分类。</p>
          ) : (
            <>
              <div className="category-edit-card">
                <div className="config-row-actions">
                  <h3>{selectedCategory.name}</h3>
                  <div className="row-actions">
                    <button className="mini-button" onClick={() => moveCategory(selectedCategory, -1)}>分类上移</button>
                    <button className="mini-button" onClick={() => moveCategory(selectedCategory, 1)}>分类下移</button>
                    <button className="mini-button" onClick={() => updateCategory(selectedCategory.id, { enabled: selectedCategory.enabled === false })}>{selectedCategory.enabled === false ? '启用分类' : '停用分类'}</button>
                    <button className="mini-button danger" onClick={() => deleteCategory(selectedCategory)}>删除分类</button>
                  </div>
                </div>
                <div className="config-form-grid">
                  <Field label="分类名称" value={selectedCategory.name} onChange={(name) => updateCategory(selectedCategory.id, { name })} />
                  <Field label="分类说明" value={selectedCategory.description} onChange={(description) => updateCategory(selectedCategory.id, { description })} wide />
                  <label className="field config-short-field">
                    <span>是否兜底分类</span>
                    <select value={selectedCategory.isFallback ? 'yes' : 'no'} onChange={(event) => updateCategory(selectedCategory.id, { isFallback: event.target.value === 'yes' })}>
                      <option value="no">否</option>
                      <option value="yes">是</option>
                    </select>
                  </label>
                  <Field label="兜底提示文案" value={selectedCategory.fallbackTip} onChange={(fallbackTip) => updateCategory(selectedCategory.id, { fallbackTip })} wide />
                </div>
              </div>

              <div className="config-section-header work-content-header">
                <div>
                  <h3>“{selectedCategory.name}”下的工作内容</h3>
                  <p className="muted">推荐关键词、备注模板和说明跟随当前工作内容一起保存。</p>
                </div>
                <button onClick={() => updateWorkItems([...(selectedCategory.items || []), createWorkItem('新工作内容')])}>新增工作内容</button>
              </div>
              <EditableTable
                items={selectedCategory.items || []}
                onChange={updateWorkItems}
                columns={[
                  { key: 'name', label: '工作内容名称', type: 'text', size: 'long' },
                  { key: 'description', label: '说明', type: 'text', size: 'text' },
                  { key: 'keywords', label: '推荐关键词', type: 'keywords', size: 'text' },
                  { key: 'remarkTemplate', label: '备注模板', type: 'textarea', size: 'longText' }
                ]}
              />
            </>
          )}
        </section>
      </div>
    </ConfigSection>
  );
}

function SceneEditor({ scenes, configs, onChange }) {
  const categories = configs.watermarkCategories.filter((item) => item.enabled !== false);
  const categoryNames = categories.map((item) => item.name);
  const currentCategory = (scene) => categories.find((item) => item.name === scene.watermarkCategory) || categories[0];

  return (
    <ConfigSection title="常见场景" onAdd={() => onChange([...scenes, createScene()])}>
      <div className="scene-config-list">
        {sortItems(scenes).map((scene, index) => (
          <article className="scene-config-card" key={scene.id}>
            <div className="config-row-actions">
              <strong>场景 {index + 1}</strong>
              <RowActions items={scenes} item={scene} onChange={onChange} />
            </div>
            <div className="config-form-grid">
              <Field label="名称" value={scene.title} onChange={(title) => updateScene(scenes, scene.id, { title, name: title }, onChange)} />
              <SelectField label="水印分类" value={scene.watermarkCategory} options={categoryNames} onChange={(watermarkCategory) => updateScene(scenes, scene.id, { watermarkCategory, workContent: currentCategory({ watermarkCategory })?.items?.[0]?.name || '' }, onChange)} />
              <SelectField label="工作内容" value={scene.workContent} options={(currentCategory(scene)?.items || []).map((item) => item.name)} onChange={(workContent) => updateScene(scenes, scene.id, { workContent }, onChange)} />
              <Field label="事项名称建议" value={scene.itemName} onChange={(itemName) => updateScene(scenes, scene.id, { itemName, workItemSuggestion: itemName }, onChange)} />
              <Field label="位置/区域提示" value={scene.locationPlaceholder} onChange={(locationPlaceholder) => updateScene(scenes, scene.id, { locationPlaceholder }, onChange)} />
              <SelectField label="处理状态建议" value={scene.processStatus || scene.processStatusSuggestion} options={configs.processStatuses.map((item) => item.name)} onChange={(processStatus) => updateScene(scenes, scene.id, { processStatus, processStatusSuggestion: processStatus }, onChange)} />
              <SelectField label="照片阶段建议" value={scene.photoStage || scene.photoStageSuggestion} options={configs.photoStages.map((item) => item.name)} onChange={(photoStage) => updateScene(scenes, scene.id, { photoStage, photoStageSuggestion: photoStage }, onChange)} />
              <Field label="推荐关键词" value={(scene.keywords || []).join('、')} onChange={(value) => updateScene(scenes, scene.id, { keywords: splitKeywords(value) }, onChange)} />
              <Field label="备注模板" value={scene.remarkTemplate} onChange={(remarkTemplate) => updateScene(scenes, scene.id, { remarkTemplate }, onChange)} wide />
            </div>
          </article>
        ))}
      </div>
    </ConfigSection>
  );
}

function BackupPanel({ paths, onBackup, onExport, onImport, onReset }) {
  return (
    <section className="config-section">
      <h3>配置备份、导入导出和恢复默认</h3>
      <p className="muted">用户自定义配置只保存在本机文档目录，软件升级不会覆盖这些文件。</p>
      <div className="config-paths">
        <span>用户配置目录：{paths?.userConfigDir || '加载中'}</span>
        <span>配置备份目录：{paths?.backupDir || '加载中'}</span>
        <span>内置默认配置：{paths?.defaultConfigDir || '加载中'}</span>
      </div>
      <div className="config-backup-actions">
        <button onClick={onBackup}>立即备份当前配置</button>
        <button onClick={onExport}>导出全部配置</button>
        <button onClick={onImport}>导入配置</button>
        <button className="danger" onClick={onReset}>恢复默认配置</button>
      </div>
      <div className="warning-box">恢复默认或导入配置前会自动备份当前配置；系统最多保留最近 30 个自动备份。</div>
    </section>
  );
}

function ConfigSection({ title, onAdd, children }) {
  return (
    <section className="config-section">
      <div className="config-section-header">
        <div>
          <h3>{title}</h3>
          <p className="muted">名称不能为空，同类名称不能重复；排序数字越小越靠前。</p>
          {title === '常见场景' && <p className="muted">事项名称建议可为空；位置/区域提示只用于提醒，不会自动填入位置。</p>}
        </div>
        <button onClick={onAdd}>新增</button>
      </div>
      {children}
    </section>
  );
}

function EditableTable({ items, onChange, columns, defaultable = false, deleteHint }) {
  const sorted = sortItems(items);
  const widthBySize = {
    short: 'minmax(120px, 0.7fr)',
    medium: 'minmax(180px, 1fr)',
    long: 'minmax(240px, 1.2fr)',
    text: 'minmax(240px, 1.35fr)',
    longText: 'minmax(280px, 1.5fr)'
  };
  const fieldColumns = columns.map((column) => widthBySize[column.size] || 'minmax(180px, 1fr)').join(' ');
  const tableColumns = `46px ${defaultable ? '52px ' : ''}${fieldColumns} 64px 200px`;

  function patchItem(id, patch) {
    onChange(items.map((item) => {
      if (item.id !== id) return defaultable && patch.isDefault ? { ...item, isDefault: false } : item;
      return { ...item, ...patch };
    }));
  }

  function deleteItem(item) {
    const message = deleteHint?.(item) || `确认删除“${item.name}”？如果只是暂时不用，建议停用，不建议删除。`;
    if (!window.confirm(message)) return;
    onChange(items.filter((current) => current.id !== item.id));
  }

  return (
    <div className="config-table">
      <div className="config-table-head" style={{ gridTemplateColumns: tableColumns }}>
        <span>启用</span>
        {defaultable && <span>默认</span>}
        {columns.map((column) => <span className={`config-column-${column.key}`} key={column.key}>{column.label}</span>)}
        <span>排序</span>
        <span>操作</span>
      </div>
      {sorted.map((item) => (
        <div className="config-table-row" key={item.id} style={{ gridTemplateColumns: tableColumns }}>
          <input type="checkbox" checked={item.enabled !== false} onChange={(event) => patchItem(item.id, { enabled: event.target.checked })} />
          {defaultable && <input type="radio" checked={Boolean(item.isDefault)} onChange={() => patchItem(item.id, { isDefault: true })} />}
          {columns.map((column) => (
            <EditableCell key={column.key} column={column} item={item} onChange={(value) => patchItem(item.id, { [column.key]: value })} />
          ))}
          <input type="number" value={item.sort} onChange={(event) => patchItem(item.id, { sort: Number(event.target.value) })} />
          <RowActions items={items} item={item} onChange={onChange} onDelete={() => deleteItem(item)} />
        </div>
      ))}
    </div>
  );
}

function EditableCell({ column, item, onChange }) {
  const value = item[column.key];
  if (column.type === 'checkbox') {
    return <input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />;
  }
  if (column.type === 'textarea') {
    return <textarea className={`config-cell config-cell-${column.key}`} rows={2} value={value || ''} onChange={(event) => onChange(event.target.value)} />;
  }
  if (column.type === 'keywords') {
    return <input className={`config-cell config-cell-${column.key}`} value={(value || []).join('、')} onChange={(event) => onChange(splitKeywords(event.target.value))} />;
  }
  return <input className={`config-cell config-cell-${column.key}`} value={value || ''} onChange={(event) => onChange(event.target.value)} />;
}

function RowActions({ items, item, onChange, onDelete }) {
  function move(delta) {
    const sorted = sortItems(items);
    const index = sorted.findIndex((current) => current.id === item.id);
    const target = sorted[index + delta];
    if (!target) return;
    onChange(items.map((current) => {
      if (current.id === item.id) return { ...current, sort: target.sort };
      if (current.id === target.id) return { ...current, sort: item.sort };
      return current;
    }));
  }

  function toggleEnabled() {
    onChange(items.map((current) => current.id === item.id ? { ...current, enabled: current.enabled === false } : current));
  }

  return (
    <div className="row-actions">
      <button className="mini-button" title="当前行可直接在列表中编辑" onClick={() => window.alert('当前行可直接在列表中编辑，修改后点击“保存并刷新主界面”。')}>编辑</button>
      <button className="mini-button" onClick={() => move(-1)}>上移</button>
      <button className="mini-button" onClick={() => move(1)}>下移</button>
      <button className="mini-button" onClick={toggleEnabled}>{item.enabled === false ? '启用' : '停用'}</button>
      {onDelete && <button className="mini-button danger" onClick={onDelete}>删除</button>}
    </div>
  );
}

function Field({ label, value, onChange, wide = false }) {
  return (
    <label className={`field ${wide ? 'wide' : ''}`}>
      <span>{label}</span>
      <input value={value || ''} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function SelectField({ label, value, options, onChange }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value || ''} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  );
}

function updateScene(scenes, id, patch, onChange) {
  onChange(scenes.map((scene) => scene.id === id ? { ...scene, ...patch } : scene));
}

function createSimpleItem(name) {
  return {
    id: `item-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name,
    enabled: true,
    sort: Date.now() % 100000,
    isDefault: false,
    description: '',
    group: ''
  };
}

function createCategory(name) {
  return {
    ...createSimpleItem(name),
    isFallback: false,
    fallbackTip: '',
    items: []
  };
}

function createWorkItem(name) {
  return {
    ...createSimpleItem(name),
    keywords: [],
    remarkTemplate: ''
  };
}

function createScene() {
  return {
    ...createSimpleItem('新常见场景'),
    title: '新常见场景',
    watermarkCategory: '',
    workContent: '',
    itemName: '',
    locationPlaceholder: '',
    processStatus: '',
    photoStage: '',
    keywords: [],
    remarkTemplate: ''
  };
}

function sortItems(items) {
  return [...(items || [])].sort((a, b) => Number(a.sort || 0) - Number(b.sort || 0));
}

function swapSort(items, item, delta) {
  const sorted = sortItems(items);
  const index = sorted.findIndex((current) => current.id === item.id);
  const target = sorted[index + delta];
  if (!target) return items;
  return items.map((current) => {
    if (current.id === item.id) return { ...current, sort: target.sort };
    if (current.id === target.id) return { ...current, sort: item.sort };
    return current;
  });
}

function splitKeywords(value) {
  return String(value || '').split(/[、,，;；\s]+/).map((item) => item.trim()).filter(Boolean);
}

export { CONFIG_LABELS };
