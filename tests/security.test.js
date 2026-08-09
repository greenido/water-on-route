const test = require('node:test');
const assert = require('node:assert/strict');

const {
  safeEqual,
  validateRoutePayload,
  validateTileCoordinates,
  isAllowedOrigin,
  normalizeHttpUrl,
  positiveInteger,
  anonymizeIp
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

test('anonymizeIp drops the host portion of IPv4 addresses', () => {
  assert.equal(anonymizeIp('203.0.113.45'), '203.0.113.0');
  assert.equal(anonymizeIp('  8.8.8.8  '), '8.8.8.0');
  assert.equal(anonymizeIp('127.0.0.1'), '127.0.0.0');
});

test('anonymizeIp keeps only the /48 of IPv6 addresses', () => {
  assert.equal(anonymizeIp('2001:db8:85a3:8d3:1319:8a2e:370:7348'), '2001:db8:85a3::');
  assert.equal(anonymizeIp('2001:db8:85a3::8a2e:370:7334'), '2001:db8:85a3::');
  assert.equal(anonymizeIp('::1'), '0:0:0::');
});

test('anonymizeIp normalizes IPv4-mapped IPv6 to the IPv4 form', () => {
  assert.equal(anonymizeIp('::ffff:203.0.113.45'), '203.0.113.0');
});

test('anonymizeIp rejects anything that is not an address', () => {
  assert.equal(anonymizeIp(null), null);
  assert.equal(anonymizeIp(undefined), null);
  assert.equal(anonymizeIp(''), null);
  assert.equal(anonymizeIp('   '), null);
  assert.equal(anonymizeIp('not-an-ip'), null);
  assert.equal(anonymizeIp('999.1.1.1'), null);
  assert.equal(anonymizeIp(12345), null);
});

test('anonymizeIp is idempotent, so re-storing a value cannot widen it', () => {
  assert.equal(anonymizeIp(anonymizeIp('203.0.113.45')), '203.0.113.0');
  assert.equal(anonymizeIp(anonymizeIp('2001:db8:85a3::8a2e:370:7334')), '2001:db8:85a3::');
});

test('positiveInteger bounds numeric environment configuration', () => {
  assert.equal(positiveInteger(undefined, 20, 1, 100), 20);
  assert.equal(positiveInteger('25', 20, 1, 100), 25);
  assert.throws(() => positiveInteger('0', 20, 1, 100), /between 1 and 100/);
  assert.throws(() => positiveInteger('not-a-number', 20, 1, 100), /between 1 and 100/);
});
