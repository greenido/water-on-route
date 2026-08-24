import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isPotableWaterTags,
  waterSubtypeLabel,
  isCoffeeTags,
  bboxSpan,
  splitBboxIntoQuads,
  dedupePointsByTypeId,
  coffeeQualityBoost,
  rankCoffeePoints,
  sortPointsByDistance,
  fetchOverpassPointsAdaptive,
  createLimiter,
  isRefillTags,
  refillConfidence,
  refillLabel,
  refillExpectation,
  rankRefillPoints,
  fetchOSMRefillPointsAdaptive
} from '../osmApi.mjs';

const BBOX = { minlat: 37, minlon: -122.4, maxlat: 37.4, maxlon: -122 };

test('isPotableWaterTags accepts the documented potable tags', () => {
  assert.ok(isPotableWaterTags({ amenity: 'drinking_water' }));
  assert.ok(isPotableWaterTags({ natural: 'spring' }));
  assert.ok(isPotableWaterTags({ man_made: 'water_tap' }));
  assert.ok(isPotableWaterTags({ amenity: 'water_point' }));
  assert.ok(isPotableWaterTags({ amenity: 'fountain', drinking_water: 'yes' }));
  assert.ok(isPotableWaterTags({ man_made: 'water_well', drinking_water: 'compatible' }));
  assert.ok(isPotableWaterTags({ drinking_water: 'yes' }));
});

test('isPotableWaterTags rejects non-potable and unmarked features', () => {
  assert.equal(isPotableWaterTags({ amenity: 'fountain' }), false);
  assert.equal(isPotableWaterTags({ man_made: 'water_well' }), false);
  assert.equal(isPotableWaterTags({ amenity: 'cafe' }), false);
  assert.equal(isPotableWaterTags(null), false);
  assert.equal(isPotableWaterTags('nope'), false);
});

test('drinking_water=no always wins, even over an explicit water amenity', () => {
  assert.equal(isPotableWaterTags({ amenity: 'drinking_water', drinking_water: 'no' }), false);
  assert.equal(isPotableWaterTags({ natural: 'spring', drinking_water: 'no' }), false);
});

test('waterSubtypeLabel names each subtype', () => {
  assert.equal(waterSubtypeLabel({ amenity: 'fountain' }), 'fountain');
  assert.equal(waterSubtypeLabel({ amenity: 'water_point' }), 'water point');
  assert.equal(waterSubtypeLabel({ man_made: 'water_tap' }), 'tap');
  assert.equal(waterSubtypeLabel({ man_made: 'water_well' }), 'well');
  assert.equal(waterSubtypeLabel({ natural: 'spring' }), 'spring');
  assert.equal(waterSubtypeLabel({ amenity: 'drinking_water' }), 'drinking water');
  assert.equal(waterSubtypeLabel({ drinking_water: 'yes' }), 'tap');
  assert.equal(waterSubtypeLabel(undefined), 'water');
});

test('isCoffeeTags covers cafes, coffee shops and coffee-cuisine restaurants', () => {
  assert.ok(isCoffeeTags({ amenity: 'cafe' }));
  assert.ok(isCoffeeTags({ shop: 'coffee' }));
  assert.ok(isCoffeeTags({ amenity: 'restaurant', cuisine: 'italian;coffee_shop' }));
  assert.equal(isCoffeeTags({ amenity: 'restaurant', cuisine: 'pizza' }), false);
  assert.equal(isCoffeeTags({ amenity: 'restaurant' }), false);
  assert.equal(isCoffeeTags(null), false);
});

test('bboxSpan reports non-negative extents', () => {
  const span = bboxSpan(BBOX);
  assert.ok(Math.abs(span.lat - 0.4) < 1e-9);
  assert.ok(Math.abs(span.lon - 0.4) < 1e-9);
  // Inverted bounds clamp to zero rather than going negative.
  assert.deepEqual(bboxSpan({ minlat: 5, maxlat: 1, minlon: 5, maxlon: 1 }), { lat: 0, lon: 0 });
});

test('splitBboxIntoQuads tiles the parent exactly', () => {
  const quads = splitBboxIntoQuads(BBOX);
  assert.equal(quads.length, 4);
  assert.equal(Math.min(...quads.map(q => q.minlat)), BBOX.minlat);
  assert.equal(Math.max(...quads.map(q => q.maxlat)), BBOX.maxlat);
  assert.equal(Math.min(...quads.map(q => q.minlon)), BBOX.minlon);
  assert.equal(Math.max(...quads.map(q => q.maxlon)), BBOX.maxlon);
  const area = (b) => (b.maxlat - b.minlat) * (b.maxlon - b.minlon);
  const total = quads.reduce((sum, q) => sum + area(q), 0);
  assert.ok(Math.abs(total - area(BBOX)) < 1e-12);
});

test('dedupePointsByTypeId keys on type and id together', () => {
  const points = [
    { _type: 'node', id: 1 },
    { _type: 'node', id: 1 },
    { _type: 'way', id: 1 },
    { id: 2 }
  ];
  assert.equal(dedupePointsByTypeId(points).length, 3);
  assert.deepEqual(dedupePointsByTypeId([]), []);
  assert.deepEqual(dedupePointsByTypeId(null), []);
});

test('dedupePointsByTypeId keeps the first occurrence', () => {
  const out = dedupePointsByTypeId([
    { _type: 'node', id: 1, tags: { name: 'first' } },
    { _type: 'node', id: 1, tags: { name: 'second' } }
  ]);
  assert.equal(out[0].tags.name, 'first');
});

test('coffeeQualityBoost rewards richer OSM tagging', () => {
  assert.equal(coffeeQualityBoost({ tags: {} }), 0);
  assert.equal(coffeeQualityBoost({ tags: { name: 'Blue Bottle' } }), 30);
  assert.equal(coffeeQualityBoost({
    tags: { name: 'X', cuisine: 'coffee_shop', opening_hours: 'Mo-Fr 07:00-17:00', website: 'https://x.test' }
  }), 75);
  assert.equal(coffeeQualityBoost(null), 0);
});

test('rankCoffeePoints trades tag quality against distance', () => {
  const bare = { id: 'bare', tags: {}, _distanceM: 10 };
  const named = { id: 'named', tags: { name: 'Cafe' }, _distanceM: 35 };
  // named loses 35 to distance but gains 30 for the name: -5 vs -10, so it wins.
  assert.deepEqual(rankCoffeePoints([bare, named]).map(p => p.id), ['named', 'bare']);
});

test('rankCoffeePoints and sortPointsByDistance do not mutate the input array', () => {
  const input = [{ id: 1, _distanceM: 90 }, { id: 2, _distanceM: 10 }];
  assert.deepEqual(sortPointsByDistance(input).map(p => p.id), [2, 1]);
  assert.deepEqual(input.map(p => p.id), [1, 2]);
  rankCoffeePoints(input);
  assert.deepEqual(input.map(p => p.id), [1, 2]);
});

test('sortPointsByDistance puts unmeasured points last', () => {
  const out = sortPointsByDistance([{ id: 1 }, { id: 2, _distanceM: 5 }]);
  assert.deepEqual(out.map(p => p.id), [2, 1]);
});

/** Minimal Response stand-in for the injected fetch. */
function reply(status, body = '') {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

test('the client sends only a bbox and a kind, never query text', async () => {
  const sent = [];
  const fetchImpl = async (url, options) => {
    sent.push({ url, contentType: options.headers['Content-Type'], body: JSON.parse(options.body) });
    return reply(200, 'ok');
  };
  await fetchOverpassPointsAdaptive(BBOX, null, { fetchImpl, kind: 'coffee', parseXml: () => [] });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, '/api/overpass');
  assert.equal(sent[0].contentType, 'application/json');
  assert.deepEqual(Object.keys(sent[0].body).sort(), ['bbox', 'kind']);
  assert.equal(sent[0].body.kind, 'coffee');
  assert.deepEqual(sent[0].body.bbox, BBOX);
});

test('adaptive fetch splits the bbox on 429 and merges the quads', async () => {
  const requested = [];
  const fetchImpl = async (_url, options) => {
    const { bbox } = JSON.parse(options.body);
    const key = `${bbox.minlat},${bbox.minlon},${bbox.maxlat},${bbox.maxlon}`;
    requested.push(key);
    // Only the full-size parent is rate limited.
    return requested.length === 1 ? reply(429, 'slow down') : reply(200, key);
  };

  const points = await fetchOverpassPointsAdaptive(BBOX, null, {
    fetchImpl,
    initialBackoffMs: 0,
    minSpan: 0.01,
    parseXml: (xml) => [{ _type: 'node', id: xml }]
  });

  assert.equal(requested.length, 5, 'one failed parent plus four quads');
  assert.equal(points.length, 4);
});

test('a 400 from the span cap is treated as splittable', async () => {
  // The proxy rejects oversized boxes with 400; the client must subdivide
  // rather than give up, otherwise long routes stop working entirely.
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return calls === 1 ? reply(400, 'bbox is too large; split it into smaller tiles') : reply(200, 'ok');
  };
  const points = await fetchOverpassPointsAdaptive(BBOX, null, {
    fetchImpl,
    initialBackoffMs: 0,
    minSpan: 0.01,
    parseXml: () => [{ _type: 'node', id: calls }]
  });
  assert.equal(calls, 5);
  assert.ok(points.length > 0);
});

test('adaptive fetch stops splitting once the bbox reaches minSpan', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return reply(429, 'nope'); };

  await assert.rejects(
    fetchOverpassPointsAdaptive(
      { minlat: 37, minlon: -122, maxlat: 37.005, maxlon: -122 + 0.005 },
      null,
      { fetchImpl, initialBackoffMs: 0, minSpan: 0.01, parseXml: () => [] }
    ),
    /Overpass error: 429/
  );
  assert.equal(calls, 1, 'a bbox already below minSpan must not be split');
});

test('adaptive fetch does not retry errors that splitting cannot fix', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return reply(500, 'boom'); };

  await assert.rejects(
    fetchOverpassPointsAdaptive(BBOX, null, { fetchImpl, initialBackoffMs: 0, parseXml: () => [] }),
    /Overpass error: 500/
  );
  assert.equal(calls, 1);
});

test('adaptive fetch dedupes points repeated across quads', async () => {
  let first = true;
  const fetchImpl = async () => {
    if (first) { first = false; return reply(504, 'timeout'); }
    return reply(200, 'ok');
  };
  const points = await fetchOverpassPointsAdaptive(BBOX, null, {
    fetchImpl,
    initialBackoffMs: 0,
    minSpan: 0.01,
    parseXml: () => [{ _type: 'node', id: 42 }] // every quad returns the same node
  });
  assert.equal(points.length, 1);
});

test('adaptive fetch reports progress per completed tile', async () => {
  const progress = [];
  await fetchOverpassPointsAdaptive(BBOX, (done) => progress.push(done), {
    fetchImpl: async () => reply(200, 'ok'),
    parseXml: () => []
  });
  assert.deepEqual(progress, [1]);
});

test('createLimiter never runs more than the cap at once', async () => {
  const limit = createLimiter(3);
  let active = 0;
  let peak = 0;
  const task = async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, 5));
    active--;
    return true;
  };
  const results = await Promise.all(Array.from({ length: 20 }, () => limit(task)));
  assert.equal(results.length, 20);
  assert.equal(peak, 3);
  assert.equal(active, 0);
});

test('createLimiter treats a bad cap as one at a time', async () => {
  for (const bad of [0, -4, NaN, undefined]) {
    const limit = createLimiter(bad);
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 5 }, () => limit(async () => {
      active++; peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 1));
      active--;
    })));
    assert.equal(peak, 1, `cap ${bad} should serialize`);
  }
});

test('createLimiter releases the slot when a task throws', async () => {
  const limit = createLimiter(1);
  await assert.rejects(limit(async () => { throw new Error('boom'); }), /boom/);
  // If the slot leaked, this would hang rather than resolve.
  assert.equal(await limit(async () => 'after'), 'after');
});

test('quads are fetched concurrently but stay under the cap', async () => {
  let inFlight = 0;
  let peak = 0;
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) return reply(429, 'slow down');
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, 10));
    inFlight--;
    return reply(200, 'ok');
  };

  await fetchOverpassPointsAdaptive(BBOX, null, {
    fetchImpl,
    initialBackoffMs: 0,
    minSpan: 0.01,
    concurrency: 2,
    parseXml: () => []
  });

  assert.equal(calls, 5, 'one parent plus four quads');
  assert.ok(peak > 1, `quads should overlap, peak was ${peak}`);
  assert.ok(peak <= 2, `peak ${peak} exceeded the cap`);
});

test('deep recursive splitting does not deadlock under a small cap', async () => {
  // Every request above the floor fails, forcing several levels of splitting.
  // A limiter that held a slot while awaiting children would hang here.
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls++;
    const { bbox } = JSON.parse(options.body);
    const span = Math.max(bbox.maxlat - bbox.minlat, bbox.maxlon - bbox.minlon);
    return span > 0.05 ? reply(504, 'timeout') : reply(200, 'ok');
  };

  const points = await fetchOverpassPointsAdaptive(
    { minlat: 37, minlon: -122.8, maxlat: 37.8, maxlon: -122 },
    null,
    { fetchImpl, initialBackoffMs: 0, minSpan: 0.01, concurrency: 1, parseXml: () => [{ _type: 'node', id: calls }] }
  );

  assert.ok(calls > 20, `expected deep splitting, got ${calls} calls`);
  assert.ok(points.length > 0);
});

test('isRefillTags accepts the stops a rider can actually use', () => {
  assert.ok(isRefillTags({ amenity: 'fuel' }));
  assert.ok(isRefillTags({ shop: 'convenience' }));
  assert.ok(isRefillTags({ shop: 'supermarket' }));
  assert.ok(isRefillTags({ amenity: 'toilets' }));
  assert.ok(isRefillTags({ tourism: 'camp_site' }));
  assert.ok(isRefillTags({ tourism: 'alpine_hut' }));
  assert.ok(isRefillTags({ amenity: 'grave_yard' }));
  assert.ok(isRefillTags({ landuse: 'cemetery' }));
});

test('isRefillTags leaves cafes to the coffee layer', () => {
  assert.equal(isRefillTags({ amenity: 'cafe' }), false);
  assert.equal(isRefillTags({ amenity: 'restaurant' }), false);
  assert.equal(isRefillTags({ shop: 'coffee' }), false);
});

test('drinking_water=no disqualifies a refill stop outright', () => {
  assert.equal(isRefillTags({ amenity: 'fuel', drinking_water: 'no' }), false);
  assert.equal(isRefillTags({ shop: 'supermarket', drinking_water: 'no' }), false);
  assert.equal(isRefillTags(null), false);
  assert.equal(isRefillTags('fuel'), false);
});

test('confidence separates a tagged tap from an educated guess', () => {
  // Explicit tagging always wins, whatever the feature is.
  assert.equal(refillConfidence({ amenity: 'toilets', drinking_water: 'yes' }), 'certain');
  assert.equal(refillConfidence({ amenity: 'grave_yard', drinking_water: 'compatible' }), 'certain');
  assert.equal(refillConfidence({ amenity: 'water_point' }), 'certain');
  // Staffed places you can walk into and ask.
  assert.equal(refillConfidence({ amenity: 'fuel' }), 'likely');
  assert.equal(refillConfidence({ shop: 'convenience' }), 'likely');
  assert.equal(refillConfidence({ tourism: 'camp_site' }), 'likely');
  // Everything else is a gamble and must say so.
  assert.equal(refillConfidence({ amenity: 'toilets' }), 'maybe');
  assert.equal(refillConfidence({ amenity: 'grave_yard' }), 'maybe');
  assert.equal(refillConfidence({ tourism: 'picnic_site' }), 'maybe');
  assert.equal(refillConfidence(undefined), 'maybe');
});

test('every refill kind has a human label and an expectation', () => {
  const kinds = [
    { amenity: 'fuel' }, { shop: 'convenience' }, { shop: 'supermarket' },
    { amenity: 'toilets' }, { tourism: 'camp_site' }, { tourism: 'picnic_site' },
    { tourism: 'wilderness_hut' }, { tourism: 'alpine_hut' },
    { amenity: 'grave_yard' }, { landuse: 'cemetery' }, { amenity: 'water_point' }
  ];
  for (const tags of kinds) {
    assert.notEqual(refillLabel(tags), 'Refill stop', `unlabelled: ${JSON.stringify(tags)}`);
    assert.ok(refillExpectation(tags).length > 0);
  }
  assert.equal(refillLabel({ amenity: 'something_else' }), 'Refill stop', 'unknown kinds still get a label');
});

test('the expectation line matches the confidence tier', () => {
  assert.match(refillExpectation({ amenity: 'water_point' }), /drinking water/i);
  assert.match(refillExpectation({ amenity: 'fuel' }), /ask inside/i);
  assert.match(refillExpectation({ amenity: 'grave_yard' }), /not guaranteed/i);
});

test('rankRefillPoints puts certainty ahead of proximity', () => {
  // A sure tap 200 m away beats a maybe at 40 m: the detour is cheaper than
  // arriving at a locked cemetery gate.
  const points = [
    { id: 'maybe-close', tags: { amenity: 'grave_yard' }, _distanceM: 40 },
    { id: 'certain-far', tags: { amenity: 'water_point' }, _distanceM: 200 },
    { id: 'likely-mid', tags: { amenity: 'fuel' }, _distanceM: 120 }
  ];
  assert.deepEqual(rankRefillPoints(points).map(p => p.id), ['certain-far', 'likely-mid', 'maybe-close']);
});

test('rankRefillPoints breaks ties by distance and does not mutate', () => {
  const points = [
    { id: 'far', tags: { amenity: 'fuel' }, _distanceM: 300 },
    { id: 'near', tags: { shop: 'convenience' }, _distanceM: 30 }
  ];
  assert.deepEqual(rankRefillPoints(points).map(p => p.id), ['near', 'far']);
  assert.equal(points[0].id, 'far');
});

/**
 * Minimal stand-in for the browser DOM, so the exported fetch helpers can be
 * exercised as the app calls them rather than through their internals. Models
 * only what parseOsmXmlGeneric touches: elements with attributes and <tag>
 * children.
 */
function withStubbedDom(nodes, run) {
  const element = ({ id, lat, lon, tags }) => ({
    getAttribute: (name) => ({ id, lat, lon })[name],
    getElementsByTagName: (name) => name === 'tag'
      ? Object.entries(tags || {}).map(([k, v]) => ({ getAttribute: (a) => (a === 'k' ? k : v) }))
      : []
  });
  const previous = globalThis.DOMParser;
  globalThis.DOMParser = class {
    parseFromString() {
      return { getElementsByTagName: (name) => (name === 'node' ? nodes.map(element) : []) };
    }
  };
  return Promise.resolve(run()).finally(() => { globalThis.DOMParser = previous; });
}

test('the client asks the proxy for the refill kind and keeps only refill stops', async () => {
  const sent = [];
  const fetchImpl = async (_url, options) => { sent.push(JSON.parse(options.body)); return reply(200, '<osm/>'); };

  const points = await withStubbedDom(
    [
      { id: 1, lat: 37.1, lon: -122.1, tags: { amenity: 'fuel', name: 'Gas' } },
      { id: 2, lat: 37.2, lon: -122.2, tags: { amenity: 'cafe' } },
      { id: 3, lat: 37.3, lon: -122.3, tags: { amenity: 'fuel', drinking_water: 'no' } }
    ],
    () => fetchOSMRefillPointsAdaptive(BBOX, null, { fetchImpl })
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'refill');
  assert.deepEqual(sent[0].bbox, BBOX);
  // The cafe belongs to the coffee layer and the explicit no is disqualifying.
  assert.deepEqual(points.map(p => p.id), [1]);
});
