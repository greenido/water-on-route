import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchRoutePoints } from '../osmApi.mjs';

const TILE_A = { minlat: 37, minlon: -122, maxlat: 37.5, maxlon: -121.5 };
const TILE_B = { minlat: 37, minlon: -121.5, maxlat: 37.5, maxlon: -121 };
const answer = (status, body = '') => ({ ok: status >= 200 && status < 300, status, text: async () => body });
const boxOf = (options) => JSON.parse(options.body).bbox;
const NODE_XML = (id) => `<osm id="${id}"/>`;

/**
 * fetchRoutePoints parses with the real XML parser, which needs DOMParser, so
 * give it the small part of one these answers need.
 */
function withFakeDom(run) {
  const previous = globalThis.DOMParser;
  globalThis.DOMParser = class {
    parseFromString(xml) {
      const id = Number(/id="(\d+)"/.exec(xml)?.[1] ?? NaN);
      const node = {
        getElementsByTagName: () => [],
        getAttribute: (name) => ({ id, lat: 37, lon: -122 })[name]
      };
      const tagEl = { getAttribute: (name) => ({ k: 'amenity', v: 'drinking_water' })[name] };
      node.getElementsByTagName = (tag) => (tag === 'tag' ? [tagEl] : []);
      return { getElementsByTagName: (tag) => (tag === 'node' && Number.isFinite(id) ? [node] : []) };
    }
  };
  return Promise.resolve().then(run).finally(() => { globalThis.DOMParser = previous; });
}

test('fetchRoutePoints merges every square and reports no gaps', () => withFakeDom(async () => {
  let id = 0;
  const fetchImpl = async () => answer(200, NODE_XML(++id));
  const result = await fetchRoutePoints('water', [TILE_A, TILE_B], null, { fetchImpl });
  assert.equal(result.points.length, 2);
  assert.equal(result.failedTiles, 0);
  assert.equal(result.totalTiles, 2);
}));

test('fetchRoutePoints keeps the squares that worked and counts the one that did not', () => withFakeDom(async () => {
  const fetchImpl = async (_url, options) => (boxOf(options).minlon === TILE_B.minlon ? answer(500, 'no') : answer(200, NODE_XML(1)));
  const result = await fetchRoutePoints('water', [TILE_A, TILE_B], null, { fetchImpl, initialBackoffMs: 0 });
  assert.equal(result.points.length, 1);
  assert.equal(result.failedTiles, 1);
  assert.equal(result.totalTiles, 2);
}));

test('fetchRoutePoints reports it when nothing at all came back', () => withFakeDom(async () => {
  const fetchImpl = async () => answer(500, 'no');
  const result = await fetchRoutePoints('water', [TILE_A, TILE_B], null, { fetchImpl });
  assert.deepEqual(result.points, []);
  assert.equal(result.failedTiles, 2);
  assert.equal(result.totalTiles, 2);
  assert.match(result.lastError.message, /Overpass error: 500/);
}));

test('fetchRoutePoints on an empty route asks for nothing', () => withFakeDom(async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return answer(200, '<osm/>'); };
  assert.deepEqual(await fetchRoutePoints('water', [], null, { fetchImpl }), { points: [], failedTiles: 0, totalTiles: 0, lastError: null });
  assert.equal(calls, 0);
}));

test('a response over the proxy size limit is split, not fatal', () => withFakeDom(async () => {
  // Regression: this used to come back as a 502, which nothing split, so a busy
  // city failed the whole search.
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls++;
    const { minlat, maxlat } = boxOf(options);
    return maxlat - minlat > 0.3 ? answer(413, 'too big') : answer(200, NODE_XML(calls));
  };
  const result = await fetchRoutePoints('water', [TILE_A], null, { fetchImpl, initialBackoffMs: 0 });
  assert.equal(calls, 5);
  assert.equal(result.points.length, 4);
  assert.equal(result.failedTiles, 0);
}));

test('a square is split at most twice, however big it keeps coming back', () => withFakeDom(async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return answer(413, 'too big'); };
  const result = await fetchRoutePoints('water', [TILE_A], null, { fetchImpl, initialBackoffMs: 0 });
  assert.equal(calls, 1 + 4 + 16);
  assert.equal(result.failedTiles, 1);
}));

for (const status of [429, 502, 503, 504]) {
  test(`a square answered ${status} is asked again as it is, never split`, () => withFakeDom(async () => {
    const boxes = [];
    const fetchImpl = async (_url, options) => {
      boxes.push(boxOf(options));
      return boxes.length <= 2 ? answer(status, 'busy') : answer(200, NODE_XML(1));
    };
    const result = await fetchRoutePoints('water', [TILE_A], null, { fetchImpl, busyBackoffMs: 0 });
    assert.equal(boxes.length, 3);
    for (const box of boxes) assert.deepEqual(box, TILE_A);
    assert.equal(result.failedTiles, 0);
    assert.equal(result.points.length, 1);
  }));
}

test('a square refused for being at capacity is asked again', () => withFakeDom(async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return calls <= 2 ? answer(502, 'at capacity') : answer(200, NODE_XML(1)); };
  const result = await fetchRoutePoints('water', [TILE_A], null, { fetchImpl, busyBackoffMs: 0 });
  assert.equal(calls, 3);
  assert.equal(result.failedTiles, 0);
}));

test('the wait before asking again grows, because that refusal comes back within a second', () => withFakeDom(async () => {
  const stamps = [];
  const fetchImpl = async () => { stamps.push(Date.now()); return stamps.length <= 2 ? answer(503, 'at capacity') : answer(200, NODE_XML(1)); };
  await fetchRoutePoints('water', [TILE_A], null, { fetchImpl, busyBackoffMs: 20 });
  const first = stamps[1] - stamps[0];
  const second = stamps[2] - stamps[1];
  assert.ok(first >= 15, `first wait ${first} ms`);
  assert.ok(second >= 45, `second wait ${second} ms`);
}));

test('a square still at capacity after the retries is reported, and not retried forever', () => withFakeDom(async () => {
  let aCalls = 0;
  const fetchImpl = async (_url, options) => {
    if (boxOf(options).minlon !== TILE_A.minlon) return answer(200, NODE_XML(1));
    aCalls++;
    return answer(503, 'at capacity');
  };
  const result = await fetchRoutePoints('water', [TILE_A, TILE_B], null, { fetchImpl, busyBackoffMs: 0 });
  assert.equal(aCalls, 3);
  assert.equal(result.failedTiles, 1);
}));

test('the two-in-flight cap holds across squares, not per square', () => withFakeDom(async () => {
  let active = 0;
  let peak = 0;
  const fetchImpl = async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
    return answer(200, '<osm/>');
  };
  const tiles = Array.from({ length: 8 }, (_, i) => ({ ...TILE_A, minlon: TILE_A.minlon + i, maxlon: TILE_A.maxlon + i }));
  await fetchRoutePoints('water', tiles, null, { fetchImpl });
  assert.equal(peak, 2);
}));

test('progress arrives as each square finishes, with everything found so far', () => withFakeDom(async () => {
  const fetchImpl = async (_url, options) => (
    boxOf(options).minlon === TILE_B.minlon ? answer(500, 'no') : answer(200, NODE_XML(1))
  );
  const seen = [];
  await fetchRoutePoints('water', [TILE_A, TILE_B], (progress) => seen.push({ ...progress, points: progress.points.length }), { fetchImpl });
  assert.deepEqual(seen.map((p) => p.doneTiles), [1, 2]);
  assert.equal(seen[1].points, 1);
  assert.equal(seen[1].failedTiles, 1);
  assert.equal(seen[1].totalTiles, 2);
}));

/** A fetch that never answers, and rejects when its signal aborts, like the real one. */
const hangingFetch = (onCall = () => {}) => (_url, options) => new Promise((_resolve, reject) => {
  onCall(options);
  options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
});

test('a search stops at its budget, however busy the server is', () => withFakeDom(async () => {
  // Regression: this took a short route past five minutes with the page blocked.
  const started = Date.now();
  let calls = 0;
  const result = await fetchRoutePoints('water', [TILE_A, TILE_B, TILE_A, TILE_B, TILE_A], null, {
    fetchImpl: hangingFetch(() => { calls++; }),
    budgetMs: 40
  });
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
  assert.equal(result.failedTiles, 5);
  assert.equal(calls, 2, 'the queued squares never start once time is up');
}));

test('a busy square does not wait out a retry that could not finish in time', () => withFakeDom(async () => {
  const started = Date.now();
  let calls = 0;
  const result = await fetchRoutePoints('water', [TILE_A], null, {
    fetchImpl: async () => { calls++; return answer(502, 'busy'); },
    busyBackoffMs: 60000,
    budgetMs: 1000
  });
  assert.equal(calls, 1);
  assert.equal(result.failedTiles, 1);
  assert.ok(Date.now() - started < 500);
}));

test('other squares keep moving while a busy one waits for its retry', () => withFakeDom(async () => {
  const order = [];
  const fetchImpl = async (_url, options) => {
    const name = boxOf(options).minlon === TILE_A.minlon ? 'A' : 'B';
    order.push(name);
    return name === 'A' && order.filter((n) => n === 'A').length === 1 ? answer(503, 'busy') : answer(200, NODE_XML(order.length));
  };
  await fetchRoutePoints('water', [TILE_A, TILE_B], null, { fetchImpl, busyBackoffMs: 10, concurrency: 1 });
  assert.deepEqual(order, ['A', 'B', 'A']);
}));

test('cancelling does not wait out a retry that is already sleeping', () => withFakeDom(async () => {
  const controller = new AbortController();
  let calls = 0;
  const started = Date.now();
  const search = fetchRoutePoints('water', [TILE_A], null, {
    fetchImpl: async () => { calls++; return answer(503, 'busy'); },
    busyBackoffMs: 60000,
    signal: controller.signal
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(search, { name: 'AbortError' });
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
}));

test('cancelling stops the search, aborts what is running, and asks for nothing more', () => withFakeDom(async () => {
  const controller = new AbortController();
  let calls = 0;
  const signals = [];
  const search = fetchRoutePoints('water', [TILE_A, TILE_B, TILE_A, TILE_B], () => assert.fail('no progress after cancelling'), {
    fetchImpl: hangingFetch((options) => { calls++; signals.push(options.signal); }),
    signal: controller.signal
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(search, { name: 'AbortError' });
  assert.equal(calls, 2);
  for (const signal of signals) assert.equal(signal.aborted, true);
}));
