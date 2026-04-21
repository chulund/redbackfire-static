import { useState, useEffect, useMemo, useCallback } from 'react';
import { getLgaTargetAreas, getSearchPreview, downloadSearchBundle } from '../api';

/**
 * Get today's 9:00 AM AEST (UTC+10) as a UTC ISO string for the default start time.
 */
function getDefault9amAestUtc() {
  const now = new Date();
  // AEST is UTC+10 → 9 AM AEST = 23:00 UTC the previous day
  const aestOffset = 10;
  const aestNow = new Date(now.getTime() + aestOffset * 3600000);
  const aestDate = aestNow.toISOString().slice(0, 10); // YYYY-MM-DD in AEST
  // 9:00 AM AEST → subtract 10h → 23:00 UTC day before
  const utcHour = 9 - aestOffset; // -1, so previous day 23:00
  const d = new Date(aestDate + 'T00:00:00Z');
  d.setUTCHours(d.getUTCHours() + utcHour);
  return d;
}

function toLocalInputValue(date) {
  if (!date) return '';
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60000);
  return local.toISOString().slice(0, 16);
}

function fromLocalInputValue(str) {
  if (!str) return null;
  return new Date(str);
}

function getLgaFeatureName(feature) {
  const p = feature?.properties || {};
  return p.abb_name || p.LGA_NAME || p.lga_name || p.name || p.NAME || null;
}

export default function SearchToolPanel({
  lgaData,
  onDrawBbox,
  drawnBbox,
  onClearBbox,
  onFlyTo,
  onHighlightLga,
  onClose,
}) {
  // Spatial mode: 'lga' | 'bbox'
  const [spatialMode, setSpatialMode] = useState('lga');

  // LGA selection
  const [lgaQuery, setLgaQuery] = useState('');
  const [selectedLga, setSelectedLga] = useState(null); // { name, geometry }

  // Target areas from ArcGIS
  const [targetAreas, setTargetAreas] = useState(null);
  const [targetAreasLoading, setTargetAreasLoading] = useState(false);
  const [targetAreasError, setTargetAreasError] = useState(null);

  // Time filter
  const defaultStart = useMemo(() => getDefault9amAestUtc(), []);
  const [startTime, setStartTime] = useState(toLocalInputValue(defaultStart));
  const [endTime, setEndTime] = useState(toLocalInputValue(new Date()));

  // Preview
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Download
  const [downloading, setDownloading] = useState(false);
  const [downloadResult, setDownloadResult] = useState(null);

  // Fetch target areas on mount
  useEffect(() => {
    setTargetAreasLoading(true);
    getLgaTargetAreas()
      .then(data => {
        setTargetAreas(data);
        setTargetAreasError(null);
      })
      .catch(err => setTargetAreasError(err.message))
      .finally(() => setTargetAreasLoading(false));
  }, []);

  // LGA search results from local data
  const lgaSearchResults = useMemo(() => {
    const query = lgaQuery.trim().toLowerCase();
    if (!query || !lgaData?.features?.length) return [];
    return lgaData.features
      .filter(f => (getLgaFeatureName(f) || '').toLowerCase().includes(query))
      .slice(0, 10);
  }, [lgaData, lgaQuery]);

  // Check if an LGA name is a target area
  const isTargetLga = useCallback((name) => {
    if (!targetAreas?.targets?.length || !name) return false;
    const lower = name.toLowerCase();
    return targetAreas.targets.some(t => (t.lga_name || '').toLowerCase() === lower);
  }, [targetAreas]);

  // Build request params
  const buildRequestParams = useCallback(() => {
    const s = fromLocalInputValue(startTime);
    const e = fromLocalInputValue(endTime);
    if (!s || !e) return null;

    const params = {
      start_utc: s.toISOString(),
      end_utc: e.toISOString(),
    };

    if (spatialMode === 'lga') {
      if (!selectedLga) return null;
      params.mode = 'lga';
      params.lga_name = selectedLga.name;
      if (selectedLga.geometry) {
        params.lga_geometry = selectedLga.geometry;
      }
    } else if (spatialMode === 'bbox') {
      if (!drawnBbox) return null;
      params.mode = 'bbox';
      params.bbox = drawnBbox;
    }

    return params;
  }, [spatialMode, selectedLga, drawnBbox, startTime, endTime]);

  const canSearch = useMemo(() => {
    if (!fromLocalInputValue(startTime) || !fromLocalInputValue(endTime)) return false;
    if (spatialMode === 'lga') return !!selectedLga;
    if (spatialMode === 'bbox') return !!drawnBbox;
    return false;
  }, [spatialMode, selectedLga, drawnBbox, startTime, endTime]);

  // Preview handler
  const handlePreview = useCallback(async () => {
    const params = buildRequestParams();
    if (!params) return;
    setPreviewLoading(true);
    setPreview(null);
    try {
      const data = await getSearchPreview({
        mode: params.mode,
        lgaName: params.lga_name,
        bbox: params.bbox,
        startUtc: params.start_utc,
        endUtc: params.end_utc,
      });
      setPreview(data);
    } catch (err) {
      setPreview({ error: err.message });
    } finally {
      setPreviewLoading(false);
    }
  }, [buildRequestParams]);

  // Download handler
  const handleDownload = useCallback(async () => {
    const params = buildRequestParams();
    if (!params) return;
    setDownloading(true);
    setDownloadResult(null);
    try {
      const filename = await downloadSearchBundle(params);
      setDownloadResult({ success: true, filename });
    } catch (err) {
      setDownloadResult({ success: false, error: err.message });
    } finally {
      setDownloading(false);
    }
  }, [buildRequestParams]);

  // Compute bounding box from a GeoJSON geometry
  const computeBounds = useCallback((geometry) => {
    if (!geometry?.coordinates) return null;
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    // Recursively walk the coordinate tree to find all [lon, lat] pairs
    const walk = (node) => {
      if (!Array.isArray(node)) return;
      if (typeof node[0] === 'number' && typeof node[1] === 'number') {
        // This is a coordinate pair [lon, lat]
        if (node[0] < minLon) minLon = node[0];
        if (node[0] > maxLon) maxLon = node[0];
        if (node[1] < minLat) minLat = node[1];
        if (node[1] > maxLat) maxLat = node[1];
      } else {
        for (const child of node) walk(child);
      }
    };
    walk(geometry.coordinates);
    if (!Number.isFinite(minLon)) return null;
    return [[minLon, minLat], [maxLon, maxLat]];
  }, []);

  // Select an LGA
  const handleSelectLga = useCallback((feature) => {
    const name = getLgaFeatureName(feature);
    setSelectedLga({ name, geometry: feature.geometry });
    setLgaQuery(name || '');
    setPreview(null);
    if (onHighlightLga) onHighlightLga(name);
    // Fly to LGA bounds
    if (onFlyTo && feature.geometry) {
      const bounds = computeBounds(feature.geometry);
      if (bounds) {
        onFlyTo({ bounds, padding: 60 });
      }
    }
  }, [onFlyTo, onHighlightLga, computeBounds]);

  // Select a target LGA
  const handleSelectTarget = useCallback((target) => {
    // Try to match target with local LGA data for full geometry
    const name = target.lga_name;
    let matchedFeature = null;
    if (lgaData?.features?.length && name) {
      const lower = name.toLowerCase();
      matchedFeature = lgaData.features.find(f => (getLgaFeatureName(f) || '').toLowerCase() === lower);
    }
    if (matchedFeature) {
      handleSelectLga(matchedFeature);
    } else {
      // Use ArcGIS geometry if available
      setSelectedLga({ name, geometry: target.geometry || null });
      setLgaQuery(name);
      setPreview(null);
      if (onHighlightLga) onHighlightLga(name);
      // Fly to ArcGIS geometry bounds
      if (onFlyTo && target.geometry) {
        const bounds = computeBounds(target.geometry);
        if (bounds) {
          onFlyTo({ bounds, padding: 60 });
        }
      }
    }
  }, [lgaData, handleSelectLga, onHighlightLga, onFlyTo, computeBounds]);

  // Start bbox draw
  const handleStartDraw = useCallback(() => {
    if (onDrawBbox) onDrawBbox();
  }, [onDrawBbox]);

  return (
    <div className="search-tool-panel">
      <div className="search-tool-header">
        <h3>Search &amp; Export</h3>
        <button className="search-tool-close" onClick={onClose} title="Close">&times;</button>
      </div>

      {/* Target LGA Notifications */}
      <div className="search-tool-section">
        <div className="search-tool-section-title">
          Target LGA Notifications
          {targetAreasLoading && <span className="search-tool-loading-dot" />}
        </div>
        {targetAreasError && (
          <div className="search-tool-error">Failed to load targets: {targetAreasError}</div>
        )}
        {targetAreas && targetAreas.targets?.length > 0 ? (
          <div className="search-tool-targets">
            {targetAreas.targets.map((t, i) => (
              <button
                key={i}
                className={`search-tool-target-btn ${selectedLga?.name?.toLowerCase() === (t.lga_name || '').toLowerCase() ? 'active' : ''}`}
                onClick={() => { setSpatialMode('lga'); handleSelectTarget(t); }}
                title={`${t.lga_name}${t.edit_date ? ` — released ${new Date(t.edit_date).toLocaleString()}` : ''}`}
              >
                <span className="target-indicator" />
                {t.lga_name || `Target ${i + 1}`}
              </button>
            ))}
          </div>
        ) : (
          !targetAreasLoading && (
            <div className="search-tool-muted">No target LGAs released yet</div>
          )
        )}
      </div>

      {/* Spatial Filter */}
      <div className="search-tool-section">
        <div className="search-tool-section-title">Spatial Filter</div>
        <div className="search-tool-mode-toggle">
          <button
            className={`mode-btn ${spatialMode === 'lga' ? 'active' : ''}`}
            onClick={() => setSpatialMode('lga')}
          >
            LGA
          </button>
          <button
            className={`mode-btn ${spatialMode === 'bbox' ? 'active' : ''}`}
            onClick={() => setSpatialMode('bbox')}
          >
            Bounding Box
          </button>
        </div>

        {spatialMode === 'lga' && (
          <div className="search-tool-lga-picker">
            <input
              type="text"
              className="search-tool-input"
              placeholder="Search LGA by name..."
              value={lgaQuery}
              onChange={(e) => {
                setLgaQuery(e.target.value);
                if (selectedLga && e.target.value !== selectedLga.name) {
                  setSelectedLga(null);
                  setPreview(null);
                }
              }}
            />
            {lgaQuery && !selectedLga && lgaSearchResults.length > 0 && (
              <div className="search-tool-dropdown">
                {lgaSearchResults.map((f, i) => {
                  const name = getLgaFeatureName(f);
                  const isTarget = isTargetLga(name);
                  return (
                    <button
                      key={i}
                      className={`search-tool-dropdown-item ${isTarget ? 'target' : ''}`}
                      onClick={() => handleSelectLga(f)}
                    >
                      {isTarget && <span className="target-indicator" />}
                      {name}
                    </button>
                  );
                })}
              </div>
            )}
            {selectedLga && (
              <div className="search-tool-selected">
                {isTargetLga(selectedLga.name) && <span className="target-indicator" />}
                <span>{selectedLga.name}</span>
                <button className="search-tool-clear-btn" onClick={() => { setSelectedLga(null); setLgaQuery(''); setPreview(null); if (onHighlightLga) onHighlightLga(null); }}>&times;</button>
              </div>
            )}
          </div>
        )}

        {spatialMode === 'bbox' && (
          <div className="search-tool-bbox">
            <button className="search-tool-draw-btn" onClick={handleStartDraw}>
              {drawnBbox ? 'Redraw on Map' : 'Draw on Map'}
            </button>
            {drawnBbox && (
              <div className="search-tool-bbox-info">
                <span className="bbox-label">
                  {drawnBbox[0].toFixed(2)}, {drawnBbox[1].toFixed(2)} &rarr; {drawnBbox[2].toFixed(2)}, {drawnBbox[3].toFixed(2)}
                </span>
                <button className="search-tool-clear-btn" onClick={() => { if (onClearBbox) onClearBbox(); setPreview(null); }}>&times;</button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Time Filter */}
      <div className="search-tool-section">
        <div className="search-tool-section-title">Time Filter</div>
        <div className="search-tool-time-row">
          <label>
            <span className="search-tool-time-label">Start</span>
            <input
              type="datetime-local"
              className="search-tool-input"
              value={startTime}
              onChange={(e) => { setStartTime(e.target.value); setPreview(null); }}
            />
          </label>
        </div>
        <div className="search-tool-time-row">
          <label>
            <span className="search-tool-time-label">End</span>
            <input
              type="datetime-local"
              className="search-tool-input"
              value={endTime}
              onChange={(e) => { setEndTime(e.target.value); setPreview(null); }}
            />
          </label>
        </div>
        <div className="search-tool-time-hint">
          Default start: 9:00 AM AEST today. Times are in your local timezone.
        </div>
      </div>

      {/* Actions */}
      <div className="search-tool-section search-tool-actions">
        <button
          className="search-tool-btn search-tool-preview-btn"
          onClick={handlePreview}
          disabled={!canSearch || previewLoading}
        >
          {previewLoading ? 'Searching...' : 'Preview'}
        </button>
        <button
          className="search-tool-btn search-tool-download-btn"
          onClick={handleDownload}
          disabled={!canSearch || downloading}
        >
          {downloading ? 'Generating...' : 'Download Bundle (.zip)'}
        </button>
      </div>

      {/* Preview Results */}
      {preview && !preview.error && (
        <div className="search-tool-section search-tool-preview">
          <div className="search-tool-section-title">Results Preview</div>
          <table className="search-tool-preview-table">
            <tbody>
              <tr><td>Hotspots</td><td className="num">{preview.hotspot_count}</td></tr>
              <tr><td>Superclusters</td><td className="num">{preview.supercluster_count}</td></tr>
              <tr><td>Ignitions</td><td className="num">{preview.ignition_count}</td></tr>
              {preview.total_frp_mw != null && (
                <tr><td>Total FRP</td><td className="num">{preview.total_frp_mw} MW</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {preview?.error && (
        <div className="search-tool-error">{preview.error}</div>
      )}

      {/* Download result */}
      {downloadResult && (
        <div className={`search-tool-download-result ${downloadResult.success ? 'success' : 'error'}`}>
          {downloadResult.success
            ? `Downloaded: ${downloadResult.filename}`
            : `Error: ${downloadResult.error}`
          }
        </div>
      )}
    </div>
  );
}
