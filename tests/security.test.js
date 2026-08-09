const test = require('node:test');
const assert = require('node:assert/strict');

const {
  safeEqual,
  validateRoutePayload,
  validateTileCoordinates,
  isAllowedOrigin,
  normalizeHttpUrl,
  positiveInteger,
  anonymizeIp,
  validateBbox,
  MAX_BBOX_SPAN_DEGREES
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

test('isAllowedOrigin can require the Origin header for state-changing routes', () => {
  const strict = { allowMissing: false };
  assert.equal(isAllowedOrigin(undefined, 'water.example', strict), false);
  assert.equal(isAllowedOrigin('', 'water.example', strict), false);
  assert.equal(isAllowedOrigin('https://water.example', 'water.example', strict), true);
  assert.equal(isAllowedOrigin('https://evil.example', 'water.example', strict), false);
});

test('validateBbox accepts a well-formed box and normalizes to four keys', () => {
  const result = validateBbox({ minlat: 37, minlon: -122.4, maxlat: 37.4, maxlon: -122, extra: 'ignored' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { minlat: 37, minlon: -122.4, maxlat: 37.4, maxlon: -122 });
});

test('validateBbox rejects missing, malformed and non-numeric input', () => {
  assert.equal(validateBbox(undefined).ok, false);
  assert.equal(validateBbox(null).ok, false);
  assert.equal(validateBbox('37,-122').ok, false);
  assert.equal(validateBbox([37, -122, 38, -121]).ok, false);
  assert.equal(validateBbox({ minlat: 37, minlon: -122 }).ok, false);
  assert.equal(validateBbox({ minlat: NaN, minlon: 0, maxlat: 1, maxlon: 1 }).ok, false);
  assert.equal(validateBbox({ minlat: '37', minlon: 0, maxlat: 1, maxlon: 1 }).ok, false);
});

test('validateBbox rejects out-of-range and inverted bounds', () => {
  assert.equal(validateBbox({ minlat: -91, minlon: 0, maxlat: 1, maxlon: 1 }).ok, false);
  assert.equal(validateBbox({ minlat: 0, minlon: 0, maxlat: 91, maxlon: 1 }).ok, false);
  assert.equal(validateBbox({ minlat: 0, minlon: -181, maxlat: 1, maxlon: 1 }).ok, false);
  assert.equal(validateBbox({ minlat: 0, minlon: 0, maxlat: 1, maxlon: 181 }).ok, false);
  assert.match(validateBbox({ minlat: 5, minlon: 0, maxlat: 1, maxlon: 1 }).error, /inverted/);
  assert.match(validateBbox({ minlat: 0, minlon: 5, maxlat: 1, maxlon: 1 }).error, /inverted/);
});

test('validateBbox caps the span so one request cannot ask for a continent', () => {
  const over = MAX_BBOX_SPAN_DEGREES + 0.1;
  assert.match(validateBbox({ minlat: 0, minlon: 0, maxlat: over, maxlon: 1 }).error, /too large/);
  assert.match(validateBbox({ minlat: 0, minlon: 0, maxlat: 1, maxlon: over }).error, /too large/);
  // The whole planet is the case that matters most.
  assert.match(validateBbox({ minlat: -90, minlon: -180, maxlat: 90, maxlon: 180 }).error, /too large/);
  // A box exactly at the cap is still allowed.
  assert.equal(validateBbox({ minlat: 0, minlon: 0, maxlat: MAX_BBOX_SPAN_DEGREES, maxlon: 1 }).ok, true);
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
