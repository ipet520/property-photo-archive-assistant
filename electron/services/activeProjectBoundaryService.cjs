const ALLOWED_ASSIGNMENT_SOURCES = new Set([
  'active_project_context',
  'marki_structured_confirmed',
  'legacy_workspace_claimed'
]);

class ActiveProjectBoundaryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ActiveProjectBoundaryError';
    this.code = code;
  }
}

function normalizeActiveProjectAgainstRuntime(input, runtimeConfiguration) {
  const projectId = clean(input?.projectId);
  const projectName = cleanProjectName(input?.projectName);
  if (!projectId || !projectName) {
    throw new ActiveProjectBoundaryError('active_project_required', '请选择当前工作项目。');
  }
  const match = (runtimeConfiguration?.configs?.projectOptions || [])
    .find((item) => clean(item?.id) === projectId);
  if (!match || cleanProjectName(match.name) !== projectName) {
    throw new ActiveProjectBoundaryError('active_project_invalid', '当前项目已失效，请重新选择。');
  }
  return { projectId, projectName };
}

function assertBatchProject(batch, activeProject) {
  if (
    clean(batch?.projectId) !== clean(activeProject?.projectId)
    || cleanProjectName(batch?.projectName) !== cleanProjectName(activeProject?.projectName)
  ) {
    throw new ActiveProjectBoundaryError(
      'batch_project_mismatch',
      '马克导入批次与当前项目不一致。'
    );
  }
}

function assertArchivePreviewProject(payload, activeProject) {
  const photos = Array.isArray(payload?.photos) ? payload.photos : [];
  const mismatch = photos.some((photo) => (
    clean(photo?.projectId) !== clean(activeProject?.projectId)
    || cleanProjectName(photo?.projectName || photo?.project)
      !== cleanProjectName(activeProject?.projectName)
    || !ALLOWED_ASSIGNMENT_SOURCES.has(clean(photo?.projectAssignmentSource))
  ));
  if (mismatch) {
    throw new ActiveProjectBoundaryError(
      'project_context_mismatch',
      '照片项目归属与当前项目不一致，已停止生成预览。'
    );
  }
}

function attachActiveProjectToArchivePreview(result, activeProject) {
  if (result?.success !== true || !result.previewPlan) return result;
  return {
    ...result,
    previewPlan: {
      ...result.previewPlan,
      projectId: clean(activeProject?.projectId),
      projectName: cleanProjectName(activeProject?.projectName)
    }
  };
}

function assertArchivePlanProject(archivePlan, activeProject) {
  const plan = archivePlan?.previewPlan;
  const items = Array.isArray(plan?.items) ? plan.items : [];
  const mismatch = (
    clean(plan?.projectId) !== clean(activeProject?.projectId)
    || cleanProjectName(plan?.projectName) !== cleanProjectName(activeProject?.projectName)
    || items.some((item) => (
      cleanProjectName(item?.ledgerRow?.project) !== cleanProjectName(activeProject?.projectName)
    ))
  );
  if (mismatch) {
    throw new ActiveProjectBoundaryError(
      'project_context_mismatch',
      '归档计划与当前项目不一致，请重新生成预览。'
    );
  }
}

function clean(value) {
  return String(value ?? '').trim();
}

function cleanProjectName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = {
  ActiveProjectBoundaryError,
  assertArchivePlanProject,
  assertArchivePreviewProject,
  assertBatchProject,
  attachActiveProjectToArchivePreview,
  normalizeActiveProjectAgainstRuntime
};
