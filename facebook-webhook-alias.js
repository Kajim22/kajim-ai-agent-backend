// Compatibility alias for Meta webhook verification and delivery.
const express = require('express');

const originalGet = express.application.get;
const originalPost = express.application.post;
const originalFetch = global.fetch;

// Messenger UX helpers. This file is preloaded before server.js, so the
// existing Facebook flow gets these improvements without changing its route.
function normalizeMessengerEvent(req, _res, next) {
  const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];

  for (const entry of entries) {
    const events = Array.isArray(entry?.messaging) ? entry.messaging : [];
    for (const event of events) {
      // Convert Messenger postback / quick-reply payloads into normal text so
      // the existing AI handler can process button clicks without a second route.
      if (!event.message && event.postback?.payload) {
        event.message = {
          text: String(event.postback.title || event.postback.payload)
        };
      }

      if (event.message?.quick_reply?.payload && !event.message.text) {
        event.message.text = String(event.message.quick_reply.payload);
      }
    }
  }

  next();
}

// Show the Messenger typing indicator immediately before the real reply.
// Only outgoing Page Send API calls are affected; all other fetch calls remain unchanged.
if (typeof originalFetch === 'function') {
  global.fetch = async function (url, options = {}) {
    const target = String(url || '');
    const isFacebookSend = /graph\.facebook\.com\/[^/]+\/me\/messages\?access_token=/.test(target);

    if (isFacebookSend && options?.method === 'POST') {
      try {
        const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
        const isTypingAction = body?.sender_action === 'typing_on' || body?.sender_action === 'typing_off';

        if (!isTypingAction && body?.recipient?.id) {
          await originalFetch(target, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              recipient: { id: body.recipient.id },
              sender_action: 'typing_on'
            })
          }).catch(() => {});

          // Small delay makes the indicator visible while keeping responses fast.
          await new Promise(resolve => setTimeout(resolve, 250));
        }
      } catch (_) {
        // Never let the UX helper break the existing Messenger flow.
      }
    }

    return originalFetch(url, options);
  };
}

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
  normalizeMessengerEvent(req, _res, () => {});
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
