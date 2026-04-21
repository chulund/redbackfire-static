import { useEffect, useRef } from 'react';

export default function ToolsMenu({ open, onClose, onOpenSearch, onOpenFrpPlot, searchActive, frpActive }) {
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        onClose?.();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="tools-menu" ref={menuRef}>
      {onOpenSearch && (
        <button
          type="button"
          className={`tools-menu-item ${searchActive ? 'active' : ''}`}
          onClick={() => { onOpenSearch?.(); onClose?.(); }}
        >
          <span className="tools-menu-icon">🔍</span>
          <span className="tools-menu-label">Search &amp; Export</span>
        </button>
      )}
      {onOpenFrpPlot && (
        <button
          type="button"
          className={`tools-menu-item ${frpActive ? 'active' : ''}`}
          onClick={() => { onOpenFrpPlot?.(); onClose?.(); }}
        >
          <span className="tools-menu-icon">📈</span>
          <span className="tools-menu-label">Plot FRP vs Time</span>
        </button>
      )}
    </div>
  );
}
