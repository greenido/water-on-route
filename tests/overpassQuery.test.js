const test = require('node:test');
const assert = require('node:assert/strict');

const {
  QUERY_KINDS,
  buildOverpassWaterQuery,
  buildOverpassCoffeeQuery,
  buildOverpassRefillQuery,
  buildQueryForKind
} = require('../server/overpassQuery');

const BBOX = { minlat: 37, minlon: -122.4, maxlat: 37.4, maxlon: -122 };

test('queries emit the bbox in Overpass south,west,north,east order', () => {
  // Swapping lat/lon silently returns nothing instead of erroring.
  assert.ok(buildOverpassWaterQuery(BBOX).includes('(37,-122.4,37.4,-122)'));
  assert.ok(buildOverpassCoffeeQuery(BBOX).includes('(37,-122.4,37.4,-122)'));
});

test('water query covers every potable tag across node, way and relation', () => {
  const query = buildOverpassWaterQuery(BBOX);
  const selectors = [
    '["amenity"="drinking_water"]',
    '["natural"="spring"]',
    '["man_made"="water_tap"]',
    '["amenity"="water_point"]',
    '["amenity"="fountain"]["drinking_water"~"^(yes|compatible)$"]',
    '["man_made"="water_well"]["drinking_water"~"^(yes|compatible)$"]',
    '["drinking_water"~"^(yes|compatible)$"]'
  ];
  for (const type of ['node', 'way', 'relation']) {
    for (const selector of selectors) {
      assert.ok(query.includes(`${type}${selector}`), `missing ${type}${selector}`);
    }
  }
  assert.equal(query.match(/\(37,-122\.4,37\.4,-122\)/g).length, 21);
});

test('water query does not accept unmarked fountains or wells', () => {
  const query = buildOverpassWaterQuery(BBOX);
  assert.ok(!/node\["amenity"="fountain"\]\(/.test(query));
  assert.ok(!/node\["man_made"="water_well"\]\(/.test(query));
});

test('coffee query covers cafes, coffee shops and coffee-cuisine restaurants', () => {
  const query = buildOverpassCoffeeQuery(BBOX);
  for (const type of ['node', 'way', 'relation']) {
    assert.ok(query.includes(`${type}["amenity"="cafe"]`));
    assert.ok(query.includes(`${type}["shop"="coffee"]`));
    assert.ok(query.includes(`${type}["amenity"="restaurant"]["cuisine"~"coffee|cafe|coffee_shop|espresso", i]`));
  }
});

test('every query asks for centers so ways and relations are placeable', () => {
  assert.ok(buildOverpassWaterQuery(BBOX).includes('out body center qt;'));
  assert.ok(buildOverpassCoffeeQuery(BBOX).includes('out body center qt;'));
});

test('buildQueryForKind dispatches on the declared kinds', () => {
  assert.equal(buildQueryForKind('water', BBOX), buildOverpassWaterQuery(BBOX));
  assert.equal(buildQueryForKind('coffee', BBOX), buildOverpassCoffeeQuery(BBOX));
});

test('buildQueryForKind refuses unknown kinds and prototype keys', () => {
  assert.throws(() => buildQueryForKind('planet', BBOX), /Unsupported query kind/);
  assert.throws(() => buildQueryForKind('constructor', BBOX), /Unsupported query kind/);
  assert.throws(() => buildQueryForKind('__proto__', BBOX), /Unsupported query kind/);
  assert.throws(() => buildQueryForKind('toString', BBOX), /Unsupported query kind/);
});

test('no client-controlled text can reach the query', () => {
  // The builders only ever interpolate the four validated bbox numbers.
  const query = buildQueryForKind('water', BBOX);
  assert.ok(!query.includes('undefined'));
  assert.ok(!query.includes('[object'));
  assert.match(query, /^\s*\[out:xml\]\[timeout:25\];/);
});

test('refill query asks for the stops a rider actually uses', () => {
  const query = buildOverpassRefillQuery(BBOX);
  const expected = [
    '["amenity"="fuel"]',
    '["shop"~"^(convenience|supermarket)$"]',
    '["amenity"="toilets"]',
    '["tourism"~"^(camp_site|picnic_site|wilderness_hut|alpine_hut)$"]',
    '["amenity"="grave_yard"]',
    '["landuse"="cemetery"]'
  ];
  for (const type of ['node', 'way', 'relation']) {
    for (const selector of expected) {
      assert.ok(query.includes(`${type}${selector}`), `missing ${type}${selector}`);
    }
  }
  assert.ok(query.includes('out body center qt;'), 'ways and relations need centers to be placeable');
});

test('refill query does not duplicate the coffee layer', () => {
  const query = buildOverpassRefillQuery(BBOX);
  assert.ok(!query.includes('"amenity"="cafe"'));
  assert.ok(!query.includes('"amenity"="restaurant"'));
});

test('refill is a first-class kind alongside water and coffee', () => {
  assert.deepEqual([...QUERY_KINDS].sort(), ['coffee', 'refill', 'water']);
  assert.equal(buildQueryForKind('refill', BBOX), buildOverpassRefillQuery(BBOX));
  assert.ok(buildOverpassRefillQuery(BBOX).includes('(37,-122.4,37.4,-122)'));
});
