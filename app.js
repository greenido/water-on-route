// Basic UI elements
const fileInput = document.getElementById('gpxFile');
const dropZone = document.getElementById('dropZone');
const statusEl = document.getElementById('status');
const errorEl = document.getElementById('error');
let loadingEl = document.getElementById('loading');
const downloadBtn = document.getElementById('downloadBtn');

// Remove failing overpass-frontend CDN import; rely on fetch fallback below

// Map setup
const map = L.map('map', { zoomControl: true });
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap contributors'
}).addTo(map);

let routeLayer = null;
let waterLayer = L.layerGroup().addTo(map);
const waterIcon = L.divIcon({ className: 'water-marker', html: '💧', iconSize: [24, 24], iconAnchor: [12, 12] });
let originalGpxText = '';
let foundWaterPoints = [];

// Helpers
function setStatus(msg) { statusEl.textContent = msg || ''; }
function setError(msg) {
  if (!msg) { errorEl.hidden = true; errorEl.textContent = ''; return; }
  errorEl.hidden = false; errorEl.textContent = msg;
}
function ensureLoadingEl() {
  if (!loadingEl) {
    const div = document.createElement('div');
    div.id = 'loading';
    div.className = 'fixed inset-0 place-content-center gap-3 bg-black/60 z-50 text-center';
    div.innerHTML = '<div class="spinner"></div><div class="text-slate-200">Fetching water points…</div>';
    div.hidden = true;
    document.body.appendChild(div);
    loadingEl = div;
  }
  return loadingEl;
}

function showLoading(show) {
  if (show && !loadingEl) ensureLoadingEl();
  if (!loadingEl) return;
  loadingEl.hidden = !show;
  loadingEl.classList.toggle('show', !!show);
  loadingEl.style.display = show ? 'grid' : 'none';
}

function computeBBoxFromGeoJSON(geojson) {
  let minLat =  90, maxLat = -90, minLon =  180, maxLon = -180;
  function update([lon, lat]) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  function walkCoords(coords) {
    if (typeof coords[0] === 'number') {
      update(coords);
    } else {
      for (const c of coords) walkCoords(c);
    }
  }
  if (geojson.type === 'FeatureCollection') {
    for (const f of geojson.features) {
      const g = f.geometry;
      if (g && g.coordinates) walkCoords(g.coordinates);
    }
  } else if (geojson.type && geojson.coordinates) {
    walkCoords(geojson.coordinates);
  }
  return { minlat: minLat, minlon: minLon, maxlat: maxLat, maxlon: maxLon };
}

function fitMapToGeoJSON(geojson) {
  const bounds = [];
  function add([lon, lat]) { bounds.push([lat, lon]); }
  function walk(coords) {
    if (typeof coords[0] === 'number') add(coords);
    else for (const c of coords) walk(c);
  }
  if (geojson.type === 'FeatureCollection') {
    for (const f of geojson.features) {
      const g = f.geometry; if (g) walk(g.coordinates);
    }
  } else if (geojson.type && geojson.coordinates) { walk(geojson.coordinates); }
  if (bounds.length) map.fitBounds(bounds);
}

function renderRoute(geojson) {
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
  routeLayer = L.geoJSON(geojson, { style: { color: '#3aa7ff', weight: 4 } });
  routeLayer.addTo(map);
  fitMapToGeoJSON(geojson);
}

function renderWaterMarkers(points) {
  waterLayer.clearLayers();
  for (const p of points) {
    const name = p.tags && (p.tags.name || p.tags.description) || 'Water';
    const type = p._type || p.tags?.amenity || p.tags?.natural || p.tags?.man_made || 'water';
    const lat = p.lat || p.center?.lat;
    const lon = p.lon || p.center?.lon;
    if (typeof lat !== 'number' || typeof lon !== 'number') continue;
    L.marker([lat, lon], { title: name, icon: waterIcon })
      .bindPopup(`<b>${name}</b><br>Type: ${type}<br>${lat.toFixed(5)}, ${lon.toFixed(5)}`)
      .addTo(waterLayer);
  }
}

async function parseGpxFile(file) {
  const text = await file.text();
  originalGpxText = text;
  const parser = new DOMParser();
  const xml = parser.parseFromString(text, 'application/xml');
  const geojson = toGeoJSON.gpx(xml);
  if (!geojson || !geojson.features || geojson.features.length === 0) {
    throw new Error('No features found in GPX.');
  }
  return geojson;
}

function combineToEnrichedGpx(geojsonRoute, waterPoints) {
  const waypointFeatures = waterPoints
    .filter(p => typeof (p.lat ?? p.center?.lat) === 'number' && typeof (p.lon ?? p.center?.lon) === 'number')
    .map(p => {
      const lat = p.lat ?? p.center.lat;
      const lon = p.lon ?? p.center.lon;
      const name = p.tags?.name || p.tags?.description || 'Water';
      const type = p._type || p.tags?.amenity || p.tags?.natural || p.tags?.man_made || 'water';
      return {
        type: 'Feature',
        properties: { name, type },
        geometry: { type: 'Point', coordinates: [lon, lat] }
      };
    });
  const combined = {
    type: 'FeatureCollection',
    features: [...geojsonRoute.features, ...waypointFeatures]
  };
  const gpxText = togpx(combined, { creator: 'GPX Water Mapper' });
  return gpxText;
}

function download(filename, text) {
  const blob = new Blob([text], { type: 'application/gpx+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// Overpass helpers: mirrors, timeout, retry/backoff, tiling
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.nchc.org.tw/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

function buildOverpassQuery(bbox) {
  const bboxStr = `${bbox.minlat},${bbox.minlon},${bbox.maxlat},${bbox.maxlon}`;
  return `
    [out:json][timeout:60];
    (
      node["amenity"="drinking_water"](${bboxStr});
      node["natural"="spring"](${bboxStr});
      node["man_made"="water_tap"](${bboxStr});
    );
    out body center;`;
}

async function requestOverpass(query, endpoints = OVERPASS_ENDPOINTS, perEndpointRetries = 2, timeoutMs = 30000) {
  let lastError = null;
  for (const endpoint of endpoints) {
    for (let attempt = 0; attempt <= perEndpointRetries; attempt++) {
      try {
        const resp = await fetchWithTimeout(endpoint, { method: 'POST', body: query }, timeoutMs);
        if (!resp.ok) {
          // Retry on 429, 502, 503, 504
          if ([429, 502, 503, 504].includes(resp.status)) {
            lastError = new Error(`Overpass error: ${resp.status}`);
            const backoff = Math.min(1000 * Math.pow(2, attempt), 8000);
            await sleep(backoff);
            continue;
          }
          throw new Error(`Overpass error: ${resp.status}`);
        }
        return await resp.json();
      } catch (err) {
        lastError = err;
        // AbortError or network: retry
        const isAbort = err && (err.name === 'AbortError' || err.message?.includes('aborted'));
        if (isAbort || err.message?.includes('NetworkError') || err.message?.includes('Failed to fetch')) {
          const backoff = Math.min(1000 * Math.pow(2, attempt), 8000);
          await sleep(backoff);
          continue;
        }
        // other errors: try next endpoint
        break;
      }
    }
    // try next endpoint
  }
  throw lastError || new Error('Overpass request failed');
}

function splitBbox(bbox, maxSpan = 0.5) {
  const latSpan = Math.max(0, bbox.maxlat - bbox.minlat);
  const lonSpan = Math.max(0, bbox.maxlon - bbox.minlon);
  const latTiles = Math.max(1, Math.ceil(latSpan / maxSpan));
  const lonTiles = Math.max(1, Math.ceil(lonSpan / maxSpan));
  const tiles = [];
  for (let i = 0; i < latTiles; i++) {
    const minlat = bbox.minlat + (latSpan * i) / latTiles;
    const maxlat = bbox.minlat + (latSpan * (i + 1)) / latTiles;
    for (let j = 0; j < lonTiles; j++) {
      const minlon = bbox.minlon + (lonSpan * j) / lonTiles;
      const maxlon = bbox.minlon + (lonSpan * (j + 1)) / lonTiles;
      tiles.push({ minlat, minlon, maxlat, maxlon });
    }
  }
  return tiles;
}

async function runWithConcurrency(items, limit, worker, onProgress) {
  let index = 0;
  let completed = 0;
  const results = new Array(items.length);
  async function next() {
    const current = index++;
    if (current >= items.length) return;
    try {
      results[current] = await worker(items[current], current);
    } finally {
      completed++;
      if (onProgress) onProgress(completed, items.length);
      await next();
    }
  }
  const starters = [];
  for (let k = 0; k < Math.min(limit, items.length); k++) starters.push(next());
  await Promise.all(starters);
  return results;
}

function normalizeNodes(data) {
  const nodes = (data.elements || []).filter(e => e.type === 'node');
  return nodes.map(n => ({ id: n.id, lat: n.lat, lon: n.lon, tags: n.tags, _type: 'node' }));
}

async function fetchOverpassWaterPoints(bbox, onProgress) {
  const tiles = splitBbox(bbox, 0.5);
  const all = await runWithConcurrency(tiles, 2, async (tile) => {
    const query = buildOverpassQuery(tile);
    const json = await requestOverpass(query);
    return normalizeNodes(json);
  }, onProgress);
  const dedup = new Map();
  for (const arr of all) {
    for (const n of (arr || [])) {
      if (!dedup.has(n.id)) dedup.set(n.id, n);
    }
  }
  return Array.from(dedup.values());
}

async function handleGpx(file) {
  setError('');
  setStatus(`Parsing ${file.name} …`);
  const geojson = await parseGpxFile(file);
  renderRoute(geojson);
  setStatus('Computing bounding box …');
  const bbox = computeBBoxFromGeoJSON(geojson);
  showLoading(true);
  try {
    setStatus('Querying OpenStreetMap (Overpass) for water points …');
    // Prefer robust fetch with mirrors/tiling; fall back to OverpassFrontend if present and fetch fails
    let results = [];
    try {
      results = await fetchOverpassWaterPoints(bbox, (done, total) => {
        setStatus(`Querying Overpass for water points … (${done}/${total})`);
      });
    } catch (primaryErr) {
      if (window.OverpassFrontend) {
        try {
          results = await new Promise((resolve, reject) => {
            const of = new window.OverpassFrontend('//overpass-api.de/api/interpreter');
            const acc = [];
            const q = 'node["amenity"="drinking_water"];node["natural"="spring"];node["man_made"="water_tap"];';
            of.BBoxQuery(q, bbox, { properties: window.OverpassFrontend.ALL }, (err, ob) => {
              if (err) { reject(err); return; }
              acc.push({ id: ob.id, lat: ob.lat, lon: ob.lon, center: ob.center, tags: ob.tags, _type: ob.type });
            }, (err) => {
              if (err) reject(err); else resolve(acc);
            });
          });
        } catch (fallbackErr) {
          throw primaryErr;
        }
      } else {
        throw primaryErr;
      }
    }
    foundWaterPoints = results;
    renderWaterMarkers(results);
    setStatus(`Found ${results.length} water points.`);
    downloadBtn.disabled = false;
  } catch (e) {
    console.error(e);
    setError(e.message || String(e));
    setStatus('');
  } finally {
    showLoading(false);
  }
}

// Events
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) handleGpx(f).catch(err => setError(err.message || String(err)));
});

dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault(); dropZone.classList.remove('dragover');
  const f = e.dataTransfer?.files?.[0];
  if (f) handleGpx(f).catch(err => setError(err.message || String(err)));
});

downloadBtn.addEventListener('click', () => {
  try {
    if (!routeLayer) return;
    // Reconstruct route GeoJSON from displayed layer for robustness
    const routeGeo = routeLayer.toGeoJSON();
    const routeFC = routeGeo.type === 'FeatureCollection' ? routeGeo : { type: 'FeatureCollection', features: [routeGeo] };
    const gpx = combineToEnrichedGpx(routeFC, foundWaterPoints);
    download('enriched.gpx', gpx);
  } catch (e) {
    setError(e.message || String(e));
  }
});

setStatus('Load a GPX file to begin.');
// Ensure loading overlay is hidden on initial load until a file is processed

console.log('Ensuring loading overlay is hidden on initial load until a file is processed');
showLoading(false);


