const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildEnrichedGpx,
  enrichedGpxForRow,
  isNearRouteSelection,
  waypointName,
  waypointInsertionIndex,
  escapeXml
} = require('../server/enrichedGpx');

const TRACK = '<trk><name>Ride</name><trkseg><trkpt lat="37.0" lon="-122.0"><ele>10</ele><time>2025-01-01T00:00:00Z</time></trkpt><trkpt lat="37.1" lon="-122.1"/></trkseg></trk>';
const PLAIN_GPX = `<?xml version="1.0"?><gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">${TRACK}</gpx>`;
const META_GPX = `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>Trip</name></metadata>${TRACK}</gpx>`;

const POINTS = [
  { _type: 'node', id: 1, lat: 37.02, lon: -122.02, _alongKm: 4.2, tags: { amenity: 'drinking_water', name: 'Park Fountain' } },
  { _type: 'way', id: 2, center: { lat: 37.05, lon: -122.05 }, _alongKm: 11.8, tags: { natural: 'spring' } }
];

test('waypoints are inserted before the first track, per the GPX 1.1 order', () => {
  const out = buildEnrichedGpx(PLAIN_GPX, POINTS);
  assert.ok(out.indexOf('<wpt ') < out.indexOf('<trk>'), 'wpt must precede trk');
  assert.equal((out.match(/<wpt /g) || []).length, 2);
});

test('waypoints go after a metadata block rather than before it', () => {
  const out = buildEnrichedGpx(META_GPX, POINTS);
  assert.ok(out.indexOf('</metadata>') < out.indexOf('<wpt '));
  assert.ok(out.indexOf('<wpt ') < out.indexOf('<trk>'));
});

test('the original track survives untouched, including time and elevation', () => {
  const out = buildEnrichedGpx(PLAIN_GPX, POINTS);
  assert.ok(out.includes(TRACK), 'the original track text must be preserved verbatim');
  assert.ok(out.includes('<time>2025-01-01T00:00:00Z</time>'));
  assert.ok(out.includes('<ele>10</ele>'));
  assert.ok(out.trimEnd().endsWith('</gpx>'));
});

test('waypoint names carry the position along the route', () => {
  const out = buildEnrichedGpx(PLAIN_GPX, POINTS);
  assert.ok(out.includes('<name>km 4.2 — Park Fountain</name>'));
  // Unnamed points fall back to their subtype.
  assert.ok(out.includes('<name>km 11.8 — spring</name>'));
});

test('waypointName falls back sensibly as tags thin out', () => {
  assert.equal(waypointName({ _alongKm: 3, tags: { name: 'A' } }), 'km 3.0 — A');
  assert.equal(waypointName({ _alongKm: 3, tags: { description: 'B' } }), 'km 3.0 — B');
  assert.equal(waypointName({ _alongKm: 3, tags: { amenity: 'fountain' } }), 'km 3.0 — fountain');
  assert.equal(waypointName({ _alongKm: 3, tags: {} }), 'km 3.0 — water');
  // No position recorded: no prefix rather than a bogus one.
  assert.equal(waypointName({ tags: { name: 'A' } }), 'A');
});

test('long routes format the position without a decimal', () => {
  assert.equal(waypointName({ _alongKm: 143.7, tags: { name: 'A' } }), 'km 144 — A');
});

test('way and relation centers are used when there is no node position', () => {
  const out = buildEnrichedGpx(PLAIN_GPX, [POINTS[1]]);
  assert.ok(out.includes('lat="37.05"'));
  assert.ok(out.includes('lon="-122.05"'));
});

test('points without any usable position are skipped, not emitted broken', () => {
  const out = buildEnrichedGpx(PLAIN_GPX, [
    POINTS[0],
    { _type: 'way', id: 9 },
    { _type: 'node', id: 10, lat: 'x', lon: -122 }
  ]);
  assert.equal((out.match(/<wpt /g) || []).length, 1);
  assert.ok(!out.includes('NaN'));
  assert.ok(!out.includes('undefined'));
});

test('names containing XML metacharacters are escaped', () => {
  const out = buildEnrichedGpx(PLAIN_GPX, [
    { lat: 37, lon: -122, _alongKm: 1, tags: { name: 'Bob & "Sue" <spring>' } }
  ]);
  assert.ok(out.includes('Bob &amp; &quot;Sue&quot; &lt;spring&gt;'));
  assert.ok(!out.includes('<spring>'));
});

test('escapeXml covers every metacharacter', () => {
  assert.equal(escapeXml(`&<>"'`), '&amp;&lt;&gt;&quot;&apos;');
  assert.equal(escapeXml('plain'), 'plain');
});

test('buildEnrichedGpx returns null rather than a broken file', () => {
  assert.equal(buildEnrichedGpx(PLAIN_GPX, []), null, 'no water points');
  assert.equal(buildEnrichedGpx(PLAIN_GPX, null), null);
  assert.equal(buildEnrichedGpx('', POINTS), null);
  assert.equal(buildEnrichedGpx(null, POINTS), null);
  assert.equal(buildEnrichedGpx('not xml at all', POINTS), null, 'no gpx root');
  assert.equal(buildEnrichedGpx('<gpx version="1.1"/>', POINTS), null, 'self-closing root');
  assert.equal(buildEnrichedGpx(PLAIN_GPX, [{ id: 1 }]), null, 'no point has coordinates');
});

test('waypointInsertionIndex points just past the root or the metadata', () => {
  const plain = waypointInsertionIndex(PLAIN_GPX);
  assert.equal(PLAIN_GPX.slice(plain, plain + 5), '<trk>');

  const withMeta = waypointInsertionIndex(META_GPX);
  assert.equal(META_GPX.slice(withMeta, withMeta + 5), '<trk>');

  assert.equal(waypointInsertionIndex('<gpx'), null, 'unterminated root tag');
  assert.equal(waypointInsertionIndex('nope'), null);
});

test('the result is still parseable as XML', () => {
  const out = buildEnrichedGpx(META_GPX, POINTS);
  // Tag balance is a cheap proxy for well-formedness without pulling in a parser.
  const opens = (out.match(/<wpt /g) || []).length;
  const closes = (out.match(/<\/wpt>/g) || []).length;
  assert.equal(opens, closes);
  assert.equal((out.match(/<gpx/g) || []).length, 1);
  assert.equal((out.match(/<\/gpx>/g) || []).length, 1);
});

const NEAR_POINTS = POINTS.map((p, i) => ({ ...p, _distanceM: 40 + i }));

test('isNearRouteSelection requires every point to be annotated', () => {
  assert.equal(isNearRouteSelection(NEAR_POINTS), true);
  assert.equal(isNearRouteSelection(POINTS), false, 'legacy points carry no _distanceM');
  assert.equal(isNearRouteSelection([...NEAR_POINTS, { lat: 1, lon: 1 }]), false, 'one unannotated point taints the set');
  assert.equal(isNearRouteSelection([]), false);
  assert.equal(isNearRouteSelection(null), false);
});

test('a stored copy is served verbatim, without rebuilding', () => {
  const out = enrichedGpxForRow({
    gpxText: PLAIN_GPX,
    enrichedGpxText: '<gpx>archived</gpx>',
    waterPoints: NEAR_POINTS
  });
  assert.equal(out, '<gpx>archived</gpx>');
});

test('a row without a stored copy is rebuilt when its points are annotated', () => {
  const out = enrichedGpxForRow({ gpxText: PLAIN_GPX, enrichedGpxText: null, waterPoints: NEAR_POINTS });
  assert.ok(out && out.includes('<wpt '));
  assert.equal((out.match(/<wpt /g) || []).length, 2);
});

test('legacy points are refused rather than guessed at', () => {
  // These rows stored the whole bounding box, so rebuilding would invent
  // waypoints that were never in the archived file.
  assert.equal(enrichedGpxForRow({ gpxText: PLAIN_GPX, enrichedGpxText: null, waterPoints: POINTS }), null);
  assert.equal(enrichedGpxForRow({ gpxText: PLAIN_GPX, enrichedGpxText: null, waterPoints: null }), null);
  assert.equal(enrichedGpxForRow(null), null);
});

test('a row the reclaim script certified is rebuilt even without annotations', () => {
  // reclaim-enriched.js only sets this after checking that the rebuild
  // reproduces the file it replaced, so the guarantee comes from that check.
  const row = { gpxText: PLAIN_GPX, enrichedGpxText: null, enrichedRegenerable: true, waterPoints: POINTS };
  const out = enrichedGpxForRow(row);
  assert.ok(out && out.includes('<wpt '));
  assert.equal((out.match(/<wpt /g) || []).length, 2);
});

test('certification cannot conjure a file from nothing', () => {
  assert.equal(enrichedGpxForRow({ gpxText: PLAIN_GPX, enrichedRegenerable: true, waterPoints: [] }), null);
  assert.equal(enrichedGpxForRow({ gpxText: '', enrichedRegenerable: true, waterPoints: POINTS }), null);
});
