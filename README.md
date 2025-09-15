# GPX Water Mapper

Find potable water sources along a GPX route. Upload a GPX file, visualize your route on a map, automatically fetch nearby water points from OpenStreetMap via Overpass, and download an enriched GPX with waypoints added.

> Built with Leaflet on the frontend and a small Express proxy for Overpass queries and tile fetching. Optional Docker services provide a local Overpass instance and a raster tile server for fully offline-friendly workflows.

---

## Features

- Upload or drag-and-drop a `.gpx` file
- Interactive map with your route and water markers
- Adaptive Overpass querying with split-and-retry for large bounding boxes or rate limits
- One-click download of an enriched `.gpx` including water waypoints
- Local proxy for Overpass and tiles to avoid CORS and respect usage policies
- Optional Docker stack to run Overpass and a local raster tile server

---

## Quick Start

You can run against public services or spin up everything locally.

### Option A: Use public Overpass and OSM tiles (fastest to try)

```bash
npm install
npm start
# Open http://localhost:3000
```

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

- Frontend (`index.html`, `app.js`, `osmApi.js`)
  - Renders a Leaflet map and your GPX route
  - Computes a bounding box for the route
  - Queries Overpass for water features: `amenity=drinking_water`, `natural=spring`, `man_made=water_tap`
  - Adaptively splits the bbox and retries on 400/429/504 responses
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
├─ osmApi.js           # Small OSM/Overpass utilities with adaptive splitting
├─ styles.css          # Basic styles
├─ routes/
│  └─ losAltos-MorganHill.gpx  # Example route
├─ server/
│  └─ index.js         # Express server + Overpass/tile proxy
├─ docker-compose.yml  # Local Overpass + tile server stack
├─ README-local.md     # Local quick notes
└─ package.json
```

---

## Running locally

### Prerequisites

- Node.js 18+ (or a runtime compatible with `undici` and ESM in browsers)
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
npm start
```

If you leave variables unset, sane defaults will be used:

- `OVERPASS_URL`: `https://overpass-api.de/api/interpreter`
- `TILE_URL_TEMPLATE`: `https://tile.openstreetmap.org/{z}/{x}/{y}.png`
- `PORT`: `3000`

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
2. Click “Select GPX” or drag-and-drop a `.gpx` file.
3. The route is parsed and displayed. The app computes the route bbox and queries Overpass for nearby water points.
4. Water markers are added to the map. Hover/tap to see basic details.
5. Click “Download enriched GPX” to save a new `.gpx` that includes the water waypoints along with your original track(s).

Implementation notes:

- GPX parsing is handled by `@tmcw/togeojson` in the browser.
- GPX export is handled by `togpx` by combining route features with water waypoints.
- Map rendering uses Leaflet.

---

## API (local proxy)

The Express server exposes a few endpoints:

- `GET /` – serves `index.html`
- `GET /app.js`, `GET /styles.css`, `GET /osmApi.js`, `GET /test.html` – static assets
- `GET /health` – simple health check
- `POST /api/overpass` – Overpass proxy
  - Accepts either `application/json` with `{ query: "..." }` or `application/x-www-form-urlencoded` with `data=...`
  - Returns Overpass response as text, passing through the content-type when available
- `GET /tiles/{z}/{x}/{y}.png` – tile proxy
  - Fetches the tile from `TILE_URL_TEMPLATE` and forwards it with caching headers

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
- `npm run dev` – Start with `nodemon` for automatic restarts on file changes

---

## License

No license file is included. If you plan to publish or distribute this project, add a license (for example MIT) or clarify the terms of use.

---

## Acknowledgements

- OpenStreetMap and Overpass communities
- Leaflet, `@tmcw/togeojson`, `togpx`, Express, and Undici
