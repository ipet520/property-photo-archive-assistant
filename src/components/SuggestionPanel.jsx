import { useState } from 'react';
import { splitKeywords } from '../utils/formatters.js';

export default function SuggestionPanel({ suggestion, onApply, onApplyEmpty, onIgnore, compact = false }) {
  const [expanded, setExpanded] = useState(false);
  if (!suggestion || suggestion.isEmpty) return null;

  const rows = [
    ['部门', suggestion.department],
    ['水印分类', suggestion.watermarkCategory],
    ['工作内容', suggestion.workContent],
    ['事项名称', suggestion.itemName || suggestion.workItem],
    ['位置/区域', suggestion.location || suggestion.locationPlaceholder],
    ['照片阶段', suggestion.photoStage],
    ['处理状态', suggestion.processStatus],
    ['关键词', splitKeywords(suggestion.keywords).join('、')],
    ['备注模板', suggestion.remarkTemplate || suggestion.remark]
  ].filter(([, value]) => String(value || '').trim());

  if (rows.length === 0) return null;
  const keywordsText = splitKeywords(suggestion.keywords).join('、');
  const primarySource = suggestion.sources?.[0] || '规则建议';
  const showDetails = !compact || expanded;

  return (
    <section className={`archive-suggestion-panel ${compact ? 'compact' : ''}`}>
      <header>
        <div>
          <p className="eyebrow">规则自动建议</p>
          <h3>归档信息建议</h3>
        </div>
        <span className="safe-badge">需人工确认</span>
      </header>
      <div className="suggestion-brief">
        <div><span>建议事项</span><strong title={suggestion.itemName || suggestion.workItem}>{suggestion.itemName || suggestion.workItem || '-'}</strong></div>
        <div><span>建议关键词</span><strong title={keywordsText}>{keywordsText || '-'}</strong></div>
        <div><span>主要来源</span><strong title={primarySource}>{primarySource}</strong></div>
      </div>
      {showDetails && <p className="suggestion-confidence">{suggestion.confidenceText || '建议仅用于辅助填写，归档前请人工确认。'}</p>}
      {showDetails && suggestion.sources?.length > 0 && (
        <div className="suggestion-source-list">
          {suggestion.sources.map((source) => <span key={source}>{source}</span>)}
        </div>
      )}
      {showDetails && <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd title={String(value)}>{String(value)}</dd>
          </div>
        ))}
      </dl>}
      <footer>
        <button type="button" className="primary" onClick={onApply}>应用建议</button>
        <button type="button" onClick={onApplyEmpty}>只填空字段</button>
        <button type="button" className="ghost" onClick={onIgnore}>忽略建议</button>
        {compact && <button type="button" className="ghost" onClick={() => setExpanded((value) => !value)}>{expanded ? '收起详情' : '查看详情'}</button>}
      </footer>
    </section>
  );
}
