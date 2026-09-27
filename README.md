# Wells Nearby (static site)

Mobile web app: gets GPS (or manual lat/lon / map tap), queries CA DWR Well Completion Reports
within a radius, shows depth/yield/SWL/year stats, drilling-method breakdown, satellite map and table.

- `index.html`, `css/app.css`, `js/config.js` (endpoints, field map, method rules, filters, table columns),
  `js/data.js` (query + normalize), `js/stats.js` (summaries), `js/app.js` (UI), `vendor/leaflet/` (Leaflet 1.9.4).
- Link params: `?lat=33.0417&lon=-116.8681&r=1&all=1`
- Test: `node tools/test-query.mjs [lat lon r] [--ckan] [--all]`;
  screenshot: `/workspace/.venv-pw/bin/python tools/screenshot.py [lat lon out.png]`
- Add a field: add it to `fieldMap` in both sources in `config.js`, then to `tableColumns` / `wellDetails()`.
- Geolocation requires HTTPS (or localhost) — host on GitHub Pages / Netlify / Cloudflare Pages.
