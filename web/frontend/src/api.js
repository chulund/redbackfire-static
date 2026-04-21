/**
 * API client for the Redback Fire backend.
 * Supports both Historical (pipeline run) and Real-time (WFS + S3) modes.
 * In static-archive builds (VITE_STATIC_MODE=true) every call is routed to
 * pre-captured fixtures via staticApi.js instead of hitting a backend.
 */

import { resolveStatic } from './staticApi.js';

const BASE = '/api';
const STATIC_MODE = import.meta.env.VITE_STATIC_MODE === 'true';

function buildQuery(url, params = {}) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value == null) return;
    if (Array.isArray(value)) {
      if (value.length > 0) search.set(key, value.join(','));
      return;
    }
    if (value !== '') search.set(key, String(value));
  });
  const query = search.toString();
  return query ? `${url}${url.includes('?') ? '&' : '?'}${query}` : url;
}

async function buildApiError(res) {
  let detail = '';

  try {
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const body = await res.json();
      detail = body?.detail || body?.error || body?.message || '';
    } else {
      detail = (await res.text()).trim();
    }
  } catch {
    detail = '';
  }

  const suffix = detail || res.statusText || 'Request failed';
  return new Error(`API error ${res.status}: ${suffix}`);
}

async function fetchJSON(url, options = {}) {
  if (STATIC_MODE) {
    const resolved = resolveStatic(url);
    if (resolved.kind === 'stub') return resolved.body;
    if (resolved.kind === 'file') {
      const res = await fetch(resolved.url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`Static fixture missing: ${resolved.url}`);
      return res.json();
    }
    throw new Error(`No static route for ${url}`);
  }
  const { headers, ...rest } = options;
  const res = await fetch(url, {
    ...rest,
    headers: {
      Accept: 'application/json',
      ...headers,
    },
  });
  if (!res.ok) {
    throw await buildApiError(res);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Historical endpoints
// ---------------------------------------------------------------------------

export async function getStatus() {
  return fetchJSON(`${BASE}/status`);
}

export async function getHistoricalDates() {
  return fetchJSON(`${BASE}/historical/dates`);
}

export async function getHistoricalDay(reportDate = null) {
  return fetchJSON(buildQuery(`${BASE}/historical/day`, { report_date: reportDate }));
}

export async function getHistoricalSimulationRun(reportDate, simulationId, options = {}) {
  const url = buildQuery(`${BASE}/historical/simulations/${encodeURIComponent(simulationId)}`, {
    report_date: reportDate,
    include: options.include,
  });
  return fetchJSON(url);
}

export async function getFireEvents(runDir = null, reportDate = null) {
  const params = new URLSearchParams();
  if (runDir) params.set('run_dir', runDir);
  if (reportDate) params.set('report_date', reportDate);
  const qs = params.toString();
  return fetchJSON(`${BASE}/fire-events${qs ? '?' + qs : ''}`);
}

// In-memory cache for historical fire-event detail payloads.
// Keyed by "reportDate:eventId"; only used when reportDate is present
// (historical bundles are immutable so no TTL/invalidation needed).
const _fireDetailCache = new Map();

export async function getFireEventDetail(eventId, runDir = null, reportDate = null) {
  const cacheKey = reportDate && !runDir ? `${reportDate}:${eventId}` : null;
  if (cacheKey) {
    const cached = _fireDetailCache.get(cacheKey);
    if (cached) return cached;
  }
  const params = new URLSearchParams();
  if (runDir) params.set('run_dir', runDir);
  if (reportDate) params.set('report_date', reportDate);
  const qs = params.toString();
  const result = await fetchJSON(`${BASE}/fire-events/${encodeURIComponent(eventId)}${qs ? '?' + qs : ''}`);
  if (cacheKey) _fireDetailCache.set(cacheKey, result);
  return result;
}

export async function getHotspots({ eventId, timeMin, timeMax, runDir, reportDate } = {}) {
  const params = new URLSearchParams();
  if (eventId != null) params.set('event_id', eventId);
  if (timeMin) params.set('time_min', timeMin);
  if (timeMax) params.set('time_max', timeMax);
  if (runDir) params.set('run_dir', runDir);
  if (reportDate) params.set('report_date', reportDate);
  const qs = params.toString();
  return fetchJSON(`${BASE}/hotspots${qs ? '?' + qs : ''}`);
}

export async function getTimeRange(runDir = null, reportDate = null) {
  const params = new URLSearchParams();
  if (runDir) params.set('run_dir', runDir);
  if (reportDate) params.set('report_date', reportDate);
  const qs = params.toString();
  return fetchJSON(`${BASE}/time-range${qs ? '?' + qs : ''}`);
}

// ---------------------------------------------------------------------------
// Real-time endpoints
// ---------------------------------------------------------------------------

export async function getRealtimeProducts() {
  return fetchJSON(`${BASE}/realtime/products`);
}

export async function getRealtimeEvents(startUtc = null, endUtc = null) {
  const params = new URLSearchParams();
  if (startUtc) params.set('start_utc', startUtc);
  if (endUtc) params.set('end_utc', endUtc);
  const qs = params.toString();
  return fetchJSON(`${BASE}/realtime/events${qs ? '?' + qs : ''}`);
}

export async function getRealtimeIgnitions(startUtc = null, endUtc = null) {
  const params = new URLSearchParams();
  if (startUtc) params.set('start_utc', startUtc);
  if (endUtc) params.set('end_utc', endUtc);
  const qs = params.toString();
  return fetchJSON(`${BASE}/realtime/ignitions${qs ? '?' + qs : ''}`);
}

export async function getRealtimeHotspots(productIds = ['bright_ahi'], asPolygons = false, hours = 12) {
  const params = new URLSearchParams();
  params.set('products', productIds.join(','));
  if (asPolygons) params.set('as_polygons', 'true');
  params.set('hours', String(hours));
  return fetchJSON(`${BASE}/realtime/hotspots?${params.toString()}`);
}

export async function getRealtimeStatus() {
  return fetchJSON(`${BASE}/realtime/status`);
}

// ---------------------------------------------------------------------------
// DEA overlay layers
// ---------------------------------------------------------------------------

export async function getDeaLayers() {
  return fetchJSON(`${BASE}/dea-layers`);
}

export async function getDeaCacheStats() {
  return fetchJSON(`${BASE}/dea-cache/stats`);
}

// ---------------------------------------------------------------------------
// External Fire Intelligence / Fire Fighting Resources layers
// ---------------------------------------------------------------------------

export async function getBushfireExtents() {
  return fetchJSON(`${BASE}/external-layers/bushfire-extents`);
}

export async function getRfsFacilities() {
  return fetchJSON(`${BASE}/external-layers/rfs-facilities`);
}

export async function getNpwsFireHistory(fireYear = 202526) {
  const params = new URLSearchParams();
  params.set('fire_year', String(fireYear));
  return fetchJSON(`${BASE}/external-layers/npws-fire-history?${params.toString()}`);
}

// ---------------------------------------------------------------------------
// NSW LGA boundaries
// ---------------------------------------------------------------------------

export async function getLgaBoundaries() {
  return fetchJSON(`${BASE}/lga`);
}

// ---------------------------------------------------------------------------
// Inferno fire simulation (v2 — async with progress)
// ---------------------------------------------------------------------------

export async function startSimulation(body) {
  if (STATIC_MODE) {
    throw new Error('Fire simulation is disabled in the static archive.');
  }
  const res = await fetch(`${BASE}/simulation/start`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw await buildApiError(res);
  }
  return res.json();
}

export async function getSimulationProgress(runId) {
  return fetchJSON(`${BASE}/simulation/progress/${encodeURIComponent(runId)}`);
}

export async function getSimulationResults(runId, options = {}) {
  const url = buildQuery(`${BASE}/simulation/results/${encodeURIComponent(runId)}`, {
    include: options.include,
    allow_incomplete: options.allowIncomplete ? 'true' : null,
  });
  return fetchJSON(url);
}

export async function checkSimulationHealth() {
  return fetchJSON(`${BASE}/simulation/health`);
}

export async function getSavedSimulationRuns(params = {}) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      search.set(key, String(value));
    }
  });
  const qs = search.toString();
  return fetchJSON(`${BASE}/simulation/saved-runs${qs ? `?${qs}` : ''}`);
}

export async function getSavedSimulationRun(runId, options = {}) {
  const url = buildQuery(`${BASE}/simulation/saved-runs/${encodeURIComponent(runId)}`, {
    include: options.include,
  });
  return fetchJSON(url);
}

// ---------------------------------------------------------------------------
// LGA Target Areas + Search/Bundle
// ---------------------------------------------------------------------------

export async function getLgaTargetAreas() {
  return fetchJSON(`${BASE}/lga/target-areas`);
}

export async function getHighlightedLgas(reportDate) {
  const params = new URLSearchParams();
  if (reportDate) params.set('report_date', reportDate);
  const query = params.toString();
  return fetchJSON(`${BASE}/lga/highlighted${query ? `?${query}` : ''}`);
}

export async function getSearchPreview({ mode, lgaName, bbox, startUtc, endUtc }) {
  const params = new URLSearchParams();
  params.set('mode', mode);
  if (lgaName) params.set('lga_name', lgaName);
  if (bbox) params.set('bbox', bbox.join(','));
  if (startUtc) params.set('start_utc', startUtc);
  if (endUtc) params.set('end_utc', endUtc);
  return fetchJSON(`${BASE}/search/preview?${params.toString()}`);
}

export async function downloadSearchBundle(body) {
  if (STATIC_MODE) {
    throw new Error('Search bundle download is disabled in the static archive.');
  }
  const res = await fetch(`${BASE}/search/bundle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw await buildApiError(res);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="?([^"]+)"?/);
  const filename = match ? match[1] : 'search_bundle.zip';
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  return filename;
}
