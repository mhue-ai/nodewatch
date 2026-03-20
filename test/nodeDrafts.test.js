const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_PORTS_BY_TYPE, inferAssetLabel, buildDraftNodesForWallet } = require('../src/nodeDrafts');

test('inferAssetLabel builds user-facing labels from Timpi NFT metadata', () => {
  assert.equal(inferAssetLabel({ display_name: 'Guardian Founders Edition #77', node_type: 'guardian', token_id: 'asset-77', edition: 'founders' }), 'Guardian Founders Edition #77');
  assert.equal(inferAssetLabel({ node_type: 'guardian', token_id: 'guardian founders edition #7', edition: 'founders' }), 'Guardian FE #7');
  assert.equal(inferAssetLabel({ node_type: 'collector', token_id: 'collector-001', edition: 'regular' }), 'Collector 001');
  assert.equal(inferAssetLabel({ node_type: 'synaptron', token_id: 'synaptron FE Alpha', edition: 'founders' }), 'Synaptron FE Alpha');
});

test('buildDraftNodesForWallet creates only missing NFT-backed drafts with inferred defaults', () => {
  const wallet = { id: 12, address: 'neutaro1wallet' };
  const existingNodes = [
    { name: 'Collector 001', nft_id: 'collector-001' },
    { name: 'Guardian FE #7', nft_id: null }
  ];

  const drafts = buildDraftNodesForWallet({
    wallet,
    existingNodes,
    assets: [
      { token_id: 'collector-001', kind: 'node', node_type: 'collector', edition: 'regular' },
      { token_id: 'guardian founders edition #7', kind: 'node', node_type: 'guardian', edition: 'founders' },
      { token_id: 'synaptron FE Alpha', kind: 'server', node_type: 'synaptron', edition: 'founders' }
    ]
  });

  assert.equal(drafts.length, 2);
  assert.deepEqual(drafts.map((draft) => draft.nft_id), ['guardian founders edition #7', 'synaptron FE Alpha']);
  assert.equal(drafts[0].port, DEFAULT_PORTS_BY_TYPE.guardian);
  assert.equal(drafts[1].port, DEFAULT_PORTS_BY_TYPE.synaptron);
  assert.equal(drafts[0].draft, 1);
  assert.equal(drafts[0].host, '');
  assert.equal(drafts[0].source_wallet_id, wallet.id);
  assert.notEqual(drafts[0].name, drafts[1].name);
});
