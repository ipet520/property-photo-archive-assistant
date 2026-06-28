import { useEffect, useRef, useState } from 'react';
import { recordRuntimeLog } from '../utils/runtimeLogger.js';

const CONFIG_TABS = [
  { key: 'projects', label: '项目管理', type: 'simple', defaultable: true },
  { key: 'departments', label: '部门管理', type: 'simple', defaultable: true },
  { key: 'photoSources', label: '照片来源', type: 'simple' },
  { key: 'watermarkCategories', label: '水印分类与工作内容', type: 'watermark' },
  { key: 'photoStages', label: '照片阶段', type: 'simple', defaultable: true },
  { key: 'processStatuses', label: '处理状态', type: 'simple', defaultable: true },
  { key: 'keywords', label: '关键词', type: 'keywords' },
  { key: 'sceneExamples', label: '常见场景', type: 'scenes' }
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
      recordRuntimeLog({ page: '系统设置', operation: '读取基础数据配置', errorType: '配置读取失败', summary: error.message, error });
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
    const invalidSceneName = configs?.sceneExamples?.find((scene) => !String(scene.title || scene.name || '').trim());
    if (invalidSceneName) {
      setActiveTab('sceneExamples');
      setMessage({ type: 'error', text: '常见场景名称不能为空。' });
      return;
    }
    const missingSceneCategory = configs?.sceneExamples?.find((scene) => !String(scene.watermarkCategory || '').trim());
    if (missingSceneCategory) {
      setActiveTab('sceneExamples');
      setMessage({ type: 'error', text: '请选择水印分类。' });
      return;
    }
    const missingSceneWorkContent = configs?.sceneExamples?.find((scene) => !String(scene.workContent || '').trim());
    if (missingSceneWorkContent) {
      setActiveTab('sceneExamples');
      setMessage({ type: 'error', text: '请选择工作内容。' });
      return;
    }
    setIsSaving(true);
    try {
      const result = await window.archiveAssistant.saveAllUserConfigs(configs);
      setConfigs(result.editableConfigs);
      setPaths(result.paths);
      await onSaved(result.runtimeConfigs);
      setMessage({ type: 'success', text: '配置已保存，主界面已刷新。' });
    } catch (error) {
      recordRuntimeLog({ page: '系统设置', operation: '保存基础数据配置', errorType: '配置保存失败', summary: error.message, error });
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
      recordRuntimeLog({ page: '系统设置', operation: '恢复默认基础数据配置', errorType: '配置保存失败', summary: error.message, error });
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
      recordRuntimeLog({ page: '系统设置', operation: '导出基础数据配置', errorType: '配置保存失败', summary: error.message, error });
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
      recordRuntimeLog({ page: '系统设置', operation: '导入基础数据配置', errorType: '配置读取失败', summary: error.message, error });
      setMessage({ type: 'error', text: `导入失败：${error.message}` });
    }
  }

  async function backupNow() {
    try {
      const result = await window.archiveAssistant.backupConfigs();
      setMessage({ type: 'success', text: `已生成配置备份：${result.backupFile}` });
    } catch (error) {
      recordRuntimeLog({ page: '系统设置', operation: '备份基础数据配置', errorType: '设置备份失败', summary: error.message, error });
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
            ) : (
              <SceneEditor
                scenes={configs.sceneExamples}
                configs={configs}
                onChange={(items) => updateConfig('sceneExamples', items)}
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
  const [focusItemId, setFocusItemId] = useState('');
  const nameSize = title === '部门管理' || title === '照片阶段' || title === '处理状态' ? 'short' : 'medium';
  function addItem() {
    const item = createTopItem(items, createSimpleItem(`新${title}`));
    setFocusItemId(item.id);
    onChange([item, ...items]);
  }
  return (
    <ConfigSection title={title} onAdd={addItem}>
      <EditableTable
        items={items}
        onChange={onChange}
        defaultable={defaultable}
        focusItemId={focusItemId}
        onFocusComplete={() => setFocusItemId('')}
        columns={[
          { key: 'name', label: '名称', type: 'text', size: nameSize },
          { key: 'description', label: '说明', type: 'text', size: 'text' }
        ]}
      />
    </ConfigSection>
  );
}

function KeywordEditor({ items, onChange }) {
  const [focusItemId, setFocusItemId] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importSummary, setImportSummary] = useState('');

  function addKeyword() {
    const item = createTopItem(items, createSimpleItem('新关键词'));
    setFocusItemId(item.id);
    onChange([item, ...items]);
  }

  function importKeywords() {
    const rawParts = importText.split(/[\n,，、;；\s]/);
    const names = rawParts.map((item) => item.trim()).filter(Boolean);
    const emptyCount = rawParts.length - names.length;
    const uniqueNames = Array.from(new Set(names));
    const existing = new Set(items.map((item) => item.name.trim()));
    const newNames = uniqueNames.filter((name) => !existing.has(name));
    const duplicateCount = names.length - uniqueNames.length + uniqueNames.filter((name) => existing.has(name)).length;
    const imported = newNames.map((name, index) => ({
      ...createSimpleItem(name),
      sort: getTopSort(items) - newNames.length + index
    }));
    if (imported.length > 0) onChange([...imported, ...items]);
    setImportSummary(`本次识别关键词 ${names.length} 个；成功导入 ${imported.length} 个；跳过重复 ${duplicateCount} 个；跳过空项 ${emptyCount} 个。`);
    setImportText('');
    setImportOpen(false);
  }

  return (
    <ConfigSection title="关键词" onAdd={addKeyword}>
      <div className="config-toolbar">
        <button className="ghost" onClick={() => setImportOpen(true)}>批量导入关键词</button>
        {importSummary && <span className="config-import-summary">{importSummary}</span>}
      </div>
      <EditableTable
        items={items}
        onChange={onChange}
        focusItemId={focusItemId}
        onFocusComplete={() => setFocusItemId('')}
        columns={[
          { key: 'name', label: '关键词', type: 'text', size: 'medium' },
          { key: 'group', label: '分组', type: 'text', size: 'short' },
          { key: 'description', label: '说明', type: 'text', size: 'text' }
        ]}
      />
      {importOpen && (
        <div className="config-import-backdrop" role="dialog" aria-modal="true" aria-labelledby="keyword-import-title">
          <section className="config-import-dialog">
            <header>
              <h3 id="keyword-import-title">批量导入关键词</h3>
              <p>每行一个关键词，也可使用逗号、顿号、分号或空格分隔。</p>
            </header>
            <textarea autoFocus value={importText} onChange={(event) => setImportText(event.target.value)} placeholder="例如：巡查、维修；安全提醒" />
            <footer>
              <button type="button" onClick={() => { setImportOpen(false); setImportText(''); }}>取消</button>
              <button type="button" className="primary" onClick={importKeywords} disabled={!importText.trim()}>导入关键词</button>
            </footer>
          </section>
        </div>
      )}
    </ConfigSection>
  );
}

function WatermarkCategoryEditor({ categories, selectedCategoryId, onSelectCategory, onChange }) {
  const [focusWorkItemId, setFocusWorkItemId] = useState('');
  const [focusCategoryId, setFocusCategoryId] = useState('');
  const categoryNameRef = useRef(null);
  const selectedCategory = categories.find((item) => item.id === selectedCategoryId) || categories[0];

  useEffect(() => {
    if (!focusCategoryId || selectedCategory?.id !== focusCategoryId) return;
    categoryNameRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    categoryNameRef.current?.focus();
    categoryNameRef.current?.select();
    setFocusCategoryId('');
  }, [focusCategoryId, selectedCategory?.id]);

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
    const nextCategory = createTopItem(categories, createCategory('新水印分类'));
    onChange([nextCategory, ...categories]);
    onSelectCategory(nextCategory.id);
    setFocusCategoryId(nextCategory.id);
  }

  function addWorkItem() {
    const currentItems = selectedCategory.items || [];
    const nextItem = createTopItem(currentItems, createWorkItem('新工作内容'));
    setFocusWorkItemId(nextItem.id);
    updateWorkItems([nextItem, ...currentItems]);
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
                  <Field inputRef={categoryNameRef} label="分类名称" value={selectedCategory.name} onChange={(name) => updateCategory(selectedCategory.id, { name })} />
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
                <button onClick={addWorkItem}>新增工作内容</button>
              </div>
              <EditableTable
                items={selectedCategory.items || []}
                onChange={updateWorkItems}
                focusItemId={focusWorkItemId}
                onFocusComplete={() => setFocusWorkItemId('')}
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
  const [focusSceneId, setFocusSceneId] = useState('');
  const sceneRefs = useRef(new Map());
  const autoSuggestionsRef = useRef(new Map());
  const categories = configs.watermarkCategories.filter((item) => item.enabled !== false);
  const categoryNames = categories.map((item) => item.name);
  const currentCategory = (scene) => categories.find((item) => item.name === scene.watermarkCategory);

  useEffect(() => {
    if (!focusSceneId) return;
    const card = sceneRefs.current.get(focusSceneId);
    card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const input = card?.querySelector('input');
    input?.focus();
    input?.select();
    setFocusSceneId('');
  }, [focusSceneId, scenes]);

  function addScene() {
    const scene = createTopItem(scenes, createScene());
    setFocusSceneId(scene.id);
    onChange([scene, ...scenes]);
  }

  function updateSceneSelection(scene, selectionPatch) {
    const nextScene = { ...scene, ...selectionPatch };
    const suggestions = buildSceneSuggestions(nextScene.watermarkCategory, nextScene.workContent, configs);
    const previousSuggestions = autoSuggestionsRef.current.get(scene.id)
      || buildSceneSuggestions(scene.watermarkCategory, scene.workContent, configs);
    const suggestionPatch = {};
    Object.entries(suggestions).forEach(([key, value]) => {
      const currentValue = sceneValue(scene, key);
      const previousValue = previousSuggestions[key];
      if (isEmptySceneValue(currentValue) || sameSceneValue(currentValue, previousValue)) suggestionPatch[key] = value;
    });
    autoSuggestionsRef.current.set(scene.id, suggestions);
    updateScene(scenes, scene.id, normalizeSceneSuggestionPatch({ ...selectionPatch, ...suggestionPatch }), onChange);
  }

  return (
    <ConfigSection title="常见场景" onAdd={addScene}>
      <div className="scene-config-list">
        {sortItems(scenes).map((scene, index) => (
          <article className="scene-config-card" key={scene.id} ref={(node) => node ? sceneRefs.current.set(scene.id, node) : sceneRefs.current.delete(scene.id)}>
            <div className="config-row-actions">
              <strong>场景 {index + 1}</strong>
              <RowActions items={scenes} item={scene} onChange={onChange} />
            </div>
            <div className="config-form-grid">
              <Field label="名称" value={scene.title} onChange={(title) => updateScene(scenes, scene.id, { title, name: title }, onChange)} />
              <SelectField label="水印分类" value={scene.watermarkCategory} options={categoryNames} placeholder="请选择水印分类" onChange={(watermarkCategory) => updateSceneSelection(scene, { watermarkCategory, workContent: '' })} />
              <SelectField label="工作内容" value={scene.workContent} options={(currentCategory(scene)?.items || []).map((item) => item.name)} placeholder="请选择工作内容" disabled={!scene.watermarkCategory} onChange={(workContent) => updateSceneSelection(scene, { workContent })} />
              <Field label="事项名称建议" value={scene.itemName} onChange={(itemName) => updateScene(scenes, scene.id, { itemName, workItemSuggestion: itemName }, onChange)} />
              <Field label="位置/区域提示" value={scene.locationPlaceholder} onChange={(locationPlaceholder) => updateScene(scenes, scene.id, { locationPlaceholder }, onChange)} />
              <SelectField label="处理状态建议" value={scene.processStatus || scene.processStatusSuggestion} options={configs.processStatuses.map((item) => item.name)} placeholder="请选择处理状态" onChange={(processStatus) => updateScene(scenes, scene.id, { processStatus, processStatusSuggestion: processStatus }, onChange)} />
              <SelectField label="照片阶段建议" value={scene.photoStage || scene.photoStageSuggestion} options={configs.photoStages.map((item) => item.name)} placeholder="请选择照片阶段" onChange={(photoStage) => updateScene(scenes, scene.id, { photoStage, photoStageSuggestion: photoStage }, onChange)} />
              <Field label="推荐关键词" value={(scene.keywords || []).join('、')} onChange={(value) => updateScene(scenes, scene.id, { keywords: splitKeywords(value) }, onChange)} />
              <Field label="备注模板" value={scene.remarkTemplate} onChange={(remarkTemplate) => updateScene(scenes, scene.id, { remarkTemplate }, onChange)} wide />
            </div>
          </article>
        ))}
      </div>
    </ConfigSection>
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

function EditableTable({ items, onChange, columns, defaultable = false, deleteHint, focusItemId = '', onFocusComplete }) {
  const rowRefs = useRef(new Map());
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

  useEffect(() => {
    if (!focusItemId) return;
    const row = rowRefs.current.get(focusItemId);
    row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const input = row?.querySelector('.config-cell-name, input[type="text"]');
    input?.focus();
    input?.select();
    onFocusComplete?.();
  }, [focusItemId, onFocusComplete]);

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
        <div className="config-table-row" key={item.id} ref={(node) => node ? rowRefs.current.set(item.id, node) : rowRefs.current.delete(item.id)} style={{ gridTemplateColumns: tableColumns }}>
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

function Field({ label, value, onChange, wide = false, inputRef }) {
  return (
    <label className={`field ${wide ? 'wide' : ''}`}>
      <span>{label}</span>
      <input ref={inputRef} value={value || ''} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function SelectField({ label, value, options, onChange, placeholder = '', disabled = false }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value || ''} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  );
}

function updateScene(scenes, id, patch, onChange) {
  onChange(scenes.map((scene) => scene.id === id ? { ...scene, ...patch } : scene));
}

function createTopItem(items, item) {
  return { ...item, sort: getTopSort(items) - 1 };
}

function getTopSort(items) {
  return Math.min(0, ...(items || []).map((item) => Number(item.sort || 0)));
}

function buildSceneSuggestions(categoryName, workContent, configs) {
  const category = String(categoryName || '');
  const work = String(workContent || '');
  if (!category || !work) return createEmptySceneSuggestions();
  const direction = SCENE_SUGGESTION_RULES.find((rule) => category.includes(rule.match)) || SCENE_SUGGESTION_RULES[0];
  const isParkingOccupation = category.includes('机动车违规管理') && work.includes('占用') && work.includes('车位');
  const processStatus = pickConfigName(configs.processStatuses, '待处理');
  const photoStage = pickConfigName(configs.photoStages, '远景定位');
  return {
    itemName: isParkingOccupation ? '车辆占用车位处理' : `${work || direction.itemStem}${/(处理|维修|巡查|检查|归档|宣传|培训|清理)$/.test(work) ? '' : '处理'}`,
    locationPlaceholder: isParkingOccupation ? '填写车位号、楼栋单元、地下车库区域等' : direction.location,
    processStatus,
    photoStage,
    keywords: buildRecommendedKeywords(category, work, direction.keywords),
    remarkTemplate: isParkingOccupation
      ? '现场发现车辆占用他人车位，已记录并按流程联系处理，后续持续跟进。'
      : `现场开展${work || direction.itemStem}工作，已完成记录并按流程处理，后续持续跟进。`
  };
}

function createEmptySceneSuggestions() {
  return {
    itemName: '',
    locationPlaceholder: '',
    processStatus: '',
    photoStage: '',
    keywords: [],
    remarkTemplate: ''
  };
}

const SCENE_SUGGESTION_RULES = [
  { match: '安全管理类', itemStem: '安全巡查', location: '填写楼栋、单元、通道或隐患点位', keywords: ['巡查', '隐患', '秩序', '安全提醒'] },
  { match: '工程类专用', itemStem: '设施设备检查', location: '填写设备房、楼栋单元或设施点位', keywords: ['维修', '检查', '处理', '设备设施'] },
  { match: '绿化保洁类', itemStem: '环境维护', location: '填写楼栋周边、园区道路或绿化区域', keywords: ['清理', '保洁', '修剪', '消杀'] },
  { match: '巡查检查类', itemStem: '现场巡查', location: '填写巡查区域、楼栋单元或具体点位', keywords: ['巡查', '记录', '复查'] },
  { match: '机动车违规管理', itemStem: '车辆秩序维护', location: '填写车位号、道路、出入口或车库区域', keywords: ['车辆停放', '占用通道', '占用车位', '秩序维护'] },
  { match: '资料整理归档', itemStem: '资料归档', location: '填写资料所属项目、部门或存放区域', keywords: ['资料收集', '分类', '归档', '核对'] },
  { match: '会议培训宣传', itemStem: '会议培训宣传', location: '填写会议室、活动区域或宣传点位', keywords: ['通知', '宣传', '培训', '活动记录'] }
];

const WORK_KEYWORD_RULES = [
  { category: '机动车违规管理', work: ['占用', '车位'], keywords: ['占用车位', '车辆停放', '车位管理', '秩序维护'] },
  { category: '机动车违规管理', work: ['消防通道'], keywords: ['消防通道', '违规停车', '车辆停放', '安全隐患', '秩序维护'] },
  { category: '绿化保洁类', work: ['楼道', '杂物'], keywords: ['楼道杂物', '公共区域', '环境卫生', '清理整治'] },
  { category: '工程类专用', work: ['公共照明'], keywords: ['公共照明', '设施维修', '工程维修', '设备设施'] }
];

function buildRecommendedKeywords(category, work, categoryKeywords) {
  if (!category) return [];
  const matchedRule = WORK_KEYWORD_RULES.find((rule) => (
    category.includes(rule.category) && rule.work.every((keyword) => work.includes(keyword))
  ));
  const workKeywords = work
    ? (matchedRule?.keywords || [work, ...splitKeywords(work.replace(/[与和、/]/g, '、'))])
    : [];
  return Array.from(new Set([...workKeywords, ...(categoryKeywords || [])].filter(Boolean)));
}

function pickConfigName(items, preferred) {
  return items.find((item) => item.enabled !== false && item.name === preferred)?.name
    || items.find((item) => item.enabled !== false)?.name
    || '';
}

function sceneValue(scene, key) {
  if (key === 'processStatus') return scene.processStatus || scene.processStatusSuggestion || '';
  if (key === 'photoStage') return scene.photoStage || scene.photoStageSuggestion || '';
  return scene[key];
}

function isEmptySceneValue(value) {
  return Array.isArray(value) ? value.length === 0 : !String(value || '').trim();
}

function sameSceneValue(current, previous) {
  if (previous === undefined) return false;
  if (Array.isArray(current) || Array.isArray(previous)) return JSON.stringify(current || []) === JSON.stringify(previous || []);
  return String(current || '') === String(previous || '');
}

function normalizeSceneSuggestionPatch(patch) {
  const next = { ...patch };
  if (Object.hasOwn(next, 'itemName')) next.workItemSuggestion = next.itemName;
  if (Object.hasOwn(next, 'processStatus')) next.processStatusSuggestion = next.processStatus;
  if (Object.hasOwn(next, 'photoStage')) next.photoStageSuggestion = next.photoStage;
  return next;
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
