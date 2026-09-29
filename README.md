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

- **Whole county (spiral from Ramona):** `tools/build_spiral_plan.py` assigns every non-destruction county permit to the nearest
  of 45 named areas, ringed outward from Ramona → `tools/spiral_plan.json`. `tools/spiral_run.py` works through it in order,
  resumable (cached permits skipped), and every 150 permits runs `tools/verify_wcr_area.py` (headless 412×915 phone check of a
  sample: readable → "county WCR (OCR)" tags, unreadable → red pin + "Read this report yourself" link), commits, pushes, and
  waits for the live Pages index. Progress table: `tools/spiral_plan.md`. Run/resume:
  `setsid nohup /workspace/.venv-pw/bin/python tools/spiral_run.py --push >> /workspace/wells-state/spiral.out 2>&1 < /dev/null &` ·
  log `/workspace/wells-state/spiral.log` (state lives outside the repo so it survives `.cache` loss / git clean) ·
  status: `… tools/spiral_run.py --status` · stop: `kill -- -<PID>` (process group; the current permit is redone on resume).
  Safety (after the Sep 28 2026 incident, when tesseract vanished on a box restart and ~1,500 permits were silently
  marked no_wcr): the extractor refuses to run without its OCR tools (exit 4; the runner auto-installs them with sudo),
  classifies read/viewer/search failures as `error` (retried, max 2) instead of `no_wcr`, the runner re-does errored or
  misclassified permits first (REPAIR phase), and a batch with >75% no_wcr (baseline ~40%) is not pushed and stops the run.
- Per permit: find docs (DEHQ library) → download likely WCR docs via headless viewer → pdftotext (generated PDFs) or
  tesseract 300 dpi (typed scans) → regex fields (depth, method, GPM, SWL, date ended, decimal lat/long) with per-field
  confidence (tesseract word confidence: high ≥80, medium ≥50, low). Output `data/county-wcr/<PERMIT>.json` (incl. parcel point)
  + shards the app loads: `tiles/<iy>_<ix>.json` on a fixed 0.025° grid (tile = lat [iy·0.025, +0.025), lon [ix·0.025, +0.025),
  ≈1.7×1.45 mi, slim entries: status, value+conf per field, best doc link) and `manifest.json` (bounds `b` s,w,n,e, count `n`,
  content hash `h` per tile). The app (`CW.ensure`) fetches only tiles intersecting the search circle (radius + 0.75 mi buffer)
  as `tiles/<key>.json?v=<hash>`; the service worker keeps them for offline use. Test: `tools/test-shards.py [--base URL]`,
  bytes: `tools/measure_wcr_bytes.py [--base URL]`. `index.json` is now a tiny stub (the loader reads it only if there is no manifest).
- **Small checkable chunks (current mode):** `tools/spiral_run.py --push --chunk <file|ID,ID> --label "<name>"` redoes just those
  permits (--force, each keeps its area), verifies locally, commits, pushes, waits for the live site, re-checks live, and exits.
  Every start runs the OCR preflight + canary (`DEH1977-LWELL-5873` must yield WCR pages; PDF cached in the state dir).
  `--alarm 0.97` for rechecks of no_wcr records (a high no_wcr share is expected there). Spot-check afterwards:
  `tools/spotcheck_library.py --file <list> --n 30`.
- **APNs, exact matching, post-2020 permits:** the DEH library matches `record_id` and `parcel_number` as PREFIXES
  (`DEH1981-LWELL-997` also returns `…-9972`; `285-030-0` returns other parcels), so every lookup (extractor, `docs.js`,
  septic) filters to the exact permit / APN. APNs are always sent as `XXX-XXX-XX-XX` (`WellsDocs.apnFull`,
  `apn_dashed`); an 8-digit APN is searched as the `XXX-XXX-XX` prefix and filtered. The county GIS permit layer stops at
  Aug 2020, so newer wells exist only in the library: `--apns 285-030-06-00` processes every LWELL permit filed under an APN,
  `--library-parcels` (radius or corridor mode) scans every parcel in the area for such permits. They are stored with
  `libraryOnly`, `apn` and the parcel centre, and the tile entry gets `lib` so the app adds them as county permits. Corridor
  mode: `--corridor "lat,lon;lat,lon;…" --buffer 0.6` (permits within 0.6 mi of the polyline); `--list-only` prints the
  permit list. Several permits/WCRs on one APN are paired one-to-one first (`match.js`), so none is hidden.
- App "This parcel" card (under the summary): after every search, the parcel at the search point → all well permits filed
  under its APN in the DEH library (library-only ones are added to the map/table at the parcel centre) with their WCR status,
  plus the septic box (status layer + DEH septic records; "Septic on file" when the layer says Not known but OWTS records
  exist). Test: `tools/test-parcel-here.py [--base URL]` (default parcel 285-030-06-00); unit: `node tools/test-apn-match.mjs`.
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

## Property lines (parcel boundaries) — `js/parcels.js`
- "▦ Lines" button on the map, top-left under the zoom buttons. On → bright yellow parcel outlines + an opacity slider
  (0–100 %, step 5); both remembered on the device (localStorage `wellsNearby.parcels`). Off by default.
- Server-rendered: SanGIS/County `DPLU_Map/MapServer/export` (same "Assessor Parcels" layer 0 as the APN lookup) restyled
  via `dynamicLayers`, 512 px transparent PNG tiles (2× pixels on phones), in their own pane under the well pins.
  Shown from zoom 15 (the service only draws parcels below 1:36,000); a "zoom in" hint shows when zoomed out.
  Zoom ≥ 18: APN labels (layer 1, white/black halo). Zoom ≥ 16: tap the map → the tapped parcel's APN + acreage is added to
  the tap popup and its outline highlighted (cyan). Settings in `config.js` → `parcelLines`.
- Tiles are not cached by the service worker (county sends no-store; only useful online). Test: `tools/test-parcels.py [--base URL]`.

## Proposed well sites (field tagging) — `js/sites.js`
- "📌 Tag site" (bottom bar / top button): `watchPosition` high-accuracy, live ±ft, keeps the best fix for up to 30 s
  (green ≤16 ft, yellow ≤50 ft, red worse; "Capture anyway" always allowed; "place pin by hand" if no GPS).
  Pin is draggable; a hand adjustment is recorded (`adjusted`, `adjustedFt`, original fix kept in `gps`).
- Parcel: SanGIS/County "Assessor Parcels" `https://gis-public.sandiegocounty.gov/arcgis/rest/services/DPLU/DPLU_Map/MapServer/0/query`
  (point-in-polygon, outSR 4326; fields APN, SITUS_*, ACREAGE (often null → polygon area), OWN_NAME1, LEGLDESC). CORS reflects the origin.
  Outline drawn on the map; APN editable; lookup failure → saved as "pending" and retried on `online` / app start / "Look up APN".
- Form: customer name (required), phone, notes, photo (camera, resized to 1600 px JPEG ~0.7).
- Storage: IndexedDB `wells-nearby/sites` on the device only. No customer data leaves the device (only coordinates go to the
  parcel service). My sites: map, wells nearby (runs the normal search at the site), Google Maps directions, share/copy,
  edit, delete (confirm); export CSV / KML (with parcel polygons) / JSON backup; import backup (merges by id, newer wins).
- `sw.js`: network-first cache of the app files so the app opens with no signal (map tiles need signal).
- **Map tap → "Search here"** (`js/app.js` `searchHerePopup`): the handler is bound to that popup's own button (never looked up by
  id — while a popup fades out for 200 ms two `#searchHere` buttons exist). Searches always end in a result or a message, shown in
  the status line AND on the map (`.map-note`): "Searching…", "Still searching…" after 10 s, count / "No wells found", "📵 No signal"
  or "… data failed" with ↻ Retry. Faded top map buttons don't catch clicks while a popup is open. A stale setbacks map-tool flag
  (sheet gone without Done) self-heals. New service worker → "App updated — tap to reload" banner.
  Test (desktop 1440×900 mouse + phone 390×844 touch): `/workspace/.venv-pw/bin/python tools/test-search-here.py [--base URL] [--only desktop|phone]`
- Test: `/workspace/.venv-pw/bin/python tools/test-sites.py 33.0417 -116.8681 "Name" [--off dlat,dlon] [--base https://…/]`

## Septic / sewer + setbacks — `js/septic.js`, `js/septic-core.js`
- **Records (DEHQ library)**: site popups (and the map-tap popup → "🚽 Septic / sewer here") list septic layouts, septic permits and
  old septic files (subcategories `OWTS Layout`, `OWTS Permit`, `Land Use Archive-Parcel`) via `WellsDocs.searchRaw`. Search order:
  dashed APN (8-digit key `xxx-xxx-xx`; the library matches "contains", so multi-APN archive files are found) → street number +
  street name (`SITUS_ADDRESS` / `SITUS_STREET`, stored with the site at tagging time; the address search misses archive files).
  Merged by FileRecordId. "🏘 Neighbors on assessor page xxx-xxx" searches the book-page prefix and groups other parcels' files.
  Links open `LUEG_View`. The last result is saved with the site (`site.septic`) and shown offline.
- **Status**: `WW_Septic_Sewer_Public` (geo.sandag.org, County DPW/DEHQ, data through May 2025; 10-digit APN) for the parcel +
  counts for parcels within 60 m, in plain words with the confidence level (1–6) and a screening-layer caveat.
- **Map "🚽 Sewer" button** (top-left): service areas (LAFCO layer 51: Ramona / Olivenhain / Borrego MWD; County SD service areas)
  and public sewer mains (County SD gravity + force mains, City of SD) queried for the view from zoom 15. No public GIS exists for
  Ramona MWD / Padre Dam / other districts' mains. Remembered in localStorage `wellsNearby.sewer`.
- **📏 Setbacks** (site popup / My sites): rings at 50 ft (sewer / tight line), 100 ft (tank / leach line), 150 ft (seepage pit);
  pick an item and tap the map (lines: tap each point, ✓ Finish). Distance = true distance from the well pin to the point or the
  nearest point of any segment (local WGS84 tangent plane). Inside a setback → red warning with feet; within 10 ft outside →
  "check with a tape". ✏️ Move (drag handles) / 🗑 Delete. Also checks mapped public sewer mains within 100 ft.
  Marks: `site.marks = [{id, kind, pts:[[lat,lon]…], created}]`, in CSV (status, warnings, marks with distances), KML (rings +
  marks) and the JSON backup. While the tool is open `WellsApp.state.mapTool` suppresses the normal tap popups.
- Privacy: requests carry only APNs, street number/name and coordinates — never customer name/phone/notes.
- Tests: `node tools/test-septic-core.mjs` (distance/warning unit checks) · `/workspace/.venv-pw/bin/python tools/test-septic.py [--base URL] [--shots DIR]`
