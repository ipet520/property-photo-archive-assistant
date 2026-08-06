const ABNORMAL_STATUSES = new Set([
  'corrupted_file',
  'workspace_file_corrupted',
  'workspace_file_unresolved',
  'missing_metadata',
  'invalid_record'
]);

export function summarizeMarkiRecoveryCandidates(items = []) {
  const summary = {
    recoverable: 0,
    alreadyInWorkbench: 0,
    alreadyArchived: 0,
    missingFile: 0,
    workspaceFileMissing: 0,
    workspaceFileCorrupted: 0,
    workspaceFileRepairable: 0,
    workspaceFileUnresolved: 0,
    abnormal: 0
  };
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.status === 'recoverable') summary.recoverable += 1;
    else if (item?.status === 'already_in_workbench') summary.alreadyInWorkbench += 1;
    else if (item?.status === 'already_archived') summary.alreadyArchived += 1;
    else if (item?.status === 'missing_file') summary.missingFile += 1;
    else if (item?.status === 'workspace_file_missing') summary.workspaceFileMissing += 1;
    else if (item?.status === 'workspace_file_corrupted') summary.workspaceFileCorrupted += 1;
    else if (item?.status === 'workspace_file_repairable') summary.workspaceFileRepairable += 1;
    else if (item?.status === 'workspace_file_unresolved') summary.workspaceFileUnresolved += 1;
    else if (ABNORMAL_STATUSES.has(item?.status)) summary.abnormal += 1;
  }
  return summary;
}

export function getRecoverableMarkiRecoveryTokens(items = []) {
  return Array.from(new Set(
    (Array.isArray(items) ? items : [])
      .filter((item) => item?.status === 'recoverable')
      .map((item) => String(item?.recoveryToken || '').trim())
      .filter(Boolean)
  ));
}

export function getRepairableMarkiRecoveryTokens(items = []) {
  return Array.from(new Set(
    (Array.isArray(items) ? items : [])
      .filter((item) => item?.status === 'workspace_file_repairable')
      .map((item) => String(item?.recoveryToken || '').trim())
      .filter(Boolean)
  ));
}

export function buildMarkiRecoveryCompletionNotice(result = {}) {
  if (result.status === 'repaired') {
    return `修复完成：恢复工作池文件 ${Number(result.repairedCount) || 0} 张，跳过 ${Number(result.skippedCount) || 0} 张。`;
  }
  return `恢复完成：新增 ${Number(result.recoveredCount) || 0} 张，跳过重复 ${Number(result.skippedCount) || 0} 张，失败 ${Number(result.failedCount) || 0} 张。`;
}
