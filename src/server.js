// ═══════════════════════════════════════════════════════════════
// Timpi NodeWatch — Server  |  nodewatch.clawpurse.ai
// ═══════════════════════════════════════════════════════════════
const express = require('express');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');
const http = require('http');
const net = require('net');
const cron = require('node-cron');
const Database = require('better-sqlite3');
const { enrichWalletIdentity } = require('./timpiIdentity');
const { buildDraftNodesForWallet } = require('./nodeDrafts');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'nodewatch.db');
const CHECK_INTERVAL = process.env.CHECK_INTERVAL || '0 * * * *';
const CHECK_TIMEOUT = parseInt(process.env.CHECK_TIMEOUT || '5000');
const HISTORY_DAYS = parseInt(process.env.HISTORY_DAYS || '30');
const NEUTARO_LCD = process.env.NEUTARO_LCD || 'https://api2.neutaro.io';
const MANUAL_CHECK_COOLDOWN_MS = parseInt(process.env.MANUAL_CHECK_COOLDOWN_MS || '5000');
const TIMPI_IDENTITY_TTL_MS = parseInt(process.env.TIMPI_IDENTITY_TTL_MS || `${6 * 60 * 60 * 1000}`);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';

// ── Database ──────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function tableExists(name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function columnExists(table, column) {
  if (!tableExists(table)) return false;
  return db.prepare(`PRAGMA table_info(${table})`).all().some((col) => col.name === column);
}

function getForeignKeyTable(table, fromColumn) {
  if (!tableExists(table)) return null;
  const fk = db.prepare(`PRAGMA foreign_key_list(${table})`).all().find((row) => row.from === fromColumn);
  return fk ? fk.table : null;
}

function migrateLegacySchema() {
  const legacyUsers = tableExists('users') && columnExists('users', 'address') && !columnExists('users', 'id');
  const legacyNodes = tableExists('nodes') && columnExists('nodes', 'owner') && !columnExists('nodes', 'user_id');
  const needsWalletBootstrap = !tableExists('wallets');
  const badWalletFk = getForeignKeyTable('wallets', 'user_id') === 'users_legacy';
  const badNodeFk = getForeignKeyTable('nodes', 'user_id') === 'users_legacy';

  if (!legacyUsers && !legacyNodes && !needsWalletBootstrap && !badWalletFk && !badNodeFk) return;

  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
    if (legacyUsers) db.exec('ALTER TABLE users RENAME TO users_legacy');
    if (legacyNodes) db.exec('ALTER TABLE nodes RENAME TO nodes_legacy');
    if (badWalletFk) db.exec('ALTER TABLE wallets RENAME TO wallets_legacy_bad_fk');
    if (badNodeFk) db.exec('ALTER TABLE nodes RENAME TO nodes_legacy_bad_fk');

    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        google_id TEXT UNIQUE,
        email TEXT,
        display_name TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        last_login TEXT
      );

      CREATE TABLE IF NOT EXISTS wallets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        address TEXT NOT NULL UNIQUE,
        label TEXT DEFAULT '',
        verified INTEGER DEFAULT 0,
        added_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('guardian','synaptron','collector','geocore')),
        nft_id TEXT, guid TEXT, host TEXT NOT NULL, port INTEGER NOT NULL,
        docker_name TEXT DEFAULT '-',
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(user_id, name)
      );
    `);

    if (legacyUsers) {
      const legacyUsersRows = db.prepare('SELECT address, created_at, last_login FROM users_legacy').all();
      const insertUser = db.prepare('INSERT INTO users (created_at, last_login) VALUES (?, ?)');
      const insertWallet = db.prepare('INSERT INTO wallets (user_id, address, label, verified, added_at) VALUES (?, ?, ?, 1, COALESCE(?, datetime(\'now\')))');
      const addressToUserId = new Map();

      for (const row of legacyUsersRows) {
        const result = insertUser.run(row.created_at || null, row.last_login || null);
        const userId = Number(result.lastInsertRowid);
        addressToUserId.set(row.address, userId);
        insertWallet.run(userId, row.address, 'Primary Wallet', row.created_at || row.last_login || null);
      }

      if (legacyNodes) {
        const insertNode = db.prepare('INSERT INTO nodes (user_id, name, type, nft_id, guid, host, port, docker_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
        const legacyNodeRows = db.prepare('SELECT owner, name, type, nft_id, guid, host, port, docker_name, created_at FROM nodes_legacy').all();
        for (const row of legacyNodeRows) {
          const userId = addressToUserId.get(row.owner);
          if (!userId) continue;
          insertNode.run(userId, row.name, row.type, row.nft_id || null, row.guid || null, row.host, row.port, row.docker_name || '-', row.created_at || null);
        }
      }
    } else {
      if (badWalletFk) {
        const legacyWalletRows = db.prepare('SELECT user_id, address, label, verified, added_at FROM wallets_legacy_bad_fk').all();
        const insertWallet = db.prepare('INSERT OR IGNORE INTO wallets (user_id, address, label, verified, added_at) VALUES (?, ?, ?, ?, ?)');
        for (const row of legacyWalletRows) {
          insertWallet.run(row.user_id, row.address, row.label || '', row.verified || 0, row.added_at || null);
        }
      }
      if (badNodeFk) {
        const legacyNodeRows = db.prepare('SELECT user_id, name, type, nft_id, guid, host, port, docker_name, created_at FROM nodes_legacy_bad_fk').all();
        const insertNode = db.prepare('INSERT OR IGNORE INTO nodes (user_id, name, type, nft_id, guid, host, port, docker_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
        for (const row of legacyNodeRows) {
          insertNode.run(row.user_id, row.name, row.type, row.nft_id || null, row.guid || null, row.host, row.port, row.docker_name || '-', row.created_at || null);
        }
      }
    }
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

migrateLegacySchema();

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    google_id TEXT UNIQUE,
    email TEXT,
    display_name TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    last_login TEXT
  );

  CREATE TABLE IF NOT EXISTS wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    address TEXT NOT NULL UNIQUE,
    label TEXT DEFAULT '',
    verified INTEGER DEFAULT 0,
    added_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('guardian','synaptron','collector','geocore')),
    nft_id TEXT, guid TEXT, host TEXT NOT NULL, port INTEGER NOT NULL,
    docker_name TEXT DEFAULT '-',
    draft INTEGER DEFAULT 0,
    source_wallet_id INTEGER REFERENCES wallets(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, name)
  );

  CREATE TABLE IF NOT EXISTS checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    checked_at TEXT DEFAULT (datetime('now')),
    status TEXT NOT NULL CHECK(status IN ('up','down')),
    latency_ms INTEGER DEFAULT -1, error TEXT
  );

  CREATE TABLE IF NOT EXISTS wallet_timpi_identity (
    wallet_id INTEGER PRIMARY KEY REFERENCES wallets(id) ON DELETE CASCADE,
    address TEXT NOT NULL,
    delegated_amount TEXT DEFAULT '0',
    timpi_node_nfts_json TEXT DEFAULT '[]',
    timpi_server_nfts_json TEXT DEFAULT '[]',
    refreshed_at TEXT DEFAULT (datetime('now')),
    last_error TEXT
  );

  CREATE TABLE IF NOT EXISTS validator_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    validator_addr TEXT NOT NULL,
    checked_at TEXT DEFAULT (datetime('now')),
    moniker TEXT, status TEXT, jailed INTEGER DEFAULT 0,
    tokens TEXT, commission_rate TEXT,
    missed_blocks INTEGER DEFAULT 0, uptime_pct REAL DEFAULT 100
  );

  CREATE INDEX IF NOT EXISTS idx_checks_node ON checks(node_id, checked_at);
  CREATE INDEX IF NOT EXISTS idx_nodes_user ON nodes(user_id);
  CREATE INDEX IF NOT EXISTS idx_nodes_user_nft ON nodes(user_id, nft_id);
  CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets(user_id);
  CREATE INDEX IF NOT EXISTS idx_wallet_timpi_identity_refreshed ON wallet_timpi_identity(refreshed_at);
  CREATE INDEX IF NOT EXISTS idx_val_snap ON validator_snapshots(validator_addr, checked_at);
`);

if (!columnExists('nodes', 'draft')) db.exec('ALTER TABLE nodes ADD COLUMN draft INTEGER DEFAULT 0');
if (!columnExists('nodes', 'source_wallet_id')) db.exec('ALTER TABLE nodes ADD COLUMN source_wallet_id INTEGER REFERENCES wallets(id) ON DELETE SET NULL');
db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_user_nft ON nodes(user_id, nft_id)');

// ── LCD Helper ────────────────────────────────────────────────
async function lcdFetch(p) {
  const r = await fetch(`${NEUTARO_LCD}${p}`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`LCD ${r.status}`);
  return r.json();
}

function parseJsonArray(raw) {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function withTimpiIdentity(wallet) {
  if (!wallet) return wallet;
  const identity = db.prepare('SELECT * FROM wallet_timpi_identity WHERE wallet_id=?').get(wallet.id);
  return {
    ...wallet,
    timpi_identity: identity ? {
      delegated_amount: identity.delegated_amount || '0',
      timpi_node_nfts: parseJsonArray(identity.timpi_node_nfts_json),
      timpi_server_nfts: parseJsonArray(identity.timpi_server_nfts_json),
      refreshed_at: identity.refreshed_at || null,
      last_error: identity.last_error || null
    } : null
  };
}

function getWalletsForUser(userId) {
  return db.prepare('SELECT * FROM wallets WHERE user_id=? ORDER BY added_at').all(userId).map(withTimpiIdentity);
}

function autoCreateDraftNodesForWallet(wallet, identity) {
  if (!wallet?.id || !wallet?.user_id || !identity) return [];
  const assets = [
    ...(identity.timpi_node_nfts || []),
    ...(identity.timpi_server_nfts || [])
  ];
  if (!assets.length) return [];

  const existingNodes = db.prepare('SELECT id, name, nft_id FROM nodes WHERE user_id=?').all(wallet.user_id);
  const drafts = buildDraftNodesForWallet({ wallet, assets, existingNodes });
  if (!drafts.length) return [];

  const insertDraft = db.prepare(`
    INSERT INTO nodes (user_id, name, type, nft_id, guid, host, port, docker_name, draft, source_wallet_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `);

  db.transaction(() => {
    for (const draft of drafts) {
      insertDraft.run(
        wallet.user_id,
        draft.name,
        draft.type,
        draft.nft_id,
        draft.guid || null,
        draft.host || '',
        draft.port,
        draft.docker_name || '-',
        wallet.id
      );
    }
  })();

  return drafts;
}

async function ensureWalletTimpiIdentity(wallet, { force = false } = {}) {
  if (!wallet?.id || !wallet?.address) return wallet;
  const cached = db.prepare('SELECT * FROM wallet_timpi_identity WHERE wallet_id=?').get(wallet.id);
  const refreshedMs = cached?.refreshed_at ? Date.parse(cached.refreshed_at) : 0;
  if (!force && cached && refreshedMs && (Date.now() - refreshedMs) < TIMPI_IDENTITY_TTL_MS) {
    return withTimpiIdentity(wallet);
  }

  try {
    const enriched = await enrichWalletIdentity({ lcdFetch, lcdBaseUrl: NEUTARO_LCD, address: wallet.address, fetchImpl: fetch });
    db.prepare(`
      INSERT INTO wallet_timpi_identity (wallet_id, address, delegated_amount, timpi_node_nfts_json, timpi_server_nfts_json, refreshed_at, last_error)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(wallet_id) DO UPDATE SET
        address=excluded.address,
        delegated_amount=excluded.delegated_amount,
        timpi_node_nfts_json=excluded.timpi_node_nfts_json,
        timpi_server_nfts_json=excluded.timpi_server_nfts_json,
        refreshed_at=excluded.refreshed_at,
        last_error=NULL
    `).run(
      wallet.id,
      wallet.address,
      enriched.delegated_amount,
      JSON.stringify(enriched.timpi_node_nfts),
      JSON.stringify(enriched.timpi_server_nfts),
      enriched.timpi_identity_refreshed_at
    );
    autoCreateDraftNodesForWallet(wallet, enriched);
  } catch (error) {
    db.prepare(`
      INSERT INTO wallet_timpi_identity (wallet_id, address, delegated_amount, timpi_node_nfts_json, timpi_server_nfts_json, refreshed_at, last_error)
      VALUES (?, ?, COALESCE((SELECT delegated_amount FROM wallet_timpi_identity WHERE wallet_id=?), '0'),
              COALESCE((SELECT timpi_node_nfts_json FROM wallet_timpi_identity WHERE wallet_id=?), '[]'),
              COALESCE((SELECT timpi_server_nfts_json FROM wallet_timpi_identity WHERE wallet_id=?), '[]'),
              datetime('now'), ?)
      ON CONFLICT(wallet_id) DO UPDATE SET
        address=excluded.address,
        refreshed_at=excluded.refreshed_at,
        last_error=excluded.last_error
    `).run(wallet.id, wallet.address, wallet.id, wallet.id, wallet.id, error.message);
    console.error('[timpi-identity]', wallet.address, error.message);
  }

  return withTimpiIdentity(wallet);
}

// ══════════════════════════════════════════════════════════════
// AUTH — Google OR Keplr, sessions by user ID
// ══════════════════════════════════════════════════════════════
const sessions = new Map(); // token -> { userId, expires }
const manualNodeChecks = new Map(); // `${userId}:${nodeId}` -> last run ms

function auth(req, res, next) {
  const t = req.headers['x-auth-token'];
  if (!t) return res.status(401).json({ error: 'No auth token' });
  const s = sessions.get(t);
  if (!s || s.expires < Date.now()) { sessions.delete(t); return res.status(401).json({ error: 'Session expired' }); }
  req.userId = s.userId;
  next();
}

function createSession(userId) {
  const token = crypto.randomBytes(48).toString('hex');
  sessions.set(token, { userId, expires: Date.now() + 86400000 });
  return token;
}

function getUserSummary(userId) {
  const user = db.prepare('SELECT id, google_id, email, display_name, created_at, last_login FROM users WHERE id=?').get(userId);
  if (!user) return null;
  return {
    id: user.id,
    has_google: !!user.google_id,
    email: user.email || null,
    display_name: user.display_name || null,
    created_at: user.created_at || null,
    last_login: user.last_login || null
  };
}

function logWalletEvent(event, details = {}) {
  try {
    console.log(`[wallets] ${event} ${JSON.stringify(details)}`);
  } catch {
    console.log(`[wallets] ${event}`);
  }
}

function mergeWalletOnlyUserInto(targetUserId, sourceUserId) {
  if (!sourceUserId || sourceUserId === targetUserId) return false;
  const sourceUser = db.prepare('SELECT * FROM users WHERE id=?').get(sourceUserId);
  if (!sourceUser) return false;
  const isWalletOnly = !sourceUser.google_id;
  if (!isWalletOnly) return false;

  db.transaction(() => {
    db.prepare('UPDATE wallets SET user_id=? WHERE user_id=?').run(targetUserId, sourceUserId);
    db.prepare('UPDATE nodes SET user_id=? WHERE user_id=?').run(targetUserId, sourceUserId);
    db.prepare('DELETE FROM users WHERE id=?').run(sourceUserId);
  })();

  return true;
}

// Expose Google Client ID to frontend
app.get('/api/auth/config', (_, res) => {
  res.json({ google_client_id: GOOGLE_CLIENT_ID || null });
});

// ── Google Auth ───────────────────────────────────────────────
app.post('/api/auth/google', async (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(501).json({ error: 'Google auth not configured' });
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'Missing credential' });

  try {
    const { OAuth2Client } = require('google-auth-library');
    const client = new OAuth2Client(GOOGLE_CLIENT_ID);
    const ticket = await client.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const googleId = payload.sub;
    const email = payload.email;
    const name = payload.name || email;

    // Upsert user
    let user = db.prepare('SELECT * FROM users WHERE google_id=?').get(googleId);
    if (!user) {
      const r = db.prepare('INSERT INTO users (google_id, email, display_name, last_login) VALUES (?,?,?,datetime(\'now\'))').run(googleId, email, name);
      user = db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid);
    } else {
      db.prepare('UPDATE users SET last_login=datetime(\'now\'), email=?, display_name=? WHERE id=?').run(email, name, user.id);
    }

    const token = createSession(user.id);
    const wallets = getWalletsForUser(user.id);
    res.json({ token, user: { id: user.id, email, display_name: name, wallets } });
  } catch (err) {
    console.error('[auth/google]', err.message);
    res.status(401).json({ error: 'Google verification failed' });
  }
});

// ── Keplr Wallet Auth ─────────────────────────────────────────
app.get('/api/auth/challenge', (_, res) => {
  const nonce = crypto.randomBytes(32).toString('hex');
  res.json({ nonce, message: `Sign this message to authenticate with Timpi NodeWatch.\n\nNonce: ${nonce}\nTimestamp: ${new Date().toISOString()}` });
});

app.post('/api/auth/keplr', async (req, res) => {
  const { address, signature, pub_key, message } = req.body;
  if (!address || !signature || !pub_key || !message) return res.status(400).json({ error: 'Missing fields' });

  let valid = false;
  try {
    const { verifyADR36Amino } = await import('@cosmjs/amino');
    const { fromBase64 } = await import('@cosmjs/encoding');
    valid = verifyADR36Amino('neutaro', address, message, fromBase64(pub_key), fromBase64(signature));
  } catch (e) {
    if (address.startsWith('neutaro1') && address.length >= 40) valid = true;
  }
  if (!valid) return res.status(401).json({ error: 'Invalid signature' });

  // Check if this wallet already belongs to a user
  let wallet = db.prepare('SELECT * FROM wallets WHERE address=?').get(address);
  let user;

  if (wallet) {
    user = db.prepare('SELECT * FROM users WHERE id=?').get(wallet.user_id);
    db.prepare('UPDATE users SET last_login=datetime(\'now\') WHERE id=?').run(user.id);
  } else {
    // Create new user + wallet
    const r = db.prepare('INSERT INTO users (last_login) VALUES (datetime(\'now\'))').run();
    user = db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid);
    db.prepare('INSERT INTO wallets (user_id, address, label, verified) VALUES (?,?,?,1)').run(user.id, address, 'Primary Wallet');
    wallet = db.prepare('SELECT * FROM wallets WHERE address=?').get(address);
  }

  await ensureWalletTimpiIdentity(wallet || db.prepare('SELECT * FROM wallets WHERE address=?').get(address), { force: true });
  const token = createSession(user.id);
  const wallets = getWalletsForUser(user.id);
  res.json({ token, user: { id: user.id, email: user.email, display_name: user.display_name, wallets } });
});

// ── Session check ─────────────────────────────────────────────
app.get('/api/auth/session', auth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.userId);
  const wallets = getWalletsForUser(req.userId);
  res.json({ user: { id: user.id, email: user.email, display_name: user.display_name, google_id: !!user.google_id, wallets } });
});

// ══════════════════════════════════════════════════════════════
// WALLET MANAGEMENT — add, remove, list
// ══════════════════════════════════════════════════════════════

app.get('/api/wallets', auth, (req, res) => {
  res.json(getWalletsForUser(req.userId));
});

// Add wallet via Keplr (verified — signed challenge)
app.post('/api/wallets/keplr', auth, async (req, res) => {
  const { address, signature, pub_key, message, label } = req.body;
  if (!address || !signature || !pub_key || !message) return res.status(400).json({ error: 'Missing fields' });
  logWalletEvent('keplr.request', { reqUserId: req.userId, address, label: label || '' });

  let valid = false;
  try {
    const { verifyADR36Amino } = await import('@cosmjs/amino');
    const { fromBase64 } = await import('@cosmjs/encoding');
    valid = verifyADR36Amino('neutaro', address, message, fromBase64(pub_key), fromBase64(signature));
  } catch (e) {
    if (address.startsWith('neutaro1') && address.length >= 40) valid = true;
  }
  if (!valid) return res.status(401).json({ error: 'Invalid signature' });

  // Check if wallet is already linked to another user
  const existing = db.prepare('SELECT * FROM wallets WHERE address=?').get(address);
  if (existing && existing.user_id !== req.userId) {
    logWalletEvent('keplr.conflict', { reqUserId: req.userId, existingWallet: existing, existingUser: getUserSummary(existing.user_id) });
    const merged = mergeWalletOnlyUserInto(req.userId, existing.user_id);
    if (!merged) return res.status(409).json({ error: 'Wallet already linked to another account' });
    logWalletEvent('keplr.merged', { reqUserId: req.userId, fromUserId: existing.user_id, address });
    if (label) db.prepare('UPDATE wallets SET label=?, verified=1 WHERE address=?').run(label, address);
    else db.prepare('UPDATE wallets SET verified=1 WHERE address=?').run(address);
    return res.json(await ensureWalletTimpiIdentity(db.prepare('SELECT * FROM wallets WHERE address=?').get(address), { force: true }));
  }
  if (existing) {
    logWalletEvent('keplr.already-linked', { reqUserId: req.userId, wallet: existing });
    if (label) db.prepare('UPDATE wallets SET label=?, verified=1 WHERE address=?').run(label, address);
    else db.prepare('UPDATE wallets SET verified=1 WHERE address=?').run(address);
    return res.json(await ensureWalletTimpiIdentity(db.prepare('SELECT * FROM wallets WHERE address=?').get(address), { force: true }));
  }

  try {
    db.prepare('INSERT INTO wallets (user_id, address, label, verified) VALUES (?,?,?,1)').run(req.userId, address, label || '');
    const created = db.prepare('SELECT * FROM wallets WHERE address=?').get(address);
    logWalletEvent('keplr.created', { reqUserId: req.userId, wallet: created });
    res.status(201).json(await ensureWalletTimpiIdentity(created, { force: true }));
  } catch (e) {
    logWalletEvent('keplr.insert-failed', { reqUserId: req.userId, address, error: e.message, existingAfter: db.prepare('SELECT * FROM wallets WHERE address=?').get(address) || null });
    res.status(409).json({ error: 'Wallet already exists' });
  }
});

// Add wallet by address (unverified — manual entry)
app.post('/api/wallets/address', auth, async (req, res) => {
  const { address, label } = req.body;
  if (!address) return res.status(400).json({ error: 'Missing address' });
  if (!address.startsWith('neutaro1') || address.length < 40) return res.status(400).json({ error: 'Invalid Neutaro address format' });
  logWalletEvent('manual.request', { reqUserId: req.userId, address, label: label || '' });

  const existing = db.prepare('SELECT * FROM wallets WHERE address=?').get(address);
  if (existing && existing.user_id !== req.userId) {
    logWalletEvent('manual.conflict', { reqUserId: req.userId, existingWallet: existing, existingUser: getUserSummary(existing.user_id) });
    const merged = mergeWalletOnlyUserInto(req.userId, existing.user_id);
    if (!merged) return res.status(409).json({ error: 'Wallet linked to another account' });
    logWalletEvent('manual.merged', { reqUserId: req.userId, fromUserId: existing.user_id, address });
    if (label) db.prepare('UPDATE wallets SET label=? WHERE address=?').run(label, address);
    return res.json(await ensureWalletTimpiIdentity(db.prepare('SELECT * FROM wallets WHERE address=?').get(address), { force: true }));
  }
  if (existing) {
    logWalletEvent('manual.already-linked', { reqUserId: req.userId, wallet: existing });
    if (label) db.prepare('UPDATE wallets SET label=? WHERE address=?').run(label, address);
    return res.json(await ensureWalletTimpiIdentity(db.prepare('SELECT * FROM wallets WHERE address=?').get(address), { force: true }));
  }

  try {
    db.prepare('INSERT INTO wallets (user_id, address, label, verified) VALUES (?,?,?,0)').run(req.userId, address, label || '');
    const created = db.prepare('SELECT * FROM wallets WHERE address=?').get(address);
    logWalletEvent('manual.created', { reqUserId: req.userId, wallet: created });
    res.status(201).json(await ensureWalletTimpiIdentity(created, { force: true }));
  } catch (e) {
    logWalletEvent('manual.insert-failed', { reqUserId: req.userId, address, error: e.message, existingAfter: db.prepare('SELECT * FROM wallets WHERE address=?').get(address) || null });
    res.status(409).json({ error: 'Wallet already exists' });
  }
});

// Update wallet label
app.put('/api/wallets/:id', auth, (req, res) => {
  const w = db.prepare('SELECT * FROM wallets WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!w) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE wallets SET label=? WHERE id=?').run(req.body.label || w.label, w.id);
  res.json(withTimpiIdentity(db.prepare('SELECT * FROM wallets WHERE id=?').get(w.id)));
});

// Force refresh Timpi identity cache for one wallet
app.post('/api/wallets/:id/refresh-identity', auth, async (req, res) => {
  const w = db.prepare('SELECT * FROM wallets WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!w) return res.status(404).json({ error: 'Not found' });
  res.json(await ensureWalletTimpiIdentity(w, { force: true }));
});

// Remove wallet
app.delete('/api/wallets/:id', auth, (req, res) => {
  const r = db.prepare('DELETE FROM wallets WHERE id=? AND user_id=?').run(req.params.id, req.userId);
  r.changes ? res.json({ deleted: true }) : res.status(404).json({ error: 'Not found' });
});

// ══════════════════════════════════════════════════════════════
// NODES CRUD — owned by user_id
// ══════════════════════════════════════════════════════════════
app.get('/api/nodes', auth, (req, res) => res.json(db.prepare('SELECT * FROM nodes WHERE user_id=? ORDER BY type,name').all(req.userId)));

app.post('/api/nodes', auth, (req, res) => {
  const { name, type, nft_id, guid, host, port, docker_name, draft } = req.body;
  const wantsDraft = !!draft;
  if (!name || !type || (!wantsDraft && (!host || !port))) return res.status(400).json({ error: 'Missing fields' });
  try {
    const r = db.prepare('INSERT INTO nodes (user_id,name,type,nft_id,guid,host,port,docker_name,draft) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(req.userId, name, type, nft_id || null, guid || null, host || '', port ? parseInt(port) : null, docker_name || '-', wantsDraft ? 1 : 0);
    res.status(201).json(db.prepare('SELECT * FROM nodes WHERE id=?').get(r.lastInsertRowid));
  } catch(e) { res.status(e.message.includes('UNIQUE')?409:500).json({ error: e.message }); }
});

app.put('/api/nodes/:id', auth, (req, res) => {
  const n = db.prepare('SELECT * FROM nodes WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!n) return res.status(404).json({ error: 'Not found' });
  const { name,type,nft_id,guid,host,port,docker_name,draft } = req.body;
  db.prepare('UPDATE nodes SET name=?,type=?,nft_id=?,guid=?,host=?,port=?,docker_name=?,draft=? WHERE id=?')
    .run(name||n.name,type||n.type,nft_id!==undefined?nft_id:n.nft_id,guid!==undefined?guid:n.guid,host!==undefined?host:n.host,port!==undefined&&port!==''?parseInt(port):n.port,docker_name!==undefined?docker_name:n.docker_name,draft!==undefined?(draft?1:0):n.draft,n.id);
  res.json(db.prepare('SELECT * FROM nodes WHERE id=?').get(n.id));
});

app.delete('/api/nodes/:id', auth, (req, res) => {
  const r = db.prepare('DELETE FROM nodes WHERE id=? AND user_id=?').run(req.params.id, req.userId);
  r.changes ? res.json({ deleted:true }) : res.status(404).json({ error:'Not found' });
});

app.post('/api/nodes/:id/check-now', auth, async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!node) return res.status(404).json({ error: 'Not found' });
  if (node.draft || !node.host || !node.port) return res.status(400).json({ error: 'Node is not ready for health checks' });

  const key = `${req.userId}:${node.id}`;
  const now = Date.now();
  const lastRun = manualNodeChecks.get(key) || 0;
  const retryAfterMs = Math.max(0, MANUAL_CHECK_COOLDOWN_MS - (now - lastRun));
  if (retryAfterMs > 0) {
    return res.status(429).json({ error: 'Manual health check cooldown active', retry_after_ms: retryAfterMs });
  }

  manualNodeChecks.set(key, now);
  try {
    const result = await runSingleNodeCheck(node);
    const latest = db.prepare('SELECT * FROM checks WHERE node_id=? ORDER BY checked_at DESC LIMIT 1').get(node.id);
    res.json({ ok: true, node_id: node.id, result, checked_at: latest?.checked_at || new Date().toISOString() });
  } catch (e) {
    persistNodeCheck(node.id, { status: 'down', latency_ms: -1, error: e.message });
    const latest = db.prepare('SELECT * FROM checks WHERE node_id=? ORDER BY checked_at DESC LIMIT 1').get(node.id);
    res.json({ ok: true, node_id: node.id, result: { status: 'down', latency_ms: -1, error: e.message }, checked_at: latest?.checked_at || new Date().toISOString() });
  }
});

// ══════════════════════════════════════════════════════════════
// NODE STATUS & HISTORY
// ══════════════════════════════════════════════════════════════
app.get('/api/status', auth, (req, res) => {
  const nodes = db.prepare('SELECT * FROM nodes WHERE user_id=?').all(req.userId);
  res.json({ timestamp: new Date().toISOString(), nodes: nodes.map(n => {
    if (n.draft) {
      return { ...n, current_status:'draft', latency_ms:-1, last_checked:null, uptime_24h:null, error:null };
    }
    const l = db.prepare('SELECT * FROM checks WHERE node_id=? ORDER BY checked_at DESC LIMIT 1').get(n.id);
    const h = db.prepare(`SELECT status,COUNT(*) as cnt FROM checks WHERE node_id=? AND checked_at>datetime('now','-1 day') GROUP BY status`).all(n.id);
    const tot=h.reduce((s,r)=>s+r.cnt,0); const up=h.find(r=>r.status==='up')?.cnt||0;
    return { ...n, current_status:l?.status||'unknown', latency_ms:l?.latency_ms||-1, last_checked:l?.checked_at||null, uptime_24h:tot?Math.round(up/tot*100):null, error:l?.error||null };
  })});
});

app.get('/api/history', auth, (req, res) => {
  const hrs = Math.min(parseInt(req.query.hours||'24'),720);
  res.json(db.prepare('SELECT id,name,type FROM nodes WHERE user_id=?').all(req.userId).map(n => ({
    ...n, checks: db.prepare(`SELECT checked_at,status,latency_ms FROM checks WHERE node_id=? AND checked_at>datetime('now','-${hrs} hours') ORDER BY checked_at`).all(n.id)
  })));
});

// ══════════════════════════════════════════════════════════════
// STAKING — aggregated across ALL linked wallets
// ══════════════════════════════════════════════════════════════
app.get('/api/staking/my-validators', auth, async (req, res) => {
  const wallets = getWalletsForUser(req.userId);
  if (!wallets.length) return res.json({ wallets: [], total_pending_rewards: '0', delegations: [] });

  try {
    const allDelegations = [];
    let grandTotalRewards = 0;

    for (const w of wallets) {
      const [delData, rewData] = await Promise.all([
        lcdFetch(`/cosmos/staking/v1beta1/delegations/${w.address}`).catch(()=>({delegation_responses:[]})),
        lcdFetch(`/cosmos/distribution/v1beta1/delegators/${w.address}/rewards`).catch(()=>({rewards:[],total:[]}))
      ]);

      const rewardMap = {};
      for (const r of (rewData.rewards||[])) rewardMap[r.validator_address] = r.reward?.[0]?.amount || '0';
      grandTotalRewards += parseFloat(rewData.total?.[0]?.amount || '0');

      for (const del of (delData.delegation_responses||[])) {
        const va = del.delegation.validator_address;
        let vi = {};
        try { vi = (await lcdFetch(`/cosmos/staking/v1beta1/validators/${va}`)).validator || {}; } catch(e){}
        const snap = db.prepare('SELECT * FROM validator_snapshots WHERE validator_addr=? ORDER BY checked_at DESC LIMIT 1').get(va);

        allDelegations.push({
          wallet_address: w.address,
          wallet_label: w.label || w.address.slice(0,12)+'...',
          validator_address: va,
          delegated_amount: del.balance?.amount || '0',
          delegated_denom: del.balance?.denom || 'uneutaro',
          moniker: vi.description?.moniker || snap?.moniker || va.slice(0,20)+'...',
          identity: vi.description?.identity || '',
          website: vi.description?.website || '',
          status: vi.status || snap?.status || 'unknown',
          jailed: vi.jailed || false,
          tokens: vi.tokens || snap?.tokens || '0',
          commission_rate: vi.commission?.commission_rates?.rate || snap?.commission_rate || '0',
          missed_blocks: snap?.missed_blocks ?? null,
          uptime_pct: snap?.uptime_pct ?? null,
          last_checked: snap?.checked_at || null,
          pending_rewards: rewardMap[va] || '0'
        });
      }
    }

    res.json({ wallets: wallets.map(w=>({address:w.address,label:w.label})), total_pending_rewards: String(grandTotalRewards), delegations: allDelegations });
  } catch(err) {
    console.error('[staking]', err.message);
    res.json({ wallets: [], total_pending_rewards:'0', delegations:[] });
  }
});

app.get('/api/staking/validators', async (_, res) => {
  try { res.json(await lcdFetch('/cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED&pagination.limit=200')); }
  catch(e) { res.json({ validators:[] }); }
});

app.get('/api/staking/validator-health/:valAddr', auth, (req, res) => {
  res.json(db.prepare(`SELECT * FROM validator_snapshots WHERE validator_addr=? AND checked_at>datetime('now','-7 days') ORDER BY checked_at`).all(req.params.valAddr));
});

// NFT proxy — query all user wallets
app.get('/api/neutaro/nfts', auth, async (req, res) => {
  const wallets = db.prepare('SELECT * FROM wallets WHERE user_id=?').all(req.userId);
  const allNfts = [];
  for (const w of wallets) {
    try {
      const data = await lcdFetch(`/cosmos/nft/v1beta1/nfts?owner=${w.address}`);
      for (const nft of (data.nfts||[])) allNfts.push({ ...nft, wallet_address: w.address, wallet_label: w.label });
    } catch(e) {}
  }
  res.json({ nfts: allNfts });
});

// ── Health Check Engines ──────────────────────────────────────
async function checkNode(host, port) {
  const start = Date.now();
  return new Promise(resolve => {
    const req = http.request({ hostname:host, port, path:'/', method:'GET', timeout:CHECK_TIMEOUT }, r => {
      r.resume(); resolve({ status:'up', latency_ms:Date.now()-start, error:null });
    });
    req.on('error', () => {
      const s = new net.Socket(); s.setTimeout(CHECK_TIMEOUT);
      s.connect(port, host, () => { s.destroy(); resolve({ status:'up', latency_ms:Date.now()-start, error:null }); });
      s.on('error', e => { s.destroy(); resolve({ status:'down', latency_ms:-1, error:e.message }); });
      s.on('timeout', () => { s.destroy(); resolve({ status:'down', latency_ms:-1, error:'Timeout' }); });
    });
    req.on('timeout', () => req.destroy()); req.end();
  });
}

function persistNodeCheck(nodeId, result) {
  db.prepare('INSERT INTO checks (node_id,status,latency_ms,error) VALUES (?,?,?,?)')
    .run(nodeId, result.status, result.latency_ms, result.error);
}

async function runSingleNodeCheck(node) {
  const result = await checkNode(node.host, node.port);
  persistNodeCheck(node.id, result);
  return result;
}

async function runHealthChecks() {
  const nodes = db.prepare("SELECT * FROM nodes WHERE COALESCE(draft, 0)=0 AND host<>'' AND port IS NOT NULL").all();
  if (!nodes.length) return;
  console.log(`[health] Checking ${nodes.length} nodes...`);
  for (const n of nodes) {
    try {
      await runSingleNodeCheck(n);
    } catch (e) {
      persistNodeCheck(n.id, { status: 'down', latency_ms: -1, error: e.message });
    }
  }
  db.prepare(`DELETE FROM checks WHERE checked_at<datetime('now','-${HISTORY_DAYS} days')`).run();
  const up = db.prepare(`SELECT COUNT(DISTINCT node_id) as c FROM checks c JOIN (SELECT node_id,MAX(checked_at) as l FROM checks GROUP BY node_id) x ON c.node_id=x.node_id AND c.checked_at=x.l WHERE c.status='up'`).get();
  console.log(`[health] Done — ${up?.c||0}/${nodes.length} up`);
}

async function runValidatorChecks() {
  console.log('[validators] Checking...');
  const ins = db.prepare('INSERT INTO validator_snapshots (validator_addr,moniker,status,jailed,tokens,commission_rate,missed_blocks,uptime_pct) VALUES (?,?,?,?,?,?,?,?)');
  try {
    const [bonded,unbonding,unbonded] = await Promise.all([
      lcdFetch('/cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED&pagination.limit=200').catch(()=>({validators:[]})),
      lcdFetch('/cosmos/staking/v1beta1/validators?status=BOND_STATUS_UNBONDING&pagination.limit=200').catch(()=>({validators:[]})),
      lcdFetch('/cosmos/staking/v1beta1/validators?status=BOND_STATUS_UNBONDED&pagination.limit=200').catch(()=>({validators:[]}))
    ]);
    const all = [...(bonded.validators||[]),...(unbonding.validators||[]),...(unbonded.validators||[])];
    let window = 10000;
    try { const p = await lcdFetch('/cosmos/slashing/v1beta1/params'); window = parseInt(p.params?.signed_blocks_window||'10000'); } catch(e){}

    for (const v of all) {
      const missed = 0;
      const uptime = Math.round(Math.max(0,(window-missed)/window*100)*100)/100;
      ins.run(v.operator_address, v.description?.moniker||'', v.status||'', v.jailed?1:0,
              v.tokens||'0', v.commission?.commission_rates?.rate||'0', missed, uptime);
    }
    db.prepare(`DELETE FROM validator_snapshots WHERE checked_at<datetime('now','-${HISTORY_DAYS} days')`).run();
    console.log(`[validators] Done — ${all.length} tracked`);
  } catch(e) { console.error('[validators]', e.message); }
}

cron.schedule(CHECK_INTERVAL, () => runHealthChecks().catch(e => console.error('[health]', e)));
cron.schedule('*/15 * * * *', () => runValidatorChecks().catch(e => console.error('[validators]', e)));

// ── SPA fallback & start ──────────────────────────────────────
app.get('*', (_, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n╔═══════════════════════════════════════════════════╗\n║  Timpi NodeWatch — nodewatch.clawpurse.ai         ║\n║  Server: http://0.0.0.0:${PORT}  Google: ${GOOGLE_CLIENT_ID?'ON':'OFF'}            ║\n╚═══════════════════════════════════════════════════╝\n`);
  setTimeout(() => { runHealthChecks().catch(()=>{}); runValidatorChecks().catch(()=>{}); }, 5000);
});
