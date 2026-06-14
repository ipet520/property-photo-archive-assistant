const REQUIRED_FIELDS = new Set(['项目', '部门', '水印分类', '工作内容', '日期', '具体位置', '工作事项', '照片阶段']);

export default function ArchiveForm({ configs, form, updateForm, compact = false }) {
  if (!configs) {
    return <section className="panel">正在加载配置...</section>;
  }

  const workContents = configs.watermarkCategories[form.watermarkCategory]?.items || [];

  return (
    <section className={`panel archive-form-panel ${compact ? 'compact' : ''}`}>
      <div className="panel-heading">
        <div>
          <p className="eyebrow">第一步</p>
          <h2>填写归档信息</h2>
        </div>
        <span className="safe-badge">原图保护</span>
      </div>

      <div className="form-grid">
        <Select label="照片来源" value={form.photoSource} options={configs.photoSources} onChange={(photoSource) => updateForm({ photoSource })} />
        <Select label="项目" value={form.project} options={configs.projects} onChange={(project) => updateForm({ project })} />
        <Select label="部门" value={form.department} options={configs.departments} onChange={(department) => updateForm({ department })} />
        <Select
          label="水印分类"
          value={form.watermarkCategory}
          options={Object.keys(configs.watermarkCategories)}
          onChange={(watermarkCategory) => updateForm({ watermarkCategory })}
        />
        <Select label="工作内容" value={form.workContent} options={workContents} onChange={(workContent) => updateForm({ workContent })} />
        <Input label="日期" type="date" value={form.date} onChange={(date) => updateForm({ date })} />
        <Input label="具体位置" value={form.location} placeholder="如：3栋1单元、负一层车库、北门岗" onChange={(location) => updateForm({ location })} />
        <Input label="工作事项" value={form.workItem} placeholder="如：闭门器维修、消防栓检查" onChange={(workItem) => updateForm({ workItem })} />
        <Select label="照片阶段" value={form.photoStage} options={configs.photoStages} onChange={(photoStage) => updateForm({ photoStage })} />
        <Select label="处理状态" value={form.processStatus} options={configs.processStatuses} onChange={(processStatus) => updateForm({ processStatus })} />
        <Input label="关键词" value={form.keywords} placeholder="多个关键词用顿号或逗号分隔" onChange={(keywords) => updateForm({ keywords })} wide />
        <TextArea label="备注" value={form.remark} placeholder="建议填写：问题点 + 处理动作 + 结果/状态" onChange={(remark) => updateForm({ remark })} />
      </div>
    </section>
  );
}

function Select({ label, value, options, onChange }) {
  return (
    <label className="field">
      <span>{label}{REQUIRED_FIELDS.has(label) && <b>*</b>}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    </label>
  );
}

function Input({ label, value, onChange, placeholder = '', type = 'text', wide = false }) {
  return (
    <label className={`field ${wide ? 'wide' : ''}`}>
      <span>{label}{REQUIRED_FIELDS.has(label) && <b>*</b>}</span>
      <input type={type} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function TextArea({ label, value, onChange, placeholder }) {
  return (
    <label className="field wide">
      <span>{label}</span>
      <textarea value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} rows={3} />
    </label>
  );
}
