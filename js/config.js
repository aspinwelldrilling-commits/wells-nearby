/* Wells Nearby — configuration.
 * Everything data-specific lives here so new fields / sources are easy to add.
 * Loaded as a plain script (no build step): exposes window.WELLS_CONFIG.
 */
(function (global) {
  'use strict';

  const CONFIG = {
    defaultRadiusMiles: 1,
    minRadiusMiles: 0.05,   // slider 0 = "tapped point": search this small radius internally
    nearestFetchMiles: 0.5, // r=0: if nothing within minRadiusMiles, show the nearest wells within this distance
    nearestCount: 3,
    radiusOptions: [0.25, 0.5, 1, 2, 3, 5],
    // Default map center if no location yet (San Diego County)
    defaultCenter: [33.03, -116.87],

    sources: {
      // PRIMARY: DWR OSWCR ArcGIS MapServer (via the ArcGIS Online item proxy
      // c074ca40fd684e41babd776eebefd009). Supports spatial query (point + distance),
      // pagination (maxRecordCount 2000) and CORS (echoes the request Origin).
      arcgis: {
        group: 'state',
        label: 'DWR OSWCR ArcGIS service',
        queryUrl: 'https://utility.arcgis.com/usrsvcs/servers/c074ca40fd684e41babd776eebefd009/rest/services/Environment/i07_WellCompletionReports/MapServer/0/query',
        pageSize: 2000,
        maxRecords: 10000,
        // service field -> normalized field
        fieldMap: {
          wcr: 'WCRNumber',
          legacyLog: 'LegacyLogNumber',
          lat: 'DecimalLatitude',
          lon: 'DecimalLongitude',
          llAccuracy: 'LLAccuracy',
          llMethod: 'MethodofDeterminationLL',
          depth: 'TotalCompletedDepth',
          drillDepth: 'TotalDrillDepth',
          method: 'DrillingMethod',
          fluid: 'Fluid',
          yield: 'WellYield',
          yieldUnits: 'WellYieldUnitofMeasure',
          swl: 'StaticWaterLevel',
          dateEnded: 'DateWorkEnded',
          plannedUse: 'PlannedUseFormerUse',
          b118Use: 'B118WellUse',
          recordType: 'RecordType',
          casingDiameter: 'CasingDiameter',
          perfTop: 'TopOfPerforatedInterval',
          perfBottom: 'BottomofPerforatedInterval',
          driller: 'DrillerName',
          address: 'WellLocation',
          city: 'City',
          apn: 'APN',
          permit: 'PermitNumber',
          permitDate: 'PermitDate',
          pdfUrl: 'WCRLinks',
        },
      },
      // FALLBACK: same dataset on the CNRA open-data portal (CKAN datastore, SQL API,
      // CORS '*'). No spatial operator, so we query a bounding box and filter by
      // distance client-side.
      ckan: {
        group: 'state',
        label: 'CNRA Open Data (CKAN datastore)',
        sqlUrl: 'https://data.cnra.ca.gov/api/3/action/datastore_search_sql',
        resourceId: '8da7b93b-4e69-495d-9caa-335691a1896b',
        maxRecords: 5000,
        fieldMap: {
          wcr: 'WCRNUMBER',
          legacyLog: 'LEGACYLOGNUMBER',
          lat: 'DECIMALLATITUDE',
          lon: 'DECIMALLONGITUDE',
          llAccuracy: 'LLACCURACY',
          llMethod: 'METHODOFDETERMINATIONLL',
          depth: 'TOTALCOMPLETEDDEPTH',
          drillDepth: 'TOTALDRILLDEPTH',
          method: 'DRILLINGMETHOD',
          fluid: 'FLUID',
          yield: 'WELLYIELD',
          yieldUnits: 'WELLYIELDUNITOFMEASURE',
          swl: 'STATICWATERLEVEL',
          dateEnded: 'DATEWORKENDED',
          plannedUse: 'PLANNEDUSEFORMERUSE',
          b118Use: 'B118WELLUSE',
          recordType: 'RECORDTYPE',
          casingDiameter: 'CASINGDIAMETER',
          perfTop: 'TOPOFPERFORATEDINTERVAL',
          perfBottom: 'BOTTOMOFPERFORATEDINTERVAL',
          driller: 'DRILLERNAME',
          address: 'WELLLOCATION',
          city: 'CITY',
          apn: 'APN',
          permit: 'PERMITNUMBER',
          permitDate: 'PERMITDATE',
        },
      },

      // COUNTY: San Diego County DEHQ (LWQD) water well PERMITS, published by County/SanGIS.
      // Unincorporated area only; points are the center of the permitted parcel (APN).
      // Has permit #, APN, date opened, use, type of work, status — NO depth/yield/SWL/method
      // (those come from the matched state WCR, if any). CORS: echoes Origin. Last edited 2023-06.
      county: {
        group: 'county',
        type: 'arcgis',
        label: 'San Diego County DEHQ well permits (SanGIS)',
        queryUrl: 'https://gis-public.sandiegocounty.gov/arcgis/rest/services/DPLU/DPLU_Map/MapServer/100/query',
        pageSize: 1700,
        maxRecords: 10000,
        fieldMap: {
          permit: 'Record_ID',
          apn: 'Parcel_No',
          lat: 'LatitudeGS84',
          lon: 'LongitudeGS84',
          llMethod: 'GEO_SRC',
          dateEnded: 'Opened_Date',   // permit application/opened date (not completion)
          wellUse: 'Well_Use',
          recordType: 'Type_Work',
          status: 'Record_Status',
          address: 'Address',
          city: 'City',
          community: 'ZipCommunity',
          purveyor: 'APNWater_Purveyor',
          basin: 'BasinNo',
        },
        // Called after generic normalization to fill source-specific derived fields.
        post: (w) => {
          w.llAccuracy = 'Parcel center (APN)';
          w.plannedUse = 'Water Supply ' + (w.wellUse || 'Unknown');
          w.waterSupply = true;          // layer 100 is the water-well program only
          w.destruction = /destr/i.test(w.recordType || '');
        },
      },
    },

    // San Diego County DEHQ "Environmental Health Document Library" (Documentum behind an AEM page).
    // The search page has no URL parameters (no deep link), but its JSON API allows CORS (*),
    // so the app lists documents inline. Each document opens in the county's own viewer (LUEG_View).
    docLibrary: {
      searchApi: 'https://file.sandiegocounty.gov/CoSD_LUEG_Repository_External_API/rest/DEHQDocumentLibrary/SearchDocuments',
      searchPage: 'https://www.sandiegocounty.gov/content/sdc/deh/doclibrary.html',
      category: 'DEH-LWQD',
      maxRecords: 350,
      timeoutMs: 30000,
      // For APN searches, only these subcategories are shown by default (parcels can have dozens of septic/SAM docs).
      wellSubtypes: ['DEH-LWQD-Water Well Permit', 'DEH-LWQD-Land Use Archive-Parcel', 'DEH-LWQD-Monitoring Well Permit Application'],
    },

    // Values read from county completion reports by tools/extract_county_wcr.py (cached JSON in the repo).
    countyWcr: {
      manifestUrl: 'data/county-wcr/manifest.json', // tile manifest (bounds + hash per tile) -> tiles/<key>.json
      indexUrl: 'data/county-wcr/index.json',       // legacy single file, used only if there is no manifest
      maxGpsShiftMiles: 1.0,     // GPS read from a WCR must be within this of the parcel center, else ignored
      agreeTolerance: { rel: 0.1, abs: { depthFt: 10, gpm: 2, swlFt: 5 } }, // OCR vs state "agrees" if within this
      needsReadColor: '#FF1744', // fluorescent red: "read this report yourself"
    },

    // Where each group's markers/labels come from.
    groups: {
      state: { label: 'State (DWR WCR)', short: 'State', color: '#f59e0b' },
      county: { label: 'County (DEHQ permit)', short: 'County', color: '#06b6d4' },
      both: { label: 'State + County', short: 'Both' },
    },
    defaultView: 'both', // 'state' | 'county' | 'both'

    // Duplicate detection between county permits and state WCRs (see js/match.js).
    matching: {
      bufferMiles: 0.75,             // fetch both sources this much beyond the radius so pairs straddling the edge still match
      keyWindowDays: [-90, 1095],    // state work-ended/permit date minus county opened date, for permit#/APN matches
      proxMiles: 0.75,               // state points are often section centroids (~0.7 mi from a parcel)
      proxWindowDays: [-7, 120],     // location-only match needs a tight date window
      // In the Both view a matched well is drawn at the county parcel center, unless the WCR has a
      // precise reported accuracy (e.g. "10 Ft"); section centroids / unknown / ">50 Ft" lose to the parcel.
      preciseStateAccuracy: /^\s*\d+(\.\d+)?\s*ft\s*$/i,
    },

    // Yield unit -> factor to convert to GPM. Unknown units are excluded from the average.
    yieldToGpm: {
      'GPM': 1, 'GAL/MIN': 1, 'GALLONS PER MINUTE': 1,
      'GPH': 1 / 60, 'GAL/HR': 1 / 60,
      'GPD': 1 / 1440, 'GAL/DAY': 1 / 1440,
      'CFS': 448.831,
      'AFY': 0.62, // acre-ft/yr ≈ 0.62 gpm
    },

    // Drilling method classification. First matching rule wins.
    // DWR records DrillingMethod (Direct Rotary, Reverse Circulation, Downhole Hammer,
    // Cable Tool, Auger, Other...) and Fluid (Air, Foam, Bentonite, Polymer, Water, Unknown).
    // In San Diego County most air-rotary wells are recorded as Method "Other" + Fluid "Air".
    methodCategories: [
      { key: 'air', label: 'Air rotary', color: '#f59e0b',
        test: (m, f) => /air|foam/.test(f) || /hammer/.test(m) },
      { key: 'mud', label: 'Mud rotary', color: '#3b82f6',
        test: (m, f) => /bentonite|polymer|mud|water/.test(f) && !/auger|cable/.test(m) },
      { key: 'rotaryUnk', label: 'Rotary (fluid not recorded)', color: '#8b5cf6',
        test: (m, f) => /rotary|reverse|circulation/.test(m) },
      { key: 'cable', label: 'Cable tool', color: '#10b981', test: (m) => /cable/.test(m) },
      { key: 'auger', label: 'Auger', color: '#a3a3a3', test: (m) => /auger/.test(m) },
      { key: 'other', label: 'Other / unknown', color: '#6b7280', test: () => true },
      // Assigned explicitly to county permits with no matched state WCR (never via test()).
      { key: 'nolog', label: 'No log data (permit only)', color: '#cbd5e1', test: () => false, explicitOnly: true },
    ],

    // Which records count as "water supply wells" (default filter).
    isWaterSupply: (w) => {
      const pu = (w.plannedUse || '').toLowerCase();
      const b = (w.b118Use || '').toLowerCase();
      if (pu.startsWith('water supply')) return true;
      if (/domestic|irrigation|public|industrial|stock/.test(pu)) return true;
      if (!pu && /domestic|irrigation|public supply|industrial/.test(b)) return true;
      return false;
    },
    isDestruction: (w) => /destr/i.test(w.recordType || ''),

    // Plausibility bounds; values outside are treated as missing.
    bounds: {
      depth: [1, 3000],     // ft
      swl: [0.01, 2000],    // ft below ground surface (0 / negative = missing or artesian)
      gpm: [0.01, 5000],
      year: [1901, new Date().getFullYear() + 1], // 1900-01-01 is used as a placeholder
    },

    // Table columns — add a field here to show it in the table.
    // Proposed well sites (tagged in the field, stored on this device only).
    parcels: {
      // SanGIS / County of San Diego "Assessor Parcels" (DPLU_Map layer 0). CORS: reflects the page origin.
      url: 'https://gis-public.sandiegocounty.gov/arcgis/rest/services/DPLU/DPLU_Map/MapServer/0/query',
      outFields: 'APN,SITUS_ADDRESS,SITUS_FRACTION,SITUS_PRE_DIR,SITUS_STREET,SITUS_SUFFIX,SITUS_POST_DIR,SITUS_SUITE,SITUS_COMMUNITY,SITUS_ZIP,ACREAGE,Shape.STArea(),OWN_NAME1,LEGLDESC',
      timeoutMs: 12000,
    },
    // Property lines overlay (js/parcels.js): county MapServer export of the same parcel layer, restyled.
    parcelLines: {
      exportUrl: 'https://gis-public.sandiegocounty.gov/arcgis/rest/services/DPLU/DPLU_Map/MapServer/export',
      color: [255, 235, 59, 255], widthPt: 1.5,  // bright yellow, thin
      minZoom: 15,       // the service draws parcels only below 1:36,000
      labelZoom: 18,     // APN labels in the tiles from this zoom
      tapZoom: 16,       // tap the map for the parcel APN from this zoom
      defaultOpacity: 70,
    },
    siteGps: { goodFt: 16, okFt: 50, maxWaitS: 30 },   // accuracy thresholds (ft) + how long to refine the fix
    sitePhoto: { maxPx: 1600, quality: 0.72 },
    tableColumns: [
      { key: 'distanceMi', label: 'Dist (mi)', fmt: (v) => v == null ? '' : v.toFixed(2), num: true },
      { key: 'srcShort', label: 'Src' },
      { key: 'depthFt', label: 'Depth (ft)', fmt: (v) => v == null ? '—' : Math.round(v), num: true },
      { key: 'methodLabel', label: 'Method' },
      { key: 'gpm', label: 'GPM', fmt: (v) => v == null ? '—' : (+v.toFixed(1)), num: true },
      { key: 'swlFt', label: 'SWL (ft)', fmt: (v) => v == null ? '—' : Math.round(v), num: true },
      { key: 'dateStr', label: 'Date', sortKey: 'dateMs' },
      { key: 'useShort', label: 'Use' },
      { key: 'wcr', label: 'WCR #' },
      { key: 'permitId', label: 'County permit' },
      { key: 'matchLabel', label: 'Dup?' },
      { key: 'wcrLabel', label: 'WCR data' },
      { key: 'docHint', label: 'Docs' },
    ],
  };

  global.WELLS_CONFIG = CONFIG;
})(typeof window !== 'undefined' ? window : globalThis);
