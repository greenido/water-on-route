/**
 * Overpass QL construction.
 *
 * This lives on the server on purpose. The proxy used to forward whatever
 * query text a client sent, which made it an open relay: anyone could run
 * unrestricted planet-wide Overpass queries under this server's identity and
 * get it banned from the public endpoint. Clients now send only a bounding box
 * and a kind, and the query is built here from a fixed set of templates.
 */

/** Kinds a client may ask for. Anything else is rejected. */
const QUERY_KINDS = Object.freeze(['water', 'coffee']);

const COFFEE_CUISINE_RE = 'coffee|cafe|coffee_shop|espresso';

/**
 * Expand a tag selector across node/way/relation for one bbox.
 * @param {string[]} selectors e.g. ['["amenity"="cafe"]']
 * @param {string} bboxPart "south,west,north,east"
 */
function forEachElementType(selectors, bboxPart) {
  const lines = [];
  for (const type of ['node', 'way', 'relation']) {
    for (const selector of selectors) {
      lines.push(`      ${type}${selector}(${bboxPart});`);
    }
  }
  return lines.join('\n');
}

/** Overpass wants (south,west,north,east); swapping silently returns nothing. */
function bboxPart(b) {
  return `${b.minlat},${b.minlon},${b.maxlat},${b.maxlon}`;
}

/**
 * Potable water: classic OSM tags plus park fountains, taps and wells.
 * drinking_water=no is filtered client-side by isPotableWaterTags.
 */
function buildOverpassWaterQuery(b) {
  const selectors = [
    '["amenity"="drinking_water"]',
    '["natural"="spring"]',
    '["man_made"="water_tap"]',
    '["amenity"="water_point"]',
    '["amenity"="fountain"]["drinking_water"~"^(yes|compatible)$"]',
    '["man_made"="water_well"]["drinking_water"~"^(yes|compatible)$"]',
    '["drinking_water"~"^(yes|compatible)$"]'
  ];
  return `
    [out:xml][timeout:25];
    (
${forEachElementType(selectors, bboxPart(b))}
    );
    out body center qt;
  `;
}

/** Cafes, coffee shops, and restaurants tagged with a coffee cuisine. */
function buildOverpassCoffeeQuery(b) {
  const selectors = [
    '["amenity"="cafe"]',
    '["shop"="coffee"]',
    `["amenity"="restaurant"]["cuisine"~"${COFFEE_CUISINE_RE}", i]`
  ];
  return `
    [out:xml][timeout:25];
    (
${forEachElementType(selectors, bboxPart(b))}
    );
    out body center qt;
  `;
}

const BUILDERS = Object.freeze({
  water: buildOverpassWaterQuery,
  coffee: buildOverpassCoffeeQuery
});

/**
 * Build the query for a validated bbox and kind.
 * @throws {Error} when the kind is not one of QUERY_KINDS
 */
function buildQueryForKind(kind, bbox) {
  const build = Object.prototype.hasOwnProperty.call(BUILDERS, kind) ? BUILDERS[kind] : null;
  if (!build) throw new Error(`Unsupported query kind: ${kind}`);
  return build(bbox);
}

module.exports = {
  QUERY_KINDS,
  buildOverpassWaterQuery,
  buildOverpassCoffeeQuery,
  buildQueryForKind
};
