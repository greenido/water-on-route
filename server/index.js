const express = require('express');
const cors = require('cors');
const { fetch } = require('undici');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Configurable upstreams
const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const TILE_URL_TEMPLATE = process.env.TILE_URL_TEMPLATE || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '1mb' }));

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

// serve app.js from ../app.js
app.get('/app.js', (req, res) => {
  res.sendFile(path.join(__dirname, '../app.js'));
});

// serve styles.css from ../styles.css
app.get('/styles.css', (req, res) => {
  res.sendFile(path.join(__dirname, '../styles.css'));
});

// serve test.html from ../test.html
app.get('/test.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../test.html'));
});

// serve osmApi.js from ../osmApi.js
app.get('/osmApi.js', (req, res) => {
  res.sendFile(path.join(__dirname, '../osmApi.js'));
});

//
//
// Overpass proxy: accepts form-urlencoded with `data` or JSON { query }
app.post('/api/overpass', async (req, res) => {
  try {
    const controller = new AbortController();
    const timeoutMs = Number(process.env.OVERPASS_TIMEOUT_MS || 60000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let body;
      let headers;
      if (typeof req.body === 'object' && req.headers['content-type']?.includes('application/json')) {
        const query = req.body.query || req.body.data;
        body = 'data=' + encodeURIComponent(String(query || ''));
        headers = { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' };
      } else {
        // urlencoded already parsed into req.body; rebuild search params
        const query = req.body.data || req.body.query || '';
        body = 'data=' + encodeURIComponent(String(query));
        headers = { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' };
      }
      const upstreamResp = await fetch(OVERPASS_URL, { method: 'POST', headers, body, signal: controller.signal });
      const text = await upstreamResp.text();
      res.status(upstreamResp.status);
      // Pass through content type if available
      const ct = upstreamResp.headers.get('content-type') || 'text/xml; charset=utf-8';
      res.setHeader('Content-Type', ct);
      return res.send(text);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const status = err.name === 'AbortError' ? 504 : 502;
    return res.status(status).send((err && err.message) || 'Proxy error');
  }
});

// Simple tile proxy
app.get('/tiles/:z/:x/:y.png', async (req, res) => {
  const { z, x, y } = req.params;
  const upstream = TILE_URL_TEMPLATE.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  try {
    const controller = new AbortController();
    const timeoutMs = Number(process.env.TILE_TIMEOUT_MS || 20000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
        const txt = await upstreamResp.text();
        return res.send(txt);
      }
      // Send image as buffer (undici provides Web ReadableStream, not Node's)
      const arrayBuf = await upstreamResp.arrayBuffer();
      const buf = Buffer.from(arrayBuf);
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

app.listen(PORT, () => {
  console.log(`Local proxy listening on http://localhost:${PORT}`);
  console.log(`Overpass upstream: ${OVERPASS_URL}`);
  console.log(`Tile upstream: ${TILE_URL_TEMPLATE}`);
});


