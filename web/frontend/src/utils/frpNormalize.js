// FRP plot helpers — normalize hotspot summaries for scatter plotting.

const SOURCE_BRIGHT_20 = 'BRIGHT 2.0';
const SOURCE_BRIGHT_186 = 'BRIGHT 1.86';

export const FRP_SOURCES = {
  BRIGHT_20: SOURCE_BRIGHT_20,
  BRIGHT_186: SOURCE_BRIGHT_186,
};

export function normalizeSource(productId) {
  if (!productId) return null;
  const id = String(productId).toLowerCase();
  if (id === 'bright_s3' || id.includes('2.0') || id.includes('v2')) return SOURCE_BRIGHT_20;
  if (id === 'bright_ahi' || id.includes('1.86') || id.includes('1.8')) return SOURCE_BRIGHT_186;
  return null;
}

export function coalesceFrp(props = {}) {
  const value = props.frp_mw ?? props.power ?? props.frp ?? null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return numeric;
}

export function coalesceTime(props = {}) {
  const raw = props.datetime ?? props.detection_time ?? props.observation_time ?? props.dt ?? props.hotspot_datetime ?? null;
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

// Stable key for dedupe / selection tracking.
export function getSelectionKey(summary) {
  if (!summary) return null;
  if (summary.idx != null) return `idx:${summary.idx}`;
  const coord = summary.coordKey || `${Number(summary.lat).toFixed(2)},${Number(summary.lng).toFixed(2)}`;
  return `${coord}|${summary.product_id || 'unknown'}|${summary.datetime || ''}`;
}

export function toFrpPoint(summary) {
  if (!summary) return null;
  const source = normalizeSource(summary.product_id);
  if (!source) return null;
  const time = coalesceTime({ datetime: summary.datetime, ...summary.properties });
  if (!time) return null;
  const frp = summary.frp != null ? summary.frp : coalesceFrp(summary.properties || {});
  return {
    key: getSelectionKey(summary),
    hotspot_id: summary.displayId || summary.id || summary.properties?.id || 'unknown',
    detection_time: time,
    frp_mw: frp,
    source,
    lat: summary.lat,
    lng: summary.lng,
  };
}

export function filterPoints(points, { start, end, sourcesEnabled }) {
  const startMs = start ? start.getTime() : -Infinity;
  const endMs = end ? end.getTime() : Infinity;
  const result = { plottable: [], skippedNoFrp: 0, skippedOutOfWindow: 0 };
  for (const p of points) {
    if (!sourcesEnabled[p.source]) continue;
    const t = p.detection_time.getTime();
    if (t < startMs || t > endMs) { result.skippedOutOfWindow += 1; continue; }
    if (p.frp_mw == null) { result.skippedNoFrp += 1; continue; }
    result.plottable.push(p);
  }
  return result;
}

export function computeWindowFromPoints(points) {
  if (!points || points.length === 0) return { start: null, end: null };
  let minT = Infinity;
  let maxT = -Infinity;
  for (const p of points) {
    const t = p.detection_time.getTime();
    if (t < minT) minT = t;
    if (t > maxT) maxT = t;
  }
  if (!Number.isFinite(minT)) return { start: null, end: null };
  // Pad by 10 minutes on each side for nicer axis.
  const pad = 10 * 60 * 1000;
  return { start: new Date(minT - pad), end: new Date(maxT + pad) };
}
