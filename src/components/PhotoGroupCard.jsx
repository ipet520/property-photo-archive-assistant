import ThumbnailHoverPreview from './ThumbnailHoverPreview.jsx';

export default function PhotoGroupCard({
  group,
  selectedIds = [],
  onSelectGroup,
  onApplySuggestion,
  onRemoveSelected,
  onSplitSelected,
  onIgnoreGroup
}) {
  const selectedInGroup = group.photoIds.filter((id) => selectedIds.includes(id));
  return (
    <article className={`photo-group-card ${group.confidence}`}>
      <header>
        <div>
          <h4 title={group.name}>{group.name}</h4>
          <p title={group.basis}>{group.basis}</p>
        </div>
        <span>{group.confidenceLabel}</span>
      </header>
      <div className="photo-group-meta">
        <strong>{group.photos.length} 张照片</strong>
        <small>{group.reasons?.join(' / ') || '待人工确认'}</small>
      </div>
      <div className="photo-group-thumbs">
        {group.photos.slice(0, 5).map((photo) => (
          <div key={photo.id} className="photo-group-thumb" title={photo.originalName || photo.name}>
            <ThumbnailHoverPreview src={photo.previewUrl || photo.thumbnailPath} alt={photo.originalName || photo.name} />
          </div>
        ))}
        {group.photos.length > 5 && <span className="photo-group-more">+{group.photos.length - 5}</span>}
      </div>
      <dl>
        <div><dt>建议事项</dt><dd title={group.suggestion?.itemName || group.suggestion?.workItem}>{group.suggestion?.itemName || group.suggestion?.workItem || '-'}</dd></div>
        <div><dt>建议关键词</dt><dd title={(group.suggestion?.keywords || []).join('、')}>{(group.suggestion?.keywords || []).slice(0, 4).join('、') || '-'}</dd></div>
      </dl>
      <footer>
        <button type="button" className="primary" onClick={() => onSelectGroup(group)}>选择本组</button>
        <button type="button" onClick={() => onApplySuggestion(group)}>应用本组建议</button>
        <button type="button" disabled={selectedInGroup.length === 0} onClick={() => onRemoveSelected(group)}>移除选中</button>
        <button type="button" disabled={selectedInGroup.length === 0} onClick={() => onSplitSelected(group)}>拆分选中</button>
        <button type="button" className="ghost" onClick={() => onIgnoreGroup(group)}>忽略本组</button>
      </footer>
    </article>
  );
}
