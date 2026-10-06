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
    // Address / APN search box on the map (js/search.js). APN -> the parcel layer above. Addresses -> SANDAG's public regional
    // locator (no key; covers San Diego County only; knows ZIP codes but not city names, so a typed community becomes its
    // ZIPs) + the parcel layer's situs address. Esri's World Geocoder is not used: it now needs an access token, and its terms
    // forbid keeping results (the recent-search list) without a paid "stored" token.
    addressSearch: {
      geocoderUrl: 'https://geo.sandag.org/server/rest/services/SANDAG_COMPOSITE_LOCATOR/GeocodeServer/findAddressCandidates',
      zipUrl: 'https://gis-public.sandiegocounty.gov/arcgis/rest/services/ZIPCODE5/GeocodeServer/findAddressCandidates',  // "Ramona" / "92065" alone
      timeoutMs: 12000,
      maxCandidates: 12,   // asked from the geocoder
      maxShown: 8,         // shown in the pick list
      minScore: 70,
      dedupeM: 120,        // geocoder hits this close to another hit are the same place
      sameAddressM: 1500,  // same house number + street this close = same address (street points are interpolated)
      recentMax: 8,
      countyBounds: [32.52, -117.62, 33.52, -116.07],   // S, W, N, E
      communities: {
        'AGUANGA': ['92536'], 'ALPINE': ['91901', '91903'], 'BONITA': ['91902', '91908'], 'BONSALL': ['92003'], 'BORREGO SPRINGS': ['92004'],
        'BOULEVARD': ['91905'], 'CAMP PENDLETON': ['92055'], 'CAMPO': ['91906'], 'CARDIFF': ['92007'],
        'CARLSBAD': ['92008', '92009', '92010', '92011', '92013', '92018'], 'CHULA VISTA': ['91909', '91910', '91911', '91912', '91913', '91914', '91915', '91921'],
        'CORONADO': ['92118', '92178'], 'DEL MAR': ['92014'], 'DESCANSO': ['91916'], 'DULZURA': ['91917'], 'EL CAJON': ['92019', '92020', '92021', '92022'],
        'ELFIN FOREST': ['92029'], 'ENCINITAS': ['92023', '92024'], 'ESCONDIDO': ['92025', '92026', '92027', '92029', '92030', '92033', '92046'],
        'FALLBROOK': ['92028', '92088'], 'GUATAY': ['91931'], 'IMPERIAL BEACH': ['91932', '91933'], 'JACUMBA': ['91934'], 'JAMUL': ['91935'],
        'JULIAN': ['92036'], 'LA JOLLA': ['92037', '92038', '92039', '92092', '92093'], 'LA MESA': ['91941', '91942', '91943', '91944'], 'LAKESIDE': ['92040'],
        'LEMON GROVE': ['91945', '91946'], 'LEUCADIA': ['92024'], 'MOUNT LAGUNA': ['91948'], 'NATIONAL CITY': ['91950', '91951'], 'OCOTILLO': ['92004'],
        'OCEANSIDE': ['92049', '92051', '92052', '92054', '92056', '92057', '92058'], 'OLIVENHAIN': ['92024'], 'PALA': ['92059'], 'PALOMAR MOUNTAIN': ['92060'],
        'PAUMA VALLEY': ['92061'], 'PINE VALLEY': ['91962'], 'POTRERO': ['91963'], 'POWAY': ['92064', '92074'], 'RAINBOW': ['92028'], 'RAMONA': ['92065'],
        'RANCHITA': ['92066'], 'RANCHO SANTA FE': ['92067', '92091'], 'SAN DIEGO': Array.from({ length: 99 }, (_, i) => '921' + String(i + 1).padStart(2, '0')),
        'SAN MARCOS': ['92069', '92078', '92079', '92096'], 'SAN YSIDRO': ['92173'], 'SANTA YSABEL': ['92070'], 'SANTEE': ['92071', '92072'],
        'SOLANA BEACH': ['92075'], 'SPRING VALLEY': ['91976', '91977', '91978', '91979'], 'TECATE': ['91980'], 'VALLEY CENTER': ['92082'],
        'VISTA': ['92081', '92083', '92084', '92085'], 'WARNER SPRINGS': ['92086'],
        // places that share a postal city
        'SAN DIEGO COUNTRY ESTATES': ['92065'], 'WYNOLA': ['92036'], 'PINE HILLS': ['92036'], 'CUYAMACA': ['92036'], 'SHELTER VALLEY': ['92036'],
        'BANNER': ['92036'], 'MESA GRANDE': ['92070'], 'HIDDEN MEADOWS': ['92026'], 'HARMONY GROVE': ['92029'], 'DEL DIOS': ['92029'], 'SAN PASQUAL': ['92025', '92027'],
        'TWIN OAKS': ['92069'], 'DE LUZ': ['92028'], 'CREST': ['92021'], 'HARBISON CANYON': ['92019'], 'DEHESA': ['92019'], 'GRANITE HILLS': ['92019'],
        'RANCHO SAN DIEGO': ['92019'], 'BOSTONIA': ['92021'], 'BLOSSOM VALLEY': ['92021'], 'FLINN SPRINGS': ['92021'], 'WINTER GARDENS': ['92040'],
        'LAKE MORENA': ['91906'], 'CASA DE ORO': ['91977'], 'LA PRESA': ['91977'], 'MOUNT HELIX': ['91941'], 'RANCHO BERNARDO': ['92127', '92128'],
        '4S RANCH': ['92127'], 'SCRIPPS RANCH': ['92131'], 'RANCHO PENASQUITOS': ['92129'], 'CARMEL VALLEY': ['92130'], 'MIRA MESA': ['92126'], 'OTAY MESA': ['92154'],
      },
      communityAliases: { 'CARDIFF BY THE SEA': 'CARDIFF', 'MT LAGUNA': 'MOUNT LAGUNA', 'IMPERIAL BCH': 'IMPERIAL BEACH', 'BORREGO': 'BORREGO SPRINGS',
        'OCOTILLO WELLS': 'OCOTILLO', 'JACUMBA HOT SPRINGS': 'JACUMBA', 'PAUMA': 'PAUMA VALLEY', 'PALOMAR MTN': 'PALOMAR MOUNTAIN', 'MT HELIX': 'MOUNT HELIX',
        'SDCE': 'SAN DIEGO COUNTRY ESTATES', 'RSF': 'RANCHO SANTA FE' },
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
    // Septic / sewer (js/septic.js). Only APNs, street number/name and coordinates are sent — never customer data.
    septic: {
      // County DPW/DEHQ parcel sewer/septic designation (points, one per APN, 10-digit APN without dashes). CORS reflects origin.
      wwUrl: 'https://geo.sandag.org/server/rest/services/Hosted/WW_Septic_Sewer_Public/FeatureServer/0/query',
      neighborM: 60,          // neighbors within ~200 ft of the site / tapped point
      timeoutMs: 20000,
      serviceAreas: [
        { name: 'LAFCO sewer service areas (Ramona MWD, Olivenhain MWD, Borrego WD)', nameField: 'NAME',
          url: 'https://gis-public.sandiegocounty.gov/arcgis/rest/services/LAFCO/lafco_water_and_fire_districts_P/MapServer/51/query' },
        { name: 'County Sanitation District service areas', nameField: 'label', where: "service_area <> 'OUTSIDE'",
          url: 'https://geo.sandag.org/server/rest/services/Hosted/Wastewater_District_CN/FeatureServer/0/query' },
      ],
      mains: [
        { name: 'County SD gravity main', fields: 'diameter,material,status,owner', size: 'diameter', mat: 'material',
          url: 'https://geo.sandag.org/server/rest/services/Hosted/Wastewater_Gravity_Main_CN/FeatureServer/0/query' },
        { name: 'County SD force main', fields: 'diameter,material,status,owner', size: 'diameter', mat: 'material',
          url: 'https://geo.sandag.org/server/rest/services/Hosted/Wastewater_Pressurized_Main_CN/FeatureServer/0/query' },
        { name: 'City of San Diego sewer main', fields: 'size_num,matl_desc,main_typ_desc', size: 'size_num', mat: 'matl_desc',
          url: 'https://geo.sandag.org/server/rest/services/Hosted/Sewer_Main_SD/FeatureServer/0/query' },
      ],
      mainsMinZoom: 15,       // sewer mains are drawn from this zoom (queried for the visible area)
      mainsCheckFt: 100,      // setback screen: look for mapped public sewer mains this close to the site
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
