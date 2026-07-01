import { useEffect, useMemo, useState } from 'react';
import {
  buildFormPatchDraft,
  createReviewDecision,
  getRecognitionReadOnlyBundleByPhoto
} from '../../utils/recognitionClient.js';

const emptyBundle = {
  stagedResult: null,
  candidateFieldSet: null,
  reviewDraft: null,
  reviewDecision: null,
  formPatchDraft: null,
  warnings: [],
  errors: []
};

export default function RecognitionReadOnlyPanel({ currentPhoto, formSnapshot = null }) {
  const photoInput = useMemo(() => buildPhotoInput(currentPhoto), [currentPhoto]);
  const photoKey = `${photoInput.photoId || ''}::${photoInput.filePath || ''}`;
  const [state, setState] = useState({ loading: false, error: '', bundle: emptyBundle });
  const [fieldDraftActions, setFieldDraftActions] = useState({});
  const [draftStatus, setDraftStatus] = useState({ type: 'idle', text: '' });
  const [isGenerating, setIsGenerating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFieldDraftActions({});
    setDraftStatus({ type: 'idle', text: '' });
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
  }, [photoKey, photoInput.photoId, photoInput.filePath]);

  const { bundle, loading, error } = state;
  const hasData = Boolean(
    bundle.stagedResult
    || bundle.candidateFieldSet
    || bundle.reviewDraft
    || bundle.reviewDecision
    || bundle.formPatchDraft
  );
  const riskMessages = buildRiskMessages(bundle);

  async function refreshBundle() {
    const nextBundle = await getRecognitionReadOnlyBundleByPhoto(photoInput);
    setState({ loading: false, error: '', bundle: nextBundle || emptyBundle });
    return nextBundle;
  }

  function updateFieldDraftAction(candidateFieldId, patch) {
    setFieldDraftActions((current) => ({
      ...current,
      [candidateFieldId]: {
        action: '',
        decidedValue: '',
        ...(current[candidateFieldId] || {}),
        ...patch
      }
    }));
  }

  async function generateReviewDraft() {
    if (isGenerating) return;
    if (!currentPhoto) {
      setDraftStatus({ type: 'error', text: '请先选择照片。' });
      return;
    }
    if (!bundle.reviewDraft) {
      setDraftStatus({ type: 'error', text: '暂无人工确认草稿，当前不能生成确认草稿。' });
      return;
    }
    const fields = Array.isArray(bundle.candidateFieldSet?.fields) ? bundle.candidateFieldSet.fields : [];
    const fieldDecisions = fields.map((field) => {
      const draftAction = fieldDraftActions[field.id] || {};
      const action = String(draftAction.action || '');
      if (!action) return null;
      if (action === 'edit' && String(draftAction.decidedValue || '').trim() === '') {
        return {
          invalid: true,
          candidateFieldId: field.id,
          message: `“${field.label || field.sourceFieldKey || '候选字段'}”选择了编辑，但确认值为空。`
        };
      }
      return {
        candidateFieldId: field.id,
        action,
        decidedValue: action === 'edit' ? draftAction.decidedValue : undefined,
        reason: '用户在识别确认区显式生成确认草稿。'
      };
    }).filter(Boolean);
    const invalidDecision = fieldDecisions.find((item) => item.invalid);
    if (invalidDecision) {
      setDraftStatus({ type: 'error', text: invalidDecision.message });
      return;
    }
    const validDecisions = fieldDecisions.filter((item) => !item.invalid);
    if (validDecisions.length === 0) {
      setDraftStatus({ type: 'warning', text: '请至少选择一个候选字段处理方式。' });
      return;
    }
    setIsGenerating(true);
    setDraftStatus({ type: 'idle', text: '正在生成确认草稿...' });
    try {
      const reviewDecision = await createReviewDecision({
        reviewDraftId: bundle.reviewDraft.id,
        fieldDecisions: validDecisions
      });
      if (!reviewDecision) {
        setDraftStatus({ type: 'error', text: '确认草稿生成失败，未修改归档表单。' });
        return;
      }
      const patchDraft = await buildFormPatchDraft({
        reviewDecisionId: reviewDecision.id,
        formSnapshot: isPlainObject(formSnapshot) ? formSnapshot : undefined
      });
      await refreshBundle();
      setDraftStatus({
        type: patchDraft ? 'success' : 'warning',
        text: patchDraft
          ? '已生成确认草稿和待应用补丁草稿，尚未应用到表单。'
          : '已生成确认草稿，但待应用补丁草稿生成失败；未修改归档表单。'
      });
    } catch (generateError) {
      setDraftStatus({ type: 'error', text: generateError.message || '生成确认草稿失败，未修改归档表单。' });
    } finally {
      setIsGenerating(false);
    }
  }

  return (
    <section className="recognition-readonly-panel" aria-label="识别确认草稿信息">
      <header>
        <div>
          <strong>识别确认（草稿）</strong>
          <span>生成草稿仅用于核对，当前版本不会写入表单</span>
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
          <CandidateFieldTable
            candidateFieldSet={bundle.candidateFieldSet}
            fieldDraftActions={fieldDraftActions}
            onDraftActionChange={updateFieldDraftAction}
          />
          <DraftActionBar
            candidateFieldSet={bundle.candidateFieldSet}
            reviewDraft={bundle.reviewDraft}
            isGenerating={isGenerating}
            status={draftStatus}
            onGenerate={generateReviewDraft}
          />
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

function CandidateFieldTable({ candidateFieldSet, fieldDraftActions, onDraftActionChange }) {
  const fields = Array.isArray(candidateFieldSet?.fields) ? candidateFieldSet.fields : [];
  return (
    <MiniSection title="候选字段">
      {fields.length === 0 ? (
        <EmptyLine text="暂无候选字段可确认。" />
      ) : (
        <div className="recognition-readonly-table">
          <div className="recognition-readonly-row interactive heading">
            <span>字段</span>
            <span>候选值</span>
            <span>确认值</span>
            <span>目标字段</span>
            <span>状态</span>
            <span>操作</span>
            <span>提示</span>
          </div>
          {fields.map((field) => (
            <div className="recognition-readonly-row interactive" key={field.id || `${field.sourceFieldKey}-${field.targetFieldKey}`}>
              <span title={field.label || field.sourceFieldKey}>{field.label || field.sourceFieldKey || '-'}</span>
              <span title={formatValue(field.normalizedValue ?? field.value)}>{formatValue(field.normalizedValue ?? field.value)}</span>
              <span>
                {(fieldDraftActions[field.id]?.action === 'edit') ? (
                  <input
                    type="text"
                    value={fieldDraftActions[field.id]?.decidedValue || ''}
                    onChange={(event) => onDraftActionChange(field.id, { decidedValue: event.target.value })}
                    placeholder="输入确认值"
                  />
                ) : (
                  <em>{formatDecisionValue(field, fieldDraftActions[field.id])}</em>
                )}
              </span>
              <span>{field.targetFieldKey === 'unmapped' ? '未映射' : (field.targetFieldKey || '-')}</span>
              <span>{field.canApply ? '可应用' : '不可应用'} / {field.requiresReview ? '需人工确认' : '无需确认'}</span>
              <span className="recognition-action-pills">
                {['accept', 'reject', 'ignore', 'edit'].map((action) => (
                  <button
                    type="button"
                    className={fieldDraftActions[field.id]?.action === action ? 'active' : ''}
                    key={action}
                    onClick={() => onDraftActionChange(field.id, {
                      action,
                      decidedValue: action === 'edit'
                        ? String(fieldDraftActions[field.id]?.decidedValue || valueForEdit(field))
                        : ''
                    })}
                  >
                    {actionLabel(action)}
                  </button>
                ))}
              </span>
              <span title={field.warning || field.error || ''}>{buildFieldHint(field, fieldDraftActions[field.id])}</span>
            </div>
          ))}
        </div>
      )}
      <MessageList warnings={candidateFieldSet?.warnings} errors={candidateFieldSet?.errors} />
    </MiniSection>
  );
}

function DraftActionBar({ candidateFieldSet, reviewDraft, isGenerating, status, onGenerate }) {
  const fields = Array.isArray(candidateFieldSet?.fields) ? candidateFieldSet.fields : [];
  if (fields.length === 0) return null;
  return (
    <div className="recognition-draft-actionbar">
      <div>
        <strong>当前不会写入表单</strong>
        <span>只会生成 ReviewDecision 和 FormPatchDraft 草稿。</span>
      </div>
      <button type="button" onClick={onGenerate} disabled={isGenerating || !reviewDraft}>
        {isGenerating ? '生成中...' : '生成确认草稿'}
      </button>
      {status.text && <small className={status.type}>{status.text}</small>}
    </div>
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

function valueForEdit(field) {
  const value = field?.normalizedValue ?? field?.value;
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join('、');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
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

function actionLabel(action) {
  return {
    accept: '接受',
    reject: '拒绝',
    ignore: '忽略',
    edit: '编辑'
  }[action] || action;
}

function formatDecisionValue(field, draftAction = {}) {
  if (!draftAction?.action) return '未决定';
  if (draftAction.action === 'reject') return '拒绝，不生成补丁';
  if (draftAction.action === 'ignore') return '忽略，不生成补丁';
  if (draftAction.action === 'edit') return draftAction.decidedValue || '待输入确认值';
  return formatValue(field.normalizedValue ?? field.value);
}

function buildFieldHint(field, draftAction = {}) {
  if (!draftAction?.action) return field.canApply ? '待人工选择' : '不可应用，可拒绝或忽略';
  if (draftAction.action === 'edit' && !String(draftAction.decidedValue || '').trim()) return '编辑值不能为空';
  if (field.targetFieldKey === 'unmapped') return '未映射字段不会生成可应用补丁';
  if (!field.canApply && ['accept', 'edit'].includes(draftAction.action)) return '可生成草稿，但补丁会标记不可应用';
  return field.warning || field.error || '显式选择后才进入确认草稿';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
