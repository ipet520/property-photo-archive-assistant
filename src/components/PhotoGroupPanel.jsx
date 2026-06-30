import PhotoGroupCard from './PhotoGroupCard.jsx';

export default function PhotoGroupPanel({
  photos = [],
  groups = [],
  selectedIds = [],
  hasGenerated = false,
  isOpen = false,
  onGenerate,
  onClose,
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
          <h3>{hasGenerated && isOpen ? '分组建议结果' : '按事项组辅助选择'}</h3>
        </div>
        <div className="photo-group-actions">
          <button type="button" className="primary" disabled={photos.length === 0} onClick={onGenerate}>
            {hasGenerated ? '重新分组' : '生成分组建议'}
          </button>
          {hasGenerated && isOpen && <button type="button" onClick={onClose}>关闭分组结果</button>}
          {hasGenerated && !isOpen && <button type="button" onClick={onClose}>查看分组结果</button>}
          {hasGenerated && <button type="button" onClick={onClear}>清除分组</button>}
        </div>
      </header>

      {hasGenerated && isOpen && photos.length === 0 ? (
        <div className="photo-group-empty compact">
          当前暂无待分拣照片。请先选择照片目录并扫描照片。
        </div>
      ) : hasGenerated && isOpen && groups.length === 0 ? (
        <div className="photo-group-empty warning">
          当前照片缺少足够识别信息，暂未形成有效分组，您仍可手动选择照片进行归档。
        </div>
      ) : hasGenerated && isOpen ? (
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
      ) : null}
    </section>
  );
}
