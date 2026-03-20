const DEFAULT_PORTS_BY_TYPE = {
  guardian: 4005,
  synaptron: 5005,
  collector: 37566,
  geocore: 4013
};

function titleCase(value = '') {
  return String(value)
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function inferAssetLabel(asset) {
  const preferredName = String(asset?.display_name || '').trim();
  if (preferredName) return preferredName;

  const typeLabel = titleCase(asset?.node_type || asset?.kind || 'Timpi Asset');
  const editionLabel = asset?.edition === 'founders' ? ' FE' : '';
  const tokenId = String(asset?.token_id || '').trim();
  if (!tokenId) return `${typeLabel}${editionLabel}`.trim();

  const compactToken = tokenId
    .replace(/^collector[-_\s]*/i, '')
    .replace(/^guardian[-_\s]*/i, '')
    .replace(/^synaptron[-_\s]*/i, '')
    .replace(/^geocore[-_\s]*/i, '')
    .replace(/^founders edition[-_\s]*/i, '')
    .replace(/^fe[-_\s]*/i, '')
    .trim();

  return `${typeLabel}${editionLabel}${compactToken ? ` ${compactToken}` : ''}`.trim();
}

function slugKey(value = '') {
  return String(value).trim().toLowerCase();
}

function nextUniqueName(baseName, existingNames = new Set()) {
  if (!existingNames.has(slugKey(baseName))) {
    existingNames.add(slugKey(baseName));
    return baseName;
  }

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${baseName} ${index}`;
    if (!existingNames.has(slugKey(candidate))) {
      existingNames.add(slugKey(candidate));
      return candidate;
    }
  }

  const fallback = `${baseName} ${Date.now()}`;
  existingNames.add(slugKey(fallback));
  return fallback;
}

function normalizeExistingNftIds(existingNodes = []) {
  return new Set(
    existingNodes
      .map((node) => String(node?.nft_id || '').trim())
      .filter(Boolean)
      .map(slugKey)
  );
}

function buildDraftNodesForWallet({ wallet, assets = [], existingNodes = [] }) {
  const existingNftIds = normalizeExistingNftIds(existingNodes);
  const existingNames = new Set(existingNodes.map((node) => slugKey(node?.name || '')).filter(Boolean));
  const drafts = [];

  for (const asset of assets) {
    const nftId = String(asset?.token_id || '').trim();
    if (!nftId || existingNftIds.has(slugKey(nftId))) continue;

    const type = String(asset?.node_type || '').trim().toLowerCase();
    if (!type || !DEFAULT_PORTS_BY_TYPE[type]) continue;

    const baseName = inferAssetLabel(asset);
    const inferredHost = String(asset?.host || '').trim();
    const inferredGuid = String(asset?.guid || '').trim();
    const inferredPort = Number.isInteger(asset?.port) ? asset.port : DEFAULT_PORTS_BY_TYPE[type];

    drafts.push({
      name: nextUniqueName(baseName, existingNames),
      type,
      nft_id: nftId,
      guid: inferredGuid || null,
      host: inferredHost,
      port: inferredPort,
      docker_name: '-',
      draft: 1,
      source_wallet_id: wallet?.id || null,
      asset_kind: asset?.kind || null,
      inferred_from_wallet: wallet?.address || null,
      edition: asset?.edition || 'regular'
    });
    existingNftIds.add(slugKey(nftId));
  }

  return drafts;
}

module.exports = {
  DEFAULT_PORTS_BY_TYPE,
  inferAssetLabel,
  buildDraftNodesForWallet
};
