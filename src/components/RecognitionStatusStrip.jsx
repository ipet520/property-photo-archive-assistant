import { useEffect, useState } from 'react';
import { getRecognitionStatus } from '../utils/recognitionClient.js';

const fallbackStatus = {
  serviceStatus: 'available',
  engineStatus: 'not_configured',
  message: '识别服务底座已接入，识别引擎待配置。',
  currentProcessing: '手动填写归档信息'
};

export default function RecognitionStatusStrip({ compact = false }) {
  const [status, setStatus] = useState(fallbackStatus);

  useEffect(() => {
    let active = true;
    getRecognitionStatus()
      .then((nextStatus) => {
        if (active && nextStatus) setStatus({ ...fallbackStatus, ...nextStatus });
      })
      .catch(() => {
        if (active) {
          setStatus({
            ...fallbackStatus,
            serviceStatus: 'error',
            message: '识别服务状态读取失败，当前仍可手动填写归档信息。'
          });
        }
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className={`recognition-status-strip ${compact ? 'compact' : ''}`} aria-label="识别服务状态">
      <span className={`recognition-status-dot ${status.engineStatus === 'available' ? 'ready' : 'waiting'}`} />
      <span>{status.message || fallbackStatus.message}</span>
      <span>{status.currentProcessing ? `当前处理方式：${status.currentProcessing}` : fallbackStatus.currentProcessing}</span>
    </div>
  );
}
