const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// Prefer project data directory in development, and /data in production (Fly volumes)
const PROJECT_DATA_DIR = path.join(__dirname, '..', 'data');
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || !!process.env.FLY_APP_NAME || !!process.env.FLY_MACHINE;
const DEFAULT_DB_DIRS = IS_PRODUCTION
  ? ['/data', PROJECT_DATA_DIR]
  : [PROJECT_DATA_DIR, '/data'];

function ensureDirectory(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    return true;
  } catch (err) {
    console.error(`Failed to create directory ${dirPath}:`, err);
    return false;
  }
}

function resolveDatabasePath() {
  const envPath = process.env.ROUTES_DB_PATH;
  if (envPath) {
    const dir = path.dirname(envPath);
    if (ensureDirectory(dir)) {
      return envPath;
    }
  }
  for (const dir of DEFAULT_DB_DIRS) {
    if (ensureDirectory(dir)) {
      return path.join(dir, 'routes.sqlite3');
    }
  }
  // fallback to cwd
  return path.join(process.cwd(), 'routes.sqlite3');
}

const DB_PATH = resolveDatabasePath();
let db;

function initDatabase() {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) return reject(err);
      db.run(
        `CREATE TABLE IF NOT EXISTS routes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          filename TEXT,
          file_size INTEGER,
          bbox TEXT,
          route_km REAL,
          waypoints_count INTEGER,
          gpx_text TEXT,
          uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        (createErr) => {
          if (createErr) return reject(createErr);
          // Best-effort schema migration for new columns
          migrateSchema().then(resolve).catch(reject);
        }
      );
    });
  });
}

function migrateSchema() {
  return new Promise((resolve) => {
    db.all(`PRAGMA table_info(routes)`, [], (err, rows) => {
      if (err) {
        console.warn('PRAGMA table_info failed, skipping migrations:', err);
        return resolve();
      }
      const cols = new Set(rows.map(r => r.name));
      const migrations = [];
      if (!cols.has('client_ip')) migrations.push(`ALTER TABLE routes ADD COLUMN client_ip TEXT`);
      if (!cols.has('water_points_json')) migrations.push(`ALTER TABLE routes ADD COLUMN water_points_json TEXT`);
      if (!cols.has('enriched_gpx_text')) migrations.push(`ALTER TABLE routes ADD COLUMN enriched_gpx_text TEXT`);
      if (migrations.length === 0) return resolve();
      let idx = 0;
      const runNext = () => {
        if (idx >= migrations.length) return resolve();
        const sql = migrations[idx++];
        db.run(sql, [], (e) => {
          if (e) console.warn('Migration step failed:', sql, e);
          runNext();
        });
      };
      runNext();
    });
  });
}

function insertRoute({ filename, fileSize, bbox, routeKm, waypointsCount, gpxText, clientIp, waterPoints, enrichedGpxText }) {
  return new Promise((resolve, reject) => {
    const stmt = `INSERT INTO routes (filename, file_size, bbox, route_km, waypoints_count, gpx_text, client_ip, water_points_json, enriched_gpx_text)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const waterJson = waterPoints ? JSON.stringify(waterPoints) : null;
    db.run(stmt, [filename || null, fileSize || null, JSON.stringify(bbox || null), routeKm || null, waypointsCount || null, gpxText || null, clientIp || null, waterJson, enrichedGpxText || null], function(err) {
      if (err) return reject(err);
      resolve({ id: this.lastID });
    });
  });
}

function listRoutes() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT id, filename, file_size, bbox, route_km, waypoints_count, uploaded_at, client_ip, enriched_gpx_text FROM routes ORDER BY uploaded_at DESC`, [], (err, rows) => {
      if (err) return reject(err);
      try {
        const mapped = rows.map(r => ({
          id: r.id,
          filename: r.filename,
          fileSize: r.file_size,
          bbox: safeParseJson(r.bbox),
          routeKm: r.route_km,
          waypointsCount: r.waypoints_count,
          uploadedAt: r.uploaded_at,
          clientIp: r.client_ip || null,
          hasEnriched: !!r.enriched_gpx_text
        }));
        resolve(mapped);
      } catch (e) {
        resolve(rows);
      }
    });
  });
}

function getRouteById(id) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT id, filename, file_size, bbox, route_km, waypoints_count, gpx_text, enriched_gpx_text, water_points_json, uploaded_at, client_ip FROM routes WHERE id = ?`, [id], (err, row) => {
      if (err) return reject(err);
      if (!row) return resolve(null);
      resolve({
        id: row.id,
        filename: row.filename,
        fileSize: row.file_size,
        bbox: safeParseJson(row.bbox),
        routeKm: row.route_km,
        waypointsCount: row.waypoints_count,
        gpxText: row.gpx_text,
        enrichedGpxText: row.enriched_gpx_text,
        waterPoints: safeParseJson(row.water_points_json),
        uploadedAt: row.uploaded_at,
        clientIp: row.client_ip
      });
    });
  });
}

function safeParseJson(txt) {
  try {
    const parsed = JSON.parse(txt);
    return parsed;
  } catch (err) {
    console.warn('safeParseJson: Failed to parse JSON:', txt, 'Error:', err);
    return null;
  }
}

module.exports = {
  DB_PATH,
  initDatabase,
  insertRoute,
  listRoutes,
  getRouteById
};


