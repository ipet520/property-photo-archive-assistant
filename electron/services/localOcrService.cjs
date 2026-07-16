const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ocrComponentVersion: OCR_COMPONENT_VERSION } = require('../../package.json');

const RAPID_OCR_RUNNER = process.platform === 'win32' ? 'rapidocr-runner.exe' : 'rapidocr-runner';

async function diagnoseLocalOcr(providerConfig = {}, options = {}) {
  const resolved = await resolveLocalOcrCommand(providerConfig, options);
  return {
    available: resolved.available,
    engine: 'rapidocr',
    componentVersion: OCR_COMPONENT_VERSION,
    provider: 'local_ocr',
    source: resolved.source,
    executablePath: resolved.executablePath,
    error: resolved.error,
    command: resolved,
    reason: resolved.available
      ? `本地 OCR：已内置；引擎 RapidOCR-ONNX；来源 ${resolved.source}。`
      : resolved.error
  };
}

async function runLocalOcr(imagePath, providerConfig = {}, options = {}) {
  const started = Date.now();
  const resolved = await resolveLocalOcrCommand(providerConfig, options);
  if (!resolved.available) {
    return createOcrResult({
      success: false,
      text: '',
      started,
      error: resolved.error,
      resolved
    });
  }
  const timeoutMs = Number(providerConfig.timeoutMs || options.timeoutMs || 15000);
  try {
    const output = await spawnWithTimeout(resolved.executablePath, ['--image', imagePath], timeoutMs);
    const parsed = parseRunnerJson(output.stdout);
    if (!parsed.ok) {
      return createOcrResult({
        success: false,
        text: '',
        started,
        error: parsed.error,
        stderr: output.stderr,
        resolved
      });
    }
    const success = parsed.value.success === true;
    const text = normalizeOcrText(parsed.value.text || '');
    return createOcrResult({
      success,
      text,
      started,
      error: success ? (text ? null : 'RapidOCR 执行成功，但未识别到有效水印文字。') : (parsed.value.error || 'RapidOCR 返回失败。'),
      stderr: output.stderr,
      resolved,
      items: Array.isArray(parsed.value.items) ? parsed.value.items : [],
      runnerDurationMs: parsed.value.durationMs
    });
  } catch (error) {
    return createOcrResult({
      success: false,
      text: '',
      started,
      error: error.message || 'RapidOCR 执行失败。',
      resolved
    });
  }
}

async function resolveLocalOcrCommand(providerConfig = {}, options = {}) {
  const candidates = [
    buildBundledProductionCandidate(options),
    buildBundledDevCandidate(),
    ...buildConfiguredCandidates(providerConfig),
    { executablePath: RAPID_OCR_RUNNER, source: 'system-path', isPathCommand: true }
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.isPathCommand) {
      if (await commandExistsOnPath(candidate.executablePath)) {
        return createAvailableCandidate(candidate);
      }
      continue;
    }
    if (await fileExists(candidate.executablePath)) return createAvailableCandidate(candidate);
  }
  return {
    available: false,
    engine: 'rapidocr',
    provider: 'local_ocr',
    source: 'none',
    executablePath: '',
    error: '未检测到内置 RapidOCR 执行器。请确认 vendor/ocr/rapidocr/rapidocr-runner.exe 已随软件打包。'
  };
}

function buildBundledProductionCandidate(options = {}) {
  const resourcesPath = options.resourcesPath || process.resourcesPath;
  if (!resourcesPath) return null;
  return {
    executablePath: path.join(resourcesPath, 'ocr', 'rapidocr', RAPID_OCR_RUNNER),
    source: 'rapidocr-bundled-production'
  };
}

function buildBundledDevCandidate() {
  return {
    executablePath: path.join(process.cwd(), 'vendor', 'ocr', 'rapidocr', RAPID_OCR_RUNNER),
    source: 'rapidocr-bundled-dev'
  };
}

function buildConfiguredCandidates(providerConfig = {}) {
  const commandPath = String(providerConfig.extraOptions?.commandPath || providerConfig.commandPath || '').trim();
  if (!commandPath) return [];
  return [{ executablePath: commandPath, source: 'external-config' }];
}

function createAvailableCandidate(candidate) {
  return {
    available: true,
    engine: 'rapidocr',
    provider: 'local_ocr',
    source: candidate.source,
    executablePath: candidate.executablePath,
    error: null
  };
}

function parseRunnerJson(stdout = '') {
  const text = String(stdout || '').trim();
  if (!text) return { ok: false, error: 'RapidOCR 未输出 JSON。' };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: `RapidOCR stdout JSON 解析失败：${error.message}` };
  }
}

function spawnWithTimeout(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('RapidOCR 执行超时。'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || `RapidOCR 退出码：${code}`));
    });
  });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function commandExistsOnPath(command) {
  const checker = process.platform === 'win32' ? 'where' : 'command';
  const args = process.platform === 'win32' ? [command] : ['-v', command];
  return new Promise((resolve) => {
    const child = spawn(checker, args, { windowsHide: true, shell: process.platform !== 'win32' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

function normalizeOcrText(value = '') {
  return String(value || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function createOcrResult({ success, text, started, error, stderr = '', resolved = {}, items = [], runnerDurationMs = null }) {
  return {
    engine: 'local',
    provider: 'local_ocr',
    ocrEngine: 'rapidocr',
    componentVersion: OCR_COMPONENT_VERSION,
    source: resolved.source || 'none',
    executablePath: resolved.executablePath || '',
    success,
    text: String(text || ''),
    items,
    confidence: calculateAggregateConfidence(items),
    durationMs: Number.isFinite(Number(runnerDurationMs)) ? Number(runnerDurationMs) : Date.now() - started,
    stderr: String(stderr || ''),
    error: success ? null : String(error || 'RapidOCR 执行失败。')
  };
}

function calculateAggregateConfidence(items = []) {
  let weightedScore = 0;
  let totalWeight = 0;
  for (const item of Array.isArray(items) ? items : []) {
    const rawScore = Number(item?.score);
    if (!Number.isFinite(rawScore)) continue;
    const score = rawScore > 1 && rawScore <= 100 ? rawScore / 100 : rawScore;
    if (score < 0 || score > 1) continue;
    const weight = Math.max(1, Array.from(String(item?.text || '').trim()).length);
    weightedScore += score * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? Number((weightedScore / totalWeight).toFixed(4)) : null;
}

module.exports = {
  OCR_COMPONENT_VERSION,
  diagnoseLocalOcr,
  runLocalOcr,
  resolveLocalOcrCommand
};
