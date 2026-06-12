const STORAGE_KEY = 'property-photo-archive-assistant:recent-records';
const MAX_RECORDS = 10;

export function loadRecentRecords() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveRecentRecords(records) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records.slice(0, MAX_RECORDS)));
}

export function addRecentRecord(records, form) {
  const record = {
    id: `${Date.now()}`,
    savedAt: new Date().toISOString(),
    project: form.project,
    department: form.department,
    photoSource: form.photoSource,
    watermarkCategory: form.watermarkCategory,
    workContent: form.workContent,
    location: form.location,
    workItem: form.workItem,
    photoStage: form.photoStage,
    processStatus: form.processStatus,
    keywords: form.keywords,
    remark: form.remark
  };

  const fingerprint = buildFingerprint(record);
  const next = [
    record,
    ...records.filter((item) => buildFingerprint(item) !== fingerprint)
  ].slice(0, MAX_RECORDS);

  saveRecentRecords(next);
  return next;
}

export function clearRecentRecords() {
  window.localStorage.removeItem(STORAGE_KEY);
  return [];
}

function buildFingerprint(record) {
  return [
    record.project,
    record.department,
    record.photoSource,
    record.watermarkCategory,
    record.workContent,
    record.location,
    record.workItem,
    record.photoStage,
    record.processStatus,
    record.keywords,
    record.remark
  ].join('|');
}
