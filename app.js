// Basic UI elements
const fileInput = document.getElementById('gpxFile');
const dropZone = document.getElementById('dropZone');
const statusEl = document.getElementById('status');
const errorEl = document.getElementById('error');
let loadingEl = document.getElementById('loading');
const downloadBtn = document.getElementById('downloadBtn');
const radiusSelect = document.getElementById('radiusSelect');
let selectedRadiusMeters = Number(radiusSelect?.value) || 150;
// Top nav + help modal elements
const navNewBtn = document.getElementById('navNewBtn');
const navHelpBtn = document.getElementById('navHelpBtn');
const helpModal = document.getElementById('helpModal');
const helpOverlay = document.getElementById('helpOverlay');
const helpPanel = document.getElementById('helpPanel');
const helpCloseBtn = document.getElementById('helpCloseBtn');
const helpOkBtn = document.getElementById('helpOkBtn');

// Remove failing overpass-frontend CDN import; rely on fetch fallback below

// Map setup
const map = L.map('map', { zoomControl: true, zoomAnimation: true });
const tileUrl = (window.WOR_CONFIG && window.WOR_CONFIG.tileUrl) || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const baseTileOptions = {
  // Allow overscaling beyond native zoom to avoid gaps when zooming in
  maxZoom: 22,
  maxNativeZoom: 19,
  attribution: '© OpenStreetMap contributors',
  // Keep nearby tiles around to reduce holes during fast pan/zoom
  keepBuffer: 6,
  // Request tiles when the map is idle to avoid flooding during animation
  updateWhenIdle: true,
  // Ensure CORS works with the proxy and CDN
  crossOrigin: true
};
const tileLayer = L.tileLayer(tileUrl, baseTileOptions).addTo(map);

// Retry failed tiles with light backoff and cache-busting
tileLayer.on('tileerror', (e) => {
  const img = e.tile;
  if (!img) return;
  const tries = Number(img.getAttribute('data-retry') || '0');
  if (tries >= 3) return;
  const src = img.getAttribute('src') || '';
  try {
    const url = new URL(src, window.location.href);
    url.searchParams.set('retry', String(tries + 1));
    url.searchParams.set('_t', String(Date.now()));
    img.setAttribute('data-retry', String(tries + 1));
    const delay = (tries + 1) * 400;
    setTimeout(() => { img.src = url.toString(); }, delay);
  } catch (_) {
    const sep = src.includes('?') ? '&' : '?';
    const next = src + sep + 'retry=' + (tries + 1) + '&_t=' + Date.now();
    img.setAttribute('data-retry', String(tries + 1));
    const delay = (tries + 1) * 400;
    setTimeout(() => { img.src = next; }, delay);
  }
});
tileLayer.on('tileload', (e) => {
  if (e && e.tile) e.tile.removeAttribute('data-retry');
});

// Force a redraw after zoom completes to ensure any missed tiles are requested
map.on('zoomend', () => {
  try { tileLayer.redraw(); } catch (_) {}
});

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
let currentRouteGeoJSON = null;
let waterLayer = L.layerGroup().addTo(map);
const baseWaterIcon = () => L.divIcon({ className: 'water-marker', html: '💧', iconSize: [24, 24], iconAnchor: [12, 12] });
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

// Geometry helpers for proximity filtering
const EARTH_RADIUS_M = 6378137;

function lonLatToWebMercator(lon, lat) {
  const x = EARTH_RADIUS_M * (lon * Math.PI / 180);
  const y = EARTH_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2));
  return [x, y];
}

function pointToSegmentDistanceMeters(p, a, b) {
  // p, a, b are [lon, lat]
  const [px, py] = lonLatToWebMercator(p[0], p[1]);
  const [ax, ay] = lonLatToWebMercator(a[0], a[1]);
  const [bx, by] = lonLatToWebMercator(b[0], b[1]);
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const abLen2 = abx * abx + aby * aby || 1; // avoid div by 0
  let t = (apx * abx + apy * aby) / abLen2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * abx;
  const cy = ay + t * aby;
  const dx = px - cx;
  const dy = py - cy;
  return Math.sqrt(dx * dx + dy * dy);
}

function minDistancePointToLineStringMeters(pointLonLat, lineCoordsLonLat) {
  let min = Infinity;
  for (let i = 1; i < lineCoordsLonLat.length; i++) {
    const d = pointToSegmentDistanceMeters(pointLonLat, lineCoordsLonLat[i - 1], lineCoordsLonLat[i]);
    if (d < min) min = d;
  }
  return min;
}

function extractRouteLineStrings(geojson) {
  const lines = [];
  function addLine(coords) { if (coords && coords.length >= 2) lines.push(coords); }
  function walkGeometry(geom) {
    if (!geom) return;
    if (geom.type === 'LineString') addLine(geom.coordinates);
    else if (geom.type === 'MultiLineString') {
      for (const ls of geom.coordinates) addLine(ls);
    } else if (geom.type === 'GeometryCollection') {
      for (const g of geom.geometries || []) walkGeometry(g);
    }
  }
  if (geojson.type === 'FeatureCollection') {
    for (const f of geojson.features) walkGeometry(f.geometry);
  } else if (geojson.type && geojson.coordinates) {
    walkGeometry(geojson);
  }
  return lines;
}

function filterPointsNearRoute(geojsonRoute, points, maxMeters) {
  const lineStrings = extractRouteLineStrings(geojsonRoute);
  if (!lineStrings.length) return [];
  const result = [];
  for (const p of points) {
    const lat = p.lat ?? p.center?.lat;
    const lon = p.lon ?? p.center?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const pt = [lon, lat];
    let min = Infinity;
    for (const ls of lineStrings) {
      const d = minDistancePointToLineStringMeters(pt, ls);
      if (d < min) min = d;
      if (min <= maxMeters) break;
    }
    if (min <= maxMeters) result.push(p);
  }
  return result;
}

function renderRoute(geojson) {
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
  routeLayer = L.geoJSON(geojson, { style: { color: '#3aa7ff', weight: 4 } });
  routeLayer.addTo(map);
  fitMapToGeoJSON(geojson);
}

// Ensure GPX exporter is available (supports global UMD or dynamic load)
let ensureToGpxPromise;
function ensureToGpxAvailable() {
  if (ensureToGpxPromise) return ensureToGpxPromise;
  ensureToGpxPromise = new Promise(async (resolve, reject) => {
    try {
      if (typeof window !== 'undefined' && typeof window.togpx === 'function') {
        return resolve(window.togpx);
      }
      // Try loading classic UMD script
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/togpx@0.5.6/togpx.js';
        s.async = true;
        s.onload = () => res();
        s.onerror = () => rej(new Error('Failed to load togpx UMD'));
        document.head.appendChild(s);
      });
      if (typeof window !== 'undefined' && typeof window.togpx === 'function') {
        return resolve(window.togpx);
      }
      // Fallback: dynamic ESM shim
      try {
        const mod = await import('https://esm.sh/togpx@0.5.6');
        const fn = mod?.default || mod?.togpx;
        if (typeof fn === 'function') {
          if (typeof window !== 'undefined') window.togpx = fn;
          return resolve(fn);
        }
      } catch (_) {}
      reject(new Error('GPX exporter not loaded.'));
    } catch (e) {
      reject(e);
    }
  });
  return ensureToGpxPromise;
}

function renderWaterMarkers(points, animate = false) {
  waterLayer.clearLayers();
  points.forEach((p, idx) => {
    const name = p.tags && (p.tags.name || p.tags.description) || 'Water';
    const type = p._type || p.tags?.amenity || p.tags?.natural || p.tags?.man_made || 'water';
    const lat = p.lat || p.center?.lat;
    const lon = p.lon || p.center?.lon;
    if (typeof lat !== 'number' || typeof lon !== 'number') return;
    const typeDisplay = p._type === 'node' ? 'node 🚰' : type;
    const marker = L.marker([lat, lon], { title: name, icon: baseWaterIcon() })
      .bindPopup(`<b>${name}</b><br>Type: ${typeDisplay}<br>${lat.toFixed(5)}, ${lon.toFixed(5)}`)
      .addTo(waterLayer);
    if (animate) {
      marker.on('add', () => {
        requestAnimationFrame(() => {
          const el = marker.getElement();
          if (el) {
            el.classList.add('drop-anim');
            el.style.animationDelay = `${Math.min(idx * 15, 600)}ms`;
          }
        });
      });
    }
  });
}

// Reset app state and UI
function resetApp() {
  try {
    setError('');
    // Remove layers
    if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
    if (waterLayer) { waterLayer.clearLayers(); }
    // Reset state
    currentRouteGeoJSON = null;
    originalGpxText = '';
    foundWaterPoints = [];
    downloadBtn.disabled = true;
    // Clear inputs and status
    if (fileInput) fileInput.value = '';
    if (dropZone && dropZone.classList) dropZone.classList.remove('dragover');
    setStatus('Load a GPX file to begin.');
    // Re-center view
    centerMapOnUser();
  } catch (_) {}
}

// Help modal controls
function showHelpModal(show) {
  if (!helpModal) return;
  const isShow = !!show;
  const focusableSelectors = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';
  const focusTrap = () => {
    if (!isShow) return;
    const focusables = helpModal.querySelectorAll(focusableSelectors);
    if (focusables.length) {
      const first = helpPanel || focusables[0];
      if (first && typeof first.focus === 'function') first.focus();
    }
  };
  if (isShow) {
    helpModal.classList.remove('hidden');
    helpModal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    if (helpOverlay) helpOverlay.classList.add('opacity-100');
    if (helpPanel) {
      helpPanel.classList.remove('opacity-0', 'translate-y-4', 'scale-95');
    }
    setTimeout(focusTrap, 0);
  } else {
    helpModal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    if (helpOverlay) helpOverlay.classList.remove('opacity-100');
    if (helpPanel) {
      helpPanel.classList.add('opacity-0', 'translate-y-4', 'scale-95');
    }
    // Wait for fade before hiding
    setTimeout(() => { helpModal.classList.add('hidden'); }, 180);
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

function combineToEnrichedGpx(geojsonRoute, waterPoints, radiusMeters) {
  // Only include water points close to the route per selected radius
  const nearPoints = filterPointsNearRoute(geojsonRoute, waterPoints, radiusMeters);
  const waypointFeatures = nearPoints
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
  const toGpxFn = (typeof window !== 'undefined' && window.togpx) || (typeof globalThis !== 'undefined' && globalThis.togpx);
  if (typeof toGpxFn !== 'function') {
    throw new Error('GPX exporter not loaded. Please ensure togpx is available.');
  }
  const gpxText = toGpxFn(combined, { creator: 'GPX Water Mapper' });
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
  currentRouteGeoJSON = geojson;
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
    const near = filterPointsNearRoute(geojson, results, selectedRadiusMeters);
    renderWaterMarkers(near, true);
    setStatus(`Found ${near.length} near-route water points (${results.length} total).`);
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

downloadBtn.addEventListener('click', async () => {
  try {
    if (!routeLayer) return;
    await ensureToGpxAvailable();
    // Reconstruct route GeoJSON from displayed layer for robustness
    const routeGeo = routeLayer.toGeoJSON();
    const routeFC = routeGeo.type === 'FeatureCollection' ? routeGeo : { type: 'FeatureCollection', features: [routeGeo] };
    const gpx = combineToEnrichedGpx(routeFC, foundWaterPoints, selectedRadiusMeters);
    download('enriched.gpx', gpx);
  } catch (e) {
    setError(e.message || String(e));
  }
});

setStatus('Load a GPX file to begin.');
// Ensure loading overlay is hidden on initial load until a file is processed

console.log('Ensuring loading overlay is hidden on initial load until a file is processed');
showLoading(false);

// React to radius changes: re-filter and animate markers
if (radiusSelect) {
  radiusSelect.addEventListener('change', () => {
    const val = Number(radiusSelect.value);
    selectedRadiusMeters = Number.isFinite(val) ? val : selectedRadiusMeters;
    if (!routeLayer || !foundWaterPoints.length) return;
    setStatus(`Updating results for ${selectedRadiusMeters} m …`);
    showLoading(true);
    try {
      const routeGeo = routeLayer.toGeoJSON();
      const routeFC = routeGeo.type === 'FeatureCollection' ? routeGeo : { type: 'FeatureCollection', features: [routeGeo] };
      const near = filterPointsNearRoute(routeFC, foundWaterPoints, selectedRadiusMeters);
      renderWaterMarkers(near, true);
      setStatus(`Found ${near.length} near-route water points (${foundWaterPoints.length} total).`);
    } catch (e) {
      console.error(e);
      setError(e.message || String(e));
    } finally {
      showLoading(false);
    }
  });
}

// Wire top nav and help modal events
if (navNewBtn) {
  navNewBtn.addEventListener('click', (e) => {
    e.preventDefault();
    resetApp();
  });
}

function bindHideHelp() {
  showHelpModal(false);
}

if (navHelpBtn) {
  navHelpBtn.addEventListener('click', (e) => {
    e.preventDefault();
    showHelpModal(true);
  });
}
if (helpOverlay) helpOverlay.addEventListener('click', bindHideHelp);
if (helpCloseBtn) helpCloseBtn.addEventListener('click', bindHideHelp);
if (helpOkBtn) helpOkBtn.addEventListener('click', bindHideHelp);

// ESC to close, trap focus within the modal
document.addEventListener('keydown', (e) => {
  // Global shortcuts (only when not typing in input fields)
  const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
  const isTyping = tag === 'input' || tag === 'textarea' || tag === 'select' || (e.target && e.target.isContentEditable);

  // '?' opens Help (Shift+/ is '?')
  if (!isTyping && (e.key === '?' || (e.key === '/' && e.shiftKey))) {
    e.preventDefault();
    showHelpModal(true);
    return;
  }
  // 'N' opens New (reset)
  if (!isTyping && (e.key === 'N' || e.key === 'n')) {
    e.preventDefault();
    resetApp();
    return;
  }
  // 'L' opens file chooser
  if (!isTyping && (e.key === 'L' || e.key === 'l')) {
    e.preventDefault();
    if (fileInput) fileInput.click();
    return;
  }
  // 'D' downloads enriched GPX
  if (!isTyping && (e.key === 'D' || e.key === 'd')) {
    if (downloadBtn && !downloadBtn.disabled) {
      e.preventDefault();
      downloadBtn.click();
      return;
    }
  }

  // Modal-only keys
  const modalOpen = helpModal && !helpModal.classList.contains('hidden');
  if (!modalOpen) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    showHelpModal(false);
    return;
  }
  if (e.key === 'Tab') {
    const focusableSelectors = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';
    const focusables = helpModal.querySelectorAll(focusableSelectors);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }
});


