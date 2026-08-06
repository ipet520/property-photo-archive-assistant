export async function runMarkiRecoveryWithWorkspaceSnapshot({
  workspaceReady = false,
  workspaceSyncBlocked = false,
  currentWorkspace = null,
  activeProjectId = '',
  saveWorkspaceSnapshot,
  recover
} = {}) {
  const projectId = String(activeProjectId || '').trim();
  if (
    workspaceReady !== true
    || workspaceSyncBlocked === true
    || !currentWorkspace
    || String(currentWorkspace.projectId || '').trim() !== projectId
  ) {
    return {
      success: false,
      error: {
        code: 'marki_recovery_workspace_not_ready',
        message: '当前工作台尚未恢复完成，请稍后重试。'
      }
    };
  }
  if (typeof saveWorkspaceSnapshot !== 'function' || typeof recover !== 'function') {
    return {
      success: false,
      error: {
        code: 'marki_recovery_execution_unavailable',
        message: '马克照片恢复暂不可用，请重试。'
      }
    };
  }
  let snapshotSaveResult;
  try {
    snapshotSaveResult = await saveWorkspaceSnapshot(currentWorkspace);
  } catch {
    snapshotSaveResult = { success: false };
  }
  if (snapshotSaveResult?.success !== true) {
    return {
      success: false,
      error: {
        code: 'marki_recovery_snapshot_save_failed',
        message: '当前工作台保存失败，已停止恢复以避免覆盖未保存内容。'
      }
    };
  }
  return recover();
}
