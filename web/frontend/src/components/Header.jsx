import { useState, useEffect } from 'react';

/**
 * Format a UTC Date to both UTC and AEST strings.
 * AEST = UTC+10 (no DST in April in NSW — AEST not AEDT).
 */
function formatDualTime(date) {
  if (!date) return { utc: '—', aest: '—' };
  const utc = date.toLocaleString('en-AU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: 'UTC',
  }) + ' UTC';
  const aest = date.toLocaleString('en-AU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: 'Australia/Sydney',
  }) + ' AEST';
  return { utc, aest };
}

export default function Header({ status, mode, onModeChange, sidebarOpen, onToggleSidebar, layerPanelOpen, onToggleLayers, rtMetadata, rtMonitoringHours, lastFetchTime }) {
  const isOk = status && status.status === 'ok';

  // Live clock (updates every second)
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const { utc, aest } = formatDualTime(now);

  // Data freshness
  const freshnessText = (() => {
    if (!lastFetchTime) return null;
    const ageSec = Math.floor((now - lastFetchTime) / 1000);
    if (ageSec < 5) return 'Just now';
    if (ageSec < 60) return `${ageSec}s ago`;
    const ageMin = Math.floor(ageSec / 60);
    return `${ageMin}m ago`;
  })();
  const freshnessAgeSec = lastFetchTime ? Math.floor((now - lastFetchTime) / 1000) : 0;
  const freshnessClass = freshnessAgeSec > 300 ? 'stale' : freshnessAgeSec > 60 ? 'warn' : '';

  return (
    <header className="app-header">
      <div className="logo">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 1C12 1 8 5 6 8c-1 1.5-1.5 3-1.5 4.5C4.5 16.64 7.86 20 12 20s7.5-3.36 7.5-7.5c0-1.5-.5-3-1.5-4.5C16 5 12 1 12 1zm0 17c-3.04 0-5.5-2.46-5.5-5.5 0-1.12.38-2.27 1.12-3.38C8.88 7.38 12 4.5 12 4.5s3.12 2.88 4.38 4.62c.74 1.11 1.12 2.26 1.12 3.38 0 3.04-2.46 5.5-5.5 5.5z"/>
          <circle cx="12" cy="13" r="3"/>
        </svg>
        <span className="logo-text">Redback Fire</span>
      </div>

      {/* Mode tabs */}
      <div className="mode-tabs">
        <button
          className={`mode-tab ${mode === 'realtime' ? 'active' : ''}`}
          onClick={() => onModeChange('realtime')}
        >
          <span className={`live-dot ${mode === 'realtime' ? 'pulse' : ''}`} />
          Real-Time
        </button>
        <button
          className={`mode-tab ${mode === 'historical' ? 'active' : ''}`}
          onClick={() => onModeChange('historical')}
        >
          Historical
        </button>
        <button
          className={`mode-tab ${mode === 'simulation' ? 'active' : ''}`}
          onClick={() => onModeChange('simulation')}
        >
          🔥 Fire Spread
        </button>
      </div>

      <span className="header-divider header-divider-primary">|</span>

      <button
        className={`header-toggle-btn header-toggle-primary ${sidebarOpen ? 'active' : ''}`}
        title="Toggle fire panel"
        aria-pressed={sidebarOpen}
        onClick={onToggleSidebar}
      >
        🔥 {mode === 'simulation' ? 'Simulation' : mode === 'realtime' ? 'Hotspots' : 'Fires'} ON/OFF
      </button>

      <button
        className={`header-toggle-btn header-toggle-secondary ${layerPanelOpen ? 'active' : ''}`}
        title="Toggle layer panel"
        aria-pressed={layerPanelOpen}
        onClick={onToggleLayers}
      >
        🗂️ Layers ON/OFF
      </button>

      <span className="header-divider header-divider-secondary">|</span>

      {/* Clock — dual UTC/AEST */}
      <div className="header-clock">
        <span className="clock-time">{utc}</span>
        <span className="clock-time aest">{aest}</span>
      </div>

      {/* Status badge */}
      <div className="header-status-cluster">
        <div className="status-badge">
          <span className={`status-dot ${isOk ? '' : 'offline'}`} />
          <span className="status-mode-label">
            {mode === 'simulation' ? 'Simulation' : mode === 'realtime' ? 'RT Feed' : 'Historical'}
          </span>
          {mode === 'simulation' ? (
            <span>Inferno Fire Simulation</span>
          ) : mode === 'realtime' ? (
            rtMetadata ? (
              <span>{rtMetadata.total || 0} hotspots ({rtMonitoringHours || 12}h)</span>
            ) : (
              <span className="text-muted">Loading...</span>
            )
          ) : (
            isOk ? (
              <>
                {status.fire_event_count} fires · {status.hotspot_count} hotspots
                <span className="text-muted" style={{ marginLeft: 4 }}>
                  (dummy data · {status.run_dir})
                </span>
              </>
            ) : (
              <span className="text-muted">No data</span>
            )
          )}
        </div>
        {freshnessText && (
          <span className={`header-freshness ${freshnessClass}`} title="Time since last data update">
            {freshnessText}
          </span>
        )}
      </div>
    </header>
  );
}
