# GPX Water Mapper

Find potable water sources along a GPX or Garmin FIT route. Upload a route file, visualize it on a map, automatically fetch nearby water points from OpenStreetMap via Overpass, and download an enriched GPX with waypoints added.

> Built with Leaflet on the frontend and a small Express proxy for Overpass queries and tile fetching. Optional Docker services provide a local Overpass instance and a raster tile server for fully offline-friendly workflows.

---

## Features

- Upload or drag-and-drop a `.gpx` or Garmin `.fit` file
- Interactive map with your route, water markers, and optional coffee markers
- Broader potable-water OSM coverage (fountains, water points, taps) plus coffee search ranked by distance and OSM signals
- Adaptive Overpass querying with split-and-retry for large bounding boxes or rate limits (water and coffee)
- One-click download of an enriched `.gpx` including water waypoints
- Local proxy for Overpass and tiles to avoid CORS and respect usage policies
- Optional Docker stack to run Overpass and a local raster tile server
- Save uploaded routes to SQLite and review them in an admin table

---

## Quick Start

You can run against public services or spin up everything locally.

### Option A: Use public Overpass and OSM tiles (fastest to try)

```bash
npm install
npm start
# Open http://localhost:3000
```

Configure admin credentials (passwords must be at least 16 characters):

```bash
ADMIN_USER=your-user ADMIN_PASS='replace-with-a-long-random-password' npm start
```

Admin endpoints are disabled when credentials are absent in development, and
the server refuses to start without them in production.

This uses the default upstreams in `server/index.js`:

- Overpass: `https://overpass-api.de/api/interpreter`
- Tiles: `https://tile.openstreetmap.org/{z}/{x}/{y}.png`

Please respect the public usage policies when testing this option.

### Option B: Run local Overpass and local tile server via Docker (recommended)

```bash
docker compose up -d

# In a separate shell
npm install
OVERPASS_URL=http://localhost:12345/api/interpreter \
TILE_URL_TEMPLATE=http://localhost:8080/data/v3/{z}/{x}/{y}.png \
npm start

# Open http://localhost:3000
```

Notes:

- The first Overpass initialization and import can take a long time for large extracts.
- `docker-compose.yml` defaults to a California extract via Geofabrik; change `OVERPASS_PLANET_URL` to a different region or the full planet as needed.

---

## How it works

- Frontend (`index.html`, `app.js`, `osmApi.mjs`)
  - Renders a Leaflet map and your GPX route
  - Computes a bounding box for the route
  - Queries Overpass for potable water: `amenity=drinking_water`, `natural=spring`, `man_made=water_tap`, `amenity=water_point`, potable `amenity=fountain` / `man_made=water_well`, and `drinking_water=yes|compatible` (excludes `drinking_water=no`)
  - Optional coffee search: `amenity=cafe`, `shop=coffee`, restaurants with coffee-related cuisine; ranked by corridor distance plus OSM signals (name/brand, cuisine, hours, website)
  - Adaptively splits the bbox and retries on 400/429/504 responses for both water and coffee; dedupes by OSM type+id
  - Split quads are fetched concurrently behind a shared cap (2 in flight by default) so one route load cannot flood Overpass
  - Lets you download an enriched GPX that includes the discovered water points as waypoints

- Backend (`server/index.js`)
  - Serves static frontend files
  - Proxies POST `/api/overpass` to the configured Overpass endpoint
  - Proxies GET `/tiles/{z}/{x}/{y}.png` to the configured tile source
  - Adds timeouts and simple headers; avoids browser CORS issues

- Optional Services (`docker-compose.yml`)
  - `overpass`: Local Overpass API backed by a persistent volume
  - `tiles`: Local raster tiles via `maptiler/tileserver-gl`

---

## Project structure

```text
water-on-route/
├─ index.html          # UI and client config (window.WOR_CONFIG)
├─ app.js              # Map, GPX handling, Overpass querying, GPX export
├─ osmApi.mjs          # Small OSM/Overpass utilities with adaptive splitting
├─ styles.css          # Basic styles
├─ routes/
│  └─ losAltos-MorganHill.gpx  # Example route
├─ server/
│  └─ index.js         # Express server + Overpass/tile proxy
│  └─ db.js            # SQLite init and helpers
├─ docker-compose.yml  # Local Overpass + tile server stack
├─ README-local.md     # Local quick notes
└─ package.json
```

---

## Running locally

### Prerequisites

- Node.js 20+
- Docker (if you want a local Overpass and tile server)

### Install and start

```bash
npm install
npm start
# Open http://localhost:3000
```

### Configure upstreams (optional)

You can point the proxy to different upstreams via environment variables when starting the server:

```bash
OVERPASS_URL=http://localhost:12345/api/interpreter \
TILE_URL_TEMPLATE=http://localhost:8080/data/v3/{z}/{x}/{y}.png \
PORT=3000 \
OVERPASS_TIMEOUT_MS=60000 \
TILE_TIMEOUT_MS=20000 \
TILE_USER_AGENT="water-on-route/1.0 (+local-proxy)" \
ADMIN_USER=your-user \
ADMIN_PASS="replace-with-a-long-random-password" \
npm start
```

If you leave variables unset, sane defaults will be used:

- `OVERPASS_URL`: `https://overpass-api.de/api/interpreter`
- `TILE_URL_TEMPLATE`: `https://tile.openstreetmap.org/{z}/{x}/{y}.png`
- `PORT`: `3000`
- `ROUTES_DB_PATH`: path to SQLite file (default `/data/routes.sqlite3` if available)
- `TRUST_PROXY_HOPS`: trusted reverse-proxy hop count (Fly.io uses `1`);
  leave unset when clients connect directly
- `UPLOAD_RATE_LIMIT`: route uploads per client per 15 minutes (default `20`)
- `PROXY_RATE_LIMIT`: Overpass requests per client per 15 minutes (default `120`)
- `TILE_RATE_LIMIT`: tile requests per client per 15 minutes (default `600`)
- `ADMIN_RATE_LIMIT`: admin requests per client per 15 minutes (default `60`)
- `ENABLE_DB_DOWNLOAD`: opt in to raw SQLite download (default `false`)
- `ENABLE_GEOIP`: opt in to third-party city lookup for stored IPs (default `false`)
- `MAX_ROUTE_DB_BYTES`: refuse new uploads past this DB size (default `536870912`)
- `OVERPASS_CACHE_TTL_MS`: how long a cached Overpass response stays fresh (default 6 h)
- `OVERPASS_CACHE_MAX_ENTRIES` / `OVERPASS_CACHE_MAX_BYTES`: cache bounds (default `200` / 64 MB)

Copy `.env.example` to `.env` for the complete configuration template. Never
commit `.env` or real credentials.

The frontend is preconfigured in `index.html` to call the local proxy:

```html
<script>
  window.WOR_CONFIG = {
    overpassUrl: 'http://localhost:3000/api/overpass',
    tileUrl: 'http://localhost:3000/tiles/{z}/{x}/{y}.png'
  };
  </script>
```

---

## Using the app

1. Open `http://localhost:3000`.
2. Click “Select GPX / FIT” or drag-and-drop a `.gpx` or `.fit` file.
3. The route is parsed and displayed. The app computes the route bbox and queries Overpass for nearby water points.
4. Water markers are added to the map. Hover/tap to see basic details.
5. Click “Download enriched GPX” to save a new `.gpx` that includes the water waypoints along with your original track(s). FIT uploads are converted to the same enriched GPX download.

Implementation notes:

- GPX parsing is handled by `@tmcw/togeojson` in the browser.
- GPX export is handled by `togpx` by combining route features with water waypoints.
- Map rendering uses Leaflet.

---

## API (local proxy)

The Express server exposes a few endpoints:

- `GET /` – serves `index.html`
- `GET /app.js`, `GET /styles.css`, `GET /osmApi.mjs`, `GET /test.html` – static assets
- `GET /health` – simple health check
- `POST /api/overpass` – Overpass proxy
  - Body (JSON): `{ bbox: { minlat, minlon, maxlat, maxlon }, kind: "water" | "coffee" }`
  - The Overpass QL is built server-side from these two inputs; client-supplied
    query text is never forwarded, so the endpoint cannot be used as an open relay
  - Same-origin requests only; a bbox spanning more than 12° on a side is rejected
    with `400`, which the client treats as a signal to split and retry
  - Successful responses are cached in memory (LRU, bounded by count, bytes and age); the reply carries `X-Cache: HIT` or `MISS`
  - Returns the Overpass response as text, passing through the content-type when available
- `GET /tiles/{z}/{x}/{y}.png` – tile proxy
  - Fetches the tile from `TILE_URL_TEMPLATE` and forwards it with caching headers

### Routes persistence API

- `POST /api/routes` – Save an uploaded route
  - Body (JSON): `{ filename, gpxText, bbox, routeKm, waypointsCount }`
  - Same-origin requests only; GPX content and metadata are validated
  - Original GPX is limited to 8 MB and enriched GPX to 12 MB
  - Returns: `{ ok: true, id }`
- `GET /api/routes` – List saved routes (protected)
  - Basic Auth required (see below)
  - Returns: `{ ok: true, routes: [...] }`
- `GET /admin` – Admin UI: sortable/filterable table of routes (protected)

### Security controls

- Helmet sets CSP, clickjacking, MIME-sniffing, referrer, and HTTPS headers.
- Route uploads, upstream proxies, tiles, and admin endpoints are rate-limited.
- Overpass queries are built server-side from a validated bbox and a fixed set of
  kinds; arbitrary query text is never proxied.
- State-changing requests must carry a matching `Origin` header, so they cannot be
  replayed by a plain HTTP client.
- Route uploads stop with `507` once the database reaches `MAX_ROUTE_DB_BYTES`,
  so an anonymous endpoint cannot fill the volume and take the app down.
- Admin credentials use timing-safe comparisons and are mandatory in production.
- Raw database download is disabled unless `ENABLE_DB_DOWNLOAD=true`.
- Upstream response sizes and tile coordinate ranges are bounded.
- Third-party browser assets are pinned with Subresource Integrity hashes.

### Privacy

- Saving a route is disclosed in the sidebar and can be switched off; the choice
  is remembered per device. With it off, nothing but anonymous OpenStreetMap
  queries leaves the browser, and the map and enriched download still work.
- Stored addresses are reduced to a coarse network before they are written:
  IPv4 keeps the `/24`, IPv6 keeps the `/48`. Full addresses are never persisted.
- The city lookup that sends addresses to `ipapi.co` is opt-in via
  `ENABLE_GEOIP=true`. It is off by default.

---

## Docker services

`docker-compose.yml` defines two services and persistent volumes:

- `overpass` (port `12345` → container `80`)
  - Env vars:
    - `OVERPASS_MODE=init`
    - `OVERPASS_PLANET_URL=https://download.geofabrik.de/north-america/us/california-latest.osm.pbf`
    - `OVERPASS_DIFFS=yes`
    - `OVERPASS_META=yes`
  - Volume: `overpass-db:/db`
  - First import can take hours for large regions

- `tiles` (port `8080`)
  - Image: `maptiler/tileserver-gl:latest`
  - Command: `--raster --port 8080`
  - Volume: `tiles-data:/data`

You can change `OVERPASS_PLANET_URL` to target a different region or the entire planet.

---

## Deploying to Fly.io

Persistent storage is required for the SQLite database. This repo's `fly.toml` mounts a volume at `/data`.

Create and attach a volume named `wor_data` (adjust size/region as needed):

```bash
fly volumes create wor_data --size 1 --region sjc
fly deploy
```

Ensure your service listens on port 3000 (already configured) and the volume mount is present under `[[mounts]]` with `destination = "/data"`.

---

## Troubleshooting

- Overpass container not ready / long startup
  - The first import is slow. Check container logs and wait until the API responds at `http://localhost:12345/api/interpreter`.

- 429/504 or partial results from Overpass
  - The frontend uses adaptive splitting and exponential backoff. Try reducing the route size, waiting longer, or running a local Overpass instance.
  - Increase `OVERPASS_TIMEOUT_MS` on the proxy if needed.

- Tiles are slow or rate-limited
  - Prefer the local tile server in Docker. If using public tiles, respect their usage policies and set a clear `TILE_USER_AGENT`.

- Map does not render or markers missing
  - Check browser console for errors.
  - Ensure `window.WOR_CONFIG` points to the running proxy and that the proxy has correct upstreams.

---

## Notes on data and usage

- Always respect OpenStreetMap and Overpass usage policies when using public services.
- Consider running the included Docker stack for local development and heavy experimentation.
- Attribution for map data: © OpenStreetMap contributors.

---

## Browser support

Modern Chromium, Firefox, and Safari. The app relies on ES modules and the Fetch API.

---

## Scripts

- `npm start` – Start the Express proxy and serve the app on `http://localhost:3000`
- `npm run dev` – Start with Node's built-in watch mode
- `npm test` – Run the security validation tests

---

## License

No license file is included. If you plan to publish or distribute this project, add a license (for example MIT) or clarify the terms of use.

---

## Acknowledgements

- OpenStreetMap and Overpass communities
- Leaflet, `@tmcw/togeojson`, `togpx`, `fit-file-parser`, Express, and Undici
