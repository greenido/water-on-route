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

export function buildOverpassWaterQuery(b) {
  const bboxPart = `${b.minlat},${b.minlon},${b.maxlat},${b.maxlon}`; // lat,lon order for Overpass bbox
  return `
    [out:xml][timeout:25];
    (
      node["amenity"="drinking_water"](${bboxPart});
      node["natural"="spring"](${bboxPart});
      node["man_made"="water_tap"](${bboxPart});
      way["amenity"="drinking_water"](${bboxPart});
      way["natural"="spring"](${bboxPart});
      way["man_made"="water_tap"](${bboxPart});
      relation["amenity"="drinking_water"](${bboxPart});
      relation["natural"="spring"](${bboxPart});
      relation["man_made"="water_tap"](${bboxPart});
    );
    out body center qt;
  `;
}

export async function fetchOverpassXml(bbox, timeoutMs = 30000, fetchImpl) {
  const url = getOverpassUrl();
  const query = buildOverpassWaterQuery(bbox);
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

export function parseOsmXmlForWater(xmlText) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(xmlText, 'application/xml');
  const results = [];

  // Nodes
  const nodeEls = Array.from(xml.getElementsByTagName('node'));
  for (const node of nodeEls) {
    const tagEls = Array.from(node.getElementsByTagName('tag'));
    const tags = {};
    for (const t of tagEls) {
      const k = t.getAttribute('k');
      const v = t.getAttribute('v');
      if (k) tags[k] = v;
    }
    const amenity = tags['amenity'];
    const naturalTag = tags['natural'];
    const manMade = tags['man_made'];
    if (amenity === 'drinking_water' || naturalTag === 'spring' || manMade === 'water_tap') {
      const id = Number(node.getAttribute('id'));
      const lat = Number(node.getAttribute('lat'));
      const lon = Number(node.getAttribute('lon'));
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        results.push({ id, lat, lon, tags, _type: 'node' });
      }
    }
  }

  // Ways (from Overpass, with optional <center lat="" lon=""/>)
  const wayEls = Array.from(xml.getElementsByTagName('way'));
  for (const way of wayEls) {
    const tagEls = Array.from(way.getElementsByTagName('tag'));
    const tags = {};
    for (const t of tagEls) {
      const k = t.getAttribute('k');
      const v = t.getAttribute('v');
      if (k) tags[k] = v;
    }
    const amenity = tags['amenity'];
    const naturalTag = tags['natural'];
    const manMade = tags['man_made'];
    if (amenity === 'drinking_water' || naturalTag === 'spring' || manMade === 'water_tap') {
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
  }

  // Relations (from Overpass, with optional <center/>)
  const relEls = Array.from(xml.getElementsByTagName('relation'));
  for (const rel of relEls) {
    const tagEls = Array.from(rel.getElementsByTagName('tag'));
    const tags = {};
    for (const t of tagEls) {
      const k = t.getAttribute('k');
      const v = t.getAttribute('v');
      if (k) tags[k] = v;
    }
    const amenity = tags['amenity'];
    const naturalTag = tags['natural'];
    const manMade = tags['man_made'];
    if (amenity === 'drinking_water' || naturalTag === 'spring' || manMade === 'water_tap') {
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

function getStatusFromError(err) {
  if (!err) return undefined;
  if (typeof err.status === 'number') return err.status;
  const m = /OSM API error:\s*(\d{3})/.exec(err.message || '');
  if (m) return Number(m[1]);
  return undefined;
}

export async function fetchOSMWaterPointsAdaptive(bbox, onProgress, options = {}) {
  const minSpan = options.minSpan ?? 0.02;
  const timeoutMs = options.timeoutMs ?? 30000;
  const initialBackoffMs = options.initialBackoffMs ?? 500;
  const maxBackoffMs = options.maxBackoffMs ?? 4000;
  const fetchImpl = options.fetchImpl; // optional for tests
  const source = options.source ?? 'overpass'; // 'overpass' (default) or 'osm'

  let tilesFetched = 0;

  async function fetchTile(tile, attempt) {
    try {
      const xml = source === 'overpass'
        ? await fetchOverpassXml(tile, timeoutMs, fetchImpl)
        : await fetchOsmMapXml(tile, timeoutMs, fetchImpl);
      tilesFetched++;
      if (onProgress) onProgress(tilesFetched, undefined);
      return parseOsmXmlForWater(xml);
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

  return fetchTile(bbox, 0);
}


