const test = require('node:test');
const assert = require('node:assert/strict');

const {
  safeEqual,
  validateRoutePayload,
  validateTileCoordinates,
  isAllowedOrigin,
  normalizeHttpUrl
} = require('../server/security');

test('safeEqual accepts equal values and rejects different lengths and values', () => {
  assert.equal(safeEqual('admin', 'admin'), true);
  assert.equal(safeEqual('admin', 'other'), false);
  assert.equal(safeEqual('admin', 'admin-longer'), false);
});

test('validateRoutePayload accepts a bounded GPX payload', () => {
  const result = validateRoutePayload({
    filename: 'route.gpx',
    gpxText: '<?xml version="1.0"?><gpx></gpx>',
    enrichedGpxText: '<gpx></gpx>',
    bbox: { minlat: 1, minlon: 2, maxlat: 3, maxlon: 4 },
    routeKm: 12.5,
    waypointsCount: 2,
    waterPoints: [{ id: 1 }]
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.filename, 'route.gpx');
});

test('validateRoutePayload accepts GPX content up to 8 MB', () => {
  const gpxText = `<gpx>${'a'.repeat(8 * 1024 * 1024 - 16)}</gpx>`;
  const result = validateRoutePayload({
    filename: 'route.gpx',
    gpxText
  });
  assert.equal(result.ok, true);
});

test('validateRoutePayload rejects oversized and non-GPX content', () => {
  assert.equal(validateRoutePayload({
    filename: 'route.gpx',
    gpxText: `<gpx>${'x'.repeat(8 * 1024 * 1024)}</gpx>`
  }).ok, false);
  assert.equal(validateRoutePayload({
    filename: 'route.txt',
    gpxText: '<script>alert(1)</script>'
  }).ok, false);
});

test('validateTileCoordinates enforces Web Mercator bounds', () => {
  assert.deepEqual(validateTileCoordinates('3', '7', '7'), { z: 3, x: 7, y: 7 });
  assert.equal(validateTileCoordinates('23', '0', '0'), null);
  assert.equal(validateTileCoordinates('3', '8', '0'), null);
  assert.equal(validateTileCoordinates('x', '0', '0'), null);
});

test('isAllowedOrigin permits same-origin and non-browser requests only', () => {
  assert.equal(isAllowedOrigin(undefined, 'water.example'), true);
  assert.equal(isAllowedOrigin('https://water.example', 'water.example'), true);
  assert.equal(isAllowedOrigin('https://evil.example', 'water.example'), false);
  assert.equal(isAllowedOrigin('not a URL', 'water.example'), false);
});

test('normalizeHttpUrl accepts HTTP URLs and rejects script schemes', () => {
  assert.equal(normalizeHttpUrl('https://example.com/path'), 'https://example.com/path');
  assert.equal(normalizeHttpUrl('example.com'), 'https://example.com/');
  assert.equal(normalizeHttpUrl('javascript:alert(1)'), null);
});
