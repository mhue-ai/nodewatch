const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyTimpiNft,
  encodeContractQuery,
  fetchOwnedTimpiNfts,
  enrichWalletIdentity
} = require('../src/timpiIdentity');

test('classifyTimpiNft maps Timpi node/server NFTs', () => {
  assert.deepEqual(classifyTimpiNft('collector-001'), {
    token_id: 'collector-001', kind: 'node', node_type: 'collector', edition: 'regular'
  });
  assert.deepEqual(classifyTimpiNft('guardian founders edition #7'), {
    token_id: 'guardian founders edition #7', kind: 'node', node_type: 'guardian', edition: 'founders'
  });
  assert.deepEqual(classifyTimpiNft('synaptron FE Alpha'), {
    token_id: 'synaptron FE Alpha', kind: 'server', node_type: 'synaptron', edition: 'founders'
  });
  assert.equal(classifyTimpiNft('random-jpeg'), null);
});

test('fetchOwnedTimpiNfts paginates CW721 tokens and filters non-Timpi NFTs', async () => {
  const calls = [];
  const pages = [
    { ok: true, json: async () => ({ data: { tokens: ['collector-a', 'not-timpi', 'synaptron FE x'] } }) },
    { ok: true, json: async () => ({ data: { tokens: [] } }) }
  ];
  const fetchImpl = async (url) => {
    calls.push(url);
    return pages.shift();
  };

  const nfts = await fetchOwnedTimpiNfts('https://lcd.example', 'neutaro1abc', fetchImpl, 'contract123');

  assert.equal(calls.length, 1);
  assert.match(calls[0], /https:\/\/lcd\.example\/cosmwasm\/wasm\/v1\/contract\/contract123\/smart\//);
  const encoded = calls[0].split('/smart/')[1];
  const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  assert.deepEqual(decoded, { tokens: { owner: 'neutaro1abc', limit: 30 } });
  assert.deepEqual(nfts, [
    { token_id: 'collector-a', kind: 'node', node_type: 'collector', edition: 'regular' },
    { token_id: 'synaptron FE x', kind: 'server', node_type: 'synaptron', edition: 'founders' }
  ]);
});

test('enrichWalletIdentity aggregates delegation amount and nft lists', async () => {
  const lcdFetch = async () => ({
    delegation_responses: [
      { balance: { amount: '123' } },
      { balance: { amount: '456' } }
    ]
  });
  const fetchImpl = async () => ({ ok: true, json: async () => ({ data: { tokens: ['collector-a', 'synaptron FE x'] } }) });

  const enriched = await enrichWalletIdentity({
    lcdFetch,
    lcdBaseUrl: 'https://lcd.example',
    address: 'neutaro1xyz',
    fetchImpl,
    nftContract: 'contract123'
  });

  assert.equal(enriched.delegated_amount, '579');
  assert.equal(enriched.timpi_node_nfts.length, 1);
  assert.equal(enriched.timpi_server_nfts.length, 1);
  assert.equal(enriched.address, 'neutaro1xyz');
  assert.ok(enriched.timpi_identity_refreshed_at);
});

test('encodeContractQuery returns base64 json payload', () => {
  const encoded = encodeContractQuery({ tokens: { owner: 'abc' } });
  assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')), { tokens: { owner: 'abc' } });
});
