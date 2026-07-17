function getMarkiApi() {
  return window.archiveAssistant?.marki || null;
}

export async function getMarkiConfigStatus() {
  const api = getMarkiApi();
  if (!api?.getConfigStatus) return createUnavailableResult('马克平台配置接口不可用。');
  try {
    return await api.getConfigStatus();
  } catch {
    return createUnavailableResult('马克平台配置读取失败。');
  }
}

export async function saveMarkiConfig(input = {}) {
  const api = getMarkiApi();
  if (!api?.saveConfig) return createUnavailableResult('马克平台配置保存接口不可用。');
  try {
    return await api.saveConfig(input);
  } catch {
    return createUnavailableResult('马克平台配置保存失败。');
  }
}

export async function clearMarkiConfig() {
  const api = getMarkiApi();
  if (!api?.clearConfig) return createUnavailableResult('马克平台配置清除接口不可用。');
  try {
    return await api.clearConfig();
  } catch {
    return createUnavailableResult('马克平台配置清除失败。');
  }
}

export async function testMarkiConnection() {
  const api = getMarkiApi();
  if (!api?.testConnection) return createUnavailableResult('马克平台连接测试接口不可用。');
  try {
    return await api.testConnection();
  } catch {
    return createUnavailableResult('马克平台连接测试失败。');
  }
}

export async function listMarkiTeams() {
  const api = getMarkiApi();
  if (!api?.listTeams) return createUnavailableResult('马克平台团队查询接口不可用。');
  try {
    return await api.listTeams();
  } catch {
    return createUnavailableResult('马克平台团队查询失败。');
  }
}

export async function listMarkiMembers(input = {}) {
  const api = getMarkiApi();
  if (!api?.listMembers) return createUnavailableResult('马克平台成员查询接口不可用。');
  try {
    return await api.listMembers(input);
  } catch {
    return createUnavailableResult('马克平台成员查询失败。');
  }
}

function createUnavailableResult(message) {
  return {
    success: false,
    connectionStatus: 'error',
    error: {
      code: 'marki_client_unavailable',
      message
    }
  };
}
