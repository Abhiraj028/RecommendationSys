# Cutlist Lab

Cutlist Lab is a MovieLens-based recommendation project with three services working together:

- React frontend
- Express API
- FastAPI recommender
- Postgres database

This guide helps you do two things fast:

- run the project locally
- share it publicly with Cloudflare tunnel links

## What lives where

- Frontend: `apps/web` (Vite + React)
- API: `apps/server` (Node.js + Express)
- Recommender: `services/recommender` (FastAPI)
- Database: Postgres via Docker Compose (`db` service)

Default ports:

- Frontend: `5173`
- API: `4000`
- Recommender: `8000`
- Postgres: `5432`

## Before you start

Required:

- Docker + Docker Compose plugin
- Node.js 20+ and npm
- Internet access (MovieLens download + Cloudflare tunnel)

Optional:

- TMDB key for richer metadata (posters, reviews)

```bash
export TMDB_API_KEY=YOUR_KEY
```

## 1. Start backend services

From the repo root:

```bash
docker compose up -d --build db recommender api
```

Quick health check:

```bash
curl -sS http://localhost:4000/health
```

Expected response:

```json
{"ok":true}
```

## 2. Load MovieLens data into the correct DB

Important detail: API and recommender are configured to use `recs_32m`, while the loader defaults to `recs`.
If you skip this, recommendations may look empty.

Create `recs_32m` once (safe if it already exists):

```bash
docker exec recs-db psql -U recs -d postgres -c "CREATE DATABASE recs_32m;"
```

Load `latest-small` into `recs_32m`:

```bash
docker compose run --rm \
  -e DATABASE_URL=postgresql://recs:recs@db:5432/recs_32m \
  -e ML_DATASET=latest-small \
  -e ML_ZIP_URL=https://files.grouplens.org/datasets/movielens/ml-latest-small.zip \
  -e ML_ZIP_PATH=/app/ml-latest-small.zip \
  loader
```

## 3. Run the frontend locally

In a new terminal:

```bash
cd apps/web
npm install
VITE_API_BASE=http://127.0.0.1:4000 npm run dev -- --host 0.0.0.0 --port 5173
```

Open `http://localhost:5173`.

## 4. Make it public with Cloudflare (quick tunnels)

You will create two public URLs:

- one for API
- one for frontend

Keep these tunnel processes running while you want the app online.

### 4.1 Start public API tunnel

In another terminal:

```bash
docker run --rm --network host cloudflare/cloudflared:latest tunnel --url http://localhost:4000
```

Copy the generated `https://...trycloudflare.com` URL. This is your public API.

### 4.2 Restart frontend to use that public API URL

If your API tunnel URL changed, restart frontend with the updated base URL:

```bash
cd apps/web
VITE_API_BASE=https://YOUR_API_TUNNEL.trycloudflare.com npm run dev -- --host 0.0.0.0 --port 5173
```

### 4.3 Start public frontend tunnel

In one more terminal:

```bash
docker run --rm --add-host host.docker.internal:host-gateway cloudflare/cloudflared:latest tunnel --url http://host.docker.internal:5173
```

Copy that `https://...trycloudflare.com` URL. Share this frontend URL.

## 5. Verify public access

API check:

```bash
curl -sS https://YOUR_API_TUNNEL.trycloudflare.com/health
```

Frontend check:

```bash
curl -sSI https://YOUR_FRONTEND_TUNNEL.trycloudflare.com/ | head -n 5
```

## Troubleshooting

### I only see JSON, not the app

You opened the API tunnel URL. Open the frontend tunnel URL instead.

### Frontend tunnel gives 502

- Make sure Vite is running on `5173`
- Use `host.docker.internal:5173` in the tunnel command for frontend

### Frontend tunnel gives 403 host error

Vite blocks unknown hosts unless allowed. This project already includes the needed config in `apps/web/vite.config.ts`.

### Browser console shows CSP or extension warnings

Many of these are extension-related (`content.js`) and not a backend issue. Confirm with the API health endpoint first.

## Reality of quick tunnels

Quick tunnel URLs are temporary and may change after restart. The app stays public only while:

- your laptop is on
- Docker services are running
- frontend dev server is running
- cloudflared tunnel processes are running
- internet remains connected

If you need a stable URL and custom domain, move to a named Cloudflare tunnel + DNS route.

## Optional backup and restore

Backup:

```bash
mkdir -p data/backup
docker exec recs-db pg_dump -U recs -d recs_32m -F c -f /tmp/recs_32m.dump
docker cp recs-db:/tmp/recs_32m.dump data/backup/recs_32m.dump
```

Restore:

```bash
docker cp data/backup/recs_32m.dump recs-db:/tmp/recs_32m.dump
docker exec recs-db pg_restore -U recs -d recs_32m --clean --if-exists /tmp/recs_32m.dump
```
