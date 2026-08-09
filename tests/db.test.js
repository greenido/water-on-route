const test = require('node:test');
const assert = require('node:assert/strict');

const {
  clampListLimit,
  clampListOffset,
  LIST_ROUTES_DEFAULT_LIMIT,
  LIST_ROUTES_MAX_LIMIT
} = require('../server/pagination');

test('clampListLimit falls back to the default for absent or junk input', () => {
  assert.equal(clampListLimit(undefined), LIST_ROUTES_DEFAULT_LIMIT);
  assert.equal(clampListLimit(null), LIST_ROUTES_DEFAULT_LIMIT);
  assert.equal(clampListLimit(''), LIST_ROUTES_DEFAULT_LIMIT);
  assert.equal(clampListLimit('abc'), LIST_ROUTES_DEFAULT_LIMIT);
  assert.equal(clampListLimit(1.5), LIST_ROUTES_DEFAULT_LIMIT);
});

test('clampListLimit rejects zero and negative page sizes', () => {
  assert.equal(clampListLimit(0), LIST_ROUTES_DEFAULT_LIMIT);
  assert.equal(clampListLimit(-10), LIST_ROUTES_DEFAULT_LIMIT);
});

test('clampListLimit honours a caller-supplied size up to the ceiling', () => {
  assert.equal(clampListLimit(1), 1);
  assert.equal(clampListLimit(50), 50);
  assert.equal(clampListLimit('75'), 75);
  assert.equal(clampListLimit(LIST_ROUTES_MAX_LIMIT), LIST_ROUTES_MAX_LIMIT);
});

test('clampListLimit caps a request that asks for everything', () => {
  assert.equal(clampListLimit(1e9), LIST_ROUTES_MAX_LIMIT);
  assert.equal(clampListLimit(LIST_ROUTES_MAX_LIMIT + 1), LIST_ROUTES_MAX_LIMIT);
});

test('clampListOffset defaults to the first page', () => {
  assert.equal(clampListOffset(undefined), 0);
  assert.equal(clampListOffset('abc'), 0);
  assert.equal(clampListOffset(-5), 0);
  assert.equal(clampListOffset(2.5), 0);
});

test('clampListOffset passes through a valid offset', () => {
  assert.equal(clampListOffset(0), 0);
  assert.equal(clampListOffset(200), 200);
  assert.equal(clampListOffset('400'), 400);
});
