import test from 'node:test';
import assert from 'node:assert/strict';

import { haversineMeters, routeTiles, ROUTE_TILE_DEG } from '../geo.mjs';

const lineFeature = (coordinates) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates } });
const inTile = (t, lon, lat) => lat >= t.minlat && lat <= t.maxlat && lon >= t.minlon && lon <= t.maxlon;

test('routeTiles gives a due-east route a box with real height', () => {
  // Regression: the bounding box of this route has zero height, so the query
  // could only ever return points exactly on the line.
  const tiles = routeTiles(lineFeature([[-122, 37.1], [-121, 37.1]]), 2000);
  assert.ok(tiles.length > 0);
  for (const t of tiles) assert.equal(t.maxlat - t.minlat, ROUTE_TILE_DEG, JSON.stringify(t));
});

test('routeTiles reaches past the outer edge of the route by the padding', () => {
  // A fountain 1.9 km north of the northernmost point of the route, which sits
  // just under a grid line, so it lands in the next row up.
  const lat = 37.49;
  const north = lat + 1900 / haversineMeters([-122, 37], [-122, 38]);
  const tiles = routeTiles(lineFeature([[-122.2, lat], [-122.1, lat]]), 2000);
  assert.ok(tiles.some((t) => inTile(t, -122.15, north)));
  assert.ok(north > 37.5);
});

test('routeTiles covers everything within the padding of a sparse diagonal', () => {
  // Only two vertices, far apart: the squares between them still have to appear.
  const a = [-122, 37];
  const b = [-120, 39];
  const tiles = routeTiles(lineFeature([a, b]), 2000);
  const metresPerDeg = haversineMeters([-122, 37], [-122, 38]);
  for (let t = 0; t <= 1; t += 0.01) {
    const lon = a[0] + (b[0] - a[0]) * t;
    const lat = a[1] + (b[1] - a[1]) * t;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, -0.7]]) {
      const pLat = lat + (dy * 2000) / metresPerDeg;
      const pLon = lon + (dx * 2000) / (metresPerDeg * Math.cos(lat * Math.PI / 180));
      assert.ok(tiles.some((tile) => inTile(tile, pLon, pLat)), `missed ${pLon},${pLat}`);
    }
  }
});

test('routeTiles skips most of the bounding box on a diagonal route', () => {
  const tiles = routeTiles(lineFeature([[-122.1, 37.1], [-117.1, 42.1]]), 2000);
  const gridSquaresInBox = (5 / ROUTE_TILE_DEG) * (5 / ROUTE_TILE_DEG);
  assert.ok(tiles.length < gridSquaresInBox / 2, `${tiles.length} of ${gridSquaresInBox}`);
});

test('routeTiles returns the same squares for overlapping routes, so they share cache entries', () => {
  const key = (t) => `${t.minlat},${t.minlon}`;
  const whole = new Set(routeTiles(lineFeature([[-122, 37.1], [-121, 37.1]]), 2000).map(key));
  const part = routeTiles(lineFeature([[-121.6, 37.1], [-121.3, 37.1]]), 2000).map(key);
  for (const k of part) assert.ok(whole.has(k), k);
  assert.deepEqual(
    routeTiles(lineFeature([[-121.6, 37.1], [-121.3, 37.1]]), 2000),
    routeTiles(lineFeature([[-121.6, 37.1], [-121.3, 37.1]]), 2000)
  );
});

test('routeTiles squares are valid at the antimeridian and for a route with no line', () => {
  const tiles = routeTiles(lineFeature([[179.99, 10], [179.999, 10]]), 2000);
  assert.ok(tiles.length > 0);
  for (const t of tiles) assert.ok(t.maxlon <= 180 && t.minlon < t.maxlon);
  assert.deepEqual(routeTiles({ type: 'FeatureCollection', features: [] }, 2000), []);
});
