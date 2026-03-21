const test = require('node:test');
const assert = require('node:assert/strict');
const { createChallengeStore } = require('../src/auth');

test('challenge store issues consumable single-use messages', () => {
  let now = Date.parse('2026-03-21T12:00:00.000Z');
  const store = createChallengeStore({ ttlMs: 5_000, now: () => now });

  const issued = store.issue();
  assert.match(issued.message, /Nonce:/);
  assert.equal(store.consume(issued.message).ok, true);

  const replay = store.consume(issued.message);
  assert.equal(replay.ok, false);
  assert.equal(replay.error, 'Unknown challenge');
});

test('challenge store rejects expired or tampered messages', () => {
  let now = Date.parse('2026-03-21T12:00:00.000Z');
  const store = createChallengeStore({ ttlMs: 1_000, now: () => now });

  const issued = store.issue();
  const tampered = `${issued.message}\nExtra: nope`;
  assert.equal(store.consume(tampered).ok, false);

  const expired = store.issue();
  now += 2_000;
  const result = store.consume(expired.message);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Challenge expired');
});
