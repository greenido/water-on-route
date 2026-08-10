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

module.exports = { OverpassCache, cacheKey, KEY_PRECISION };
