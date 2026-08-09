const crypto = require('crypto');

const MAX_GPX_BYTES = 8 * 1024 * 1024;
const MAX_ENRICHED_GPX_BYTES = 12 * 1024 * 1024;
const MAX_WATER_POINTS_BYTES = 512 * 1024;

function safeEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const actualBuffer = Buffer.from(actual, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateRoutePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'Invalid request body' };
  }

  const filename = typeof payload.filename === 'string' ? payload.filename.trim() : 'route.gpx';
  const gpxText = payload.gpxText;
  const enrichedGpxText = payload.enrichedGpxText;

  if (!filename || filename.length > 255 || !/\.gpx$/i.test(filename)) {
    return { ok: false, error: 'filename must be a .gpx name up to 255 characters' };
  }
  if (typeof gpxText !== 'string' || !/<gpx(?:\s|>)/i.test(gpxText.slice(0, 2048))) {
    return { ok: false, error: 'gpxText must contain a GPX document' };
  }
  if (byteLength(gpxText) > MAX_GPX_BYTES) {
    return { ok: false, error: 'gpxText exceeds the 8 MB limit' };
  }
  if (enrichedGpxText != null) {
    if (typeof enrichedGpxText !== 'string' || !/<gpx(?:\s|>)/i.test(enrichedGpxText.slice(0, 2048))) {
      return { ok: false, error: 'enrichedGpxText must contain a GPX document' };
    }
    if (byteLength(enrichedGpxText) > MAX_ENRICHED_GPX_BYTES) {
      return { ok: false, error: 'enrichedGpxText exceeds the 12 MB limit' };
    }
  }

  const bbox = payload.bbox;
  if (bbox != null) {
    const keys = ['minlat', 'minlon', 'maxlat', 'maxlon'];
    if (!bbox || typeof bbox !== 'object' || !keys.every((key) => isFiniteNumber(bbox[key]))) {
      return { ok: false, error: 'bbox must contain finite numeric bounds' };
    }
    if (bbox.minlat < -90 || bbox.maxlat > 90 || bbox.minlon < -180 || bbox.maxlon > 180 ||
        bbox.minlat > bbox.maxlat || bbox.minlon > bbox.maxlon) {
      return { ok: false, error: 'bbox is outside valid coordinate bounds' };
    }
  }

  const routeKm = payload.routeKm;
  if (routeKm != null && (!isFiniteNumber(routeKm) || routeKm < 0 || routeKm > 50000)) {
    return { ok: false, error: 'routeKm is invalid' };
  }
  const waypointsCount = payload.waypointsCount;
  if (waypointsCount != null &&
      (!Number.isInteger(waypointsCount) || waypointsCount < 0 || waypointsCount > 10000)) {
    return { ok: false, error: 'waypointsCount is invalid' };
  }
  const waterPoints = payload.waterPoints;
  if (waterPoints != null) {
    if (!Array.isArray(waterPoints) || waterPoints.length > 10000) {
      return { ok: false, error: 'waterPoints is invalid' };
    }
    if (byteLength(JSON.stringify(waterPoints)) > MAX_WATER_POINTS_BYTES) {
      return { ok: false, error: 'waterPoints exceeds the 512 KB limit' };
    }
  }

  return {
    ok: true,
    value: {
      filename,
      gpxText,
      bbox: bbox || null,
      routeKm: routeKm ?? null,
      waypointsCount: waypointsCount ?? null,
      waterPoints: waterPoints || null,
      enrichedGpxText: enrichedGpxText || null
    }
  };
}

function validateTileCoordinates(zValue, xValue, yValue) {
  if (![zValue, xValue, yValue].every((value) => /^\d+$/.test(String(value)))) return null;
  const z = Number(zValue);
  const x = Number(xValue);
  const y = Number(yValue);
  if (!Number.isInteger(z) || z < 0 || z > 22) return null;
  const maximum = 2 ** z;
  if (x < 0 || y < 0 || x >= maximum || y >= maximum) return null;
  return { z, x, y };
}

/**
 * Reduce a client IP to a coarse network before it is stored.
 *
 * A GPX track already reveals where someone rides; pairing it with a full IP
 * makes the pair directly identifying. Dropping the host portion keeps the
 * value useful for coarse traffic analysis without pinning it to a household:
 * IPv4 keeps the /24, IPv6 keeps the /48.
 *
 * @param {string|null|undefined} ip
 * @returns {string|null} anonymized IP, or null when the input is not an IP
 */
function anonymizeIp(ip) {
  if (typeof ip !== 'string') return null;
  let value = ip.trim();
  if (!value) return null;

  // Normalize IPv4-mapped IPv6 (::ffff:203.0.113.45) to its IPv4 form.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mapped) value = mapped[1];

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
    const octets = value.split('.');
    if (octets.some((o) => Number(o) > 255)) return null;
    return `${octets[0]}.${octets[1]}.${octets[2]}.0`;
  }

  if (value.includes(':')) {
    // Expand the :: shorthand so we can reliably keep the first three hextets.
    const [head, tail = ''] = value.split('::');
    const headParts = head ? head.split(':').filter(Boolean) : [];
    const tailParts = tail ? tail.split(':').filter(Boolean) : [];
    const missing = 8 - headParts.length - tailParts.length;
    if (missing < 0) return null;
    const full = value.includes('::')
      ? [...headParts, ...Array(missing).fill('0'), ...tailParts]
      : value.split(':');
    if (full.length !== 8) return null;
    return `${full.slice(0, 3).join(':')}::`;
  }

  return null;
}

function isAllowedOrigin(origin, host) {
  if (!origin) return true;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function normalizeHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(value.trim())
    ? value.trim()
    : `https://${value.trim()}`;
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function positiveInteger(value, fallback, minimum, maximum) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Configuration value must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

module.exports = {
  MAX_GPX_BYTES,
  safeEqual,
  validateRoutePayload,
  validateTileCoordinates,
  isAllowedOrigin,
  normalizeHttpUrl,
  positiveInteger,
  anonymizeIp
};
