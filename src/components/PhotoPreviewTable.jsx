import { formatFileSize } from '../utils/formatters.js';

export default function PhotoPreviewTable({ items, photos, photoStages, onChangeItem }) {
  const rows = items.length > 0 ? items : photos;

  return (
    <section className="panel preview-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">第二步</p>
          <h2>预览归档结果</h2>
        </div>
        <span className="count-badge">{rows.length} 张照片</span>
      </div>

      {rows.length === 0 ? (
        <div className="empty-state">还没有照片。请选择照片文件夹后点击“扫描照片”。</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>序号</th>
                <th>缩略图</th>
                <th>原文件名</th>
                <th>新文件名</th>
                <th>水印分类</th>
                <th>工作内容</th>
                <th>位置/区域</th>
                <th>事项名称</th>
                <th>照片阶段</th>
                <th>处理状态</th>
                <th>目标路径</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((item, index) => (
                <tr key={item.id}>
                  <td>{item.index || index + 1}</td>
                  <td><img src={item.previewUrl} alt={item.originalName || item.name} /></td>
                  <td>
                    <strong>{item.originalName || item.name}</strong>
                    {!item.newFileName && <small>{formatFileSize(item.size)}</small>}
                  </td>
                  <td className="filename">{item.newFileName || '生成预览后显示'}</td>
                  <td>{item.watermarkCategory || '-'}</td>
                  <td>{item.workContent || '-'}</td>
                  <td>{item.location || '-'}</td>
                  <td>{item.workItem || '-'}</td>
                  <td>
                    {item.newFileName ? (
                      <select value={item.photoStage} onChange={(event) => onChangeItem(item.id, { photoStage: event.target.value })}>
                        {photoStages.map((stage) => <option key={stage} value={stage}>{stage}</option>)}
                      </select>
                    ) : '-'}
                  </td>
                  <td>{item.processStatus || '-'}</td>
                  <td className="path-cell">{item.targetPath || '生成预览后显示完整路径'}</td>
                  <td>
                    <span className={`row-status ${item.status === '归档失败' ? 'failed' : ''}`}>{item.error || item.status || '已扫描'}</span>
                    {item.newFileName && (
                      <>
                        <input
                          className="inline-edit"
                          value={item.keywords}
                          placeholder="关键词"
                          onChange={(event) => onChangeItem(item.id, { keywords: event.target.value })}
                        />
                        <input
                          className="inline-edit"
                          value={item.remark}
                          placeholder="备注"
                          onChange={(event) => onChangeItem(item.id, { remark: event.target.value })}
                        />
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
