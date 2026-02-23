# Meridian — Deployment Guide

## What you're deploying

```
meridian/
├── index.html                  ← The full frontend (single file)
├── schema.sql                  ← D1 database schema
├── wrangler.toml               ← Cloudflare project config
├── functions/
│   └── api/
│       └── [[route]].js        ← Pages Function — all backend API routes
└── SETUP.md                    ← This file
```

**Architecture:**
- `index.html` is served as a static file by Cloudflare Pages
- `/api/*` routes are handled by the Pages Function (no separate Worker needed)
- D1 stores: settings, goals, and calendar events
- Your Anthropic API key lives in Cloudflare secrets — never in the browser
- Google Calendar OAuth still runs client-side (required by Google's SDK)
- The GCal OAuth token is stored in `localStorage` (only for auto-reconnect on reload)

---

## Prerequisites

- Node.js 16.17.0 or later (use [nvm](https://github.com/nvm-sh/nvm) or [Volta](https://volta.sh/))
- A Cloudflare account with Pages enabled
- Your repository connected to Cloudflare Pages (or use Direct Upload)

---

## Step 1 — Install Wrangler

```bash
npm install -g wrangler
wrangler login
```

---

## Step 2 — Create the D1 database

```bash
npx wrangler d1 create meridian-db
```

Copy the `database_id` from the output and paste it into `wrangler.toml`:

```toml
[[d1_databases]]
binding       = "DB"
database_name = "meridian-db"
database_id   = "paste-your-id-here"
```

---

## Step 3 — Run the schema (local first, then remote)

```bash
# Test locally
npx wrangler d1 execute meridian-db --local --file=./schema.sql

# Apply to production
npx wrangler d1 execute meridian-db --remote --file=./schema.sql
```

---

## Step 4 — Set your secrets

These are set via the Cloudflare dashboard or CLI. They are **never** in code or `wrangler.toml`.

```bash
# Required — a secret string you choose (e.g. a long random password)
npx wrangler secret put AUTH_TOKEN

# Required — your Anthropic API key
npx wrangler secret put ANTHROPIC_API_KEY

# Optional — your Google OAuth Client ID (enables Google Calendar sync)
npx wrangler secret put GCAL_CLIENT_ID
```

Or set them in the Cloudflare dashboard:
**Workers & Pages → meridian → Settings → Variables and Secrets → Add secret**

---

## Step 5 — Deploy

### Via Git (recommended)

Push this folder to a GitHub/GitLab repo, then connect it to Cloudflare Pages:

1. Go to [Cloudflare Dashboard → Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages)
2. Click **Create application → Pages → Connect to Git**
3. Select your repo
4. Set **Build output directory** to `.` (the root)
5. Leave the build command blank (no build step needed)
6. Click **Save and Deploy**

### Via Wrangler CLI

```bash
npx wrangler pages deploy . --project-name=meridian
```

---

## Step 6 — First login

Visit your deployed URL (e.g. `https://meridian.pages.dev`).

The setup screen will ask for your **Access Token** — this is the `AUTH_TOKEN` value you set in Step 4. Enter it once, and it's stored in `localStorage` on your device.

---

## Local development

```bash
# Start local Pages dev server with D1 access
npx wrangler pages dev . --d1 DB=<your-database-id>
```

Or to use your real remote D1 database while developing locally:

```bash
npx wrangler pages dev . --d1 DB=<your-database-id> --remote
```

Then open `http://localhost:8788`.

---

## Secrets reference

| Secret | Required | Description |
|--------|----------|-------------|
| `AUTH_TOKEN` | ✅ | Any secret string — protects your API endpoints |
| `ANTHROPIC_API_KEY` | ✅ | Your Anthropic API key (`sk-ant-api03-...`) |
| `GCAL_CLIENT_ID` | Optional | Google OAuth Client ID for Calendar sync |

---

## D1 schema reference

| Table | Purpose |
|-------|---------|
| `settings` | Key-value store for your profile (name, role, work hours) |
| `goals` | Work and personal goals with type and timestamp |
| `events` | Today's calendar events (manual + Google Calendar synced) |

Events are scoped to `event_date = today` — each day starts with a fresh slate from Google Calendar. Manually added events persist until you delete them.
