/**
 * Paging helpers.
 *
 * Kept apart from db.js so they can be tested without loading the sqlite3
 * native binding.
 */

const LIST_ROUTES_DEFAULT_LIMIT = 200;
const LIST_ROUTES_MAX_LIMIT = 1000;

/**
 * Coerce a client-supplied page size into a safe integer.
 * @param {unknown} value
 * @returns {number} between 1 and LIST_ROUTES_MAX_LIMIT
 */
function clampListLimit(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return LIST_ROUTES_DEFAULT_LIMIT;
  return Math.min(parsed, LIST_ROUTES_MAX_LIMIT);
}

/**
 * Coerce a client-supplied offset into a non-negative integer.
 * @param {unknown} value
 * @returns {number}
 */
function clampListOffset(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return 0;
  return parsed;
}

module.exports = {
  clampListLimit,
  clampListOffset,
  LIST_ROUTES_DEFAULT_LIMIT,
  LIST_ROUTES_MAX_LIMIT
};
