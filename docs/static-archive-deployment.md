# Static Archive Deployment

## Goal

Keep `redbackfire.org` online as a polished static archive of the Team Redback site after the competition servers are retired.

This repo is the deploy target. It serves one frozen competition day through GitHub Pages and keeps the existing map-led UI as close as possible to the live site while removing server-side dependencies.

## Git Workflow

1. Create feature branch from `main`.
2. Freeze or refresh fixtures in that branch.
3. Run local build and smoke test.
4. Open PR into `main`.
5. Merge after review.
6. Let `.github/workflows/pages.yml` deploy `main` to GitHub Pages.

Recommended branch names:

- `feat/static-archive-copy`
- `feat/archive-refresh-2026-04-09`
- `fix/github-pages-cutover`

## Freeze Workflow

Run backend locally from source monorepo or point at still-live production site:

```bash
# source monorepo
cd web/backend
uvicorn main:app --port 8000

# static archive repo
node scripts/freeze-static-api.mjs \
  --backend http://localhost:8000 \
  --out web/frontend/public/static-api \
  --report-date 2026-04-09
```

Outputs:

- `web/frontend/public/static-api/*.json`
- `web/frontend/public/static-api/archive-manifest.json`

If you already have an internal historical bundle and saved-simulations export staged locally, point the freezer at those directories with `--historical-bundle-dir` and `--saved-simulations-dir`.

After freezing a different day, update:

- `web/frontend/.env`
- `web/frontend/.env.production`
- optional local overrides in `.env.local`

Set `VITE_ARCHIVE_REPORT_DATE` to match frozen fixtures.

## Local Verification

```bash
cd web/frontend
npm ci
cp .env.example .env.local
# set VITE_MAPBOX_TOKEN in .env.local
npm run build
npm run preview
```

Check:

- archive banner wording and date
- no password gate
- hotspots and fire events load from `static-api/`
- saved simulations load
- no calls to legacy `/api` backend
- no OpenWeather requests

## GitHub Pages

Repository settings:

1. `Settings -> Pages`
2. Source: `GitHub Actions`
3. Custom domain: `redbackfire.org`
4. Enforce HTTPS after certificate issues successfully

Required repository secret:

- `VITE_MAPBOX_TOKEN`

The Pages workflow already:

- builds with `VITE_STATIC_MODE=true`
- injects `VITE_MAPBOX_TOKEN`
- copies `public/CNAME`
- writes `404.html` SPA fallback

## Cloudflare Cutover

Use apex `redbackfire.org` as primary URL.

Before editing DNS:

1. Remove or disable old redirects and origin records that still point to the retired host.
2. Confirm GitHub Pages custom domain is configured.

Recommended DNS records for apex GitHub Pages hosting:

- `A  redbackfire.org  185.199.108.153`
- `A  redbackfire.org  185.199.109.153`
- `A  redbackfire.org  185.199.110.153`
- `A  redbackfire.org  185.199.111.153`
- optional `AAAA` records per GitHub Pages documentation
- `CNAME  www  <owner>.github.io`

Cloudflare steps:

1. Set apex GitHub Pages records to `DNS only` during certificate provisioning.
2. Add redirect rule from `www.redbackfire.org/*` to `https://redbackfire.org/$1`.
3. Verify `https://redbackfire.org` serves GitHub Pages content.
4. Re-enable proxy only if needed after TLS is stable.

## Mapbox Allowlist

Allow these origins in Mapbox token settings:

- `https://redbackfire.org/*`
- `https://www.redbackfire.org/*`
- `https://<owner>.github.io/*`
- `http://localhost:5173/*`

If GitHub Pages preview or Cloudflare staging uses another hostname, add that too before testing.

## Missing Considerations

1. Confirm committed `.env` files are blank and real tokens exist only in `.env.local` or GitHub repository secrets.
2. Keep a copy of frozen fixture source data and `archive-manifest.json` outside GitHub Pages.
3. Confirm `robots.txt` policy matches public discoverability intent.
4. Decide whether archived realtime tab is acceptable UX or should be hidden to avoid confusion.
5. Keep at least one offline copy of `dist/` and fixture JSON before shutting old infrastructure down.