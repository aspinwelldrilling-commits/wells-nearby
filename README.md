# Wells Nearby (static site)

Mobile web app: gets GPS (or manual lat/lon / map tap), queries CA DWR Well Completion Reports
and San Diego County DEHQ water-well permits within a radius, flags duplicates between them, and shows
depth/yield/SWL/year stats, drilling-method breakdown, satellite map and table (Data: State / County / Both).

Sources (both queried live from the browser, CORS OK):
- State: DWR OSWCR `.../Environment/i07_WellCompletionReports/MapServer/0` (ArcGIS Online proxy), fallback CNRA CKAN datastore.
- County: `https://gis-public.sandiegocounty.gov/arcgis/rest/services/DPLU/DPLU_Map/MapServer/100`
  ("Unincorporated LWQD Well Permits (DEH)"), parcel-center points, no depth/yield/SWL — those come from matched WCRs.

- `index.html`, `css/app.css`, `js/config.js` (endpoints, field map, method rules, filters, table columns),
  `js/data.js` (query + normalize), `js/stats.js` (summaries), `js/match.js` (county↔state duplicate matching, State/County/Both views), `js/app.js` (UI), `vendor/leaflet/` (Leaflet 1.9.4).
- Link params: `?lat=33.0417&lon=-116.8681&r=1&view=both&all=1`
- Test: `node tools/test-query.mjs [lat lon r] [--ckan] [--all] [--pairs]`;
  screenshot: `/workspace/.venv-pw/bin/python tools/screenshot.py [lat lon out.png]`
- Add a field: add it to `fieldMap` in both sources in `config.js`, then to `tableColumns` / `wellDetails()`.
- Geolocation requires HTTPS (or localhost) — host on GitHub Pages / Netlify / Cloudflare Pages.
