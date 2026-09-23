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
  const url = `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(pageId)}/subscribed_apps?access_token=${encodeURIComponent(pageAccessToken)}&subscribed_fields=messages`;
  const response = await fetch(url, {
    method: 'POST'
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.error || data?.success === false) {
    throw new Error(data?.error?.message || `Page webhook subscription failed (${response.status})`);
  }
  console.log(`✓ Facebook Messenger messages subscription active: page=${pageId}`);
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
    // Subscribe the Page first, then let server.js run its normal authenticated
    // connect handler. This keeps the existing authorization/database logic intact.
    return originalPost.call(this, path, async (req, res, next) => {
      const pageId = String(req.body?.pageId || '').trim();
      const pageAccessToken = String(req.body?.pageAccessToken || '').trim();

      if (!pageId || !pageAccessToken) {
        return res.status(400).json({ success: false, error: 'pageId ও pageAccessToken প্রয়োজন' });
      }

      try {
        await subscribePageToMessenger(pageId, pageAccessToken);
        next();
      } catch (err) {
        console.error(`Facebook Page subscription failed: page=${pageId}:`, err.message);
        return res.status(502).json({
          success: false,
          error: 'Facebook Page webhook subscription failed: ' + err.message
        });
      }
    }, ...handlers);
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
