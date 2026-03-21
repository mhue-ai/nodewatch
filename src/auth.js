const crypto = require('crypto');

const DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1000;

function createChallengeStore({ ttlMs = DEFAULT_CHALLENGE_TTL_MS, now = () => Date.now() } = {}) {
  const challenges = new Map();

  function issue() {
    const nonce = crypto.randomBytes(32).toString('hex');
    const issuedAt = now();
    const expiresAt = issuedAt + ttlMs;
    const timestamp = new Date(issuedAt).toISOString();
    const message = `Sign this message to authenticate with Timpi NodeWatch.\n\nNonce: ${nonce}\nTimestamp: ${timestamp}`;
    challenges.set(nonce, { nonce, message, issuedAt, expiresAt, used: false });
    return { nonce, message, issued_at: timestamp, expires_at: new Date(expiresAt).toISOString() };
  }

  function consume(message) {
    if (!message || typeof message !== 'string') {
      return { ok: false, error: 'Missing challenge message' };
    }

    const nonceMatch = message.match(/(?:^|\n)Nonce:\s*([a-f0-9]{64})(?:\n|$)/i);
    const timestampMatch = message.match(/(?:^|\n)Timestamp:\s*([^\n]+)(?:\n|$)/i);
    if (!nonceMatch || !timestampMatch) {
      return { ok: false, error: 'Invalid challenge format' };
    }

    const nonce = nonceMatch[1].toLowerCase();
    const entry = challenges.get(nonce);
    if (!entry) return { ok: false, error: 'Unknown challenge' };
    if (entry.used) return { ok: false, error: 'Challenge already used' };
    if (entry.message !== message) return { ok: false, error: 'Challenge mismatch' };
    if (entry.expiresAt < now()) {
      challenges.delete(nonce);
      return { ok: false, error: 'Challenge expired' };
    }

    const parsedTimestamp = Date.parse(timestampMatch[1]);
    if (!Number.isFinite(parsedTimestamp)) {
      return { ok: false, error: 'Invalid challenge timestamp' };
    }

    entry.used = true;
    challenges.delete(nonce);
    return { ok: true, nonce };
  }

  function sweep() {
    const ts = now();
    for (const [nonce, entry] of challenges.entries()) {
      if (entry.expiresAt < ts || entry.used) challenges.delete(nonce);
    }
  }

  return { issue, consume, sweep, size: () => challenges.size };
}

async function verifyKeplrSignature({ address, signature, pub_key, message }) {
  if (!address || !signature || !pub_key || !message) {
    return { ok: false, error: 'Missing fields' };
  }

  try {
    const { verifyADR36Amino } = await import('@cosmjs/amino');
    const { fromBase64 } = await import('@cosmjs/encoding');
    const valid = verifyADR36Amino('neutaro', address, message, fromBase64(pub_key), fromBase64(signature));
    return valid ? { ok: true } : { ok: false, error: 'Invalid signature' };
  } catch (error) {
    console.error('[auth/keplr] verification error', error.message);
    return { ok: false, error: 'Signature verification unavailable' };
  }
}

module.exports = {
  DEFAULT_CHALLENGE_TTL_MS,
  createChallengeStore,
  verifyKeplrSignature
};
