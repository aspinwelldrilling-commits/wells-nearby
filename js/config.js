/* Wells Nearby — configuration.
 * Everything data-specific lives here so new fields / sources are easy to add.
 * Loaded as a plain script (no build step): exposes window.WELLS_CONFIG.
 */
(function (global) {
  'use strict';

  const CONFIG = {
    defaultRadiusMiles: 1,
    radiusOptions: [0.25, 0.5, 1, 2, 3, 5],
    // Default map center if no location yet (San Diego County)
    defaultCenter: [33.03, -116.87],

    sources: {
      // PRIMARY: DWR OSWCR ArcGIS MapServer (via the ArcGIS Online item proxy
      // c074ca40fd684e41babd776eebefd009). Supports spatial query (point + distance),
      // pagination (maxRecordCount 2000) and CORS (echoes the request Origin).
      arcgis: {
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
          pdfUrl: 'WCRLinks',
        },
      },
      // FALLBACK: same dataset on the CNRA open-data portal (CKAN datastore, SQL API,
      // CORS '*'). No spatial operator, so we query a bounding box and filter by
      // distance client-side.
      ckan: {
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
        },
      },
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
      year: [1900, new Date().getFullYear() + 1],
    },

    // Table columns — add a field here to show it in the table.
    tableColumns: [
      { key: 'distanceMi', label: 'Dist (mi)', fmt: (v) => v == null ? '' : v.toFixed(2), num: true },
      { key: 'depthFt', label: 'Depth (ft)', fmt: (v) => v == null ? '—' : Math.round(v), num: true },
      { key: 'methodLabel', label: 'Method' },
      { key: 'gpm', label: 'GPM', fmt: (v) => v == null ? '—' : (+v.toFixed(1)), num: true },
      { key: 'swlFt', label: 'SWL (ft)', fmt: (v) => v == null ? '—' : Math.round(v), num: true },
      { key: 'dateStr', label: 'Date', sortKey: 'dateMs' },
      { key: 'useShort', label: 'Use' },
      { key: 'wcr', label: 'WCR #' },
    ],
  };

  global.WELLS_CONFIG = CONFIG;
})(typeof window !== 'undefined' ? window : globalThis);
