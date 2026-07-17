const fs = require('node:fs/promises');
const path = require('node:path');

const CREDENTIAL_FILE_NAME = 'marki-credentials.json';
const CREDENTIAL_VERSION = 1;

function getMarkiCredentialPath(userDataDir) {
  return path.join(String(userDataDir || ''), CREDENTIAL_FILE_NAME);
}

async function getMarkiCredentialStatus(userDataDir, safeStorage) {
  const credentialPath = getMarkiCredentialPath(userDataDir);
  const encryptionAvailable = isEncryptionAvailable(safeStorage);
  try {
    const stored = await readStoredCredential(credentialPath);
    return {
      success: true,
      configured: Boolean(stored.orgId && stored.encryptedKey),
      credentialAvailable: encryptionAvailable,
      encryptionAvailable,
      orgId: String(stored.orgId || ''),
      updatedAt: String(stored.updatedAt || ''),
      connectionStatus: 'not_tested'
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        success: true,
        configured: false,
        credentialAvailable: encryptionAvailable,
        encryptionAvailable,
        orgId: '',
        updatedAt: '',
        connectionStatus: 'not_configured'
      };
    }
    return {
      success: false,
      configured: false,
      credentialAvailable: false,
      encryptionAvailable,
      orgId: '',
      updatedAt: '',
      connectionStatus: 'error',
      error: {
        code: 'marki_credential_status_failed',
        message: '马克平台安全配置读取失败。'
      }
    };
  }
}

async function saveMarkiCredentials(userDataDir, safeStorage, input = {}) {
  const orgId = normalizeOrgId(input.orgId);
  const key = String(input.key || '').trim();
  if (!orgId) {
    return createFailure('invalid_org_id', '组织 ID 必须为数字。');
  }
  if (!key) {
    return createFailure('missing_organization_key', '请输入组织 KEY。');
  }
  if (!isEncryptionAvailable(safeStorage)) {
    return createFailure('encryption_unavailable', '当前系统无法启用安全加密，组织 KEY 未保存。');
  }

  const credentialPath = getMarkiCredentialPath(userDataDir);
  const updatedAt = new Date().toISOString();
  const encryptedKey = safeStorage.encryptString(key).toString('base64');
  const stored = {
    version: CREDENTIAL_VERSION,
    orgId,
    encryptedKey,
    updatedAt
  };
  await writeJsonAtomic(credentialPath, stored);
  return {
    success: true,
    configured: true,
    credentialAvailable: true,
    encryptionAvailable: true,
    orgId,
    updatedAt,
    connectionStatus: 'not_tested'
  };
}

async function clearMarkiCredentials(userDataDir, safeStorage) {
  const credentialPath = getMarkiCredentialPath(userDataDir);
  await fs.rm(credentialPath, { force: true });
  return {
    success: true,
    configured: false,
    credentialAvailable: isEncryptionAvailable(safeStorage),
    encryptionAvailable: isEncryptionAvailable(safeStorage),
    orgId: '',
    updatedAt: '',
    connectionStatus: 'not_configured'
  };
}

async function loadMarkiCredentials(userDataDir, safeStorage) {
  if (!isEncryptionAvailable(safeStorage)) {
    throw createCredentialError('encryption_unavailable', '当前系统无法使用安全加密。');
  }
  const credentialPath = getMarkiCredentialPath(userDataDir);
  let stored;
  try {
    stored = await readStoredCredential(credentialPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw createCredentialError('marki_not_configured', '尚未配置马克平台组织信息。');
    }
    throw createCredentialError('marki_credential_read_failed', '马克平台安全配置读取失败。');
  }
  const orgId = normalizeOrgId(stored.orgId);
  if (!orgId || !stored.encryptedKey) {
    throw createCredentialError('marki_not_configured', '尚未配置马克平台组织信息。');
  }
  try {
    const key = safeStorage.decryptString(Buffer.from(stored.encryptedKey, 'base64'));
    if (!key) throw new Error('empty credential');
    return { orgId, key, updatedAt: String(stored.updatedAt || '') };
  } catch {
    throw createCredentialError(
      'marki_credential_unavailable',
      '组织 KEY 无法在当前 Windows 用户或设备上解密，请重新配置。'
    );
  }
}

async function readStoredCredential(credentialPath) {
  const content = await fs.readFile(credentialPath, 'utf8');
  const parsed = JSON.parse(content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid credential file');
  }
  return parsed;
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
  try {
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

function normalizeOrgId(value) {
  const text = String(value || '').trim();
  return /^\d+$/.test(text) ? text : '';
}

function isEncryptionAvailable(safeStorage) {
  try {
    return Boolean(safeStorage?.isEncryptionAvailable?.());
  } catch {
    return false;
  }
}

function createCredentialError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createFailure(code, message) {
  return {
    success: false,
    configured: false,
    error: { code, message }
  };
}

module.exports = {
  CREDENTIAL_FILE_NAME,
  clearMarkiCredentials,
  getMarkiCredentialPath,
  getMarkiCredentialStatus,
  loadMarkiCredentials,
  saveMarkiCredentials
};
