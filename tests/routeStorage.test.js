const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const sqlite3 = require('sqlite3');

const tempDbPath = path.join(
  os.tmpdir(),
  `test-route-storage-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite3`
);
process.env.ROUTES_DB_PATH = tempDbPath;

const {
  initDatabase,
  insertRoute,
  getRouteById,
  getRouteByShareToken,
  databaseUsedBytes,
  uploadedBytesLastDay,
  purgeExpiredRoutes,
  deleteRouteById,
  listRouteIds
} = require('../server/db');
const { storeUpload, deleteSharedRoute } = require('../server/routeStorage');

const MB = 1024 * 1024;
const LIMITS = { retentionDays: 90, dailyBudgetBytes: 512 * MB, maxBytes: 512 * MB };

let uniqueFile = 0;
const gpx = (padding = 0) => `<gpx version="1.1"><!-- ${++uniqueFile} ${'x'.repeat(padding)} --></gpx>`;
const route = (gpxText = gpx()) => ({
  filename: 'ride.gpx',
  gpxText,
  bbox: null,
  routeKm: 10,
  waypointsCount: 1,
  waterPoints: [{ id: 1, lat: 1, lon: 2 }],
  clientIp: '192.0.2.0'
});
const save = (r = route(), limits = {}) => storeUpload(r, { share: false, ...LIMITS, ...limits });
const share = (r = route(), limits = {}) => storeUpload(r, { share: true, ...LIMITS, ...limits });

// A second connection, to set up states the API deliberately cannot reach.
function sql(statement, params = []) {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(tempDbPath, (openErr) => {
      if (openErr) return reject(openErr);
      database.all(statement, params, (err, rows) => {
        database.close();
        if (err) return reject(err);
        resolve(rows);
      });
    });
  });
}

async function clearRoutes() {
  for (const id of await listRouteIds()) await deleteRouteById(id);
}

test.before(async () => {
  await initDatabase();
});

test.beforeEach(clearRoutes);

test.after(() => {
  try {
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
  } catch (_) {}
});

test('saving hands back no link, so the route cannot be reached by anyone else', async () => {
  const saved = await save();
  assert.equal(saved.outcome, 'saved');
  assert.equal(saved.shareToken, undefined);
  assert.equal(saved.deleteToken, undefined);
  const row = await getRouteById(saved.id);
  assert.equal(row.shareToken, null);
});

test('saving the same file twice stores it once', async () => {
  const file = route();
  const first = await save(file);
  const second = await save({ ...file, filename: 'renamed.gpx' });
  assert.equal(second.id, first.id);
  assert.equal((await listRouteIds()).length, 1);
});

test('saving a file that already has a link adds nothing and reveals nothing', async () => {
  const file = route();
  const shared = await share(file);
  const saved = await save(file);
  assert.equal(saved.id, shared.id);
  assert.equal(saved.shareToken, undefined);
});

test('sharing returns a link, in hex so chat apps cannot break it', async () => {
  const shared = await share();
  // base64url uses _ which Slack/markdown split, turning ?route=ab_cd into ?route=ab
  // (HTTP 400: too short). Hex never hits that class of chat-app URL breakers.
  assert.match(shared.shareToken, /^[0-9a-f]{32}$/);
  assert.match(shared.deleteToken, /^[0-9a-f]{32}$/);
  assert.notEqual(shared.shareToken, shared.deleteToken);
  const opened = await getRouteByShareToken(shared.shareToken);
  assert.equal(opened.id, shared.id);
  assert.equal(opened.deleteTokenHash, undefined, 'the delete proof must never reach a recipient');
});

test('sharing a route that was already saved reuses its row and stops it expiring', async () => {
  const file = route();
  const saved = await save(file);
  const [before] = await sql('SELECT expires_at FROM routes WHERE id = ?', [saved.id]);
  assert.ok(before.expires_at);

  const updated = { ...file, waterPoints: [{ id: 2, lat: 3, lon: 4 }], waypointsCount: 7 };
  const shared = await share(updated);
  assert.equal(shared.id, saved.id);
  assert.equal((await listRouteIds()).length, 1);
  const [after] = await sql('SELECT expires_at FROM routes WHERE id = ?', [saved.id]);
  assert.equal(after.expires_at, null);
  const opened = await getRouteByShareToken(shared.shareToken);
  assert.deepEqual(opened.waterPoints, updated.waterPoints, 'keeps the latest water points');
  assert.equal(opened.waypointsCount, 7);
});

test('two riders sharing one file each get their own link', async () => {
  const file = route();
  const first = await share(file);
  const second = await share(file);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.shareToken, second.shareToken);

  // One rider taking theirs down must not break the other's.
  assert.equal(await deleteSharedRoute(first.shareToken, first.deleteToken), 'deleted');
  assert.equal(await getRouteByShareToken(first.shareToken), null);
  assert.ok(await getRouteByShareToken(second.shareToken));
});

test('only the delete token created with a link can delete it', async () => {
  const mine = await share();
  const theirs = await share();
  assert.equal(await deleteSharedRoute(mine.shareToken, theirs.deleteToken), 'forbidden');
  assert.equal(await deleteSharedRoute(mine.shareToken, ''), 'forbidden');
  assert.equal(await deleteSharedRoute(mine.shareToken, undefined), 'forbidden');
  assert.ok(await getRouteByShareToken(mine.shareToken));
  assert.equal(await deleteSharedRoute('00000000000000000000000000000000', mine.deleteToken), 'missing');
});

test('a link from before delete tokens existed cannot be deleted by guessing', async () => {
  const { shareToken } = await insertRoute({ ...route(), fileSize: 10, shareToken: 'abad1dea00000000abad1dea00000000' });
  assert.equal(await deleteSharedRoute(shareToken, 'anything'), 'forbidden');
  assert.ok(await getRouteByShareToken(shareToken));
});

test('the delete token is stored only as a hash', async () => {
  const shared = await share();
  const [row] = await sql('SELECT delete_token_hash FROM routes WHERE id = ?', [shared.id]);
  assert.ok(row.delete_token_hash);
  assert.notEqual(row.delete_token_hash, shared.deleteToken);
});

test('saved routes expire and shared routes do not', async () => {
  const expired = await save(route(), { retentionDays: -1 });
  const current = await save();
  const shared = await share();
  assert.equal(await purgeExpiredRoutes(), 1);
  assert.equal(await getRouteById(expired.id), null);
  assert.ok(await getRouteById(current.id));
  assert.ok(await getRouteById(shared.id));
});

test('rows from before expiry existed are never purged or evicted', async () => {
  // Stored under no such promise, and possibly the only record of past usage.
  const legacy = await insertRoute({ ...route(), fileSize: 10 });
  await sql(`UPDATE routes SET uploaded_at = datetime('now', '-10 years') WHERE id = ?`, [legacy.id]);
  assert.equal(await purgeExpiredRoutes(), 0);
  const used = await databaseUsedBytes();
  assert.equal((await save(route(), { maxBytes: used })).outcome, 'full');
  assert.ok(await getRouteById(legacy.id));
});

test('the daily budget stops new data but not repeats of what is already held', async () => {
  const file = route(gpx(2000));
  await save(file);
  const taken = await uploadedBytesLastDay();
  assert.ok(taken >= 2000);
  const limits = { dailyBudgetBytes: taken + 100 };
  assert.equal((await save(route(gpx(2000)), limits)).outcome, 'over_budget');
  assert.equal((await share(route(gpx(2000)), limits)).outcome, 'over_budget');
  assert.equal((await save(file, limits)).outcome, 'saved');
  // Sharing what is already held needs no new space either, so it must still work.
  assert.ok((await share(file, limits)).shareToken);
});

test('the daily budget only counts the last 24 hours', async () => {
  const old = await save(route(gpx(2000)));
  await sql(`UPDATE routes SET uploaded_at = datetime('now', '-2 days') WHERE id = ?`, [old.id]);
  assert.equal(await uploadedBytesLastDay(), 0);
});

test('at the cap the oldest saved routes make way, and shared routes stay', async () => {
  const shared = await share(route(gpx(40000)));
  const oldest = await save(route(gpx(40000)));
  await save(route(gpx(40000)));
  await sql(`UPDATE routes SET uploaded_at = datetime('now', '-1 day') WHERE id = ?`, [oldest.id]);

  const used = await databaseUsedBytes();
  const next = await save(route(gpx(40000)), { maxBytes: used + 20000 });
  assert.equal(next.outcome, 'saved');
  assert.equal(await getRouteById(oldest.id), null, 'oldest saved route goes first');
  assert.ok(await getRouteByShareToken(shared.shareToken), 'shared route is kept');
});

test('with only shared routes left at the cap, uploads are refused rather than breaking links', async () => {
  const shared = await share(route(gpx(40000)));
  const used = await databaseUsedBytes();
  assert.equal((await save(route(gpx(40000)), { maxBytes: used })).outcome, 'full');
  assert.ok(await getRouteByShareToken(shared.shareToken));
});

test('clearing rows frees room, though the file itself stays the same size', async () => {
  // Regression: "full" was read from the file size, which SQLite never shrinks,
  // so a database that once hit the cap stayed full however much was deleted.
  const big = await save(route(gpx(200000)));
  const usedBefore = await databaseUsedBytes();
  const fileBefore = fs.statSync(tempDbPath).size;
  await deleteRouteById(big.id);
  assert.ok(await databaseUsedBytes() < usedBefore);
  assert.equal(fs.statSync(tempDbPath).size, fileBefore);
});

test('a single upload bigger than the whole cap is refused without clearing anything', async () => {
  const saved = await save();
  assert.equal((await save(route(gpx(5000)), { maxBytes: 1000 })).outcome, 'full');
  assert.ok(await getRouteById(saved.id));
});
