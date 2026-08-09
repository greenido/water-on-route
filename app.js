/**
 * Water on Route — Client App
 * Purpose: Leaflet-based GPX/FIT viewer that finds near-route water points via Overpass
 *          and exports an enriched GPX with waypoints.
 *
 * Dependencies provided by HTML (globals):
 *   - Leaflet (L)
 *   - toGeoJSON
 *   - togpx (loaded on demand if not present)
 *
 * ESM imports:
 *   - fetchOSMWaterPointsAdaptive from ./osmApi.mjs
 *   - parseFitToGeoJSON from ./fitToGeoJSON.mjs
 *   - geometry helpers from ./geo.mjs
 *
 * Each loaded file is persisted at most once (see saveRoute); rendering is a
 * pure view concern and must stay free of side effects.
 *
 * UX features:
 *   - Drag & drop or file picker for GPX / FIT
 *   - Base layer switcher and animated water markers
 *   - Keyboard: '?' help, 'N' new, 'L' load, 'D' download
 */

import {
  fetchOSMWaterPointsAdaptive,
  fetchOSMCoffeePointsAdaptive,
  waterSubtypeLabel,
  rankCoffeePoints,
  sortPointsByDistance,
} from './osmApi.mjs';
import { parseFitToGeoJSON } from './fitToGeoJSON.mjs';
import {
  computeBBoxFromGeoJSON,
  computeRouteLengthKm,
  filterPointsNearRoute,
} from './geo.mjs';

// Basic UI elements
const fileInput = document.getElementById('gpxFile');
const dropZone = document.getElementById('dropZone');
const statusEl = document.getElementById('status');
const errorEl = document.getElementById('error');
let loadingEl = document.getElementById('loading');
const downloadBtn = document.getElementById('downloadBtn');
const radiusSelect = document.getElementById('radiusSelect');
const saveRouteToggle = document.getElementById('saveRouteToggle');
let selectedRadiusMeters = Number(radiusSelect?.value) || 150;

// Whether the user lets us keep their route server-side. Remembered per device;
// the checkbox in the HTML carries the default for a first-time visitor.
const SAVE_ROUTE_PREF_KEY = 'wor.saveRoute';
function readSaveRoutePreference() {
  try {
    const stored = localStorage.getItem(SAVE_ROUTE_PREF_KEY);
    if (stored === 'true' || stored === 'false') return stored === 'true';
  } catch (_) { /* private mode: fall through to the markup default */ }
  return saveRouteToggle ? saveRouteToggle.checked : true;
}
let saveRouteEnabled = readSaveRoutePreference();
if (saveRouteToggle) {
  saveRouteToggle.checked = saveRouteEnabled;
  saveRouteToggle.addEventListener('change', () => {
    saveRouteEnabled = saveRouteToggle.checked;
    try { localStorage.setItem(SAVE_ROUTE_PREF_KEY, String(saveRouteEnabled)); } catch (_) {}
    showToast(saveRouteEnabled ? 'Routes will be saved on the server.' : 'Routes stay in your browser.');
  });
}
// Top nav + help modal elements
const navNewBtn = document.getElementById('navNewBtn');
const navHelpBtn = document.getElementById('navHelpBtn');
const navCoffeeBtn = document.getElementById('navCoffeeBtn');
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

// Define popular base layers
const osmStandard = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  ...baseTileOptions,
  attribution: '© OpenStreetMap contributors'
});
const openTopo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
  ...baseTileOptions,
  maxNativeZoom: 17,
  attribution: 'Map data: © OpenStreetMap contributors, SRTM | Map style: © OpenTopoMap (CC-BY-SA)'
});
const esriWorldImagery = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  ...baseTileOptions,
  maxNativeZoom: 19,
  attribution: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community'
});
const localTiles = (window.WOR_CONFIG && window.WOR_CONFIG.tileUrl)
  ? L.tileLayer(window.WOR_CONFIG.tileUrl, {
      ...baseTileOptions,
      attribution: 'Local tiles | © OpenStreetMap contributors'
    })
  : null;

const baseLayers = {
  'OSM Standard': osmStandard,
  'OpenTopoMap (Terrain)': openTopo,
  'Esri WorldImagery (Satellite)': esriWorldImagery,
  ...(localTiles ? { 'Local Tiles': localTiles } : {})
};

let tileLayer = localTiles || osmStandard;
tileLayer.addTo(map);

// Helper to attach robust retry handlers to any base layer
function attachTileRetryHandlers(layer) {
  if (!layer) return;
  layer.on('tileerror', (e) => {
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
  layer.on('tileload', (e) => {
    if (e && e.tile) e.tile.removeAttribute('data-retry');
  });
}

// Attach retry handlers to all defined base layers
attachTileRetryHandlers(osmStandard);
attachTileRetryHandlers(openTopo);
attachTileRetryHandlers(esriWorldImagery);
attachTileRetryHandlers(localTiles);

// Keep reference to current base layer when user switches
map.on('baselayerchange', (e) => { tileLayer = e.layer; });

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
let coffeeLayer = L.layerGroup().addTo(map);
const baseCoffeeIcon = () => L.divIcon({ className: 'water-marker', html: '☕', iconSize: [24, 24], iconAnchor: [12, 12] });
let originalGpxText = '';
let foundWaterPoints = [];
let foundCoffeePoints = [];
let layersControl = null;
// Name of the file currently loaded, and whether it has already been persisted.
// Guards against re-uploading the same route on every radius change.
let currentRouteFilename = 'route.gpx';
let savedRouteForFile = false;

// Layers control: allow switching base maps and toggling overlays
layersControl = L.control.layers(baseLayers, { 'Water Points': waterLayer, 'Coffee': coffeeLayer }, { collapsed: true }).addTo(map);

// Helpers
function setStatus(msg) { statusEl.textContent = msg || ''; }
function setError(msg) {
  if (!msg) { errorEl.hidden = true; errorEl.textContent = ''; return; }
  errorEl.hidden = false; errorEl.textContent = msg;
}
let toastEl = null;
let toastTimer = null;
function showToast(message, durationMs = 2000) {
  try {
    if (!toastEl) {
      const div = document.createElement('div');
      div.id = 'toast';
      div.className = 'rounded-lg border bg-slate-800 border-slate-700 text-slate-100 shadow-lg px-3 py-2 text-sm';
      div.style.position = 'fixed';
      div.style.left = '50%';
      div.style.transform = 'translateX(-50%)';
      div.style.bottom = '20px';
      div.style.opacity = '0';
      div.style.pointerEvents = 'none';
      div.style.transition = 'opacity 150ms ease';
      div.style.zIndex = '3000';
      document.body.appendChild(div);
      toastEl = div;
    }
    toastEl.textContent = message;
    toastEl.style.opacity = '1';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toastEl) toastEl.style.opacity = '0';
    }, Number.isFinite(durationMs) ? durationMs : 2000);
  } catch (_) {}
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
  if (routeLayer) {
    try { if (layersControl) layersControl.removeLayer(routeLayer); } catch (_) {}
    map.removeLayer(routeLayer);
    routeLayer = null;
  }
  routeLayer = L.geoJSON(geojson, { style: { color: '#3aa7ff', weight: 4 } });
  routeLayer.addTo(map);
  try { if (layersControl) layersControl.addOverlay(routeLayer, 'Route'); } catch (_) {}
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

/**
 * The displayed route as a FeatureCollection, preferring the Leaflet layer so
 * exports match exactly what the user sees.
 */
function currentRouteAsFeatureCollection() {
  const routeGeo = (routeLayer && typeof routeLayer.toGeoJSON === 'function')
    ? routeLayer.toGeoJSON()
    : currentRouteGeoJSON;
  if (!routeGeo) return { type: 'FeatureCollection', features: [] };
  return routeGeo.type === 'FeatureCollection'
    ? routeGeo
    : { type: 'FeatureCollection', features: [routeGeo] };
}

function renderWaterMarkers(points, animate = false) {
  waterLayer.clearLayers();
  points.forEach((p, idx) => {
    const name = p.tags && (p.tags.name || p.tags.description) || 'Water';
    const subtype = waterSubtypeLabel(p.tags);
    const lat = p.lat || p.center?.lat;
    const lon = p.lon || p.center?.lon;
    if (typeof lat !== 'number' || typeof lon !== 'number') return;
    const popup = document.createElement('div');
    const title = document.createElement('b');
    title.textContent = name;
    popup.appendChild(title);
    const subtypeLine = document.createElement('div');
    subtypeLine.textContent = subtype;
    popup.appendChild(subtypeLine);
    if (Number.isFinite(p._distanceM)) {
      const distanceLine = document.createElement('div');
      distanceLine.textContent = `${Math.round(p._distanceM)} m from route`;
      popup.appendChild(distanceLine);
    }
    const mapsLink = document.createElement('a');
    mapsLink.href = `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(5)},${lon.toFixed(5)}`;
    mapsLink.target = '_blank';
    mapsLink.rel = 'noopener';
    mapsLink.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    popup.appendChild(mapsLink);
    const marker = L.marker([lat, lon], { title: name, icon: baseWaterIcon() })
      .bindPopup(popup)
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

/**
 * Persist the loaded route once.
 *
 * This deliberately lives outside renderWaterMarkers: rendering happens again
 * on every radius change, and saving from there uploaded the whole GPX each
 * time, filling the database with duplicates of the same route.
 *
 * @param {Array<object>} points near-route water points at the current radius
 */
async function saveRoute(points) {
  if (!saveRouteEnabled) return;
  if (savedRouteForFile) return;
  if (!currentRouteGeoJSON || !Array.isArray(points) || points.length === 0) return;
  if (!originalGpxText) return;

  savedRouteForFile = true;
  try {
    await ensureToGpxAvailable();
    const routeFC = currentRouteAsFeatureCollection();
    const payload = {
      filename: currentRouteFilename,
      gpxText: originalGpxText,
      bbox: computeBBoxFromGeoJSON(currentRouteGeoJSON),
      routeKm: Number(computeRouteLengthKm(currentRouteGeoJSON).toFixed(2)),
      waypointsCount: points.length,
      waterPoints: points,
      enrichedGpxText: combineToEnrichedGpx(routeFC, points, selectedRadiusMeters)
    };
    const resp = await fetch('/api/routes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  } catch (err) {
    // Saving is best-effort telemetry; never block the user's map on it.
    savedRouteForFile = false;
    console.warn('[saveRoute] failed to save route', err);
  }
}

async function renderCoffeeMarkers(points, animate = false) {
  coffeeLayer.clearLayers();
  points.forEach((p, idx) => {
    const name = p.tags && (p.tags.name || p.tags.brand || p.tags.operator || p.tags.description) || 'Coffee';
    const type = p._type || p.tags?.amenity || p.tags?.shop || 'cafe';
    const lat = p.lat || p.center?.lat;
    const lon = p.lon || p.center?.lon;
    if (typeof lat !== 'number' || typeof lon !== 'number') return;
    // Build address and details
    const tags = p.tags || {};
    const addrParts = [
      tags['addr:housenumber'],
      tags['addr:street'],
    ].filter(Boolean);
    const cityParts = [
      tags['addr:city'] || tags['addr:town'] || tags['addr:village'],
      tags['addr:state'] || tags['addr:province'],
      tags['addr:postcode'],
    ].filter(Boolean);
    const addressLine = addrParts.length ? addrParts.join(' ') : '';
    const cityLine = cityParts.length ? cityParts.join(', ') : '';
    const fullAddress = [addressLine, cityLine].filter(Boolean).join(', ');

    const hours = tags['opening_hours'];
    const phone = tags['phone'] || tags['contact:phone'];
    const website = tags['website'] || tags['contact:website'];
    const operator = tags['operator'];
    const brand = tags['brand'];
    const cuisine = tags['cuisine'];

    const mapsUrl = `https://www.google.com/maps/search/${encodeURIComponent(name)}/@${lat.toFixed(5)},${lon.toFixed(5)},17z`;
    const popup = document.createElement('div');
    const title = document.createElement('b');
    title.textContent = name;
    popup.appendChild(title);

    const addDetail = (label, value) => {
      if (!value) return;
      const line = document.createElement('div');
      line.textContent = label ? `${label}: ${value}` : String(value);
      popup.appendChild(line);
    };
    addDetail('', fullAddress);
    addDetail('Hours', hours);
    if (phone && /^[+0-9().\s-]{3,30}$/.test(phone)) {
      const phoneLine = document.createElement('div');
      phoneLine.append('Phone: ');
      const phoneLink = document.createElement('a');
      phoneLink.href = `tel:${phone}`;
      phoneLink.textContent = phone;
      phoneLine.appendChild(phoneLink);
      popup.appendChild(phoneLine);
    }
    if (website) {
      try {
        const candidate = /^[a-z][a-z0-9+.-]*:/i.test(website) ? website : `https://${website}`;
        const websiteUrl = new URL(candidate);
        if (websiteUrl.protocol === 'http:' || websiteUrl.protocol === 'https:') {
          const websiteLine = document.createElement('div');
          const websiteLink = document.createElement('a');
          websiteLink.href = websiteUrl.href;
          websiteLink.target = '_blank';
          websiteLink.rel = 'noopener';
          websiteLink.textContent = 'Website';
          websiteLine.appendChild(websiteLink);
          popup.appendChild(websiteLine);
        }
      } catch (_) {}
    }
    addDetail('Operator', operator);
    addDetail('Brand', brand);
    addDetail('Cuisine', cuisine);
    const mapsLink = document.createElement('a');
    mapsLink.href = mapsUrl;
    mapsLink.target = '_blank';
    mapsLink.rel = 'noopener';
    mapsLink.textContent = 'Open in Google Maps';
    popup.appendChild(mapsLink);

    const marker = L.marker([lat, lon], { title: name, icon: baseCoffeeIcon() })
      .bindPopup(popup)
      .addTo(coffeeLayer);
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
    if (routeLayer) {
      try { if (layersControl) layersControl.removeLayer(routeLayer); } catch (_) {}
      map.removeLayer(routeLayer);
      routeLayer = null;
    }
    if (waterLayer) { waterLayer.clearLayers(); }
    if (coffeeLayer) { coffeeLayer.clearLayers(); }
    // Reset state
    currentRouteGeoJSON = null;
    originalGpxText = '';
    foundWaterPoints = [];
    foundCoffeePoints = [];
    currentRouteFilename = 'route.gpx';
    savedRouteForFile = false;
    downloadBtn.disabled = true;
    // Clear inputs and status
    if (fileInput) fileInput.value = '';
    if (dropZone && dropZone.classList) dropZone.classList.remove('dragover');
    setStatus('Load a GPX or FIT file to begin.');
    // Re-center view
    centerMapOnUser();
    // Notify user
    showToast('Map cleaned.');
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

function routeFileKind(file) {
  const name = (file?.name || '').toLowerCase();
  if (name.endsWith('.fit')) return 'fit';
  if (name.endsWith('.gpx')) return 'gpx';
  // Fallback by MIME when extension is missing
  const type = (file?.type || '').toLowerCase();
  if (type.includes('gpx') || type.includes('xml')) return 'gpx';
  return null;
}

const MAX_ROUTE_FILE_BYTES = 8 * 1024 * 1024;

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

async function parseFitFile(file) {
  const buffer = await file.arrayBuffer();
  const geojson = await parseFitToGeoJSON(buffer);
  // Persist a GPX representation so admin/original downloads still work
  await ensureToGpxAvailable();
  const toGpxFn = (typeof window !== 'undefined' && window.togpx) || (typeof globalThis !== 'undefined' && globalThis.togpx);
  originalGpxText = typeof toGpxFn === 'function'
    ? toGpxFn(geojson, { creator: 'GPX Water Mapper (from FIT)' })
    : '';
  return geojson;
}

async function parseRouteFile(file) {
  if (file?.size > MAX_ROUTE_FILE_BYTES) {
    throw new Error('File is too large. Please upload a .gpx or .fit file up to 8 MB.');
  }
  const kind = routeFileKind(file);
  if (kind === 'fit') return parseFitFile(file);
  if (kind === 'gpx') return parseGpxFile(file);
  throw new Error('Unsupported file type. Please upload a .gpx or .fit file.');
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
      const type = waterSubtypeLabel(p.tags) || p._type || 'water';
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

/** Storage name for an upload; FIT routes are persisted as their GPX rendering. */
function storageFilenameFor(file) {
  const name = (file?.name || 'route.gpx').trim() || 'route.gpx';
  return /\.fit$/i.test(name) ? name.replace(/\.fit$/i, '.gpx') : name;
}

async function handleRouteFile(file) {
  setError('');
  setStatus(`Parsing ${file.name} …`);
  const geojson = await parseRouteFile(file);
  renderRoute(geojson);
  currentRouteGeoJSON = geojson;
  // A new file is a new route: allow exactly one save for it.
  currentRouteFilename = storageFilenameFor(file);
  savedRouteForFile = false;
  setStatus('Computing bounding box …');
  const bbox = computeBBoxFromGeoJSON(geojson);
  showLoading(true);
  try {
    const backend = (window.WOR_CONFIG && window.WOR_CONFIG.overpassUrl) ? 'planet (Overpass)' : 'OpenStreetMap';
    setStatus(`Querying ${backend} for water points …`);
    const results = await fetchOSMWaterPointsAdaptive(bbox, (done) => {
      setStatus(`Querying ${backend} for water points … (${done})`);
    }, { minSpan: 0.01, initialBackoffMs: 500, maxBackoffMs: 4000, source: 'overpass' });
    foundWaterPoints = results;
    const near = sortPointsByDistance(filterPointsNearRoute(geojson, results, selectedRadiusMeters));
    renderWaterMarkers(near, true);
    setStatus(`Found ${near.length} near-route water points (${results.length} total).`);
    downloadBtn.disabled = false;
    // Save once, after the route is on screen, and never block rendering on it.
    saveRoute(near);
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
  if (f) handleRouteFile(f).catch(err => setError(err.message || String(err)));
});

dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault(); dropZone.classList.remove('dragover');
  const f = e.dataTransfer?.files?.[0];
  if (f) handleRouteFile(f).catch(err => setError(err.message || String(err)));
});

downloadBtn.addEventListener('click', async () => {
  try {
    if (!routeLayer) return;
    await ensureToGpxAvailable();
    const gpx = combineToEnrichedGpx(currentRouteAsFeatureCollection(), foundWaterPoints, selectedRadiusMeters);
    download('enriched.gpx', gpx);
  } catch (e) {
    setError(e.message || String(e));
  }
});

setStatus('Load a GPX or FIT file to begin.');
// Ensure loading overlay is hidden on initial load until a file is processed

console.log('-- Ensuring loading overlay is hidden on initial load until a file is processed');
showLoading(false);

// React to radius changes: re-filter and animate markers
if (radiusSelect) {
  radiusSelect.addEventListener('change', () => {
    const val = Number(radiusSelect.value);
    selectedRadiusMeters = Number.isFinite(val) ? val : selectedRadiusMeters;
    if (!routeLayer) return;
    setStatus(`Updating results for ${selectedRadiusMeters} m …`);
    showLoading(true);
    try {
      const routeFC = currentRouteAsFeatureCollection();
      const msgs = [];
      if (foundWaterPoints.length) {
        const nearW = sortPointsByDistance(filterPointsNearRoute(routeFC, foundWaterPoints, selectedRadiusMeters));
        renderWaterMarkers(nearW, true);
        msgs.push(`water ${nearW.length}/${foundWaterPoints.length}`);
      }
      if (foundCoffeePoints.length) {
        const nearC = rankCoffeePoints(filterPointsNearRoute(routeFC, foundCoffeePoints, selectedRadiusMeters));
        renderCoffeeMarkers(nearC, true);
        msgs.push(`coffee ${nearC.length}/${foundCoffeePoints.length}`);
      }
      if (msgs.length) setStatus(`Updated results for ${selectedRadiusMeters} m — ${msgs.join(', ')}`);
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

if (navCoffeeBtn) {
  navCoffeeBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      setError('');
      if (!routeLayer) { setError('Please load a GPX route first.'); return; }
      const routeFC = currentRouteAsFeatureCollection();
      const bbox = computeBBoxFromGeoJSON(routeFC);
      setStatus('Querying Overpass for coffee …');
      showLoading(true);
      const results = await fetchOSMCoffeePointsAdaptive(bbox, (done) => {
        setStatus(`Querying Overpass for coffee … (${done})`);
      }, { minSpan: 0.01, initialBackoffMs: 500, maxBackoffMs: 4000, source: 'overpass' });
      foundCoffeePoints = results || [];
      const near = rankCoffeePoints(filterPointsNearRoute(routeFC, foundCoffeePoints, selectedRadiusMeters));
      renderCoffeeMarkers(near, true);
      setStatus(`Found ${near.length} near-route coffee places (${foundCoffeePoints.length} total).`);
    } catch (err) {
      console.error(err);
      setError(err.message || String(err));
      setStatus('');
    } finally {
      showLoading(false);
    }
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

  // 'C' triggers coffee search
  if (!isTyping && (e.key === 'C' || e.key === 'c')) {
    if (navCoffeeBtn) {
      e.preventDefault();
      navCoffeeBtn.click();
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


