export const PROJECT_ASSIGNMENT_SOURCES = Object.freeze({
  ACTIVE_CONTEXT: 'active_project_context',
  MARKI_CONFIRMED: 'marki_structured_confirmed',
  LEGACY_CLAIMED: 'legacy_workspace_claimed'
});

export const PROJECT_CONTEXT_ERROR_CODES = Object.freeze({
  REQUIRED: 'active_project_required',
  INVALID: 'active_project_invalid',
  PHOTO_MISMATCH: 'photo_project_mismatch',
  PHOTO_UNRESOLVED: 'photo_project_unresolved',
  BATCH_MISMATCH: 'batch_project_mismatch',
  WORKSPACE_MISMATCH: 'workspace_project_mismatch',
  SOURCE_LOCKED: 'source_project_locked',
  FORM_MISMATCH: 'project_context_mismatch',
  FIELD_READONLY: 'project_field_readonly',
  HASH_CONFLICT: 'photo_hash_project_conflict'
});

const READONLY_PROJECT_FIELDS = Object.freeze([
  'projectId',
  'projectName',
  'project',
  'projectConfirmed',
  'projectSource',
  'projectAssignmentSource'
]);

export class ActiveProjectContextError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ActiveProjectContextError';
    this.code = code;
  }
}

export function getEnabledProjectOptions(runtimeConfigurationOrConfigs = {}) {
  const configs = runtimeConfigurationOrConfigs?.configs || runtimeConfigurationOrConfigs;
  return (Array.isArray(configs?.projectOptions) ? configs.projectOptions : [])
    .map((item) => ({
      id: cleanId(item?.id),
      name: cleanProjectText(item?.name)
    }))
    .filter((item) => item.id && item.name);
}

export function resolveActiveProject(projectId, runtimeConfigurationOrConfigs = {}) {
  const safeProjectId = cleanId(projectId);
  if (!safeProjectId) return null;
  const match = getEnabledProjectOptions(runtimeConfigurationOrConfigs)
    .find((item) => item.id === safeProjectId);
  return match ? Object.freeze({ projectId: match.id, projectName: match.name }) : null;
}

export function validateActiveProject(activeProject, runtimeConfigurationOrConfigs = {}) {
  if (!activeProject?.projectId || !activeProject?.projectName) {
    return {
      valid: false,
      code: PROJECT_CONTEXT_ERROR_CODES.REQUIRED,
      message: '请选择当前工作项目。'
    };
  }
  const resolved = resolveActiveProject(activeProject.projectId, runtimeConfigurationOrConfigs);
  if (!resolved || resolved.projectName !== cleanProjectText(activeProject.projectName)) {
    return {
      valid: false,
      code: PROJECT_CONTEXT_ERROR_CODES.INVALID,
      message: '当前项目已失效，请重新选择。'
    };
  }
  return { valid: true, activeProject: resolved };
}

export function requireActiveProject(activeProject, runtimeConfigurationOrConfigs = {}) {
  const validation = validateActiveProject(activeProject, runtimeConfigurationOrConfigs);
  if (!validation.valid) {
    throw new ActiveProjectContextError(validation.code, validation.message);
  }
  return validation.activeProject;
}

export function classifyPhotoProjectCompatibility({
  activeProject,
  projectOptions = [],
  sourceProjectText = '',
  assignedProjectId = '',
  assignedProjectName = ''
} = {}) {
  const current = normalizeActiveProjectValue(activeProject);
  if (!current) {
    return projectCompatibility(
      'active_project_required',
      false,
      PROJECT_CONTEXT_ERROR_CODES.REQUIRED,
      '请选择当前工作项目。'
    );
  }

  const lockedProjectId = cleanId(assignedProjectId);
  const lockedProjectName = cleanProjectText(assignedProjectName);
  if (
    (lockedProjectId && lockedProjectId !== current.projectId)
    || (lockedProjectName && lockedProjectName !== current.projectName)
  ) {
    return {
      ...projectCompatibility(
        'source_project_locked',
        false,
        PROJECT_CONTEXT_ERROR_CODES.SOURCE_LOCKED,
        `该照片已归属“${lockedProjectName || '其他项目'}”，不能加入当前项目“${current.projectName}”。`
      ),
      sourceProjectName: lockedProjectName
    };
  }

  const sourceText = cleanProjectText(sourceProjectText);
  if (!sourceText) {
    return {
      ...projectCompatibility('assign_current_project', true, '', ''),
      projectId: current.projectId,
      projectName: current.projectName,
      projectAssignmentSource: PROJECT_ASSIGNMENT_SOURCES.ACTIVE_CONTEXT,
      sourceProjectText: ''
    };
  }

  const normalizedOptions = (Array.isArray(projectOptions) ? projectOptions : [])
    .map((item) => ({ id: cleanId(item?.id), name: cleanProjectText(item?.name) }))
    .filter((item) => item.id && item.name);
  const exactMatch = normalizedOptions.find((item) => item.name === sourceText);
  if (!exactMatch) {
    return {
      ...projectCompatibility(
        'project_unresolved',
        false,
        PROJECT_CONTEXT_ERROR_CODES.PHOTO_UNRESOLVED,
        '照片项目无法确认，请检查项目配置或切换到正确项目。'
      ),
      sourceProjectText: sourceText
    };
  }
  if (exactMatch.id !== current.projectId) {
    return {
      ...projectCompatibility(
        'project_mismatch',
        false,
        PROJECT_CONTEXT_ERROR_CODES.PHOTO_MISMATCH,
        `项目不匹配：照片属于“${exactMatch.name}”，当前项目为“${current.projectName}”。`
      ),
      sourceProjectText: sourceText,
      matchedProjectId: exactMatch.id,
      matchedProjectName: exactMatch.name
    };
  }
  return {
    ...projectCompatibility('current_project', true, '', ''),
    projectId: current.projectId,
    projectName: current.projectName,
    projectAssignmentSource: PROJECT_ASSIGNMENT_SOURCES.MARKI_CONFIRMED,
    sourceProjectText: sourceText
  };
}

export function assignPhotoToActiveProject(photo = {}, activeProject, assignmentSource) {
  const current = normalizeActiveProjectValue(activeProject);
  if (!current) {
    throw new ActiveProjectContextError(
      PROJECT_CONTEXT_ERROR_CODES.REQUIRED,
      '请选择当前工作项目。'
    );
  }
  if (!Object.values(PROJECT_ASSIGNMENT_SOURCES).includes(assignmentSource)) {
    throw new ActiveProjectContextError(
      PROJECT_CONTEXT_ERROR_CODES.INVALID,
      '照片项目归属依据无效。'
    );
  }
  return {
    ...photo,
    projectId: current.projectId,
    projectName: current.projectName,
    projectAssignmentSource: assignmentSource
  };
}

export function applyActiveProjectToArchiveInfo(value = {}, activeProject, assignmentSource = '') {
  const current = normalizeActiveProjectValue(activeProject);
  if (!current) {
    throw new ActiveProjectContextError(
      PROJECT_CONTEXT_ERROR_CODES.REQUIRED,
      '请选择当前工作项目。'
    );
  }
  const source = cleanId(assignmentSource || value.projectAssignmentSource || value.projectSource)
    || PROJECT_ASSIGNMENT_SOURCES.ACTIVE_CONTEXT;
  return {
    ...value,
    projectId: current.projectId,
    projectName: current.projectName,
    project: current.projectName,
    projectConfirmed: true,
    projectSource: source,
    projectAssignmentSource: source
  };
}

export function validatePhotosForActiveProject(photos = [], activeProject) {
  const current = normalizeActiveProjectValue(activeProject);
  if (!current) {
    return {
      valid: false,
      code: PROJECT_CONTEXT_ERROR_CODES.REQUIRED,
      message: '请选择当前工作项目。',
      invalidPhotoIds: []
    };
  }
  const invalidPhotoIds = (Array.isArray(photos) ? photos : [])
    .filter((photo) => (
      cleanId(photo?.projectId) !== current.projectId
      || cleanProjectText(photo?.projectName) !== current.projectName
      || !Object.values(PROJECT_ASSIGNMENT_SOURCES).includes(cleanId(photo?.projectAssignmentSource))
    ))
    .map((photo) => cleanId(photo?.id))
    .filter(Boolean);
  return invalidPhotoIds.length
    ? {
        valid: false,
        code: PROJECT_CONTEXT_ERROR_CODES.PHOTO_MISMATCH,
        message: '照片项目归属与当前项目不一致，已停止处理。',
        invalidPhotoIds
      }
    : { valid: true, invalidPhotoIds: [] };
}

export function stripReadonlyProjectPatch(patch = {}) {
  const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const attemptedFields = READONLY_PROJECT_FIELDS.filter((field) => Object.hasOwn(source, field));
  return {
    patch: Object.fromEntries(
      Object.entries(source).filter(([field]) => !READONLY_PROJECT_FIELDS.includes(field))
    ),
    attemptedFields,
    warning: attemptedFields.length
      ? {
          code: PROJECT_CONTEXT_ERROR_CODES.FIELD_READONLY,
          message: '项目由当前工作上下文确定，不可在表单中修改。'
        }
      : null
  };
}

export function normalizeActiveProjectValue(value) {
  const projectId = cleanId(value?.projectId);
  const projectName = cleanProjectText(value?.projectName);
  return projectId && projectName ? { projectId, projectName } : null;
}

export function cleanProjectText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function projectCompatibility(status, selectable, code, message) {
  return { status, selectable, code, message };
}

function cleanId(value) {
  return String(value ?? '').trim();
}
