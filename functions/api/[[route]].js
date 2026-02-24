/**
 * Meridian — Pages Function with field-level encryption
 *
 * Sensitive fields encrypted with AES-256-GCM before writing to D1:
 *   goals.text, events.title, events.notes, settings.name, settings.role
 *
 * Non-sensitive fields stored plaintext (needed for queries):
 *   user_id, event_date, start_time, end_time, type, source, timestamps
 *
 * Required Cloudflare secrets:
 *   GCAL_CLIENT_ID     — Google OAuth Client ID
 *   ANTHROPIC_API_KEY  — Anthropic API key
 *   ENCRYPTION_KEY     — Base64-encoded 32-byte AES key (see generation instructions below)
 *
 * To generate ENCRYPTION_KEY, run this in your browser console or Node.js:
 *   const key = await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
 *   const raw = await crypto.subtle.exportKey('raw', key);
 *   console.log(btoa(String.fromCharCode(...new Uint8Array(raw))));
 *
 * Then set it: npx wrangler secret put ENCRYPTION_KEY
 * Or paste the value into Cloudflare dashboard → Settings → Variables and Secrets → Add Secret
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS),
  });
}

function err(msg, status) {
  return json({ error: msg }, status || 400);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// ── Encryption helpers (AES-256-GCM) ─────────────────────────────────────────

async function getEncryptionKey(env) {
  if (!env.ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY not configured');
  const raw = Uint8Array.from(atob(env.ENCRYPTION_KEY), c => c.charCodeAt(0));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encrypt(plaintext, cryptoKey) {
  if (!plaintext && plaintext !== 0) return '';
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    enc.encode(String(plaintext))
  );
  // Store as base64(iv) + '.' + base64(ciphertext)
  const toB64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  return toB64(iv.buffer) + '.' + toB64(ciphertext);
}

async function decrypt(encoded, cryptoKey) {
  if (!encoded) return '';
  try {
    const [ivB64, ctB64] = encoded.split('.');
    if (!ivB64 || !ctB64) return encoded; // not encrypted — return as-is (migration safety)
    const fromB64 = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const iv         = fromB64(ivB64);
    const ciphertext = fromB64(ctB64);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ciphertext);
    return new TextDecoder().decode(plain);
  } catch(e) {
    // If decryption fails (e.g. old plaintext row), return as-is
    return encoded;
  }
}

// ── Google token verification ─────────────────────────────────────────────────

async function verifyGoogleToken(idToken, expectedClientId) {
  const res = await fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken)
  );
  if (!res.ok) throw new Error('Token verification failed');
  const claims = await res.json();
  if (parseInt(claims.exp) < Date.now() / 1000) throw new Error('Token expired');
  if (claims.aud !== expectedClientId) throw new Error('Token audience mismatch');
  if (claims.email_verified !== 'true' && claims.email_verified !== true) throw new Error('Email not verified');
  return { userId: claims.sub, email: claims.email };
}

async function authenticate(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (!idToken) throw new Error('Missing Authorization header');
  if (!env.GCAL_CLIENT_ID) throw new Error('GCAL_CLIENT_ID not configured');
  return verifyGoogleToken(idToken, env.GCAL_CLIENT_ID);
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function onRequest(context) {
  const request = context.request;
  const env     = context.env;
  const params  = context.params;

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  const routeParts = Array.isArray(params.route) ? params.route : (params.route ? [params.route] : []);
  const route  = routeParts.join('/');
  const method = request.method;
  const db     = env.DB;

  // Public endpoint — no auth, no encryption needed
  if (route === 'config') {
    return json({ gcalClientId: env.GCAL_CLIENT_ID || '' });
  }

  // Authenticate every other request
  var user;
  try {
    user = await authenticate(request, env);
  } catch(e) {
    return err(e.message || 'Unauthorized', 401);
  }
  const userId = user.userId;

  // Get encryption key — required for all data routes
  var cryptoKey;
  try {
    cryptoKey = await getEncryptionKey(env);
  } catch(e) {
    return err('Encryption not configured: ' + e.message, 500);
  }

  // ── /api/me ───────────────────────────────────────────────────────────────
  if (route === 'me') {
    return json(user);
  }

  // ── /api/settings ─────────────────────────────────────────────────────────
  if (route === 'settings') {
    if (method === 'GET') {
      const row = await db
        .prepare('SELECT * FROM settings WHERE user_id = ?')
        .bind(userId).first();
      if (!row) return json({});
      return json({
        user_id:    row.user_id,
        name:       await decrypt(row.name,       cryptoKey),
        role:       await decrypt(row.role,       cryptoKey),
        work_start: row.work_start,
        work_end:   row.work_end,
        updated_at: row.updated_at,
      });
    }

    if (method === 'PUT') {
      const body = await request.json();
      const encName = await encrypt(body.name || '', cryptoKey);
      const encRole = await encrypt(body.role || '', cryptoKey);
      await db.prepare(
        'INSERT INTO settings (user_id, name, role, work_start, work_end, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET name = excluded.name, role = excluded.role, work_start = excluded.work_start, work_end = excluded.work_end, updated_at = CURRENT_TIMESTAMP'
      ).bind(userId, encName, encRole, body.workStart || '9:00 AM', body.workEnd || '6:00 PM').run();
      return json({ ok: true });
    }
  }

  // ── /api/goals ────────────────────────────────────────────────────────────
  if (route === 'goals') {
    if (method === 'GET') {
      const { results } = await db
        .prepare('SELECT * FROM goals WHERE user_id = ? ORDER BY created_at ASC')
        .bind(userId).all();
      const decrypted = await Promise.all(results.map(async g => ({
        id:         g.id,
        user_id:    g.user_id,
        text:       await decrypt(g.text, cryptoKey),
        type:       g.type,
        created_at: g.created_at,
      })));
      return json(decrypted);
    }

    if (method === 'POST') {
      const body = await request.json();
      if (!body.text || !body.type) return err('text and type are required');
      const encText = await encrypt(body.text.trim(), cryptoKey);
      const result  = await db
        .prepare('INSERT INTO goals (user_id, text, type) VALUES (?, ?, ?)')
        .bind(userId, encText, body.type).run();
      return json({ id: result.meta.last_row_id, text: body.text, type: body.type }, 201);
    }
  }

  // ── /api/goals/:id ────────────────────────────────────────────────────────
  if (route.startsWith('goals/')) {
    const id = route.split('/')[1];
    if (method === 'DELETE') {
      await db.prepare('DELETE FROM goals WHERE id = ? AND user_id = ?').bind(id, userId).run();
      return json({ ok: true });
    }
  }

  // ── /api/events ───────────────────────────────────────────────────────────
  if (route === 'events') {
    if (method === 'GET') {
      const { results } = await db
        .prepare('SELECT * FROM events WHERE user_id = ? AND event_date = ? ORDER BY start_time ASC')
        .bind(userId, todayStr()).all();
      const decrypted = await Promise.all(results.map(async e => ({
        id:         e.id,
        user_id:    e.user_id,
        title:      await decrypt(e.title, cryptoKey),
        start_time: e.start_time,
        end_time:   e.end_time,
        type:       e.type,
        notes:      await decrypt(e.notes, cryptoKey),
        source:     e.source,
        event_date: e.event_date,
        created_at: e.created_at,
      })));
      return json(decrypted);
    }

    if (method === 'POST') {
      const body = await request.json();
      if (!body.title || !body.start) return err('title and start are required');
      const encTitle = await encrypt(body.title.trim(), cryptoKey);
      const encNotes = await encrypt(body.notes || '',  cryptoKey);
      const result   = await db.prepare(
        'INSERT INTO events (user_id, title, start_time, end_time, type, notes, source, event_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(userId, encTitle, body.start, body.end || '', body.type || 'work', encNotes, body.source || 'manual', todayStr()).run();
      return json({ id: result.meta.last_row_id, title: body.title, start: body.start, end: body.end, type: body.type, notes: body.notes, source: body.source }, 201);
    }

    if (method === 'DELETE') {
      const url    = new URL(request.url);
      const source = url.searchParams.get('source');
      if (source === 'gcal') {
        await db.prepare("DELETE FROM events WHERE user_id = ? AND source = 'gcal' AND event_date = ?")
          .bind(userId, todayStr()).run();
        return json({ ok: true });
      }
      return err('Missing source param');
    }
  }

  // ── /api/events/:id ───────────────────────────────────────────────────────
  if (route.startsWith('events/')) {
    const id = route.split('/')[1];
    if (method === 'DELETE') {
      await db.prepare('DELETE FROM events WHERE id = ? AND user_id = ?').bind(id, userId).run();
      return json({ ok: true });
    }
  }

  // ── /api/generate — Anthropic proxy ──────────────────────────────────────
  if (route === 'generate') {
    if (method !== 'POST') return err('POST only', 405);
    if (!env.ANTHROPIC_API_KEY) return err('ANTHROPIC_API_KEY not configured', 500);
    const body     = await request.json();
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    const data = await upstream.json();
    return json(data, upstream.status);
  }

  return err('Not found', 404);
}
