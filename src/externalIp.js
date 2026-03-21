function normalizeIpCandidate(value) {
  if (value === null || value === undefined) return null;
  let raw = String(value).trim();
  if (!raw) return null;

  try {
    if (/^https?:\/\//i.test(raw)) {
      const parsed = new URL(raw);
      raw = parsed.hostname || raw;
    }
  } catch {}

  raw = raw.replace(/^\[|\]$/g, '').trim();
  if (!raw) return null;

  const ipv4 = raw.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  if (ipv4) return ipv4[0];

  if (/^[a-z0-9.-]+$/i.test(raw) || raw.includes(':')) return raw;
  return null;
}

function extractExternalIp(payload) {
  if (!payload) return null;
  if (typeof payload === 'string') return normalizeIpCandidate(payload);
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const value = extractExternalIp(item);
      if (value) return value;
    }
    return null;
  }
  if (typeof payload === 'object') {
    const directKeys = ['ip', 'ipAddress', 'ip_address', 'query', 'address', 'result'];
    for (const key of directKeys) {
      if (payload[key]) {
        const value = normalizeIpCandidate(payload[key]);
        if (value) return value;
      }
    }
    for (const value of Object.values(payload)) {
      const nested = extractExternalIp(value);
      if (nested) return nested;
    }
  }
  return null;
}

async function discoverExternalIp(fetchImpl = globalThis.fetch) {
  const providers = [
    { url: 'https://api.ipify.org?format=json', parse: async (response) => extractExternalIp(await response.json().catch(() => null)) },
    { url: 'https://api64.ipify.org?format=json', parse: async (response) => extractExternalIp(await response.json().catch(() => null)) },
    { url: 'https://ifconfig.me/all.json', parse: async (response) => extractExternalIp(await response.json().catch(() => null)) },
    { url: 'https://icanhazip.com', parse: async (response) => extractExternalIp(await response.text().catch(() => '')) },
    { url: 'https://checkip.amazonaws.com', parse: async (response) => extractExternalIp(await response.text().catch(() => '')) }
  ];

  const errors = [];
  for (const provider of providers) {
    try {
      const response = await fetchImpl(provider.url, { signal: AbortSignal.timeout(5000) }).catch(() => null);
      if (!response?.ok) {
        errors.push(`${provider.url}: ${response?.status || 'request failed'}`);
        continue;
      }
      const ip = await provider.parse(response);
      if (ip) return { ip, source: provider.url };
      errors.push(`${provider.url}: no ip in response`);
    } catch (error) {
      errors.push(`${provider.url}: ${error.message}`);
    }
  }

  const error = new Error('Unable to determine external IP');
  error.details = errors;
  throw error;
}

module.exports = {
  normalizeIpCandidate,
  extractExternalIp,
  discoverExternalIp
};
