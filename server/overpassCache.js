/**
 * In-memory LRU cache for Overpass responses.
 *
 * Reloading the same route re-queried Overpass from scratch every time. OSM
 * data for a bbox changes on the order of days, so caching costs nothing in
 * freshness and is the difference between being a good Overpass citizen and
 * being rate-limited.
 *
 * Bounded three ways - entry count, total bytes, and age - because a single
 * response can be megabytes and this runs on a 1 GB machine.
 */

const sqlite3 = require('sqlite3');

/** Bbox rounding, ~11 m. Coarse enough to hit on a reloaded route. */
const KEY_PRECISION = 4;

function roundKeyPart(value) {
  return Number(value).toFixed(KEY_PRECISION);
}

/**
 * Stable cache key for a validated bbox and kind.
 * @param {string} kind
 * @param {{minlat:number,minlon:number,maxlat:number,maxlon:number}} bbox
 */
function cacheKey(kind, bbox) {
  return [
    kind,
    roundKeyPart(bbox.minlat),
    roundKeyPart(bbox.minlon),
    roundKeyPart(bbox.maxlat),
    roundKeyPart(bbox.maxlon)
  ].join(':');
}

class OverpassCache {
  /**
   * @param {{maxEntries?: number, maxBytes?: number, ttlMs?: number, now?: () => number}} [options]
   */
  constructor(options = {}) {
    this.maxEntries = options.maxEntries ?? 200;
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    this.ttlMs = options.ttlMs ?? 6 * 60 * 60 * 1000;
    this.now = options.now ?? Date.now;
    this.entries = new Map();
    this.bytes = 0;
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * @param {string} key
   * @returns {{body: Buffer, contentType: string}|null}
   */
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }
    if (this.now() - entry.storedAt > this.ttlMs) {
      this.#remove(key);
      this.misses++;
      return null;
    }
    // Re-insert so Map iteration order stays least-recently-used first.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits++;
    return { body: entry.body, contentType: entry.contentType };
  }

  /**
   * @param {string} key
   * @param {Buffer} body
   * @param {string} contentType
   */
  set(key, body, contentType) {
    if (!Buffer.isBuffer(body)) return;
    // A single response bigger than the whole budget would evict everything
    // else for no benefit.
    if (body.length > this.maxBytes) return;

    if (this.entries.has(key)) this.#remove(key);
    this.entries.set(key, { body, contentType, storedAt: this.now() });
    this.bytes += body.length;
    this.#evict();
  }

  #remove(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.bytes -= entry.body.length;
    this.entries.delete(key);
  }

  #evict() {
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.#remove(oldest.value);
    }
  }

  get size() {
    return this.entries.size;
  }

  stats() {
    return { size: this.entries.size, bytes: this.bytes, hits: this.hits, misses: this.misses };
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
  }
}

/**
 * Kinds whose answers may be written to disk.
 *
 * Route searches ask for fixed grid squares about 50 km across, which say little
 * about anyone. A near-me box is centred on the rider, and the privacy notes
 * promise it stays out of the database, so it only ever lives in memory.
 */
const PERSISTED_KINDS = Object.freeze(new Set(['water', 'coffee', 'refill']));

function isPersistedKind(kind) {
  return PERSISTED_KINDS.has(kind);
}

/**
 * Overpass answers on disk, so they outlive the process.
 *
 * Purely an optimisation: every failure is logged and treated as a miss, because
 * a broken cache must never break a search. With maxBytes 0 it does nothing.
 *
 * Bounded by age and by total bytes, dropping the least recently used first.
 * SQLite reuses freed pages, so the file stops growing at about maxBytes.
 */
class OverpassDiskCache {
  /**
   * @param {{path: string, maxBytes: number, ttlMs: number, now?: () => number}} options
   */
  constructor({ path, maxBytes, ttlMs, now = Date.now }) {
    this.path = path;
    this.maxBytes = maxBytes;
    this.ttlMs = ttlMs;
    this.now = now;
    this.ready = null;
  }

  #run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, (err) => (err ? reject(err) : resolve()));
    });
  }

  #all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });
  }

  /** Opens the file. Safe to skip awaiting: get and set wait for it themselves. */
  open() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      if (!(this.maxBytes > 0)) return false;
      await new Promise((resolve, reject) => {
        this.db = new sqlite3.Database(this.path, (err) => (err ? reject(err) : resolve()));
      });
      await this.#run(`CREATE TABLE IF NOT EXISTS overpass_cache (
        key TEXT PRIMARY KEY,
        body BLOB NOT NULL,
        content_type TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        stored_at INTEGER NOT NULL,
        used_at INTEGER NOT NULL
      )`);
      await this.#run(`CREATE INDEX IF NOT EXISTS idx_overpass_cache_used_at ON overpass_cache (used_at)`);
      return true;
    })().catch((err) => {
      console.warn('[overpassDiskCache] open failed, continuing without it', err);
      return false;
    });
    return this.ready;
  }

  /**
   * @param {string} key
   * @returns {Promise<{body: Buffer, contentType: string}|null>}
   */
  async get(key) {
    if (!(await this.open())) return null;
    try {
      const [row] = await this.#all(`SELECT body, content_type, stored_at FROM overpass_cache WHERE key = ?`, [key]);
      if (!row) return null;
      if (this.now() - row.stored_at > this.ttlMs) {
        await this.#run(`DELETE FROM overpass_cache WHERE key = ?`, [key]);
        return null;
      }
      await this.#run(`UPDATE overpass_cache SET used_at = ? WHERE key = ?`, [this.now(), key]);
      return { body: row.body, contentType: row.content_type };
    } catch (err) {
      console.warn('[overpassDiskCache] read failed', err);
      return null;
    }
  }

  /**
   * @param {string} key
   * @param {Buffer} body
   * @param {string} contentType
   */
  async set(key, body, contentType) {
    if (!Buffer.isBuffer(body) || body.length > this.maxBytes) return;
    if (!(await this.open())) return;
    try {
      const now = this.now();
      await this.#run(
        `INSERT OR REPLACE INTO overpass_cache (key, body, content_type, bytes, stored_at, used_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [key, body, contentType, body.length, now, now]
      );
      await this.#run(`DELETE FROM overpass_cache WHERE stored_at < ?`, [now - this.ttlMs]);
      await this.#evict();
    } catch (err) {
      console.warn('[overpassDiskCache] write failed', err);
    }
  }

  async #evict() {
    const [{ total }] = await this.#all(`SELECT COALESCE(SUM(bytes), 0) AS total FROM overpass_cache`);
    let excess = total - this.maxBytes;
    if (excess <= 0) return;
    for (const { key, bytes } of await this.#all(`SELECT key, bytes FROM overpass_cache ORDER BY used_at ASC, rowid ASC`)) {
      if (excess <= 0) break;
      await this.#run(`DELETE FROM overpass_cache WHERE key = ?`, [key]);
      excess -= bytes;
    }
  }

  async close() {
    if (!(await this.open())) return;
    await new Promise((resolve) => this.db.close(() => resolve()));
  }
}

module.exports = { OverpassCache, OverpassDiskCache, cacheKey, isPersistedKind, KEY_PRECISION };
