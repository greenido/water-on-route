/**
 * What happens to an uploaded route, and how long it stays.
 *
 * Uploads are anonymous, and the Origin check only stops browsers: a script can
 * send any header it likes. So the limits here do not depend on who is asking.
 * A daily budget means one client cannot fill the volume in an afternoon, and
 * the cap makes room by dropping the oldest routes nobody shared, so a full
 * database costs some old telemetry rather than everyone's ability to share.
 *
 * Routes that were only saved expire. Share links last until deleted, because
 * the link is something a person handed to someone else. Rows from before
 * expiry existed have no expiry date and are left alone.
 */
const crypto = require('crypto');
const {
  insertRoute,
  findRouteByContentHash,
  shareExistingRoute,
  getShareCredentials,
  deleteRouteById,
  databaseUsedBytes,
  uploadedBytesLastDay,
  deleteOldestExpiringRoutes
} = require('./db');
const { safeEqual } = require('./security');

const EVICTION_BATCH = 25;

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

// Hex, not base64url: Slack/markdown treat `_` as emphasis and split the URL, so
// a recipient opened ?route=ab instead of ?route=ab_cd… (HTTP 400).
const newToken = () => crypto.randomBytes(16).toString('hex');

/**
 * Drop the oldest expiring routes until the incoming bytes fit under the cap.
 * @returns {Promise<boolean>} false when only routes we must keep are left
 */
async function makeRoom(incomingBytes, maxBytes) {
  if (incomingBytes > maxBytes) return false;
  while ((await databaseUsedBytes()) + incomingBytes > maxBytes) {
    if (!(await deleteOldestExpiringRoutes(EVICTION_BATCH))) return false;
  }
  return true;
}

/**
 * Store an uploaded route, reusing a row with the same file where that is safe.
 *
 * A plain save of a file already held adds nothing. Sharing takes over a row
 * nobody has shared yet, but gets its own row otherwise: two riders sharing the
 * same event GPX each hold a link, and one deleting theirs must not break the
 * other's.
 *
 * @param {object} route validated fields: filename, gpxText, bbox, routeKm,
 *   waypointsCount, waterPoints, clientIp
 * @param {object} options
 * @param {boolean} options.share the rider asked for a link
 * @param {number} options.retentionDays how long a route that is only saved stays
 * @param {number} options.dailyBudgetBytes new bytes accepted per rolling 24 h
 * @param {number} options.maxBytes cap on the database's live data
 * @returns {Promise<{outcome: 'saved', id: number, shareToken?: string, deleteToken?: string}
 *   |{outcome: 'over_budget'}|{outcome: 'full'}>}
 */
async function storeUpload(route, { share, retentionDays, dailyBudgetBytes, maxBytes }) {
  const contentHash = sha256(route.gpxText);
  const shareCredentials = () => {
    const deleteToken = newToken();
    return { shareToken: newToken(), deleteToken, deleteTokenHash: sha256(deleteToken) };
  };

  const existing = await findRouteByContentHash(contentHash, { unsharedOnly: share });
  if (existing && !share) return { outcome: 'saved', id: existing.id };
  if (existing) {
    const { shareToken, deleteToken, deleteTokenHash } = shareCredentials();
    await shareExistingRoute(existing.id, {
      shareToken,
      deleteTokenHash,
      waterPoints: route.waterPoints,
      waypointsCount: route.waypointsCount
    });
    return { outcome: 'saved', id: existing.id, shareToken, deleteToken };
  }

  const fileSize = Buffer.byteLength(route.gpxText, 'utf8');
  const incomingBytes = fileSize + (route.waterPoints ? Buffer.byteLength(JSON.stringify(route.waterPoints), 'utf8') : 0);
  if ((await uploadedBytesLastDay()) + incomingBytes > dailyBudgetBytes) return { outcome: 'over_budget' };
  if (!(await makeRoom(incomingBytes, maxBytes))) return { outcome: 'full' };

  if (!share) {
    const { id } = await insertRoute({ ...route, fileSize, contentHash, retentionDays });
    return { outcome: 'saved', id };
  }
  const { shareToken, deleteToken, deleteTokenHash } = shareCredentials();
  const { id } = await insertRoute({ ...route, fileSize, contentHash, shareToken, deleteTokenHash });
  return { outcome: 'saved', id, shareToken, deleteToken };
}

/**
 * Delete a shared route for whoever holds its delete token.
 * @returns {Promise<'deleted'|'forbidden'|'missing'>}
 */
async function deleteSharedRoute(shareToken, deleteToken) {
  const row = await getShareCredentials(shareToken);
  if (!row) return 'missing';
  // Links shared before delete tokens existed have none, so nothing can match.
  if (!row.deleteTokenHash || typeof deleteToken !== 'string') return 'forbidden';
  if (!safeEqual(sha256(deleteToken), row.deleteTokenHash)) return 'forbidden';
  await deleteRouteById(row.id);
  return 'deleted';
}

module.exports = { storeUpload, deleteSharedRoute };
