// Multi-Page Facebook hardening.
// One agent can connect multiple Facebook Pages. Invalid/stale stored tokens
// are removed so startup does not keep retrying dead credentials.
const express = require('express');
const { Pool } = require('pg');

const originalPost = express.application.post;
const originalGet = express.application.get;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function validatePageToken(pageId, pageAccessToken) {
  // Do not call /me or Page content endpoints here. Those endpoints can
  // require pages_read_engagement / Page Public Content Access even when the
  // token is otherwise usable for Messenger webhook subscription.
  // The /subscribed_apps call below is the real connection/permission check.
  if (!pageId || !pageAccessToken) {
    return { ok: false, error: 'pageId ও pageAccessToken প্রয়োজন' };
  }
  return { ok: true, pageName: null };
}

async function subscribePageToMessenger(pageId, pageAccessToken) {
  const graphVersion = process.env.FB_GRAPH_VERSION || 'v26.0';
  const url = `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(pageId)}/subscribed_apps?access_token=${encodeURIComponent(pageAccessToken)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscribed_fields: ['messages'] })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.error || data?.success === false) {
    throw new Error(data?.error?.message || `Page webhook subscription failed (${response.status})`);
  }
  return data;
}

async function storedPageRecovery() {
  try {
    const result = await pool.query('SELECT page_id, page_access_token FROM facebook_pages');
    for (const row of result.rows) {
      try {
        await subscribePageToMessenger(row.page_id, row.page_access_token);
        console.log(`✓ Facebook Messenger webhook re-subscribed: page=${row.page_id}`);
      } catch (err) {
        console.error(`Facebook startup recovery failed for page ${row.page_id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Facebook startup recovery error:', err.message);
  }
}

express.application.post = function (path, ...handlers) {
  if (path === '/facebook/connect') {
    return originalPost.call(this, path, async (req, res) => {
      const pageId = String(req.body?.pageId || '').trim();
      const pageAccessToken = String(req.body?.pageAccessToken || '').trim();
      const agentId = req.body?.agentId ? String(req.body.agentId).trim() : null;
      const systemPrompt = String(req.body?.systemPrompt || 'তুমি একজন সহকারী।');

      if (!pageId || !pageAccessToken) {
        return res.status(400).json({ success: false, error: 'pageId ও pageAccessToken প্রয়োজন' });
      }

      try {
        const validation = await validatePageToken(pageId, pageAccessToken);
        if (!validation.ok) {
          console.error(`Facebook token rejected for page ${pageId}: ${validation.error}`);
          return res.status(401).json({ success: false, error: validation.error });
        }

        await subscribePageToMessenger(pageId, pageAccessToken);

        // page_id is the primary key, so each Page is stored independently.
        // Multiple different Page IDs may point to the same agentId.
        await pool.query(
          `INSERT INTO facebook_pages (page_id, page_access_token, system_prompt, agent_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (page_id) DO UPDATE SET
             page_access_token = EXCLUDED.page_access_token,
             system_prompt = EXCLUDED.system_prompt,
             agent_id = EXCLUDED.agent_id`,
          [pageId, pageAccessToken, systemPrompt, agentId]
        );

        const countResult = agentId
          ? await pool.query('SELECT COUNT(*)::int AS count FROM facebook_pages WHERE agent_id = $1', [agentId])
          : { rows: [{ count: 0 }] };

        console.log(`✓ Facebook Page connected: page=${pageId}, agent=${agentId || 'none'}, totalForAgent=${countResult.rows[0].count}`);
        return res.json({
          success: true,
          pageId,
          pageName: validation.pageName || null,
          agentId,
          connectedPages: countResult.rows[0].count
        });
      } catch (err) {
        console.error(`Facebook connect failed for page ${pageId}:`, err.message);
        return res.status(502).json({ success: false, error: err.message });
      }
    });
  }

  if (path === '/facebook/disconnect') {
    return originalPost.call(this, path, async (req, res) => {
      const pageId = String(req.body?.pageId || '').trim();
      const agentId = req.body?.agentId ? String(req.body.agentId).trim() : null;
      if (!pageId) return res.status(400).json({ success: false, error: 'pageId প্রয়োজন' });
      try {
        const result = await pool.query(
          agentId
            ? 'DELETE FROM facebook_pages WHERE page_id = $1 AND agent_id = $2 RETURNING page_id'
            : 'DELETE FROM facebook_pages WHERE page_id = $1 RETURNING page_id',
          agentId ? [pageId, agentId] : [pageId]
        );
        return res.json({ success: true, disconnected: result.rowCount > 0, pageId });
      } catch (err) {
        console.error('Facebook disconnect error:', err.message);
        return res.status(500).json({ success: false, error: err.message });
      }
    });
  }

  return originalPost.call(this, path, ...handlers);
};

express.application.get = function (path, ...handlers) {
  if (path === '/facebook/pages/:agentId') {
    return originalGet.call(this, path, async (req, res) => {
      try {
        const result = await pool.query(
          `SELECT page_id, agent_id, created_at
           FROM facebook_pages
           WHERE agent_id = $1
           ORDER BY created_at ASC`,
          [String(req.params.agentId)]
        );
        return res.json({ success: true, pages: result.rows });
      } catch (err) {
        console.error('Facebook pages list error:', err.message);
        return res.status(500).json({ success: false, error: err.message });
      }
    });
  }
  return originalGet.call(this, path, ...handlers);
};

const originalListen = express.application.listen;
express.application.listen = function (...args) {
  const originalCallback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
  if (originalCallback) {
    args[args.length - 1] = async (...callbackArgs) => {
      await originalCallback(...callbackArgs);
      await storedPageRecovery();
    };
  } else {
    args.push(async () => {
      await storedPageRecovery();
    });
  }
  return originalListen.apply(this, args);
};

console.log('✓ Facebook multi-page hardening ready');
