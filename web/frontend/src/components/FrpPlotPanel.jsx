import { useEffect, useMemo, useRef, useState } from 'react';
import {
  FRP_SOURCES,
  toFrpPoint,
  filterPoints,
  computeWindowFromPoints,
} from '../utils/frpNormalize';
import { downloadChartPng, downloadPointsCsv } from '../utils/frpExport';

const SOURCE_STYLES = {
  [FRP_SOURCES.BRIGHT_20]: { color: '#1f77b4', shape: 'circle', size: 7 },
  [FRP_SOURCES.BRIGHT_186]: { color: '#ff7f0e', shape: 'triangle', size: 9 },
};

const CHART_W = 560;
const CHART_H = 320;
const PAD = { top: 20, right: 20, bottom: 54, left: 58 };
const PLOT_W = CHART_W - PAD.left - PAD.right;
const PLOT_H = CHART_H - PAD.top - PAD.bottom;

function toLocalInputValue(date) {
  if (!date) return '';
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60000);
  return local.toISOString().slice(0, 16);
}

function fromLocalInputValue(str) {
  if (!str) return null;
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatAestShort(date) {
  if (!date) return '';
  return date.toLocaleString('en-AU', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    timeZone: 'Australia/Sydney',
  });
}

function linspace(a, b, n) {
  if (n <= 1) return [a];
  const step = (b - a) / (n - 1);
  return Array.from({ length: n }, (_, i) => a + step * i);
}

function niceMaxY(maxVal) {
  if (!Number.isFinite(maxVal) || maxVal <= 0) return 10;
  const exp = Math.floor(Math.log10(maxVal));
  const base = Math.pow(10, exp);
  const rel = maxVal / base;
  let nice;
  if (rel <= 1) nice = 1;
  else if (rel <= 2) nice = 2;
  else if (rel <= 5) nice = 5;
  else nice = 10;
  return nice * base;
}

function ScatterChart({ plottable, startTime, endTime, svgRef }) {
  const maxY = useMemo(() => {
    if (plottable.length === 0) return 10;
    const m = Math.max(...plottable.map((p) => p.frp_mw));
    return niceMaxY(m * 1.1);
  }, [plottable]);

  const startMs = startTime?.getTime() ?? 0;
  const endMs = endTime?.getTime() ?? 1;
  const xSpan = Math.max(1, endMs - startMs);

  const xScale = (t) => PAD.left + ((t - startMs) / xSpan) * PLOT_W;
  const yScale = (v) => PAD.top + PLOT_H - (v / maxY) * PLOT_H;

  const xTicks = linspace(startMs, endMs, 5).map((ms) => new Date(ms));
  const yTicks = linspace(0, maxY, 5);

  return (
    <svg
      ref={svgRef}
      className="frp-chart-svg"
      width={CHART_W}
      height={CHART_H}
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x={0} y={0} width={CHART_W} height={CHART_H} fill="#1a1a2e" />
      <rect
        x={PAD.left} y={PAD.top} width={PLOT_W} height={PLOT_H}
        fill="#101020" stroke="rgba(255,255,255,0.15)" strokeWidth={1}
      />
      {yTicks.map((v, i) => {
        const y = yScale(v);
        return (
          <g key={`yt-${i}`}>
            <line
              x1={PAD.left} x2={PAD.left + PLOT_W} y1={y} y2={y}
              stroke="rgba(255,255,255,0.08)" strokeDasharray="3,3"
            />
            <text x={PAD.left - 6} y={y + 4} textAnchor="end" fill="#c0c0d0" fontSize="11">
              {v.toFixed(v >= 100 ? 0 : 1)}
            </text>
          </g>
        );
      })}
      {xTicks.map((d, i) => {
        const x = xScale(d.getTime());
        return (
          <g key={`xt-${i}`}>
            <line
              x1={x} x2={x} y1={PAD.top} y2={PAD.top + PLOT_H}
              stroke="rgba(255,255,255,0.06)" strokeDasharray="3,3"
            />
            <text
              x={x} y={PAD.top + PLOT_H + 18}
              textAnchor="middle" fill="#c0c0d0" fontSize="10"
            >
              {formatAestShort(d)}
            </text>
          </g>
        );
      })}
      <text
        x={PAD.left - 42} y={PAD.top + PLOT_H / 2}
        transform={`rotate(-90 ${PAD.left - 42} ${PAD.top + PLOT_H / 2})`}
        textAnchor="middle" fill="#e0e0e0" fontSize="12"
      >
        FRP (MW)
      </text>
      <text
        x={PAD.left + PLOT_W / 2} y={CHART_H - 6}
        textAnchor="middle" fill="#e0e0e0" fontSize="12"
      >
        Time (AEST)
      </text>
      {plottable.map((p, i) => {
        const style = SOURCE_STYLES[p.source] || SOURCE_STYLES[FRP_SOURCES.BRIGHT_20];
        const x = xScale(p.detection_time.getTime());
        const y = yScale(p.frp_mw);
        if (style.shape === 'triangle') {
          const s = style.size;
          const path = `M ${x} ${y - s} L ${x + s} ${y + s} L ${x - s} ${y + s} Z`;
          return (
            <path
              key={`pt-${i}`} d={path}
              fill={style.color} stroke="#000" strokeWidth={0.7} opacity={0.9}
            />
          );
        }
        return (
          <circle
            key={`pt-${i}`} cx={x} cy={y} r={style.size}
            fill={style.color} stroke="#000" strokeWidth={0.7} opacity={0.9}
          />
        );
      })}
      <g transform={`translate(${PAD.left + 8}, ${PAD.top + 8})`}>
        <rect x={0} y={0} width={130} height={44} fill="rgba(0,0,0,0.45)" rx={4} />
        <circle cx={12} cy={14} r={6} fill="#1f77b4" stroke="#000" strokeWidth={0.7} />
        <text x={24} y={18} fill="#e0e0e0" fontSize="11">BRIGHT 2.0</text>
        <path d="M 6 34 L 18 34 L 12 24 Z" fill="#ff7f0e" stroke="#000" strokeWidth={0.7} />
        <text x={24} y={38} fill="#e0e0e0" fontSize="11">BRIGHT 1.86</text>
      </g>
    </svg>
  );
}

export default function FrpPlotPanel({
  selectedSummaries,
  onClose,
  onClearSelection,
  onRemoveOne,
  onExitSelectionMode,
  selectionModeActive,
  onToggleSelectionMode,
}) {
  const svgRef = useRef(null);

  const points = useMemo(() => {
    return (selectedSummaries || [])
      .map(toFrpPoint)
      .filter(Boolean);
  }, [selectedSummaries]);

  const defaultWindow = useMemo(() => computeWindowFromPoints(points), [points]);

  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [sourcesEnabled, setSourcesEnabled] = useState({
    [FRP_SOURCES.BRIGHT_20]: true,
    [FRP_SOURCES.BRIGHT_186]: true,
  });
  const [plotGenerated, setPlotGenerated] = useState(false);
  const [previewEnabled, setPreviewEnabled] = useState(true);
  const [downloadError, setDownloadError] = useState(null);

  useEffect(() => {
    if (defaultWindow.start) setStart((prev) => prev || toLocalInputValue(defaultWindow.start));
    if (defaultWindow.end) setEnd((prev) => prev || toLocalInputValue(defaultWindow.end));
  }, [defaultWindow.start, defaultWindow.end]);

  const startDate = fromLocalInputValue(start) || defaultWindow.start;
  const endDate = fromLocalInputValue(end) || defaultWindow.end;

  const filtered = useMemo(() => {
    if (points.length === 0) {
      return { plottable: [], skippedNoFrp: 0, skippedOutOfWindow: 0 };
    }
    return filterPoints(points, { start: startDate, end: endDate, sourcesEnabled });
  }, [points, startDate, endDate, sourcesEnabled]);

  const sourceCounts = useMemo(() => {
    const counts = { [FRP_SOURCES.BRIGHT_20]: 0, [FRP_SOURCES.BRIGHT_186]: 0 };
    for (const p of points) counts[p.source] = (counts[p.source] || 0) + 1;
    return counts;
  }, [points]);

  const canGenerate = points.length > 0 && startDate && endDate && endDate > startDate;
  const showChart = plotGenerated && filtered.plottable.length > 0;
  const showEmptyBanner = plotGenerated && filtered.plottable.length === 0;

  const handleGenerate = () => {
    setDownloadError(null);
    setPlotGenerated(true);
  };

  const handleDownloadPng = async () => {
    try {
      setDownloadError(null);
      await downloadChartPng(svgRef.current, `frp_plot_${Date.now()}.png`);
    } catch (err) {
      setDownloadError(err?.message || 'PNG export failed');
    }
  };

  const handleDownloadCsv = () => {
    try {
      setDownloadError(null);
      downloadPointsCsv(filtered.plottable, `frp_points_${Date.now()}.csv`);
    } catch (err) {
      setDownloadError(err?.message || 'CSV export failed');
    }
  };

  const handleCloseClick = () => {
    onExitSelectionMode?.();
    onClose?.();
  };

  return (
    <div className={`search-tool-panel frp-plot-panel ${previewEnabled ? 'expanded' : 'collapsed'}`}>
      <div className="search-tool-header">
        <h3>Plot FRP vs Time</h3>
        <button type="button" className="search-tool-close" onClick={handleCloseClick}>×</button>
      </div>

      <div className="frp-body">
        <div className="frp-col frp-col-controls">

      <div className="search-tool-section">
        <div className="search-tool-section-title">Selection Mode</div>
        <button
          type="button"
          className={`mode-btn ${selectionModeActive ? 'active' : ''}`}
          style={{ width: '100%' }}
          onClick={onToggleSelectionMode}
        >
          {selectionModeActive ? '● Selection ON — drag on map' : '○ Selection OFF'}
        </button>
        <div className="frp-hint">
          Drag on the map to select hotspots inside an area. A short click toggles a single hotspot.
        </div>
      </div>

      <div className="search-tool-section">
        <div className="search-tool-section-title">
          Selection ({points.length})
          <span className="frp-source-counts">
            {sourceCounts[FRP_SOURCES.BRIGHT_20]}× 2.0 · {sourceCounts[FRP_SOURCES.BRIGHT_186]}× 1.86
          </span>
        </div>
        {points.length === 0 ? (
          <div className="frp-empty">No hotspots selected.</div>
        ) : (
          <div className="frp-selection-list">
            {points.slice(0, 20).map((p) => (
              <div key={p.key} className="frp-selection-item">
                <span
                  className={`frp-source-marker ${p.source === FRP_SOURCES.BRIGHT_186 ? 'triangle' : 'circle'}`}
                  style={{ background: SOURCE_STYLES[p.source].color }}
                />
                <span className="frp-selection-id" title={p.hotspot_id}>{p.hotspot_id}</span>
                <span className="frp-selection-meta">
                  {p.frp_mw != null ? `${p.frp_mw.toFixed(1)} MW` : '—'}
                </span>
                <button
                  type="button"
                  className="frp-selection-remove"
                  onClick={() => onRemoveOne?.(p.key)}
                  title="Remove"
                >
                  ×
                </button>
              </div>
            ))}
            {points.length > 20 && (
              <div className="frp-empty">… {points.length - 20} more</div>
            )}
          </div>
        )}
        {points.length > 0 && (
          <button
            type="button"
            className="mode-btn"
            style={{ width: '100%', marginTop: 6 }}
            onClick={onClearSelection}
          >
            Clear selection
          </button>
        )}
      </div>

      <div className="search-tool-section">
        <div className="search-tool-section-title">Time Window (local)</div>
        <label className="frp-label">Start</label>
        <input
          type="datetime-local"
          className="search-tool-input"
          value={start}
          onChange={(e) => setStart(e.target.value)}
        />
        <label className="frp-label">End</label>
        <input
          type="datetime-local"
          className="search-tool-input"
          value={end}
          onChange={(e) => setEnd(e.target.value)}
        />
      </div>

      <div className="search-tool-section">
        <div className="search-tool-section-title">Sources</div>
        <label className="frp-checkbox">
          <input
            type="checkbox"
            checked={sourcesEnabled[FRP_SOURCES.BRIGHT_20]}
            onChange={(e) => setSourcesEnabled((s) => ({ ...s, [FRP_SOURCES.BRIGHT_20]: e.target.checked }))}
          />
          <span className="frp-source-dot" style={{ background: '#1f77b4' }} /> BRIGHT 2.0
        </label>
        <label className="frp-checkbox">
          <input
            type="checkbox"
            checked={sourcesEnabled[FRP_SOURCES.BRIGHT_186]}
            onChange={(e) => setSourcesEnabled((s) => ({ ...s, [FRP_SOURCES.BRIGHT_186]: e.target.checked }))}
          />
          <span className="frp-source-dot triangle" style={{ background: '#ff7f0e' }} /> BRIGHT 1.86
        </label>
      </div>

      <div className="search-tool-section">
        <button
          type="button"
          className="mode-btn active"
          style={{ width: '100%' }}
          disabled={!canGenerate}
          onClick={handleGenerate}
        >
          Generate Plot
        </button>
        {filtered.skippedNoFrp > 0 && (
          <div className="frp-hint">{filtered.skippedNoFrp} point(s) skipped — no FRP value.</div>
        )}
        {filtered.skippedOutOfWindow > 0 && (
          <div className="frp-hint">{filtered.skippedOutOfWindow} point(s) outside window.</div>
        )}
        {showChart && (
          <div className="frp-download-row">
            <button type="button" className="mode-btn active" onClick={handleDownloadPng}>
              Download PNG
            </button>
            <button type="button" className="mode-btn" onClick={handleDownloadCsv}>
              Download CSV
            </button>
          </div>
        )}
        {showEmptyBanner && (
          <div className="frp-empty error">No FRP values in the selected window.</div>
        )}
        {downloadError && <div className="frp-empty error">{downloadError}</div>}
        <label className="frp-checkbox" style={{ marginTop: 8 }}>
          <input
            type="checkbox"
            checked={previewEnabled}
            onChange={(e) => setPreviewEnabled(e.target.checked)}
          />
          Preview Plot
        </label>
      </div>

        </div>

        {previewEnabled && (
          <div className="frp-col frp-col-preview">
            <div className="search-tool-section frp-preview-section">
              <div className="search-tool-section-title">Preview</div>
              {!plotGenerated && (
                <div className="frp-empty">Configure selection and press Generate Plot to preview.</div>
              )}
              {showEmptyBanner && (
                <div className="frp-empty error">No FRP values in the selected window.</div>
              )}
              {showChart && (
                <div className="frp-chart-wrap">
                  <ScatterChart
                    plottable={filtered.plottable}
                    startTime={startDate}
                    endTime={endDate}
                    svgRef={svgRef}
                  />
                </div>
              )}
            </div>
          </div>
        )}
        {!previewEnabled && showChart && (
          <div className="frp-offscreen-chart" aria-hidden="true">
            <ScatterChart
              plottable={filtered.plottable}
              startTime={startDate}
              endTime={endDate}
              svgRef={svgRef}
            />
          </div>
        )}
      </div>
    </div>
  );
}
