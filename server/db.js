/**
 * Database utilities for route storage (SQLite3)
 *
 * Responsibilities:
 * - Resolve database path based on environment
 * - Initialize database and run lightweight migrations
 * - Provide CRUD helpers for routes table
 *
 * Environment variables:
 * - ROUTES_DB_PATH: explicit SQLite file path
 * - NODE_ENV: production/development toggle
 * - FLY_APP_NAME / FLY_MACHINE: production detection on Fly.io
 *
 * Exports: DB_PATH, initDatabase, insertRoute, listRoutes, getRouteById
 */
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { clampListLimit, clampListOffset } = require('./pagination');

// Per-operation tracing is useful when a Fly volume misbehaves and pure noise
// the rest of the time. Errors and warnings always log; this gates the rest.
const DEBUG_DB = process.env.DEBUG_DB === 'true';
const debugLog = DEBUG_DB ? (...args) => console.debug(...args) : () => {};

// Prefer project data directory in development, and /data in production (Fly volumes)
const PROJECT_DATA_DIR = path.join(__dirname, '..', 'data');
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || !!process.env.FLY_APP_NAME || !!process.env.FLY_MACHINE;
const DEFAULT_DB_DIRS = IS_PRODUCTION
  ? ['/data', PROJECT_DATA_DIR]
  : [PROJECT_DATA_DIR, '/data'];

function ensureDirectory(dirPath) {
  const startTime = Date.now();
  debugLog('[db.ensureDirectory] start', { dirPath });
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    const elapsedMs = Date.now() - startTime;
    debugLog('[db.ensureDirectory] success', { dirPath, elapsedMs });
    return true;
  } catch (err) {
    const elapsedMs = Date.now() - startTime;
    console.error('[db.ensureDirectory] failed', { dirPath, elapsedMs, error: err });
    return false;
  }
}

function resolveDatabasePath() {
  const startTime = Date.now();
  debugLog('[db.resolveDatabasePath] start');
  const envPath = process.env.ROUTES_DB_PATH;
  if (envPath) {
    const dir = path.dirname(envPath);
    if (ensureDirectory(dir)) {
      const elapsedMs = Date.now() - startTime;
      debugLog('[db.resolveDatabasePath] using env path', { envPath, elapsedMs });
      return envPath;
    }
  }
  for (const dir of DEFAULT_DB_DIRS) {
    if (ensureDirectory(dir)) {
      const resolved = path.join(dir, 'routes.sqlite3');
      const elapsedMs = Date.now() - startTime;
      debugLog('[db.resolveDatabasePath] resolved default', { dir, resolved, elapsedMs });
      return resolved;
    }
  }
  // fallback to cwd
  const fallback = path.join(process.cwd(), 'routes.sqlite3');
  const elapsedMs = Date.now() - startTime;
  debugLog('[db.resolveDatabasePath] fallback cwd', { fallback, elapsedMs });
  return fallback;
}

const DB_PATH = resolveDatabasePath();
let db;

function initDatabase() {
  const startTime = Date.now();
  debugLog('[db.initDatabase] opening', { DB_PATH });
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        const elapsedMs = Date.now() - startTime;
        console.error('[db.initDatabase] open failed', { DB_PATH, elapsedMs, error: err });
        return reject(err);
      }
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
          if (createErr) {
            const elapsedMs = Date.now() - startTime;
            console.error('[db.initDatabase] create table failed', { elapsedMs, error: createErr });
            return reject(createErr);
          }
          // Best-effort schema migration for new columns
          migrateSchema()
            .then(() => {
              const elapsedMs = Date.now() - startTime;
              debugLog('[db.initDatabase] ready', { elapsedMs });
              resolve();
            })
            .catch((e) => {
              const elapsedMs = Date.now() - startTime;
              console.warn('[db.initDatabase] migrate failed', { elapsedMs, error: e });
              reject(e);
            });
        }
      );
    });
  });
}

function migrateSchema() {
  const startTime = Date.now();
  debugLog('[db.migrateSchema] start');
  return new Promise((resolve) => {
    db.all(`PRAGMA table_info(routes)`, [], (err, rows) => {
      if (err) {
        const elapsedMs = Date.now() - startTime;
        console.warn('[db.migrateSchema] pragma failed, skipping', { elapsedMs, error: err });
        return resolve();
      }
      const cols = new Set(rows.map(r => r.name));
      const migrations = [];
      if (!cols.has('client_ip')) migrations.push(`ALTER TABLE routes ADD COLUMN client_ip TEXT`);
      if (!cols.has('water_points_json')) migrations.push(`ALTER TABLE routes ADD COLUMN water_points_json TEXT`);
      if (!cols.has('enriched_gpx_text')) migrations.push(`ALTER TABLE routes ADD COLUMN enriched_gpx_text TEXT`);
      // Set by scripts/reclaim-enriched.js once it has verified that rebuilding
      // reproduces the archived file, so the download path can rebuild rows
      // whose points predate the _distanceM annotation.
      if (!cols.has('enriched_regenerable')) migrations.push(`ALTER TABLE routes ADD COLUMN enriched_regenerable INTEGER NOT NULL DEFAULT 0`);
      // The listing always sorts by uploaded_at; without this every page is a
      // full scan plus a sort of the whole table.
      migrations.push(`CREATE INDEX IF NOT EXISTS idx_routes_uploaded_at ON routes (uploaded_at DESC, id DESC)`);
      if (migrations.length === 0) {
        const elapsedMs = Date.now() - startTime;
        debugLog('[db.migrateSchema] no migrations needed', { elapsedMs });
        return resolve();
      }
      let idx = 0;
      const runNext = () => {
        if (idx >= migrations.length) return resolve();
        const sql = migrations[idx++];
        db.run(sql, [], (e) => {
          if (e) console.warn('[db.migrateSchema] step failed', { sql, error: e });
          runNext();
        });
      };
      runNext();
    });
  });
}

// enriched_gpx_text is intentionally not written: it is derivable from
// gpx_text plus water_points_json and is rebuilt on download. The column stays
// so existing rows keep serving their stored copy until reclaimed.
function insertRoute({ filename, fileSize, bbox, routeKm, waypointsCount, gpxText, clientIp, waterPoints }) {
  const startTime = Date.now();
  debugLog('[db.insertRoute] inserting', { filename, fileSize, routeKm, waypointsCount, hasGpx: !!gpxText });
  return new Promise((resolve, reject) => {
    const stmt = `INSERT INTO routes (filename, file_size, bbox, route_km, waypoints_count, gpx_text, client_ip, water_points_json)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    const waterJson = waterPoints ? JSON.stringify(waterPoints) : null;
    db.run(stmt, [filename || null, fileSize || null, JSON.stringify(bbox || null), routeKm || null, waypointsCount || null, gpxText || null, clientIp || null, waterJson], function(err) {
      if (err) {
        const elapsedMs = Date.now() - startTime;
        console.error('[db.insertRoute] failed', { elapsedMs, error: err });
        return reject(err);
      }
      const elapsedMs = Date.now() - startTime;
      debugLog('[db.insertRoute] success', { id: this.lastID, elapsedMs });
      resolve({ id: this.lastID });
    });
  });
}

function countRoutes() {
  return new Promise((resolve, reject) => {
    db.get(`SELECT count(*) AS total FROM routes`, [], (err, row) => {
      if (err) return reject(err);
      resolve(row ? row.total : 0);
    });
  });
}

/**
 * Page of route metadata, newest first.
 *
 * Deliberately does not select gpx_text or enriched_gpx_text: the list only
 * needs to know whether an enriched version exists, and pulling the column to
 * compute a boolean read 15.7 MB to produce 1 KB of output on a 20-row table.
 * SQLite answers `IS NOT NULL` from the record header instead.
 */
function listRoutes({ limit, offset } = {}) {
  const startTime = Date.now();
  const pageSize = clampListLimit(limit);
  const skip = clampListOffset(offset);
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT id, filename, file_size, bbox, route_km, waypoints_count, uploaded_at, client_ip,
              -- An enriched download is available either from the stored copy
              -- (older rows) or by rebuilding it. Rebuilding needs every point
              -- to carry _distanceM, which marks it as the near-route
              -- selection; legacy rows stored the whole bbox instead and would
              -- otherwise offer a link that 404s. Mirrors
              -- isNearRouteSelection in server/enrichedGpx.js.
              (enriched_gpx_text IS NOT NULL
               OR enriched_regenerable = 1
               OR (json_valid(water_points_json)
                   AND json_array_length(water_points_json) > 0
                   AND NOT EXISTS (
                     SELECT 1 FROM json_each(routes.water_points_json)
                     WHERE json_extract(value, '$._distanceM') IS NULL
                   ))) AS has_enriched
       FROM routes
       ORDER BY uploaded_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      [pageSize, skip],
      (err, rows) => {
        if (err) {
          console.error('[db.listRoutes] failed', { elapsedMs: Date.now() - startTime, error: err });
          return reject(err);
        }
        const mapped = rows.map(r => ({
          id: r.id,
          filename: r.filename,
          fileSize: r.file_size,
          bbox: safeParseJson(r.bbox),
          routeKm: r.route_km,
          waypointsCount: r.waypoints_count,
          uploadedAt: r.uploaded_at,
          clientIp: r.client_ip || null,
          hasEnriched: !!r.has_enriched
        }));
        resolve({ routes: mapped, limit: pageSize, offset: skip });
      }
    );
  });
}

/**
 * Ids only, oldest first, for streaming exports that must not hold every
 * route in memory at once.
 */
function listRouteIds() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT id FROM routes ORDER BY id ASC`, [], (err, rows) => {
      if (err) return reject(err);
      resolve(rows.map(r => r.id));
    });
  });
}

function getRouteById(id) {
  const startTime = Date.now();
  debugLog('[db.getRouteById] start', { id });
  return new Promise((resolve, reject) => {
    db.get(`SELECT id, filename, file_size, bbox, route_km, waypoints_count, gpx_text, enriched_gpx_text, enriched_regenerable, water_points_json, uploaded_at, client_ip FROM routes WHERE id = ?`, [id], (err, row) => {
      if (err) {
        const elapsedMs = Date.now() - startTime;
        console.error('[db.getRouteById] failed', { id, elapsedMs, error: err });
        return reject(err);
      }
      if (!row) {
        const elapsedMs = Date.now() - startTime;
        debugLog('[db.getRouteById] not found', { id, elapsedMs });
        return resolve(null);
      }
      const result = {
        id: row.id,
        filename: row.filename,
        fileSize: row.file_size,
        bbox: safeParseJson(row.bbox),
        routeKm: row.route_km,
        waypointsCount: row.waypoints_count,
        gpxText: row.gpx_text,
        enrichedGpxText: row.enriched_gpx_text,
        enrichedRegenerable: !!row.enriched_regenerable,
        waterPoints: safeParseJson(row.water_points_json),
        uploadedAt: row.uploaded_at,
        clientIp: row.client_ip
      };
      const elapsedMs = Date.now() - startTime;
      debugLog('[db.getRouteById] success', { id, hasEnriched: !!result.enrichedGpxText, hasWater: !!result.waterPoints, elapsedMs });
      resolve(result);
    });
  });
}

// Called once per row per listing; logging here made a page load emit hundreds
// of lines and timed JSON.parse of a few hundred bytes.
function safeParseJson(txt) {
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

function deleteRouteById(id) {
  const startTime = Date.now();
  debugLog('[db.deleteRouteById] start', { id });
  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM routes WHERE id = ?`, [id], function(err) {
      if (err) {
        const elapsedMs = Date.now() - startTime;
        console.error('[db.deleteRouteById] failed', { id, elapsedMs, error: err });
        return reject(err);
      }
      const elapsedMs = Date.now() - startTime;
      const deletedCount = Number(this && this.changes) || 0;
      debugLog('[db.deleteRouteById] success', { id, deletedCount, elapsedMs });
      resolve({ deletedCount });
    });
  });
}

module.exports = {
  DB_PATH,
  initDatabase,
  insertRoute,
  listRoutes,
  listRouteIds,
  countRoutes,
  getRouteById,
  deleteRouteById
};


