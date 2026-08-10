// Small, dependency-free OSM API utilities with adaptive splitting and backoff

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Cap how many operations run at once.
 *
 * Wrap only the leaf network call, never a function that awaits its own
 * children: a parent holding a slot while waiting on a child it cannot
 * schedule would deadlock.
 *
 * @param {number} max concurrent operations
 * @returns {(fn: () => Promise<any>) => Promise<any>}
 */
export function createLimiter(max) {
  const limit = Math.max(1, Math.floor(max) || 1);
  let active = 0;
  const queue = [];

  const pump = () => {
    while (active < limit && queue.length) {
      const { fn, resolve, reject } = queue.shift();
      active++;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => { active--; pump(); });
    }
  };

  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    pump();
  });
}

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

/**
 * The same-origin proxy endpoint.
 *
 * There is deliberately no public-Overpass fallback: the proxy builds the
 * query server-side, and the page's CSP restricts connect-src to 'self'
 * anyway, so a direct upstream call could never have succeeded.
 */
export function getOverpassUrl() {
  try {
    if (typeof window !== 'undefined' && window.WOR_CONFIG && window.WOR_CONFIG.overpassUrl) {
      return window.WOR_CONFIG.overpassUrl;
    }
  } catch (_) {}
  return '/api/overpass';
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

/**
 * Ask the proxy for one bbox worth of POIs.
 *
 * Only the box and the kind travel over the wire; the Overpass QL is built
 * server-side so the endpoint cannot be used to run arbitrary queries.
 *
 * @param {object} bbox {minlat, minlon, maxlat, maxlon}
 * @param {'water'|'coffee'} kind
 * @returns {Promise<string>} Overpass XML
 */
export async function fetchOverpassXml(bbox, kind = 'water', timeoutMs = 30000, fetchImpl) {
  const resp = await fetchWithTimeout(
    getOverpassUrl(),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bbox, kind })
    },
    timeoutMs,
    fetchImpl
  );
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
  const m = /Overpass error:\s*(\d{3})/.exec(err.message || '');
  if (m) return Number(m[1]);
  return undefined;
}

/**
 * Adaptive Overpass fetch, splitting the bbox on 400/429/504.
 *
 * A 400 is treated as splittable because the proxy rejects boxes above its
 * span cap with exactly that status, so an oversized route resolves by
 * subdividing rather than failing.
 *
 * @param {object} bbox
 * @param {function|null} onProgress
 * @param {object} options
 * @param {'water'|'coffee'} [options.kind]
 * @param {function} [options.parseXml] - XML → points (default: water parser)
 */
export async function fetchOverpassPointsAdaptive(bbox, onProgress, options = {}) {
  const minSpan = options.minSpan ?? 0.02;
  const timeoutMs = options.timeoutMs ?? 30000;
  const initialBackoffMs = options.initialBackoffMs ?? 500;
  const maxBackoffMs = options.maxBackoffMs ?? 4000;
  const fetchImpl = options.fetchImpl; // optional for tests
  const kind = options.kind ?? 'water';
  const parseXml = options.parseXml ?? parseOsmXmlForWater;
  // Overpass hands out a small number of slots per client; a couple of
  // requests in flight overlaps the latency without provoking 429s.
  const limit = createLimiter(options.concurrency ?? 2);

  let tilesFetched = 0;

  async function fetchTile(tile, attempt) {
    try {
      // Only the network call is limited, so a parent awaiting its quads is
      // never occupying a slot.
      const xml = await limit(() => fetchOverpassXml(tile, kind, timeoutMs, fetchImpl));
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
        const results = await Promise.all(quads.map((q) => fetchTile(q, attempt + 1)));
        return results.flat();
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
    kind: 'water',
    parseXml: parseOsmXmlForWater,
  });
}

export async function fetchOSMCoffeePointsAdaptive(bbox, onProgress, options = {}) {
  return fetchOverpassPointsAdaptive(bbox, onProgress, {
    ...options,
    kind: 'coffee',
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
