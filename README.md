# Cutlist Lab

MovieLens-powered recommendation studio with:
- React frontend
- Express API
- FastAPI recommender service
- PostgreSQL data store

This README is a practical runbook for:
- local setup
- loading MovieLens data
- exposing the app publicly from your own laptop using Cloudflare quick tunnels

## Architecture

- Frontend: `apps/web` (Vite + React)
- API: `apps/server` (Node.js + Express)
- Recommender: `services/recommender` (FastAPI)
- Database: Postgres (`db` service in Docker Compose)

Default ports:
- Frontend: `5173`
- API: `4000`
- Recommender: `8000`
- Postgres: `5432`

## Prerequisites

- Docker + Docker Compose plugin
- Node.js 20+ and npm
- Internet connection (for TMDB and Cloudflare quick tunnel)

Optional:
- TMDB API key for posters/reviews

```bash
export TMDB_API_KEY=YOUR_KEY
```

## 1) Start Backend Services

From repo root:

```bash
docker compose up -d --build db recommender api
```

Check health:

```bash
curl -sS http://localhost:4000/health
```

Expected:

```json
{"ok":true}
```

## 2) Initialize and Load Database

Important: API and recommender currently point to `recs_32m` in `docker-compose.yml`, while loader defaults to `recs`.
To avoid empty results, load into the same DB used by API (`recs_32m`).

Create DB once (ignore error if it already exists):

```bash
docker exec recs-db psql -U recs -d postgres -c "CREATE DATABASE recs_32m;"
```

Load latest-small dataset into `recs_32m`:

```bash
docker compose run --rm \
  -e DATABASE_URL=postgresql://recs:recs@db:5432/recs_32m \
  -e ML_DATASET=latest-small \
  -e ML_ZIP_URL=https://files.grouplens.org/datasets/movielens/ml-latest-small.zip \
  -e ML_ZIP_PATH=/app/ml-latest-small.zip \
  loader
```

## 3) Start Frontend Locally

In a new terminal:

```bash
cd apps/web
npm install
VITE_API_BASE=http://127.0.0.1:4000 npm run dev -- --host 0.0.0.0 --port 5173
```

Open:
- http://localhost:5173

## 4) Expose Public URLs From Your Laptop (No Card)

This creates two temporary public URLs (one for API, one for frontend).
Keep these processes running.

### 4.1 API quick tunnel

In a new terminal:

```bash
docker run --rm --network host cloudflare/cloudflared:latest tunnel --url http://localhost:4000
```

Copy the generated `https://...trycloudflare.com` URL for API.

### 4.2 Frontend quick tunnel

In a new terminal:

```bash
docker run --rm --add-host host.docker.internal:host-gateway cloudflare/cloudflared:latest tunnel --url http://host.docker.internal:5173
```

Copy the generated `https://...trycloudflare.com` URL for frontend.

### 4.3 Make frontend call the public API URL

If your API tunnel URL changed, restart frontend with the new API base:

```bash
cd apps/web
VITE_API_BASE=https://YOUR_API_TUNNEL.trycloudflare.com npm run dev -- --host 0.0.0.0 --port 5173
```

Use the frontend tunnel URL in browser from any network.

## 5) Sanity Checks

API should work:

```bash
curl -sS https://YOUR_API_TUNNEL.trycloudflare.com/health
```

Frontend should return HTML:

```bash
curl -sSI https://YOUR_FRONTEND_TUNNEL.trycloudflare.com/ | head -n 5
```

## Common Issues

### Seeing JSON at URL instead of app

You opened API URL, not frontend URL.

### Frontend tunnel returns 502

- Ensure Vite is running on `5173`
- Use `host.docker.internal:5173` in frontend tunnel command (not `127.0.0.1` from inside Docker)

### Frontend tunnel returns 403 "host not allowed"

Vite host checks block random tunnel domains unless allowed. This repo is configured for this in `apps/web/vite.config.ts`.

### CSP/extension warnings in browser console

These are often extension-side (`content.js`) and not backend failures. Validate with API health endpoint.

## Operational Notes

- Quick tunnel URLs are temporary and can change when restarted.
- App is reachable globally only while:
  - laptop is on
  - internet is available
  - backend containers are running
  - frontend dev server is running
  - cloudflared processes are running

## Optional: Dataset Backup and Restore

Backup:

```bash
mkdir -p data/backup
docker exec recs-db pg_dump -U recs -d recs_32m -F c -f /tmp/recs_32m.dump
docker cp recs-db:/tmp/recs_32m.dump data/backup/recs_32m.dump
```

Restore into `recs_32m`:

```bash
docker cp data/backup/recs_32m.dump recs-db:/tmp/recs_32m.dump
docker exec recs-db pg_restore -U recs -d recs_32m --clean --if-exists /tmp/recs_32m.dump
```
