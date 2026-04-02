# Cutlist Lab

MovieLens-powered recommendation studio with a React front end, Express API, and FastAPI recommender. Includes a cold-start flow, dedicated search, and an analytics/EDA dashboard.

## Quick Start

### 1) TMDB key (optional)
Posters come from TMDB.

```bash
export TMDB_API_KEY=YOUR_KEY
```

### 2) Start backend
```bash
docker compose up -d --build
```

### 3) Load MovieLens (one-time)
```bash
docker compose run --rm loader
```

### 4) Start web
```bash
cd apps/web
npm install
npm run dev
```

Open:
- http://localhost:5173

API:
- http://localhost:4000/health

## Dataset Backup + 32M

### Backup current DB
```bash
mkdir -p data/backup
docker exec recs-db pg_dump -U recs -d recs -F c -f /tmp/recs_latest-small.dump
docker cp recs-db:/tmp/recs_latest-small.dump data/backup/recs_latest-small.dump
```

### Load 32M into a separate DB
```bash
docker exec recs-db psql -U recs -d postgres -c "CREATE DATABASE recs_32m;"
docker compose run --rm \
  -e DATABASE_URL=postgresql://recs:recs@db:5432/recs_32m \
  -e ML_DATASET=32m \
  -e ML_ZIP_URL=https://files.grouplens.org/datasets/movielens/ml-32m.zip \
  -e ML_ZIP_PATH=/app/ml-32m.zip \
  loader
```

Switch datasets by changing `DATABASE_URL` in docker-compose.yml.
