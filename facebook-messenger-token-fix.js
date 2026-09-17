// Messenger token reliability patch.
// Reuses the configured Graph API version and provides explicit diagnostics
// when a Page token is expired, invalid, or belongs to another Page.
const express = require('express');
const { Pool } = require('pg');
const originalPost = express.application.post;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function inspectToken(pageId, token) {
  const version = process.env.FB_GRAPH_VERSION || 'v26.0';
  const url = `https://graph.facebook.com/${version}/me?fields=id,name&access_token=${encodeURIComponent(token)}`;
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    return { ok: false, error: data?.error?.message || `Meta returned HTTP ${response.status}`, code: data?.error?.code || null };
  }
  if (String(data.id) !== String(pageId)) {
    return { ok: false, error: 'এই access token অন্য Facebook Page-এর।', code: 'PAGE_ID_MISMATCH' };
  }
  return { ok: true, pageName: data.name || null };
}

express.application.post = function(path, ...handlers) {
  if (path === '/facebook/token-check') {
    return originalPost.call(this, path, async (req, res) => {
      const pageId = String(req.body?.pageId || '').trim();
      const token = String(req.body?.pageAccessToken || '').trim();
      if (!pageId || !token) return res.status(400).json({ success: false, error: 'pageId ও pageAccessToken প্রয়োজন' });
      try {
        const result = await inspectToken(pageId, token);
        return res.status(result.ok ? 200 : 401).json({ success: result.ok, pageId, ...result });
      } catch (err) {
        return res.status(502).json({ success: false, error: err.message });
      }
    });
  }
  return originalPost.call(this, path, ...handlers);
};

console.log('✓ Facebook Messenger token diagnostic patch ready');
