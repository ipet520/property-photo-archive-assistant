import { buildRemarkTemplates, getSuggestedKeywords, splitKeywords, toggleKeyword } from '../utils/formatters.js';

export default function SmartAssistPanel({
  configs,
  form,
  updateForm,
  recentRecords,
  onApplyScene,
  onApplyRecent,
  onClearRecent
}) {
  if (!configs) return null;

  const suggestedKeywords = splitKeywords(getSuggestedKeywords(form, configs));
  const activeKeywords = splitKeywords(form.keywords);
  const remarkTemplates = buildRemarkTemplates(form, configs.sceneExamples, configs);

  function toggleSuggestedKeyword(keyword) {
    updateForm({ keywords: toggleKeyword(form.keywords, keyword) }, { preserveKeywords: true });
  }

  return (
    <section className="assist-grid">
      <details className="panel assist-panel" open>
        <summary>
          <span>
            <strong>常见场景快速套用</strong>
            <small>选择后自动带出分类、内容、关键词和备注模板</small>
          </span>
        </summary>
        <div className="scene-picker">
          {configs.sceneExamples.map((scene) => (
            <button type="button" className="scene-chip" key={scene.title} onClick={() => onApplyScene(scene)}>
              <strong>{scene.title}</strong>
              <small>{scene.watermarkCategory} / {scene.workContent}</small>
            </button>
          ))}
        </div>
      </details>

      <details className="panel assist-panel" open>
        <summary>
          <span>
            <strong>关键词推荐</strong>
            <small>点击加入，再次点击取消</small>
          </span>
          <button type="button" className="mini-button" onClick={(event) => {
            event.preventDefault();
            updateForm({ keywords: '' }, { preserveKeywords: true });
          }}>清空</button>
        </summary>
        <div className="keyword-cloud">
          {suggestedKeywords.length === 0 ? (
            <span className="muted">填写事项名称或位置/区域后会出现更多推荐关键词。</span>
          ) : suggestedKeywords.map((keyword) => (
            <button
              type="button"
              key={keyword}
              className={`keyword-chip ${activeKeywords.includes(keyword) ? 'active' : ''}`}
              onClick={() => toggleSuggestedKeyword(keyword)}
            >
              {keyword}
            </button>
          ))}
        </div>
      </details>

      <details className="panel assist-panel">
        <summary>
          <span>
            <strong>备注模板</strong>
            <small>点击填入备注栏，可继续手动修改</small>
          </span>
        </summary>
        <div className="template-list">
          {remarkTemplates.map((template) => (
            <button type="button" key={template} className="template-card" onClick={() => updateForm({ remark: fillTemplate(template, form) })}>
              {fillTemplate(template, form)}
            </button>
          ))}
        </div>
      </details>

      <details className="panel assist-panel">
        <summary>
          <span>
            <strong>最近使用记录</strong>
            <small>本地保存最近 10 条表单组合</small>
          </span>
          <button type="button" className="mini-button" onClick={(event) => {
            event.preventDefault();
            onClearRecent();
          }}>清空</button>
        </summary>
        <div className="recent-list">
          {recentRecords.length === 0 ? (
            <span className="muted">完成归档后会自动保存最近使用记录。</span>
          ) : recentRecords.map((record) => (
            <button type="button" key={record.id} className="recent-card" onClick={() => onApplyRecent(record)}>
              <strong>{record.project} / {record.department}</strong>
              <span>{record.watermarkCategory} / {record.workContent}</span>
              <small>{record.location || '未填写位置/区域'} - {record.workItem || '未填写事项名称'}</small>
            </button>
          ))}
        </div>
      </details>
    </section>
  );
}

function fillTemplate(template, form) {
  return template
    .replaceAll('具体位置', form.location || '位置/区域')
    .replaceAll('位置/区域', form.location || '位置/区域')
    .replaceAll('工作事项', form.workItem || form.workContent || '事项名称')
    .replaceAll('事项名称', form.workItem || form.workContent || '事项名称');
}
