const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');

const DIRECTORY_REQUIREMENT_KEYS = new Set([
  'readable',
  'writable',
  'allowCreate',
  'checkOnly'
]);

async function inspectDirectoryHealth(configuredPath, requirements = {}, options = {}) {
  const fileSystem = options.fs || fs;
  const normalizedRequirements = normalizeRequirements(requirements);
  const normalizedPath = normalizeDirectoryPath(configuredPath);
  const result = {
    configuredPath: String(configuredPath || ''),
    normalizedPath,
    exists: false,
    isDirectory: false,
    readable: false,
    writable: false,
    creatable: false,
    healthStatus: 'not_configured',
    errorCode: 'directory_not_configured',
    errorMessage: '目录尚未配置。'
  };

  if (!normalizedPath) return result;

  let stat;
  try {
    stat = await fileSystem.stat(normalizedPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return failure(result, 'unreadable', error?.code || 'directory_stat_failed', safeErrorMessage(error));
    }
    if (normalizedRequirements.allowCreate) {
      result.creatable = await canCreateDirectory(fileSystem, normalizedPath);
    }
    return {
      ...result,
      healthStatus: result.creatable ? 'creatable' : 'missing',
      errorCode: result.creatable ? '' : 'directory_missing',
      errorMessage: result.creatable ? '' : '目录不存在。'
    };
  }

  result.exists = true;
  result.isDirectory = stat.isDirectory();
  if (!result.isDirectory) {
    return failure(result, 'not_directory', 'path_not_directory', '配置路径不是目录。');
  }

  try {
    await fileSystem.access(normalizedPath, fsSync.constants.R_OK);
    result.readable = true;
  } catch (error) {
    return failure(result, 'unreadable', error?.code || 'directory_unreadable', safeErrorMessage(error));
  }

  if (normalizedRequirements.writable) {
    try {
      await fileSystem.access(normalizedPath, fsSync.constants.W_OK);
      result.writable = true;
    } catch (error) {
      return failure(result, 'unwritable', error?.code || 'directory_unwritable', safeErrorMessage(error));
    }
  } else {
    try {
      await fileSystem.access(normalizedPath, fsSync.constants.W_OK);
      result.writable = true;
    } catch {
      result.writable = false;
    }
  }

  return {
    ...result,
    creatable: false,
    healthStatus: 'healthy',
    errorCode: '',
    errorMessage: ''
  };
}

function normalizeDirectoryPath(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return path.normalize(path.resolve(text));
}

function normalizeRequirements(requirements) {
  if (!requirements || typeof requirements !== 'object' || Array.isArray(requirements)) {
    throw new TypeError('目录检查要求无效。');
  }
  for (const key of Object.keys(requirements)) {
    if (!DIRECTORY_REQUIREMENT_KEYS.has(key)) {
      throw new TypeError('目录检查要求包含未知字段。');
    }
  }
  return {
    readable: requirements.readable !== false,
    writable: requirements.writable === true,
    allowCreate: requirements.allowCreate === true,
    checkOnly: requirements.checkOnly !== false
  };
}

async function canCreateDirectory(fileSystem, targetPath) {
  let parent = path.dirname(targetPath);
  while (parent && parent !== path.dirname(parent)) {
    try {
      const stat = await fileSystem.stat(parent);
      if (!stat.isDirectory()) return false;
      await fileSystem.access(parent, fsSync.constants.W_OK);
      return true;
    } catch (error) {
      if (error?.code !== 'ENOENT') return false;
      parent = path.dirname(parent);
    }
  }
  return false;
}

function failure(base, healthStatus, errorCode, errorMessage) {
  return {
    ...base,
    healthStatus,
    errorCode,
    errorMessage
  };
}

function safeErrorMessage(error) {
  const code = String(error?.code || '').trim();
  return code ? `系统错误 ${code}` : '系统拒绝访问。';
}

module.exports = {
  inspectDirectoryHealth,
  normalizeDirectoryPath
};
