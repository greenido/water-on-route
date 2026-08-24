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
const QUERY_KINDS = Object.freeze(['water', 'coffee', 'refill']);

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

/**
 * Places a rider can top up bottles that are not tagged as drinking water.
 *
 * Outside cities amenity=drinking_water is sparse: on the archived 121 km
 * Windy Butano route the app found 8 water points, and 111 km through the
 * Santa Cruz mountains found 12, against 39 per 10 km for a run through a
 * city park. Riders bridge those gaps at fuel stations, shops, campgrounds
 * and cemetery taps, none of which the water query asks for.
 *
 * Cafes are deliberately absent: the coffee search already covers hospitality,
 * and duplicating it here would put the same pins on two layers.
 */
function buildOverpassRefillQuery(b) {
  const selectors = [
    '["amenity"="fuel"]',
    '["shop"~"^(convenience|supermarket)$"]',
    '["amenity"="toilets"]',
    '["tourism"~"^(camp_site|picnic_site|wilderness_hut|alpine_hut)$"]',
    // A tap by the gate is standard in much of Europe and often the only
    // water for miles.
    '["amenity"="grave_yard"]',
    '["landuse"="cemetery"]',
    '["amenity"="water_point"]',
    '["waterway"="water_point"]'
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
  coffee: buildOverpassCoffeeQuery,
  refill: buildOverpassRefillQuery
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
  buildOverpassRefillQuery,
  buildQueryForKind
};
