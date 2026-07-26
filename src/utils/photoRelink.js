const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function getExpectedLocalPhotoSha256(photo = {}) {
  return normalizeSha256(photo?.fileHealth?.expectedSha256 || photo?.sha256);
}

export function selectLocalPhotoRelinkCandidate(photo = {}, candidates = []) {
  if (photo?.sourceType !== 'local_file') {
    return {
      success: false,
      reason: photo?.sourceType === 'marki_api'
        ? 'marki_requires_trusted_repair'
        : 'unsupported_source_type',
      candidate: null
    };
  }
  const expectedSha256 = getExpectedLocalPhotoSha256(photo);
  if (!expectedSha256) {
    return { success: false, reason: 'historical_fingerprint_missing', candidate: null };
  }
  const matches = (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => normalizeSha256(
      candidate?.fileHealth?.currentSha256 || candidate?.sha256
    ) === expectedSha256)
    .sort((left, right) => String(left?.path || '').localeCompare(
      String(right?.path || ''),
      'zh-CN'
    ));
  if (matches.length === 0) {
    return { success: false, reason: 'matching_fingerprint_not_found', candidate: null };
  }
  return {
    success: true,
    reason: '',
    candidate: matches[0],
    expectedSha256
  };
}

export function buildRelinkedLocalPhoto(photo = {}, candidate = {}, health = {}) {
  const expectedSha256 = getExpectedLocalPhotoSha256(photo);
  const currentSha256 = normalizeSha256(health?.currentSha256);
  if (
    photo?.sourceType !== 'local_file'
    || !expectedSha256
    || health?.healthStatus !== 'healthy'
    || health?.fingerprintMatches !== true
    || currentSha256 !== expectedSha256
  ) {
    return null;
  }
  const originalPath = String(health?.resolvedPath || candidate?.path || '').trim();
  if (!originalPath) return null;
  const previewUrl = String(candidate?.previewUrl || '').trim();
  return {
    ...photo,
    originalPath,
    originalName: String(candidate?.name || photo.originalName || '').trim(),
    extension: String(candidate?.extension || photo.extension || '').trim(),
    size: Number(health.size) || 0,
    width: Number(health.width) || 0,
    height: Number(health.height) || 0,
    modifiedAt: String(candidate?.modifiedAt || photo.modifiedAt || '').trim(),
    thumbnailPath: previewUrl,
    previewUrl,
    originalMissing: false,
    sortStatus: photo.missingSortStatus || photo.sortStatus,
    missingSortStatus: undefined,
    sha256: expectedSha256,
    fileHealth: {
      ...health,
      expectedSha256,
      currentSha256,
      fingerprintMatches: true,
      healthStatus: 'healthy',
      failureReason: ''
    }
  };
}

function normalizeSha256(value) {
  const text = String(value || '').trim().toLowerCase();
  return SHA256_PATTERN.test(text) ? text : '';
}
