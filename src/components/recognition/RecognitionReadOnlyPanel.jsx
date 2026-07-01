import { useEffect, useMemo, useState } from 'react';
import { getRecognitionReadOnlyBundleByPhoto } from '../../utils/recognitionClient.js';

const emptyBundle = {
  stagedResult: null,
  candidateFieldSet: null,
  reviewDraft: null,
  reviewDecision: null,
  formPatchDraft: null,
  warnings: [],
  errors: []
};

export default function RecognitionReadOnlyPanel({ currentPhoto }) {
  const photoInput = useMemo(() => buildPhotoInput(currentPhoto), [currentPhoto]);
  const photoKey = `${photoInput.photoId || ''}::${photoInput.filePath || ''}`;
  const [state, setState] = useState({
    loading: false,
    error: '',
    bundle: emptyBundle
  });

  useEffect(() => {
    let cancelled = false;
    if (!photoInput.photoId && !photoInput.filePath) {
      setState({ loading: false, error: '', bundle: emptyBundle });
      return () => { cancelled = true; };
    }
    setState((current) => ({ ...current, loading: true, error: '' }));
    getRecognitionReadOnlyBundleByPhoto(photoInput)
      .then((bundle) => {
        if (cancelled) return;
        setState({ loading: false, error: '', bundle: bundle || emptyBundle });
      })
      .catch((error) => {
        if (cancelled) return;
        setState({
          loading: false,
          error: error.message || '识别确认信息读取失败。',
          bundle: emptyBundle
        });
      });
    return () => { cancelled = true; };
  }, [photoKey]);

  const { bundle, loading, error } = state;
  const hasData = Boolean(
    bundle.stagedResult
    || bundle.candidateFieldSet
    || bundle.reviewDraft
    || bundle.reviewDecision
    || bundle.formPatchDraft
  );
  const riskMessages = buildRiskMessages(bundle);

  return (
    <section className="recognition-readonly-panel" aria-label="识别确认只读信息">
      <header>
        <div>
          <strong>识别确认（只读）</strong>
          <span>仅供核对，当前版本不会自动写入表单</span>
        </div>
        <small>{loading ? '读取中' : (hasData ? '已有数据' : '无数据')}</small>
      </header>

      {!currentPhoto && <EmptyBlock text="请选择照片后查看识别确认信息。" />}
      {currentPhoto && loading && <EmptyBlock text="正在读取识别确认信息..." />}
      {currentPhoto && error && <EmptyBlock type="error" text="识别确认信息读取失败，不影响手工归档。" detail={error} />}
      {currentPhoto && !loading && !error && !hasData && <EmptyBlock text="暂无识别确认数据。" />}

      {currentPhoto && !loading && !error && hasData && (
        <div className="recognition-readonly-content">
          <StagedResultSummary stagedResult={bundle.stagedResult} />
          <CandidateFieldTable candidateFieldSet={bundle.candidateFieldSet} />
          <ReviewSummary reviewDraft={bundle.reviewDraft} reviewDecision={bundle.reviewDecision} />
          <PatchDraftTable formPatchDraft={bundle.formPatchDraft} />
          <RiskSummary messages={riskMessages} warnings={bundle.warnings} errors={bundle.errors} />
        </div>
      )}
    </section>
  );
}

function StagedResultSummary({ stagedResult }) {
  if (!stagedResult) return <MiniSection title="识别暂存状态"><EmptyLine text="暂无识别暂存数据。" /></MiniSection>;
  return (
    <MiniSection title="识别暂存状态">
      <dl className="recognition-readonly-grid">
        <div><dt>识别状态</dt><dd>{stagedResult.recognitionStatus || '-'}</dd></div>
        <div><dt>暂存状态</dt><dd>{stagedResult.stageStatus || '-'}</dd></div>
        <div><dt>Provider</dt><dd>{[stagedResult.providerId, stagedResult.providerType].filter(Boolean).join(' / ') || '-'}</dd></div>
        <div><dt>任务</dt><dd title={stagedResult.taskId}>{stagedResult.taskId || '-'}</dd></div>
        <div><dt>更新时间</dt><dd>{formatTime(stagedResult.updatedAt || stagedResult.createdAt)}</dd></div>
        <div><dt>原文</dt><dd>{stagedResult.rawText ? '已有识别原文' : '暂无识别原文'}</dd></div>
      </dl>
      <MessageList warnings={stagedResult.warnings} errors={stagedResult.errors} />
    </MiniSection>
  );
}

function CandidateFieldTable({ candidateFieldSet }) {
  const fields = Array.isArray(candidateFieldSet?.fields) ? candidateFieldSet.fields : [];
  return (
    <MiniSection title="候选字段">
      {fields.length === 0 ? (
        <EmptyLine text="暂无候选字段。" />
      ) : (
        <div className="recognition-readonly-table">
          <div className="recognition-readonly-row heading">
            <span>字段</span>
            <span>候选值</span>
            <span>目标字段</span>
            <span>状态</span>
          </div>
          {fields.map((field) => (
            <div className="recognition-readonly-row" key={field.id || `${field.sourceFieldKey}-${field.targetFieldKey}`}>
              <span title={field.label || field.sourceFieldKey}>{field.label || field.sourceFieldKey || '-'}</span>
              <span title={formatValue(field.normalizedValue ?? field.value)}>{formatValue(field.normalizedValue ?? field.value)}</span>
              <span>{field.targetFieldKey === 'unmapped' ? '未映射' : (field.targetFieldKey || '-')}</span>
              <span>{field.canApply ? '可应用' : '不可应用'} / {field.requiresReview ? '需人工确认' : '无需确认'}</span>
            </div>
          ))}
        </div>
      )}
      <MessageList warnings={candidateFieldSet?.warnings} errors={candidateFieldSet?.errors} />
    </MiniSection>
  );
}

function ReviewSummary({ reviewDraft, reviewDecision }) {
  return (
    <MiniSection title="人工确认草稿">
      {!reviewDraft ? (
        <EmptyLine text="暂无人工确认草稿。" />
      ) : (
        <dl className="recognition-readonly-grid">
          <div><dt>草稿状态</dt><dd>{reviewDraft.status || '-'}</dd></div>
          <div><dt>候选字段</dt><dd>{reviewDraft.summary?.total ?? 0}</dd></div>
          <div><dt>可应用</dt><dd>{reviewDraft.summary?.canApplyCount ?? 0}</dd></div>
          <div><dt>需确认</dt><dd>{reviewDraft.summary?.requiresReviewCount ?? 0}</dd></div>
          <div><dt>冲突</dt><dd>{reviewDraft.summary?.conflictCount ?? 0}</dd></div>
          <div><dt>无效</dt><dd>{reviewDraft.summary?.invalidCount ?? 0}</dd></div>
        </dl>
      )}
      {!reviewDecision ? (
        <EmptyLine text="暂无人工确认决策。" />
      ) : (
        <dl className="recognition-readonly-grid compact">
          <div><dt>决策状态</dt><dd>{reviewDecision.status || '-'}</dd></div>
          <div><dt>接受</dt><dd>{reviewDecision.summary?.acceptedCount ?? 0}</dd></div>
          <div><dt>编辑</dt><dd>{reviewDecision.summary?.editedCount ?? 0}</dd></div>
          <div><dt>拒绝/忽略</dt><dd>{(reviewDecision.summary?.rejectedCount ?? 0) + (reviewDecision.summary?.ignoredCount ?? 0)}</dd></div>
        </dl>
      )}
      <MessageList warnings={reviewDecision?.warnings} errors={reviewDecision?.errors} />
    </MiniSection>
  );
}

function PatchDraftTable({ formPatchDraft }) {
  const patches = Array.isArray(formPatchDraft?.patches) ? formPatchDraft.patches : [];
  return (
    <MiniSection title="表单补丁草稿">
      {!formPatchDraft ? (
        <EmptyLine text="暂无待应用补丁。" />
      ) : (
        <>
          <dl className="recognition-readonly-grid compact">
            <div><dt>补丁状态</dt><dd>{formPatchDraft.status || '-'}</dd></div>
            <div><dt>有效</dt><dd>{formPatchDraft.summary?.validCount ?? 0}</dd></div>
            <div><dt>不可应用</dt><dd>{formPatchDraft.summary?.blockedCount ?? 0}</dd></div>
            <div><dt>冲突</dt><dd>{formPatchDraft.summary?.conflictCount ?? 0}</dd></div>
          </dl>
          {patches.length === 0 ? (
            <EmptyLine text="暂无待应用补丁。" />
          ) : (
            <div className="recognition-readonly-table patch">
              <div className="recognition-readonly-row heading">
                <span>目标字段</span>
                <span>补丁值</span>
                <span>状态</span>
              </div>
              {patches.map((patch) => (
                <div className={`recognition-readonly-row ${patch.hasConflict ? 'warning' : ''}`} key={patch.id || `${patch.targetFieldKey}-${patch.candidateFieldId}`}>
                  <span>{patch.label || patch.targetFieldKey || '-'}</span>
                  <span title={formatValue(patch.normalizedValue ?? patch.value)}>{formatValue(patch.normalizedValue ?? patch.value)}</span>
                  <span>{patch.canApply ? '需明确应用' : '当前不可应用'}{patch.hasConflict ? ' / 存在冲突' : ''}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <MessageList warnings={formPatchDraft?.warnings} errors={formPatchDraft?.errors} />
    </MiniSection>
  );
}

function RiskSummary({ messages, warnings, errors }) {
  const allWarnings = [...(Array.isArray(messages) ? messages : []), ...(Array.isArray(warnings) ? warnings : [])];
  const allErrors = Array.isArray(errors) ? errors : [];
  if (allWarnings.length === 0 && allErrors.length === 0) return null;
  return (
    <MiniSection title="冲突与风险提示">
      <p className="recognition-readonly-risk">识别候选内容仅供核对，当前版本不会自动写入表单。</p>
      <MessageList warnings={allWarnings} errors={allErrors} />
    </MiniSection>
  );
}

function MiniSection({ title, children }) {
  return (
    <section className="recognition-readonly-section">
      <h4>{title}</h4>
      {children}
    </section>
  );
}

function EmptyBlock({ text, detail = '', type = 'empty' }) {
  return (
    <div className={`recognition-readonly-empty ${type}`}>
      <span>{text}</span>
      {detail && <small>{trimText(detail, 90)}</small>}
    </div>
  );
}

function EmptyLine({ text }) {
  return <p className="recognition-readonly-line">{text}</p>;
}

function MessageList({ warnings = [], errors = [] }) {
  const safeWarnings = normalizeMessages(warnings).slice(0, 3);
  const safeErrors = normalizeMessages(errors).slice(0, 3);
  if (safeWarnings.length === 0 && safeErrors.length === 0) return null;
  return (
    <ul className="recognition-readonly-messages">
      {safeWarnings.map((message, index) => <li className="warning" key={`w-${index}`}>{trimText(message, 90)}</li>)}
      {safeErrors.map((message, index) => <li className="error" key={`e-${index}`}>{trimText(message, 90)}</li>)}
    </ul>
  );
}

function buildPhotoInput(photo) {
  if (!photo) return { photoId: '', filePath: '' };
  return {
    photoId: String(photo.photoId || photo.id || ''),
    filePath: String(photo.filePath || photo.originalPath || photo.path || '')
  };
}

function buildRiskMessages(bundle = {}) {
  const patches = Array.isArray(bundle.formPatchDraft?.patches) ? bundle.formPatchDraft.patches : [];
  return [
    patches.some((patch) => patch.hasConflict) && '存在冲突字段，后续需人工确认后再处理。',
    patches.some((patch) => patch.canApply === false) && '存在当前不可应用字段，系统不会自动写入表单。'
  ].filter(Boolean);
}

function formatValue(value) {
  if (value === null || value === undefined || value === '') return '-';
  if (Array.isArray(value)) return value.length ? value.join('、') : '-';
  if (typeof value === 'object') return trimText(JSON.stringify(value), 80);
  return trimText(String(value), 80);
}

function formatTime(value) {
  if (!value) return '-';
  return String(value).replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

function normalizeMessages(values = []) {
  return (Array.isArray(values) ? values : [values]).map((item) => {
    if (!item) return '';
    if (typeof item === 'string') return item;
    return item.message || item.errorMessage || '';
  }).filter(Boolean);
}

function trimText(value = '', max = 80) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
