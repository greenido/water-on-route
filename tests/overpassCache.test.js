const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { OverpassCache, OverpassDiskCache, cacheKey, isPersistedKind } = require('../server/overpassCache');

const BBOX = { minlat: 37.7694, minlon: -122.4862, maxlat: 37.7714, maxlon: -122.4502 };
const XML = Buffer.from('<osm></osm>');

test('cacheKey separates kinds for the same box', () => {
  assert.notEqual(cacheKey('water', BBOX), cacheKey('coffee', BBOX));
});

test('cacheKey is stable and rounds to about 11 m', () => {
  assert.equal(cacheKey('water', BBOX), cacheKey('water', { ...BBOX }));
  // Below the rounding precision the same tile is reused.
  assert.equal(
    cacheKey('water', BBOX),
    cacheKey('water', { ...BBOX, minlat: BBOX.minlat + 0.000004 })
  );
  // Above it, a different tile.
  assert.notEqual(
    cacheKey('water', BBOX),
    cacheKey('water', { ...BBOX, minlat: BBOX.minlat + 0.001 })
  );
});

test('a stored response comes back and is counted as a hit', () => {
  const cache = new OverpassCache();
  const key = cacheKey('water', BBOX);
  assert.equal(cache.get(key), null);

  cache.set(key, XML, 'text/xml');
  const hit = cache.get(key);
  assert.equal(hit.body.toString(), '<osm></osm>');
  assert.equal(hit.contentType, 'text/xml');
  assert.deepEqual(cache.stats(), { size: 1, bytes: XML.length, hits: 1, misses: 1 });
});

test('entries expire once past the TTL', () => {
  let now = 1000;
  const cache = new OverpassCache({ ttlMs: 500, now: () => now });
  const key = cacheKey('water', BBOX);
  cache.set(key, XML, 'text/xml');

  now = 1400;
  assert.ok(cache.get(key), 'still fresh at 400 ms');
  now = 1600;
  assert.equal(cache.get(key), null, 'expired at 600 ms');
  assert.equal(cache.size, 0, 'expired entry is dropped, not just hidden');
});

test('the entry count is bounded, evicting least-recently-used first', () => {
  const cache = new OverpassCache({ maxEntries: 3 });
  for (const k of ['a', 'b', 'c']) cache.set(k, XML, 'text/xml');

  cache.get('a');            // 'a' becomes most recent, so 'b' is now oldest
  cache.set('d', XML, 'text/xml');

  assert.ok(cache.get('a'), 'recently used entry survives');
  assert.equal(cache.get('b'), null, 'least recently used entry was evicted');
  assert.ok(cache.get('c'));
  assert.ok(cache.get('d'));
  assert.equal(cache.size, 3);
});

test('the byte budget is enforced as well as the entry count', () => {
  const big = Buffer.alloc(400);
  const cache = new OverpassCache({ maxEntries: 100, maxBytes: 1000 });
  cache.set('a', big, 'text/xml');
  cache.set('b', big, 'text/xml');
  cache.set('c', big, 'text/xml'); // 1200 > 1000, so 'a' must go

  assert.equal(cache.get('a'), null);
  assert.ok(cache.get('b'));
  assert.ok(cache.get('c'));
  assert.ok(cache.stats().bytes <= 1000);
});

test('a response larger than the whole budget is not cached at all', () => {
  const cache = new OverpassCache({ maxBytes: 100 });
  cache.set('small', Buffer.alloc(50), 'text/xml');
  cache.set('huge', Buffer.alloc(500), 'text/xml');

  assert.equal(cache.get('huge'), null, 'oversized response is skipped');
  assert.ok(cache.get('small'), 'and it did not evict everything else on the way');
});

test('overwriting a key does not double-count its bytes', () => {
  const cache = new OverpassCache();
  cache.set('a', Buffer.alloc(100), 'text/xml');
  cache.set('a', Buffer.alloc(30), 'text/xml');
  assert.equal(cache.stats().bytes, 30);
  assert.equal(cache.size, 1);
});

test('non-buffer bodies are ignored rather than corrupting the byte count', () => {
  const cache = new OverpassCache();
  cache.set('a', '<osm></osm>', 'text/xml');
  assert.equal(cache.size, 0);
  assert.equal(cache.stats().bytes, 0);
});

test('clear empties the cache and resets the byte count', () => {
  const cache = new OverpassCache();
  cache.set('a', XML, 'text/xml');
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.stats().bytes, 0);
});

function diskCachePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wor-overpass-')), 'cache.sqlite3');
}

test('the disk cache survives being reopened, as after the machine stops', async () => {
  const file = diskCachePath();
  const first = new OverpassDiskCache({ path: file, maxBytes: 1024 * 1024, ttlMs: 1000 });
  await first.set('water:1', XML, 'text/xml');
  await first.close();

  const second = new OverpassDiskCache({ path: file, maxBytes: 1024 * 1024, ttlMs: 1000 });
  const hit = await second.get('water:1');
  assert.deepEqual(hit, { body: XML, contentType: 'text/xml' });
  assert.equal(await second.get('water:2'), null);
  await second.close();
});

test('the disk cache expires old answers', async () => {
  let clock = 1000;
  const cache = new OverpassDiskCache({ path: diskCachePath(), maxBytes: 1024, ttlMs: 100, now: () => clock });
  await cache.set('k', XML, 'text/xml');
  clock += 50;
  assert.ok(await cache.get('k'));
  clock += 100;
  assert.equal(await cache.get('k'), null);
  await cache.close();
});

test('the disk cache stays under its byte limit, dropping the least recently used', async () => {
  let clock = 1;
  const cache = new OverpassDiskCache({ path: diskCachePath(), maxBytes: 25, ttlMs: 1e9, now: () => clock++ });
  const body = Buffer.alloc(10, 'x');
  await cache.set('a', body, 'text/xml');
  await cache.set('b', body, 'text/xml');
  await cache.get('a');
  await cache.set('c', body, 'text/xml');
  assert.ok(await cache.get('a'), 'recently read, so it stays');
  assert.equal(await cache.get('b'), null, 'least recently used goes first');
  assert.ok(await cache.get('c'));
  await cache.close();
});

test('the disk cache refuses a single answer bigger than its whole budget', async () => {
  const cache = new OverpassDiskCache({ path: diskCachePath(), maxBytes: 5, ttlMs: 1000 });
  await cache.set('k', Buffer.alloc(10), 'text/xml');
  assert.equal(await cache.get('k'), null);
  await cache.close();
});

test('a disk cache that cannot open is a miss, not an error', async () => {
  const cache = new OverpassDiskCache({ path: '/nonexistent-dir/nope/cache.sqlite3', maxBytes: 1024, ttlMs: 1000 });
  await cache.set('k', XML, 'text/xml');
  assert.equal(await cache.get('k'), null);
});

test('with no byte budget the disk cache never creates a file', async () => {
  const file = diskCachePath();
  const cache = new OverpassDiskCache({ path: file, maxBytes: 0, ttlMs: 1000 });
  await cache.set('k', XML, 'text/xml');
  assert.equal(await cache.get('k'), null);
  assert.equal(fs.existsSync(file), false);
});

test('near-me answers never go to disk, as the privacy notes promise', () => {
  assert.equal(isPersistedKind('nearby'), false);
  for (const kind of ['water', 'coffee', 'refill']) assert.equal(isPersistedKind(kind), true);
});
