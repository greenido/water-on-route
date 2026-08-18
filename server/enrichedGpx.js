/**
 * Rebuild an enriched GPX from the original file plus the water points found
 * for it.
 *
 * Every saved route used to store the enriched GPX as well as the original,
 * which doubled the storage for something fully derivable: 21 MB of originals
 * carried 15 MB of enriched copies. Generating on download costs a few
 * milliseconds and keeps one copy of the truth.
 *
 * Waypoints are injected into the original text rather than re-serialising a
 * parsed route, so tracks keep their timestamps, elevation and extensions
 * exactly as uploaded.
 */

// Node 22 can require() an ES module, so the naming rules live in one place
// rather than being copied from the client.
const { waterSubtypeLabel } = require('../osmApi.mjs');
const { formatKm } = require('../geo.mjs');

const GPX_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (c) => GPX_ESCAPES[c]);
}

/** Overpass nodes carry lat/lon; ways and relations carry a center. */
function pointCoordinates(point) {
  const lat = point?.lat ?? point?.center?.lat;
  const lon = point?.lon ?? point?.center?.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

/**
 * "km 47.0 — Fountain", matching what the client writes, so a regenerated
 * file is indistinguishable from one exported in the browser.
 */
function waypointName(point) {
  const tags = point?.tags || {};
  const label = tags.name || tags.description || waterSubtypeLabel(tags) || 'Water';
  return Number.isFinite(point?._alongKm) ? `km ${formatKm(point._alongKm)} — ${label}` : label;
}

function waypointXml(point) {
  const coords = pointCoordinates(point);
  if (!coords) return null;
  const name = escapeXml(waypointName(point));
  const type = escapeXml(waterSubtypeLabel(point?.tags) || 'water');
  return `<wpt lat="${coords.lat}" lon="${coords.lon}"><name>${name}</name><type>${type}</type></wpt>`;
}

/**
 * Where waypoints belong in a GPX document.
 *
 * GPX 1.1 fixes the child order as metadata?, wpt*, rte*, trk*, so waypoints
 * go after any metadata block and before the first track. Appending them at
 * the end would produce a file some parsers reject.
 *
 * @returns {number|null} index to splice at, or null when the text is not GPX
 *   we can safely edit
 */
function waypointInsertionIndex(gpxText) {
  const openStart = gpxText.indexOf('<gpx');
  if (openStart < 0) return null;
  const openEnd = gpxText.indexOf('>', openStart);
  if (openEnd < 0) return null;
  // A self-closing root has no room for children.
  if (gpxText[openEnd - 1] === '/') return null;

  const metadataClose = gpxText.indexOf('</metadata>', openEnd);
  if (metadataClose >= 0) return metadataClose + '</metadata>'.length;
  return openEnd + 1;
}

/**
 * Whether a stored point set is the near-route selection that was exported.
 *
 * Rows written before the near-route filter annotated its output stored every
 * point in the route's bounding box, not the subset within the search radius:
 * one archived row holds 117 points for a file that contained 12 waypoints,
 * and the radius that produced it was never recorded. Rebuilding from those
 * would silently invent waypoints, so _distanceM is treated as the marker that
 * a set is the filtered one and safe to rebuild from.
 *
 * @param {Array<object>} waterPoints
 * @returns {boolean}
 */
function isNearRouteSelection(waterPoints) {
  return Array.isArray(waterPoints)
    && waterPoints.length > 0
    && waterPoints.every((p) => Number.isFinite(p?._distanceM));
}

/**
 * Splice waypoints into a GPX document.
 *
 * Makes no judgement about whether the points are the right ones: callers that
 * cannot check the result against something must gate on
 * isNearRouteSelection first.
 *
 * @param {string} gpxText the original uploaded GPX
 * @param {Array<object>} waterPoints points as stored in water_points_json
 * @returns {string|null} enriched GPX, or null when it cannot be built
 */
function buildEnrichedGpx(gpxText, waterPoints) {
  if (typeof gpxText !== 'string' || !gpxText) return null;
  if (!Array.isArray(waterPoints) || waterPoints.length === 0) return null;

  const index = waypointInsertionIndex(gpxText);
  if (index === null) return null;

  const waypoints = waterPoints.map(waypointXml).filter(Boolean);
  if (!waypoints.length) return null;

  return `${gpxText.slice(0, index)}\n${waypoints.join('\n')}${gpxText.slice(index)}`;
}

/**
 * The enriched GPX to serve for a stored route.
 *
 * Prefers the archived copy. Otherwise it rebuilds, but only when the result
 * can be trusted: either the points carry _distanceM and are known to be the
 * near-route selection, or the reclaim script already verified for this row
 * that a rebuild reproduces the file it replaced.
 *
 * @param {{gpxText: string, enrichedGpxText: string|null, enrichedRegenerable?: boolean, waterPoints: Array<object>|null}} row
 * @returns {string|null}
 */
function enrichedGpxForRow(row) {
  if (!row) return null;
  if (row.enrichedGpxText) return row.enrichedGpxText;
  if (!row.enrichedRegenerable && !isNearRouteSelection(row.waterPoints)) return null;
  return buildEnrichedGpx(row.gpxText, row.waterPoints);
}

module.exports = {
  buildEnrichedGpx,
  enrichedGpxForRow,
  isNearRouteSelection,
  waypointName,
  waypointInsertionIndex,
  escapeXml
};
