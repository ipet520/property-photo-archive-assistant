const path = require('node:path');
const { loadConfigs } = require('./configService.cjs');
const {
  buildMarkiStructuredImportBundle
} = require('./markiStructuredImportService.cjs');
const {
  saveMarkiSourceMetadata
} = require('./markiSourceMetadataService.cjs');

const WORKBENCH_IMPORT_PACKAGE_KEYS = Object.freeze([
  'batchId',
  'photos',
  'recognitionResultsByPhoto',
  'watermarkRecordsByPhoto',
  'archiveSuggestionsByPhoto'
]);

class MarkiImportOrchestratorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MarkiImportOrchestratorError';
    this.code = code;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message
    };
  }
}

async function prepareMarkiStructuredImport(input = {}, options = {}) {
  const normalizedInput = validateInput(input);
  const dependencies = resolveDependencies(options);
  const configs = await loadImportConfigs(
    dependencies.loadConfigs,
    normalizedInput.documentsPath
  );
  const bundle = buildImportBundle(
    dependencies.buildStructuredImportBundle,
    normalizedInput,
    configs,
    options
  );
  const metadataEntries = validateAndSortMetadataEntries(bundle);
  const failures = [];
  let metadataSavedCount = 0;

  for (const [sourceMetadataRef, record] of metadataEntries) {
    try {
      await dependencies.saveSourceMetadata(
        normalizedInput.documentsPath,
        record,
        buildMetadataSaveOptions(options)
      );
      metadataSavedCount += 1;
    } catch (error) {
      failures.push(buildSafeMetadataFailure(sourceMetadataRef, record, error));
    }
  }

  const failedCount = failures.length;
  const success = failedCount === 0;
  return {
    success,
    batchId: bundle.workbenchImportPackage.batchId,
    inputCount: normalizedInput.items.length,
    metadataSavedCount,
    failedCount,
    failures,
    deduplication: bundle.deduplication,
    workbenchImportPackage: success ? bundle.workbenchImportPackage : null
  };
}

function validateInput(input) {
  if (!isPlainObject(input)) {
    throw createOrchestratorError(
      'marki_import_input_invalid',
      '马克结构化导入参数无效。'
    );
  }
  const documentsPath = String(input.documentsPath || '').trim();
  if (
    !documentsPath
    || !path.isAbsolute(documentsPath)
    || /[\u0000-\u001f\u007f]/.test(documentsPath)
  ) {
    throw createOrchestratorError(
      'marki_import_documents_path_invalid',
      '马克结构化导入文档目录无效。'
    );
  }
  const orgId = String(input.orgId ?? '').trim();
  if (!/^\d+$/.test(orgId)) {
    throw createOrchestratorError(
      'marki_import_org_id_invalid',
      '马克结构化导入组织 ID 无效。'
    );
  }
  if (!Array.isArray(input.items)) {
    throw createOrchestratorError(
      'marki_import_items_invalid',
      '马克结构化导入照片列表无效。'
    );
  }
  return {
    documentsPath,
    orgId,
    items: input.items
  };
}

function resolveDependencies(options) {
  const dependencies = {
    loadConfigs: options.loadConfigs || loadConfigs,
    buildStructuredImportBundle: (
      options.buildStructuredImportBundle || buildMarkiStructuredImportBundle
    ),
    saveSourceMetadata: options.saveSourceMetadata || saveMarkiSourceMetadata
  };
  if (Object.values(dependencies).some((dependency) => typeof dependency !== 'function')) {
    throw createOrchestratorError(
      'marki_import_dependency_invalid',
      '马克结构化导入服务配置无效。'
    );
  }
  return dependencies;
}

async function loadImportConfigs(loadConfigsImpl, documentsPath) {
  let loadedConfigs;
  try {
    loadedConfigs = await loadConfigsImpl(documentsPath);
  } catch {
    throw createOrchestratorError(
      'marki_import_config_load_failed',
      '无法读取马克导入所需的项目和归档分类配置。'
    );
  }
  if (
    !isPlainObject(loadedConfigs)
    || !Array.isArray(loadedConfigs.projects)
    || !isPlainObject(loadedConfigs.watermarkCategories)
  ) {
    throw createOrchestratorError(
      'marki_import_config_invalid',
      '马克导入所需的项目和归档分类配置无效。'
    );
  }
  return {
    projects: loadedConfigs.projects,
    watermarkCategories: loadedConfigs.watermarkCategories
  };
}

function buildImportBundle(buildBundle, input, configs, options) {
  try {
    return buildBundle({
      orgId: input.orgId,
      items: input.items,
      configs
    }, buildBundleOptions(options));
  } catch {
    throw createOrchestratorError(
      'marki_import_bundle_build_failed',
      '马克结构化导入数据转换失败，请检查照片数据后重试。'
    );
  }
}

function buildBundleOptions(options) {
  const bundleOptions = {};
  if (Object.hasOwn(options, 'batchId')) bundleOptions.batchId = options.batchId;
  if (Object.hasOwn(options, 'now')) bundleOptions.now = options.now;
  if (Object.hasOwn(options, 'activeProject')) bundleOptions.activeProject = options.activeProject;
  return bundleOptions;
}

function buildMetadataSaveOptions(options) {
  const saveOptions = {};
  if (Object.hasOwn(options, 'now')) saveOptions.now = options.now;
  return saveOptions;
}

function validateAndSortMetadataEntries(bundle) {
  if (
    !isPlainObject(bundle)
    || !isPlainObject(bundle.workbenchImportPackage)
    || !isPlainObject(bundle.sourceMetadataRecordsByRef)
    || !isPlainObject(bundle.deduplication)
  ) {
    throw createOrchestratorError(
      'marki_import_bundle_invalid',
      '马克结构化导入转换结果无效。'
    );
  }
  const packageKeys = Object.keys(bundle.workbenchImportPackage);
  if (
    packageKeys.length !== WORKBENCH_IMPORT_PACKAGE_KEYS.length
    || WORKBENCH_IMPORT_PACKAGE_KEYS.some((key) => !packageKeys.includes(key))
    || !String(bundle.workbenchImportPackage.batchId || '').trim()
  ) {
    throw createOrchestratorError(
      'marki_import_bundle_invalid',
      '马克结构化导入转换结果无效。'
    );
  }

  const entries = Object.entries(bundle.sourceMetadataRecordsByRef)
    .sort(([left], [right]) => left.localeCompare(right, 'en'));
  for (const [sourceMetadataRef, record] of entries) {
    if (
      !isSafeIdentifier(sourceMetadataRef)
      || !isPlainObject(record)
      || record.sourceMetadataRef !== sourceMetadataRef
      || !isSafeIdentifier(record.sourceKey)
    ) {
      throw createOrchestratorError(
        'marki_import_bundle_invalid',
        '马克结构化导入转换结果无效。'
      );
    }
  }
  return entries;
}

function buildSafeMetadataFailure(sourceMetadataRef, record, error) {
  const errorCode = String(error?.code || '').trim();
  return {
    sourceMetadataRef,
    sourceKey: record.sourceKey,
    code: /^marki_[a-z0-9_]{1,90}$/.test(errorCode)
      ? errorCode
      : 'marki_source_metadata_save_failed',
    message: '马克来源元数据保存失败，请重试。'
  };
}

function isSafeIdentifier(value) {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= 500
    && !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function createOrchestratorError(code, message) {
  return new MarkiImportOrchestratorError(code, message);
}

module.exports = {
  MarkiImportOrchestratorError,
  WORKBENCH_IMPORT_PACKAGE_KEYS,
  prepareMarkiStructuredImport
};
