const DEFAULT_NFT_CONTRACT = process.env.TIMPI_NFT_CONTRACT || 'neutaro14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s9z4e5z';

function encodeContractQuery(query) {
  return Buffer.from(JSON.stringify(query), 'utf8').toString('base64');
}

function flattenMetadataStrings(value, output = []) {
  if (value === null || value === undefined) return output;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    output.push(String(value));
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) flattenMetadataStrings(item, output);
    return output;
  }
  if (typeof value === 'object') {
    for (const nested of Object.values(value)) flattenMetadataStrings(nested, output);
  }
  return output;
}

function flattenMetadataEntries(value, output = []) {
  if (value === null || value === undefined) return output;
  if (Array.isArray(value)) {
    for (const item of value) flattenMetadataEntries(item, output);
    return output;
  }
  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      output.push([String(key), nested]);
      flattenMetadataEntries(nested, output);
    }
  }
  return output;
}

function firstMetadataMatch(metadata, patterns = []) {
  const normalizedPatterns = patterns.map((pattern) => String(pattern).toLowerCase().replace(/[^a-z0-9]/g, ''));
  for (const [key, value] of flattenMetadataEntries(metadata)) {
    const hay = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!normalizedPatterns.some((pattern) => hay === pattern)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      const out = String(value).trim();
      if (out) return out;
    }
  }
  return null;
}

function classifyTimpiNft(tokenId, metadata = null) {
  const fields = flattenMetadataStrings([tokenId, metadata]).join(' | ').toLowerCase();
  const isFoundersEdition = fields.includes('founders edition') || fields.includes('founders_edition') || fields.includes('fe ');

  if (fields.includes('collector')) return { token_id: tokenId, kind: 'node', node_type: 'collector', edition: isFoundersEdition ? 'founders' : 'regular' };
  if (fields.includes('guardian')) return { token_id: tokenId, kind: 'node', node_type: 'guardian', edition: isFoundersEdition ? 'founders' : 'regular' };
  if (fields.includes('synaptron')) return { token_id: tokenId, kind: 'server', node_type: 'synaptron', edition: isFoundersEdition ? 'founders' : 'regular' };
  if (fields.includes('geocore') || fields.includes('geo core')) return { token_id: tokenId, kind: 'node', node_type: 'geocore', edition: isFoundersEdition ? 'founders' : 'regular' };

  return null;
}

async function fetchDelegatedAmount(lcdFetch, address) {
  const data = await lcdFetch(`/cosmos/staking/v1beta1/delegations/${address}`).catch(() => ({ delegation_responses: [] }));
  return (data.delegation_responses || []).reduce((sum, delegation) => {
    return sum + BigInt(delegation?.balance?.amount || '0');
  }, 0n).toString();
}

async function queryContractSmart(lcdBaseUrl, nftContract, query, fetchImpl = globalThis.fetch) {
  const encoded = encodeContractQuery(query);
  const response = await fetchImpl(`${lcdBaseUrl}/cosmwasm/wasm/v1/contract/${nftContract}/smart/${encoded}`, {
    signal: AbortSignal.timeout(15000)
  }).catch(() => null);
  if (!response || !response.ok) return null;
  const data = await response.json().catch(() => ({}));
  return data?.data ?? null;
}

async function fetchJsonUrl(url, fetchImpl = globalThis.fetch) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(15000) }).catch(() => null);
  if (!response || !response.ok) return null;
  return response.json().catch(() => null);
}

async function fetchTokenMetadata(lcdBaseUrl, nftContract, tokenId, fetchImpl = globalThis.fetch) {
  const allInfo = await queryContractSmart(lcdBaseUrl, nftContract, { all_nft_info: { token_id: tokenId } }, fetchImpl);
  if (allInfo) return allInfo;
  const nftInfo = await queryContractSmart(lcdBaseUrl, nftContract, { nft_info: { token_id: tokenId } }, fetchImpl);
  return nftInfo || null;
}

async function enrichTokenMetadata(metadata, fetchImpl = globalThis.fetch) {
  const tokenUri = metadata?.info?.token_uri || metadata?.token_uri || null;
  const remote = await fetchJsonUrl(tokenUri, fetchImpl);
  if (!remote) return metadata;
  return {
    ...(metadata || {}),
    remote_metadata: remote,
    merged_extension: {
      ...(remote || {}),
      ...(metadata?.info?.extension || metadata?.extension || {})
    }
  };
}

function normalizeTimpiNft(tokenId, metadata = null) {
  const classified = classifyTimpiNft(tokenId, metadata);
  if (!classified) return null;

  const extension = metadata?.merged_extension || metadata?.info?.extension || metadata?.extension || metadata?.remote_metadata || null;
  const tokenUri = metadata?.info?.token_uri || metadata?.token_uri || null;
  const displayName = extension?.name || metadata?.info?.name || metadata?.name || tokenId;
  const description = extension?.description || metadata?.description || null;
  const guid = firstMetadataMatch(extension || metadata, ['guid', 'node_guid', 'server_guid', 'machine_guid']);
  const host = firstMetadataMatch(extension || metadata, ['host', 'hostname', 'ip', 'address', 'endpoint', 'url']);
  const portRaw = firstMetadataMatch(extension || metadata, ['port']);
  const port = portRaw && /^\d+$/.test(String(portRaw).trim()) ? parseInt(String(portRaw).trim(), 10) : null;

  return {
    ...classified,
    display_name: displayName,
    description,
    token_uri: tokenUri,
    metadata: extension || metadata || null,
    guid: guid || null,
    host: host || null,
    port: port || null
  };
}

async function fetchOwnedTimpiNfts(lcdBaseUrl, address, fetchImpl = globalThis.fetch, nftContract = DEFAULT_NFT_CONTRACT) {
  const discovered = [];
  let startAfter = null;

  for (let page = 0; page < 10; page += 1) {
    const query = startAfter
      ? { tokens: { owner: address, limit: 30, start_after: startAfter } }
      : { tokens: { owner: address, limit: 30 } };

    const tokenData = await queryContractSmart(lcdBaseUrl, nftContract, query, fetchImpl);
    const tokens = tokenData?.tokens || [];
    if (!tokens.length) break;

    for (const tokenId of tokens) {
      const rawMetadata = await fetchTokenMetadata(lcdBaseUrl, nftContract, tokenId, fetchImpl).catch(() => null);
      const metadata = await enrichTokenMetadata(rawMetadata, fetchImpl).catch(() => rawMetadata);
      const nft = normalizeTimpiNft(tokenId, metadata);
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
  queryContractSmart,
  fetchJsonUrl,
  fetchTokenMetadata,
  enrichTokenMetadata,
  normalizeTimpiNft,
  fetchOwnedTimpiNfts,
  enrichWalletIdentity
};
