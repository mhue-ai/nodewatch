const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeIpCandidate, extractExternalIp, discoverExternalIp } = require('../src/externalIp');

test('normalizeIpCandidate strips urls and keeps ip/host values', () => {
  assert.equal(normalizeIpCandidate('https://203.0.113.5:4005/status'), '203.0.113.5');
  assert.equal(normalizeIpCandidate('guardian.example.com'), 'guardian.example.com');
  assert.equal(normalizeIpCandidate('[2001:db8::1]'), '2001:db8::1');
});

test('extractExternalIp finds common provider fields', () => {
  assert.equal(extractExternalIp({ ip: '198.51.100.9' }), '198.51.100.9');
  assert.equal(extractExternalIp({ query: '198.51.100.10' }), '198.51.100.10');
  assert.equal(extractExternalIp('198.51.100.11\n'), '198.51.100.11');
});

test('discoverExternalIp falls through providers until one works', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('api.ipify.org')) return { ok: false, status: 503 };
    if (url.includes('api64.ipify.org')) return { ok: true, json: async () => ({ ip: '203.0.113.77' }) };
    throw new Error('unexpected provider');
  };

  const result = await discoverExternalIp(fetchImpl);
  assert.equal(result.ip, '203.0.113.77');
  assert.equal(calls.length, 2);
});
