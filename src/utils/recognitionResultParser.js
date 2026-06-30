import { normalizeRecognitionResult } from './recognitionTypes.js';
import { parseWatermarkText } from './watermarkTextParser.js';

export function parseRecognitionText(rawText = '', options = {}) {
  return parseWatermarkText(rawText, options);
}

export function normalizeRecognitionFieldsFromResult(result = {}) {
  return normalizeRecognitionResult(result).fields;
}

export function mergeRecognitionFields(...fieldSets) {
  return fieldSets.reduce((merged, fields = {}) => ({
    ...merged,
    ...Object.fromEntries(Object.entries(fields).filter(([, value]) => {
      if (Array.isArray(value)) return value.length > 0;
      return String(value || '').trim();
    })),
    keywords: unique([...(merged.keywords || []), ...(Array.isArray(fields.keywords) ? fields.keywords : [])])
  }), { keywords: [] });
}

function unique(values = []) {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
}
