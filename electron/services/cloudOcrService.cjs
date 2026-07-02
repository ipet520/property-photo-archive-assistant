const fs = require('node:fs/promises');

async function runCustomCloudOcr(imagePath, providerConfig = {}, options = {}) {
  const started = Date.now();
  const endpoint = String(providerConfig.endpoint || '').trim();
  if (!endpoint) return createCloudResult(false, '', started, 'custom_ocr 未配置 endpoint。');
  if (!options.allowCloudUpload) return createCloudResult(false, '', started, '未授权上传裁剪后的水印区域，已阻止云端 OCR。');
  const apiKey = String(providerConfig.apiKey || providerConfig.extraOptions?.apiKey || '').trim();
  if (!apiKey && providerConfig.extraOptions?.requireAuth !== false) {
    return createCloudResult(false, '', started, 'custom_ocr 鉴权信息未配置。');
  }

  try {
    const method = String(providerConfig.extraOptions?.method || 'POST').toUpperCase();
    const bodyType = String(providerConfig.extraOptions?.bodyType || 'json').toLowerCase();
    const imageField = String(providerConfig.extraOptions?.imageField || 'image');
    const useBase64 = providerConfig.extraOptions?.useBase64 !== false;
    const headers = buildHeaders(providerConfig, apiKey);
    const imageBuffer = await fs.readFile(imagePath);
    const request = bodyType === 'multipart'
      ? buildMultipartRequest(imageBuffer, imageField, headers, providerConfig)
      : buildJsonRequest(imageBuffer, imageField, headers, providerConfig, useBase64);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(providerConfig.timeoutMs || 15000));
    const response = await fetch(endpoint, {
      method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal
    });
    clearTimeout(timer);
    const raw = await response.text();
    if (!response.ok) return createCloudResult(false, '', started, `custom_ocr 请求失败：HTTP ${response.status} ${raw.slice(0, 160)}`);
    const parsed = parseJson(raw);
    const textPath = String(providerConfig.extraOptions?.textPath || 'data.text');
    const text = extractByPath(parsed, textPath) || rawTextFallback(parsed);
    if (!String(text || '').trim()) return createCloudResult(false, '', started, 'custom_ocr 返回中未解析到文本。', raw);
    return createCloudResult(true, String(text).trim(), started, null, raw);
  } catch (error) {
    return createCloudResult(false, '', started, error.name === 'AbortError' ? 'custom_ocr 请求超时。' : (error.message || 'custom_ocr 请求失败。'));
  }
}

function buildHeaders(providerConfig, apiKey) {
  const extraHeaders = normalizeObject(providerConfig.extraOptions?.headers);
  const authHeaderName = String(providerConfig.extraOptions?.authHeaderName || 'Authorization');
  const authPrefix = String(providerConfig.extraOptions?.authPrefix || 'Bearer');
  const headers = { ...extraHeaders };
  if (apiKey && authHeaderName && !headers[authHeaderName]) {
    headers[authHeaderName] = authPrefix ? `${authPrefix} ${apiKey}` : apiKey;
  }
  return headers;
}

function buildJsonRequest(imageBuffer, imageField, headers, providerConfig, useBase64) {
  headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  const basePayload = normalizeObject(providerConfig.extraOptions?.payload);
  return {
    headers,
    body: JSON.stringify({
      ...basePayload,
      [imageField]: useBase64 ? imageBuffer.toString('base64') : Array.from(imageBuffer)
    })
  };
}

function buildMultipartRequest(imageBuffer, imageField, headers, providerConfig) {
  const form = new FormData();
  const blob = new Blob([imageBuffer], { type: 'image/png' });
  form.append(imageField, blob, 'watermark.png');
  Object.entries(normalizeObject(providerConfig.extraOptions?.payload)).forEach(([key, value]) => form.append(key, String(value)));
  delete headers['Content-Type'];
  return { headers, body: form };
}

function extractByPath(value, pathText) {
  const segments = String(pathText || '').split('.').filter(Boolean);
  let current = value;
  for (const segment of segments) {
    const arrayMatch = segment.match(/^(.+)\[\]\.?(.+)?$/);
    if (arrayMatch) {
      const list = current?.[arrayMatch[1]];
      if (!Array.isArray(list)) return '';
      const childKey = arrayMatch[2] || '';
      return list.map((item) => childKey ? item?.[childKey] : item).filter(Boolean).join('\n');
    }
    current = current?.[segment];
  }
  if (Array.isArray(current)) return current.join('\n');
  return current == null ? '' : String(current);
}

function rawTextFallback(value) {
  return extractByPath(value, 'words_result[].words')
    || extractByPath(value, 'data.words_result[].words')
    || extractByPath(value, 'text')
    || extractByPath(value, 'data.text');
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function normalizeObject(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return {}; }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function createCloudResult(success, text, started, error, rawResponse = '') {
  return {
    engine: 'cloud',
    provider: 'custom_ocr',
    success,
    text: String(text || ''),
    confidence: null,
    durationMs: Date.now() - started,
    error: success ? null : String(error || '云端 OCR 识别失败。'),
    rawResponse
  };
}

module.exports = {
  runCustomCloudOcr
};
