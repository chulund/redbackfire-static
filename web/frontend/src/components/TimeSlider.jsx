/**
 * TimeSlider — dual-handle range slider for temporal filtering.
 * Redesigned: single visual track with two draggable handles, clear labels,
 * highlighted selection range, and a working reset button.
 */

function formatTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-AU', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}

export default function TimeSlider({ timeRange, timeFilter, onChange }) {
  const minTs = timeRange.min ? new Date(timeRange.min).getTime() : 0;
  const maxTs = timeRange.max ? new Date(timeRange.max).getTime() : 0;
  const range = maxTs - minTs || 1;

  const curMin = timeFilter.min ? new Date(timeFilter.min).getTime() : minTs;
  const curMax = timeFilter.max ? new Date(timeFilter.max).getTime() : maxTs;

  // Highlight bar percentage
  const leftPct = ((curMin - minTs) / range) * 100;
  const rightPct = ((maxTs - curMax) / range) * 100;

  const isFiltered = timeFilter.min != null || timeFilter.max != null;

  const handleStartChange = (e) => {
    const ts = Math.min(Number(e.target.value), curMax);
    onChange({
      min: new Date(ts).toISOString(),
      max: timeFilter.max || new Date(maxTs).toISOString(),
    });
  };

  const handleEndChange = (e) => {
    const ts = Math.max(Number(e.target.value), curMin);
    onChange({
      min: timeFilter.min || new Date(minTs).toISOString(),
      max: new Date(ts).toISOString(),
    });
  };

  const handleReset = () => {
    onChange({ min: null, max: null });
  };

  if (!timeRange.min || !timeRange.max) {
    return (
      <div className="time-slider-bar">
        <span className="time-label text-muted">No time data available</span>
      </div>
    );
  }

  return (
    <div className="time-slider-bar">
      {/* Left label */}
      <div className="time-info">
        <span className="time-label-main">{formatTime(timeFilter.min || timeRange.min)}</span>
        <span className="time-label-sub">From</span>
      </div>

      {/* Dual-handle range slider */}
      <div className="range-slider-container">
        {/* Visual track bg + highlight */}
        <div className="range-track">
          <div
            className="range-highlight"
            style={{ left: `${leftPct}%`, right: `${rightPct}%` }}
          />
        </div>
        {/* Start handle */}
        <input
          type="range"
          className="range-input range-start"
          min={minTs}
          max={maxTs}
          value={curMin}
          onChange={handleStartChange}
          step={600000}
        />
        {/* End handle */}
        <input
          type="range"
          className="range-input range-end"
          min={minTs}
          max={maxTs}
          value={curMax}
          onChange={handleEndChange}
          step={600000}
        />
      </div>

      {/* Right label */}
      <div className="time-info" style={{ textAlign: 'right' }}>
        <span className="time-label-main">{formatTime(timeFilter.max || timeRange.max)}</span>
        <span className="time-label-sub">To</span>
      </div>

      {/* Reset button */}
      <button
        className={`time-btn reset-btn ${isFiltered ? 'active' : ''}`}
        onClick={handleReset}
        title="Reset time filter"
        disabled={!isFiltered}
      >
        ↺ Reset
      </button>
    </div>
  );
}
