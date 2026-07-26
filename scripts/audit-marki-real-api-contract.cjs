const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const AUDIT_PRELOAD_REQUESTED = process.env.MARKI_AUDIT_PRELOAD === '1';
const HAS_ELECTRON_CHILD_TYPE_ARGUMENT = process.argv.some((argument) =>
  String(argument).startsWith('--type=')
);
const IS_AUDIT_PRELOAD = AUDIT_PRELOAD_REQUESTED && !HAS_ELECTRON_CHILD_TYPE_ARGUMENT;
const IS_AUDIT_CHILD_PROCESS = AUDIT_PRELOAD_REQUESTED && HAS_ELECTRON_CHILD_TYPE_ARGUMENT;
const MAX_METADATA_RECORDS = 200;
const MAX_PHOTO_DOWNLOADS = 20;
const MAX_ACTIVE_PAGES = 30;
const MAX_SAMPLE_BYTES = 30 * 1024 * 1024;
const MOMENT_ENDPOINT = '/marki/moment';
const TEAM_ENDPOINT = '/marki/org/team';
const MEMBER_ENDPOINT = '/marki/team/mem';
const CANDIDATE_FILTER_FIELDS = [
  'markId',
  'watermarkId',
  'templateId',
  'markName',
  'isWatermarked',
  'hasWatermark',
  'watermarkStatus'
];
const IDENTITY_FIELDS = [
  'markId',
  'watermarkId',
  'templateId',
  'mediaId',
  'fileId',
  'assetId',
  'originalId',
  'originId',
  'parentId',
  'parentMomentId',
  'variantId',
  'version',
  'variantType',
  'imageVariant',
  'watermarkStatus',
  'markStatus',
  'isWatermarked',
  'hasWatermark'
];
const SAFE_CONTENT_LABELS = new Set([
  '日期',
  '时间',
  '日期时间',
  '拍摄时间',
  '地址',
  '地点',
  '位置',
  '项目',
  '小区名称',
  '工作内容',
  '工作备注',
  '水印',
  '水印名称',
  '水印模板',
  '车牌号码',
  '违停类型',
  '施工单位',
  '物业公司',
  '防伪码'
]);
let activeAuditPhase = 'offline';

if (IS_AUDIT_PRELOAD) {
  const Module = require('node:module');
  const productionMainPath = path.resolve(__dirname, '..', 'electron', 'main.cjs').toLowerCase();
  const originalCjsLoader = Module._extensions['.cjs'] || Module._extensions['.js'];
  Module._extensions['.cjs'] = function auditOnlyCjsLoader(module, filename) {
    if (path.resolve(filename).toLowerCase() === productionMainPath) {
      module._compile('module.exports = {};\n', filename);
      return;
    }
    originalCjsLoader(module, filename);
  };
}

class AuditError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
  }
}

function stableHash(value, salt = '') {
  return crypto
    .createHash('sha256')
    .update(String(salt))
    .update('\0')
    .update(String(value ?? ''))
    .digest('hex')
    .slice(0, 16);
}

function redactIdentifier(value, salt) {
  const text = String(value ?? '').trim();
  return text ? `hash:${stableHash(text, salt)}` : '接口未返回';
}

function normalizeScalar(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function safeFieldName(value, salt) {
  const text = String(value ?? '').trim();
  if (/^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/.test(text)) return text;
  if (SAFE_CONTENT_LABELS.has(text)) return text;
  return `field:${stableHash(text, salt)}`;
}

function parseContentEntries(content, salt) {
  if (!content) return [];
  let parsed = content;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const labels = [];
  for (const entry of parsed) {
    let label = '';
    if (Array.isArray(entry)) {
      label = entry[0];
    } else if (entry && typeof entry === 'object') {
      label = entry.label ?? entry.key ?? entry.name ?? entry.title;
    }
    if (String(label ?? '').trim()) labels.push(safeFieldName(label, salt));
  }
  return [...new Set(labels)].sort();
}

function fingerprintUrl(rawUrl, salt) {
  const text = String(rawUrl ?? '').trim();
  if (!text) {
    return {
      urlHash: '接口未返回',
      pathHash: '接口未返回',
      queryParameterCount: 0
    };
  }
  try {
    const parsed = new URL(text);
    return {
      urlHash: `hash:${stableHash(text, salt)}`,
      pathHash: `hash:${stableHash(`${parsed.origin}${parsed.pathname}`, salt)}`,
      queryParameterCount: [...parsed.searchParams.keys()].length
    };
  } catch {
    return {
      urlHash: `hash:${stableHash(text, salt)}`,
      pathHash: 'invalid_url',
      queryParameterCount: 0
    };
  }
}

function safeExplicitValue(value, salt) {
  if (value === undefined) return '接口未返回';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  const text = String(value).trim();
  if (!text) return '接口未返回';
  if (/^(watermarked|unwatermarked|original|unknown|true|false|yes|no|0|1)$/i.test(text)) {
    return text.toLowerCase();
  }
  return `hash:${stableHash(text, salt)}`;
}

function getFirstPresentField(record, fields, salt) {
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(record || {}, field)) {
      return {
        field,
        value: safeExplicitValue(record[field], salt)
      };
    }
  }
  return {
    field: '接口未返回',
    value: '接口未返回'
  };
}

function formatUtc8DateTime(date) {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const pad = (value) => String(value).padStart(2, '0');
  return [
    shifted.getUTCFullYear(),
    '-',
    pad(shifted.getUTCMonth() + 1),
    '-',
    pad(shifted.getUTCDate()),
    ' ',
    pad(shifted.getUTCHours()),
    ':',
    pad(shifted.getUTCMinutes()),
    ':',
    pad(shifted.getUTCSeconds())
  ].join('');
}

function getApiData(payload) {
  return payload && typeof payload.data === 'object' && payload.data !== null ? payload.data : {};
}

function getListFromData(data, keys) {
  for (const key of keys) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  return [];
}

function extractTeams(payload) {
  return getListFromData(getApiData(payload), ['teamOrgList', 'teamList', 'teams', 'list']);
}

function extractMembers(payload) {
  return getListFromData(getApiData(payload), ['memberList', 'memList', 'members', 'list']);
}

function extractMoments(payload) {
  return getListFromData(getApiData(payload), ['momList']);
}

function assertSuccessfulPayload(result, operation) {
  const code = Number(result?.payload?.code);
  if (!result?.httpOk || code !== 0) {
    throw new AuditError(
      `marki_${operation}_failed`,
      `${operation} failed with http=${result?.httpStatus ?? 'unknown'}, code=${
        Number.isFinite(code) ? code : 'unknown'
      }`
    );
  }
}

function recordIdentity(record, salt) {
  const id = String(record?.id ?? '').trim();
  const url = fingerprintUrl(record?.url, salt);
  return `${id ? stableHash(id, salt) : 'no-id'}:${url.pathHash}`;
}

function samePrimitiveValue(left, right) {
  if (left === null || right === null) return left === right;
  if (typeof left === 'object' || typeof right === 'object') {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return String(left) === String(right);
}

function buildRawFieldMatrix(records, salt) {
  const fields = new Map();
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    for (const [rawName, value] of Object.entries(record)) {
      const name = safeFieldName(rawName, salt);
      const current = fields.get(name) || {
        field: name,
        presentCount: 0,
        types: new Set()
      };
      current.presentCount += 1;
      current.types.add(normalizeScalar(value));
      fields.set(name, current);
    }
  }
  return [...fields.values()]
    .map((entry) => ({
      field: entry.field,
      presentCount: entry.presentCount,
      presenceRate: records.length ? Number((entry.presentCount / records.length).toFixed(4)) : 0,
      types: [...entry.types].sort()
    }))
    .sort((left, right) => left.field.localeCompare(right.field));
}

function coordinateKey(record) {
  const lng = Number(record?.lng);
  const lat = Number(record?.lat);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return '';
  return `${lng.toFixed(6)}:${lat.toFixed(6)}`;
}

function parsePostTime(value) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) {
    return number > 1e12 ? number : number * 1000;
  }
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function jaccard(left, right) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const union = new Set([...leftSet, ...rightSet]);
  if (union.size === 0) return 1;
  let intersection = 0;
  for (const value of leftSet) {
    if (rightSet.has(value)) intersection += 1;
  }
  return intersection / union.size;
}

function findCandidatePairs(records, salt) {
  const candidates = [];
  for (let leftIndex = 0; leftIndex < records.length; leftIndex += 1) {
    const left = records[leftIndex];
    if (!left || typeof left !== 'object') continue;
    for (let rightIndex = leftIndex + 1; rightIndex < records.length; rightIndex += 1) {
      const right = records[rightIndex];
      if (!right || typeof right !== 'object') continue;
      const uidSame = String(left.uid ?? '') !== '' && String(left.uid) === String(right.uid ?? '');
      const teamIdSame =
        String(left.teamId ?? '') !== '' && String(left.teamId) === String(right.teamId ?? '');
      if (!uidSame || !teamIdSame) continue;
      const leftTime = parsePostTime(left.postTime);
      const rightTime = parsePostTime(right.postTime);
      const deltaMs =
        Number.isFinite(leftTime) && Number.isFinite(rightTime)
          ? Math.abs(leftTime - rightTime)
          : Number.POSITIVE_INFINITY;
      if (deltaMs > 10_000) continue;
      const leftUrl = fingerprintUrl(left.url, salt);
      const rightUrl = fingerprintUrl(right.url, salt);
      if (leftUrl.pathHash === rightUrl.pathHash) continue;
      const leftLabels = parseContentEntries(left.content, salt);
      const rightLabels = parseContentEntries(right.content, salt);
      const fieldSimilarity = jaccard(leftLabels, rightLabels);
      const coordinatesSame =
        coordinateKey(left) !== '' && coordinateKey(left) === coordinateKey(right);
      const markPresenceDiffers =
        Boolean(String(left.markName ?? '').trim()) !== Boolean(String(right.markName ?? '').trim());
      let score = 6;
      if (deltaMs <= 2_000) score += 4;
      else score += 2;
      if (coordinatesSame) score += 2;
      if (fieldSimilarity >= 0.8) score += 2;
      if (markPresenceDiffers) score += 1;
      candidates.push({
        leftIndex,
        rightIndex,
        score,
        deltaMs,
        fieldSimilarity,
        coordinatesSame,
        markPresenceDiffers
      });
    }
  }
  return candidates.sort(
    (left, right) => right.score - left.score || left.deltaMs - right.deltaMs
  );
}

function detectImageFormat(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpeg';
  }
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'png';
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString() === 'RIFF') return 'webp_or_riff';
  return 'unknown';
}

function compareBitmaps(nativeImage, leftBuffer, rightBuffer) {
  const leftImage = nativeImage.createFromBuffer(leftBuffer);
  const rightImage = nativeImage.createFromBuffer(rightBuffer);
  if (leftImage.isEmpty() || rightImage.isEmpty()) {
    return { comparable: false, similarity: null };
  }
  const left = leftImage.resize({ width: 64, height: 64, quality: 'good' }).toBitmap();
  const right = rightImage.resize({ width: 64, height: 64, quality: 'good' }).toBitmap();
  if (left.length !== right.length || left.length === 0) {
    return { comparable: false, similarity: null };
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 4) {
    difference += Math.abs(left[index] - right[index]);
    difference += Math.abs(left[index + 1] - right[index + 1]);
    difference += Math.abs(left[index + 2] - right[index + 2]);
  }
  const channels = (left.length / 4) * 3;
  return {
    comparable: true,
    similarity: Number((1 - difference / (channels * 255)).toFixed(6))
  };
}

function buildSafeMomentDescriptor(record, index, salt) {
  const url = fingerprintUrl(record?.url, salt);
  const labels = parseContentEntries(record?.content, salt);
  return {
    recordIndex: index + 1,
    idHash: redactIdentifier(record?.id, salt),
    uidHash: redactIdentifier(record?.uid, salt),
    teamIdHash: redactIdentifier(record?.teamId, salt),
    urlHash: url.urlHash,
    urlPathHash: url.pathHash,
    queryParameterCount: url.queryParameterCount,
    postTimeType: normalizeScalar(record?.postTime),
    momentType: safeExplicitValue(record?.momentType, salt),
    markNameState: String(record?.markName ?? '').trim() ? 'present' : 'absent',
    markNameHash: redactIdentifier(record?.markName, salt),
    contentFieldLabels: labels,
    contentFieldSetHash: `hash:${stableHash(labels.join('|'), salt)}`,
    coordinateState:
      Number.isFinite(Number(record?.lng)) && Number.isFinite(Number(record?.lat))
        ? 'present'
        : 'absent',
    explicitIdentityFields: IDENTITY_FIELDS.map((field) => ({
      field,
      value: Object.prototype.hasOwnProperty.call(record || {}, field)
        ? safeExplicitValue(record[field], salt)
        : '接口未返回'
    }))
  };
}

function buildPairMatrixEntry(candidate, records, sampleByPathHash, nativeImage, salt, pairIndex) {
  const left = records[candidate.leftIndex];
  const right = records[candidate.rightIndex];
  const leftUrl = fingerprintUrl(left.url, salt);
  const rightUrl = fingerprintUrl(right.url, salt);
  const leftSample = sampleByPathHash.get(leftUrl.pathHash);
  const rightSample = sampleByPathHash.get(rightUrl.pathHash);
  const pixelComparison =
    leftSample?.buffer && rightSample?.buffer
      ? compareBitmaps(nativeImage, leftSample.buffer, rightSample.buffer)
      : { comparable: false, similarity: null };
  const idSame =
    String(left.id ?? '') !== '' && String(left.id ?? '') === String(right.id ?? '');
  const contentLabelsLeft = parseContentEntries(left.content, salt);
  const contentLabelsRight = parseContentEntries(right.content, salt);
  const fileShaSame =
    leftSample?.sha256 && rightSample?.sha256
      ? leftSample.sha256 === rightSample.sha256
      : '样本未下载';
  const reasons = [
    'uid相同',
    'teamId相同',
    `postTime差值${candidate.deltaMs}ms`,
    candidate.coordinatesSame ? '经纬度相同' : '经纬度不相同或接口未返回',
    `content字段集合相似度${candidate.fieldSimilarity.toFixed(3)}`,
    candidate.markPresenceDiffers ? 'markName存在状态不同' : 'markName存在状态相同',
    pixelComparison.comparable
      ? `64x64像素相似度${pixelComparison.similarity}`
      : '像素不可比较'
  ];
  let confidence = '低';
  if (
    candidate.deltaMs <= 2_000 &&
    candidate.coordinatesSame &&
    candidate.fieldSimilarity >= 0.8 &&
    pixelComparison.similarity >= 0.9
  ) {
    confidence = '高';
  } else if (
    candidate.deltaMs <= 10_000 &&
    candidate.fieldSimilarity >= 0.5 &&
    (candidate.coordinatesSame || pixelComparison.similarity >= 0.75)
  ) {
    confidence = '中';
  }
  return {
    pairCandidateId: `pair-${String(pairIndex + 1).padStart(3, '0')}`,
    recordAIdHash: redactIdentifier(left.id, salt),
    recordBIdHash: redactIdentifier(right.id, salt),
    idSame,
    urlHashSame: leftUrl.urlHash === rightUrl.urlHash,
    urlPathHashSame: leftUrl.pathHash === rightUrl.pathHash,
    fileShaSame,
    postTimeDeltaMs: candidate.deltaMs,
    uidSame: String(left.uid ?? '') !== '' && String(left.uid) === String(right.uid ?? ''),
    teamIdSame:
      String(left.teamId ?? '') !== '' && String(left.teamId) === String(right.teamId ?? ''),
    coordinatesSame: candidate.coordinatesSame,
    contentFieldSetSame: JSON.stringify(contentLabelsLeft) === JSON.stringify(contentLabelsRight),
    markNameA: String(left.markName ?? '').trim() ? 'present' : 'absent',
    markNameB: String(right.markName ?? '').trim() ? 'present' : 'absent',
    explicitWatermarkStatusA: getFirstPresentField(
      left,
      ['watermarkStatus', 'markStatus', 'isWatermarked', 'hasWatermark'],
      salt
    ),
    explicitWatermarkStatusB: getFirstPresentField(
      right,
      ['watermarkStatus', 'markStatus', 'isWatermarked', 'hasWatermark'],
      salt
    ),
    templateOrWatermarkIdA: getFirstPresentField(
      left,
      ['templateId', 'watermarkId', 'markId'],
      salt
    ),
    templateOrWatermarkIdB: getFirstPresentField(
      right,
      ['templateId', 'watermarkId', 'markId'],
      salt
    ),
    mediaIdA: getFirstPresentField(left, ['mediaId', 'fileId', 'assetId'], salt),
    mediaIdB: getFirstPresentField(right, ['mediaId', 'fileId', 'assetId'], salt),
    originalIdA: getFirstPresentField(left, ['originalId', 'originId'], salt),
    originalIdB: getFirstPresentField(right, ['originalId', 'originId'], salt),
    parentRecordIdA: getFirstPresentField(left, ['parentId', 'parentMomentId'], salt),
    parentRecordIdB: getFirstPresentField(right, ['parentId', 'parentMomentId'], salt),
    versionFieldA: getFirstPresentField(
      left,
      ['variantId', 'version', 'variantType', 'imageVariant'],
      salt
    ),
    versionFieldB: getFirstPresentField(
      right,
      ['variantId', 'version', 'variantType', 'imageVariant'],
      salt
    ),
    imageA: leftSample
      ? {
          width: leftSample.width,
          height: leftSample.height,
          size: leftSample.size,
          format: leftSample.format
        }
      : '样本未下载',
    imageB: rightSample
      ? {
          width: rightSample.width,
          height: rightSample.height,
          size: rightSample.size,
          format: rightSample.format
        }
      : '样本未下载',
    pixelSimilarity: pixelComparison.similarity,
    confidence,
    confidenceReasons: reasons,
    humanConfirmed: false
  };
}

function evaluateAbResult(baselineRecords, variantRecords, field, expectedValue, result, salt) {
  const baselineSet = new Set(baselineRecords.map((record) => recordIdentity(record, salt)));
  const variantSet = new Set(variantRecords.map((record) => recordIdentity(record, salt)));
  const setChanged =
    baselineSet.size !== variantSet.size || [...baselineSet].some((value) => !variantSet.has(value));
  const allReturnedMatchField =
    variantRecords.length > 0 &&
    variantRecords.every(
      (record) =>
        Object.prototype.hasOwnProperty.call(record || {}, field) &&
        samePrimitiveValue(record[field], expectedValue)
    );
  const apiCode = Number(result?.payload?.code);
  let assessment = '不支持或未证明支持';
  if (!result?.httpOk || apiCode !== 0) assessment = '参数被拒绝';
  else if (setChanged && allReturnedMatchField) assessment = '真实结果支持筛选';
  else if (setChanged) assessment = '结果变化但筛选语义未证明';
  return {
    field,
    httpStatus: result?.httpStatus ?? 'unknown',
    apiCode: Number.isFinite(apiCode) ? apiCode : 'unknown',
    traceIdHash: redactIdentifier(result?.traceId, salt),
    baselineCount: baselineRecords.length,
    variantCount: variantRecords.length,
    resultSetChanged: setChanged,
    allReturnedMatchField,
    assessment
  };
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function ensureEvidenceOutsideRepository(evidenceDirectory, repositoryRoot) {
  const evidence = path.resolve(evidenceDirectory).toLowerCase();
  const repository = path.resolve(repositoryRoot).toLowerCase();
  if (evidence === repository || evidence.startsWith(`${repository}${path.sep}`)) {
    throw new AuditError('unsafe_evidence_path', 'Evidence directory must be outside repository.');
  }
}

async function createEvidenceDirectory(repositoryRoot) {
  const directory = path.join(
    os.tmpdir(),
    `property-photo-marki-contract-audit-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto
      .randomUUID()
      .slice(0, 8)}`
  );
  ensureEvidenceOutsideRepository(directory, repositoryRoot);
  await fs.mkdir(path.join(directory, 'raw-responses'), { recursive: true });
  await fs.mkdir(path.join(directory, 'photo-samples'), { recursive: true });
  return directory;
}

function createRawApiClient({
  credentials,
  evidenceDirectory,
  apiBaseUrl,
  buildSignature,
  fetchImpl = globalThis.fetch,
  rawFilePrefix = 'request'
}) {
  let requestCount = 0;
  const endpointCounts = {};
  return {
    getRequestCounts() {
      return {
        total: requestCount,
        byEndpoint: { ...endpointCounts }
      };
    },
    async post(endpoint, body) {
      requestCount += 1;
      endpointCounts[endpoint] = (endpointCounts[endpoint] || 0) + 1;
      const traceId = `marki-contract-audit-${crypto.randomUUID()}`;
      const timestamp = String(Math.floor(Date.now() / 1000));
      const bodyText = body === null || body === undefined ? '' : JSON.stringify(body);
      const sign = buildSignature({
        orgId: credentials.orgId,
        key: credentials.key,
        timestamp,
        traceId,
        bodyText
      });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      let response;
      let payload;
      try {
        response = await fetchImpl(`${apiBaseUrl}${endpoint}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            orgId: credentials.orgId,
            timestamp,
            traceId,
            sign
          },
          body: bodyText || undefined,
          signal: controller.signal
        });
        payload = await response.json();
      } catch (error) {
        const code = error?.name === 'AbortError' ? 'request_timeout' : 'network_or_parse_error';
        await writeJson(
          path.join(
            evidenceDirectory,
            'raw-responses',
            `${rawFilePrefix}-${String(requestCount).padStart(3, '0')}.json`
          ),
          {
            endpoint,
            requestBody: body,
            failureCode: code
          }
        );
        throw new AuditError(code, `Real audit request failed: ${code}`);
      } finally {
        clearTimeout(timeout);
      }
      const result = {
        endpoint,
        httpOk: response.ok,
        httpStatus: response.status,
        traceId,
        payload
      };
      await writeJson(
        path.join(
          evidenceDirectory,
          'raw-responses',
          `${rawFilePrefix}-${String(requestCount).padStart(3, '0')}.json`
        ),
        {
          endpoint,
          requestBody: body,
          httpStatus: response.status,
          traceId,
          payload
        }
      );
      return result;
    }
  };
}

async function queryMomentRange(api, filters, metadataBudget, options = {}) {
  const records = [];
  const seenCursors = new Set();
  let next = '';
  let hasMore = true;
  let pageCount = 0;
  let firstPageResult = null;
  while (
    hasMore &&
    records.length < metadataBudget &&
    pageCount < MAX_ACTIVE_PAGES
  ) {
    const body = {
      ...(filters.teamId ? { teamId: filters.teamId } : {}),
      ...(filters.uid ? { uid: filters.uid } : {}),
      start: filters.start,
      end: filters.end,
      ...(next ? { next } : {}),
      momType: 1,
      ...(options.extraBody || {})
    };
    const result = await api.post(MOMENT_ENDPOINT, body);
    const apiCode = Number(result?.payload?.code);
    if (!result?.httpOk || apiCode !== 0) {
      if (options.captureFailure) {
        return {
          records,
          pageCount,
          hasMore: false,
          truncated: false,
          failed: true,
          httpStatus: result?.httpStatus ?? 'unknown',
          apiCode: Number.isFinite(apiCode) ? apiCode : 'unknown',
          traceId: String(result?.traceId || '')
        };
      }
      assertSuccessfulPayload(result, 'moment_query');
    }
    if (!firstPageResult) firstPageResult = result;
    const page = extractMoments(result.payload);
    const remaining = metadataBudget - records.length;
    records.push(...page.slice(0, remaining));
    const data = getApiData(result.payload);
    const returnedNext = String(data.next ?? '').trim();
    hasMore = data.hasMore === true;
    pageCount += 1;
    if (!hasMore || !returnedNext || seenCursors.has(returnedNext)) break;
    seenCursors.add(returnedNext);
    next = returnedNext;
  }
  return {
    records,
    pageCount,
    hasMore: hasMore && records.length < metadataBudget,
    truncated: records.length >= metadataBudget && hasMore,
    failed: false,
    firstPageResult
  };
}

function areSetsEqual(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function buildIdSet(records) {
  return new Set(
    records
      .map((record) => String(record?.id ?? '').trim())
      .filter(Boolean)
  );
}

function buildNeedMarkRelations(groupResults) {
  const byLabel = new Map(groupResults.map((entry) => [entry.label, entry]));
  const sets = Object.fromEntries(
    [...byLabel.entries()].map(([label, entry]) => [label, buildIdSet(entry.records)])
  );
  const markIntersection = new Set(
    [...sets.need_mark_1].filter((value) => sets.need_mark_2.has(value))
  );
  const markUnion = new Set([...sets.need_mark_1, ...sets.need_mark_2]);
  return {
    omittedEqualsZero: areSetsEqual(sets.omitted, sets.need_mark_0),
    omittedEqualsOne: areSetsEqual(sets.omitted, sets.need_mark_1),
    omittedEqualsTwo: areSetsEqual(sets.omitted, sets.need_mark_2),
    zeroEqualsOne: areSetsEqual(sets.need_mark_0, sets.need_mark_1),
    zeroEqualsTwo: areSetsEqual(sets.need_mark_0, sets.need_mark_2),
    oneEqualsTwo: areSetsEqual(sets.need_mark_1, sets.need_mark_2),
    oneTwoIntersectionCount: markIntersection.size,
    oneTwoDisjoint: markIntersection.size === 0,
    oneTwoUnionEqualsOmitted: areSetsEqual(markUnion, sets.omitted),
    oneTwoUnionEqualsZero: areSetsEqual(markUnion, sets.need_mark_0)
  };
}

function classifyNeedMarkSupport(groupResults, relations, knownPair) {
  const parameterGroups = groupResults.filter((entry) => entry.needMark !== null);
  if (parameterGroups.some((entry) => entry.failed)) return 'D';
  if (groupResults.some((entry) => entry.truncated)) return 'E';
  if (
    relations.omittedEqualsZero &&
    relations.omittedEqualsOne &&
    relations.omittedEqualsTwo
  ) {
    return 'C';
  }
  const pairPresentInAll = groupResults.every(
    (entry) => knownPair.every((id) => entry.idSet.has(id))
  );
  const pairSplitAcrossVariants =
    knownPair.filter((id) => groupResults.find((entry) => entry.label === 'need_mark_1').idSet.has(id))
      .length === 1 &&
    knownPair.filter((id) => groupResults.find((entry) => entry.label === 'need_mark_2').idSet.has(id))
      .length === 1;
  if (
    relations.oneTwoDisjoint &&
    (relations.oneTwoUnionEqualsZero || relations.oneTwoUnionEqualsOmitted) &&
    pairSplitAcrossVariants
  ) {
    return 'A';
  }
  const pairPresentInBaseline =
    knownPair.every((id) =>
      groupResults.find((entry) => entry.label === 'omitted').idSet.has(id)
    ) &&
    knownPair.every((id) =>
      groupResults.find((entry) => entry.label === 'need_mark_0').idSet.has(id)
    );
  if (!pairPresentInBaseline && !pairPresentInAll) return 'E';
  return 'B';
}

async function loadKnownPairForNeedMark(evidenceDirectory) {
  const rawDirectory = path.join(evidenceDirectory, 'raw-responses');
  const names = (await fs.readdir(rawDirectory))
    .filter((name) => /^request-\d+\.json$/.test(name))
    .sort();
  const records = [];
  for (const name of names) {
    const evidence = JSON.parse(
      await fs.readFile(path.join(rawDirectory, name), 'utf8')
    );
    if (evidence?.endpoint !== MOMENT_ENDPOINT) continue;
    const requestKeys = Object.keys(evidence?.requestBody || {});
    if (requestKeys.some((key) => !['teamId', 'uid', 'start', 'end', 'next', 'momType'].includes(key))) {
      continue;
    }
    for (const record of extractMoments(evidence?.payload)) {
      if (records.length >= MAX_METADATA_RECORDS) break;
      records.push(record);
    }
    if (records.length >= MAX_METADATA_RECORDS) break;
  }
  const groups = new Map();
  for (const record of records) {
    const key = [
      record?.uid,
      record?.teamId,
      record?.postTime,
      record?.lng,
      record?.lat
    ].join('|');
    const current = groups.get(key) || [];
    current.push(record);
    groups.set(key, current);
  }
  const candidate = [...groups.values()].find(
    (group) =>
      group.length === 2 &&
      String(group[0]?.id ?? '') !== String(group[1]?.id ?? '') &&
      String(group[0]?.url ?? '') !== String(group[1]?.url ?? '') &&
      String(group[0]?.content ?? '') === String(group[1]?.content ?? '') &&
      String(group[0]?.markName ?? '') === String(group[1]?.markName ?? '')
  );
  if (!candidate) {
    throw new AuditError(
      'known_pair_unavailable',
      'Existing evidence has no usable high-confidence pair.'
    );
  }
  const timestamp = parsePostTime(candidate[0].postTime);
  if (!Number.isFinite(timestamp)) {
    throw new AuditError('known_pair_time_invalid', 'Known pair time is invalid.');
  }
  return {
    pair: candidate,
    filters: {
      teamId: candidate[0].teamId,
      uid: candidate[0].uid,
      start: formatUtc8DateTime(new Date(timestamp - 5 * 60 * 1000)),
      end: formatUtc8DateTime(new Date(timestamp + 5 * 60 * 1000))
    }
  };
}

async function runNeedMarkAudit(api, evidenceDirectory, salt) {
  const known = await loadKnownPairForNeedMark(evidenceDirectory);
  const definitions = [
    { label: 'omitted', needMark: null },
    { label: 'need_mark_0', needMark: 0 },
    { label: 'need_mark_1', needMark: 1 },
    { label: 'need_mark_2', needMark: 2 }
  ];
  const groupResults = [];
  for (const definition of definitions) {
    activeAuditPhase = `need_mark_${definition.needMark ?? 'omitted'}`;
    const beforeCount = api.getRequestCounts().total;
    const query = await queryMomentRange(api, known.filters, MAX_METADATA_RECORDS, {
      extraBody:
        definition.needMark === null ? {} : { needMark: definition.needMark },
      captureFailure: true
    });
    const idSet = buildIdSet(query.records);
    groupResults.push({
      ...definition,
      ...query,
      idSet,
      callCount: api.getRequestCounts().total - beforeCount
    });
  }
  const relations = buildNeedMarkRelations(groupResults);
  const knownPairIds = known.pair.map((record) => String(record.id));
  const classification = classifyNeedMarkSupport(
    groupResults,
    relations,
    knownPairIds
  );
  const safeGroups = groupResults.map((entry) => ({
    label: entry.label,
    needMark: entry.needMark === null ? 'omitted' : entry.needMark,
    callCount: entry.callCount,
    recordCount: entry.records.length,
    failed: entry.failed,
    truncated: entry.truncated,
    hasMoreAfterRead: entry.hasMore,
    httpStatus: entry.failed ? entry.httpStatus : 200,
    apiCode: entry.failed ? entry.apiCode : 0,
    traceIdHash: entry.failed ? redactIdentifier(entry.traceId, salt) : 'not_applicable',
    idHashes: [...entry.idSet].sort().map((id) => redactIdentifier(id, salt)),
    knownPairPresence: knownPairIds.map((id, index) => ({
      side: index === 0 ? 'A' : 'B',
      present: entry.idSet.has(id)
    }))
  }));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    electronVersion: String(process.versions.electron || ''),
    query: {
      teamIdHash: redactIdentifier(known.filters.teamId, salt),
      uidHash: redactIdentifier(known.filters.uid, salt),
      start: known.filters.start,
      end: known.filters.end,
      momType: 1,
      maximumRecordsPerGroup: MAX_METADATA_RECORDS
    },
    groups: safeGroups,
    relations,
    knownPair: {
      idHashes: knownPairIds.map((id) => redactIdentifier(id, salt)),
      postTimeDeltaMs: Math.abs(
        parsePostTime(known.pair[0].postTime) - parsePostTime(known.pair[1].postTime)
      ),
      uidSame: String(known.pair[0].uid) === String(known.pair[1].uid),
      teamIdSame: String(known.pair[0].teamId) === String(known.pair[1].teamId),
      contentSame: String(known.pair[0].content) === String(known.pair[1].content),
      markNameSame: String(known.pair[0].markName) === String(known.pair[1].markName)
    },
    classification,
    classificationMeaning: {
      A: '已确认支持',
      B: '疑似支持',
      C: '被静默忽略',
      D: '明确不支持',
      E: '证据不足'
    }[classification],
    apiCalls: api.getRequestCounts(),
    downloadsPerformed: 0,
    privacy: {
      credentialsPersistedInEvidence: false,
      requestHeadersPersistedInEvidence: false,
      fullUrlsInSanitizedSummary: false,
      contentValuesInSanitizedSummary: false
    }
  };
}

async function downloadPhotoSamples(records, candidates, evidenceDirectory, nativeImage, salt) {
  const selectedIndexes = [];
  for (const candidate of candidates) {
    for (const index of [candidate.leftIndex, candidate.rightIndex]) {
      if (!selectedIndexes.includes(index)) selectedIndexes.push(index);
      if (selectedIndexes.length >= MAX_PHOTO_DOWNLOADS) break;
    }
    if (selectedIndexes.length >= MAX_PHOTO_DOWNLOADS) break;
  }
  const sampleByPathHash = new Map();
  const safeSamples = [];
  for (const recordIndex of selectedIndexes) {
    const record = records[recordIndex];
    const rawUrl = String(record?.url ?? '').trim();
    if (!rawUrl) continue;
    const urlInfo = fingerprintUrl(rawUrl, salt);
    if (sampleByPathHash.has(urlInfo.pathHash)) continue;
    const response = await fetch(rawUrl, { method: 'GET', redirect: 'follow' });
    if (!response.ok) {
      safeSamples.push({
        recordIndex: recordIndex + 1,
        urlPathHash: urlInfo.pathHash,
        status: 'download_failed',
        httpStatus: response.status
      });
      continue;
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_SAMPLE_BYTES) {
      safeSamples.push({
        recordIndex: recordIndex + 1,
        urlPathHash: urlInfo.pathHash,
        status: 'sample_too_large'
      });
      continue;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_SAMPLE_BYTES) {
      safeSamples.push({
        recordIndex: recordIndex + 1,
        urlPathHash: urlInfo.pathHash,
        status: 'sample_too_large'
      });
      continue;
    }
    const image = nativeImage.createFromBuffer(buffer);
    const size = image.isEmpty() ? { width: 0, height: 0 } : image.getSize();
    const sample = {
      buffer,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      size: buffer.length,
      width: size.width,
      height: size.height,
      format: detectImageFormat(buffer)
    };
    sampleByPathHash.set(urlInfo.pathHash, sample);
    const sampleNumber = sampleByPathHash.size;
    await fs.writeFile(
      path.join(
        evidenceDirectory,
        'photo-samples',
        `sample-${String(sampleNumber).padStart(3, '0')}.bin`
      ),
      buffer
    );
    safeSamples.push({
      recordIndex: recordIndex + 1,
      urlPathHash: urlInfo.pathHash,
      status: 'downloaded',
      sha256: `hash:${stableHash(sample.sha256, salt)}`,
      size: sample.size,
      width: sample.width,
      height: sample.height,
      format: sample.format
    });
  }
  return {
    sampleByPathHash,
    safeSamples,
    downloadedCount: sampleByPathHash.size
  };
}

async function runFilterAbTests(api, baseFilters, baselineRecords, allRecords, salt) {
  const results = [];
  for (const field of CANDIDATE_FILTER_FIELDS) {
    const sourceRecord = allRecords.find(
      (record) =>
        Object.prototype.hasOwnProperty.call(record || {}, field) &&
        record[field] !== null &&
        record[field] !== undefined &&
        String(record[field]).trim() !== ''
    );
    if (!sourceRecord) {
      results.push({
        field,
        assessment: '原始响应无候选字段，未发起A/B请求'
      });
      continue;
    }
    const body = {
      ...(baseFilters.teamId ? { teamId: baseFilters.teamId } : {}),
      ...(baseFilters.uid ? { uid: baseFilters.uid } : {}),
      start: baseFilters.start,
      end: baseFilters.end,
      momType: 1,
      [field]: sourceRecord[field]
    };
    const result = await api.post(MOMENT_ENDPOINT, body);
    const variantRecords =
      Number(result?.payload?.code) === 0 ? extractMoments(result.payload) : [];
    results.push(
      evaluateAbResult(
        baselineRecords,
        variantRecords,
        field,
        sourceRecord[field],
        result,
        salt
      )
    );
  }
  return results;
}

function summarizeCodeAssumptions() {
  return [
    {
      assumption: 'sanitizeMoment仅保留有限字段，可能丢失媒体、模板和版本字段',
      codeStatus: '已由代码确认',
      realApiStatus: '由原始字段矩阵判定'
    },
    {
      assumption: '查询会话sourceKey使用marki_api:<orgId>:<momentId>',
      codeStatus: '已由代码确认',
      realApiStatus: '不属于服务端事实'
    },
    {
      assumption: '相同sourceKey仅保留水印证据等级较高记录',
      codeStatus: '已由代码确认',
      realApiStatus: '不属于服务端事实'
    },
    {
      assumption: '导入逻辑只允许watermarked记录',
      codeStatus: '已由代码确认',
      realApiStatus: '不属于服务端事实'
    },
    {
      assumption: '模板名称和图片版本状态混在一个筛选维度',
      codeStatus: '已由代码确认',
      realApiStatus: '不属于服务端事实'
    }
  ];
}

function inferFilterSupport(abResults) {
  const supported = (fields) =>
    abResults.some(
      (entry) => fields.includes(entry.field) && entry.assessment === '真实结果支持筛选'
    );
  return {
    templateFiltering:
      supported(['markId', 'watermarkId', 'templateId', 'markName'])
        ? '已证明支持'
        : '不支持或未证明支持',
    watermarkStatusFiltering:
      supported(['isWatermarked', 'hasWatermark', 'watermarkStatus'])
        ? '已证明支持'
        : '不支持或未证明支持'
  };
}

function buildAuditSummary({
  salt,
  evidenceDirectory,
  runtime,
  api,
  rangeDays,
  filters,
  records,
  pageCount,
  teams,
  members,
  pairMatrix,
  safeSamples,
  fieldMatrix,
  abResults,
  downloadedCount
}) {
  const fieldNames = new Set(fieldMatrix.map((entry) => entry.field));
  const rawIdentityFields = IDENTITY_FIELDS.map((field) => ({
    field,
    responseStatus: fieldNames.has(field) ? '接口返回' : '接口未返回'
  }));
  const filterSupport = inferFilterSupport(abResults);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    evidenceDirectory,
    evidenceDirectoryForReport: `%TEMP%\\${path.basename(evidenceDirectory)}`,
    runtime,
    limits: {
      metadataRecordLimit: MAX_METADATA_RECORDS,
      photoDownloadLimit: MAX_PHOTO_DOWNLOADS
    },
    apiCalls: api.getRequestCounts(),
    query: {
      rangeDays,
      start: filters.start,
      end: filters.end,
      teamFilterApplied: Boolean(filters.teamId),
      uidFilterApplied: Boolean(filters.uid),
      pageCount,
      metadataRecordCount: records.length,
      teamRecordCount: teams.length,
      memberRecordCount: members.length
    },
    rawFieldMatrix: fieldMatrix,
    rawIdentityFields,
    safeRecordDescriptors: records.map((record, index) =>
      buildSafeMomentDescriptor(record, index, salt)
    ),
    candidatePairCount: pairMatrix.length,
    pairMatrix,
    downloadedSampleCount: downloadedCount,
    safeSamples,
    filterAbResults: abResults,
    filterSupport,
    codeAssumptions: summarizeCodeAssumptions(),
    privacy: {
      rawResponsesStoredOutsideRepository: true,
      rawPhotoSamplesStoredOutsideRepository: true,
      credentialsPersistedInEvidence: false,
      requestHeadersPersistedInEvidence: false,
      fullUrlsInSanitizedSummary: false,
      contentValuesInSanitizedSummary: false,
      identifiersAreAuditScopedHashes: true
    }
  };
}

async function runRealAudit() {
  activeAuditPhase = 'create_evidence';
  const repositoryRoot = path.resolve(__dirname, '..');
  const supplementMembers = process.argv.includes('--supplement-members');
  const auditNeedMark = process.argv.includes('--audit-need-mark');
  const reuseExistingEvidence = supplementMembers || auditNeedMark;
  const requestedEvidenceDirectory = String(process.env.MARKI_AUDIT_BASE_EVIDENCE || '').trim();
  const evidenceDirectory = reuseExistingEvidence
    ? path.resolve(requestedEvidenceDirectory)
    : await createEvidenceDirectory(repositoryRoot);
  if (reuseExistingEvidence) {
    if (!requestedEvidenceDirectory) {
      throw new AuditError(
        'missing_evidence_directory',
        'Audit supplement requires an existing evidence directory.'
      );
    }
    ensureEvidenceOutsideRepository(evidenceDirectory, repositoryRoot);
    await fs.access(evidenceDirectory);
  }
  activeAuditPhase = 'load_electron';
  const electron = require('electron');
  const packageJson = require('../package.json');
  const { app, safeStorage, nativeImage } = electron;
  activeAuditPhase = 'configure_runtime';
  const developmentRuntimePath = path.join(repositoryRoot, '.runtime');
  const developmentUserDataPath = path.join(developmentRuntimePath, 'userData');
  const credentialPath = path.join(developmentUserDataPath, 'marki-credentials.json');
  if (!IS_AUDIT_PRELOAD) {
    activeAuditPhase = 'configure_app_name';
    app.setName(
      String(
        process.argv.includes('--use-package-name')
          ? packageJson.name
          : packageJson?.build?.productName || '物业工作照片归档助手'
      )
    );
  }
  activeAuditPhase = 'configure_user_data_switch';
  app.commandLine.appendSwitch('user-data-dir', developmentUserDataPath);
  activeAuditPhase = 'configure_cache_switch';
  app.commandLine.appendSwitch('disk-cache-dir', path.join(developmentRuntimePath, 'cache'));
  activeAuditPhase = 'configure_user_data_path';
  app.setPath('userData', developmentUserDataPath);
  activeAuditPhase = 'configure_session_data_path';
  app.setPath('sessionData', path.join(developmentRuntimePath, 'sessionData'));
  activeAuditPhase = 'wait_ready';
  await app.whenReady();

  activeAuditPhase = 'load_credential_service';
  const { loadMarkiCredentials } = require('../electron/services/markiCredentialService.cjs');
  activeAuditPhase = 'load_api_service';
  const {
    MARKI_API_BASE_URL,
    buildMarkiPostSignature
  } = require('../electron/services/markiApiService.cjs');
  let credentials = null;
  try {
    activeAuditPhase = 'load_credentials';
    credentials = await loadMarkiCredentials(developmentUserDataPath, safeStorage);
    if (!credentials?.orgId || !credentials?.key) {
      throw new AuditError('credentials_unavailable', 'Existing Marki credentials are unavailable.');
    }
    const salt = crypto.randomBytes(32).toString('hex');
    const api = createRawApiClient({
      credentials,
      evidenceDirectory,
      apiBaseUrl: MARKI_API_BASE_URL,
      buildSignature: buildMarkiPostSignature,
      rawFilePrefix: auditNeedMark
        ? 'need-mark'
        : supplementMembers
          ? 'member-supplement'
          : 'request'
    });

    if (auditNeedMark) {
      activeAuditPhase = 'need_mark_audit';
      const needMarkSummary = await runNeedMarkAudit(api, evidenceDirectory, salt);
      const summaryPath = path.join(evidenceDirectory, 'need-mark-sanitized.json');
      await writeJson(summaryPath, needMarkSummary);
      process.stdout.write(
        `AUDIT_NEED_MARK_COMPLETE ${JSON.stringify({
          evidenceDirectory,
          summaryPath,
          classification: needMarkSummary.classification,
          classificationMeaning: needMarkSummary.classificationMeaning,
          groupCounts: needMarkSummary.groups.map((entry) => ({
            label: entry.label,
            callCount: entry.callCount,
            recordCount: entry.recordCount
          })),
          apiCalls: needMarkSummary.apiCalls
        })}\n`
      );
      activeAuditPhase = 'complete';
      return;
    }

    if (supplementMembers) {
      activeAuditPhase = 'load_team_evidence';
      const teamEvidence = JSON.parse(
        await fs.readFile(
          path.join(evidenceDirectory, 'raw-responses', 'request-001.json'),
          'utf8'
        )
      );
      const teams = extractTeams(teamEvidence?.payload);
      const teamId = teams[0]?.teamId ?? teams[0]?.id;
      if (teamId === undefined || teamId === null || !String(teamId).trim()) {
        throw new AuditError('team_evidence_unavailable', 'Team evidence has no usable team ID.');
      }
      activeAuditPhase = 'query_members';
      const memberResult = await api.post(MEMBER_ENDPOINT, { teamId });
      assertSuccessfulPayload(memberResult, 'member_query');
      const members = extractMembers(memberResult.payload);
      const supplementSummary = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        electronVersion: String(process.versions.electron || ''),
        safeStorageDecryptionSucceeded: true,
        apiCalls: api.getRequestCounts(),
        teamEvidenceCount: teams.length,
        memberRecordCount: members.length,
        memberResponseDataFields: Object.keys(getApiData(memberResult.payload)).sort(),
        memberFieldMatrix: buildRawFieldMatrix(members, salt),
        privacy: {
          memberValuesPersistedInSanitizedSummary: false,
          credentialsPersistedInEvidence: false,
          requestHeadersPersistedInEvidence: false
        }
      };
      await writeJson(
        path.join(evidenceDirectory, 'member-supplement-sanitized.json'),
        supplementSummary
      );
      process.stdout.write(
        `AUDIT_MEMBER_SUPPLEMENT_COMPLETE ${JSON.stringify({
          evidenceDirectory,
          memberRecordCount: members.length,
          apiCalls: supplementSummary.apiCalls
        })}\n`
      );
      activeAuditPhase = 'complete';
      return;
    }

    activeAuditPhase = 'query_teams';
    const teamResult = await api.post(TEAM_ENDPOINT, null);
    assertSuccessfulPayload(teamResult, 'team_query');
    const teams = extractTeams(teamResult.payload);
    let members = [];
    if (teams.length > 0) {
      const teamId = teams[0]?.teamId ?? teams[0]?.id;
      if (teamId !== undefined && teamId !== null && String(teamId).trim()) {
        const memberResult = await api.post(MEMBER_ENDPOINT, { teamId });
        assertSuccessfulPayload(memberResult, 'member_query');
        members = extractMembers(memberResult.payload);
      }
    }

    const now = new Date();
    let selectedRange = null;
    let selectedQuery = null;
    for (const rangeDays of [3, 7, 31]) {
      const filters = {
        start: formatUtc8DateTime(new Date(now.getTime() - rangeDays * 24 * 60 * 60 * 1000)),
        end: formatUtc8DateTime(now)
      };
      activeAuditPhase = `query_moments_${rangeDays}d`;
      const query = await queryMomentRange(api, filters, MAX_METADATA_RECORDS);
      const candidates = findCandidatePairs(query.records, salt);
      selectedRange = { rangeDays, filters };
      selectedQuery = query;
      if (candidates.length > 0 || query.records.length >= MAX_METADATA_RECORDS || rangeDays === 31) {
        break;
      }
    }

    const records = selectedQuery?.records || [];
    const candidates = findCandidatePairs(records, salt);
    activeAuditPhase = 'download_samples';
    const sampleResult = await downloadPhotoSamples(
      records,
      candidates.slice(0, 10),
      evidenceDirectory,
      nativeImage,
      salt
    );
    const pairMatrix = candidates.slice(0, 10).map((candidate, index) =>
      buildPairMatrixEntry(
        candidate,
        records,
        sampleResult.sampleByPathHash,
        nativeImage,
        salt,
        index
      )
    );
    const baselineRecords = selectedQuery?.firstPageResult
      ? extractMoments(selectedQuery.firstPageResult.payload)
      : [];
    activeAuditPhase = 'filter_ab';
    const abResults = await runFilterAbTests(
      api,
      selectedRange.filters,
      baselineRecords,
      records,
      salt
    );
    activeAuditPhase = 'write_summary';
    const summary = buildAuditSummary({
      salt,
      evidenceDirectory,
      runtime: {
        electronVersion: String(process.versions.electron || ''),
        developmentUserDataPath,
        credentialPath,
        credentialFileExists: true,
        safeStorageDecryptionSucceeded: true
      },
      api,
      rangeDays: selectedRange.rangeDays,
      filters: selectedRange.filters,
      records,
      pageCount: selectedQuery.pageCount,
      teams,
      members,
      pairMatrix,
      safeSamples: sampleResult.safeSamples,
      fieldMatrix: buildRawFieldMatrix(records, salt),
      abResults,
      downloadedCount: sampleResult.downloadedCount
    });
    const summaryPath = path.join(evidenceDirectory, 'sanitized-summary.json');
    await writeJson(summaryPath, summary);
    await writeJson(path.join(evidenceDirectory, 'audit-metadata.json'), {
      schemaVersion: 1,
      generatedAt: summary.generatedAt,
      repositoryHeadExpected: '4522775fdebb5f6c5e56572f652defe90d37f7e7',
      rawEvidenceContainsSensitiveData: true,
      doNotCommit: true
    });
    process.stdout.write(
      `AUDIT_COMPLETE ${JSON.stringify({
        evidenceDirectory,
        summaryPath,
        metadataRecordCount: records.length,
        downloadedSampleCount: sampleResult.downloadedCount,
        candidatePairCount: pairMatrix.length,
        apiCalls: summary.apiCalls
      })}\n`
    );
    activeAuditPhase = 'complete';
  } finally {
    if (credentials) {
      credentials.key = '';
      credentials.orgId = '';
    }
    app.quit();
  }
}

async function runSelfCheck() {
  const salt = 'self-check-salt';
  const fakeOrigin = ['https:', '', 'example.invalid'].join('/');
  const fakeUrl = `${fakeOrigin}/private/photo.jpg?sign=${['FAKE', 'SIGNATURE'].join('_')}&key=${[
    'FAKE',
    'KEY'
  ].join('_')}`;
  const fake = {
    id: ['moment', '123456789'].join('-'),
    uid: ['user', '987654321'].join('-'),
    teamId: ['team', '111111111'].join('-'),
    url: fakeUrl,
    content: JSON.stringify([
      ['小区名称', ['SYNTHETIC', 'COMMUNITY'].join('_')],
      ['地址', ['SYNTHETIC', 'ADDRESS'].join('_')],
      ['工作备注', ['SYNTHETIC', 'PERSON', 'NOTE'].join('_')]
    ]),
    markName: ['SYNTHETIC', 'TEMPLATE'].join('_'),
    postTime: 1710000000,
    lng: 112.123456,
    lat: 28.123456,
    mediaId: ['media', 'synthetic', 'id'].join('-'),
    isWatermarked: true
  };
  const safe = buildSafeMomentDescriptor(fake, 0, salt);
  const serialized = JSON.stringify(safe);
  for (const forbidden of [
    fake.id,
    fake.uid,
    fake.teamId,
    'FAKE_SIGNATURE',
    'FAKE_KEY',
    fakeOrigin,
    'SYNTHETIC_COMMUNITY',
    'SYNTHETIC_ADDRESS',
    'SYNTHETIC_PERSON_NOTE',
    'SYNTHETIC_TEMPLATE',
    'media-synthetic-id'
  ]) {
    assert.equal(serialized.includes(forbidden), false, `redaction leaked ${forbidden}`);
  }
  assert.deepEqual(safe.contentFieldLabels, ['地址', '小区名称', '工作备注']);
  assert.equal(safe.queryParameterCount, 2);
  assert.equal(safe.coordinateState, 'present');
  assert.equal(safe.markNameState, 'present');
  assert.equal(MAX_METADATA_RECORDS, 200);
  assert.equal(MAX_PHOTO_DOWNLOADS, 20);
  assert.throws(
    () => ensureEvidenceOutsideRepository(path.join('C:\\repo', 'evidence'), 'C:\\repo'),
    /outside repository/
  );
  const ab = evaluateAbResult(
    [{ id: '1', url: `${fakeOrigin}/a.jpg?x=1`, markName: 'A' }],
    [{ id: '1', url: `${fakeOrigin}/a.jpg?x=2`, markName: 'A' }],
    'markName',
    'A',
    { httpOk: true, httpStatus: 200, traceId: 'trace', payload: { code: 0 } },
    salt
  );
  assert.equal(ab.resultSetChanged, false);
  assert.equal(ab.assessment, '不支持或未证明支持');
  const makeNeedMarkGroup = (label, ids, options = {}) => ({
    label,
    needMark: label === 'omitted' ? null : Number(label.at(-1)),
    records: ids.map((id) => ({ id })),
    idSet: new Set(ids),
    failed: Boolean(options.failed),
    truncated: Boolean(options.truncated)
  });
  const ignoredGroups = [
    makeNeedMarkGroup('omitted', ['a', 'b']),
    makeNeedMarkGroup('need_mark_0', ['a', 'b']),
    makeNeedMarkGroup('need_mark_1', ['a', 'b']),
    makeNeedMarkGroup('need_mark_2', ['a', 'b'])
  ];
  const ignoredRelations = buildNeedMarkRelations(ignoredGroups);
  assert.equal(ignoredRelations.omittedEqualsZero, true);
  assert.equal(classifyNeedMarkSupport(ignoredGroups, ignoredRelations, ['a', 'b']), 'C');
  const supportedGroups = [
    makeNeedMarkGroup('omitted', ['a', 'b']),
    makeNeedMarkGroup('need_mark_0', ['a', 'b']),
    makeNeedMarkGroup('need_mark_1', ['a']),
    makeNeedMarkGroup('need_mark_2', ['b'])
  ];
  const supportedRelations = buildNeedMarkRelations(supportedGroups);
  assert.equal(supportedRelations.oneTwoDisjoint, true);
  assert.equal(supportedRelations.oneTwoUnionEqualsZero, true);
  assert.equal(classifyNeedMarkSupport(supportedGroups, supportedRelations, ['a', 'b']), 'A');
  const rejectedGroups = supportedGroups.map((entry) => ({
    ...entry,
    failed: entry.label === 'need_mark_2'
  }));
  assert.equal(
    classifyNeedMarkSupport(rejectedGroups, buildNeedMarkRelations(rejectedGroups), ['a', 'b']),
    'D'
  );
  const changedGroups = [
    makeNeedMarkGroup('omitted', ['a', 'b', 'c']),
    makeNeedMarkGroup('need_mark_0', ['a', 'b', 'c']),
    makeNeedMarkGroup('need_mark_1', ['a', 'c']),
    makeNeedMarkGroup('need_mark_2', ['b', 'c'])
  ];
  assert.equal(
    classifyNeedMarkSupport(changedGroups, buildNeedMarkRelations(changedGroups), ['a', 'b']),
    'B'
  );
  process.stdout.write('SELF_CHECK_OK scenarios=10 assertions=25\n');
}

async function main() {
  if (process.argv.includes('--self-check')) {
    await runSelfCheck();
    return;
  }
  if (!process.argv.includes('--real') && !process.argv.includes('--audit')) {
    process.stderr.write(
      'This audit script is offline by default. Use --self-check or run it with Electron and --audit.\n'
    );
    process.exitCode = 2;
    return;
  }
  await runRealAudit();
}

if (!IS_AUDIT_CHILD_PROCESS) {
  main().catch((error) => {
    const candidateCode = String(error?.code || '');
    const code =
      error instanceof AuditError || /^[a-z][a-z0-9_]{1,63}$/.test(candidateCode)
        ? candidateCode
        : `unexpected_${String(activeAuditPhase).replace(/[^a-z0-9_]/g, '_')}`;
    process.stderr.write(`AUDIT_FAILED code=${code}\n`);
    try {
      require('electron').app.quit();
    } catch {
      // Node self-check mode does not expose Electron.
    }
    process.exitCode = 1;
  });
}

module.exports = {
  buildRawFieldMatrix,
  buildSafeMomentDescriptor,
  ensureEvidenceOutsideRepository,
  evaluateAbResult,
  findCandidatePairs,
  fingerprintUrl,
  formatUtc8DateTime,
  parseContentEntries,
  stableHash
};
