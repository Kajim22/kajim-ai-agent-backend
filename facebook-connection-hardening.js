// Facebook connection hardening.
// Validates a Page Access Token before saving it and subscribes the Page
// to the Messenger webhook so incoming messages can reach the backend.
const express = require('express');
const { Pool } = require('pg');

const originalPost = express.application.post;
const originalListen = express.application.listen;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function validatePageToken(pageId, pageAccessToken) {
  const graphVersion = process.env.FB_GRAPH_VERSION || 'v26.0';
  const url = `https://graph.facebook.com/${graphVersion}/me?fields=id,name&access_token=${encodeURIComponent(pageAccessToken)}`;
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data?.error) {
    return { ok: false, error: data?.error?.message || `Facebook token validation failed (${response.status})` };
  }

  if (String(data.id || '') !== String(pageId)) {
    return { ok: false, error: 'এই Page Access Token এই Page ID-এর সাথে মিলে না।' };
  }

  return { ok: true, pageName: data.name || null };
}

async function subscribePageToMessenger(pageId, pageAccessToken) {
  const graphVersion = process.env.FB_GRAPH_VERSION || 'v26.0';
  const url = `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(pageId)}/subscribed_apps?access_token=${encodeURIComponent(pageAccessToken)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscribed_fields: ['messages', 'messaging_postbacks', 'messaging_optins'] })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.error || data?.success === false) {
    throw new Error(data?.error?.message || `Page webhook subscription failed (${response.status})`);
  }
  return data;
}

async function resubscribeStoredPages() {
  try {
    const result = await pool.query('SELECT page_id, page_access_token FROM facebook_pages');
    for (const row of result.rows) {
      try {
        const validation = await validatePageToken(row.page_id, row.page_access_token);
        if (!validation.ok) {
          console.error(`Facebook stored token invalid for page ${row.page_id}: ${validation.error}`);
          continue;
        }
        await subscribePageToMessenger(row.page_id, row.page_access_token);
        console.log(`✓ Facebook Messenger webhook re-subscribed: page=${row.page_id}`);
      } catch (err) {
        console.error(`Facebook startup subscription failed for page ${row.page_id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Facebook startup re-subscription error:', err.message);
  }
}

// server.js calls app.listen(..., callback). Run the stored-page recovery
// immediately after the server's own startup callback so the DB is ready.
express.application.listen = function (...args) {
  const originalCallback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
  if (originalCallback) {
    args[args.length - 1] = async (...callbackArgs) => {
      await originalCallback(...callbackArgs);
      await resubscribeStoredPages();
    };
  } else {
    args.push(async () => {
      await resubscribeStoredPages();
    });
  }
  return originalListen.apply(this, args);
};

express.application.post = function (path, ...handlers) {
  if (path === '/facebook/connect') {
    const guard = async (req, res, next) => {
      const pageId = String(req.body?.pageId || '').trim();
      const pageAccessToken = String(req.body?.pageAccessToken || '').trim();

      if (!pageId || !pageAccessToken) {
        return res.status(400).json({ success: false, error: 'pageId ও pageAccessToken প্রয়োজন' });
      }

      try {
        const validation = await validatePageToken(pageId, pageAccessToken);
        if (!validation.ok) {
          console.error(`Facebook token rejected for page ${pageId}: ${validation.error}`);
          return res.status(401).json({ success: false, error: validation.error });
        }

        console.log(`✓ Facebook Page token validated: page=${pageId}${validation.pageName ? `, name=${validation.pageName}` : ''}`);

        try {
          await subscribePageToMessenger(pageId, pageAccessToken);
          console.log(`✓ Facebook Messenger webhook subscribed: page=${pageId}`);
        } catch (subscriptionError) {
          console.error(`Facebook webhook subscription failed for page ${pageId}:`, subscriptionError.message);
          return res.status(502).json({
            success: false,
            error: 'Facebook Page যাচাই হয়েছে, কিন্তু Messenger webhook subscription ব্যর্থ হয়েছে: ' + subscriptionError.message
          });
        }

        next();
      } catch (err) {
        console.error('Facebook token validation error:', err.message);
        return res.status(502).json({ success: false, error: 'Facebook token যাচাই করা যায়নি।' });
      }
    };

    return originalPost.call(this, path, guard, ...handlers);
  }

  if (path === '/facebook/disconnect') {
    const disconnect = async (req, res) => {
      const pageId = String(req.body?.pageId || '').trim();
      if (!pageId) return res.status(400).json({ success: false, error: 'pageId প্রয়োজন' });

      try {
        await pool.query('DELETE FROM facebook_pages WHERE page_id = $1', [pageId]);
        console.log(`✓ Facebook Page disconnected: page=${pageId}`);
        return res.json({ success: true, disconnected: true, pageId });
      } catch (err) {
        console.error('Facebook disconnect error:', err.message);
        return res.status(500).json({ success: false, error: err.message });
      }
    };

    return originalPost.call(this, path, disconnect);
  }

  return originalPost.call(this, path, ...handlers);
};
