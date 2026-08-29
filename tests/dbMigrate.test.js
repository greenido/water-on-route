const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const sqlite3 = require('sqlite3');

// Reproduce Fly's situation: a pre-share_token routes table that already has rows.
const tempDbPath = path.join(
  os.tmpdir(),
  `test-db-migrate-share-token-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite3`
);
process.env.ROUTES_DB_PATH = tempDbPath;

const {
  initDatabase,
  insertRoute,
  getRouteById,
  getRouteByShareToken
} = require('../server/db');

function openDb(filePath) {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(filePath, (err) => {
      if (err) return reject(err);
      resolve(database);
    });
  });
}

function closeDb(database) {
  return new Promise((resolve, reject) => {
    database.close((err) => (err ? reject(err) : resolve()));
  });
}

function runSql(database, sql, params = []) {
  return new Promise((resolve, reject) => {
    database.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function allSql(database, sql, params = []) {
  return new Promise((resolve, reject) => {
    database.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

test.before(async () => {
  const database = await openDb(tempDbPath);
  await runSql(
    database,
    `CREATE TABLE routes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT,
      file_size INTEGER,
      bbox TEXT,
      route_km REAL,
      waypoints_count INTEGER,
      gpx_text TEXT,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );
  await runSql(
    database,
    `INSERT INTO routes (filename, file_size, bbox, route_km, waypoints_count, gpx_text)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['legacy.gpx', 100, '{}', 12.5, 3, '<gpx></gpx>']
  );
  await closeDb(database);
  await initDatabase();
});

test.after(() => {
  try {
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
  } catch (_) {}
});

test('migrateSchema adds share_token to a non-empty legacy routes table', async () => {
  const legacy = await getRouteById(1);
  assert.ok(legacy, 'pre-existing row must still be readable');
  assert.equal(legacy.filename, 'legacy.gpx');
  assert.equal(legacy.shareToken, null);

  const database = await openDb(tempDbPath);
  try {
    const cols = await allSql(database, 'PRAGMA table_info(routes)');
    assert.ok(cols.some((col) => col.name === 'share_token'), 'share_token column must exist after migrate');
    const indexes = await allSql(database, 'PRAGMA index_list(routes)');
    const shareTokenIndex = indexes.find((idx) => idx.name === 'idx_routes_share_token');
    assert.ok(shareTokenIndex, 'unique index idx_routes_share_token must exist');
    assert.equal(Number(shareTokenIndex.unique), 1);
  } finally {
    await closeDb(database);
  }
});

test('insertRoute works after migrating a populated legacy database', async () => {
  const saved = await insertRoute({
    filename: 'new-after-migrate.gpx',
    fileSize: 50,
    bbox: { minlat: 1, minlon: 2, maxlat: 3, maxlon: 4 },
    routeKm: 1,
    waypointsCount: 1,
    gpxText: '<gpx></gpx>',
    shareToken: 'migratedtok1'
  });
  assert.ok(saved.id > 1);
  const byToken = await getRouteByShareToken('migratedtok1');
  assert.ok(byToken);
  assert.equal(byToken.id, saved.id);

  await assert.rejects(
    () => insertRoute({
      filename: 'dup.gpx',
      fileSize: 1,
      bbox: null,
      routeKm: 1,
      waypointsCount: 1,
      gpxText: '<gpx></gpx>',
      shareToken: 'migratedtok1'
    }),
    /UNIQUE|constraint/i
  );
});
