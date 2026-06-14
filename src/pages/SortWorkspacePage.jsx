export default function SortWorkspacePage() {
  return (
    <div className="sort-workspace-page">
      <section className="page-hero compact">
        <div>
          <p className="eyebrow">V1.3.0 预留</p>
          <h1>照片分拣工作台</h1>
          <p>照片分拣工作台将在 V1.3.0 开放，用于处理混合照片批量分拣归档。</p>
        </div>
      </section>

      <div className="sort-toolbar panel">
        <button>选择照片文件夹</button>
        <button>扫描照片</button>
        <select defaultValue="全部">
          <option>全部</option>
          <option>未分拣</option>
          <option>已分拣</option>
          <option>已归档</option>
          <option>归档失败</option>
        </select>
        <button className="ghost">生成归档预览</button>
        <button className="primary">确认归档</button>
      </div>

      <section className="sort-workspace-layout">
        <div className="sort-photo-area panel">
          <h2>照片缩略图网格</h2>
          <div className="placeholder-grid">
            {Array.from({ length: 12 }).map((_, index) => <span key={index}>照片 {index + 1}</span>)}
          </div>
          <p className="muted">后续将在此显示导入照片，支持多选、框选、筛选、分拣状态标记。</p>
        </div>
        <aside className="sort-info-panel panel">
          <h2>选中照片归档信息</h2>
          {['项目', '部门', '照片来源', '水印分类', '工作内容', '日期', '具体位置', '工作事项', '照片阶段', '处理状态', '关键词', '备注'].map((label) => (
            <label className="field" key={label}>
              <span>{label}</span>
              <input disabled placeholder="V1.3.0 开放" />
            </label>
          ))}
          <button disabled>应用到选中照片</button>
        </aside>
      </section>

      <footer className="sort-status-bar">
        <span>总照片数：0</span>
        <span>已选择：0</span>
        <span>已分拣：0</span>
        <span>未分拣：0</span>
        <span>已归档：0</span>
        <span>归档失败：0</span>
      </footer>
    </div>
  );
}
