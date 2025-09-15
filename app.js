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
const tileUrl = (window.WOR_CONFIG && window.WOR_CONFIG.tileUrl) || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
L.tileLayer(tileUrl, {
  maxZoom: 19,
  attribution: '© OpenStreetMap contributors'
}).addTo(map);

// Center on user's current location at startup
function centerMapOnUser() {
  try {
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const { latitude, longitude } = pos.coords;
          map.setView([latitude, longitude], 13);
        },
        () => {
          // fallback view
          map.setView([20, 0], 2);
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
      );
    } else {
      map.setView([20, 0], 2);
    }
  } catch (_) {
    map.setView([20, 0], 2);
  }
}
centerMapOnUser();

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

// Import adaptive OSM utilities
import { fetchOSMWaterPointsAdaptive } from './osmApi.js';

async function handleGpx(file) {
  setError('');
  setStatus(`Parsing ${file.name} …`);
  const geojson = await parseGpxFile(file);
  renderRoute(geojson);
  setStatus('Computing bounding box …');
  const bbox = computeBBoxFromGeoJSON(geojson);
  showLoading(true);
  try {
    const backend = (window.WOR_CONFIG && window.WOR_CONFIG.overpassUrl) ? 'planet (Overpass)' : 'OpenStreetMap';
    setStatus(`Querying ${backend} for water points …`);
    let results = [];
    results = await fetchOSMWaterPointsAdaptive(bbox, (done) => {
      setStatus(`Querying ${backend} for water points … (${done})`);
    }, { minSpan: 0.01, initialBackoffMs: 500, maxBackoffMs: 4000, source: 'overpass' });
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


