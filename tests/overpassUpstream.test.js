const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_FALLBACK_URLS,
  DEFAULT_USER_AGENT,
  RESPONSE_TOO_LARGE,
  overpassBodyFailure,
  parseFallbackUrls,
  queryUpstreams
} = require('../server/overpassUpstream');

const PRIMARY = 'https://primary.example.com/api/interpreter';
const MIRROR = 'https://mirror.example.com/api/interpreter';
const SPARE = 'https://spare.example.com/api/interpreter';

const reply = (status, body = '') => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (name) => (name === 'content-type' ? 'text/xml' : null) },
  text: async () => body
});

/** A fetch that answers per URL: a status, or 'hang' to wait until aborted. */
function fakeFetch(plan) {
  const calls = [];
  const fetchImpl = (url, options) => {
    calls.push({ url, options });
    const answer = plan[url];
    if (answer === 'hang') {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    }
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(reply(answer, `<osm from="${url}"/>`));
  };
  return { fetchImpl, calls };
}

const run = (fetchImpl, overrides = {}) => queryUpstreams({
  urls: [PRIMARY, MIRROR],
  body: 'data=q',
  userAgent: DEFAULT_USER_AGENT,
  attemptTimeoutMs: 1000,
  totalTimeoutMs: 2000,
  fetchImpl,
  readBody: async (response) => Buffer.from(await response.text()),
  ...overrides
});

test('a healthy primary answers and the mirror is never asked', async () => {
  const { fetchImpl, calls } = fakeFetch({ [PRIMARY]: 200, [MIRROR]: 200 });
  const result = await run(fetchImpl);
  assert.equal(result.url, PRIMARY);
  assert.equal(result.status, 200);
  assert.equal(result.body.toString(), `<osm from="${PRIMARY}"/>`);
  assert.deepEqual(calls.map((c) => c.url), [PRIMARY]);
});

for (const status of [429, 502, 503, 504]) {
  test(`a ${status} from the primary moves on to the mirror`, async () => {
    const logged = [];
    const { fetchImpl, calls } = fakeFetch({ [PRIMARY]: status, [MIRROR]: 200 });
    const result = await run(fetchImpl, { log: (m) => logged.push(m) });
    assert.equal(result.url, MIRROR);
    assert.equal(result.ok, true);
    assert.deepEqual(calls.map((c) => c.url), [PRIMARY, MIRROR]);
    assert.match(logged[0], new RegExp(`primary.example.com answered ${status}; trying mirror.example.com`));
  });
}

test('a 400 is the real answer and is not asked again elsewhere', async () => {
  const { fetchImpl, calls } = fakeFetch({ [PRIMARY]: 400, [MIRROR]: 200 });
  const result = await run(fetchImpl);
  assert.equal(result.status, 400);
  assert.deepEqual(calls.map((c) => c.url), [PRIMARY]);
});

test('a network failure at the primary moves on to the mirror', async () => {
  const { fetchImpl } = fakeFetch({ [PRIMARY]: new Error('ECONNRESET'), [MIRROR]: 200 });
  assert.equal((await run(fetchImpl)).url, MIRROR);
});

test('a primary stuck in its queue is cut off so the mirror still has time', async () => {
  const { fetchImpl } = fakeFetch({ [PRIMARY]: 'hang', [MIRROR]: 200 });
  const started = Date.now();
  const result = await run(fetchImpl, { attemptTimeoutMs: 30, totalTimeoutMs: 1000 });
  assert.equal(result.url, MIRROR);
  assert.ok(Date.now() - started < 500, 'gave up on the primary at the attempt cap, not the total budget');
});

test('the last upstream gets the rest of the budget, not just the attempt cap', async () => {
  // Only one upstream: it must be allowed the whole budget, as before fallbacks.
  let abortedAfter = null;
  const started = Date.now();
  const fetchImpl = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      abortedAfter = Date.now() - started;
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
  });
  await assert.rejects(run(fetchImpl, { urls: [PRIMARY], attemptTimeoutMs: 10, totalTimeoutMs: 120 }), { name: 'AbortError' });
  assert.ok(abortedAfter >= 100, `aborted after ${abortedAfter} ms`);
});

test('when every upstream is busy the last busy answer comes back', async () => {
  const { fetchImpl, calls } = fakeFetch({ [PRIMARY]: 502, [MIRROR]: 429 });
  const result = await run(fetchImpl);
  assert.equal(result.status, 429);
  assert.equal(result.ok, false);
  assert.equal(calls.length, 2);
});

test('a busy answer outranks a later timeout, so the client sees why', async () => {
  const { fetchImpl } = fakeFetch({ [PRIMARY]: 502, [MIRROR]: 'hang' });
  const result = await run(fetchImpl, { attemptTimeoutMs: 20, totalTimeoutMs: 60 });
  assert.equal(result.status, 502);
});

test('when nothing answers at all the timeout surfaces as an AbortError', async () => {
  const { fetchImpl } = fakeFetch({ [PRIMARY]: 'hang', [MIRROR]: 'hang' });
  await assert.rejects(run(fetchImpl, { attemptTimeoutMs: 20, totalTimeoutMs: 60 }), { name: 'AbortError' });
});

test('upstreams past the total budget are not tried', async () => {
  let clock = 0;
  const { fetchImpl, calls } = fakeFetch({ [PRIMARY]: 504, [MIRROR]: 200, [SPARE]: 200 });
  const slowFetch = async (url, options) => {
    clock += 1000; // each attempt "takes" a second
    return fetchImpl(url, options);
  };
  const result = await run(slowFetch, { urls: [PRIMARY, MIRROR, SPARE], totalTimeoutMs: 1000, now: () => clock });
  assert.equal(result.status, 504, 'the budget ran out after the primary');
  assert.deepEqual(calls.map((c) => c.url), [PRIMARY]);
});

test('every request identifies the app and posts the query form-encoded', async () => {
  const { fetchImpl, calls } = fakeFetch({ [PRIMARY]: 502, [MIRROR]: 200 });
  await run(fetchImpl);
  for (const { options } of calls) {
    assert.equal(options.method, 'POST');
    assert.equal(options.body, 'data=q');
    assert.equal(options.headers['User-Agent'], DEFAULT_USER_AGENT);
    assert.match(options.headers['Content-Type'], /^application\/x-www-form-urlencoded/);
  }
  // overpass-api.de answers 406 to generic agents such as "node" and "curl/…".
  assert.match(DEFAULT_USER_AGENT, /^water-on-route\/\S+ \(\+https:\/\//);
});

test('parseFallbackUrls: unset means the defaults, empty means none', () => {
  assert.deepEqual(parseFallbackUrls(undefined), [...DEFAULT_FALLBACK_URLS]);
  assert.deepEqual(parseFallbackUrls(''), []);
  assert.deepEqual(parseFallbackUrls(' '), []);
});

test('parseFallbackUrls keeps http(s) URLs in order and drops anything else', () => {
  assert.deepEqual(
    parseFallbackUrls(`${MIRROR}, ftp://nope.example.com, not a url,${SPARE} `),
    [MIRROR, SPARE]
  );
});

const REMARK = '<?xml version="1.0"?><osm version="0.6"><remark> runtime error: Query timed out in "query" at line 3 after 26 seconds. </remark></osm>';
const fetchWithBodies = (bodies) => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return reply(200, bodies[url]);
  };
  return { fetchImpl, calls };
};

test('overpassBodyFailure spots a timeout reported inside a 200', () => {
  assert.match(overpassBodyFailure(Buffer.from(REMARK)), /runtime error/);
  assert.match(overpassBodyFailure(Buffer.from('<html>busy</html>')), /other than OSM/);
  assert.equal(overpassBodyFailure(Buffer.from('<?xml version="1.0"?><osm version="0.6"><node id="1"/></osm>')), null);
  // Other remarks are informational, not failures.
  assert.equal(overpassBodyFailure(Buffer.from('<osm><remark>note</remark></osm>')), null);
});

test('overpassBodyFailure finds the remark after a large partial answer', () => {
  const big = `<osm>${'<node id="1"/>'.repeat(100000)}<remark> runtime error: out of memory </remark></osm>`;
  assert.match(overpassBodyFailure(Buffer.from(big)), /runtime error/);
});

test('a 200 reporting a runtime error moves on to the mirror', async () => {
  const good = '<osm version="0.6"><node id="1"/></osm>';
  const { fetchImpl, calls } = fetchWithBodies({ [PRIMARY]: REMARK, [MIRROR]: good });
  const result = await run(fetchImpl);
  assert.deepEqual(calls, [PRIMARY, MIRROR]);
  assert.equal(result.status, 200);
  assert.equal(result.body.toString(), good);
});

test('when every upstream reports a runtime error the answer is a 504, not a 200', async () => {
  // Regression: passed along as a 200, this read as "no water here" and was
  // cached for hours.
  const { fetchImpl } = fetchWithBodies({ [PRIMARY]: REMARK, [MIRROR]: REMARK });
  const result = await run(fetchImpl);
  assert.equal(result.status, 504);
  assert.equal(result.ok, false);
});

test('an answer over the size limit is final: the mirror has the same data', async () => {
  const { fetchImpl, calls } = fakeFetch({ [PRIMARY]: 200, [MIRROR]: 200 });
  const readBody = async () => {
    throw Object.assign(new Error('too big'), { code: RESPONSE_TOO_LARGE });
  };
  await assert.rejects(run(fetchImpl, { readBody }), { code: RESPONSE_TOO_LARGE });
  assert.deepEqual(calls.map((c) => c.url), [PRIMARY]);
});
