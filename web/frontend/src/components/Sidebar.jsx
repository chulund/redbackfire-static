import { useEffect, useMemo, useRef, useState } from 'react';
import { getFireEventDetail, getRealtimeHotspots, getSavedSimulationRun } from '../api';
import { useLinkedSimulations } from '../hooks/useData';
import { getDisplayHotspotId, getSourceHotspotId } from '../utils/hotspots';
import { downloadGeoJSON, downloadRealtimeHotspots, downloadSimulationResult } from '../utils/download';

/* ================================================================
   Helpers
   ================================================================ */

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-AU', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    });
  } catch { return iso; }
}

function fmtAest(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-AU', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZone: 'Australia/Sydney', timeZoneName: 'short',
    });
  } catch { return iso; }
}

/** Format a datetime in both UTC and AEST */
function fmtDualTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    const utc = d.toLocaleString('en-AU', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
      timeZone: 'UTC',
    }) + ' UTC';
    const aest = d.toLocaleString('en-AU', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
      timeZone: 'Australia/Sydney',
    }) + ' AEST';
    return `${utc}\n${aest}`;
  } catch { return iso; }
}

function fmtDuration(hours) {
  if (hours == null || hours === '') return '—';
  const h = Number(hours);
  if (!Number.isFinite(h) || h < 0) return '—';
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 24) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} days`;
}

function getProductDisplayName(productId) {
  if (productId === 'bright_s3') return 'BRIGHT AHI v2.0';
  if (productId === 'bright_ahi') return 'BRIGHT AHI v1.86';
  return productId || '—';
}

function getHotspotId(props = {}, hotspot = null) {
  return getDisplayHotspotId(props, hotspot) || '—';
}

function getEventDurationHours(props = {}) {
  const direct = getHotspotProp(props, ['duration_hours', 'duration_h', 'duration_hr', 'duration']);
  if (direct != null) {
    const value = Number(direct);
    if (Number.isFinite(value) && value >= 0) return value;
  }

  const start = getHotspotProp(props, ['first_hotspot_time', 'start_dt', 'datetime']);
  const end = getHotspotProp(props, ['last_hotspot_time', 'end_dt', 'datetime']);
  if (!start || !end) return null;
  const hours = (new Date(end).getTime() - new Date(start).getTime()) / 3600000;
  return Number.isFinite(hours) && hours >= 0 ? hours : null;
}

function getEventMaxFrp(props = {}) {
  return getValidFrp(getHotspotProp(props, ['frp_max_mw', 'max_frp_mw', 'peak_frp_mw']));
}

function getEventMeanFrp(props = {}) {
  return getValidFrp(getHotspotProp(props, ['frp_mean_mw', 'mean_frp_mw', 'avg_frp_mw']));
}

function getValidFrp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return numeric;
}

function getHotspotProp(props = {}, keys = []) {
  for (const key of keys) {
    const value = props[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function formatNumber(value, digits = 1) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(digits) : '—';
}

function getEventFirstTime(props = {}) {
  return getHotspotProp(props, ['first_hotspot_time', 'start_dt', 'first_detection', 'datetime']);
}

function getEventLastTime(props = {}) {
  return getHotspotProp(props, ['last_hotspot_time', 'end_dt', 'last_detection', 'datetime']);
}

function getEventAreaKm2(props = {}) {
  const km2 = Number(getHotspotProp(props, ['area_km2', 'affected_area_km2']));
  if (Number.isFinite(km2) && km2 >= 0) return km2;
  const hectares = Number(getHotspotProp(props, ['area_ha', 'affected_area_ha']));
  if (Number.isFinite(hectares) && hectares >= 0) return hectares / 100;
  return null;
}

function getEventHotspotCount(props = {}, fallback = 0) {
  const numeric = Number(getHotspotProp(props, ['hotspot_count', 'n_detections', 'n_pixels', 'n_unique_locations']));
  if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  return fallback;
}

function getEventTotalFrp(props = {}) {
  return getValidFrp(getHotspotProp(props, ['frp_total_mw', 'total_frp_mw']));
}

function getEventConfidence(props = {}, detailConfidence = null) {
  if (detailConfidence?.level && detailConfidence?.label) {
    return {
      label: detailConfidence.label,
      cls: detailConfidence.level,
      reasoning: detailConfidence.reasoning || '',
    };
  }

  const raw = String(getHotspotProp(props, ['fire_confidence', 'fire_confidence_raw', 'confidence']) || '').trim().toLowerCase();
  if (raw === 'very_likely' || raw === 'high') {
    return { label: 'High confidence', cls: 'high', reasoning: `Published fire confidence: ${raw.replace('_', ' ')}.` };
  }
  if (raw === 'likely' || raw === 'nominal' || raw === 'medium') {
    return { label: 'Moderate confidence', cls: 'medium', reasoning: `Published fire confidence: ${raw.replace('_', ' ')}.` };
  }
  if (raw === 'less_likely' || raw === 'low') {
    return { label: 'Lower confidence', cls: 'low', reasoning: `Published fire confidence: ${raw.replace('_', ' ')}.` };
  }

  return getConfidence(getEventHotspotCount(props, 0));
}

function getXprizeDayLabel(reportDate) {
  if (!reportDate) return '';
  const finalsStartUtc = Date.UTC(2026, 3, 8);
  const parts = String(reportDate).split('-').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return '';
  const reportUtc = Date.UTC(parts[0], parts[1] - 1, parts[2]);
  const diffDays = Math.round((reportUtc - finalsStartUtc) / 86400000);
  if (diffDays < 0) return `XPRIZE Day ${diffDays}`;
  if (diffDays === 0) return 'XPRIZE Day 1';
  return `XPRIZE Day +${diffDays + 1}`;
}

function formatHistoricalReportDateLabel(reportDate) {
  if (!reportDate) return '—';
  try {
    const baseLabel = new Date(`${reportDate}T00:00:00`).toLocaleDateString('en-AU', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    const xprizeLabel = getXprizeDayLabel(reportDate);
    return xprizeLabel ? `${baseLabel} (${xprizeLabel})` : baseLabel;
  } catch {
    return reportDate;
  }
}

function fmtHotspotHoursSince(iso) {
  if (!iso) return '—';
  const millis = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(millis)) return '—';
  return `${(millis / 3600000).toFixed(1)} h`;
}

function getFeatureCenter(feature) {
  const geometry = feature?.geometry;
  if (!geometry) return null;
  if (geometry.type === 'Point') {
    const [lng, lat] = geometry.coordinates || [];
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  }
  const ring = geometry.type === 'Polygon'
    ? geometry.coordinates?.[0]
    : geometry.type === 'MultiPolygon'
      ? geometry.coordinates?.[0]?.[0]
      : null;
  if (!Array.isArray(ring) || ring.length === 0) return null;
  const lng = ring.reduce((sum, coord) => sum + coord[0], 0) / ring.length;
  const lat = ring.reduce((sum, coord) => sum + coord[1], 0) / ring.length;
  return { lat, lng };
}

function summariseRealtimeHotspots(hotspots) {
  if (!hotspots?.features?.length) return [];
  return hotspots.features.map((feature, index) => {
    const props = feature.properties || {};
    const center = getFeatureCenter(feature);
    const lat = center?.lat ?? Number(props.lat ?? props.latitude);
    const lng = center?.lng ?? Number(props.lon ?? props.longitude);
    return {
      id: getSourceHotspotId(props, feature),
      displayId: getDisplayHotspotId(props, feature),
      idx: props._feature_index ?? index,
      lat,
      lng,
      coordKey: Number.isFinite(lat) && Number.isFinite(lng) ? `${lat.toFixed(5)},${lng.toFixed(5)}` : null,
      datetime: getHotspotProp(props, ['datetime', 'dt', 'hotspot_datetime']),
      frp: getValidFrp(getHotspotProp(props, ['frp_mw', 'power', 'frp'])),
      product_id: getHotspotProp(props, ['product_id']),
      stableId: getHotspotProp(props, ['stable_id', 'cluster_id', 'event_id', 'fire_id', 'source_supercluster_id']),
      properties: props,
    };
  }).filter(item => Number.isFinite(item.lat) && Number.isFinite(item.lng));
}

function formatSavedSimulationLocation(run) {
  if (run?.location_name) return run.location_name;
  if (Number.isFinite(run?.lat) && Number.isFinite(run?.lng)) {
    return `${Number(run.lat).toFixed(4)}°, ${Number(run.lng).toFixed(4)}°`;
  }
  return 'Unknown location';
}

function hectaresToKm2(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return numeric / 100;
}

function formatSavedSimulationSummary(run) {
  const variables = run?.results?.variables || {};
  const areaKm2 = hectaresToKm2(run?.summary?.area_sim ?? variables.area_sim);
  const highIntensityKm2 = hectaresToKm2(run?.summary?.area_high_intensity ?? variables.area_high_intensity);
  const highFraction = areaKm2 && highIntensityKm2 != null && areaKm2 > 0
    ? (highIntensityKm2 / areaKm2) * 100
    : null;
  return {
    areaKm2,
    highIntensityKm2,
    highFraction,
  };
}

function isTimestampWithinWindow(value, start, end) {
  if (!value || !start || !end) return false;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return false;
  return timestamp >= start.getTime() && timestamp <= end.getTime();
}

function summariseRealtimeClusters(events) {
  if (!events?.features?.length) return [];
  return events.features.map((feature) => {
    const props = feature.properties || {};
    return {
      id: props.stable_id ?? props.cluster_id ?? props.event_id ?? props.fire_id,
      hotspotCount: props.n_detections ?? props.hotspot_count ?? props.n_unique_locations ?? 0,
      firstTime: props.first_hotspot_time || props.start_dt || props.datetime,
      feature,
    };
  });
}

function summariseRealtimeIgnitions(ignitions) {
  if (!ignitions?.features?.length) return [];
  return ignitions.features.map((feature, index) => {
    const props = feature.properties || {};
    const center = getFeatureCenter(feature);
    return {
      id: props.ignition_id || props.stable_id || index,
      stableId: props.stable_id ?? props.cluster_id ?? props.event_id ?? props.fire_id ?? null,
      datetime: props.datetime || props.ignition_datetime || null,
      lat: center?.lat,
      lng: center?.lng,
      feature,
    };
  }).filter(item => Number.isFinite(item.lat) && Number.isFinite(item.lng));
}

function getLgaNameFromFeature(feature) {
  const props = feature?.properties || {};
  return props.abb_name || props.LGA_NAME || props.lga_name || props.name || props.NAME || null;
}

function pointInRing(lat, lng, ring = []) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]?.[0];
    const yi = ring[i]?.[1];
    const xj = ring[j]?.[0];
    const yj = ring[j]?.[1];
    const intersects = ((yi > lat) !== (yj > lat))
      && (lng < ((xj - xi) * (lat - yi)) / ((yj - yi) || Number.EPSILON) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInPolygonGeometry(lat, lng, geometry) {
  if (!geometry) return false;
  if (geometry.type === 'Polygon') {
    return pointInRing(lat, lng, geometry.coordinates?.[0] || []);
  }
  if (geometry.type === 'MultiPolygon') {
    return (geometry.coordinates || []).some(polygon => pointInRing(lat, lng, polygon?.[0] || []));
  }
  return false;
}

function findLgaNameForPoint(lat, lng, lgaData) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !lgaData?.features?.length) return null;
  const match = lgaData.features.find(feature => pointInPolygonGeometry(lat, lng, feature.geometry));
  return getLgaNameFromFeature(match);
}

function formatSimulationModeLabel(mode) {
  return mode === 'custom' ? 'Custom' : 'Automated';
}

function DetailFieldGroup({ title, rows }) {
  if (!rows?.length) return null;

  return (
    <div className="detail-field-group">
      <div className="detail-field-group-title">{title}</div>
      <div className="detail-field-group-body">
        {rows.map(([label, value]) => (
          <div key={label} className="detail-row">
            <span className="detail-label">{label}</span>
            <span className="detail-value">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function buildSavedSimulationTitle(run, lgaName) {
  const time = run?.startDateTime ? fmtAest(run.startDateTime) : 'Unknown time';
  return `${lgaName || 'Unknown LGA'} · ${time}`;
}

function getConfidence(count) {
  if (count >= 10) return { label: 'Very likely (90%)', cls: 'high' };
  if (count >= 4) return { label: 'Likely (70%)', cls: 'medium' };
  return { label: 'Possible (40%)', cls: 'low' };
}

const LAND_COVER_COLORS = {
  'Natural Terrestrial Vegetation': '#2f7d32',
  'Cultivated Terrestrial Vegetation': '#7cb342',
  'Natural Aquatic Vegetation': '#26a69a',
  'Cultivated Aquatic Vegetation': '#66bb6a',
  'Artificial Surfaces': '#5d3a1a',
  'Natural Bare Surfaces': '#c9a16b',
  'Water': '#1e88e5',
  'Forest': '#2f7d32',
  'Shrubland': '#8b5a2b',
  'Grassland': '#a3b557',
  'Cropland': '#7cb342',
  'Built-up': '#5d3a1a',
  'Bare / sparse vegetation': '#c9a16b',
  'Artificial Surface': '#5d3a1a',
  'Natural Surface': '#c9a16b',
};

/* ================================================================
   DonutChart — land cover distribution
   ================================================================ */

function DonutChart({ data }) {
  if (!data || Object.keys(data).length === 0) {
    return <div className="text-muted text-sm" style={{ padding: '8px 16px' }}>No land cover data</div>;
  }

  const entries = Object.entries(data).sort((a, b) => b[1].pct - a[1].pct);
  const total = entries.reduce((s, [, v]) => s + v.count, 0);

  let cumAngle = 0;
  const r = 50, cx = 60, cy = 60;

  const arcs = entries.map(([label, { count }]) => {
    const frac = count / total;
    const startAngle = cumAngle;
    cumAngle += frac * 360;
    const endAngle = cumAngle;
    const startRad = (startAngle - 90) * Math.PI / 180;
    const endRad = (endAngle - 90) * Math.PI / 180;
    const large = frac > 0.5 ? 1 : 0;
    const x1 = cx + r * Math.cos(startRad), y1 = cy + r * Math.sin(startRad);
    const x2 = cx + r * Math.cos(endRad), y2 = cy + r * Math.sin(endRad);
    const color = LAND_COVER_COLORS[label] || '#6b7280';

    return (
      <path key={label}
        d={`M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`}
        fill={color} stroke="var(--bg-secondary)" strokeWidth="2" />
    );
  });

  return (
    <div className="land-cover-section">
      <h3><span style={{ fontSize: 16 }}>🌿</span> Land Cover Distribution</h3>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
        <svg width="120" height="120" viewBox="0 0 120 120">
          {arcs}
          <circle cx={cx} cy={cy} r={28} fill="var(--bg-secondary)" />
        </svg>
        <div className="land-cover-legend">
          {entries.map(([label, { pct }]) => (
            <div key={label} className="land-cover-item">
              <span className="land-cover-dot"
                style={{ background: LAND_COVER_COLORS[label] || '#6b7280' }} />
              <span style={{ flex: 1 }}>{label}</span>
              <span className="text-muted" style={{ marginLeft: 4 }}>{pct}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ================================================================
   Tab Content Components
   ================================================================ */

function TimelineTab({ timeline }) {
  if (!timeline || timeline.length === 0) {
    return <div className="tab-content-empty">No timeline data available</div>;
  }

  const times = timeline.map(h => new Date(h.datetime).getTime()).filter(t => !isNaN(t));
  const minT = Math.min(...times);
  const maxT = Math.max(...times);
  const range = maxT - minT || 1;

  return (
    <div className="tab-content">
      <div className="timeline-chart">
        <div className="timeline-track">
          {timeline.map((h, i) => {
            const t = new Date(h.datetime).getTime();
            const pct = ((t - minT) / range) * 100;
            const intensity = h.frp ? Math.min(h.frp / 50, 1) : 0.3;
            return (
              <div key={i} className="timeline-dot-wrapper" style={{ left: `${pct}%` }}
                title={`${fmtDate(h.datetime)}\nFRP: ${h.frp?.toFixed(1) ?? '?'} MW`}>
                <div className="timeline-dot" style={{
                  background: `rgba(255, ${Math.round(107 - intensity * 80)}, ${Math.round(53 - intensity * 53)}, ${0.6 + intensity * 0.4})`,
                  width: 8 + intensity * 6, height: 8 + intensity * 6,
                }} />
              </div>
            );
          })}
        </div>
        <div className="timeline-labels">
          <span>{fmtDate(timeline[0]?.datetime)}</span>
          <span>{fmtDate(timeline[timeline.length - 1]?.datetime)}</span>
        </div>
      </div>
      <div className="timeline-summary">
        {timeline.length} hotspots over {fmtDuration((maxT - minT) / 3600000)}
      </div>
    </div>
  );
}

function FRPTab({ timeline }) {
  if (!timeline || timeline.length === 0) {
    return <div className="tab-content-empty">No FRP data available</div>;
  }

  const validFrps = timeline.map(h => getValidFrp(h.frp)).filter(v => v != null);
  const maxFRP = Math.max(...validFrps, 1);
  const totalFRP = validFrps.reduce((sum, value) => sum + value, 0);
  const meanFRP = validFrps.length > 0 ? totalFRP / validFrps.length : 0;

  return (
    <div className="tab-content">
      <div className="frp-stats-row">
        <div className="frp-stat-box">
          <div className="frp-stat-value text-fire">{maxFRP.toFixed(1)}</div>
          <div className="frp-stat-label">Max MW</div>
        </div>
        <div className="frp-stat-box">
          <div className="frp-stat-value text-yellow">{meanFRP.toFixed(1)}</div>
          <div className="frp-stat-label">Mean MW</div>
        </div>
        <div className="frp-stat-box">
          <div className="frp-stat-value text-blue">{totalFRP.toFixed(0)}</div>
          <div className="frp-stat-label">Total MW</div>
        </div>
      </div>
      <div className="frp-chart">
        {timeline.map((h, i) => {
          const frp = getValidFrp(h.frp) || 0;
          const pct = (frp / maxFRP) * 100;
          const intensity = frp / maxFRP;
          const r = 255, g = Math.round(200 - intensity * 150), b = Math.round(50 - intensity * 50);
          return (
            <div key={i} className="frp-bar-row"
              title={`${fmtDate(h.datetime)}: ${frp > 0 ? `${frp.toFixed(1)} MW` : 'Unknown FRP'}`}>
              <span className="frp-bar-label">{frp > 0 ? frp.toFixed(0) : '—'}</span>
              <div className="frp-bar-track">
                <div className="frp-bar-fill" style={{
                  width: `${pct}%`,
                  background: `rgb(${r},${g},${b})`,
                }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HotspotsTab({ timeline }) {
  if (!timeline || timeline.length === 0) {
    return <div className="tab-content-empty">No hotspot data available</div>;
  }

  return (
    <div className="tab-content">
      <div className="hotspots-table">
        <div className="hotspots-table-header">
          <span>Time</span>
          <span>FRP (MW)</span>
          <span>Confidence</span>
        </div>
        {timeline.map((h, i) => (
          <div key={i} className="hotspots-table-row">
            <span>{fmtDate(h.datetime)}</span>
            <span>{getValidFrp(h.frp) != null ? getValidFrp(h.frp).toFixed(1) : 'Unknown'}</span>
            <span className={`confidence-tag ${h.confidence === 'h' ? 'high' : h.confidence === 'n' ? 'medium' : 'low'}`}>
              {h.confidence === 'h' ? 'High' : h.confidence === 'n' ? 'Nominal' : h.confidence === 'l' ? 'Low' : h.confidence || '—'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AreaTab({ props }) {
  const area = props.area_km2 ? Number(props.area_km2) : null;
  const pixels = props.n_pixels ? Number(props.n_pixels) : null;

  return (
    <div className="tab-content">
      <div className="area-display">
        <div className="area-big-number">
          {area != null ? area.toFixed(1) : '—'}
          <span className="area-unit">km²</span>
        </div>
        <div className="area-sub">Total Affected Area</div>
      </div>
      <div className="area-details">
        {pixels != null && (
          <div className="area-detail-row">
            <span>Satellite Pixels</span>
            <span>{pixels}</span>
          </div>
        )}
        {props.centroid_lat && props.centroid_lon && (
          <div className="area-detail-row">
            <span>Fire Centroid</span>
            <span className="font-mono">{Number(props.centroid_lat).toFixed(4)}°, {Number(props.centroid_lon).toFixed(4)}°</span>
          </div>
        )}
        {area != null && (
          <div className="area-detail-row">
            <span>Per Pixel Avg</span>
            <span>{pixels ? (area / pixels).toFixed(2) : '—'} km²</span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ================================================================
   EventDetail — full fire event panel
   ================================================================ */

function EventDetail({ eventId, events, hotspots, eventColors, reportDate,
  selectedHistoricalSimulationId, selectedHistoricalSimulation, selectedHistoricalSimulationError,
  onSelectHistoricalSimulation, onClearHistoricalSimulation,
}) {
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(null);
  const [activeTab, setActiveTab] = useState('timeline');

  useEffect(() => {
    if (eventId == null) return;
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    const t0 = performance.now();
    getFireEventDetail(eventId, null, reportDate)
      .then((payload) => {
        if (!cancelled) {
          console.log(`[fire-detail] ${eventId} loaded in ${(performance.now() - t0).toFixed(0)} ms`);
          setDetail(payload);
        }
      })
      .catch((err) => {
        console.error('Detail fetch failed:', err);
        if (!cancelled) setDetailError(err);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => { cancelled = true; };
  }, [eventId, reportDate]);

  if (eventId == null) return null;

  const eventFeat = events?.features?.find(f => {
    const p = f.properties;
    return (p.stable_id ?? p.cluster_id ?? p.event_id ?? p.fire_id) == eventId;
  });

  const props = { ...(eventFeat?.properties || {}), ...(detail?.stats || {}) };
  const hotspotCount = getEventHotspotCount(props, detail?.hotspot_count || 0);
  const confidence = getEventConfidence(props, detail?.fire_confidence);
  const timeline = detail?.hotspot_timeline || [];
  const firstHotspotTime = getEventFirstTime(props);
  const lastHotspotTime = getEventLastTime(props);
  const durationHours = getEventDurationHours(props);
  const areaKm2 = getEventAreaKm2(props);
  const maxFrp = getEventMaxFrp(props);
  const meanFrp = getEventMeanFrp(props);
  const totalFrp = getEventTotalFrp(props);
  const fireBehaviour = detail?.fire_behaviour || null;
  const eventHeading = props.supercluster_label || `Fire Event #${eventId}`;
  if ((props.area_km2 == null || props.area_km2 === '') && areaKm2 != null) {
    props.area_km2 = areaKm2;
  }
  if ((props.n_pixels == null || props.n_pixels === '') && hotspotCount > 0) {
    props.n_pixels = hotspotCount;
  }
  const behaviourRows = fireBehaviour?.status === 'available'
    ? [
      ['Summary', fireBehaviour.summary || '—'],
      ['Spread Horizon', fireBehaviour.spread_horizon_hours != null ? fmtDuration(fireBehaviour.spread_horizon_hours) : '—'],
      ['Isochrone Steps', fireBehaviour.isochrone_steps ?? '—'],
      ['Simulated Span', fireBehaviour.simulated_span_km != null ? `${formatNumber(fireBehaviour.simulated_span_km, 1)} km` : '—'],
      ['Impacted Roads', fireBehaviour.impacted_roads ?? 0],
      ['First Road Impact', fireBehaviour.first_road_impact_time ? fmtAest(fireBehaviour.first_road_impact_time) : 'None detected'],
    ]
    : [['Simulation Insight', fireBehaviour?.summary || 'No bundled simulation summary available for this fire.']];

  return (
    <>
      <div className="sidebar-header">
        <h2>
          <span className="fire-icon">🔥</span>
          {eventHeading}
          <span className="text-muted text-sm" style={{ fontWeight: 400, marginLeft: 4 }}>
            {hotspotCount} hotspots
          </span>
        </h2>
      </div>

      <div className="event-detail">
        {detailLoading && !detail && <div className="event-inline-note">Loading fire details…</div>}
        {detailError && (
          <div className="event-inline-note error">
            {detailError.message || 'Could not load additional fire detail'}
          </div>
        )}

        {/* Timing section */}
        <div className="detail-section-title">⏱ Timing</div>
        <div className="detail-row">
          <span className="detail-label">First Hotspot</span>
          <span className="detail-value dual-time">{fmtDualTime(firstHotspotTime)}</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Last Hotspot</span>
          <span className="detail-value dual-time">{fmtDualTime(lastHotspotTime)}</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Lifetime</span>
          <span className="detail-value">{fmtDuration(durationHours)}</span>
        </div>

        {/* Location section */}
        <div className="detail-section-title">📍 Location</div>
        {props.ignition_lat && props.ignition_lon && (
          <div className="detail-row">
            <span className="detail-label">Ignition Point</span>
            <span className="detail-value font-mono">
              {Number(props.ignition_lat).toFixed(4)}°, {Number(props.ignition_lon).toFixed(4)}°
            </span>
          </div>
        )}
        {props.centroid_lat && props.centroid_lon && (
          <div className="detail-row">
            <span className="detail-label">Centroid</span>
            <span className="detail-value font-mono">
              {Number(props.centroid_lat).toFixed(4)}°, {Number(props.centroid_lon).toFixed(4)}°
            </span>
          </div>
        )}

        {props.LGA && (
          <div className="detail-row">
            <span className="detail-label">LGA</span>
            <span className="detail-value">{props.LGA}</span>
          </div>
        )}

        {/* Fire intensity section */}
        <div className="detail-section-title">🔥 Fire Intensity</div>
        {maxFrp != null && (
          <div className="detail-row">
            <span className="detail-label">Max Intensity (FRP)</span>
            <span className="detail-value text-fire">{formatNumber(maxFrp, 1)} MW</span>
          </div>
        )}
        {meanFrp != null && (
          <div className="detail-row">
            <span className="detail-label">Mean Intensity</span>
            <span className="detail-value">{formatNumber(meanFrp, 1)} MW</span>
          </div>
        )}
        {totalFrp != null && (
          <div className="detail-row">
            <span className="detail-label">Total FRP</span>
            <span className="detail-value">{formatNumber(totalFrp, 1)} MW</span>
          </div>
        )}

        {/* Area & detection */}
        <div className="detail-section-title">📐 Area & Detection</div>
        {areaKm2 != null && (
          <div className="detail-row">
            <span className="detail-label">Affected Area</span>
            <span className="detail-value">{Number(props.area_km2).toFixed(1)} km²</span>
          </div>
        )}
        {areaKm2 != null && (
          <div className="detail-row">
            <span className="detail-label">Affected Area (ha)</span>
            <span className="detail-value">{formatNumber(areaKm2 * 100, 1)} ha</span>
          </div>
        )}
        {props.n_pixels != null && props.n_pixels !== '' && (
          <div className="detail-row">
            <span className="detail-label">Pixel Count</span>
            <span className="detail-value">{props.n_pixels}</span>
          </div>
        )}
        <div className="detail-row">
          <span className="detail-label">Fire Confidence</span>
          <span className="detail-value">
            <span className={`confidence-badge ${confidence.cls}`}>{confidence.label}</span>
          </span>
        </div>
        {confidence.reasoning && <div className="event-inline-note subtle">{confidence.reasoning}</div>}

        {/* Sensor info */}
        <div className="detail-section-title">🛰 Sensor</div>
        <div className="detail-row">
          <span className="detail-label">Satellite</span>
          <span className="detail-value">Himawari-9</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Sensor</span>
          <span className="detail-value">AHI</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Algorithm</span>
          <span className="detail-value">BRIGHT</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Temporal Resolution</span>
          <span className="detail-value">10 min</span>
        </div>

        {/* Fire behaviour */}
        <div className="detail-section-title">📋 Fire Behaviour</div>
        <div className="detail-row">
          <span className="detail-label">Simulation Insight</span>
          <span className="detail-value detail-value-wrap">{fireBehaviour?.summary || 'No bundled simulation summary available for this fire.'}</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Spread Horizon</span>
          <span className="detail-value">{fireBehaviour?.spread_horizon_hours != null ? fmtDuration(fireBehaviour.spread_horizon_hours) : '—'}</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Impacted Roads</span>
          <span className="detail-value">{fireBehaviour?.impacted_roads ?? 0}</span>
        </div>
      </div>

      {/* Tab buttons */}
      <div className="tab-grid">
        {[
          { key: 'timeline', icon: '\u{1F4C8}', label: 'Timeline' },
          { key: 'frp', icon: '\u{1F4CA}', label: 'FRP' },
          { key: 'hotspots', icon: '\u{1F534}', label: 'Hotspots' },
          { key: 'area', icon: '\u{1F4D0}', label: 'Area' },
          { key: 'simulation', icon: '\u{1F525}', label: 'Fire Spread' },
          { key: 'land_cover', icon: '\u{1F33F}', label: 'Land Cover' },
        ].map(tab => (
          <button key={tab.key}
            className={`tab-btn ${activeTab === tab.key ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.key)}>
            {tab.icon} {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'timeline' && <TimelineTab timeline={timeline} />}
      {activeTab === 'frp' && <FRPTab timeline={timeline} />}
      {activeTab === 'hotspots' && <HotspotsTab timeline={timeline} />}
      {activeTab === 'area' && <AreaTab props={props} />}
      {activeTab === 'simulation' && (
        <HistoricalEventSimulationTab
          fireBehaviour={fireBehaviour}
          selectedSimulationId={selectedHistoricalSimulationId}
          selectedSimulation={selectedHistoricalSimulation}
          selectedSimulationError={selectedHistoricalSimulationError}
          onSelectSimulation={onSelectHistoricalSimulation}
          onClearSimulation={onClearHistoricalSimulation}
        />
      )}
      {activeTab === 'land_cover' && (
        <LandCoverTab
          landCover={detail?.land_cover}
          note={detail?.land_cover_note}
          source={detail?.land_cover_source}
        />
      )}
    </>
  );
}

function LandCoverTab({ landCover, note, source }) {
  const hasData = landCover && Object.keys(landCover).length > 0;
  const sourceLabel = source === 'hotspot_attributes'
    ? 'Source: Hotspot attributes (DEA Land Cover L4 classification)'
    : source === 'nsw_zone_approximation'
      ? 'Source: Approximate NSW vegetation zones (DEA Land Cover L4 schema)'
      : source === 'dea_l4_raster'
        ? 'Source: DEA Land Cover L4 (geoscience Australia)'
        : 'Classification schema: DEA Land Cover L4';
  return (
    <div className="tab-content">
      {hasData ? (
        <>
          <DonutChart data={landCover} />
          <div className="text-sm text-muted" style={{ marginTop: 8, textAlign: 'center', lineHeight: 1.4 }}>
            {sourceLabel}
            <div style={{ marginTop: 2, fontSize: 11, opacity: 0.85 }}>
              Digital Earth Australia ·{' '}
              <a
                href="https://www.ga.gov.au/scientific-topics/dea/dea-data-and-products/dea-land-cover-landsat"
                target="_blank"
                rel="noreferrer"
                style={{ color: 'inherit', textDecoration: 'underline' }}
              >
                ga.gov.au
              </a>
            </div>
          </div>
        </>
      ) : (
        <div className="tab-content-empty">
          {note || 'No land cover breakdown is available for this fire yet.'}
        </div>
      )}
    </div>
  );
}

/* ================================================================
   EventList — list view of all fires
   ================================================================ */

const FIRE_COMPLEX_PAGE_SIZE = 10;

function EventList({ events, selectedEventId, onSelectEvent, eventColors }) {
  const total = events?.features?.length || 0;
  const [visibleCount, setVisibleCount] = useState(FIRE_COMPLEX_PAGE_SIZE);

  useEffect(() => {
    setVisibleCount(FIRE_COMPLEX_PAGE_SIZE);
  }, [events]);

  if (!total) {
    return (
      <div className="rt-summary-list rt-summary-list-scroll-shell">
        <div className="detail-section-title">
          {'\u{1F525}'} Fire Complexes (0)
        </div>
        <div className="no-data" style={{ padding: '12px 8px' }}>
          <p className="text-sm text-muted">No reported fire events in this published bundle.</p>
        </div>
      </div>
    );
  }

  const visible = events.features.slice(0, visibleCount);
  const remaining = total - visible.length;

  return (
    <div className="rt-summary-list rt-summary-list-scroll-shell">
      <div className="detail-section-title">
        {'\u{1F525}'} Fire Complexes ({total})
      </div>
      <div className="rt-summary-list-body rt-summary-list-body-scroll">
        {visible.map((feat, idx) => {
          const p = feat.properties;
          const id = p.stable_id ?? p.cluster_id ?? p.event_id ?? p.fire_id ?? idx;
          const color = eventColors[idx % eventColors.length];
          const area = p.area_km2 ? `${Number(p.area_km2).toFixed(1)} km\u00B2` : '';
          const pixels = getEventHotspotCount(p, 0) ? `${getEventHotspotCount(p, 0)} hotspots` : '';
          const duration = getEventDurationHours(p) ? fmtDuration(getEventDurationHours(p)) : '';

          return (
            <div key={id}
              className={`event-list-item ${selectedEventId == id ? 'active' : ''}`}
              onClick={() => onSelectEvent(id)}>
              <span className="event-color" style={{ background: color }} />
              <div className="event-info">
                <div className="event-name">{p.supercluster_label || `Fire #${id}`}</div>
                <div className="event-meta">
                  {[area, pixels, duration].filter(Boolean).join(' \u00B7 ')}
                </div>
              </div>
              <div className="event-stats">
                {getEventMaxFrp(p) != null && <div className="text-fire">{formatNumber(getEventMaxFrp(p), 0)} MW</div>}
                <div className="text-muted">{fmtDate(getEventFirstTime(p)).split(',')[0]}</div>
              </div>
            </div>
          );
        })}
      </div>
      {remaining > 0 && (
        <button
          type="button"
          className="rt-summary-list-load-more"
          onClick={() => setVisibleCount((n) => n + FIRE_COMPLEX_PAGE_SIZE)}
        >
          Load more ({remaining} remaining)
        </button>
      )}
    </div>
  );
}

/* ================================================================
   HistoricalEventSimulationTab — Fire Spread tab in event detail
   ================================================================ */

function HistoricalEventSimulationTab({
  fireBehaviour,
  selectedSimulationId,
  selectedSimulation,
  selectedSimulationError,
  onSelectSimulation,
  onClearSimulation,
}) {
  const simulations = fireBehaviour?.nearby_simulations || [];

  if (!simulations.length) {
    return <div className="tab-content-empty">No bundled fire spread simulation is linked closely enough to this fire.</div>;
  }

  return (
    <div className="tab-content">
      <div className="hotspots-table">
        <div className="hotspots-table-header">
          <span>Simulation</span>
          <span>Match</span>
          <span>Layers</span>
        </div>
        {simulations.map((simulation) => {
          const isActive = selectedSimulationId === simulation.simulation_id;
          const matchLabel = simulation.match_type === 'stable_id'
            ? 'Stable fire ID'
            : simulation.distance_km != null
              ? `${simulation.distance_km} km away`
              : 'Nearby';
          const layerLabels = ['isochrones', 'roads']
            .filter((key) => simulation.available_layers?.[key])
            .join(' \u00B7 ') || 'No layers';

          return (
            <button
              key={simulation.simulation_id}
              type="button"
              className={`rt-summary-list-item ${isActive ? 'active' : ''}`}
              onClick={() => onSelectSimulation?.(simulation.simulation_id)}
            >
              <span className="rt-summary-list-main">{simulation.supercluster_label || simulation.simulation_id}</span>
              <span className="rt-summary-list-meta">{matchLabel} {'\u00B7'} {layerLabels}</span>
            </button>
          );
        })}
      </div>
      {selectedSimulationError && simulations.some((item) => item.simulation_id === selectedSimulationId) && (
        <div className="sim-error-detail">{selectedSimulationError}</div>
      )}
      {selectedSimulation && simulations.some((item) => item.simulation_id === selectedSimulationId) && (
        <div className="rt-hotspot-detail" style={{ padding: '12px 0 0', borderTop: 'none' }}>
          <div className="detail-section-title">Selected Fire Spread Simulation</div>
          <div className="detail-field-groups">
            <DetailFieldGroup
              title="Bundle"
              rows={[
                ['Run ID', selectedSimulation.run_id || '\u2014'],
                ['Report Date', selectedSimulation.source?.report_date || '\u2014'],
                ['Source', selectedSimulation.source?.source_dir || '\u2014'],
              ]}
            />
            <DetailFieldGroup
              title="Layers"
              rows={[
                ['Isochrones', selectedSimulation.available_results?.isochrones ? 'available' : 'missing'],
                ['Roads', selectedSimulation.available_results?.roads ? 'available' : 'missing'],
              ]}
            />
          </div>
          <div className="sim-actions" style={{ marginTop: 10 }}>
            <button className="sim-clear-btn" onClick={() => onClearSimulation?.()}>Clear Simulation</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ================================================================
   RealtimeSidebar — real-time mode content
   ================================================================ */

function RealtimeSidebar({
  rtStatus, rtMetadata, rtEventMetadata, allProducts, activeProducts, rtMonitoringHours,
  rtWindowStart, rtWindowEnd,
  hotspots, events, ignitions, onSelectHotspot, onSelectCluster, onSelectIgnition,
  savedSimulationRuns, savedSimulationDiagnostics, savedSimulationRefreshing, savedSimulationRequestLimit,
  onRequestMoreSavedSimulations, selectedSavedSimulationId,
  selectedSavedSimulation, selectedSavedSimulationError, onSelectSavedSimulation, onClearSavedSimulation,
  lgaData, layers,
}) {
  const [activeList, setActiveList] = useState(null);
  const [productListFilter, setProductListFilter] = useState(null);
  const [hotspotsDownloadStatus, setHotspotsDownloadStatus] = useState({}); // { product: status }
  const [savedSimDownloadStatus, setSavedSimDownloadStatus] = useState(''); // downloading, success, error
  const [savedSimulationVisibleCount, setSavedSimulationVisibleCount] = useState(24);

  // Download handlers
  const handleDownloadHotspots = async (productId) => {
    if (!hotspots || !hotspots.features || hotspots.features.length === 0) {
      setHotspotsDownloadStatus(prev => ({ ...prev, [productId]: 'error' }));
      setTimeout(() => setHotspotsDownloadStatus(prev => ({ ...prev, [productId]: '' })), 2000);
      return;
    }

    // Filter hotspots by product if needed
    const filteredHotspots = {
      ...hotspots,
      features: hotspots.features.filter(f => !productId || f.properties?.product_id === productId),
    };

    if (filteredHotspots.features.length === 0) {
      setHotspotsDownloadStatus(prev => ({ ...prev, [productId]: 'error' }));
      setTimeout(() => setHotspotsDownloadStatus(prev => ({ ...prev, [productId]: '' })), 2000);
      return;
    }

    try {
      setHotspotsDownloadStatus(prev => ({ ...prev, [productId]: 'downloading' }));
      downloadRealtimeHotspots(filteredHotspots, productId, rtMonitoringHours || 12);
      setHotspotsDownloadStatus(prev => ({ ...prev, [productId]: 'success' }));
      setTimeout(() => setHotspotsDownloadStatus(prev => ({ ...prev, [productId]: '' })), 2000);
    } catch (err) {
      console.error('Download failed:', err);
      setHotspotsDownloadStatus(prev => ({ ...prev, [productId]: 'error' }));
      setTimeout(() => setHotspotsDownloadStatus(prev => ({ ...prev, [productId]: '' })), 2000);
    }
  };

  const handleDownloadSavedSimulation = async () => {
    if (!selectedSavedSimulation) return;

    try {
      setSavedSimDownloadStatus('downloading');
      
      // If we have a full payload, use it directly; otherwise fetch it
      const fullSimulation = selectedSavedSimulation.results 
        ? selectedSavedSimulation 
        : await getSavedSimulationRun(selectedSavedSimulation.id);
      
      downloadSimulationResult(fullSimulation, selectedSavedSimulation.id);
      setSavedSimDownloadStatus('success');
      setTimeout(() => setSavedSimDownloadStatus(''), 2000);
    } catch (err) {
      console.error('Download failed:', err);
      setSavedSimDownloadStatus('error');
      setTimeout(() => setSavedSimDownloadStatus(''), 2000);
    }
  };

  // Group hotspot counts by product
  const productCounts = {};
  let totalCount = 0;
  if (rtMetadata) {
    for (const [pid, count] of Object.entries(rtMetadata.product_counts || {})) {
      productCounts[pid] = count || 0;
      totalCount += count || 0;
    }
  }
  const liveClusterCount = rtEventMetadata?.count || 0;
  const liveIgnitionCount = rtEventMetadata?.ignition_count || 0;
  const brightS3Active = activeProducts.includes('bright_s3');
  const s3LiveEnabled = Boolean(rtStatus?.s3_live_enabled);
  const hotspotDiagnostics = rtMetadata?.source_diagnostics?.bright_s3 || null;
  const s3MissingFiles = Boolean(hotspotDiagnostics?.reason?.includes('No detection exports found'));
  const showS3FailureBanner = brightS3Active && (!s3LiveEnabled || s3MissingFiles);
  const hotspotSummaries = summariseRealtimeHotspots(hotspots)
    .filter(item => !productListFilter || item.product_id === productListFilter)
    .sort((left, right) => new Date(right.datetime || 0).getTime() - new Date(left.datetime || 0).getTime());
  const clusterSummaries = summariseRealtimeClusters(events)
    .sort((left, right) => new Date(right.firstTime || 0).getTime() - new Date(left.firstTime || 0).getTime());
  const ignitionSummaries = summariseRealtimeIgnitions(ignitions)
    .sort((left, right) => new Date(right.datetime || 0).getTime() - new Date(left.datetime || 0).getTime());
  const savedSimulationItems = useMemo(() => {
    return (savedSimulationRuns || [])
      .filter((run) => isTimestampWithinWindow(run?.startDateTime, rtWindowStart, rtWindowEnd))
      .map((run) => {
        const lgaName = findLgaNameForPoint(Number(run?.lat), Number(run?.lng), lgaData) || 'Unknown LGA';
        return {
          ...run,
          lgaName,
          modeLabel: formatSimulationModeLabel(run?.source?.mode),
          title: buildSavedSimulationTitle(run, lgaName),
        };
      });
  }, [savedSimulationRuns, lgaData, rtWindowStart, rtWindowEnd]);
  const savedSimulationCount = savedSimulationItems.length;
  const visibleClusterCount = layers?.fireEvents ? liveClusterCount : 0;
  const visibleIgnitionCount = layers?.ignitions ? liveIgnitionCount : 0;
  const visibleSavedSimulationCount = layers?.savedSimulations ? savedSimulationCount : 0;
  const savedSimulationPageSize = 24;
  const showHotspotList = activeList === 'hotspots' && hotspotSummaries.length > 0;
  const showClusterList = activeList === 'clusters' && layers?.fireEvents && visibleClusterCount > 0;
  const showIgnitionList = activeList === 'ignitions' && layers?.ignitions && visibleIgnitionCount > 0;
  const showSavedSimulationList = activeList === 'saved-simulations' && layers?.savedSimulations && visibleSavedSimulationCount > 0;
  const showSavedSimulationEmpty = activeList === 'saved-simulations' && layers?.savedSimulations && visibleSavedSimulationCount === 0;
  const savedSimulationVisibleItems = savedSimulationItems.slice(0, savedSimulationVisibleCount);
  const savedSimulationDiagnosticsTotal = Number(savedSimulationDiagnostics?.total || 0);
  const savedSimulationHasMoreVisible = savedSimulationVisibleCount < visibleSavedSimulationCount;
  const savedSimulationHasMoreBackend = savedSimulationDiagnosticsTotal > savedSimulationItems.length;
  const savedSimulationCanShowMore = showSavedSimulationList && (savedSimulationHasMoreVisible || savedSimulationHasMoreBackend);
  const selectedSavedSimulationLga = useMemo(() => {
    return findLgaNameForPoint(Number(selectedSavedSimulation?.lat), Number(selectedSavedSimulation?.lng), lgaData) || 'Unknown LGA';
  }, [selectedSavedSimulation, lgaData]);

  useEffect(() => {
    if (!showSavedSimulationList) return;
    setSavedSimulationVisibleCount((current) => Math.min(Math.max(current, savedSimulationPageSize), visibleSavedSimulationCount || current));
  }, [showSavedSimulationList, visibleSavedSimulationCount]);

  // Format XPRIZE day boundaries cleanly
  const fmtRange = (isoStart, isoEnd) => {
    if (!isoStart || !isoEnd) return { utcRange: '—', aestRange: '—' };
    const start = new Date(isoStart);
    const end = new Date(isoEnd);
    const opts = { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' };
    const utcStart = start.toLocaleString('en-AU', { ...opts, timeZone: 'UTC' });
    const utcEnd = end.toLocaleString('en-AU', { ...opts, timeZone: 'UTC' });
    const aestStart = start.toLocaleString('en-AU', { ...opts, timeZone: 'Australia/Sydney' });
    const aestEnd = end.toLocaleString('en-AU', { ...opts, timeZone: 'Australia/Sydney' });
    return {
      utcRange: `${utcStart} — ${utcEnd} UTC`,
      aestRange: `${aestStart} — ${aestEnd} AEST`,
    };
  };

  const dayRange = rtStatus ? fmtRange(rtStatus.xprize_day_start, rtStatus.xprize_day_end) : null;

  return (
    <>
      <div className="sidebar-header">
        <h2>
          <span className="fire-icon">🛰</span>
          Real-Time Hotspots
          <span className="text-muted text-sm" style={{ fontWeight: 400, marginLeft: 4 }}>
            {totalCount} total
          </span>
        </h2>
      </div>

      {/* XPRIZE Day Info — clean layout */}
      {rtStatus && (
        <div className="rt-day-info">
          <div className="detail-section-title">📅 Current XPRIZE Day (24-hour period)</div>
          <div className="xprize-day-block">
            <div className="xprize-time-row">
              <span className="xprize-label">UTC</span>
              <span className="xprize-value">{dayRange?.utcRange}</span>
            </div>
            <div className="xprize-time-row">
              <span className="xprize-label">AEST</span>
              <span className="xprize-value aest">{dayRange?.aestRange}</span>
            </div>

          </div>
        </div>
      )}

      {showS3FailureBanner && (
        <div className="rt-s3-status-banner">
          <div className="rt-s3-status-title">BRIGHT AHI v2.0 Warning</div>
          {!s3LiveEnabled ? (
            <div>
              Live BRIGHT AHI v2.0 access is currently disabled in backend configuration.
            </div>
          ) : (
            <div>
              {hotspotDiagnostics?.reason || 'The backend could not find the expected BRIGHT AHI v2.0 export files for the selected monitoring window.'}
            </div>
          )}
        </div>
      )}

      {/* Product Summary */}
      <div className="rt-product-summary">
        <div className="detail-section-title">🔥 Hotspot counts by Product</div>
        {allProducts && allProducts.map(prod => {
          const pid = prod.id;
          const count = productCounts[pid] || 0;
          const isActive = activeProducts.includes(pid);
          const downloadState = hotspotsDownloadStatus[pid] || '';
          const btnText = downloadState === 'downloading' ? 'Downloading...'
            : downloadState === 'success' ? 'Downloaded'
              : downloadState === 'error' ? 'Failed'
                : 'Download';

          return (
            <div key={pid} className={`rt-product-row ${isActive ? 'active' : 'inactive'}`}>
              <div className="rt-product-row-main">
                <span className="product-label">{prod.label}</span>
                <span className="product-count">{count}</span>
              </div>
              <button
                type="button"
                className={`rt-product-download-btn ${downloadState ? `is-${downloadState}` : ''}`}
                onClick={() => handleDownloadHotspots(pid)}
                disabled={downloadState === 'downloading' || count === 0}
                title={count === 0 ? 'No hotspots available for this product' : `Download ${count} hotspots`}
              >
                {btnText}
              </button>
            </div>
          );
        })}
      </div>

      <div style={{ padding: '6px 16px', fontSize: 11, color: 'var(--text-secondary)', background: 'rgba(96, 165, 250, 0.08)', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 14 }}>💡</span>
        <span>Tip: Click on a hotspot on the map for individual statistics</span>
      </div>

      {/* Summary stats — always visible to prevent layout jump */}
      <div className="rt-stats-section">
        <div className="detail-section-title">📊 Fire Report Summary</div>

        <div className="frp-stats-row frp-stats-primary">
            <button type="button" className={`frp-stat-box ${activeList === 'hotspots' ? 'active' : ''}`} onClick={() => { setActiveList('hotspots'); setProductListFilter(null); }}>
              <div className="frp-stat-value text-fire">{totalCount}</div>
              <div className="frp-stat-label">Hotspots ({rtMonitoringHours || 12}h)</div>
            </button>
            <button type="button" className={`frp-stat-box ${activeList === 'products' ? 'active' : ''}`} onClick={() => { setActiveList('products'); setProductListFilter(null); }}>
              <div className="frp-stat-value text-yellow">{Object.values(productCounts).filter(c => c > 0).length}</div>
              <div className="frp-stat-label">Active Products</div>
            </button>
          </div>
          <div className="frp-stats-row frp-stats-secondary">
            <button type="button" className={`frp-stat-box ${activeList === 'clusters' ? 'active' : ''}`} onClick={() => { setActiveList('clusters'); setProductListFilter(null); }}>
              <div className="frp-stat-value text-fire">{visibleClusterCount}</div>
              <div className="frp-stat-label">Fire Complexes</div>
            </button>
            <button type="button" className={`frp-stat-box ${activeList === 'ignitions' ? 'active' : ''}`} onClick={() => { setActiveList('ignitions'); setProductListFilter(null); }}>
              <div className="frp-stat-value text-yellow">{visibleIgnitionCount}</div>
              <div className="frp-stat-label">Ignitions</div>
            </button>
            <button type="button" className={`frp-stat-box ${activeList === 'saved-simulations' ? 'active' : ''}`} onClick={() => { setActiveList('saved-simulations'); setProductListFilter(null); }}>
              <div className="frp-stat-value text-yellow">{visibleSavedSimulationCount}</div>
              <div className="frp-stat-label">Saved Fire Spread Simulations</div>
            </button>
          </div>

          {/* FRP Statistics */}
          {(() => {
            const frpStats = rtMetadata?.frp_stats || {};
            const overallFrp = frpStats._all || {};
            const hasOverall = overallFrp.count > 0;
            return (
              <div className="rt-frp-section">
                <div className="detail-section-title" style={{ fontSize: 11, marginTop: 10 }}>🔥 FRP Statistics</div>
                <div className="rt-frp-context">
                  <div className="detail-row">
                    <span className="detail-label">Monitoring Window : </span>
                    <span className="detail-value">{rtMonitoringHours || 12} hours</span>
                  </div>
                  <div className="detail-row">
                    <span className="detail-label">Monitoring Extent : </span>
                    <span className="detail-value">New South Wales (NSW)</span>
                  </div>
                </div>
                {hasOverall ? (
                  <>
                    {allProducts && allProducts.map(prod => {
                      const stats = frpStats[prod.id] || { count: 0, total: 0, mean: 0, max: 0 };
                      return (
                        <div key={prod.id} className="rt-frp-product-row">
                          <div className="rt-frp-product-header">
                            <span className="rt-frp-product-name">{prod.label}</span>
                            <span className="rt-frp-product-count">{stats.count} hotspots</span>
                          </div>
                          <div className="rt-frp-product-stats">
                            <div className="rt-frp-stat">
                              <span className="rt-frp-stat-value text-fire">{stats.total?.toFixed(1) ?? '—'}</span>
                              <span className="rt-frp-stat-label">Total FRP (MW)</span>
                            </div>
                            <div className="rt-frp-stat">
                              <span className="rt-frp-stat-value text-yellow">{stats.mean?.toFixed(1) ?? '—'}</span>
                              <span className="rt-frp-stat-label">Mean FRP (MW)</span>
                            </div>
                            <div className="rt-frp-stat">
                              <span className="rt-frp-stat-value text-fire">{stats.max?.toFixed(1) ?? '—'}</span>
                              <span className="rt-frp-stat-label">Max FRP (MW)</span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </>
                ) : (
                  <div className="text-muted" style={{ fontSize: 11, padding: '4px 0' }}>No FRP data available in current window.</div>
                )}
              </div>
            );
          })()}

        </div>

      {activeList === 'products' && (
        <div className="rt-summary-list">
          <div className="detail-section-title">🛰 Active Products</div>
          {allProducts?.filter(product => (productCounts[product.id] || 0) > 0).map(product => (
            <button
              key={product.id}
              type="button"
              className="rt-summary-list-item"
              onClick={() => {
                setActiveList('hotspots');
                setProductListFilter(product.id);
              }}
            >
              <span className="rt-summary-list-main">{product.label}</span>
              <span className="rt-summary-list-meta">{productCounts[product.id]} hotspots</span>
            </button>
          ))}
        </div>
      )}

      {showHotspotList && (
        <div className="rt-summary-list rt-summary-list-scroll-shell">
          <div className="detail-section-title">📍 Hotspot List {productListFilter ? `· ${getProductDisplayName(productListFilter)}` : ''}</div>
          <div className="rt-summary-list-body rt-summary-list-body-scroll">
            {hotspotSummaries.slice(0, 40).map(hotspot => (
              <button
                key={`${hotspot.id}-${hotspot.idx}`}
                type="button"
                className="rt-summary-list-item"
                onClick={() => onSelectHotspot?.(hotspot, { flyTo: true })}
              >
                <span className="rt-summary-list-main">{hotspot.displayId || getHotspotId(hotspot.properties, hotspot)}</span>
                <span className="rt-summary-list-meta">{getProductDisplayName(hotspot.product_id)} · {hotspot.datetime ? fmtDate(hotspot.datetime) : 'Unknown time'}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {showClusterList && (
          <div className="rt-summary-list rt-summary-list-scroll-shell">
          <div className="detail-section-title">📦 Fire Complex List</div>
            <div className="rt-summary-list-body rt-summary-list-body-scroll">
              {clusterSummaries.map(cluster => (
                <button
                  key={cluster.id}
                  type="button"
                  className="rt-summary-list-item"
                  onClick={() => onSelectCluster?.(cluster.id)}
                >
                  <span className="rt-summary-list-main">Fire Complex {cluster.id}</span>
                  <span className="rt-summary-list-meta">{cluster.hotspotCount} hotspots · {cluster.firstTime ? fmtDate(cluster.firstTime) : 'Unknown time'}</span>
                </button>
              ))}
            </div>
        </div>
      )}

      {showIgnitionList && (
          <div className="rt-summary-list rt-summary-list-scroll-shell">
          <div className="detail-section-title">🟡 Ignition List</div>
            <div className="rt-summary-list-body rt-summary-list-body-scroll">
              {ignitionSummaries.map(ignition => (
                <button
                  key={`${ignition.id}-${ignition.stableId || 'none'}`}
                  type="button"
                  className="rt-summary-list-item"
                  onClick={() => onSelectIgnition?.(ignition)}
                >
                  <span className="rt-summary-list-main">Ignition {ignition.id}</span>
                  <span className="rt-summary-list-meta">{ignition.datetime ? fmtDate(ignition.datetime) : 'Unknown time'}{ignition.stableId != null ? ` · Fire Complex ${ignition.stableId}` : ''}</span>
                </button>
              ))}
            </div>
        </div>
      )}

      {showSavedSimulationEmpty && (
        <div className="rt-summary-list">
          <div className="detail-section-title">💾 Saved Simulations</div>
          <p className="text-muted" style={{ fontSize: 12, padding: '8px 0' }}>No saved simulations yet.</p>
        </div>
      )}

      {showSavedSimulationList && (
        <div className="rt-summary-list rt-summary-list-scroll-shell">
          <div className="detail-section-title">
            💾 Saved Simulations{savedSimulationRefreshing ? ' · Refreshing' : ''}
            <span className="text-muted" style={{ marginLeft: 6, fontWeight: 400 }}>
              {savedSimulationItems.length}{savedSimulationDiagnosticsTotal ? ` / ${savedSimulationDiagnosticsTotal}` : ''}
            </span>
          </div>
          <div className="rt-summary-list-body rt-summary-list-body-scroll">
            {savedSimulationVisibleItems.map((run) => (
              <button
                key={run.run_id}
                type="button"
                className={`rt-summary-list-item ${selectedSavedSimulationId === run.run_id ? 'active' : ''}`}
                onClick={() => onSelectSavedSimulation?.(run.run_id)}
              >
                <span className="rt-summary-list-main">{run.title}</span>
                <span className="rt-summary-list-meta">
                  {run.modeLabel}
                  {run.startDateTime && <span className="rt-summary-list-time">{fmtAest(run.startDateTime)}</span>}
                </span>
              </button>
            ))}
          </div>
          {savedSimulationCanShowMore && (
            <button
              type="button"
              className="rt-summary-list-item"
              onClick={() => {
                if (savedSimulationHasMoreVisible) {
                  setSavedSimulationVisibleCount((current) => current + savedSimulationPageSize);
                  return;
                }
                onRequestMoreSavedSimulations?.();
              }}
              disabled={savedSimulationRefreshing}
              style={{ marginTop: 8, justifyContent: 'center' }}
            >
              {savedSimulationHasMoreVisible ? 'Show more' : savedSimulationRefreshing ? 'Loading more…' : `Load more from backend (${savedSimulationRequestLimit || 100} requested)`}
            </button>
          )}
          {savedSimulationDiagnostics?.error && (
            <div className="sim-error-detail">{savedSimulationDiagnostics.error}</div>
          )}
          {selectedSavedSimulationError && (
            <div className="sim-error-detail">{selectedSavedSimulationError}</div>
          )}
          {selectedSavedSimulation && (() => {
            const summary = formatSavedSimulationSummary(selectedSavedSimulation);
            const spatialRows = [
              ['LGA', selectedSavedSimulationLga],
              ['Location', formatSavedSimulationLocation(selectedSavedSimulation)],
            ].filter(([, value]) => value && value !== '—');
            const temporalRows = [
              ['Start Time', selectedSavedSimulation.startDateTime ? fmtAest(selectedSavedSimulation.startDateTime) : '—'],
            ].filter(([, value]) => value && value !== '—');
            const outputRows = [
              ['Total Fire Area', summary.areaKm2 != null ? `${summary.areaKm2.toFixed(2)} km²` : '—'],
              ['High Intensity Area', summary.highIntensityKm2 != null ? `${summary.highIntensityKm2.toFixed(2)} km²` : '—'],
              ['High Intensity Fraction', summary.highFraction != null ? `${summary.highFraction.toFixed(1)}%` : '—'],
            ].filter(([, value]) => value && value !== '—');
            const parameterRows = [
              ['Run ID', selectedSavedSimulationId],
              ['Mode', formatSimulationModeLabel(selectedSavedSimulation.source?.mode)],
              ['Source Hotspot', selectedSavedSimulation.source?.source_hotspot_id || 'none'],
              ['Source Fire Complex', selectedSavedSimulation.source?.source_supercluster_id || 'none'],
              ['Persistence', `${selectedSavedSimulation.persistence?.local?.status || 'unknown'} / ${selectedSavedSimulation.persistence?.s3?.status || 'disabled'}`],
            ];

            return (
              <div className="rt-hotspot-detail" style={{ padding: '12px 0 0', borderTop: 'none' }}>
                <div className="detail-section-title">🧭 Selected Saved Simulation</div>
                <div className="detail-field-groups">
                  <DetailFieldGroup title="Spatial" rows={spatialRows} />
                  <DetailFieldGroup title="Temporal" rows={temporalRows} />
                  <DetailFieldGroup title="Output" rows={outputRows} />
                  <DetailFieldGroup title="Parameters" rows={parameterRows} />
                </div>
                <div className="sim-actions" style={{ marginTop: 10 }}>
                  <button 
                    className="sim-clear-btn" 
                    onClick={handleDownloadSavedSimulation}
                    disabled={savedSimDownloadStatus === 'downloading'}
                    title="Download simulation results as GeoJSON"
                  >
                    {savedSimDownloadStatus === 'downloading' ? '↓ Downloading...' : savedSimDownloadStatus === 'success' ? '✓ Downloaded' : savedSimDownloadStatus === 'error' ? '✗ Failed' : '⬇ Download Result'}
                  </button>
                  <button className="sim-clear-btn" onClick={() => onClearSavedSimulation?.()}>Clear Saved Run</button>
                </div>
              </div>
            );
          })()}
        </div>
      )}

    </>
  );
}

/* ================================================================
   LinkedSimulationsSection - shows saved simulations linked to a
   hotspot or fire complex via stable_id / hotspot_id.
   ================================================================ */

const SIM_STATUS_ICONS = { ok: '\u25CF', running: '\u25CE', error: '\u2717', corrupt: '\u26A0' };
const SIM_STATUS_CLASSES = { ok: 'linked-sim-ok', running: 'linked-sim-running', error: 'linked-sim-error', corrupt: 'linked-sim-corrupt' };

function fmtTimeAgo(iso) {
  if (!iso) return '';
  try {
    const ms = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  } catch { return ''; }
}

function LinkedSimulationsSection({ stableId, hotspotId, onViewSimulation }) {
  const { simulations, loading, error } = useLinkedSimulations(stableId, hotspotId);
  const [expanded, setExpanded] = useState(false);

  if (!stableId && !hotspotId) return null;

  const sorted = [...simulations].sort((a, b) => {
    const ta = a.saved_at || a.startDateTime || '';
    const tb = b.saved_at || b.startDateTime || '';
    return tb.localeCompare(ta);
  });

  const count = sorted.length;
  const statusLabel = loading ? 'checking\u2026' : count === 0 ? 'none' : count === 1 ? '1 simulation' : `${count} simulations`;

  return (
    <div className="linked-simulations-section">
      <button
        type="button"
        className="cluster-detail-toggle linked-sim-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((prev) => !prev)}
      >
        <span className="linked-sim-badge-label">
          {expanded ? '\u25BE' : '\u25B8'} Simulations:
        </span>
        <span className={`linked-sim-badge ${count > 0 ? 'linked-sim-badge-has' : ''}`}>
          {statusLabel}
        </span>
      </button>

      {expanded && (
        <div className="linked-sim-body">
          {loading && <div className="linked-sim-loading">{'Loading simulations\u2026'}</div>}
          {error && <div className="linked-sim-error-msg">{error}</div>}

          {!loading && !error && count === 0 && (
            <div className="linked-sim-empty">No saved simulations for this detection.</div>
          )}

          {!loading && count > 0 && sorted.map((run, idx) => {
            const status = run.status || 'ok';
            const areaKm2 = run.summary?.area_sim != null ? (Number(run.summary.area_sim) / 100).toFixed(1) : null;
            const savedAgo = run.saved_at ? fmtTimeAgo(run.saved_at) : '';
            const isLatest = idx === 0 && count > 1;
            return (
              <button
                key={run.run_id}
                type="button"
                className="linked-sim-item"
                onClick={() => onViewSimulation?.(run.run_id)}
                title={`View simulation ${run.run_id}`}
              >
                <span className={`linked-sim-status ${SIM_STATUS_CLASSES[status] || ''}`}>
                  {SIM_STATUS_ICONS[status] || '?'}
                </span>
                <span className="linked-sim-info">
                  <span className="linked-sim-info-top">
                    {isLatest && <span className="linked-sim-latest-badge">Latest</span>}
                    {run.startDateTime ? fmtAest(run.startDateTime) : run.run_id?.slice(0, 8)}
                  </span>
                  <span className="linked-sim-info-bottom">
                    {areaKm2 != null ? `${areaKm2} km\u00B2` : ''}
                    {savedAgo ? ` \u00B7 ${savedAgo}` : ''}
                    {status === 'error' ? ' \u00B7 Failed' : status === 'running' ? ' \u00B7 In progress' : ''}
                  </span>
                </span>
                <span className="linked-sim-arrow">{'\u2192'}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RealtimeHotspotDetail({ hotspots, allHotspots, onSelectHotspot, onViewSimulation }) {
  const [expandedTechnicalHotspotIdx, setExpandedTechnicalHotspotIdx] = useState(null);
  const selectedHotspot = hotspots?.[0] || null;
  const allHotspotSummaries = summariseRealtimeHotspots(allHotspots);
  const selectedCoordKey = selectedHotspot?.coordKey || (selectedHotspot && Number.isFinite(selectedHotspot.lat) && Number.isFinite(selectedHotspot.lng)
    ? `${Number(selectedHotspot.lat).toFixed(5)},${Number(selectedHotspot.lng).toFixed(5)}`
    : null);
  const contextHotspots = (hotspots || []).filter((item) => item?.idx !== selectedHotspot?.idx);
  const relatedHotspots = contextHotspots.length > 0
    ? contextHotspots
    : (selectedCoordKey
      ? allHotspotSummaries.filter((item) => item.coordKey === selectedCoordKey && item.idx !== selectedHotspot?.idx)
      : []);

  if (!selectedHotspot) return null;

  const technicalExpanded = expandedTechnicalHotspotIdx === selectedHotspot.idx;

  const props = selectedHotspot.properties || {};
  const detectionTime = selectedHotspot.datetime || getHotspotProp(props, ['datetime', 'dt', 'hotspot_datetime']);
  const frp = getValidFrp(selectedHotspot.frp ?? getHotspotProp(props, ['frp_mw', 'power', 'frp']));
  const tempKRaw = getHotspotProp(props, ['temperature_kelvin', 'temp_kelvin', 'temp_k', 'brightness_temp_k']);
  const tempK = tempKRaw != null && tempKRaw !== '' ? Number(tempKRaw) : NaN;
  const accuracy = getHotspotProp(props, ['accuracy', 'positional_accuracy', 'geolocation_accuracy']);
  const primaryRows = [
    ['Detection Time', detectionTime ? fmtAest(detectionTime) : '—'],
    ['Hours Since', detectionTime ? fmtHotspotHoursSince(detectionTime) : '—'],
    ['FRP', frp != null ? `${frp.toFixed(1)} MW` : 'Unknown'],
    ['Confidence', getHotspotProp(props, ['confidence']) || '—'],
    ['Product', getProductDisplayName(getHotspotProp(props, ['product_id']) || selectedHotspot.product_id)],
  ].filter(([, value]) => value !== '—' && value !== 'Unknown');
  const technicalRows = [
    ['Hotspot ID', getHotspotId(props, selectedHotspot)],
    ['Latitude', Number(selectedHotspot.lat).toFixed(5)],
    ['Longitude', Number(selectedHotspot.lng).toFixed(5)],
    ['Satellite', getHotspotProp(props, ['satellite', 'platform']) || '—'],
    ['Sensor', getHotspotProp(props, ['sensor', 'instrument']) || '—'],
    ['Temperature', Number.isFinite(tempK) && tempK >= 200 ? `${tempK.toFixed(1)} K (${(tempK - 273.15).toFixed(1)} \u00B0C)` : '\u2014'],
    ['Accuracy', accuracy != null ? String(accuracy) : '—'],
    ['Process Algorithm', getHotspotProp(props, ['process_algorithm', 'algorithm']) || '—'],
    ['Scan', getHotspotProp(props, ['scan']) || '—'],
    ['Track', getHotspotProp(props, ['track']) || '—'],
  ].filter(([, value]) => value !== '—');

  return (
    <div className="rt-hotspot-detail">
      <div className="detail-section-title">📍 Selected Hotspot</div>
      <div className="rt-hotspot-detail-note">
        {relatedHotspots.length > 0
          ? `${relatedHotspots.length + 1} hotspots share this coordinate.`
          : 'Single hotspot at this coordinate.'}
      </div>
      <div className="rt-hotspot-card">
        <div className="rt-hotspot-card-header rt-hotspot-card-header-static active">
          <span>{getHotspotId(props, selectedHotspot)}</span>
          <span className="text-muted">{detectionTime ? fmtDate(detectionTime) : selectedHotspot.product_id}</span>
        </div>
        <div className="rt-hotspot-card-body">
          {primaryRows.map(([label, value]) => (
            <div key={label} className="detail-row">
              <span className="detail-label">{label}</span>
              <span className="detail-value">{value}</span>
            </div>
          ))}
          {technicalRows.length > 0 && (
            <>
              <button
                type="button"
                className="cluster-detail-toggle hotspot-detail-toggle"
                aria-expanded={technicalExpanded}
                onClick={() => setExpandedTechnicalHotspotIdx((prev) => (prev === selectedHotspot.idx ? null : selectedHotspot.idx))}
              >
                {technicalExpanded ? '▾ Hide technical fields' : '▸ Show technical fields'}
              </button>
              {technicalExpanded && (
                <div className="rt-hotspot-technical-fields">
                  {technicalRows.map(([label, value]) => (
                    <div key={label} className="detail-row">
                      <span className="detail-label">{label}</span>
                      <span className="detail-value">{value}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {relatedHotspots.length > 0 && (
        <div className="rt-related-hotspots rt-summary-list-scroll-shell">
          <div className="detail-section-title">Related Hotspots At This Coordinate</div>
          <div className="rt-summary-list-body rt-summary-list-body-scroll">
            {relatedHotspots.map((hotspot) => {
              const hotspotProps = hotspot.properties || {};
              const hotspotTime = hotspot.datetime || getHotspotProp(hotspotProps, ['datetime', 'dt', 'hotspot_datetime']);
              return (
                <button
                  key={`${hotspot.id}-${hotspot.idx}`}
                  type="button"
                  className="rt-summary-list-item rt-related-hotspot-item"
                  onClick={() => onSelectHotspot?.(hotspot, { flyTo: true, contextHotspots: [hotspot, ...relatedHotspots.filter((item) => item.idx !== hotspot.idx)] })}
                >
                  <span className="rt-summary-list-main">{hotspot.displayId || getHotspotId(hotspotProps, hotspot)}</span>
                  <span className="rt-summary-list-meta">
                    {getProductDisplayName(getHotspotProp(hotspotProps, ['product_id']) || hotspot.product_id)}
                    <span className="rt-summary-list-time">{hotspotTime ? fmtAest(hotspotTime) : 'Unknown time'}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      <LinkedSimulationsSection
        stableId={selectedHotspot.stableId}
        hotspotId={selectedHotspot.id}
        onViewSimulation={onViewSimulation}
      />
    </div>
  );
}

function RealtimeClusterDetail({ events, selectedClusterId, monitoringHours, onViewSimulation }) {
  const [expanded, setExpanded] = useState(false);
  if (selectedClusterId == null || !events?.features?.length) return null;

  const feature = events.features.find((item) => {
    const props = item.properties || {};
    return (props.stable_id ?? props.cluster_id ?? props.event_id ?? props.fire_id) == selectedClusterId;
  });
  if (!feature) return null;

  const props = feature.properties || {};
  const clusterId = props.stable_id ?? props.cluster_id ?? props.event_id ?? props.fire_id ?? '—';
  const hotspotCount = props.n_detections ?? props.hotspot_count ?? props.n_unique_locations ?? '—';
  const area = props.area_km2 ?? props.affected_area_km2 ?? null;
  const maxFrp = getEventMaxFrp(props);
  const meanFrp = getEventMeanFrp(props);
  const durationHours = getEventDurationHours(props);
  const ignitionLat = props.ignition_lat != null ? Number(props.ignition_lat) : null;
  const ignitionLon = props.ignition_lon != null ? Number(props.ignition_lon) : null;

  return (
    <div className="rt-hotspot-detail rt-cluster-detail">
      <div className="detail-section-title">📦 Selected Fire Complex</div>
      <div className="rt-hotspot-detail-note">
        Active monitoring window: {monitoringHours || 12} hours
      </div>
      <div className="rt-hotspot-card">
        <div className="rt-hotspot-card-body rt-cluster-card-body open">
          <div className="detail-row">
            <span className="detail-label">Fire Complex ID</span>
            <span className="detail-value">{clusterId}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Hotspots</span>
            <span className="detail-value">{hotspotCount}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Estimated Area</span>
            <span className="detail-value">{area != null && area !== '' ? `${Number(area).toFixed(1)} km²` : '—'}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Duration</span>
            <span className="detail-value">{fmtDuration(durationHours)}</span>
          </div>
          <button type="button" className="cluster-detail-toggle" aria-expanded={expanded} onClick={() => setExpanded(e => !e)}>
            {expanded ? '▾ Hide details' : '▸ More details'}
          </button>
          {expanded && (
            <>
              <div className="detail-row">
                <span className="detail-label">First Detection</span>
                <span className="detail-value">{fmtAest(props.first_hotspot_time || props.start_dt || props.datetime)}</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Last Detection</span>
                <span className="detail-value">{fmtAest(props.last_hotspot_time || props.end_dt || props.datetime)}</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Max FRP</span>
                <span className="detail-value">{maxFrp != null ? `${Number(maxFrp).toFixed(1)} MW` : '—'}</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Mean FRP</span>
                <span className="detail-value">{meanFrp != null ? `${Number(meanFrp).toFixed(1)} MW` : '—'}</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Ignition Point</span>
                <span className="detail-value">
                  {ignitionLat != null && ignitionLon != null
                    ? `${ignitionLat.toFixed(4)}°, ${ignitionLon.toFixed(4)}°`
                    : '—'}
                </span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Ignition Time</span>
                <span className="detail-value">{fmtAest(props.ignition_datetime)}</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">LGA</span>
                <span className="detail-value">{props.LGA || '—'}</span>
              </div>
            </>
          )}
        </div>
      </div>
      <LinkedSimulationsSection
        stableId={clusterId}
        hotspotId={null}
        onViewSimulation={onViewSimulation}
      />
    </div>
  );
}

/* ================================================================
   HistoricalDatePicker — published report-day selector
   ================================================================ */

function HistoricalDatePicker({ dates, selectedDate, onSelectDate, loading }) {
  if (loading && (!dates || dates.length === 0)) {
    return (
      <div className="run-picker">
        <label className="run-picker-label">Published report day</label>
        <div className="text-sm text-muted">Loading available dates…</div>
      </div>
    );
  }

  if (!dates || dates.length === 0) return null;

  return (
    <div className="run-picker">
      <label className="run-picker-label">Published report day</label>
      <select
        className="run-picker-select"
        value={selectedDate || ''}
        onChange={(e) => onSelectDate(e.target.value || null)}
      >
        <option value="">Latest published bundle</option>
        {dates.map(item => (
          <option key={item.report_date} value={item.report_date}>
            {formatHistoricalReportDateLabel(item.report_date)}
          </option>
        ))}
      </select>
    </div>
  );
}

function HistoricalSummary({ metadata, loading, error }) {
  if (loading && !metadata) {
    return (
      <div className="no-data">
        <p>Loading published bundle…</p>
      </div>
    );
  }

  if (error && !metadata) {
    return (
      <div className="no-data">
        <p>Could not load historical bundle</p>
        <p className="text-sm text-muted">{error.message || String(error)}</p>
      </div>
    );
  }

  if (!metadata) return null;

  const summary = metadata.summary || {};
  const window = metadata.window || {};
  const availableLayers = metadata.available_layers || {};
  const delivery = metadata.delivery || {};
  const reportDateLabel = formatHistoricalReportDateLabel(metadata.report_date);
  const burnAreaHa = Number(summary.total_burnt_area_ha || 0);

  return (
    <div className="historical-summary-card">
      <div className="historical-summary-card-header">
        <div>
          <div className="historical-summary-eyebrow">Published Bundle Summary</div>
          <h3 className="historical-summary-title">{reportDateLabel}</h3>
        </div>
        <div className={`historical-summary-status ${loading ? 'refreshing' : ''}`}>
          {loading ? 'Refreshing' : 'Published'}
        </div>
      </div>
      <div className="historical-summary-metrics">
        <div className="historical-summary-metric">
          <span className="historical-summary-metric-label">Fires</span>
          <strong>{summary.daily_fire_count ?? availableLayers.events ?? 0}</strong>
        </div>
        <div className="historical-summary-metric">
          <span className="historical-summary-metric-label">Hotspots</span>
          <strong>{summary.daily_hotspot_count ?? availableLayers.hotspots ?? 0}</strong>
        </div>
        <div className="historical-summary-metric">
          <span className="historical-summary-metric-label">Simulations</span>
          <strong>{availableLayers.simulations ?? 0}</strong>
        </div>
        <div className="historical-summary-metric">
          <span className="historical-summary-metric-label">Burnt Area</span>
          <strong>{burnAreaHa.toFixed(1)} ha</strong>
        </div>
      </div>
      <div className="historical-summary-grid">
        <div className="detail-row">
          <span className="detail-label">Report date : </span>
          <span className="detail-value">{metadata.report_date || '—'}</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Produced : </span>
          <span className="detail-value">{fmtAest(metadata.production_timestamp)}</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Fires : </span>
          <span className="detail-value">{summary.daily_fire_count ?? availableLayers.events ?? 0}</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Hotspots : </span>
          <span className="detail-value">{summary.daily_hotspot_count ?? availableLayers.hotspots ?? 0}</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Burnt area : </span>
          <span className="detail-value">{Number(summary.total_burnt_area_ha || 0).toFixed(1)} ha</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Simulations : </span>
          <span className="detail-value">{availableLayers.simulations ?? 0}</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Window start : </span>
          <span className="detail-value">{fmtAest(window.local_start_iso)}</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Window end : </span>
          <span className="detail-value">{fmtAest(window.local_end_iso)}</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Published files : </span>
          <span className="detail-value">{delivery.report_publish_uploaded_count ?? 0}</span>
        </div>
      </div>
      {error && <div className="historical-summary-note warning">{error.message || String(error)}</div>}
    </div>
  );
}

const HISTORICAL_SIM_PAGE_SIZE = 10;

function HistoricalSimulationList({
  simulations,
  selectedSimulationId,
  selectedSimulation,
  selectedSimulationError,
  onSelectSimulation,
  onClearSimulation,
}) {
  const total = simulations?.length || 0;
  const [visibleCount, setVisibleCount] = useState(HISTORICAL_SIM_PAGE_SIZE);

  useEffect(() => {
    setVisibleCount(HISTORICAL_SIM_PAGE_SIZE);
  }, [simulations]);

  if (!total) return null;

  const visible = simulations.slice(0, visibleCount);
  const remaining = total - visible.length;

  return (
    <div className="rt-summary-list rt-summary-list-scroll-shell">
      <div className="detail-section-title">Historical Simulations ({total})</div>
      <div className="rt-summary-list-body rt-summary-list-body-scroll">
        {visible.map((simulation) => {
          const availableLayers = simulation.available_layers || {};
          const layerLabels = ['isochrones', 'roads'].filter((key) => availableLayers[key]).join(' · ') || 'No layers';
          const label = simulation.supercluster_label || simulation.stable_id || simulation.simulation_id;
          return (
            <button
              key={simulation.simulation_id}
              type="button"
              className={`rt-summary-list-item ${selectedSimulationId === simulation.simulation_id ? 'active' : ''}`}
              onClick={() => onSelectSimulation?.(simulation.simulation_id)}
            >
              <span className="rt-summary-list-main">{label}</span>
              <span className="rt-summary-list-meta">{simulation.simulation_id} · {layerLabels}</span>
            </button>
          );
        })}
      </div>
      {remaining > 0 && (
        <button
          type="button"
          className="rt-summary-list-load-more"
          onClick={() => setVisibleCount((n) => n + HISTORICAL_SIM_PAGE_SIZE)}
        >
          Load more ({remaining} remaining)
        </button>
      )}
      {selectedSimulationError && (
        <div className="sim-error-detail">{selectedSimulationError}</div>
      )}
      {selectedSimulation && (
        <div className="rt-hotspot-detail" style={{ padding: '12px 0 0', borderTop: 'none' }}>
          <div className="detail-section-title">Selected Historical Simulation</div>
          <div className="detail-field-groups">
            <DetailFieldGroup
              title="Bundle"
              rows={[
                ['Run ID', selectedSimulation.run_id || '—'],
                ['Report Date', selectedSimulation.source?.report_date || '—'],
                ['Source', selectedSimulation.source?.source_dir || '—'],
              ]}
            />
            <DetailFieldGroup
              title="Layers"
              rows={[
                ['Isochrones', selectedSimulation.available_results?.isochrones ? 'available' : 'missing'],
                ['Roads', selectedSimulation.available_results?.roads ? 'available' : 'missing'],
              ]}
            />
          </div>
          <div className="sim-actions" style={{ marginTop: 10 }}>
            <button className="sim-clear-btn" onClick={() => onClearSimulation?.()}>Clear Historical Simulation</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ================================================================
   Sidebar — main export
   ================================================================ */

export default function Sidebar({
  open, onClose, mode, events, hotspots,
  selectedEventId, onSelectEvent, eventColors,
  layers,
  rtMetadata, rtStatus,
  rtEventMetadata,
  allProducts, activeProducts,
  selectedRealtimeHotspots, selectedRealtimeClusterId, rtMonitoringHours, rtWindowStart, rtWindowEnd, rtIgnitions,
  onSelectRealtimeHotspot, onSelectRealtimeCluster, onSelectRealtimeIgnition,
  savedSimulationRuns, savedSimulationDiagnostics, savedSimulationLoading, savedSimulationRefreshing,
  selectedSavedSimulationId, selectedSavedSimulation, selectedSavedSimulationError,
  onSelectSavedSimulation, onClearSavedSimulation,
  lgaData,
  historicalDates, historicalDatesLoading, selectedHistoricalDate, onSelectHistoricalDate,
  historicalMetadata, historicalSimulations, historicalLoading, historicalError,
  selectedHistoricalSimulationId, selectedHistoricalSimulation, selectedHistoricalSimulationError,
  onSelectHistoricalSimulation, onClearHistoricalSimulation,
  targetAreas, selectedTargetLga, onSelectTargetLga,
  historicalHighlightedLgas,
  historicalHighlightedLgaStatus,
}) {
  const sidebarBodyRef = useRef(null);
  const selectedHotspotDetailRef = useRef(null);

  useEffect(() => {
    if (!selectedRealtimeHotspots?.length) return;
    selectedHotspotDetailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [selectedRealtimeHotspots]);

  return (
    <aside className={`sidebar-left ${open ? '' : 'collapsed'}`}>
      {mode === 'realtime' ? (
        /* ---- REAL-TIME MODE ---- */
        <>
          <div style={{ display: 'flex', alignItems: 'center', padding: '4px 8px 0', justifyContent: 'flex-end' }}>
            <button className="sidebar-close-btn" onClick={onClose}>×</button>
          </div>
          <div className="sidebar-body" ref={sidebarBodyRef}>
            <RealtimeSidebar
              layers={layers}
              rtStatus={rtStatus}
              rtMetadata={rtMetadata}
              rtEventMetadata={rtEventMetadata}
              allProducts={allProducts}
              activeProducts={activeProducts}
              rtMonitoringHours={rtMonitoringHours}
              rtWindowStart={rtWindowStart}
              rtWindowEnd={rtWindowEnd}
              hotspots={hotspots}
              events={events}
              ignitions={rtIgnitions}
              onSelectHotspot={onSelectRealtimeHotspot}
              onSelectCluster={onSelectRealtimeCluster}
              onSelectIgnition={onSelectRealtimeIgnition}
              savedSimulationRuns={savedSimulationRuns}
              savedSimulationDiagnostics={savedSimulationDiagnostics}
              savedSimulationLoading={savedSimulationLoading}
              savedSimulationRefreshing={savedSimulationRefreshing}
              selectedSavedSimulationId={selectedSavedSimulationId}
              selectedSavedSimulation={selectedSavedSimulation}
              selectedSavedSimulationError={selectedSavedSimulationError}
              onSelectSavedSimulation={onSelectSavedSimulation}
              onClearSavedSimulation={onClearSavedSimulation}
              selectedRealtimeHotspots={selectedRealtimeHotspots}
              lgaData={lgaData}
            />
            <RealtimeClusterDetail
              events={events}
              selectedClusterId={selectedRealtimeClusterId}
              monitoringHours={rtMonitoringHours}
              onViewSimulation={onSelectSavedSimulation}
            />
            <div ref={selectedHotspotDetailRef}>
              <RealtimeHotspotDetail hotspots={selectedRealtimeHotspots} allHotspots={hotspots} onSelectHotspot={onSelectRealtimeHotspot} onViewSimulation={onSelectSavedSimulation} />
            </div>
          </div>
        </>
      ) : selectedEventId != null ? (
        /* ---- HISTORICAL: EVENT DETAIL ---- */
        <>
          <div style={{ display: 'flex', alignItems: 'center', padding: '4px 8px 0 0', justifyContent: 'flex-end' }}>
            <button className="tab-btn" onClick={() => onSelectEvent(null)} style={{ fontSize: 11 }}>
              ← All fires
            </button>
            <button className="sidebar-close-btn" onClick={onClose} style={{ marginLeft: 'auto' }}>×</button>
          </div>
          <div className="sidebar-body">
            <EventDetail
              eventId={selectedEventId}
              events={events}
              hotspots={hotspots}
              eventColors={eventColors}
              reportDate={selectedHistoricalDate || historicalMetadata?.report_date}
              selectedHistoricalSimulationId={selectedHistoricalSimulationId}
              selectedHistoricalSimulation={selectedHistoricalSimulation}
              selectedHistoricalSimulationError={selectedHistoricalSimulationError}
              onSelectHistoricalSimulation={onSelectHistoricalSimulation}
              onClearHistoricalSimulation={onClearHistoricalSimulation}
            />
          </div>
        </>
      ) : (
        /* ---- HISTORICAL: EVENT LIST ---- */
        <>
          <div className="sidebar-header">
            <h2>
              <span className="fire-icon">🔥</span>
              Historical Fires ({events?.features?.length || 0})
            </h2>
            <button className="close-btn" onClick={onClose}>×</button>
          </div>
          <div className="sidebar-body">
            <HistoricalDatePicker
              dates={historicalDates}
              selectedDate={selectedHistoricalDate}
              onSelectDate={onSelectHistoricalDate}
              loading={historicalDatesLoading}
            />
            <HistoricalSummary
              metadata={historicalMetadata}
              loading={historicalLoading}
              error={historicalError}
            />
            {(() => {
              const hasLgas = historicalHighlightedLgas?.length > 0;
              const emptyMessage = 'no LGA was released for the day';
              return (
                <div className="rt-summary-list rt-summary-list-scroll-shell">
                  <div className="detail-section-title">
                    {'\u{2728}'} Highlighted LGAs{hasLgas ? ` (${historicalHighlightedLgas.length})` : ''}
                  </div>
                  {hasLgas ? (
                    <div className="rt-summary-list-body rt-summary-list-body-scroll">
                      {historicalHighlightedLgas.map((entry, idx) => {
                        const display = entry.lga_name || entry.raw_name || 'Unknown LGA';
                        const isMatched = entry.matched;
                        const isActive = selectedTargetLga === display;
                        return (
                          <button
                            key={display + idx}
                            type="button"
                            className={`rt-summary-list-item ${isActive ? 'active' : ''}`}
                            onClick={() => onSelectTargetLga?.(isActive ? null : display)}
                            title={!isMatched ? `No exact match against LGA dataset; using raw poller name: ${entry.raw_name}` : undefined}
                          >
                            <span className="rt-summary-list-main">{display}</span>
                            <span className="rt-summary-list-meta">
                              {isMatched ? 'BRIGHT poller · matched' : 'BRIGHT poller · raw'}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="rt-summary-list-body">
                      <div className="rt-summary-list-item" style={{ cursor: 'default', opacity: 0.75 }}>
                        <span className="rt-summary-list-main">{emptyMessage}</span>
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
            {/* Live Target LGAs hidden in historical mode — live state doesn't apply to past dates */}
            <EventList
              events={events}
              selectedEventId={selectedEventId}
              onSelectEvent={onSelectEvent}
              eventColors={eventColors}
            />
            <HistoricalSimulationList
              simulations={historicalSimulations}
              selectedSimulationId={selectedHistoricalSimulationId}
              selectedSimulation={selectedHistoricalSimulation}
              selectedSimulationError={selectedHistoricalSimulationError}
              onSelectSimulation={onSelectHistoricalSimulation}
              onClearSimulation={onClearHistoricalSimulation}
            />
          </div>
        </>
      )}
    </aside>
  );
}
