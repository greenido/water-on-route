/**
 * Convert Garmin FIT activity/course data to a GeoJSON FeatureCollection.
 * Uses fit-file-parser (loaded on demand from CDN in the browser).
 */

const FIT_PARSER_CDN = 'https://cdn.jsdelivr.net/npm/fit-file-parser@4.1.0/+esm';

let fitParserCtorPromise = null;

/**
 * Lazily load FitParser from the CDN (browser) or resolve a provided constructor.
 * @param {Function} [FitParserOverride] optional constructor for tests / Node
 * @returns {Promise<Function>}
 */
export async function ensureFitParser(FitParserOverride) {
  if (typeof FitParserOverride === 'function') return FitParserOverride;
  if (typeof window !== 'undefined' && typeof window.FitParser === 'function') {
    return window.FitParser;
  }
  if (!fitParserCtorPromise) {
    fitParserCtorPromise = import(FIT_PARSER_CDN).then((mod) => {
      const FitParser = mod?.default || mod?.FitParser;
      if (typeof FitParser !== 'function') {
        throw new Error('Failed to load fit-file-parser');
      }
      if (typeof window !== 'undefined') window.FitParser = FitParser;
      return FitParser;
    });
  }
  return fitParserCtorPromise;
}

/**
 * Collect lon/lat pairs from FIT record-like objects (degrees).
 * @param {Array<object>} points
 * @returns {number[][]} [lon, lat] or [lon, lat, elev]
 */
export function coordinatesFromFitPoints(points) {
  const coords = [];
  for (const p of points || []) {
    const lat = p.position_lat;
    const lon = p.position_long;
    if (typeof lat !== 'number' || typeof lon !== 'number') continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    // Reject invalid / unset FIT positions
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const elev = p.altitude;
    if (typeof elev === 'number' && Number.isFinite(elev)) {
      coords.push([lon, lat, elev]);
    } else {
      coords.push([lon, lat]);
    }
  }
  return coords;
}

/**
 * Build a GeoJSON FeatureCollection LineString from FIT parse output.
 * Prefers activity records; falls back to course_points.
 * @param {object} fitData
 * @returns {object} GeoJSON FeatureCollection
 */
export function fitDataToGeoJSON(fitData) {
  const records = fitData?.records || [];
  let coords = coordinatesFromFitPoints(records);
  let source = 'records';

  if (coords.length < 2) {
    const coursePoints = fitData?.course_points || [];
    coords = coordinatesFromFitPoints(coursePoints);
    source = 'course_points';
  }

  if (coords.length < 2) {
    throw new Error('No GPS track found in FIT file.');
  }

  const name =
    fitData?.sessions?.[0]?.sport ||
    fitData?.sports?.[0]?.name ||
    fitData?.file_ids?.[0]?.product_name ||
    'FIT route';

  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { name: String(name), source: `fit:${source}` },
        geometry: {
          type: 'LineString',
          coordinates: coords,
        },
      },
    ],
  };
}

/**
 * Parse a FIT ArrayBuffer / Buffer into GeoJSON.
 * @param {ArrayBuffer|Uint8Array|Buffer} content
 * @param {{ FitParser?: Function }} [options]
 * @returns {Promise<object>} GeoJSON FeatureCollection
 */
export async function parseFitToGeoJSON(content, options = {}) {
  const FitParser = await ensureFitParser(options.FitParser);
  const parser = new FitParser({
    mode: 'list',
    lengthUnit: 'm',
    force: true,
  });
  const fitData = await parser.parseAsync(content);
  return fitDataToGeoJSON(fitData);
}
