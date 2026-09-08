const express = require('express');

// Validate that /facebook/connect receives a real token for the supplied Page.
// The token itself is never logged or returned.
const originalPost = express.application.post;

express.application.post = function (path, ...handlers) {
  if (path === '/facebook/connect') {
    const wrappedHandlers = [async (req, res, next) => {
      try {
        const { pageId, pageAccessToken } = req.body || {};
        if (!pageId || !pageAccessToken) return next();

        const graphVersion = process.env.FB_GRAPH_VERSION || 'v20.0';
        const url = `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(String(pageId))}?fields=id&access_token=${encodeURIComponent(String(pageAccessToken))}`;
        const response = await fetch(url);
        const data = await response.json().catch(() => ({}));

        if (!response.ok || data.error || String(data.id || '') !== String(pageId)) {
          const message = data?.error?.message || 'Facebook Page Access Token validation failed';
          console.error(`Facebook connect rejected: ${message}`);
          return res.status(400).json({ success: false, error: 'Facebook Page Access Token invalid বা Page ID-এর সাথে মেলে না। Meta থেকে Page Access Token তৈরি করে আবার চেষ্টা করুন।' });
        }

        console.log(`✓ Facebook Page token validated for page ${pageId}`);
        return next();
      } catch (err) {
        console.error('Facebook token validation error:', err.message);
        return res.status(502).json({ success: false, error: 'Facebook token validation করা যায়নি। কিছুক্ষণ পর আবার চেষ্টা করুন।' });
      }
    }, ...handlers];

    return originalPost.call(this, path, ...wrappedHandlers);
  }

  return originalPost.call(this, path, ...handlers);
};
