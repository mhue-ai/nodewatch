# Timpi NodeWatch

**[nodewatch.clawpurse.ai](https://nodewatch.clawpurse.ai)**

Self-hosted monitoring dashboard for your Timpi network nodes. Connect your Keplr wallet, discover your Node Access NFTs, register your nodes, and monitor them in real-time.

Part of the **ClawPurse ecosystem** — alongside ClawPurse Wallet, ClawPurse Gateway, Timpi Drip Faucet, and Basis Timpi.

## Features

- **Keplr wallet authentication** — sign in with your Neutaro wallet, no passwords
- **NFT auto-discovery** — detects Guardian, Synaptron, Collector, and GeoCore NFTs from the Neutaro chain
- **Node registration** — fill in host, port, GUID for each NFT
- **Automated health checks** — cron-based HTTP + TCP checks every 5 minutes
- **Live dashboard** — status cards, uptime sparklines, latency/uptime trend charts, event log
- **Multi-user** — each wallet sees only their own nodes
- **SQLite storage** — zero-dependency persistence with 30-day history retention
- **Docker one-liner** — single container, persistent volume

## Quick Start

### Docker (recommended)

```bash
git clone https://github.com/mhue-ai/nodewatch.git
cd nodewatch
cp .env.example .env    # adjust if needed
docker compose up -d
```

Dashboard is at **https://nodewatch.clawpurse.ai**

### Without Docker

```bash
git clone https://github.com/mhue-ai/nodewatch.git
cd nodewatch
npm install
cp .env.example .env
npm start
```

## Architecture

```
┌──────────────────────────────────────────────┐
│  Browser (SPA)                                │
│  ├── Keplr wallet → sign challenge            │
│  ├── NFT discovery → Neutaro LCD proxy        │
│  ├── Node CRUD → REST API                     │
│  └── Dashboard → status/history API           │
└──────────────────┬───────────────────────────┘
                   │ HTTP
┌──────────────────▼───────────────────────────┐
│  Express.js Server (single container)         │
│  ├── Wallet-sig auth (ADR-036)                │
│  ├── SQLite (users, nodes, checks)            │
│  ├── Cron health checker (HTTP + TCP)         │
│  ├── Neutaro LCD proxy (NFT queries)          │
│  └── Static file server (SPA)                 │
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
| `PORT` | 3000 | Server port |
| `CHECK_INTERVAL` | `*/5 * * * *` | Cron schedule for checks |
| `CHECK_TIMEOUT` | 5000 | Connection timeout (ms) |
| `HISTORY_DAYS` | 30 | Days of history to keep |
| `NEUTARO_LCD` | `https://api.neutaro.tech` | Neutaro REST endpoint |

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/auth/challenge` | No | Get signing challenge |
| POST | `/api/auth/verify` | No | Verify wallet signature |
| GET | `/api/auth/session` | Yes | Check session validity |
| GET | `/api/nodes` | Yes | List user's nodes |
| POST | `/api/nodes` | Yes | Register a node |
| PUT | `/api/nodes/:id` | Yes | Update a node |
| DELETE | `/api/nodes/:id` | Yes | Delete a node |
| GET | `/api/status` | Yes | Current status + 24h uptime |
| GET | `/api/history?hours=24` | Yes | Trend data for charts |
| GET | `/api/timeline/:nodeId` | Yes | Per-node check timeline |
| GET | `/api/neutaro/nfts/:addr` | No | Proxy NFT query to LCD |

## Data Storage

SQLite database at `data/nodewatch.db` (or Docker volume `nodewatch-data`).

Tables:
- **users** — wallet addresses + login timestamps
- **nodes** — registered nodes with type, host, port, GUID
- **checks** — health check results with timestamp, status, latency

## Production Deployment

For production with HTTPS, put NodeWatch behind a reverse proxy:

```nginx
server {
    listen 443 ssl;
    server_name nodewatch.clawpurse.ai;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## License

MIT
