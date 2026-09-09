// Compatibility alias for Meta webhook verification and delivery.
const express = require('express');

const originalGet = express.application.get;
const originalPost = express.application.post;

function normalizeFacebookConnect(req, _res, next) {
  if (req.body && req.body.pageId != null) {
    req.body.pageId = String(req.body.pageId).trim();
  }
  if (req.body && req.body.pageAccessToken != null) {
    req.body.pageAccessToken = String(req.body.pageAccessToken).trim();
  }
  if (req.body?.pageId) {
    console.log(`Facebook connect request: page=${req.body.pageId}, token=provided`);
  }
  next();
}

function logFacebookWebhook(req, _res, next) {
  const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];
  for (const entry of entries) {
    if (entry?.id) console.log(`Facebook webhook received: page=${String(entry.id).trim()}`);
  }
  next();
}

express.application.get = function (path, ...handlers) {
  const result = originalGet.call(this, path, ...handlers);

  if (path === '/webhook/facebook') {
    originalGet.call(this, '/webhook', ...handlers);
  }

  return result;
};

express.application.post = function (path, ...handlers) {
  if (path === '/facebook/connect') {
    return originalPost.call(this, path, normalizeFacebookConnect, ...handlers);
  }

  if (path === '/webhook/facebook') {
    const result = originalPost.call(this, path, logFacebookWebhook, ...handlers);
    originalPost.call(this, '/webhook', logFacebookWebhook, ...handlers);
    return result;
  }

  return originalPost.call(this, path, ...handlers);
};
