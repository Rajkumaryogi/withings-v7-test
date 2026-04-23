# Withings API Integration

A Node.js application to authenticate with Withings API and fetch health data.

## Setup

1. **Install dependencies:**
```bash
npm install
```

## Quick Start

### Single Command to Start Server

```bash
# Start the Withings API server (keeps running)
npm run server
# or
npm run docs

# Server will run on http://localhost:5001
# Documentation available at http://localhost:5001/docs
```

The server will keep running and handle:
- ✅ OAuth authentication flow
- ✅ API data endpoints
- ✅ Automatic token refresh
- ✅ Frontend integration

### Frontend Integration

Once the server is running, you can connect Withings from the Vitals Dashboard:

1. Click "Connect Device" in the Vitals Dashboard
2. Select "Withings Body+"
3. Authentication window will open automatically
4. After authentication, you'll be redirected back to the dashboard
5. Data will automatically load and display

## API Documentation

The API documentation is available at `http://localhost:5001/docs` when the server is running.

The documentation server provides:
- 📚 Complete API reference
- 📊 Status endpoint (`/api/status`)
- 🔌 All available endpoints
- 💡 Usage examples

## Fetching data effectively

The server uses `getAllData()` (activity, body measures, sleep, user, devices). To make that **complete and efficient**:

1. **Pagination (built in)** — Withings returns at most a limited number of rows per call (`more` + `offset`). The client now **follows pages** until `more` is false (capped for safety).

2. **Tune windows with env** (smaller windows = faster syncs; larger = more history on first import):
   - `WITHINGS_ACTIVITY_DAYS` — default `90`
   - `WITHINGS_SLEEP_DAYS` — default `90`
   - `WITHINGS_MEASURE_DAYS` — default `365` (body composition, BP, SpO₂, etc.)
   - `WITHINGS_API_MAX_PAGES` — safety cap on pagination loops, default `100`

3. **Push webhooks (continuous sync)** — Set **`WITHINGS_WEBHOOK_URL`** to your public HTTPS URL ending in **`/webhook/withings`** (e.g. behind ngrok or your API domain). Allowlist that URL in the **Withings Developer Portal** for notifications. After each successful OAuth, the server calls Withings **`subscribe`** for weight, activity, sleep, and related **appli** values so new cloud readings trigger **`POST /webhook/withings`** → same pipeline as **`POST /api/withings/sync`** → **`user_vitals`**. Optional: **`PUBLIC_WEBHOOK_BASE_URL`** (origin only) if you prefer the app to append `/webhook/withings`. Re-run **`POST /api/withings/register-webhooks`** after changing the URL. Optional **`WITHINGS_NOTIFY_APPLIS`** = comma-separated appli overrides (default `1,2,4,16,44,50,51`). If subscribe returns errors, try **`WITHINGS_NOTIFY_API_URL`** (default `https://wbsapi.withings.net`; some setups use a `/notify` path per Withings docs).

4. **After first bulk import** — `user_vitals` writes are filtered so measurements older than the last successful push timestamp are not re-sent (avoids duplicate writes when you still fetch a long window).

5. **Optional next steps** (not implemented in code by default): add the **heart** endpoint for wearable HR time series; use **shorter windows on webhook** and longer windows on weekly “backfill”; store `lastupdate` / cursor fields if Withings exposes them for true incremental API pulls.

## Storage

- **Tokens:** DynamoDB table **`vitals-di-tokens`** (via server OAuth callback and refresh).
- **Readings:** DynamoDB **`user_vitals`** (via `POST /api/withings/sync`, webhooks, or OAuth background sync).
- **No** `withings.json` or `data/*.json` snapshots.

## Manual Usage (CLI)

- **`npm run server`** — main integration path for Vitals7.
- **`COGNITO_USER_ID=<uuid> npm run get-data`** — same sync as `POST /api/withings/sync` (requires tokens already in `vitals-di-tokens` for that user). Optional: `node src/data/save-data.js <uuid>`.

If you prefer the interactive menu instead of the frontend: