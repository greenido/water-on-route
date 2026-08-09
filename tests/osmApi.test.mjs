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
  fetchOverpassPointsAdaptive
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
