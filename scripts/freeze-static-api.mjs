#!/usr/bin/env node
/**
 * freeze-static-api.mjs
 *
 * Captures every /api/* response the static archive needs from a running
 * Team Redback backend (local uvicorn OR the still-live production server)
 * and writes them as JSON files under web/frontend/public/static-api/.
 *
 * Usage:
 *   node scripts/freeze-static-api.mjs \
 *     --backend https://redbackfire.org \
 *     --out web/frontend/public/static-api \
 *     --report-date 2026-04-09
 *
 * Requires Node 20+ (uses global fetch).
 *
 * The script is idempotent. It mirrors the ROUTES table in
 * web/frontend/src/staticApi.js so anything the running frontend asks for
 * in static mode is produced here.
 */

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import process from 'node:process';

const OMITTED_JSON_KEYS = new Set([
  '_source_file',
]);

const REDACTED_JSON_KEYS = new Set([
  'archive_simulation_dir',
  'bucket',
  'bundled_dir',
  'directory',
  'historical_bundle_dir',
  'manifest_path',
  'prefix',
  'report_docx',
  'report_json',
  'report_md',
  'reported_hotspots_geojson',
  'reported_superclusters_geojson',
  'results_path',
  'root',
  's3_bucket',
  's3_profile',
  'saved_simulations_dir',
  'source_dir',
  'source_file',
  'xprize_detections_geojson',
  'xprize_polygons_geojson',
]);

const INTERNAL_VALUE_PATTERNS = [
  /^\/home\/ec2-user\//,
  /^\/opt\/bright\//,
  /^s3:\/\//,
  /^temp[\\/]/,
  /bright-nrt-kostas-dev-ls/i,
];

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv);
const BACKEND = (args.backend || 'http://localhost:8000').replace(/\/$/, '');
const OUT_DIR = args.out || 'web/frontend/public/static-api';
const REPORT_DATE = args['report-date'] || '2026-04-09';
const DAY_START_UTC = args['start-utc'] || `${REPORT_DATE}T00:00:00Z`;
const DAY_END_UTC = args['end-utc'] || `${REPORT_DATE}T23:59:59Z`;
const HISTORICAL_BUNDLE_DIR = args['historical-bundle-dir'] || '';
const SAVED_SIMULATIONS_DIR = args['saved-simulations-dir'] || '';
const GENERATED_AT = new Date().toISOString();
const DAY_START_MS = Date.parse(DAY_START_UTC);
const DAY_END_MS = Date.parse(DAY_END_UTC);

console.log(`Backend:      ${BACKEND}`);
console.log(`Output:       ${OUT_DIR}`);
console.log(`Report date:  ${REPORT_DATE}`);
if (HISTORICAL_BUNDLE_DIR) console.log(`Historical:   ${HISTORICAL_BUNDLE_DIR}`);
if (SAVED_SIMULATIONS_DIR) console.log(`Saved sims:   ${SAVED_SIMULATIONS_DIR}`);
console.log();

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function readJsonIfExists(path, label = path) {
  if (!(await pathExists(path))) return null;
  try {
    return await readJsonFile(path);
  } catch (err) {
    console.warn(`  SKIP  ${label}: ${err.message}`);
    return null;
  }
}

async function readDirectoryNames(path) {
  if (!(await pathExists(path))) return [];
  const entries = await readdir(path, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function listJsonFiles(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const fullPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      paths.push(...await listJsonFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.json')) {
      paths.push(fullPath);
    }
  }
  return paths;
}

function isoToMs(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isWithinArchiveWindow(value) {
  const timestamp = isoToMs(value);
  return timestamp != null && timestamp >= DAY_START_MS && timestamp <= DAY_END_MS;
}

function getSimulationAvailability(payload) {
  const results = payload?.results || {};
  return {
    variables: Boolean(results.variables),
    isochrones: Boolean(results.isochrones?.json),
    roads: Boolean(results.roads?.json),
    min_arrival_time: Boolean(results.min_arrival_time?.b64),
    max_intensity: Boolean(results.max_intensity?.b64),
  };
}

function sanitizeArchiveJson(value, key = '') {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeArchiveJson(item));
  }

  if (value && typeof value === 'object') {
    const sanitized = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      if (OMITTED_JSON_KEYS.has(childKey)) continue;
      if (REDACTED_JSON_KEYS.has(childKey)) {
        sanitized[childKey] = null;
        continue;
      }
      sanitized[childKey] = sanitizeArchiveJson(childValue, childKey);
    }
    return sanitized;
  }

  if (typeof value === 'string') {
    if (key === 'backend') return value;
    if (value === 'lightsail') return null;
    if (INTERNAL_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
      return null;
    }
  }

  return value;
}

function inferHistoricalSimulationId(entry = {}) {
  const candidates = [
    entry.simulation_id,
    entry.bundled_dir,
    entry.source_dir,
    entry.saved_simulations_dir,
    entry.archive_simulation_dir,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const value = String(candidate).trim().split('/').filter(Boolean).at(-1);
    if (value) return value;
  }
  return null;
}

function mergeSavedSimulationPayload(runId, manifest = {}, results = {}) {
  const payload = {
    ...results,
    run_id: results.run_id || manifest.run_id || runId,
    status: results.status || manifest.status || 'complete',
    saved_at: results.saved_at || manifest.saved_at || null,
    startDateTime: results.startDateTime || manifest.startDateTime || null,
    lat: results.lat ?? manifest.lat ?? null,
    lng: results.lng ?? manifest.lng ?? null,
    ignition_points: results.ignition_points || manifest.ignition_points || [],
    source: {
      ...(manifest.source || {}),
      ...(results.source || {}),
    },
    summary: {
      ...(manifest.summary || {}),
      ...(results.summary || {}),
    },
    persistence: {
      ...(manifest.persistence || {}),
      ...(results.persistence || {}),
    },
    results: results.results || {},
  };
  payload.available_results = getSimulationAvailability(payload);
  return payload;
}

async function buildHistoricalSimulationPayload(entry, dayBody) {
  if (!HISTORICAL_BUNDLE_DIR) return null;
  const simulationId = inferHistoricalSimulationId(entry);
  if (!simulationId) return null;

  const simulationDir = join(HISTORICAL_BUNDLE_DIR, 'simulations', simulationId);
  if (!(await pathExists(simulationDir))) {
    console.warn(`  SKIP  historical/simulations/${simulationId}: bundle directory missing`);
    return null;
  }

  const [isochrones, roads, ignitionDelta] = await Promise.all([
    readJsonIfExists(join(simulationDir, 'isochrones.geojson'), `historical/simulations/${simulationId}/isochrones`),
    readJsonIfExists(join(simulationDir, 'roads.geojson'), `historical/simulations/${simulationId}/roads`),
    readJsonIfExists(join(simulationDir, 'ignition_delta.json'), `historical/simulations/${simulationId}/ignition_delta`),
  ]);

  const results = {};
  if (isochrones?.features?.length) results.isochrones = { json: isochrones };
  if (roads?.features?.length) results.roads = { json: roads };
  if (Object.keys(results).length === 0) {
    console.warn(`  SKIP  historical/simulations/${simulationId}: no renderable layers`);
    return null;
  }

  const metadataWindow = dayBody?.metadata?.window || dayBody?.window || {};
  const lat = ignitionDelta?.dispatched?.lat ?? entry?.ignition_lat ?? null;
  const lng = ignitionDelta?.dispatched?.lng ?? entry?.ignition_lon ?? null;
  const ignitionDatetime = ignitionDelta?.first_hotspot_time ?? entry?.ignition_datetime ?? null;
  const payload = {
    run_id: simulationId,
    status: 'complete',
    lat,
    lng,
    ignition_points: lat != null && lng != null
      ? [{ lat, lng, id: ignitionDelta?.stable_id ?? simulationId, datetime: ignitionDatetime }]
      : [],
    startDateTime: metadataWindow.local_start_iso || DAY_START_UTC,
    results,
    summary: {
      area_sim: null,
      area_high_intensity: null,
      has_isochrones: Boolean(results.isochrones),
      has_roads: Boolean(results.roads),
      has_arrival_time: false,
      has_intensity: false,
    },
    source: {
      mode: 'historical_bundle',
      report_date: REPORT_DATE,
      source_simulation_id: simulationId,
      source_dir: entry?.source_dir || null,
      source_supercluster_id: entry?.stable_id != null ? String(entry.stable_id) : null,
      coord_translation: null,
      ignition_source: ignitionDelta?.source || (lat != null && lng != null ? 'bundle_manifest' : null),
    },
    persistence: {
      local: {
        status: 'bundle',
        directory: simulationDir,
      },
    },
  };
  payload.available_results = getSimulationAvailability(payload);
  return payload;
}

async function buildHistoricalSimulationFixtures(dayBody) {
  if (!HISTORICAL_BUNDLE_DIR) return { count: 0, ids: [] };
  const entries = Array.isArray(dayBody?.simulations)
    ? dayBody.simulations
    : Array.isArray(dayBody?.simulations?.bundled)
      ? dayBody.simulations.bundled
      : [];
  let written = 0;
  const writtenIds = [];
  for (const entry of entries) {
    const simulationId = inferHistoricalSimulationId(entry);
    if (!simulationId) continue;
    const payload = await buildHistoricalSimulationPayload(entry, dayBody);
    if (!payload) continue;
    await write(`historical/simulations/${simulationId}.json`, payload);
    written += 1;
    writtenIds.push(simulationId);
  }
  return { count: written, ids: writtenIds };
}

async function buildSavedRunFixturesFromDirectory() {
  if (!SAVED_SIMULATIONS_DIR) return { runCount: 0, detailCount: 0 };
  const runIds = await readDirectoryNames(SAVED_SIMULATIONS_DIR);
  const manifests = [];
  let detailCount = 0;
  for (const runId of runIds) {
    const runDir = join(SAVED_SIMULATIONS_DIR, runId);
    const manifest = await readJsonIfExists(join(runDir, 'manifest.json'), `saved-runs/${runId}/manifest`);
    const results = await readJsonIfExists(join(runDir, 'results.json'), `saved-runs/${runId}/results`);
    if (!manifest || !results) continue;

    const merged = mergeSavedSimulationPayload(runId, manifest, results);
    if (!isWithinArchiveWindow(merged.startDateTime)) continue;

    manifests.push({
      ...(manifest || {}),
      run_id: merged.run_id,
      status: merged.status,
      saved_at: merged.saved_at,
      startDateTime: merged.startDateTime,
      lat: merged.lat,
      lng: merged.lng,
      ignition_points: merged.ignition_points,
      source: merged.source,
      summary: merged.summary,
      persistence: merged.persistence,
    });
    await write(`simulation/saved-runs/${merged.run_id}.json`, merged);
    detailCount += 1;
  }

  manifests.sort((left, right) => String(right.saved_at || '').localeCompare(String(left.saved_at || '')));
  await write('simulation/saved-runs.json', {
    runs: manifests,
    diagnostics: {
      returned: manifests.length,
      total: manifests.length,
      source: 'local_saved_simulations_dir',
      root: SAVED_SIMULATIONS_DIR,
    },
  });
  return { runCount: manifests.length, detailCount };
}

async function runWithConcurrency(items, limit, worker) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(workers);
}

async function getJSON(path) {
  const url = path.startsWith('http') ? path : `${BACKEND}${path}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function write(relPath, body) {
  const full = join(OUT_DIR, relPath);
  const sanitizedBody = sanitizeArchiveJson(body);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, JSON.stringify(sanitizedBody));
  console.log(`  wrote ${relPath}  (${JSON.stringify(sanitizedBody).length.toLocaleString()} bytes)`);
}

async function sanitizeExistingArchiveFiles() {
  if (!(await pathExists(OUT_DIR))) {
    console.warn(`Archive output directory not found: ${OUT_DIR}`);
    return;
  }

  const jsonFiles = await listJsonFiles(OUT_DIR);
  let updated = 0;
  for (const filePath of jsonFiles) {
    const originalText = await readFile(filePath, 'utf8');
    const originalBody = JSON.parse(originalText);
    const sanitizedBody = sanitizeArchiveJson(originalBody);
    const sanitizedText = JSON.stringify(sanitizedBody);
    if (sanitizedText === originalText) continue;
    await writeFile(filePath, sanitizedText);
    updated += 1;
  }

  console.log(`Sanitized ${updated} JSON file(s) under ${OUT_DIR}`);
}

async function capture(label, apiPath, outRelPath) {
  try {
    const body = await getJSON(apiPath);
    await write(outRelPath, body);
    return body;
  } catch (err) {
    console.warn(`  SKIP  ${label}: ${err.message}`);
    return null;
  }
}

if (args['sanitize-only']) {
  await sanitizeExistingArchiveFiles();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Single-shot endpoints
// ---------------------------------------------------------------------------

console.log('== root endpoints ==');
await capture('status',                    '/api/status',                     'status.json');
await capture('realtime/products',         '/api/realtime/products',          'realtime/products.json');
await capture('realtime/status',           '/api/realtime/status',            'realtime/status.json');
await capture('lga',                       '/api/lga',                        'lga.json');
await capture('lga/target-areas',          '/api/lga/target-areas',           'lga/target-areas.json');
await capture('lga/highlighted',           `/api/lga/highlighted?report_date=${REPORT_DATE}`,
                                           'lga/highlighted.json');

console.log('\n== external layers ==');
await capture('bushfire-extents',          '/api/external-layers/bushfire-extents',
                                           'external-layers/bushfire-extents.json');
await capture('rfs-facilities',            '/api/external-layers/rfs-facilities',
                                           'external-layers/rfs-facilities.json');
await capture('npws-fire-history',         '/api/external-layers/npws-fire-history?fire_year=202526',
                                           'external-layers/npws-fire-history.json');

// ---------------------------------------------------------------------------
// Historical day (the spine of the archive)
// ---------------------------------------------------------------------------

console.log('\n== historical day ==');
const datesBody = await capture('historical/dates', '/api/historical/dates', 'historical/dates.json');
// Narrow the list we ship to just the frozen date so the picker looks clean.
if (datesBody && Array.isArray(datesBody.dates)) {
  await write('historical/dates.json', { dates: [REPORT_DATE] });
}

let dayBody = await capture('historical/day',
                              `/api/historical/day?report_date=${REPORT_DATE}`,
                              'historical/day.json');

const fireEventsBody = await capture('fire-events',
              `/api/fire-events?report_date=${REPORT_DATE}`,
              'fire-events.json');

await capture('hotspots',
              `/api/hotspots?report_date=${REPORT_DATE}`,
              'hotspots.json');

await capture('time-range',
              `/api/time-range?report_date=${REPORT_DATE}`,
              'time-range.json');

// Fire-event detail per event
const fireEventIds = new Set();
for (const feature of fireEventsBody?.features || []) {
  const id = feature?.properties?.stable_id
    ?? feature?.properties?.cluster_id
    ?? feature?.properties?.event_id
    ?? feature?.properties?.fire_id
    ?? feature?.properties?.id
    ?? feature?.id;
  if (id != null) fireEventIds.add(String(id));
}

console.log(`\n== fire-events detail (${fireEventIds.size}) ==`);
let fireEventDetailCount = 0;
await runWithConcurrency(Array.from(fireEventIds), 6, async (id) => {
  const payload = await capture(`fire-events/${id}`,
                `/api/fire-events/${encodeURIComponent(id)}?report_date=${REPORT_DATE}`,
                `fire-events/${id}.json`);
  if (payload) fireEventDetailCount += 1;
});
console.log(`  wrote ${fireEventDetailCount} fire-event detail fixture(s)`);

// Historical simulations — enumerate from the day bundle
const bundledSimulations = Array.isArray(dayBody?.simulations)
  ? dayBody.simulations
  : Array.isArray(dayBody?.simulations?.bundled)
    ? dayBody.simulations.bundled
    : [];
const simulationIds = new Set();
for (const simulation of bundledSimulations) {
  const id = inferHistoricalSimulationId(simulation) ?? simulation?.stable_id ?? simulation?.id;
  if (id != null) simulationIds.add(String(id));
}
console.log(`\n== historical/simulations (${simulationIds.size}) ==`);
let historicalSimulationFixtureCount = 0;
if (HISTORICAL_BUNDLE_DIR) {
  const historicalSimulationStats = await buildHistoricalSimulationFixtures(dayBody);
  historicalSimulationFixtureCount = historicalSimulationStats.count;
  if (Array.isArray(dayBody?.simulations?.bundled)) {
    const keptIds = new Set(historicalSimulationStats.ids);
    const filteredBundled = dayBody.simulations.bundled.filter((entry) => keptIds.has(inferHistoricalSimulationId(entry)));
    dayBody = {
      ...dayBody,
      metadata: {
        ...(dayBody.metadata || {}),
        available_layers: {
          ...((dayBody.metadata || {}).available_layers || {}),
          simulations: filteredBundled.length,
        },
      },
      simulations: {
        ...(dayBody.simulations || {}),
        bundled: filteredBundled,
      },
    };
    await write('historical/day.json', dayBody);
  }
  console.log(`  wrote ${historicalSimulationFixtureCount} historical simulation fixture(s) from bundle dir`);
} else {
  for (const id of simulationIds) {
    const payload = await capture(`historical/simulations/${id}`,
                  `/api/historical/simulations/${encodeURIComponent(id)}?report_date=${REPORT_DATE}&include=variables&include=isochrones&include=roads&include=arrival_time&include=intensity`,
                  `historical/simulations/${id}.json`);
    if (payload) historicalSimulationFixtureCount += 1;
  }
}

// ---------------------------------------------------------------------------
// Realtime endpoints — scoped to the frozen day so the tab has content
// ---------------------------------------------------------------------------

console.log('\n== realtime (scoped to frozen day) ==');
await capture('realtime/events',
              `/api/realtime/events?start_utc=${encodeURIComponent(DAY_START_UTC)}&end_utc=${encodeURIComponent(DAY_END_UTC)}`,
              'realtime/events.json');
await capture('realtime/ignitions',
              `/api/realtime/ignitions?start_utc=${encodeURIComponent(DAY_START_UTC)}&end_utc=${encodeURIComponent(DAY_END_UTC)}`,
              'realtime/ignitions.json');
await capture('realtime/hotspots',
              '/api/realtime/hotspots?products=bright_ahi&hours=24',
              'realtime/hotspots.json');

// ---------------------------------------------------------------------------
// Saved simulations (browseable list + each detail)
// ---------------------------------------------------------------------------

console.log('\n== simulation/saved-runs ==');
let savedRunCount = 0;
let savedRunDetailCount = 0;
if (SAVED_SIMULATIONS_DIR) {
  const savedRunStats = await buildSavedRunFixturesFromDirectory();
  savedRunCount = savedRunStats.runCount;
  savedRunDetailCount = savedRunStats.detailCount;
  console.log(`  wrote ${savedRunDetailCount} saved simulation fixture(s) from local dir`);
} else {
  const savedList = await capture('simulation/saved-runs',
                `/api/simulation/saved-runs?start_after=${encodeURIComponent(DAY_START_UTC)}&start_before=${encodeURIComponent(DAY_END_UTC)}&limit=200`,
                'simulation/saved-runs.json');

  const savedIds = new Set();
  if (savedList) {
    const items = savedList.runs || savedList.items || savedList.results || [];
    for (const run of items) {
      const id = run?.run_id ?? run?.id;
      if (id != null) savedIds.add(String(id));
    }
  }
  savedRunCount = savedIds.size;
  console.log(`  ${savedIds.size} saved runs`);
  for (const id of savedIds) {
    const payload = await capture(`simulation/saved-runs/${id}`,
                  `/api/simulation/saved-runs/${encodeURIComponent(id)}?include=variables&include=isochrones&include=roads&include=arrival_time&include=intensity`,
                  `simulation/saved-runs/${id}.json`);
    if (payload) savedRunDetailCount += 1;
  }
}

await write('archive-manifest.json', {
  archive_kind: 'team-redback-static-site',
  backend: BACKEND,
  report_date: REPORT_DATE,
  start_utc: DAY_START_UTC,
  end_utc: DAY_END_UTC,
  generated_at: GENERATED_AT,
  fire_event_count: fireEventIds.size,
  fire_event_detail_count: fireEventDetailCount,
  historical_simulation_count: historicalSimulationFixtureCount,
  saved_simulation_count: savedRunCount,
  saved_simulation_detail_count: savedRunDetailCount,
  sources: {
    historical_bundle_dir: HISTORICAL_BUNDLE_DIR || null,
    saved_simulations_dir: SAVED_SIMULATIONS_DIR || null,
  },
});

console.log('\nDone.');
