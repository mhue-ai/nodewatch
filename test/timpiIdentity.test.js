const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyTimpiNft,
  encodeContractQuery,
  fetchOwnedTimpiNfts,
  enrichWalletIdentity,
  normalizeTimpiNft
} = require('../src/timpiIdentity');

test('classifyTimpiNft maps Timpi node/server NFTs from token ids or metadata', () => {
  assert.deepEqual(classifyTimpiNft('collector-001'), {
    token_id: 'collector-001', kind: 'node', node_type: 'collector', edition: 'regular'
  });
  assert.deepEqual(classifyTimpiNft('guardian founders edition #7'), {
    token_id: 'guardian founders edition #7', kind: 'node', node_type: 'guardian', edition: 'founders'
  });
  assert.deepEqual(classifyTimpiNft('asset-77', { extension: { name: 'Synaptron FE Alpha' } }), {
    token_id: 'asset-77', kind: 'server', node_type: 'synaptron', edition: 'founders'
  });
  assert.equal(classifyTimpiNft('random-jpeg'), null);
});

test('normalizeTimpiNft preserves richer display metadata', () => {
  assert.deepEqual(normalizeTimpiNft('asset-77', {
    info: {
      token_uri: 'https://example.com/nft/77.json',
      extension: { name: 'Guardian Founders Edition #77', description: 'special guardian' }
    }
  }), {
    token_id: 'asset-77',
    kind: 'node',
    node_type: 'guardian',
    edition: 'founders',
    display_name: 'Guardian Founders Edition #77',
    description: 'special guardian',
    token_uri: 'https://example.com/nft/77.json',
    metadata: { name: 'Guardian Founders Edition #77', description: 'special guardian' }
  });
});

test('fetchOwnedTimpiNfts paginates CW721 tokens and enriches each token with metadata', async () => {
  const calls = [];
  const responses = new Map([
    ['{"tokens":{"owner":"neutaro1abc","limit":30}}', { tokens: ['collector-a', 'asset-77', 'not-timpi'] }],
    ['{"all_nft_info":{"token_id":"collector-a"}}', { info: { extension: { name: 'Collector A' } } }],
    ['{"all_nft_info":{"token_id":"asset-77"}}', { info: { token_uri: 'https://example.com/77.json', extension: { name: 'Guardian Founders Edition #77', description: 'special guardian' } } }],
    ['{"all_nft_info":{"token_id":"not-timpi"}}', { info: { extension: { name: 'Completely unrelated NFT' } } }]
  ]);
  const fetchImpl = async (url) => {
    calls.push(url);
    const encoded = url.split('/smart/')[1];
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    return { ok: true, json: async () => ({ data: responses.get(decoded) || { tokens: [] } }) };
  };

  const nfts = await fetchOwnedTimpiNfts('https://lcd.example', 'neutaro1abc', fetchImpl, 'contract123');

  assert.equal(calls.length, 4);
  const firstDecoded = Buffer.from(calls[0].split('/smart/')[1], 'base64').toString('utf8');
  assert.equal(firstDecoded, '{"tokens":{"owner":"neutaro1abc","limit":30}}');
  assert.deepEqual(nfts, [
    {
      token_id: 'collector-a', kind: 'node', node_type: 'collector', edition: 'regular',
      display_name: 'Collector A', description: null, token_uri: null, metadata: { name: 'Collector A' }
    },
    {
      token_id: 'asset-77', kind: 'node', node_type: 'guardian', edition: 'founders',
      display_name: 'Guardian Founders Edition #77', description: 'special guardian', token_uri: 'https://example.com/77.json',
      metadata: { name: 'Guardian Founders Edition #77', description: 'special guardian' }
    }
  ]);
});

test('enrichWalletIdentity aggregates delegation amount and nft lists', async () => {
  const lcdFetch = async () => ({
    delegation_responses: [
      { balance: { amount: '123' } },
      { balance: { amount: '456' } }
    ]
  });
  const responses = new Map([
    ['{"tokens":{"owner":"neutaro1xyz","limit":30}}', { tokens: ['collector-a', 'asset-77'] }],
    ['{"all_nft_info":{"token_id":"collector-a"}}', { info: { extension: { name: 'Collector A' } } }],
    ['{"all_nft_info":{"token_id":"asset-77"}}', { info: { extension: { name: 'Synaptron FE X' } } }]
  ]);
  const fetchImpl = async (url) => {
    const encoded = url.split('/smart/')[1];
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    return { ok: true, json: async () => ({ data: responses.get(decoded) || { tokens: [] } }) };
  };

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
  assert.equal(enriched.timpi_node_nfts[0].display_name, 'Collector A');
  assert.equal(enriched.timpi_server_nfts[0].display_name, 'Synaptron FE X');
  assert.equal(enriched.address, 'neutaro1xyz');
  assert.ok(enriched.timpi_identity_refreshed_at);
});

test('encodeContractQuery returns base64 json payload', () => {
  const encoded = encodeContractQuery({ tokens: { owner: 'abc' } });
  assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')), { tokens: { owner: 'abc' } });
});
