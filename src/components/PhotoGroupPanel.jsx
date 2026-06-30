import PhotoGroupCard from './PhotoGroupCard.jsx';

export default function PhotoGroupPanel({
  photos = [],
  groups = [],
  selectedIds = [],
  hasGenerated = false,
  onGenerate,
  onClear,
  onSelectGroup,
  onApplySuggestion,
  onRemoveSelected,
  onSplitSelected,
  onIgnoreGroup
}) {
  return (
    <section className="photo-group-panel">
      <header className="photo-group-panel-header">
        <div>
          <p className="eyebrow">智能分组</p>
          <h3>按疑似事项组处理照片</h3>
        </div>
        <div className="photo-group-actions">
          <button type="button" className="primary" disabled={photos.length === 0} onClick={onGenerate}>
            {hasGenerated ? '重新分组' : '生成智能分组'}
          </button>
          <button type="button" disabled={!hasGenerated} onClick={onClear}>清除分组</button>
        </div>
      </header>

      {photos.length === 0 ? (
        <div className="photo-group-empty">
          <strong>当前暂无待分拣照片。</strong>
          <span>请先选择照片目录并扫描照片。</span>
        </div>
      ) : !hasGenerated ? (
        <div className="photo-group-empty">
          <strong>尚未生成智能分组。</strong>
          <span>您可以点击“生成智能分组”，系统会根据时间、场景和关键词进行辅助分组。</span>
        </div>
      ) : groups.length === 0 ? (
        <div className="photo-group-empty warning">
          <strong>当前照片缺少足够信息，暂未形成明确分组。</strong>
          <span>您仍可手动选择照片进行归档。</span>
        </div>
      ) : (
        <div className="photo-group-list">
          {groups.map((group) => (
            <PhotoGroupCard
              key={group.id}
              group={group}
              selectedIds={selectedIds}
              onSelectGroup={onSelectGroup}
              onApplySuggestion={onApplySuggestion}
              onRemoveSelected={onRemoveSelected}
              onSplitSelected={onSplitSelected}
              onIgnoreGroup={onIgnoreGroup}
            />
          ))}
        </div>
      )}
    </section>
  );
}
