# Cloudflare Hosting Runbook

Minimal steps for hosting your app from your laptop using Cloudflare Tunnel.

## 1) Start backend

From project root:

```bash
docker compose up -d --build db recommender api
```

Verify:

```bash
curl -sS http://localhost:4000/health
```

Expected:

```json
{"ok":true}
```

## 2) Start frontend locally (optional)

In a new terminal for local testing only:

```bash
cd apps/web
npm install
VITE_API_BASE=http://127.0.0.1:4000 npm run dev -- --host 0.0.0.0 --port 5173
```

The local frontend will work only on your laptop at `http://localhost:5173`.

## 3) Expose API publicly

In another terminal:

```bash
docker run --rm --network host cloudflare/cloudflared:latest tunnel --url http://localhost:4000
```

Copy the generated API URL.

## 4) Restart frontend with the public API URL

If you want the frontend available to other people, the frontend must call the public API URL. 

```bash
cd apps/web
VITE_API_BASE=https://YOUR_API_TUNNEL.trycloudflare.com npm run dev -- --host 0.0.0.0 --port 5173
```
## 5) Expose frontend publicly

In a new terminal:

```bash
docker run --rm --add-host host.docker.internal:host-gateway cloudflare/cloudflared:latest tunnel --url http://host.docker.internal:5173
```

Copy the generated frontend URL.

## 6) Verify

```bash
curl -sS https://YOUR_API_TUNNEL.trycloudflare.com/health
curl -sSI https://YOUR_FRONTEND_TUNNEL.trycloudflare.com/ | head -n 5
```

## Notes

- Quick tunnel URLs are temporary and can change after restart.
- Your app is online only while your laptop, Docker services, frontend, and Cloudflare tunnels are running.
- If you want a stable custom domain, use Cloudflare named tunnel and DNS routing.
