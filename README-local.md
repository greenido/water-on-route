Local Overpass + Tile Proxy

Quick start

1) Start Overpass and optional tiles via Docker (macOS/Linux):

cd /Applications/MAMP/htdocs/thirsty/water-on-route
docker compose up -d

- Overpass: http://localhost:12345/api/interpreter (first init may take time)
- Tileserver (optional): http://localhost:8080

2) Start Node proxy:

npm install
OVERPASS_URL=http://localhost:12345/api/interpreter \
TILE_URL_TEMPLATE=http://localhost:8080/data/v3/{z}/{x}/{y}.png \
npm start

3) Frontend config (already set):

`index.html` points to the local proxy at port 3000:

<script>
  window.WOR_CONFIG = {
    overpassUrl: 'http://localhost:3000/api/overpass',
    tileUrl: 'http://localhost:3000/tiles/{z}/{x}/{y}.png'
  };
</script>

Notes

- Swap `OVERPASS_PLANET_URL` in `docker-compose.yml` to another region or the full planet.
- Initial Overpass import can take hours for large extracts.
- The app queries Overpass for nodes/ways/relations tagged as drinking water or springs.


