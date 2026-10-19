/**
 * Overpass upstreams: the primary, then fallbacks when it is busy.
 *
 * The public endpoint queues requests when it is full: on 2026-10-19 even a
 * one-node query took 27–47 s at overpass-api.de, and some answers were a 502
 * "server is currently at capacity". The maps.mail.ru mirror answered the same
 * query in ~17 s. One slow upstream should not fail a search that a second one
 * can answer.
 *
 * Only "busy" answers and network failures or timeouts move on to the next
 * upstream. Anything else, such as a 400 for a bad query, is the real answer
 * and comes back as is: asking a mirror the same bad question gets the same
 * reply, just later.
 *
 * Requests carry an identifying User-Agent. The Overpass usage policy asks for
 * one, and overpass-api.de answers some generic agents (`node`, `curl/…`)
 * with 406.
 */

/** Statuses that mean "try somewhere else", not "this query is wrong". */
const BUSY_STATUSES = Object.freeze(new Set([429, 502, 503, 504]));

const DEFAULT_FALLBACK_URLS = Object.freeze(['https://maps.mail.ru/osm/tools/overpass/api/interpreter']);

const DEFAULT_USER_AGENT = 'water-on-route/1.0 (+https://github.com/greenido/water-on-route)';

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

/**
 * Parse OVERPASS_FALLBACK_URLS. Unset means the defaults; set to an empty
 * string means no fallbacks at all (for a local Overpass you trust).
 * Anything that is not an http(s) URL is dropped rather than fetched.
 *
 * @param {string|undefined} value comma-separated URLs
 * @returns {string[]}
 */
function parseFallbackUrls(value) {
  if (value === undefined) return [...DEFAULT_FALLBACK_URLS];
  return String(value)
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && isHttpUrl(part));
}

const hostOf = (url) => {
  try { return new URL(url).host; } catch (_) { return url; }
};

/**
 * POST one Overpass query to each upstream in turn until one answers.
 *
 * Every attempt but the last is capped at attemptTimeoutMs, so a primary that
 * is stuck in its queue leaves the fallback time to answer. The last attempt
 * gets whatever is left of totalTimeoutMs. With a single upstream that is the
 * whole budget, which is how the proxy behaved before fallbacks existed.
 *
 * @param {object} options
 * @param {string[]} options.urls primary first, then fallbacks
 * @param {string} options.body form-encoded `data=…`
 * @param {string} options.userAgent
 * @param {number} options.attemptTimeoutMs cap for each attempt but the last
 * @param {number} options.totalTimeoutMs budget across all attempts
 * @param {Function} options.fetchImpl fetch-compatible function
 * @param {(response: object) => Promise<Buffer>} options.readBody bounded body reader
 * @param {() => number} [options.now]
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<{url: string, status: number, ok: boolean, body: Buffer, contentType: string|null}>}
 *   the first non-busy answer, or the last busy one if every upstream was busy
 * @throws the last network error or timeout (name 'AbortError') when no upstream answered at all
 */
async function queryUpstreams({
  urls,
  body,
  userAgent,
  attemptTimeoutMs,
  totalTimeoutMs,
  fetchImpl,
  readBody,
  now = Date.now,
  log
}) {
  const deadline = now() + totalTimeoutMs;
  let lastBusy = null;
  let lastError = null;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const remaining = deadline - now();
    if (remaining <= 0) break;
    const isLast = i === urls.length - 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), isLast ? remaining : Math.min(attemptTimeoutMs, remaining));
    let outcome;
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'User-Agent': userAgent
        },
        body,
        signal: controller.signal
      });
      const result = {
        url,
        status: response.status,
        ok: response.ok,
        body: await readBody(response),
        contentType: response.headers.get('content-type')
      };
      if (!BUSY_STATUSES.has(result.status)) return result;
      lastBusy = result;
      outcome = `answered ${result.status}`;
    } catch (err) {
      lastError = err;
      outcome = err && err.name === 'AbortError' ? 'timed out' : `failed (${err && err.message})`;
    } finally {
      clearTimeout(timer);
    }
    if (!isLast && log) log(`[overpass] ${hostOf(url)} ${outcome}; trying ${hostOf(urls[i + 1])}`);
  }

  if (lastBusy) return lastBusy;
  throw lastError || Object.assign(new Error('Overpass upstreams timed out'), { name: 'AbortError' });
}

module.exports = {
  BUSY_STATUSES,
  DEFAULT_FALLBACK_URLS,
  DEFAULT_USER_AGENT,
  parseFallbackUrls,
  queryUpstreams
};
