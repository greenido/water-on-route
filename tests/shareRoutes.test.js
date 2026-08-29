const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Set a dedicated temp DB path before loading db.js
const tempDbPath = path.join(os.tmpdir(), `test-share-routes-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite3`);
process.env.ROUTES_DB_PATH = tempDbPath;

const {
  initDatabase,
  insertRoute,
  getRouteById,
  getRouteByShareToken
} = require('../server/db');
const { validateShareToken } = require('../server/security');

test.before(async () => {
  await initDatabase();
});

test.after(() => {
  try {
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
  } catch (_) {}
});

test('insertRoute automatically generates a valid shareToken', async () => {
  const payload = {
    filename: 'mount-tam.gpx',
    fileSize: 1234,
    bbox: { minlat: 37.8, minlon: -122.6, maxlat: 37.9, maxlon: -122.5 },
    routeKm: 42.5,
    waypointsCount: 5,
    gpxText: '<gpx version="1.1"><trk><trkseg><trkpt lat="37.8" lon="-122.6"></trkpt></trkseg></trk></gpx>',
    clientIp: '192.0.2.0',
    waterPoints: [{ lat: 37.85, lon: -122.55, tags: { amenity: 'drinking_water' } }]
  };

  const result = await insertRoute(payload);
  assert.ok(result.id > 0, 'Should have positive numeric ID');
  assert.ok(result.shareToken, 'Should return a shareToken');
  assert.equal(typeof result.shareToken, 'string');
  assert.equal(validateShareToken(result.shareToken), true, 'shareToken must satisfy validateShareToken');
  // base64url uses _ which Slack/markdown split, turning ?route=ab_cd into ?route=ab
  // (HTTP 400: too short). Hex never hits that class of chat-app URL breakers.
  assert.match(result.shareToken, /^[0-9a-f]{32}$/);

  const row = await getRouteById(result.id);
  assert.equal(row.shareToken, result.shareToken, 'getRouteById must return the shareToken');
  assert.equal(row.clientIp, '192.0.2.0', 'getRouteById preserves clientIp for admin');
});

test('getRouteByShareToken retrieves the route and protects visitor privacy', async () => {
  const payload = {
    filename: 'ridge-trail.gpx',
    fileSize: 2048,
    bbox: { minlat: 37.7, minlon: -122.4, maxlat: 37.8, maxlon: -122.3 },
    routeKm: 25.0,
    waypointsCount: 2,
    gpxText: '<gpx version="1.1"><trk></trk></gpx>',
    clientIp: '198.51.100.0',
    waterPoints: [{ lat: 37.75, lon: -122.35, tags: { amenity: 'drinking_water' } }]
  };

  const saved = await insertRoute(payload);
  const shared = await getRouteByShareToken(saved.shareToken);

  assert.ok(shared, 'Must find route by share token');
  assert.equal(shared.id, saved.id);
  assert.equal(shared.filename, 'ridge-trail.gpx');
  assert.equal(shared.routeKm, 25.0);
  assert.equal(shared.waypointsCount, 2);
  assert.equal(shared.shareToken, saved.shareToken);
  assert.deepEqual(shared.bbox, payload.bbox);
  assert.deepEqual(shared.waterPoints, payload.waterPoints);
  assert.equal(shared.gpxText, payload.gpxText);
  // Ensure visitor privacy: clientIp should not be exposed in shared representation
  assert.equal(shared.clientIp, undefined, 'clientIp must not be exposed by getRouteByShareToken');
});

test('getRouteByShareToken returns null for unknown or invalid tokens', async () => {
  const notFound = await getRouteByShareToken('non_existent_token_123');
  assert.equal(notFound, null);
});
