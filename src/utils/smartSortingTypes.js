export const SMART_GROUP_STATUSES = ['pending_review', 'needs_fix', 'confirmed', 'ignored'];

export const SMART_GROUP_CONFIDENCE = ['high', 'medium', 'low', 'unknown'];

export function createEmptySmartPhotoGroup(overrides = {}) {
  return {
    groupId: '',
    groupName: '',
    photos: [],
    recognitionResults: [],
    recognitionBasis: [],
    project: '',
    location: '',
    dateRange: {
      start: '',
      end: ''
    },
    workContent: '',
    keywords: [],
    suggestedArchiveFields: {
      photoSource: '',
      project: '',
      department: '',
      watermarkCategory: '',
      workContent: '',
      date: '',
      location: '',
      itemName: '',
      photoStage: '',
      processStatus: '',
      keywords: '',
      remark: ''
    },
    missingFields: [],
    riskWarnings: [],
    confidence: 'unknown',
    status: 'pending_review',
    dataSources: {
      fileTime: true,
      fileName: true,
      recognition: false,
      manualCorrection: false
    },
    ...overrides
  };
}
