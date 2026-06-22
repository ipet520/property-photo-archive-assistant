import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const previewWidth = 400;
const previewHeight = 340;
const previewGap = 14;
const viewportGap = 8;
const previewDelay = 700;
const movementThreshold = 12;

export default function ThumbnailHoverPreview({ src, alt, className = '' }) {
  const [preview, setPreview] = useState(null);
  const [failed, setFailed] = useState(false);
  const timerRef = useRef(null);
  const imageRef = useRef(null);
  const anchorRef = useRef(null);

  function clearPendingPreview() {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  function hidePreview() {
    clearPendingPreview();
    anchorRef.current = null;
    setPreview(null);
  }

  function showPreview() {
    if (!src || !imageRef.current) return;
    const rect = imageRef.current.getBoundingClientRect();
    const availableWidth = Math.min(previewWidth, window.innerWidth - viewportGap * 2);
    const availableHeight = Math.min(previewHeight, window.innerHeight - viewportGap * 2);
    const rightPosition = rect.right + previewGap;
    const left = rightPosition + availableWidth <= window.innerWidth - viewportGap
      ? rightPosition
      : Math.max(viewportGap, rect.left - availableWidth - previewGap);
    const top = Math.min(
      Math.max(viewportGap, rect.top + rect.height / 2 - availableHeight / 2),
      Math.max(viewportGap, window.innerHeight - availableHeight - viewportGap)
    );
    setFailed(false);
    setPreview({ left, top });
  }

  function schedulePreview(clientX, clientY) {
    clearPendingPreview();
    anchorRef.current = { x: clientX, y: clientY };
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      showPreview();
    }, previewDelay);
  }

  function handleMouseMove(event) {
    const anchor = anchorRef.current;
    if (!anchor) return;
    if (Math.hypot(event.clientX - anchor.x, event.clientY - anchor.y) > movementThreshold) {
      setPreview(null);
      schedulePreview(event.clientX, event.clientY);
    }
  }

  useEffect(() => {
    const cancelPreview = () => hidePreview();
    window.addEventListener('scroll', cancelPreview, true);
    window.addEventListener('wheel', cancelPreview, true);
    document.addEventListener('pointerdown', cancelPreview, true);
    document.addEventListener('dragstart', cancelPreview, true);
    return () => {
      clearPendingPreview();
      window.removeEventListener('scroll', cancelPreview, true);
      window.removeEventListener('wheel', cancelPreview, true);
      document.removeEventListener('pointerdown', cancelPreview, true);
      document.removeEventListener('dragstart', cancelPreview, true);
    };
  }, []);

  return (
    <>
      <img
        ref={imageRef}
        src={src}
        alt={alt}
        className={className}
        onMouseEnter={(event) => schedulePreview(event.clientX, event.clientY)}
        onMouseMove={handleMouseMove}
        onMouseLeave={hidePreview}
        onMouseDown={hidePreview}
        onClick={hidePreview}
        onWheel={hidePreview}
        onDragStart={hidePreview}
      />
      {preview && createPortal(
        <div className="thumbnail-hover-preview" style={preview} aria-hidden="true">
          {failed
            ? <span>预览失败</span>
            : <img src={src} alt="" onError={() => setFailed(true)} />}
        </div>,
        document.body
      )}
    </>
  );
}
