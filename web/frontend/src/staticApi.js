/**
 * Static-mode API router.
 *
 * When VITE_STATIC_MODE is 'true' the api.js fetchJSON wrapper delegates to
 * resolveStatic() below, which maps /api/* request paths to either
 *   - a JSON file under public/static-api/, or
 *   - an inline stub response.
 *
 * Fixtures are captured by scripts/freeze-static-api.mjs. Keep the route
 * table in sync with that script.
 */

const STATIC_BASE = `${import.meta.env.BASE_URL}static-api`;

const ROUTES = [
  { re: /^\/api\/status$/,                         file: 'status.json' },

  { re: /^\/api\/historical\/dates$/,              file: 'historical/dates.json' },
  { re: /^\/api\/historical\/day$/,                file: 'historical/day.json' },
  {
    re: /^\/api\/historical\/simulations\/([^/?]+)$/,
    file: (m) => `historical/simulations/${m[1]}.json`,
  },

  { re: /^\/api\/fire-events$/,                    file: 'fire-events.json' },
  {
    re: /^\/api\/fire-events\/([^/?]+)$/,
    file: (m) => `fire-events/${m[1]}.json`,
  },
  { re: /^\/api\/hotspots$/,                       file: 'hotspots.json' },
  { re: /^\/api\/time-range$/,                     file: 'time-range.json' },

  { re: /^\/api\/realtime\/products$/,             file: 'realtime/products.json' },
  { re: /^\/api\/realtime\/events$/,               file: 'realtime/events.json' },
  { re: /^\/api\/realtime\/ignitions$/,            file: 'realtime/ignitions.json' },
  { re: /^\/api\/realtime\/hotspots$/,             file: 'realtime/hotspots.json' },
  { re: /^\/api\/realtime\/status$/,               file: 'realtime/status.json' },

  { re: /^\/api\/dea-layers$/,                     stub: { layers: [] } },
  { re: /^\/api\/dea-cache\/stats$/,               stub: {} },

  { re: /^\/api\/external-layers\/bushfire-extents$/,
    file: 'external-layers/bushfire-extents.json' },
  { re: /^\/api\/external-layers\/rfs-facilities$/,
    file: 'external-layers/rfs-facilities.json' },
  { re: /^\/api\/external-layers\/npws-fire-history$/,
    file: 'external-layers/npws-fire-history.json' },

  { re: /^\/api\/lga$/,                            file: 'lga.json' },
  { re: /^\/api\/lga\/target-areas$/,              file: 'lga/target-areas.json' },
  { re: /^\/api\/lga\/highlighted$/,               file: 'lga/highlighted.json' },

  { re: /^\/api\/search\/preview$/,
    stub: { count: 0, features: [], message: 'Search disabled in static archive.' } },

  { re: /^\/api\/simulation\/health$/,             stub: { status: 'disabled' } },
  {
    re: /^\/api\/simulation\/saved-runs\/([^/?]+)$/,
    file: (m) => `simulation/saved-runs/${m[1]}.json`,
  },
  { re: /^\/api\/simulation\/saved-runs(?:\?|$)/,  file: 'simulation/saved-runs.json' },
];

export function resolveStatic(pathWithQuery) {
  const path = pathWithQuery.split('?')[0];
  for (const r of ROUTES) {
    const m = pathWithQuery.match(r.re) || path.match(r.re);
    if (!m) continue;
    if (r.stub !== undefined) return { kind: 'stub', body: r.stub };
    const file = typeof r.file === 'function' ? r.file(m) : r.file;
    return { kind: 'file', url: `${STATIC_BASE}/${file}` };
  }
  return { kind: 'miss' };
}
