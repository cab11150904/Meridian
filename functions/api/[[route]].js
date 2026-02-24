/**
 * Meridian — Multi-tenant Pages Function
 * File: functions/api/[[route]].js
 *
 * Authentication: Google ID tokens, verified server-side on every request.
 * Tenancy: All D1 queries are scoped to the verified Google user ID (sub).
 *
 * Required Cloudflare secrets:
 *   GCAL_CLIENT_ID    — Google OAuth Client ID (auth + Calendar)
 *   ANTHROPIC_API_KEY — Anthropic API key (never sent to the browser)
 *
 * D1 binding: DB (configured in wrangler.toml)
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function err(msg, status = 400) {
  return json({ error: msg }, status);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// ── Google ID token verification ──────────────────────────────────────────────
// Calls Google's tokeninfo endpoint to verify the ID token and extract claims.
// Returns { userId, email } on success, throws on failure.
async function verifyGoogleToken(idToken, expectedClientId) {
  const res = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
  );

  if (!res.ok) {
    throw new Error('Token verification failed');
  }

  const claims = await res.json();

  // Reject if the token has expired
  if (parseInt(claims.exp) < Date.now() / 1000) {
    throw new Error('Token expired');
  }

  // Reject if the audience doesn't match our Client ID — prevents token substitution
  if (claims.aud !== expectedClientId) {
    throw new Error('Token audience mismatch');
  }

  // Reject unverified email addresses
  if (claims.email_verified !== 'true' && claims.email_verified !== true) {
    throw new Error('Email not verified');
  }

  return {
    userId: claims.sub,   // permanent, unique Google user ID
    email:  claims.email,
  };
}

// ── Auth middleware ───────────────────────────────────────────────────────────
async function authenticate(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const idToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : null;

  if (!idToken) throw new Error('Missing Authorization header');
  if (!env.GCAL_CLIENT_ID) throw new Error('GCAL_CLIENT_ID not configured');

  return verifyGoogleToken(idToken, env.GCAL_CLIENT_ID);
}

// ── Main handler ──────────────────────────────────────────────────────────────
export async function onRequest(context) {
  const { request, env, params } = context;

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  const route = Array.isArray(params.route)
    ? params.route.join('/')
    : (params.route || '');

  const method = request.method;
  const db     = env.DB;

  // ── /api/config — public, returns client ID for frontend Google Sign-In ───
  if (route === 'config') {
    return json({ gcalClientId: env.GCAL_CLIENT_ID || '' });
  }

  // ── All other routes require a valid Google ID token ─────────────────────
  let user;
  try {
    user = await authenticate(request, env);
  } catch (e) {
    return err(e.message || 'Unauthorized', 401);
  }

  const { userId } = user;

  // ── /api/me — returns the current user's identity ────────────────────────
  if (route === 'me') {
    return json(user);
  }

  // ── /api/settings ─────────────────────────────────────────────────────────
  if (route === 'settings') {
    if (method === 'GET') {
      const row = await db
        .prepare('SELECT * FROM settings WHERE user_id = ?')
        .bind(userId)
        .first();
      return json(row || {});
    }

    if (method === 'PUT') {
      const body = await request.json();
      await db
        .prepare(`
          INSERT INTO settings (user_id, name, role, work_start, work_end, updated_at)
          VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(user_id) DO UPDATE SET
            name       = excluded.name,
            role       = excluded.role,
            work_start = excluded.work_start,
            work_end   = excluded.work_end,
            updated_at = CURRENT_TIMESTAMP
        `)
        .bind(
          userId,
          body.name      || '',
          body.role      || '',
          body.workStart || '9:00 AM',
          body.workEnd   || '6:00 PM'
        )
        .run();
      return json({ ok: true });
    }
  }

  // ── /api/goals ────────────────────────────────────────────────────────────
  if (route === 'goals') {
    if (method === 'GET') {
      const { results } = await db
        .prepare('SELECT * FROM goals WHERE user_id = ? ORDER BY created_at ASC')
        .bind(userId)
        .all();
      return json(results);
    }

    if (method === 'POST') {
      const { text, type } = await request.json();
      if (!text || !type) return err('text and type are required');
      const result = await db
        .prepare('INSERT INTO goals (user_id, text, type) VALUES (?, ?, ?)')
        .bind(userId, text.trim(), type)
        .run();
      return json({ id: result.meta.last_row_id, text, type }, 201);
    }
  }

  // ── /api/goals/:id ────────────────────────────────────────────────────────
  if (route.startsWith('goals/')) {
    const id = route.split('/')[1];
    if (method === 'DELETE') {
      // user_id check prevents deleting another user's goals
      await db
        .prepare('DELETE FROM goals WHERE id = ? AND user_id = ?')
        .bind(id, userId)
        .run();
      return json({ ok: true });
    }
  }

  // ── /api/events ───────────────────────────────────────────────────────────
  if (route === 'events') {
    if (method === 'GET') {
      const { results } = await db
        .prepare('SELECT * FROM events WHERE user_id = ? AND event_date = ? ORDER BY start_time ASC')
        .bind(userId, todayStr())
        .all();
      return json(results);
    }

    if (method === 'POST') {
      const { title, start, end, type, notes, source } = await request.json();
      if (!title || !start) return err('title and start are required');
      const result = await db
        .prepare(`
          INSERT INTO events (user_id, title, start_time, end_time, type, notes, source, event_date)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          userId,
          title.trim(),
          start,
          end    || '',
          type   || 'work',
          notes  || '',
          source || 'manual',
          todayStr()
        )
        .run();
      return json(
        { id: result.meta.last_row_id, title, start, end, type, notes, source },
        201
      );
    }

    // DELETE ?source=gcal — wipe today's gcal events for this user only
    if (method === 'DELETE') {
      const url    = new URL(request.url);
      const source = url.searchParams.get('source');
      if (source === 'gcal') {
        await db
          .prepare("DELETE FROM events WHERE user_id = ? AND source = 'gcal' AND event_date = ?")
          .bind(userId, todayStr())
          .run();
        return json({ ok: true });
      }
      return err('Missing source param');
    }
  }

  // ── /api/events/:id ───────────────────────────────────────────────────────
  if (route.startsWith('events/')) {
    const id = route.split('/')[1];
    if (method === 'DELETE') {
      // user_id check prevents deleting another user's events
      await db
        .prepare('DELETE FROM events WHERE id = ? AND user_id = ?')
        .bind(id, userId)
        .run();
      return json({ ok: true });
    }
  }

  // ── /api/generate — Anthropic proxy ──────────────────────────────────────
  if (route === 'generate') {
    if (method !== 'POST') return err('POST only', 405);
    if (!env.ANTHROPIC_API_KEY) return err('ANTHROPIC_API_KEY not configured on server', 500);

    const body     = await request.json();
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-api-key':       env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    const data = await upstream.json();
    return json(data, upstream.status);
  }

  return err('Not found', 404);
}
