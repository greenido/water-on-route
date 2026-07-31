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

module.exports = {
  MAX_GPX_BYTES,
  safeEqual,
  validateRoutePayload,
  validateTileCoordinates,
  isAllowedOrigin,
  normalizeHttpUrl
};
