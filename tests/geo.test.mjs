import test from 'node:test';
import assert from 'node:assert/strict';

import {
  haversineMeters,
  mercatorScaleAtY,
  lonLatToWebMercator,
  pointToSegmentDistanceMeters,
  minDistancePointToLineStringMeters,
  extractRouteLineStrings,
  filterPointsNearRoute,
  buildRouteIndex,
  distanceToRouteMeters,
  computeBBoxFromGeoJSON,
  computeRouteLengthKm,
  pointLonLat
} from '../geo.mjs';

/** A due-east segment at the given latitude, long enough to project onto. */
function eastWestSegment(lat, lon = -122) {
  return [[lon - 0.05, lat], [lon + 0.05, lat]];
}

test('mercatorScaleAtY equals 1/cos(latitude)', () => {
  for (const lat of [0, 15, 37.4, 45, 60, 70]) {
    const [, y] = lonLatToWebMercator(0, lat);
    const expected = 1 / Math.cos(lat * Math.PI / 180);
    assert.ok(Math.abs(mercatorScaleAtY(y) - expected) < 1e-9,
      `scale at lat ${lat}: got ${mercatorScaleAtY(y)}, want ${expected}`);
  }
});

test('point-to-segment distance is true ground distance at every latitude', () => {
  // Regression: distances were previously measured on the Mercator plane, which
  // inflates by 1/cos(lat) - a 2x overstatement at 60 degrees.
  for (const lat of [0, 37.4, 45, 52.5, 60, 70]) {
    const [a, b] = eastWestSegment(lat);
    const offsetLat = lat + 0.0018; // ~200 m north
    const p = [-122, offsetLat];

    const expected = haversineMeters(p, [-122, lat]);
    const actual = pointToSegmentDistanceMeters(p, a, b);

    assert.ok(Math.abs(actual - expected) / expected < 0.001,
      `lat ${lat}: got ${actual.toFixed(1)} m, want ${expected.toFixed(1)} m`);
  }
});

test('a 150 m radius admits a 149 m point and rejects a 151 m point at high latitude', () => {
  // At lat 60 the old code reported 151 m as ~302 m and dropped it.
  const lat = 60;
  const route = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: eastWestSegment(lat) }
    }]
  };
  const metresPerDegLat = haversineMeters([-122, lat], [-122, lat + 1]) / 1;
  const near = { id: 1, lon: -122, lat: lat + 149 / metresPerDegLat };
  const far = { id: 2, lon: -122, lat: lat + 151 / metresPerDegLat };

  const kept = filterPointsNearRoute(route, [near, far], 150);
  assert.deepEqual(kept.map(p => p.id), [1]);
  assert.ok(Math.abs(kept[0]._distanceM - 149) < 1);
});

test('distance to a polyline takes the nearest segment', () => {
  const line = [[-122, 37], [-122, 37.01], [-121.99, 37.01]];
  const p = [-121.995, 37.0101];
  const d = minDistancePointToLineStringMeters(p, line);
  assert.ok(d < 20, `expected the point to sit on the last segment, got ${d} m`);
});

test('degenerate segments do not produce NaN', () => {
  const d = pointToSegmentDistanceMeters([-122, 37.001], [-122, 37], [-122, 37]);
  assert.ok(Number.isFinite(d));
  assert.ok(Math.abs(d - haversineMeters([-122, 37.001], [-122, 37])) < 0.5);
});

test('extractRouteLineStrings walks features, multi-lines and collections', () => {
  const fc = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } },
      { type: 'Feature', geometry: { type: 'MultiLineString', coordinates: [[[2, 2], [3, 3]], [[4, 4], [5, 5]]] } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [9, 9] } },
      { type: 'Feature', geometry: { type: 'GeometryCollection', geometries: [{ type: 'LineString', coordinates: [[6, 6], [7, 7]] }] } }
    ]
  };
  assert.equal(extractRouteLineStrings(fc).length, 4);
});

test('extractRouteLineStrings drops single-vertex lines', () => {
  const fc = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0]] } }]
  };
  assert.deepEqual(extractRouteLineStrings(fc), []);
});

test('filterPointsNearRoute reads way/relation centers and skips coordinate-less POIs', () => {
  const route = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: eastWestSegment(37) } }]
  };
  const points = [
    { id: 1, _type: 'node', lat: 37.0001, lon: -122 },
    { id: 2, _type: 'way', center: { lat: 37.0001, lon: -122 } },
    { id: 3, _type: 'way' }, // no center, must be skipped not crash
    { id: 4, _type: 'node', lat: 'x', lon: -122 }
  ];
  const kept = filterPointsNearRoute(route, points, 150);
  assert.deepEqual(kept.map(p => p.id), [1, 2]);
});

test('filterPointsNearRoute returns nothing when the route has no lines', () => {
  const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] } }] };
  assert.deepEqual(filterPointsNearRoute(fc, [{ id: 1, lat: 0, lon: 0 }], 500), []);
});

test('filterPointsNearRoute does not mutate its inputs', () => {
  const route = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: eastWestSegment(37) } }]
  };
  const original = { id: 1, lat: 37.0001, lon: -122 };
  filterPointsNearRoute(route, [original], 150);
  assert.equal(original._distanceM, undefined);
});

test('pointLonLat prefers node coordinates then centers', () => {
  assert.deepEqual(pointLonLat({ lat: 1, lon: 2 }), [2, 1]);
  assert.deepEqual(pointLonLat({ center: { lat: 3, lon: 4 } }), [4, 3]);
  assert.equal(pointLonLat({}), null);
  assert.equal(pointLonLat(null), null);
});

/** Deterministic PRNG so a failure is reproducible. */
function makeRandom(seed) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

test('the indexed distance agrees with the straightforward implementation', () => {
  // The fast path works in squared projected units with bbox rejection and a
  // shrinking bound; this pins it to the obvious per-segment implementation.
  const rand = makeRandom(2024);
  const coords = [];
  let lat = 37.3, lon = -122.1;
  for (let i = 0; i < 400; i++) {
    lat += (rand() - 0.5) * 0.004;
    lon += (rand() - 0.5) * 0.004;
    coords.push([lon, lat]);
  }
  const route = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords } }]
  };
  const index = buildRouteIndex(route);

  // Near the route - the only regime the app actually queries - the two agree
  // to floating-point noise. Far away they can differ by ~1e-6 relative,
  // because the fast path picks the winning segment by projected distance and
  // two segments tens of km away can be tied there but not on the ground.
  let near = 0;
  let far = 0;
  for (let i = 0; i < 500; i++) {
    const p = [-122.1 + (rand() - 0.5) * 0.9, 37.3 + (rand() - 0.5) * 0.9];
    const naive = minDistancePointToLineStringMeters(p, coords);
    const fast = distanceToRouteMeters(index, p);
    const relative = Math.abs(fast - naive) / Math.max(naive, 1);
    if (naive <= 5000) {
      assert.ok(relative < 1e-9, `near point ${p}: fast ${fast} vs naive ${naive}`);
      near++;
    } else {
      assert.ok(relative < 1e-4, `far point ${p}: fast ${fast} vs naive ${naive}`);
      far++;
    }
  }
  assert.ok(near > 0 && far > 0, `expected both regimes exercised, got near=${near} far=${far}`);
});

test('the cutoff never discards a point that is genuinely inside it', () => {
  const rand = makeRandom(77);
  const coords = [];
  let lat = 45, lon = 7;
  for (let i = 0; i < 200; i++) {
    lat += (rand() - 0.5) * 0.003;
    lon += (rand() - 0.5) * 0.003;
    coords.push([lon, lat]);
  }
  const route = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords } }] };
  const index = buildRouteIndex(route);

  for (let i = 0; i < 300; i++) {
    const p = [7 + (rand() - 0.5) * 0.4, 45 + (rand() - 0.5) * 0.4];
    const exact = minDistancePointToLineStringMeters(p, coords);
    for (const cutoff of [50, 150, 500, 2000]) {
      const bounded = distanceToRouteMeters(index, p, cutoff);
      if (exact <= cutoff) {
        assert.ok(Math.abs(bounded - exact) / Math.max(exact, 1) < 1e-6,
          `cutoff ${cutoff}: expected ${exact}, got ${bounded}`);
      } else {
        assert.equal(bounded, Infinity, `cutoff ${cutoff} should reject ${exact} m`);
      }
    }
  }
});

test('filterPointsNearRoute accepts a prebuilt index and matches the unindexed call', () => {
  const coords = [[-122, 37], [-122, 37.02], [-121.98, 37.02]];
  const route = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords } }] };
  const points = [
    { id: 1, lat: 37.0005, lon: -122.0005 },
    { id: 2, lat: 37.5, lon: -122 }
  ];
  const withIndex = filterPointsNearRoute(null, points, 200, buildRouteIndex(route));
  const withoutIndex = filterPointsNearRoute(route, points, 200);
  assert.deepEqual(withIndex.map(p => p.id), [1]);
  assert.deepEqual(withIndex.map(p => p.id), withoutIndex.map(p => p.id));
  assert.ok(Math.abs(withIndex[0]._distanceM - withoutIndex[0]._distanceM) < 1e-9);
});

test('buildRouteIndex reports emptiness rather than throwing on a route with no lines', () => {
  const index = buildRouteIndex({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] } }] });
  assert.equal(index.isEmpty, true);
  assert.equal(distanceToRouteMeters(index, [0, 0]), Infinity);
  assert.equal(distanceToRouteMeters(null, [0, 0]), Infinity);
  assert.deepEqual(filterPointsNearRoute(null, [{ lat: 0, lon: 0 }], 100, index), []);
});

test('the index still measures true ground metres at high latitude', () => {
  const index = buildRouteIndex({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[-122.05, 60], [-121.95, 60]] } }]
  });
  const p = [-122, 60.0018];
  const expected = haversineMeters(p, [-122, 60]);
  const actual = distanceToRouteMeters(index, p);
  assert.ok(Math.abs(actual - expected) / expected < 0.001, `got ${actual}, want ${expected}`);
});

test('computeBBoxFromGeoJSON covers every vertex', () => {
  const fc = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-122, 37], [-121, 38]] } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [-123, 36] } }
    ]
  };
  assert.deepEqual(computeBBoxFromGeoJSON(fc), { minlat: 36, minlon: -123, maxlat: 38, maxlon: -121 });
});

test('computeRouteLengthKm matches a known great-circle length', () => {
  // One degree of latitude is ~111.19 km on the sphere used here.
  const fc = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [0, 1]] } }]
  };
  const km = computeRouteLengthKm(fc);
  assert.ok(Math.abs(km - 111.32) < 0.2, `got ${km} km`);
});

test('computeRouteLengthKm ignores elevation in the third ordinate', () => {
  const flat = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [0, 1]] } }] };
  const withElev = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0, 100], [0, 1, 900]] } }] };
  assert.equal(computeRouteLengthKm(flat), computeRouteLengthKm(withElev));
});
