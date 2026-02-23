# Meridian — Deployment Guide (Multi-tenant)

## Architecture

```
meridian/
├── index.html                  ← Full frontend (single file)
├── schema.sql                  ← D1 database schema
├── wrangler.toml               ← Cloudflare project config
├── functions/
│   └── api/
│       └── [[route]].js        ← Pages Function — all API routes
└── SETUP.md                    ← This file
```

**How authentication works:**
- Users sign in with Google (via Google Identity Services)
- Google returns an ID token to the browser
- Every API request sends that token in the `Authorization: Bearer` header
- The Pages Function calls `https://oauth2.googleapis.com/tokeninfo` to verify it server-side
- The verified Google `sub` (user ID) is used to scope all D1 queries — no user can see another's data
- Your Anthropic API key lives in Cloudflare secrets, never in the browser

**The only credential users need:** their Google account.  
**The only secrets you need to configure:** `GCAL_CLIENT_ID` and `ANTHROPIC_API_KEY`.

---

## Step 1 — Create the D1 database

In the Cloudflare dashboard:

1. Go to **Storage & Databases → D1 SQL Database**
2. Click **Create database**, name it `meridian-db`, click **Create**
3. Copy the **Database ID** shown on the database page
4. Paste it into `wrangler.toml`:

```toml
[[d1_databases]]
binding       = "DB"
database_name = "meridian-db"
database_id   = "paste-your-id-here"
```

---

## Step 2 — Run the schema

On the `meridian-db` page, click the **Console** tab.

Run each statement separately (paste one, click Execute, then the next):

```sql
CREATE TABLE IF NOT EXISTS settings (
  user_id    TEXT PRIMARY KEY,
  name       TEXT    DEFAULT '',
  role       TEXT    DEFAULT '',
  work_start TEXT    DEFAULT '9:00 AM',
  work_end   TEXT    DEFAULT '6:00 PM',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

```sql
CREATE TABLE IF NOT EXISTS goals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT    NOT NULL,
  text       TEXT    NOT NULL,
  type       TEXT    NOT NULL CHECK(type IN ('work', 'personal')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

```sql
CREATE INDEX IF NOT EXISTS idx_goals_user ON goals(user_id);
```

```sql
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT    NOT NULL,
  title      TEXT    NOT NULL,
  start_time TEXT    NOT NULL,
  end_time   TEXT    DEFAULT '',
  type       TEXT    DEFAULT 'work',
  notes      TEXT    DEFAULT '',
  source     TEXT    DEFAULT 'manual',
  event_date TEXT    DEFAULT (date('now')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

```sql
CREATE INDEX IF NOT EXISTS idx_events_user_date ON events(user_id, event_date);
```

Verify all 3 tables appear under the **Tables** tab.

---

## Step 3 — Bind D1 to your Pages project

In your Pages project → **Settings** → **Bindings** → **Add**:
- Type: **D1 database**
- Variable name: `DB`
- Database: `meridian-db`
- Click **Save**

---

## Step 4 — Set secrets

In your Pages project → **Settings** → **Variables and Secrets** → **Add**:

| Name | Type | Value |
|------|------|-------|
| `GCAL_CLIENT_ID` | Secret | Your Google OAuth Client ID |
| `ANTHROPIC_API_KEY` | Secret | Your Anthropic API key (`sk-ant-api03-...`) |

Click **Deploy** after adding both.

**Important:** Use the **Secret** type (not plaintext) so values are encrypted and never visible again.

---

## Step 5 — Configure Google OAuth

In your [Google Cloud Console](https://console.cloud.google.com/apis/credentials):

1. Open your OAuth 2.0 Client ID
2. Under **Authorized JavaScript Origins**, add your Pages URL:
   - `https://your-project.pages.dev`
   - Your custom domain if you have one
3. Save

This same Client ID handles both **sign-in** and **Google Calendar access**.

---

## Step 6 — Deploy

Push all files to your GitHub repo. Cloudflare Pages auto-deploys on commit.

Your repo root should look like:
```
your-repo/
├── index.html
├── schema.sql
├── wrangler.toml
├── SETUP.md
└── functions/
    └── api/
        └── [[route]].js
```

---

## Step 7 — First login

Visit your Pages URL. Click **Sign in with Google**, authenticate, and you're in.

Each Google account that signs in gets its own completely isolated workspace — goals, events, and settings are never shared between users.

---

## Secrets reference

| Secret | Required | Description |
|--------|----------|-------------|
| `GCAL_CLIENT_ID` | ✅ | Google OAuth Client ID — handles login AND Calendar sync |
| `ANTHROPIC_API_KEY` | ✅ | Anthropic API key — proxied server-side, never in the browser |

---

## D1 schema reference

| Table | Scope | Purpose |
|-------|-------|---------|
| `settings` | Per user | Name, role, work hours |
| `goals` | Per user | Work and personal goals |
| `events` | Per user + date | Today's calendar events (manual + Google Calendar) |

All rows are stamped with `user_id` (Google's permanent `sub` identifier). The Pages Function verifies the Google ID token on every request and rejects any attempt to access another user's data.
