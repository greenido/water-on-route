// Small, dependency-free OSM API utilities with adaptive splitting and backoff

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function fetchWithTimeout(url, options, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await (fetchImpl || fetch)(url, { ...options, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchOsmMapXml(bbox, timeoutMs = 30000, fetchImpl) {
  const bboxParam = `${bbox.minlon},${bbox.minlat},${bbox.maxlon},${bbox.maxlat}`; // lon,lat order per OSM API
  const url = `https://api.openstreetmap.org/api/0.6/map?bbox=${bboxParam}`;
  const resp = await fetchWithTimeout(url, { method: 'GET' }, timeoutMs, fetchImpl);
  if (!resp.ok) {
    let serverMsg = '';
    try { serverMsg = await resp.text(); } catch (_) {}
    const trimmed = serverMsg ? serverMsg.slice(0, 200) : '';
    const err = new Error(`OSM API error: ${resp.status}${trimmed ? ` - ${trimmed}` : ''}`);
    // Attach status to error for programmatic handling
    err.status = resp.status;
    throw err;
  }
  return await resp.text();
}

// Determine Overpass endpoint from optional runtime config
export function getOverpassUrl() {
  try {
    if (typeof window !== 'undefined' && window.WOR_CONFIG && window.WOR_CONFIG.overpassUrl) {
      return window.WOR_CONFIG.overpassUrl;
    }
  } catch (_) {}
  return 'https://overpass-api.de/api/interpreter';
}

/** Potable water: classic OSM tags plus park fountains / taps / wells. Excludes drinking_water=no. */
export function isPotableWaterTags(tags) {
  if (!tags || typeof tags !== 'object') return false;
  if (tags.drinking_water === 'no') return false;

  const amenity = tags.amenity;
  const naturalTag = tags.natural;
  const manMade = tags.man_made;
  const drinking = tags.drinking_water;

  if (amenity === 'drinking_water') return true;
  if (naturalTag === 'spring') return true;
  if (manMade === 'water_tap') return true;
  if (amenity === 'water_point') return true;
  if (amenity === 'fountain' && (drinking === 'yes' || drinking === 'compatible')) return true;
  if (manMade === 'water_well' && (drinking === 'yes' || drinking === 'compatible')) return true;
  if (drinking === 'yes' || drinking === 'compatible') return true;
  return false;
}

/** Short subtype label for UI (fountain, tap, spring, …). */
export function waterSubtypeLabel(tags) {
  if (!tags) return 'water';
  if (tags.amenity === 'fountain') return 'fountain';
  if (tags.amenity === 'water_point') return 'water point';
  if (tags.man_made === 'water_tap') return 'tap';
  if (tags.man_made === 'water_well') return 'well';
  if (tags.natural === 'spring') return 'spring';
  if (tags.amenity === 'drinking_water') return 'drinking water';
  if (tags.drinking_water === 'yes' || tags.drinking_water === 'compatible') return 'tap';
  return 'water';
}

const COFFEE_CUISINE_RE = /coffee|cafe|coffee_shop|espresso/i;

/** Coffee / cafe POIs we care about. */
export function isCoffeeTags(tags) {
  if (!tags || typeof tags !== 'object') return false;
  if (tags.amenity === 'cafe') return true;
  if (tags.shop === 'coffee') return true;
  if (tags.amenity === 'restaurant' && COFFEE_CUISINE_RE.test(tags.cuisine || '')) return true;
  return false;
}

export function buildOverpassWaterQuery(b) {
  const bboxPart = `${b.minlat},${b.minlon},${b.maxlat},${b.maxlon}`; // lat,lon order for Overpass bbox
  // drinking_water=no excluded in parser; Overpass also skips fountain/well without potable tag
  return `
    [out:xml][timeout:25];
    (
      node["amenity"="drinking_water"](${bboxPart});
      node["natural"="spring"](${bboxPart});
      node["man_made"="water_tap"](${bboxPart});
      node["amenity"="water_point"](${bboxPart});
      node["amenity"="fountain"]["drinking_water"~"^(yes|compatible)$"](${bboxPart});
      node["man_made"="water_well"]["drinking_water"~"^(yes|compatible)$"](${bboxPart});
      node["drinking_water"~"^(yes|compatible)$"](${bboxPart});
      way["amenity"="drinking_water"](${bboxPart});
      way["natural"="spring"](${bboxPart});
      way["man_made"="water_tap"](${bboxPart});
      way["amenity"="water_point"](${bboxPart});
      way["amenity"="fountain"]["drinking_water"~"^(yes|compatible)$"](${bboxPart});
      way["man_made"="water_well"]["drinking_water"~"^(yes|compatible)$"](${bboxPart});
      way["drinking_water"~"^(yes|compatible)$"](${bboxPart});
      relation["amenity"="drinking_water"](${bboxPart});
      relation["natural"="spring"](${bboxPart});
      relation["man_made"="water_tap"](${bboxPart});
      relation["amenity"="water_point"](${bboxPart});
      relation["amenity"="fountain"]["drinking_water"~"^(yes|compatible)$"](${bboxPart});
      relation["man_made"="water_well"]["drinking_water"~"^(yes|compatible)$"](${bboxPart});
      relation["drinking_water"~"^(yes|compatible)$"](${bboxPart});
    );
    out body center qt;
  `;
}

// Build Overpass query for coffee-related POIs
export function buildOverpassCoffeeQuery(b) {
  const bboxPart = `${b.minlat},${b.minlon},${b.maxlat},${b.maxlon}`; // lat,lon order for Overpass bbox
  const cuisineRe = 'coffee|cafe|coffee_shop|espresso';
  return `
    [out:xml][timeout:25];
    (
      node["amenity"="cafe"](${bboxPart});
      node["shop"="coffee"](${bboxPart});
      node["amenity"="restaurant"]["cuisine"~"${cuisineRe}", i](${bboxPart});
      way["amenity"="cafe"](${bboxPart});
      way["shop"="coffee"](${bboxPart});
      way["amenity"="restaurant"]["cuisine"~"${cuisineRe}", i](${bboxPart});
      relation["amenity"="cafe"](${bboxPart});
      relation["shop"="coffee"](${bboxPart});
      relation["amenity"="restaurant"]["cuisine"~"${cuisineRe}", i](${bboxPart});
    );
    out body center qt;
  `;
}

export async function fetchOverpassXml(bbox, timeoutMs = 30000, fetchImpl, buildQuery = buildOverpassWaterQuery) {
  const url = getOverpassUrl();
  const query = buildQuery(bbox);
  const body = 'data=' + encodeURIComponent(query);
  const resp = await fetchWithTimeout(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body }, timeoutMs, fetchImpl);
  if (!resp.ok) {
    let serverMsg = '';
    try { serverMsg = await resp.text(); } catch (_) {}
    const trimmed = serverMsg ? serverMsg.slice(0, 200) : '';
    const err = new Error(`Overpass error: ${resp.status}${trimmed ? ` - ${trimmed}` : ''}`);
    err.status = resp.status;
    throw err;
  }
  return await resp.text();
}

// Fetch coffee POIs from Overpass into unified points array (like water parser)
export async function fetchOverpassCoffeePoints(bbox, timeoutMs = 30000, fetchImpl) {
  const xmlText = await fetchOverpassXml(bbox, timeoutMs, fetchImpl, buildOverpassCoffeeQuery);
  return parseOsmXmlGeneric(xmlText).filter((p) => isCoffeeTags(p.tags));
}

function collectTags(el) {
  const tagEls = Array.from(el.getElementsByTagName('tag'));
  const tags = {};
  for (const t of tagEls) {
    const k = t.getAttribute('k');
    const v = t.getAttribute('v');
    if (k) tags[k] = v;
  }
  return tags;
}

// Parse generic POIs (cafe/coffee/restaurant) similarly to water parser
export function parseOsmXmlGeneric(xmlText) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(xmlText, 'application/xml');
  const results = [];

  // Nodes
  for (const node of Array.from(xml.getElementsByTagName('node'))) {
    const tags = collectTags(node);
    const id = Number(node.getAttribute('id'));
    const lat = Number(node.getAttribute('lat'));
    const lon = Number(node.getAttribute('lon'));
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      results.push({ id, lat, lon, tags, _type: 'node' });
    }
  }

  // Ways
  for (const way of Array.from(xml.getElementsByTagName('way'))) {
    const tags = collectTags(way);
    const id = Number(way.getAttribute('id'));
    const centerEl = way.getElementsByTagName('center')[0];
    const lat = centerEl ? Number(centerEl.getAttribute('lat')) : NaN;
    const lon = centerEl ? Number(centerEl.getAttribute('lon')) : NaN;
    const result = { id, tags, _type: 'way' };
    if (Number.isFinite(lat) && Number.isFinite(lon)) result.center = { lat, lon };
    results.push(result);
  }

  // Relations
  for (const rel of Array.from(xml.getElementsByTagName('relation'))) {
    const tags = collectTags(rel);
    const id = Number(rel.getAttribute('id'));
    const centerEl = rel.getElementsByTagName('center')[0];
    const lat = centerEl ? Number(centerEl.getAttribute('lat')) : NaN;
    const lon = centerEl ? Number(centerEl.getAttribute('lon')) : NaN;
    const result = { id, tags, _type: 'relation' };
    if (Number.isFinite(lat) && Number.isFinite(lon)) result.center = { lat, lon };
    results.push(result);
  }

  return results;
}

export function parseOsmXmlForWater(xmlText) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(xmlText, 'application/xml');
  const results = [];

  // Nodes
  for (const node of Array.from(xml.getElementsByTagName('node'))) {
    const tags = collectTags(node);
    if (!isPotableWaterTags(tags)) continue;
    const id = Number(node.getAttribute('id'));
    const lat = Number(node.getAttribute('lat'));
    const lon = Number(node.getAttribute('lon'));
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      results.push({ id, lat, lon, tags, _type: 'node' });
    }
  }

  // Ways (from Overpass, with optional <center lat="" lon=""/>)
  for (const way of Array.from(xml.getElementsByTagName('way'))) {
    const tags = collectTags(way);
    if (!isPotableWaterTags(tags)) continue;
    const id = Number(way.getAttribute('id'));
    const centerEl = way.getElementsByTagName('center')[0];
    const lat = centerEl ? Number(centerEl.getAttribute('lat')) : NaN;
    const lon = centerEl ? Number(centerEl.getAttribute('lon')) : NaN;
    const result = { id, tags, _type: 'way' };
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      result.center = { lat, lon };
    }
    results.push(result);
  }

  // Relations (from Overpass, with optional <center/>)
  for (const rel of Array.from(xml.getElementsByTagName('relation'))) {
    const tags = collectTags(rel);
    if (!isPotableWaterTags(tags)) continue;
    const id = Number(rel.getAttribute('id'));
    const centerEl = rel.getElementsByTagName('center')[0];
    const lat = centerEl ? Number(centerEl.getAttribute('lat')) : NaN;
    const lon = centerEl ? Number(centerEl.getAttribute('lon')) : NaN;
    const result = { id, tags, _type: 'relation' };
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      result.center = { lat, lon };
    }
    results.push(result);
  }

  return results;
}

export function bboxSpan(b) {
  return { lat: Math.max(0, b.maxlat - b.minlat), lon: Math.max(0, b.maxlon - b.minlon) };
}

export function splitBboxIntoQuads(b) {
  const midLat = (b.minlat + b.maxlat) / 2;
  const midLon = (b.minlon + b.maxlon) / 2;
  return [
    { minlat: b.minlat, minlon: b.minlon, maxlat: midLat, maxlon: midLon }, // SW
    { minlat: b.minlat, minlon: midLon, maxlat: midLat, maxlon: b.maxlon }, // SE
    { minlat: midLat, minlon: b.minlon, maxlat: b.maxlat, maxlon: midLon }, // NW
    { minlat: midLat, minlon: midLon, maxlat: b.maxlat, maxlon: b.maxlon }  // NE
  ];
}

export function dedupePointsByTypeId(points) {
  if (!Array.isArray(points) || !points.length) return [];
  const seen = new Set();
  const out = [];
  for (const p of points) {
    const key = `${p._type || 'node'}:${p.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function getStatusFromError(err) {
  if (!err) return undefined;
  if (typeof err.status === 'number') return err.status;
  const m = /(?:OSM API|Overpass) error:\s*(\d{3})/.exec(err.message || '');
  if (m) return Number(m[1]);
  return undefined;
}

/**
 * Adaptive Overpass (or OSM map) fetch with bbox split on 400/429/504.
 * @param {object} bbox
 * @param {function|null} onProgress
 * @param {object} options
 * @param {function} [options.buildQuery] - Overpass QL builder (default: water)
 * @param {function} [options.parseXml] - XML → points (default: water parser)
 */
export async function fetchOverpassPointsAdaptive(bbox, onProgress, options = {}) {
  const minSpan = options.minSpan ?? 0.02;
  const timeoutMs = options.timeoutMs ?? 30000;
  const initialBackoffMs = options.initialBackoffMs ?? 500;
  const maxBackoffMs = options.maxBackoffMs ?? 4000;
  const fetchImpl = options.fetchImpl; // optional for tests
  const source = options.source ?? 'overpass'; // 'overpass' (default) or 'osm'
  const buildQuery = options.buildQuery ?? buildOverpassWaterQuery;
  const parseXml = options.parseXml ?? parseOsmXmlForWater;

  let tilesFetched = 0;

  async function fetchTile(tile, attempt) {
    try {
      const xml = source === 'overpass'
        ? await fetchOverpassXml(tile, timeoutMs, fetchImpl, buildQuery)
        : await fetchOsmMapXml(tile, timeoutMs, fetchImpl);
      tilesFetched++;
      if (onProgress) onProgress(tilesFetched, undefined);
      return parseXml(xml);
    } catch (e) {
      const status = getStatusFromError(e);
      const span = bboxSpan(tile);
      const canSplit = span.lat > minSpan || span.lon > minSpan;
      if ((status === 400 || status === 429 || status === 504) && canSplit) {
        const backoff = Math.min(initialBackoffMs * Math.pow(2, attempt), maxBackoffMs);
        if (backoff > 0) await sleep(backoff);
        const quads = splitBboxIntoQuads(tile);
        let all = [];
        for (const q of quads) {
          const pts = await fetchTile(q, attempt + 1);
          if (pts && pts.length) all = all.concat(pts);
        }
        return all;
      }
      throw e;
    }
  }

  const raw = await fetchTile(bbox, 0);
  return dedupePointsByTypeId(raw);
}

export async function fetchOSMWaterPointsAdaptive(bbox, onProgress, options = {}) {
  return fetchOverpassPointsAdaptive(bbox, onProgress, {
    ...options,
    buildQuery: buildOverpassWaterQuery,
    parseXml: parseOsmXmlForWater,
  });
}

export async function fetchOSMCoffeePointsAdaptive(bbox, onProgress, options = {}) {
  return fetchOverpassPointsAdaptive(bbox, onProgress, {
    ...options,
    buildQuery: buildOverpassCoffeeQuery,
    parseXml: (xml) => parseOsmXmlGeneric(xml).filter((p) => isCoffeeTags(p.tags)),
  });
}

export function coffeeQualityBoost(p) {
  const tags = (p && p.tags) || {};
  let boost = 0;
  if (tags.name || tags.brand) boost += 30;
  if (/coffee|espresso|cafe|coffee_shop/i.test(tags.cuisine || '')) boost += 20;
  if (tags.opening_hours) boost += 15;
  if (tags.website || tags['contact:website']) boost += 10;
  return boost;
}

/** Rank coffee: OSM quality signals minus distance (closer + richer tags win). */
export function rankCoffeePoints(points) {
  return [...points].sort((a, b) => {
    const scoreA = coffeeQualityBoost(a) - (a._distanceM ?? 0);
    const scoreB = coffeeQualityBoost(b) - (b._distanceM ?? 0);
    if (scoreB !== scoreA) return scoreB - scoreA;
    return (a._distanceM ?? Infinity) - (b._distanceM ?? Infinity);
  });
}

export function sortPointsByDistance(points) {
  return [...points].sort((a, b) => (a._distanceM ?? Infinity) - (b._distanceM ?? Infinity));
}
