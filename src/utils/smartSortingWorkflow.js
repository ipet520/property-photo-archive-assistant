import { RECOGNITION_MODES, RECOGNITION_PROVIDERS } from './recognitionTypes.js';

export const SMART_SORT_WORKFLOW_STEPS = [
  { key: 'import', label: '导入照片', ready: true },
  { key: 'recognize', label: '识别照片信息', ready: false },
  { key: 'group', label: '生成事项组', ready: false },
  { key: 'suggest', label: '生成归档建议', ready: true },
  { key: 'review', label: '人工审核修正', ready: true },
  { key: 'archive', label: '确认归档', ready: true }
];

export const SMART_SORTING_CAPABILITY = {
  recognitionModes: RECOGNITION_MODES,
  recognitionProviders: RECOGNITION_PROVIDERS,
  currentRecognitionEnabled: false,
  currentVersionScope: 'architecture_ready',
  safety: {
    uploadsPhotos: false,
    autoArchives: false,
    writesLedgerAutomatically: false,
    modifiesOriginalPhotos: false
  },
  recognitionInput: {
    acceptsRecognitionResults: true,
    acceptsRecognitionFields: true,
    currentProviderStatus: 'not_configured',
    currentBehavior: '规则建议继续可用，但不会冒充识别驱动分组。'
  }
};
