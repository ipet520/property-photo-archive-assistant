export const PROJECT_DIRECTORY_TYPES = Object.freeze({
  archiveRoot: 'archive_root',
  packageExport: 'package_export'
});

export function normalizeProjectDirectoryPreferences(result, activeProject) {
  const source = result?.preferences || result || {};
  return {
    projectId: clean(source.projectId) || clean(activeProject?.projectId),
    archiveRootDirectory: clean(source.archiveRootDirectory),
    packageExportDirectory: clean(source.packageExportDirectory),
    updatedAt: clean(source.updatedAt)
  };
}

export function buildProjectDirectoryState(directory, healthResult, labels = {}) {
  const configuredPath = clean(directory);
  const health = healthResult?.health || healthResult || null;
  const healthy = Boolean(
    configuredPath
    && health?.healthStatus === 'healthy'
    && clean(health.normalizedPath) === configuredPath
  );
  const invalid = Boolean(configuredPath && health && !healthy);
  return {
    configuredPath,
    healthy,
    invalid,
    canOpen: healthy,
    canClear: Boolean(configuredPath),
    selectLabel: invalid
      ? labels.reselect || '重新选择目录'
      : configuredPath
        ? labels.change || '更改目录'
        : labels.select || '选择目录',
    displayText: configuredPath || labels.empty || '未设置'
  };
}

export function isArchivePreviewPlanCurrent(plan, activeProject, archiveRootDirectory) {
  if (!plan) return false;
  return (
    clean(plan.projectId) === clean(activeProject?.projectId)
    && clean(plan.archiveRoot || plan.archiveRootDirectory) === clean(archiveRootDirectory)
  );
}

export function resolveLegacyDirectoryInitialPath(runtimeConfiguration, directoryType) {
  if (directoryType === PROJECT_DIRECTORY_TYPES.archiveRoot) {
    return clean(runtimeConfiguration?.archiveRootDirectory);
  }
  if (directoryType === PROJECT_DIRECTORY_TYPES.packageExport) {
    return clean(runtimeConfiguration?.archivePackageDirectory);
  }
  return '';
}

function clean(value) {
  return String(value || '').trim();
}
