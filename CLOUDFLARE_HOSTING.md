# Cloudflare Hosting Runbook (Laptop Self-Host)

This guide is only for making this project reachable from anywhere using Cloudflare Tunnel while services run on your own laptop.

It covers:
- Option A: Quick tunnels (fastest, temporary URLs)
- Option B: Named tunnel (stable custom domain)

## What You Are Hosting

- API (Express): `localhost:4000`
- Frontend (Vite): `localhost:5173`
- Recommender and Postgres stay private on your machine

Only frontend and API need public access.

## Prerequisites

- Docker installed
- Node.js and npm installed
- Backend already working locally
- Cloudflare account (needed only for Option B)
- Domain on Cloudflare DNS (needed only for Option B)

## 1) Start Backend Locally

From repo root:

```bash
docker compose up -d --build db recommender api
```

Seed data (if not already loaded):

```bash
docker exec recs-db psql -U recs -d postgres -c "CREATE DATABASE recs_32m;"
docker compose run --rm \
  -e DATABASE_URL=postgresql://recs:recs@db:5432/recs_32m \
  -e ML_DATASET=latest-small \
  -e ML_ZIP_URL=https://files.grouplens.org/datasets/movielens/ml-latest-small.zip \
  -e ML_ZIP_PATH=/app/ml-latest-small.zip \
  loader
```

Sanity check:

```bash
curl -sS http://localhost:4000/health
```

Expected:

```json
{"ok":true}
```

## 2) Start Frontend Locally

In a new terminal:

```bash
cd apps/web
npm install
VITE_API_BASE=http://127.0.0.1:4000 npm run dev -- --host 0.0.0.0 --port 5173
```

Sanity check:

```bash
curl -sSI http://localhost:5173/ | head -n 5
```

## Option A: Quick Tunnel (No Domain, Fastest)

Use this for demos right now. URLs change when you restart tunnels.

### A.1 API public URL

In a new terminal:

```bash
docker run --rm --network host cloudflare/cloudflared:latest tunnel --url http://localhost:4000
```

Copy the generated API URL, like:

`https://<random>.trycloudflare.com`

### A.2 Restart frontend with public API URL

In another terminal, restart frontend so remote users call the public API URL:

```bash
cd apps/web
VITE_API_BASE=https://YOUR_API_TUNNEL.trycloudflare.com npm run dev -- --host 0.0.0.0 --port 5173
```

### A.3 Frontend public URL

In a new terminal:

```bash
docker run --rm --add-host host.docker.internal:host-gateway cloudflare/cloudflared:latest tunnel --url http://host.docker.internal:5173
```

Copy the generated frontend URL and share that URL.

### A.4 Verify from anywhere

```bash
curl -sS https://YOUR_API_TUNNEL.trycloudflare.com/health
curl -sSI https://YOUR_FRONTEND_TUNNEL.trycloudflare.com/ | head -n 5
```

## Option B: Named Tunnel (Stable Domain)

Use this if you want fixed URLs like:
- `https://api.yourdomain.com`
- `https://app.yourdomain.com`

### B.1 Install cloudflared locally

Linux:

```bash
# Debian/Ubuntu example
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo gpg --dearmor -o /usr/share/keyrings/cloudflare-main.gpg
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install -y cloudflared
```

### B.2 Login and create tunnel

```bash
cloudflared tunnel login
cloudflared tunnel create recs-home
```

### B.3 Route DNS records

```bash
cloudflared tunnel route dns recs-home api.yourdomain.com
cloudflared tunnel route dns recs-home app.yourdomain.com
```

### B.4 Create config file

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: recs-home
credentials-file: /home/YOUR_USER/.cloudflared/TUNNEL_ID.json
ingress:
  - hostname: api.yourdomain.com
    service: http://localhost:4000
  - hostname: app.yourdomain.com
    service: http://localhost:5173
  - service: http_status:404
```

### B.5 Start frontend with stable API base

```bash
cd apps/web
VITE_API_BASE=https://api.yourdomain.com npm run dev -- --host 0.0.0.0 --port 5173
```

### B.6 Run the named tunnel

```bash
cloudflared tunnel run recs-home
```

Open:
- `https://app.yourdomain.com`

## Keep It Running

Your site is reachable only while all of these are running:
- Docker backend containers
- Frontend Vite process
- Cloudflare tunnel process
- Laptop power + internet

Recommended:
- run frontend and cloudflared inside `tmux`
- disable auto-sleep on laptop

## Troubleshooting

### 1) You see API JSON instead of website

You opened the API URL, not the frontend URL.

### 2) Frontend tunnel 502

- Ensure frontend is running on `5173`
- For Dockerized quick tunnel, use:
  - `http://host.docker.internal:5173`

### 3) Frontend tunnel 403 host blocked

This repo already allows tunnel hostnames in Vite config (`allowedHosts: true`).

### 4) API works but frontend actions fail

Frontend likely points to old API URL. Restart frontend with correct `VITE_API_BASE`.

### 5) Random tunnel URL changed

Expected with quick tunnels. Use Option B for stable domain.
