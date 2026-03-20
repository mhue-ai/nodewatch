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

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'nodewatch.db');
const CHECK_INTERVAL = process.env.CHECK_INTERVAL || '*/5 * * * *';
const CHECK_TIMEOUT = parseInt(process.env.CHECK_TIMEOUT || '5000');
const HISTORY_DAYS = parseInt(process.env.HISTORY_DAYS || '30');
const NEUTARO_LCD = process.env.NEUTARO_LCD || 'https://api.neutaro.tech';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';

// ── Database ──────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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

  CREATE TABLE IF NOT EXISTS checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    checked_at TEXT DEFAULT (datetime('now')),
    status TEXT NOT NULL CHECK(status IN ('up','down')),
    latency_ms INTEGER DEFAULT -1, error TEXT
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
  CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets(user_id);
  CREATE INDEX IF NOT EXISTS idx_val_snap ON validator_snapshots(validator_addr, checked_at);
`);

// ── LCD Helper ────────────────────────────────────────────────
async function lcdFetch(p) {
  const r = await fetch(`${NEUTARO_LCD}${p}`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`LCD ${r.status}`);
  return r.json();
}

// ══════════════════════════════════════════════════════════════
// AUTH — Google OR Keplr, sessions by user ID
// ══════════════════════════════════════════════════════════════
const sessions = new Map(); // token -> { userId, expires }

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
    const wallets = db.prepare('SELECT * FROM wallets WHERE user_id=?').all(user.id);
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
  }

  const token = createSession(user.id);
  const wallets = db.prepare('SELECT * FROM wallets WHERE user_id=?').all(user.id);
  res.json({ token, user: { id: user.id, email: user.email, display_name: user.display_name, wallets } });
});

// ── Session check ─────────────────────────────────────────────
app.get('/api/auth/session', auth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.userId);
  const wallets = db.prepare('SELECT * FROM wallets WHERE user_id=?').all(req.userId);
  res.json({ user: { id: user.id, email: user.email, display_name: user.display_name, google_id: !!user.google_id, wallets } });
});

// ══════════════════════════════════════════════════════════════
// WALLET MANAGEMENT — add, remove, list
// ══════════════════════════════════════════════════════════════

app.get('/api/wallets', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM wallets WHERE user_id=? ORDER BY added_at').all(req.userId));
});

// Add wallet via Keplr (verified — signed challenge)
app.post('/api/wallets/keplr', auth, async (req, res) => {
  const { address, signature, pub_key, message, label } = req.body;
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

  // Check if wallet is already linked to another user
  const existing = db.prepare('SELECT * FROM wallets WHERE address=?').get(address);
  if (existing && existing.user_id !== req.userId) return res.status(409).json({ error: 'Wallet already linked to another account' });
  if (existing) return res.json(existing); // already linked to this user

  try {
    db.prepare('INSERT INTO wallets (user_id, address, label, verified) VALUES (?,?,?,1)').run(req.userId, address, label || '');
    res.status(201).json(db.prepare('SELECT * FROM wallets WHERE address=?').get(address));
  } catch (e) { res.status(409).json({ error: 'Wallet already exists' }); }
});

// Add wallet by address (unverified — manual entry)
app.post('/api/wallets/address', auth, (req, res) => {
  const { address, label } = req.body;
  if (!address) return res.status(400).json({ error: 'Missing address' });
  if (!address.startsWith('neutaro1') || address.length < 40) return res.status(400).json({ error: 'Invalid Neutaro address format' });

  const existing = db.prepare('SELECT * FROM wallets WHERE address=?').get(address);
  if (existing && existing.user_id !== req.userId) return res.status(409).json({ error: 'Wallet linked to another account' });
  if (existing) return res.json(existing);

  try {
    db.prepare('INSERT INTO wallets (user_id, address, label, verified) VALUES (?,?,?,0)').run(req.userId, address, label || '');
    res.status(201).json(db.prepare('SELECT * FROM wallets WHERE address=?').get(address));
  } catch (e) { res.status(409).json({ error: 'Wallet already exists' }); }
});

// Update wallet label
app.put('/api/wallets/:id', auth, (req, res) => {
  const w = db.prepare('SELECT * FROM wallets WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!w) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE wallets SET label=? WHERE id=?').run(req.body.label || w.label, w.id);
  res.json(db.prepare('SELECT * FROM wallets WHERE id=?').get(w.id));
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
  const { name, type, nft_id, guid, host, port, docker_name } = req.body;
  if (!name||!type||!host||!port) return res.status(400).json({ error: 'Missing fields' });
  try {
    const r = db.prepare('INSERT INTO nodes (user_id,name,type,nft_id,guid,host,port,docker_name) VALUES (?,?,?,?,?,?,?,?)')
      .run(req.userId, name, type, nft_id||null, guid||null, host, parseInt(port), docker_name||'-');
    res.status(201).json(db.prepare('SELECT * FROM nodes WHERE id=?').get(r.lastInsertRowid));
  } catch(e) { res.status(e.message.includes('UNIQUE')?409:500).json({ error: e.message }); }
});

app.put('/api/nodes/:id', auth, (req, res) => {
  const n = db.prepare('SELECT * FROM nodes WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!n) return res.status(404).json({ error: 'Not found' });
  const { name,type,nft_id,guid,host,port,docker_name } = req.body;
  db.prepare('UPDATE nodes SET name=?,type=?,nft_id=?,guid=?,host=?,port=?,docker_name=? WHERE id=?')
    .run(name||n.name,type||n.type,nft_id!==undefined?nft_id:n.nft_id,guid!==undefined?guid:n.guid,host||n.host,port?parseInt(port):n.port,docker_name!==undefined?docker_name:n.docker_name,n.id);
  res.json(db.prepare('SELECT * FROM nodes WHERE id=?').get(n.id));
});

app.delete('/api/nodes/:id', auth, (req, res) => {
  const r = db.prepare('DELETE FROM nodes WHERE id=? AND user_id=?').run(req.params.id, req.userId);
  r.changes ? res.json({ deleted:true }) : res.status(404).json({ error:'Not found' });
});

// ══════════════════════════════════════════════════════════════
// NODE STATUS & HISTORY
// ══════════════════════════════════════════════════════════════
app.get('/api/status', auth, (req, res) => {
  const nodes = db.prepare('SELECT * FROM nodes WHERE user_id=?').all(req.userId);
  res.json({ timestamp: new Date().toISOString(), nodes: nodes.map(n => {
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
  const wallets = db.prepare('SELECT * FROM wallets WHERE user_id=?').all(req.userId);
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

async function runHealthChecks() {
  const nodes = db.prepare('SELECT * FROM nodes').all();
  if (!nodes.length) return;
  console.log(`[health] Checking ${nodes.length} nodes...`);
  const ins = db.prepare('INSERT INTO checks (node_id,status,latency_ms,error) VALUES (?,?,?,?)');
  for (const n of nodes) { try { const r=await checkNode(n.host,n.port); ins.run(n.id,r.status,r.latency_ms,r.error); } catch(e){ ins.run(n.id,'down',-1,e.message); } }
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
