/**
 * Water on Route — Client App
 * Purpose: Leaflet-based GPX/FIT viewer that finds near-route water points via Overpass
 *          and exports an enriched GPX with waypoints.
 *
 * Dependencies provided by HTML (globals), each pinned with an SRI hash:
 *   - Leaflet (L)
 *   - toGeoJSON
 *   - togpx
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
 *   - Keyboard: '?' help, 'N' new, 'L' load, 'D' download, 'F' refill, 'C' coffee
 */

import {
  fetchOSMWaterPointsAdaptive,
  fetchOSMCoffeePointsAdaptive,
  fetchOSMRefillPointsAdaptive,
  waterSubtypeLabel,
  rankCoffeePoints,
  rankRefillPoints,
  refillLabel,
  refillConfidence,
  refillExpectation,
} from './osmApi.mjs';
import { parseFitToGeoJSON } from './fitToGeoJSON.mjs';
import {
  computeBBoxFromGeoJSON,
  computeRouteLengthKm,
  filterPointsNearRoute,
  buildRouteIndex,
  sortPointsAlongRoute,
  longestDryStretch,
  elevationProfile,
  formatKm,
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
const summaryEl = document.getElementById('summary');
const summaryDistanceEl = document.getElementById('summaryDistance');
const summaryCountEl = document.getElementById('summaryCount');
const dryStretchEl = document.getElementById('dryStretch');
const dryStretchValueEl = document.getElementById('dryStretchValue');
const refillEffectEl = document.getElementById('refillEffect');
const waterListEl = document.getElementById('waterList');
const profilePanel = document.getElementById('profilePanel');
const profileSvg = document.getElementById('profile');
const profileHint = document.getElementById('profileHint');
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
const navRefillBtn = document.getElementById('navRefillBtn');
const helpModal = document.getElementById('helpModal');
const helpOverlay = document.getElementById('helpOverlay');
const helpPanel = document.getElementById('helpPanel');
const helpCloseBtn = document.getElementById('helpCloseBtn');
const helpOkBtn = document.getElementById('helpOkBtn');

// Map setup
const map = L.map('map', { zoomControl: true, zoomAnimation: true });
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
let refillLayer = L.layerGroup().addTo(map);
// Distinct glyphs per tier: a guaranteed tap and a "worth a try" cemetery
// should not look identical on the map.
const REFILL_ICONS = { certain: '🚰', likely: '⛽', maybe: '🚻' };
const refillIcon = (confidence) => L.divIcon({
  className: `water-marker refill-${confidence}`,
  html: REFILL_ICONS[confidence] || REFILL_ICONS.maybe,
  iconSize: [24, 24],
  iconAnchor: [12, 12]
});
let coffeeLayer = L.layerGroup().addTo(map);
const baseCoffeeIcon = () => L.divIcon({ className: 'water-marker', html: '☕', iconSize: [24, 24], iconAnchor: [12, 12] });
let originalGpxText = '';
let foundWaterPoints = [];
let foundCoffeePoints = [];
let foundRefillPoints = [];
let nearRefillPoints = [];
// The near-route water points currently drawn, so a refill search arriving
// later can redraw the summary without re-filtering water.
let lastNearWaterPoints = [];
let layersControl = null;
// Name of the file currently loaded, and whether it has already been persisted.
// Guards against re-uploading the same route on every radius change.
let currentRouteFilename = 'route.gpx';
let savedRouteForFile = false;
// Route projected once per file; radius changes and exports reuse it.
let currentRouteIndex = null;
let currentRouteKm = 0;

// Layers control: allow switching base maps and toggling overlays
layersControl = L.control.layers(baseLayers, { 'Water Points': waterLayer, 'Refill Stops': refillLayer, 'Coffee': coffeeLayer }, { collapsed: true }).addTo(map);

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

/**
 * The GPX exporter, loaded by index.html with an SRI hash.
 *
 * This used to fall back to injecting togpx 0.5.6 from jsdelivr and then to
 * importing it from esm.sh. Neither could ever run: index.html always defines
 * window.togpx first, the injected copy was a different version than the
 * pinned one, and esm.sh is not in the page's script-src, so the import was
 * blocked by CSP. A missing exporter is a broken deployment, so say that.
 *
 * @returns {Function} togpx
 */
function requireToGpx() {
  const toGpx = typeof window !== 'undefined' ? window.togpx : undefined;
  if (typeof toGpx !== 'function') {
    throw new Error('GPX exporter failed to load. Check your connection and reload the page.');
  }
  return toGpx;
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

/**
 * Colour the dry-stretch callout by how much trouble it represents.
 * Thresholds are deliberately conservative: 25 km is roughly an hour of
 * riding, which is about as long as one bottle lasts in the heat.
 */
function dryStretchSeverity(gapKm) {
  if (gapKm >= 40) return { tone: 'border-red-500/50 bg-red-500/10 text-red-200', note: 'carry extra' };
  if (gapKm >= 25) return { tone: 'border-amber-500/50 bg-amber-500/10 text-amber-200', note: 'top up before it' };
  return { tone: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200', note: 'comfortable' };
}

/**
 * Second line under the dry stretch: how far the gap shrinks once refill
 * stops are counted. Hidden until a refill search has actually run.
 */
function renderRefillEffect(waterOnlyDry) {
  if (!refillEffectEl) return;
  if (!nearRefillPoints.length) {
    refillEffectEl.hidden = true;
    return;
  }
  refillEffectEl.hidden = false;
  const combined = longestDryStretch(currentRouteKm, [...lastNearWaterPoints, ...nearRefillPoints]);
  const saved = waterOnlyDry.gapKm - combined.gapKm;
  const count = nearRefillPoints.length;
  const plural = count === 1 ? 'refill stop' : 'refill stops';
  refillEffectEl.textContent = saved > 0.05
    ? `With ${count} ${plural}: ${formatKm(combined.gapKm)} km (km ${formatKm(combined.startKm)} to ${formatKm(combined.endKm)})`
    : `${count} ${plural} found, but none inside the dry stretch`;
}

/** Sidebar summary: distance, count, worst gap, and the stops in ride order. */
function renderSummary(points) {
  if (!summaryEl) return;
  if (!currentRouteIndex || currentRouteIndex.isEmpty) {
    summaryEl.hidden = true;
    return;
  }
  summaryEl.hidden = false;
  summaryDistanceEl.textContent = `${formatKm(currentRouteKm)} km`;
  summaryCountEl.textContent = String(points.length);

  const dry = longestDryStretch(currentRouteKm, points);
  const severity = dryStretchSeverity(dry.gapKm);
  dryStretchEl.className = `rounded-md border px-3 py-2 text-sm ${severity.tone}`;
  dryStretchValueEl.textContent = points.length
    ? `${formatKm(dry.gapKm)} km — km ${formatKm(dry.startKm)} to ${formatKm(dry.endKm)} (${severity.note})`
    : `${formatKm(dry.gapKm)} km — no water found on this route`;

  // The reason refill stops exist: show what they do to the worst gap. Kept as
  // a separate line rather than folded into the headline number, because a
  // fuel station is not the same promise as a tagged tap.
  renderRefillEffect(dry);

  waterListEl.replaceChildren();
  for (const p of points) {
    const li = document.createElement('li');
    li.className = 'flex items-baseline gap-2 text-slate-300';
    const km = document.createElement('span');
    km.className = 'tabular-nums text-slate-400 w-16 shrink-0';
    km.textContent = Number.isFinite(p._alongKm) ? `km ${formatKm(p._alongKm)}` : '—';
    const label = document.createElement('span');
    label.className = 'truncate';
    label.textContent = (p.tags && (p.tags.name || p.tags.description)) || waterSubtypeLabel(p.tags);
    li.append(km, label);
    waterListEl.appendChild(li);
  }
}

/**
 * Compact elevation strip with a tick for every water point.
 *
 * Drawn as inline SVG in a fixed 1000x100 viewBox and stretched to the panel
 * width, so there is no canvas sizing to keep in sync with layout.
 */
function renderProfile(points) {
  if (!profilePanel || !profileSvg) return;
  const samples = currentRouteIndex ? elevationProfile(currentRouteIndex) : [];
  const totalKm = currentRouteKm;
  if (!totalKm || samples.length < 2) {
    profilePanel.hidden = true;
    return;
  }
  profilePanel.hidden = false;

  const W = 1000, H = 100, PAD = 6;
  const eles = samples.map(s => s.ele);
  const minEle = Math.min(...eles);
  const maxEle = Math.max(...eles);
  const span = maxEle - minEle || 1;
  const xAt = (km) => Math.max(0, Math.min(W, (km / totalKm) * W));
  const yAt = (ele) => H - PAD - ((ele - minEle) / span) * (H - PAD * 2);

  profileSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const ns = 'http://www.w3.org/2000/svg';
  const parts = [];

  const area = document.createElementNS(ns, 'path');
  const line = samples.map((s, i) => `${i ? 'L' : 'M'}${xAt(s.km).toFixed(1)},${yAt(s.ele).toFixed(1)}`).join('');
  area.setAttribute('d', `${line}L${W},${H}L0,${H}Z`);
  area.setAttribute('fill', 'rgba(56,189,248,0.15)');
  parts.push(area);

  const stroke = document.createElementNS(ns, 'path');
  stroke.setAttribute('d', line);
  stroke.setAttribute('fill', 'none');
  stroke.setAttribute('stroke', '#38bdf8');
  stroke.setAttribute('stroke-width', '1.5');
  stroke.setAttribute('vector-effect', 'non-scaling-stroke');
  parts.push(stroke);

  // Shade the worst gap so it reads at a glance.
  const dry = longestDryStretch(totalKm, points);
  if (dry.gapKm > 0 && points.length) {
    const band = document.createElementNS(ns, 'rect');
    band.setAttribute('x', String(xAt(dry.startKm)));
    band.setAttribute('y', '0');
    band.setAttribute('width', String(Math.max(1, xAt(dry.endKm) - xAt(dry.startKm))));
    band.setAttribute('height', String(H));
    band.setAttribute('fill', dry.gapKm >= 25 ? 'rgba(248,113,113,0.16)' : 'rgba(148,163,184,0.10)');
    parts.unshift(band);
  }

  for (const p of points) {
    if (!Number.isFinite(p._alongKm)) continue;
    const x = xAt(p._alongKm);
    const tick = document.createElementNS(ns, 'line');
    tick.setAttribute('x1', String(x));
    tick.setAttribute('x2', String(x));
    tick.setAttribute('y1', '0');
    tick.setAttribute('y2', String(H));
    tick.setAttribute('stroke', '#22d3ee');
    tick.setAttribute('stroke-width', '1');
    tick.setAttribute('vector-effect', 'non-scaling-stroke');
    tick.setAttribute('opacity', '0.85');
    const title = document.createElementNS(ns, 'title');
    title.textContent = `km ${formatKm(p._alongKm)} — ${(p.tags && p.tags.name) || waterSubtypeLabel(p.tags)}`;
    tick.appendChild(title);
    parts.push(tick);
  }

  profileSvg.replaceChildren(...parts);
  profileHint.textContent = `${Math.round(minEle)}–${Math.round(maxEle)} m · ${formatKm(totalKm)} km`;
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
    // Where it sits along the ride matters more than how far off-route it is.
    const positionLine = document.createElement('div');
    positionLine.textContent = [
      Number.isFinite(p._alongKm) ? `km ${formatKm(p._alongKm)}` : null,
      Number.isFinite(p._distanceM) ? `${Math.round(p._distanceM)} m off route` : null
    ].filter(Boolean).join(' · ');
    if (positionLine.textContent) popup.appendChild(positionLine);
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
    // The enriched GPX is not uploaded: the server rebuilds it from the
    // original plus these water points, which halves both the request and the
    // stored row for a file that is entirely derivable.
    const payload = {
      filename: currentRouteFilename,
      gpxText: originalGpxText,
      bbox: computeBBoxFromGeoJSON(currentRouteGeoJSON),
      routeKm: Number(computeRouteLengthKm(currentRouteGeoJSON).toFixed(2)),
      waypointsCount: points.length,
      waterPoints: points
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

/**
 * Refill stops, drawn per confidence tier.
 *
 * Each popup leads with what to expect on arrival, because the whole point of
 * the tier is that you plan differently for a tagged tap than for a cemetery.
 */
function renderRefillMarkers(points, animate = false) {
  refillLayer.clearLayers();
  points.forEach((p, idx) => {
    const lat = p.lat ?? p.center?.lat;
    const lon = p.lon ?? p.center?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    const tags = p.tags || {};
    const kind = refillLabel(tags);
    const confidence = refillConfidence(tags);

    const popup = document.createElement('div');
    const title = document.createElement('b');
    title.textContent = tags.name || kind;
    popup.appendChild(title);

    const addLine = (text, className) => {
      if (!text) return;
      const line = document.createElement('div');
      if (className) line.className = className;
      line.textContent = text;
      popup.appendChild(line);
    };
    if (tags.name) addLine(kind);
    addLine(refillExpectation(tags));
    addLine([
      Number.isFinite(p._alongKm) ? `km ${formatKm(p._alongKm)}` : null,
      Number.isFinite(p._distanceM) ? `${Math.round(p._distanceM)} m off route` : null
    ].filter(Boolean).join(' · '));
    addLine(tags.opening_hours ? `Hours: ${tags.opening_hours}` : null);

    const mapsLink = document.createElement('a');
    mapsLink.href = `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(5)},${lon.toFixed(5)}`;
    mapsLink.target = '_blank';
    mapsLink.rel = 'noopener';
    mapsLink.textContent = 'Open in Google Maps';
    popup.appendChild(mapsLink);

    const marker = L.marker([lat, lon], { title: `${tags.name || kind} — ${refillExpectation(tags)}`, icon: refillIcon(confidence) })
      .bindPopup(popup)
      .addTo(refillLayer);
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

async function renderCoffeeMarkers(points, animate = false) {
  coffeeLayer.clearLayers();
  points.forEach((p, idx) => {
    const name = p.tags && (p.tags.name || p.tags.brand || p.tags.operator || p.tags.description) || 'Coffee';
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
    if (refillLayer) { refillLayer.clearLayers(); }
    if (coffeeLayer) { coffeeLayer.clearLayers(); }
    // Reset state
    currentRouteGeoJSON = null;
    originalGpxText = '';
    foundWaterPoints = [];
    foundCoffeePoints = [];
    foundRefillPoints = [];
    nearRefillPoints = [];
    lastNearWaterPoints = [];
    currentRouteFilename = 'route.gpx';
    savedRouteForFile = false;
    currentRouteIndex = null;
    currentRouteKm = 0;
    downloadBtn.disabled = true;
    // Hide the route-specific panels rather than leaving stale numbers up
    if (summaryEl) summaryEl.hidden = true;
    if (waterListEl) waterListEl.replaceChildren();
    if (refillEffectEl) { refillEffectEl.hidden = true; refillEffectEl.textContent = ''; }
    if (profilePanel) profilePanel.hidden = true;
    if (profileSvg) profileSvg.replaceChildren();
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
  originalGpxText = requireToGpx()(geojson, { creator: 'GPX Water Mapper (from FIT)' });
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

function combineToEnrichedGpx(geojsonRoute, waterPoints, radiusMeters, routeIndex = currentRouteIndex) {
  // Only include water points close to the route per selected radius
  const nearPoints = filterPointsNearRoute(geojsonRoute, waterPoints, radiusMeters, routeIndex);
  const waypointFeatures = nearPoints
    .filter(p => typeof (p.lat ?? p.center?.lat) === 'number' && typeof (p.lon ?? p.center?.lon) === 'number')
    .map(p => {
      const lat = p.lat ?? p.center.lat;
      const lon = p.lon ?? p.center.lon;
      const label = p.tags?.name || p.tags?.description || waterSubtypeLabel(p.tags) || 'Water';
      const type = waterSubtypeLabel(p.tags) || p._type || 'water';
      // Prefix the ride position so the waypoints are useful on a head unit,
      // where they otherwise arrive as a row of identically named dots.
      const name = Number.isFinite(p._alongKm) ? `km ${formatKm(p._alongKm)} — ${label}` : label;
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
  return requireToGpx()(combined, { creator: 'GPX Water Mapper' });
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
  // Project the route once; every later radius change and export reuses this.
  currentRouteIndex = buildRouteIndex(geojson);
  currentRouteKm = currentRouteIndex.totalM / 1000;
  setStatus('Computing bounding box …');
  const bbox = computeBBoxFromGeoJSON(geojson);
  showLoading(true);
  try {
    const backend = (window.WOR_CONFIG && window.WOR_CONFIG.overpassUrl) ? 'planet (Overpass)' : 'OpenStreetMap';
    setStatus(`Querying ${backend} for water points …`);
    const results = await fetchOSMWaterPointsAdaptive(bbox, (done) => {
      setStatus(`Querying ${backend} for water points … (${done})`);
    }, { minSpan: 0.01, initialBackoffMs: 500, maxBackoffMs: 4000 });
    foundWaterPoints = results;
    // Ride order, not proximity order: this is the sequence you meet them in.
    const near = sortPointsAlongRoute(filterPointsNearRoute(geojson, results, selectedRadiusMeters, currentRouteIndex));
    renderWaterMarkers(near, true);
    lastNearWaterPoints = near;
    renderSummary(near);
    renderProfile(near);
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

downloadBtn.addEventListener('click', () => {
  try {
    if (!routeLayer) return;
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
        const nearW = sortPointsAlongRoute(filterPointsNearRoute(routeFC, foundWaterPoints, selectedRadiusMeters, currentRouteIndex));
        renderWaterMarkers(nearW, true);
        lastNearWaterPoints = nearW;
        renderSummary(nearW);
        renderProfile(nearW);
        msgs.push(`water ${nearW.length}/${foundWaterPoints.length}`);
      }
      if (foundRefillPoints.length) {
        nearRefillPoints = rankRefillPoints(filterPointsNearRoute(routeFC, foundRefillPoints, selectedRadiusMeters, currentRouteIndex));
        renderRefillMarkers(nearRefillPoints, true);
        msgs.push(`refill ${nearRefillPoints.length}/${foundRefillPoints.length}`);
      }
      if (foundCoffeePoints.length) {
        const nearC = rankCoffeePoints(filterPointsNearRoute(routeFC, foundCoffeePoints, selectedRadiusMeters, currentRouteIndex));
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

if (navRefillBtn) {
  navRefillBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      setError('');
      if (!routeLayer) { setError('Please load a GPX route first.'); return; }
      const routeFC = currentRouteAsFeatureCollection();
      const bbox = computeBBoxFromGeoJSON(routeFC);
      setStatus('Querying Overpass for refill stops …');
      showLoading(true);
      const results = await fetchOSMRefillPointsAdaptive(bbox, (done) => {
        setStatus(`Querying Overpass for refill stops … (${done})`);
      }, { minSpan: 0.01, initialBackoffMs: 500, maxBackoffMs: 4000 });
      foundRefillPoints = results || [];
      nearRefillPoints = rankRefillPoints(filterPointsNearRoute(routeFC, foundRefillPoints, selectedRadiusMeters, currentRouteIndex));
      renderRefillMarkers(nearRefillPoints, true);
      renderSummary(lastNearWaterPoints);
      setStatus(`Found ${nearRefillPoints.length} near-route refill stops (${foundRefillPoints.length} total).`);
    } catch (err) {
      console.error(err);
      setError(err.message || String(err));
      setStatus('');
    } finally {
      showLoading(false);
    }
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
      }, { minSpan: 0.01, initialBackoffMs: 500, maxBackoffMs: 4000 });
      foundCoffeePoints = results || [];
      const near = rankCoffeePoints(filterPointsNearRoute(routeFC, foundCoffeePoints, selectedRadiusMeters, currentRouteIndex));
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

  // 'F' triggers the refill-stop search
  if (!isTyping && (e.key === 'F' || e.key === 'f')) {
    if (navRefillBtn) {
      e.preventDefault();
      navRefillBtn.click();
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


