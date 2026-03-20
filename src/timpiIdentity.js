const DEFAULT_NFT_CONTRACT = process.env.TIMPI_NFT_CONTRACT || 'neutaro14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s9z4e5z';

function encodeContractQuery(query) {
  return Buffer.from(JSON.stringify(query), 'utf8').toString('base64');
}

function classifyTimpiNft(tokenId) {
  const id = String(tokenId || '').toLowerCase();
  const isFoundersEdition = id.includes('founders edition') || id.includes('founders_edition') || id.includes('fe ');

  if (id.startsWith('collector')) return { token_id: tokenId, kind: 'node', node_type: 'collector', edition: isFoundersEdition ? 'founders' : 'regular' };
  if (id.startsWith('guardian')) return { token_id: tokenId, kind: 'node', node_type: 'guardian', edition: isFoundersEdition ? 'founders' : 'regular' };
  if (id.startsWith('synaptron')) return { token_id: tokenId, kind: 'server', node_type: 'synaptron', edition: isFoundersEdition ? 'founders' : 'regular' };
  if (id.startsWith('geocore')) return { token_id: tokenId, kind: 'node', node_type: 'geocore', edition: isFoundersEdition ? 'founders' : 'regular' };

  return null;
}

async function fetchDelegatedAmount(lcdFetch, address) {
  const data = await lcdFetch(`/cosmos/staking/v1beta1/delegations/${address}`).catch(() => ({ delegation_responses: [] }));
  return (data.delegation_responses || []).reduce((sum, delegation) => {
    return sum + BigInt(delegation?.balance?.amount || '0');
  }, 0n).toString();
}

async function fetchOwnedTimpiNfts(lcdBaseUrl, address, fetchImpl = globalThis.fetch, nftContract = DEFAULT_NFT_CONTRACT) {
  const discovered = [];
  let startAfter = null;

  for (let page = 0; page < 10; page += 1) {
    const query = startAfter
      ? { tokens: { owner: address, limit: 30, start_after: startAfter } }
      : { tokens: { owner: address, limit: 30 } };
    const encoded = encodeContractQuery(query);
    const response = await fetchImpl(`${lcdBaseUrl}/cosmwasm/wasm/v1/contract/${nftContract}/smart/${encoded}`, {
      signal: AbortSignal.timeout(15000)
    }).catch(() => null);

    if (!response || !response.ok) break;

    const data = await response.json().catch(() => ({}));
    const tokens = data?.data?.tokens || [];
    if (!tokens.length) break;

    for (const tokenId of tokens) {
      const nft = classifyTimpiNft(tokenId);
      if (nft) discovered.push(nft);
    }

    startAfter = tokens[tokens.length - 1];
    if (tokens.length < 30) break;
  }

  return discovered;
}

async function enrichWalletIdentity({ lcdFetch, lcdBaseUrl, address, fetchImpl = globalThis.fetch, nftContract = DEFAULT_NFT_CONTRACT }) {
  const [delegated_amount, timpi_nfts] = await Promise.all([
    fetchDelegatedAmount(lcdFetch, address),
    fetchOwnedTimpiNfts(lcdBaseUrl, address, fetchImpl, nftContract)
  ]);

  return {
    address,
    delegated_amount,
    timpi_nfts,
    timpi_node_nfts: timpi_nfts.filter((nft) => nft.kind === 'node'),
    timpi_server_nfts: timpi_nfts.filter((nft) => nft.kind === 'server'),
    timpi_identity_refreshed_at: new Date().toISOString()
  };
}

module.exports = {
  DEFAULT_NFT_CONTRACT,
  encodeContractQuery,
  classifyTimpiNft,
  fetchDelegatedAmount,
  fetchOwnedTimpiNfts,
  enrichWalletIdentity
};
