/**
 * Geometry helpers for route/POI proximity.
 *
 * Distances are true ground distances in metres. Points are [lon, lat] pairs
 * so the module can consume GeoJSON coordinates directly.
 */

const EARTH_RADIUS_M = 6378137;
const DEG_TO_RAD = Math.PI / 180;

/**
 * Spherical Web Mercator projection.
 * @param {number} lon degrees
 * @param {number} lat degrees
 * @returns {[number, number]} [x, y] in metres of projected plane
 */
export function lonLatToWebMercator(lon, lat) {
  const x = EARTH_RADIUS_M * (lon * DEG_TO_RAD);
  const y = EARTH_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + (lat * DEG_TO_RAD) / 2));
  return [x, y];
}

/**
 * Local scale factor of the Web Mercator projection at a projected y.
 *
 * Mercator is conformal but not equidistant: a metre on the projected plane is
 * only a true metre at the equator, and is inflated by 1/cos(latitude) elsewhere
 * (x2 at 60 degrees). Projected lengths must be divided by this factor to get
 * ground distance. cosh(y/R) is identically 1/cos(latitude), so we can descale
 * without inverting the projection.
 *
 * @param {number} y projected northing in metres
 * @returns {number} scale factor >= 1
 */
export function mercatorScaleAtY(y) {
  return Math.cosh(y / EARTH_RADIUS_M);
}

/**
 * Great-circle distance between two [lon, lat] points.
 * @returns {number} metres
 */
export function haversineMeters(a, b) {
  const lat1 = a[1] * DEG_TO_RAD;
  const lat2 = b[1] * DEG_TO_RAD;
  const dLat = lat2 - lat1;
  const dLon = (b[0] - a[0]) * DEG_TO_RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Shortest ground distance from a point to a segment.
 *
 * The perpendicular foot is found on the projected plane (valid because
 * Mercator preserves angles), then the projected length is descaled to metres.
 *
 * @param {[number, number]} p [lon, lat]
 * @param {[number, number]} a segment start [lon, lat]
 * @param {[number, number]} b segment end [lon, lat]
 * @returns {number} metres
 */
export function pointToSegmentDistanceMeters(p, a, b) {
  const [px, py] = lonLatToWebMercator(p[0], p[1]);
  const [ax, ay] = lonLatToWebMercator(a[0], a[1]);
  const [bx, by] = lonLatToWebMercator(b[0], b[1]);
  return projectedPointToSegmentMeters(px, py, ax, ay, bx, by);
}

/**
 * Same as pointToSegmentDistanceMeters but on already-projected coordinates,
 * so callers that reuse a projected polyline do not re-project per query.
 * @returns {number} metres
 */
export function projectedPointToSegmentMeters(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const abLen2 = abx * abx + aby * aby;
  let t = abLen2 === 0 ? 0 : ((px - ax) * abx + (py - ay) * aby) / abLen2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * abx;
  const cy = ay + t * aby;
  const dx = px - cx;
  const dy = py - cy;
  const projected = Math.sqrt(dx * dx + dy * dy);
  // Descale at the midpoint of the two endpoints; over the sub-kilometre spans
  // we care about the scale factor is effectively constant.
  return projected / mercatorScaleAtY((py + cy) / 2);
}

/**
 * Shortest ground distance from a point to a polyline.
 * @param {[number, number]} pointLonLat
 * @param {Array<[number, number]>} lineCoordsLonLat
 * @returns {number} metres, Infinity for a degenerate line
 */
export function minDistancePointToLineStringMeters(pointLonLat, lineCoordsLonLat) {
  let min = Infinity;
  for (let i = 1; i < lineCoordsLonLat.length; i++) {
    const d = pointToSegmentDistanceMeters(pointLonLat, lineCoordsLonLat[i - 1], lineCoordsLonLat[i]);
    if (d < min) min = d;
  }
  return min;
}

/** Pull every LineString/MultiLineString coordinate array out of a GeoJSON value. */
export function extractRouteLineStrings(geojson) {
  const lines = [];
  const addLine = (coords) => { if (coords && coords.length >= 2) lines.push(coords); };
  function walkGeometry(geom) {
    if (!geom) return;
    if (geom.type === 'LineString') addLine(geom.coordinates);
    else if (geom.type === 'MultiLineString') {
      for (const ls of geom.coordinates) addLine(ls);
    } else if (geom.type === 'GeometryCollection') {
      for (const g of geom.geometries || []) walkGeometry(g);
    }
  }
  if (!geojson) return lines;
  if (geojson.type === 'FeatureCollection') {
    for (const f of geojson.features || []) walkGeometry(f.geometry);
  } else if (geojson.type === 'Feature') {
    walkGeometry(geojson.geometry);
  } else if (geojson.type && geojson.coordinates) {
    walkGeometry(geojson);
  }
  return lines;
}

/** Read [lon, lat] off an Overpass node (lat/lon) or way/relation (center). */
export function pointLonLat(p) {
  const lat = p?.lat ?? p?.center?.lat;
  const lon = p?.lon ?? p?.center?.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return [lon, lat];
}

/**
 * Pre-project a route for repeated proximity queries.
 *
 * Projecting inside the query loop meant three lonLatToWebMercator calls per
 * segment per candidate: on a 5,400-point route with 300 candidates that is
 * ~5M log/tan evaluations, repeated on every radius change. Here the route is
 * projected once into flat Float64Arrays, with bounding boxes so most segments
 * can be rejected by comparison instead of arithmetic.
 *
 * @param {object} geojsonRoute
 * @returns {{lines: Array<object>, minX: number, minY: number, maxX: number, maxY: number, isEmpty: boolean}}
 */
export function buildRouteIndex(geojsonRoute) {
  const lines = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let totalM = 0;

  for (const ls of extractRouteLineStrings(geojsonRoute)) {
    const xy = new Float64Array(ls.length * 2);
    // Ground metres from the start of this line to each vertex, so a match can
    // report how far along the route it sits, not just how far off it.
    const cum = new Float64Array(ls.length);
    const elevation = new Float64Array(ls.length);
    let lMinX = Infinity, lMinY = Infinity, lMaxX = -Infinity, lMaxY = -Infinity;

    for (let i = 0; i < ls.length; i++) {
      const [x, y] = lonLatToWebMercator(ls[i][0], ls[i][1]);
      xy[i * 2] = x;
      xy[i * 2 + 1] = y;
      elevation[i] = typeof ls[i][2] === 'number' ? ls[i][2] : NaN;
      if (i > 0) cum[i] = cum[i - 1] + haversineMeters(ls[i - 1], ls[i]);
      if (x < lMinX) lMinX = x;
      if (x > lMaxX) lMaxX = x;
      if (y < lMinY) lMinY = y;
      if (y > lMaxY) lMaxY = y;
    }

    lines.push({
      xy,
      cum,
      elevation,
      startM: totalM,
      minX: lMinX, minY: lMinY, maxX: lMaxX, maxY: lMaxY
    });
    totalM += cum[cum.length - 1] || 0;

    if (lMinX < minX) minX = lMinX;
    if (lMaxX > maxX) maxX = lMaxX;
    if (lMinY < minY) minY = lMinY;
    if (lMaxY > maxY) maxY = lMaxY;
  }

  return { lines, minX, minY, maxX, maxY, totalM, isEmpty: lines.length === 0 };
}

/**
 * Ground distance from a lon/lat point to an indexed route.
 *
 * Works in squared projected units so the inner loop has no sqrt and no cosh,
 * then descales once at the midpoint between the query and the closest point,
 * matching what a per-segment implementation computes.
 *
 * @param {object} index from buildRouteIndex
 * @param {[number, number]} lonLat
 * @param {number} [maxMeters] optional cutoff; returns Infinity when exceeded
 * @returns {number} metres, or Infinity
 */
export function nearestOnRoute(index, lonLat, maxMeters = Infinity) {
  if (!index || index.isEmpty) return null;
  const [px, py] = lonLatToWebMercator(lonLat[0], lonLat[1]);
  const scale = mercatorScaleAtY(py);

  // Ground metres -> projected units, so the whole search stays in one space.
  let bound = Number.isFinite(maxMeters) ? maxMeters * scale : Infinity;
  if (Number.isFinite(bound)) {
    if (px < index.minX - bound || px > index.maxX + bound ||
        py < index.minY - bound || py > index.maxY + bound) {
      return null;
    }
  }

  let bestSq = Number.isFinite(bound) ? bound * bound : Infinity;
  let bestCy = py;
  let bestAlongM = 0;
  let found = false;

  for (const line of index.lines) {
    if (Number.isFinite(bound) &&
        (px < line.minX - bound || px > line.maxX + bound ||
         py < line.minY - bound || py > line.maxY + bound)) {
      continue;
    }
    const xy = line.xy;
    const cum = line.cum;
    for (let i = 2; i < xy.length; i += 2) {
      const ax = xy[i - 2], ay = xy[i - 1];
      const bx = xy[i], by = xy[i + 1];

      // Reject the segment on its own bounding box before doing any real work.
      const loX = ax < bx ? ax : bx;
      const hiX = ax < bx ? bx : ax;
      if (px < loX - bound || px > hiX + bound) continue;
      const loY = ay < by ? ay : by;
      const hiY = ay < by ? by : ay;
      if (py < loY - bound || py > hiY + bound) continue;

      const abx = bx - ax;
      const aby = by - ay;
      const abLen2 = abx * abx + aby * aby;
      let t = abLen2 === 0 ? 0 : ((px - ax) * abx + (py - ay) * aby) / abLen2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cy = ay + t * aby;
      const dx = px - (ax + t * abx);
      const dy = py - cy;
      const dSq = dx * dx + dy * dy;

      if (dSq < bestSq) {
        bestSq = dSq;
        bestCy = cy;
        found = true;
        const v = i / 2; // index of the segment's end vertex
        bestAlongM = line.startM + cum[v - 1] + t * (cum[v] - cum[v - 1]);
        // Tightening the bound makes later segments cheaper to reject.
        bound = Math.sqrt(dSq);
      }
    }
  }

  if (!found) return null;
  return {
    distanceM: Math.sqrt(bestSq) / mercatorScaleAtY((py + bestCy) / 2),
    alongM: bestAlongM
  };
}

/**
 * Ground distance from a lon/lat point to an indexed route.
 * @returns {number} metres, or Infinity when beyond maxMeters
 */
export function distanceToRouteMeters(index, lonLat, maxMeters = Infinity) {
  const nearest = nearestOnRoute(index, lonLat, maxMeters);
  return nearest ? nearest.distanceM : Infinity;
}

/**
 * Keep the POIs within maxMeters of the route, annotating each with _distanceM.
 * @param {object|null} geojsonRoute
 * @param {Array<object>} points Overpass-shaped POIs
 * @param {number} maxMeters
 * @param {object} [routeIndex] a prebuilt index, to avoid re-projecting
 * @returns {Array<object>} copies carrying _distanceM
 */
export function filterPointsNearRoute(geojsonRoute, points, maxMeters, routeIndex) {
  const index = routeIndex || buildRouteIndex(geojsonRoute);
  if (index.isEmpty) return [];
  const result = [];
  for (const p of points || []) {
    const pt = pointLonLat(p);
    if (!pt) continue;
    const nearest = nearestOnRoute(index, pt, maxMeters);
    if (nearest && nearest.distanceM <= maxMeters) {
      result.push({ ...p, _distanceM: nearest.distanceM, _alongKm: nearest.alongM / 1000 });
    }
  }
  return result;
}

/** Order by position along the route, which is the order they are ridden in. */
export function sortPointsAlongRoute(points) {
  return [...points].sort((a, b) => (a._alongKm ?? Infinity) - (b._alongKm ?? Infinity));
}

/**
 * The longest stretch of route with no water, including the run-in from the
 * start and the run-out to the finish.
 *
 * This is the number a rider actually plans around: not "how far off-route is
 * the nearest fountain" but "how long am I without one".
 *
 * @param {number} routeKm total route length
 * @param {Array<{_alongKm: number}>} points water points carrying _alongKm
 * @returns {{gapKm: number, startKm: number, endKm: number, count: number}}
 */
export function longestDryStretch(routeKm, points) {
  const total = Number.isFinite(routeKm) && routeKm > 0 ? routeKm : 0;
  const marks = (points || [])
    .map((p) => p._alongKm)
    .filter((km) => Number.isFinite(km))
    .sort((a, b) => a - b);

  if (!total) return { gapKm: 0, startKm: 0, endKm: 0, count: marks.length };
  if (!marks.length) return { gapKm: total, startKm: 0, endKm: total, count: 0 };

  let gapKm = marks[0];
  let startKm = 0;
  let endKm = marks[0];

  for (let i = 1; i < marks.length; i++) {
    const gap = marks[i] - marks[i - 1];
    if (gap > gapKm) {
      gapKm = gap;
      startKm = marks[i - 1];
      endKm = marks[i];
    }
  }

  const runOut = total - marks[marks.length - 1];
  if (runOut > gapKm) {
    gapKm = runOut;
    startKm = marks[marks.length - 1];
    endKm = total;
  }

  return { gapKm, startKm, endKm, count: marks.length };
}

/**
 * Elevation samples for a compact profile strip: [{ km, ele }].
 * Returns [] when the route carries no elevation data.
 * @param {object} index from buildRouteIndex
 * @param {number} [samples] target number of points
 */
export function elevationProfile(index, samples = 240) {
  if (!index || index.isEmpty) return [];
  const all = [];
  for (const line of index.lines) {
    for (let i = 0; i < line.cum.length; i++) {
      const ele = line.elevation[i];
      if (Number.isFinite(ele)) all.push({ km: (line.startM + line.cum[i]) / 1000, ele });
    }
  }
  if (all.length < 2) return [];
  if (all.length <= samples) return all;
  // Even stride keeps the shape without shipping thousands of points to the DOM.
  const stride = all.length / samples;
  const out = [];
  for (let i = 0; i < samples; i++) out.push(all[Math.floor(i * stride)]);
  out.push(all[all.length - 1]);
  return out;
}

/** Axis-aligned bounds of any GeoJSON value, in Overpass key order. */
export function computeBBoxFromGeoJSON(geojson) {
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  function update([lon, lat]) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  function walkCoords(coords) {
    if (!coords || !coords.length) return;
    if (typeof coords[0] === 'number') update(coords);
    else for (const c of coords) walkCoords(c);
  }
  if (!geojson) return { minlat: minLat, minlon: minLon, maxlat: maxLat, maxlon: maxLon };
  if (geojson.type === 'FeatureCollection') {
    for (const f of geojson.features || []) {
      if (f?.geometry?.coordinates) walkCoords(f.geometry.coordinates);
    }
  } else if (geojson.type === 'Feature') {
    if (geojson.geometry?.coordinates) walkCoords(geojson.geometry.coordinates);
  } else if (geojson.type && geojson.coordinates) {
    walkCoords(geojson.coordinates);
  }
  return { minlat: minLat, minlon: minLon, maxlat: maxLat, maxlon: maxLon };
}

/** Total length of every LineString in the route. */
export function computeRouteLengthKm(geojson) {
  let meters = 0;
  for (const ls of extractRouteLineStrings(geojson)) {
    for (let i = 1; i < ls.length; i++) meters += haversineMeters(ls[i - 1], ls[i]);
  }
  return meters / 1000;
}
