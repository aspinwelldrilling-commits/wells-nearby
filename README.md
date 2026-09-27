# Wells Nearby (static site)

Mobile web app: gets GPS (or manual lat/lon / map tap), queries CA DWR Well Completion Reports
and San Diego County DEHQ water-well permits within a radius, flags duplicates between them, and shows
depth/yield/SWL/year stats, drilling-method breakdown, satellite map and table (Data: State / County / Both).

Sources (both queried live from the browser, CORS OK):
- State: DWR OSWCR `.../Environment/i07_WellCompletionReports/MapServer/0` (ArcGIS Online proxy), fallback CNRA CKAN datastore.
- County: `https://gis-public.sandiegocounty.gov/arcgis/rest/services/DPLU/DPLU_Map/MapServer/100`
  ("Unincorporated LWQD Well Permits (DEH)"), parcel-center points, no depth/yield/SWL — those come from matched WCRs.

- County documents: popups list the well's scanned files from the DEHQ Environmental Health Document Library, fetched on
  popup open from `https://file.sandiegocounty.gov/CoSD_LUEG_Repository_External_API/rest/DEHQDocumentLibrary/SearchDocuments?record_id=…`
  (or `parcel_number=…`), CORS `*` only on uncached responses → a `ts=` cache-buster is added (as the county page does).
  Documents open in `https://file.sandiegocounty.gov/LUEG/LUEG_View?FileRecordId=…`. See `js/docs.js`.
- `index.html`, `css/app.css`, `js/config.js` (endpoints, field map, method rules, filters, table columns),
  `js/data.js` (query + normalize), `js/stats.js` (summaries), `js/match.js` (county↔state duplicate matching, State/County/Both views), `js/docs.js` (county document library), `js/app.js` (UI), `vendor/leaflet/` (Leaflet 1.9.4).
- Link params: `?lat=33.0417&lon=-116.8681&r=1&view=both&all=1` (`r` = slider value 0–1 mi, or 2/3/5 via "wider";
  `r=0` searches 0.05 mi internally; if nothing is that close it shows the nearest 3 wells within 0.5 mi).

## County WCR extraction (OCR cache)
County completion reports are scanned PDFs behind an OutSystems viewer (no direct PDF URL, no text layer on most), so they
are processed offline, per area, and cached in the repo:

    /workspace/.venv-pw/bin/python tools/extract_county_wcr.py --lat 33.0417 --lon -116.8681 --radius 1 --area ramona
    # options: --delay 2.5 (s between county requests)  --force (redo)  --limit N  --permits ID,ID  --reparse (no network)
    node tools/validate-county-wcr.mjs      # status counts, accuracy vs matched state WCRs
    git add data/county-wcr && git commit -m "WCR cache: <area>" && git push

- Per permit: find docs (DEHQ library) → download likely WCR docs via headless viewer → pdftotext (generated PDFs) or
  tesseract 300 dpi (typed scans) → regex fields (depth, method, GPM, SWL, date ended, decimal lat/long) with per-field
  confidence (tesseract word confidence: high ≥80, medium ≥50, low). Output `data/county-wcr/<PERMIT>.json` + `index.json`.
- Status: `readable` / `partial` / `unreadable` (handwritten/garbled) / `no_wcr` / `no_docs` / `destruction_wcr` / `error`.
- App (`js/countywcr.js`): uses only high/medium values from records classified `readable` (partial = mostly handwriting,
  shown only as "unverified" hints in the red popup), within plausible bounds, only to fill fields the state record
  lacks (tagged "OCR"); checks agreement where the state has the value. GPS from a WCR is used only if within 1 mi of the parcel.
  Red (#FF1744) = county permit with no usable log data from state or OCR → "Read this report yourself" link to the most
  likely doc page. Grey dashed = not yet processed (link to doc list).
- Test: `node tools/test-query.mjs [lat lon r] [--ckan] [--all] [--pairs]`;
  screenshot: `/workspace/.venv-pw/bin/python tools/screenshot.py [lat lon out.png]`
- Add a field: add it to `fieldMap` in both sources in `config.js`, then to `tableColumns` / `wellDetails()`.
- Geolocation requires HTTPS (or localhost) — host on GitHub Pages / Netlify / Cloudflare Pages.
