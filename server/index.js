/**
 * Water on Route — Local Dev Server
 * Purpose: Serve static client files and proxy Overpass + OSM tiles for local development.
 *
 * Endpoints:
 *   GET  /                   → index.html
 *   GET  /app.js             → client script
 *   GET  /styles.css         → styles
 *   GET  /favicon.svg        → favicon (also as .ico)
 *   GET  /health             → health check
 *   POST /api/overpass       → Overpass passthrough (form-urlencoded or JSON { query })
 *   GET  /tiles/:z/:x/:y.png → Tile proxy to configured OSM tile server
 *
 * Environment variables:
 *   PORT                    → listening port (default 3000)
 *   OVERPASS_URL            → Overpass API base URL
 *   OVERPASS_TIMEOUT_MS     → timeout for Overpass requests
 *   TILE_URL_TEMPLATE       → tile URL template, e.g. https://tile.openstreetmap.org/{z}/{x}/{y}.png
 *   TILE_TIMEOUT_MS         → timeout for tile fetches
 *   TILE_USER_AGENT         → UA string for tile requests
 */

// Load environment variables from a local .env if present (no-op if package not installed or on Fly)
try {
  require('dotenv').config(); 
} 
catch (e) {
  console.error('Failed to load .env file:', e);
}

const express = require('express');
const { fetch } = require('undici');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { initDatabase, insertRoute, listRoutes, getRouteById, deleteRouteById, DB_PATH } = require('./db');
const archiver = require('archiver');
const crypto = require('crypto');
const {
  safeEqual,
  validateRoutePayload,
  validateTileCoordinates,
  isAllowedOrigin,
  positiveInteger
} = require('./security');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Configurable upstreams
const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const TILE_URL_TEMPLATE = process.env.TILE_URL_TEMPLATE || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OVERPASS_TIMEOUT_MS = positiveInteger(process.env.OVERPASS_TIMEOUT_MS, 60000, 1000, 120000);
const TILE_TIMEOUT_MS = positiveInteger(process.env.TILE_TIMEOUT_MS, 20000, 1000, 60000);
const OVERPASS_MAX_RESPONSE_BYTES = positiveInteger(
  process.env.OVERPASS_MAX_RESPONSE_BYTES,
  8 * 1024 * 1024,
  64 * 1024,
  32 * 1024 * 1024
);
const TILE_MAX_RESPONSE_BYTES = positiveInteger(
  process.env.TILE_MAX_RESPONSE_BYTES,
  2 * 1024 * 1024,
  16 * 1024,
  8 * 1024 * 1024
);

if (process.env.TRUST_PROXY_HOPS) {
  app.set('trust proxy', positiveInteger(process.env.TRUST_PROXY_HOPS, 1, 1, 10));
} else if (process.env.FLY_APP_NAME || process.env.FLY_MACHINE) {
  app.set('trust proxy', 1);
}

app.use((_req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  next();
});
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        (_req, res) => `'nonce-${res.locals.cspNonce}'`,
        'https://cdn.jsdelivr.net',
        'https://unpkg.com'
      ],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://unpkg.com'],
      imgSrc: [
        "'self'",
        'data:',
        'blob:',
        'https://unpkg.com',
        'https://*.tile.openstreetmap.org',
        'https://*.tile.opentopomap.org',
        'https://server.arcgisonline.com'
      ],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: IS_PRODUCTION ? [] : null
    }
  },
  crossOriginEmbedderPolicy: false,
  strictTransportSecurity: IS_PRODUCTION
}));
app.use(express.urlencoded({ extended: false, limit: '128kb' }));
app.use(express.json({ limit: '24mb' }));

const limiterDefaults = {
  windowMs: 15 * 60 * 1000,
  standardHeaders: 'draft-8',
  legacyHeaders: false
};
const uploadLimiter = rateLimit({
  ...limiterDefaults,
  limit: positiveInteger(process.env.UPLOAD_RATE_LIMIT, 20, 1, 10000),
  message: { error: 'Too many route uploads; try again later' }
});
const proxyLimiter = rateLimit({
  ...limiterDefaults,
  limit: positiveInteger(process.env.PROXY_RATE_LIMIT, 120, 1, 10000),
  message: 'Proxy rate limit exceeded'
});
const tileLimiter = rateLimit({
  ...limiterDefaults,
  limit: positiveInteger(process.env.TILE_RATE_LIMIT, 600, 1, 100000),
  message: 'Tile rate limit exceeded'
});
const adminLimiter = rateLimit({
  ...limiterDefaults,
  limit: positiveInteger(process.env.ADMIN_RATE_LIMIT, 60, 1, 10000),
  message: 'Admin rate limit exceeded'
});

function requireSameOrigin(req, res, next) {
  if (!isAllowedOrigin(req.get('origin'), req.get('host'))) {
    return res.status(403).json({ error: 'Cross-origin request denied' });
  }
  return next();
}

// serve favicon assets
app.get('/favicon.svg', (req, res) => {
  res.sendFile(path.join(__dirname, '../favicon.svg'));
});
// minimal ico fallback: reuse svg with correct content type if no .ico provided
app.get('/favicon.ico', (req, res) => {
  res.type('image/svg+xml');
  res.sendFile(path.join(__dirname, '../favicon.svg'));
});

// Health
app.get('/health', (_req, res) => res.json({ ok: true }));

// serve index.html from ../index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../index.html'));
});

app.get('/config.js', (_req, res) => {
  res.type('application/javascript');
  res.setHeader('Cache-Control', 'no-store');
  res.send(`window.WOR_CONFIG = Object.freeze({
    overpassUrl: '/api/overpass',
    tileUrl: '/tiles/{z}/{x}/{y}.png'
  });`);
});

// serve app.js from ../app.js
app.get('/app.js', (req, res) => {
  res.sendFile(path.join(__dirname, '../app.js'));
});

// serve styles.css from ../styles.css
app.get('/styles.css', (req, res) => {
  res.sendFile(path.join(__dirname, '../styles.css'));
});

// serve the Tailwind bundle built by `npm run build:css`
app.get('/tailwind.css', (req, res) => {
  res.sendFile(path.join(__dirname, '../tailwind.css'));
});

// serve test.html from ../tests/test.html
app.get('/test.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../tests/test.html'));
});

// serve osmApi.js from ../osmApi.js
app.get('/osmApi.js', (req, res) => {
  res.sendFile(path.join(__dirname, '../osmApi.js'));
});

// serve fitToGeoJSON.js from ../fitToGeoJSON.js (imported by app.js)
app.get('/fitToGeoJSON.js', (req, res) => {
  res.sendFile(path.join(__dirname, '../fitToGeoJSON.js'));
});

// Basic auth middleware for admin endpoints
function requireBasicAuth(req, res, next) {
  const expectedUser = process.env.ADMIN_USER;
  const expectedPass = process.env.ADMIN_PASS;
  if (!expectedUser || !expectedPass) {
    return res.status(503).send('Admin access is not configured');
  }
  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).send('Auth required');
  }
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  if (idx < 0) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).send('Invalid credentials');
  }
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  if (safeEqual(user, expectedUser) && safeEqual(pass, expectedPass)) return next();
  res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
  return res.status(401).send('Invalid credentials');
}

// API: Save a route (raw GPX plus summary)
// body: { filename, gpxText, bbox, routeKm, waypointsCount }
app.post('/api/routes', uploadLimiter, requireSameOrigin, async (req, res) => {
  try {
    const validation = validateRoutePayload(req.body);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }
    const { filename, gpxText, bbox, routeKm, waypointsCount, waterPoints, enrichedGpxText } = validation.value;
    console.log('[POST /api/routes] Incoming request', {
      filename,
      bbox,
      routeKm,
      waypointsCount,
      hasWaterPoints: !!waterPoints,
      hasEnrichedGpx: !!enrichedGpxText
    });
    const fileSize = Buffer.byteLength(gpxText, 'utf8');
    const clientIp = req.ip || req.socket?.remoteAddress || null;
    console.log('[POST /api/routes] Calculated fileSize and clientIp', { fileSize, clientIp });
    const result = await insertRoute({ filename, fileSize, bbox, routeKm, waypointsCount, gpxText, clientIp, waterPoints, enrichedGpxText });
    console.log('[POST /api/routes] Route inserted', { id: result.id });
    return res.json({ ok: true, id: result.id });
  } catch (e) {
    console.error('[POST /api/routes] Error:', e);
    return res.status(500).json({ error: 'Failed to save route' });
  }
});

// API: List routes (protected)
app.get('/api/routes', adminLimiter, requireBasicAuth, async (_req, res) => {
  try {
    const rows = await listRoutes();
    return res.json({ ok: true, routes: rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list routes' });
  }
});

// API: Delete route (protected)
app.delete('/api/routes/:id', adminLimiter, requireSameOrigin, requireBasicAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const result = await deleteRouteById(id);
    if (!result || !result.deletedCount) {
      return res.status(404).json({ error: 'Not found' });
    }
    return res.json({ ok: true, deleted: result.deletedCount });
  } catch (e) {
    console.error('[DELETE /api/routes/:id] error', e);
    return res.status(500).json({ error: 'Failed to delete route' });
  }
});

// Simple GeoIP lookup with caching. Uses ipapi.co (no key) unless GEOIP_URL provided.
const GEOIP_CACHE = new Map();
const GEOIP_TTL_MS = 1000 * 60 * 60; // 1 hour
const PRIVATE_IP_RE = /^(?:127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[0-1])\.\d+\.\d+|::1|fc00:|fe80:)/;

function isPrivateIp(ip) {
  try {
    return PRIVATE_IP_RE.test(String(ip));
  } catch {
    return true;
  }
}

function cacheGet(ip) {
  const item = GEOIP_CACHE.get(ip);
  if (!item) return null;
  if (Date.now() - item.t > GEOIP_TTL_MS) {
    GEOIP_CACHE.delete(ip);
    return null;
  }
  return item.v;
}

function cacheSet(ip, value) {
  GEOIP_CACHE.set(ip, { v: value, t: Date.now() });
}

app.get('/api/geoip/:ip', adminLimiter, requireBasicAuth, async (req, res) => {
  const ip = String(req.params.ip || '').trim();
  if (!net.isIP(ip)) return res.status(400).json({ error: 'valid IP required' });
  if (isPrivateIp(ip)) return res.json({ ok: true, location: '' });
  const cached = cacheGet(ip);
  if (cached !== null && cached !== undefined) {
    return res.json({ ok: true, location: cached });
  }
  try {
    const base = process.env.GEOIP_URL || 'https://ipapi.co/{ip}/json/';
    const url = base.replace('{ip}', encodeURIComponent(ip));
    const controller = new AbortController();
    const timeoutMs = Number(process.env.GEOIP_TIMEOUT_MS || 6000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: controller.signal, headers: { 'Accept': 'application/json' } });
      if (!r.ok) throw new Error('geoip upstream ' + r.status);
      const j = await r.json();
      const city = j.city || j.town || '';
      const region = j.region || j.region_code || j.state || '';
      const country = j.country_name || j.country || '';
      const parts = [city, region, country].filter(Boolean);
      const display = parts.join(', ');
      cacheSet(ip, display);
      return res.json({ ok: true, location: display });
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    cacheSet(ip, '');
    return res.json({ ok: true, location: '' });
  }
});

// Download endpoints (protected)
app.get('/api/routes/:id/original.gpx', adminLimiter, requireBasicAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).send('Invalid id');
    const row = await getRouteById(id);
    if (!row || !row.gpxText) return res.status(404).send('Not found');
    const fname = (row.filename && row.filename.replace(/[^a-zA-Z0-9_.-]+/g, '_')) || `route-${id}.gpx`;
    res.setHeader('Content-Type', 'application/gpx+xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    return res.send(row.gpxText);
  } catch (e) {
    console.error(e);
    return res.status(500).send('Failed to download');
  }
});

app.get('/api/routes/:id/enriched.gpx', adminLimiter, requireBasicAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).send('Invalid id');
    const row = await getRouteById(id);
    if (!row || !row.enrichedGpxText) return res.status(404).send('Enriched GPX not found');
    const base = (row.filename && row.filename.replace(/[^a-zA-Z0-9_.-]+/g, '_').replace(/\.gpx$/i, '')) || `route-${id}`;
    const fname = `${base}-enriched.gpx`;
    res.setHeader('Content-Type', 'application/gpx+xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    return res.send(row.enrichedGpxText);
  } catch (e) {
    console.error(e);
    return res.status(500).send('Failed to download');
  }
});

// Admin utilities (protected)
app.get('/api/admin/db.sqlite3', adminLimiter, requireBasicAuth, async (_req, res) => {
  try {
    if (process.env.ENABLE_DB_DOWNLOAD !== 'true') {
      return res.status(404).send('Not found');
    }
    if (!DB_PATH || !fs.existsSync(DB_PATH)) {
      return res.status(404).send('DB file not found');
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="routes.sqlite3"');
    const stream = fs.createReadStream(DB_PATH);
    stream.on('error', (e) => {
      console.error('[GET /api/admin/db.sqlite3] stream error', e);
      if (!res.headersSent) res.status(500);
      res.end('Failed to stream DB');
    });
    return stream.pipe(res);
  } catch (e) {
    console.error('[GET /api/admin/db.sqlite3] error', e);
    return res.status(500).send('Failed to download DB');
  }
});

app.get('/api/routes/all.zip', adminLimiter, requireBasicAuth, async (_req, res) => {
  try {
    const routes = await listRoutes();
    const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
    const fname = `routes-${ts}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('warning', (err) => {
      console.warn('[GET /api/routes/all.zip] warning', err);
    });
    archive.on('error', (err) => {
      console.error('[GET /api/routes/all.zip] error', err);
      if (!res.headersSent) res.status(500);
      res.end('Archive error');
    });
    archive.pipe(res);

    for (const r of routes) {
      try {
        const full = await getRouteById(r.id);
        if (!full) continue;
        const baseSafe = (full.filename && full.filename.replace(/[^a-zA-Z0-9_.-]+/g, '_').replace(/\.gpx$/i, '')) || `route-${full.id}`;
        if (full.gpxText) {
          archive.append(full.gpxText, { name: `${baseSafe}.gpx` });
        }
        if (full.enrichedGpxText) {
          archive.append(full.enrichedGpxText, { name: `${baseSafe}-enriched.gpx` });
        }
      } catch (e) {
        console.warn('[GET /api/routes/all.zip] skipping route due to error', { id: r.id, error: e && e.message });
      }
    }

    await archive.finalize();
  } catch (e) {
    console.error('[GET /api/routes/all.zip] fatal error', e);
    return res.status(500).send('Failed to build ZIP');
  }
});

// Admin page (protected)
app.get('/admin', adminLimiter, requireBasicAuth, (req, res) => {
  const nonce = res.locals.cspNonce;
  const dbDownloadLink = process.env.ENABLE_DB_DOWNLOAD === 'true'
    ? '<a href="/api/admin/db.sqlite3" class="px-3 py-2 rounded-lg bg-emerald-400 text-slate-900 font-medium hover:bg-emerald-300 transition text-sm inline-flex items-center gap-2">Download DB</a>'
    : '';
  res.type('html');
  res.send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Routes Admin</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/simple-datatables@9.0.3/dist/style.css" integrity="sha384-xnK68E/OAsSGcbvbeWEOyhjix2K7rBxt8Eytj/Ow9zuPG7WwFGGqMPQ8SbexlsL0" crossorigin="anonymous">
    <script nonce="${nonce}" src="https://cdn.tailwindcss.com/3.4.17" integrity="sha384-igm5BeiBt36UU4gqwWS7imYmelpTsZlQ45FZf+XBn9MuJbn4nQr7yx1yFydocC/K" crossorigin="anonymous"></script>
    <style nonce="${nonce}">body{background:#0f172a;color:#e2e8f0;font-family:system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Helvetica, Arial, Apple Color Emoji, Segoe UI Emoji, Segoe UI Symbol} .wrap{max-width:1100px;margin:24px auto;padding:0 16px} .card{background:#0b1220;border:1px solid #1e293b;border-radius:12px;padding:16px} h1{font-size:18px;margin:0 0 12px} .table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch} #routesTable{width:100%} #routesTable td.route-cell{max-width:340px;white-space:normal;word-break:break-word;overflow-wrap:anywhere} @media (max-width:720px){ #routesTable td.route-cell{max-width:220px} }</style>
  </head>
  <body class="bg-slate-950 text-slate-100">
    <div class="wrap">
      <h1 class="m-0 text-lg tracking-wide font-semibold">Saved Routes</h1>
      <div class="card mb-3 flex gap-2 flex-wrap">
        <a href="/api/routes/all.zip" class="px-3 py-2 rounded-lg bg-sky-400 text-slate-900 font-medium hover:bg-sky-300 transition text-sm inline-flex items-center gap-2">Download all</a>
        ${dbDownloadLink}
      </div>
      <div class="card">
        <div class="table-wrap">
        <table id="routesTable" class="display">
          <thead>
            <tr>
              <th>ID</th>
              <th>Filename</th>
              <th>Size (KB)</th>
              <th>Route (km)</th>
              <th>Waypoints</th>
              <th>Uploaded</th>
              <th>IP</th>
              <th>Location</th>
              <th>Downloads</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
        </div>
      </div>
    </div>
    <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/simple-datatables@9.0.3/dist/umd/simple-datatables.js" integrity="sha384-qknKzrIWsL9I5CVZxbBKS2IOVnXBRjl0gucgQ7xGPQLH6yN7agkTKPtOyGg2ujCl" crossorigin="anonymous" defer></script>
    <script nonce="${nonce}">
      document.addEventListener('DOMContentLoaded', async () => {
        try {
          const resp = await fetch('/api/routes', { headers: { 'Accept': 'application/json' } });
          const data = await resp.json();
          const routes = (data && data.routes) || [];
          const tbody = document.querySelector('#routesTable tbody');
          const ipLocCache = new Map();

          async function resolveLocation(ip) {
            if (!ip) return '';
            if (ipLocCache.has(ip)) return ipLocCache.get(ip);
            try {
              const r = await fetch('/api/geoip/' + encodeURIComponent(ip), { headers: { 'Accept': 'application/json' } });
              if (!r.ok) throw new Error('geoip failed');
              const j = await r.json();
              const loc = (j && j.location) || '';
              ipLocCache.set(ip, loc);
              return loc;
            } catch (e) {
              ipLocCache.set(ip, '');
              return '';
            }
          }

          function appendTextCell(row, value, className) {
            const cell = document.createElement('td');
            if (className) cell.className = className;
            cell.textContent = value == null ? '' : String(value);
            row.appendChild(cell);
            return cell;
          }

          routes.forEach(r => {
            const tr = document.createElement('tr');
            const kb = r.fileSize ? Math.round(r.fileSize / 1024) : '';
            appendTextCell(tr, r.id);
            appendTextCell(tr, r.filename, 'route-cell');
            appendTextCell(tr, kb);
            appendTextCell(tr, r.routeKm);
            appendTextCell(tr, r.waypointsCount);
            appendTextCell(tr, r.uploadedAt);
            appendTextCell(tr, r.clientIp, 'route-cell');
            const locTd = appendTextCell(tr, r.clientIp ? '…' : '', 'location-cell');
            const downloads = document.createElement('td');
            const original = document.createElement('a');
            original.href = '/api/routes/' + encodeURIComponent(r.id) + '/original.gpx';
            original.target = '_blank';
            original.rel = 'noopener';
            original.textContent = 'Original';
            downloads.appendChild(original);
            if (r.hasEnriched) {
              downloads.appendChild(document.createTextNode(' | '));
              const enriched = document.createElement('a');
              enriched.href = '/api/routes/' + encodeURIComponent(r.id) + '/enriched.gpx';
              enriched.target = '_blank';
              enriched.rel = 'noopener';
              enriched.textContent = 'Enriched';
              downloads.appendChild(enriched);
            }
            tr.appendChild(downloads);
            tbody.appendChild(tr);

            if (r.clientIp && locTd) {
              resolveLocation(r.clientIp).then(loc => {
                locTd.textContent = loc || '';
              });
            }
          });
          const dt = new simpleDatatables.DataTable('#routesTable', { searchable: true, sortable: true, perPage: 25 });

          // Add Delete column and buttons after table is initialized
          const table = document.querySelector('#routesTable');
          const theadRow = table.querySelector('thead tr');
          const th = document.createElement('th');
          th.textContent = 'Actions';
          theadRow.appendChild(th);

          const rows = table.querySelectorAll('tbody tr');
          rows.forEach((row) => {
            const idCell = row.children[0];
            const id = Number(idCell && idCell.textContent);
            const td = document.createElement('td');
            const btn = document.createElement('button');
            btn.textContent = '🗑️ Delete';
            btn.className = 'px-2 py-1 rounded bg-red-500/90 hover:bg-red-400 text-slate-900 text-sm';
            btn.addEventListener('click', async () => {
              if (!confirm('Delete route #' + id + '? This cannot be undone.')) return;
              try {
                const resp = await fetch('/api/routes/' + id, { method: 'DELETE' });
                if (!resp.ok) {
                  const j = await resp.json().catch(() => ({}));
                  throw new Error(j && j.error || ('HTTP ' + resp.status));
                }
                // remove row from table and redraw
                row.remove();
                dt.refresh();
              } catch (e) {
                alert('Failed to delete: ' + (e && e.message || e));
              }
            });
            td.appendChild(btn);
            row.appendChild(td);
          });
        } catch (e) {
          console.error(e);
          alert('Failed to load routes');
        }
      });
    </script>
  </body>
</html>`);
});

//
//
// Overpass proxy: accepts form-urlencoded with `data` or JSON { query }
async function readUpstreamBody(response, maxBytes) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error('Upstream response exceeds size limit');
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('Upstream response exceeds size limit');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

app.post('/api/overpass', proxyLimiter, requireSameOrigin, async (req, res) => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);
    try {
      let body;
      let headers;
      if (typeof req.body === 'object' && req.headers['content-type']?.includes('application/json')) {
        const query = String(req.body.query || req.body.data || '');
        if (!query || Buffer.byteLength(query, 'utf8') > 64 * 1024) {
          return res.status(400).send('Invalid Overpass query');
        }
        body = 'data=' + encodeURIComponent(query);
        headers = { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' };
      } else {
        // urlencoded already parsed into req.body; rebuild search params
        const query = String(req.body.data || req.body.query || '');
        if (!query || Buffer.byteLength(query, 'utf8') > 64 * 1024) {
          return res.status(400).send('Invalid Overpass query');
        }
        body = 'data=' + encodeURIComponent(query);
        headers = { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' };
      }
      const upstreamResp = await fetch(OVERPASS_URL, { method: 'POST', headers, body, signal: controller.signal });
      const responseBody = await readUpstreamBody(
        upstreamResp,
        OVERPASS_MAX_RESPONSE_BYTES
      );
      res.status(upstreamResp.status);
      // Pass through content type if available
      const ct = upstreamResp.headers.get('content-type') || 'text/xml; charset=utf-8';
      res.setHeader('Content-Type', ct);
      return res.send(responseBody);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const status = err.name === 'AbortError' ? 504 : 502;
    console.error('[POST /api/overpass] error', err);
    return res.status(status).send('Proxy error');
  }
});

// Simple tile proxy
app.get('/tiles/:z/:x/:y.png', tileLimiter, async (req, res) => {
  const coordinates = validateTileCoordinates(req.params.z, req.params.x, req.params.y);
  if (!coordinates) return res.status(400).send('Invalid tile coordinates');
  const { z, x, y } = coordinates;
  const upstream = TILE_URL_TEMPLATE.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TILE_TIMEOUT_MS);
    try {
      const upstreamResp = await fetch(upstream, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'User-Agent': process.env.TILE_USER_AGENT || 'water-on-route/1.0 (+local-proxy)'
        }
      });
      res.status(upstreamResp.status);
      res.setHeader('Content-Type', upstreamResp.headers.get('content-type') || 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      if (!upstreamResp.ok) {
        return res.send(await readUpstreamBody(upstreamResp, 64 * 1024));
      }
      const buf = await readUpstreamBody(
        upstreamResp,
        TILE_MAX_RESPONSE_BYTES
      );
      res.setHeader('Content-Length', String(buf.length));
      return res.end(buf);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const status = err.name === 'AbortError' ? 504 : 502;
    return res.status(status).send('Tile proxy error');
  }
});

app.use((err, _req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ error: 'Request body exceeds the 24 MB limit' });
  }
  if (err) {
    console.error('[express] unhandled request error', err);
    return res.status(400).json({ error: 'Invalid request' });
  }
  return next();
});

function validateStartupConfiguration() {
  const adminUser = process.env.ADMIN_USER;
  const adminPass = process.env.ADMIN_PASS;
  if (IS_PRODUCTION && (!adminUser || !adminPass)) {
    throw new Error('ADMIN_USER and ADMIN_PASS are required in production');
  }
  if ((adminUser && !adminPass) || (!adminUser && adminPass)) {
    throw new Error('ADMIN_USER and ADMIN_PASS must be configured together');
  }
  if (adminUser && (adminUser.length < 4 || adminPass.length < 16)) {
    throw new Error('ADMIN_USER must be at least 4 characters and ADMIN_PASS at least 16 characters');
  }
}

validateStartupConfiguration();

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🍎 Local proxy listening on http://localhost:${PORT}`);
      console.log(`🍯 Overpass upstream: ${OVERPASS_URL}`);
      console.log(`🍯 Tile upstream: ${TILE_URL_TEMPLATE}`);
      console.log(`㏈ - Database initialized at ${DB_PATH}`);
    });
  })
  .catch((err) => {
    console.error('Failed to init DB', err);
    process.exit(1);
  });


