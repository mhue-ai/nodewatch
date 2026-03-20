# Timpi NodeWatch

**[nodewatch.clawpurse.ai](https://nodewatch.clawpurse.ai)**

Self-hosted monitoring dashboard for your Timpi network nodes. Connect your Keplr wallet, discover your Node Access NFTs, register your nodes, and monitor them in real-time.

Part of the **ClawPurse ecosystem** — alongside ClawPurse Wallet, ClawPurse Gateway, Timpi Drip Faucet, and Basis Timpi.

## Features

- **Dual authentication** — sign in with Google or Keplr wallet (or both)
- **Multi-wallet support** — link multiple Neutaro wallets, add via Keplr or by address
- **NFT auto-discovery** — detects Guardian, Synaptron, Collector, and GeoCore NFTs across all linked wallets
- **Node registration** — fill in host, port, GUID for each NFT
- **Automated health checks** — cron-based HTTP + TCP checks every 5 minutes
- **Staking dashboard** — aggregated delegations, pending rewards, and validator health across all wallets
- **Validator monitoring** — jailed status, missed blocks, uptime, commission tracked every 15 minutes
- **Live dashboard** — status cards, uptime sparklines, latency/uptime trend charts, event log
- **Built-in HTTPS** — Caddy auto-provisions Let's Encrypt certificates, zero config
- **Multi-user** — each account sees only their own nodes and staking
- **SQLite storage** — zero-dependency persistence with 30-day history retention
- **Docker deployment** — two containers (app + Caddy), persistent volumes

## Quick Start

### Docker with automatic HTTPS (recommended)

```bash
git clone https://github.com/mhue-ai/nodewatch.git
cd nodewatch
cp .env.example .env
```

Edit `.env` — set your domain (must have DNS pointing to this server):

```
DOMAIN=nodewatch.clawpurse.ai
```

Then deploy:

```bash
docker compose up -d
```

Caddy automatically provisions a Let's Encrypt TLS certificate. Dashboard is live at **https://nodewatch.clawpurse.ai** within ~30 seconds.

Ports 80 and 443 must be open. Caddy handles the HTTP→HTTPS redirect automatically.

### Local development (no HTTPS)

```bash
git clone https://github.com/mhue-ai/nodewatch.git
cd nodewatch
npm install
cp .env.example .env
npm start
```

Visit `http://localhost:3000` — Keplr signing still works over localhost.

## Architecture

```
┌──────────────────────────────────────────────┐
│  Browser (SPA)                                │
│  ├── Google Sign-In / Keplr wallet auth       │
│  ├── Multi-wallet management                  │
│  ├── NFT discovery → all linked wallets       │
│  ├── Node CRUD → REST API                     │
│  ├── Staking → aggregated across wallets      │
│  └── Dashboard → status/history/trends        │
└──────────────────┬───────────────────────────┘
                   │ HTTPS (port 443)
┌──────────────────▼───────────────────────────┐
│  Caddy (auto-TLS via Let's Encrypt)           │
│  ├── Automatic HTTPS cert provisioning        │
│  ├── HTTP→HTTPS redirect                      │
│  ├── HTTP/3, gzip, security headers           │
│  └── Reverse proxy → nodewatch:3000           │
└──────────────────┬───────────────────────────┘
                   │ HTTP (internal)
┌──────────────────▼───────────────────────────┐
│  Express.js Server                            │
│  ├── Google + Keplr auth (sessions by user)   │
│  ├── Wallet CRUD (multi-wallet per user)      │
│  ├── Node CRUD + health checker cron          │
│  ├── Validator health cron (every 15 min)     │
│  ├── Neutaro LCD proxy (NFTs, staking)        │
│  └── SQLite (users, wallets, nodes, checks)   │
└──────────────────────────────────────────────┘
```

## How It Works

### 1. Authentication

User clicks "Connect Keplr Wallet" → server generates a challenge nonce → Keplr signs it (ADR-036 arbitrary signing) → server verifies the signature matches the Neutaro address → issues a 24-hour session token.

No accounts, no passwords, no email. Your wallet IS your identity.

### 2. NFT Discovery

Once authenticated, the app queries the Neutaro LCD endpoint for all NFTs owned by your wallet address. It identifies Guardian, Synaptron, Collector, and GeoCore access NFTs and presents them as clickable cards.

### 3. Node Registration

Click an NFT (or register manually) → fill in the technical details:

| Field | Description | Example |
|-------|-------------|---------|
| Name | Your label | Guardian-1 |
| Type | Node type | guardian |
| Host | IP address | 192.168.1.10 |
| Port | HTTP port | 4005 |
| GUID | Registration GUID | abc-def-123 |

Default ports by type:
- **Guardian**: 4005 (also 8983 for Solr)
- **Synaptron**: 5005
- **Collector**: 37566
- **GeoCore**: 4013+

### 4. Health Monitoring

Every 5 minutes, the server checks each registered node:
1. HTTP GET to `host:port/`
2. If HTTP fails, raw TCP connection attempt
3. Records: up/down status, latency in ms, error message
4. Prunes checks older than 30 days

### 5. Dashboard

- **Status cards** — per-node up/down, latency, 24h uptime %, GUID
- **Uptime sparklines** — 4-hour visual timeline per card
- **Trend charts** — 24h rolling uptime % and latency (Chart.js)
- **Event log** — auto-detects state transitions
- **Type filters** — filter by node type
- **Auto-refresh** — polls every 60 seconds

## Networking Notes

### Checking nodes on the same server

If your Timpi nodes run on the same machine as NodeWatch, use `host.docker.internal` (Docker Desktop) or `172.17.0.1` (Linux Docker) as the host, or run with `network_mode: host` in docker-compose.

### Checking remote nodes

The health checker runs server-side, so it can reach any IP/port the server can access. Register remote nodes using their public IP.

### CORS / Browser limitations

The browser never contacts your nodes directly — all health checks go through the server. This avoids all CORS issues.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DOMAIN` | `localhost` | Your domain — Caddy auto-provisions HTTPS |
| `PORT` | 3000 | Internal server port (Caddy proxies to this) |
| `CHECK_INTERVAL` | `*/5 * * * *` | Cron schedule for node checks |
| `CHECK_TIMEOUT` | 5000 | Connection timeout (ms) |
| `HISTORY_DAYS` | 30 | Days of history to keep |
| `NEUTARO_LCD` | `https://api.neutaro.tech` | Neutaro REST endpoint |
| `GOOGLE_CLIENT_ID` | *(empty)* | Google OAuth client ID (optional) |

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/auth/config` | No | Get Google client ID (if configured) |
| GET | `/api/auth/challenge` | No | Get Keplr signing challenge |
| POST | `/api/auth/google` | No | Verify Google ID token, create session |
| POST | `/api/auth/keplr` | No | Verify wallet signature, create session |
| GET | `/api/auth/session` | Yes | Check session, get user + wallets |
| GET | `/api/wallets` | Yes | List linked wallets |
| POST | `/api/wallets/keplr` | Yes | Add wallet via Keplr (verified) |
| POST | `/api/wallets/address` | Yes | Add wallet by address (manual) |
| PUT | `/api/wallets/:id` | Yes | Update wallet label |
| DELETE | `/api/wallets/:id` | Yes | Remove wallet |
| GET | `/api/nodes` | Yes | List user's nodes |
| POST | `/api/nodes` | Yes | Register a node |
| PUT | `/api/nodes/:id` | Yes | Update a node |
| DELETE | `/api/nodes/:id` | Yes | Delete a node |
| GET | `/api/status` | Yes | Current node status + 24h uptime |
| GET | `/api/history?hours=24` | Yes | Node trend data for charts |
| GET | `/api/staking/my-validators` | Yes | Delegations + rewards across all wallets |
| GET | `/api/staking/validators` | No | All bonded Neutaro validators |
| GET | `/api/staking/validator-health/:addr` | Yes | 7-day validator snapshot history |
| GET | `/api/neutaro/nfts` | Yes | NFTs across all linked wallets |

## Data Storage

SQLite database at `data/nodewatch.db` (or Docker volume `nodewatch-data`).

Tables:
- **users** — id, google_id, email, display_name, timestamps
- **wallets** — linked Neutaro addresses per user (verified or manual)
- **nodes** — registered nodes with type, host, port, GUID (owned by user)
- **checks** — health check results with timestamp, status, latency
- **validator_snapshots** — periodic validator health records (status, jailed, uptime, missed blocks)

## HTTPS

HTTPS is built in via Caddy. When you set `DOMAIN=nodewatch.clawpurse.ai` in `.env`, Caddy automatically:

1. Provisions a Let's Encrypt TLS certificate
2. Redirects HTTP (port 80) to HTTPS (port 443)
3. Enables HTTP/3 (QUIC)
4. Adds security headers (HSTS, X-Frame-Options, etc.)
5. Renews the certificate before expiry

**Requirements:**
- Ports 80 and 443 must be open on the server
- DNS A record for your domain must point to the server's IP
- First cert provisioning takes ~10-30 seconds

For local development, `DOMAIN=localhost` uses Caddy's internal CA (self-signed).

## License

MIT
