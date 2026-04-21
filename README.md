# redbackfire-static

Static archive of the **Team Redback** fire-intelligence dashboard for the XPRIZE Wildfire Track B final competition held in NSW, Australia from 7 to 20 April 2026. This repo keeps the public-facing site alive after the competition by replacing live backend calls with frozen fixtures and deploying a static build to GitHub Pages under `redbackfire.org`.

Contact: simon.jones@rmit.edu.au

## Layout

```
web/frontend/              React + Vite SPA (the only thing that ships)
  public/static-api/       Frozen JSON fixtures captured from the live backend
  .env.example             Non-secret local env template
  public/CNAME             Custom domain for GitHub Pages
  src/staticApi.js         URL → fixture / stub router used in static mode
scripts/freeze-static-api.mjs
                           One-shot capture script (Node 20). Pointed at a
                           running local copy of the original FastAPI backend.
.github/workflows/pages.yml
                           Builds the frontend and deploys to GitHub Pages.
```

## Local development

```bash
cd web/frontend
npm ci
npm run dev
# http://localhost:5173
```

Static mode is on by default in both `.env` and `.env.production`. Put a URL-restricted Mapbox token in `.env.local` for local map rendering:

```bash
cp .env.example .env.local
# then set VITE_MAPBOX_TOKEN in .env.local
```

Important: `npm run preview` serves the already-built `dist/` bundle. If you add or change `.env.local`, rerun `npm run build` before starting preview so the token is baked into the production assets.

The archive banner reads `VITE_ARCHIVE_REPORT_DATE`, so update that value when you freeze a different day.

## Build

```bash
cd web/frontend
npm run build
# dist/ ready for any static host
```

## Deploy

`main` branch pushes trigger `.github/workflows/pages.yml`, which builds `web/frontend` and publishes `dist/` to GitHub Pages using the `actions/deploy-pages` artifact flow. Custom domain is wired via `web/frontend/public/CNAME` + Cloudflare DNS.

Required repo secret: `VITE_MAPBOX_TOKEN` (Mapbox public token, URL-restricted to `redbackfire.org`, `www.redbackfire.org`, `<owner>.github.io`, and local preview origins if needed).

Full operator runbook: [docs/static-archive-deployment.md](docs/static-archive-deployment.md).

## Re-freezing the fixtures

If the upstream monorepo's backend is still available, run it locally against a historical bundle directory and re-capture:

```bash
# In the backend repo:
cd web/backend && uvicorn main:app --port 8000
# In this repo:
node scripts/freeze-static-api.mjs --backend http://localhost:8000 \
  --out web/frontend/public/static-api --report-date 2026-04-09
```

The script is idempotent and overwrites only the files it captures. It also writes `public/static-api/archive-manifest.json` with freeze provenance and object counts.

If you have an internal historical bundle and saved-simulations export already staged locally, you can also point the freezer at those directories with `--historical-bundle-dir` and `--saved-simulations-dir` instead of depending on the live site.

## What's disabled in static mode

- Password gate (removed).
- Live satellite polling (realtime/historical/external-layers served from frozen JSON).
- Inferno fire simulation launch (saved runs still browsable).
- Custom search bundle download.
- OpenWeather weather overlay.
- DEA tile overlay (panel renders empty).

All other UI — Mapbox basemap, layer toggles, historical hotspots, pre-computed simulations, NSW LGA overlays, time slider, map navigation — remains interactive.
