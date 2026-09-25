// Lightweight diagnostic probe for Facebook/Meta webhook delivery.
// Loaded before server.js so it runs before express.json() and route handlers.
// It never consumes or changes the request; it only logs webhook-shaped requests.

const express = require('express');

if (!express.application.__akexaFacebookWebhookProbe) {
  const originalUse = express.application.use;

  express.application.use = function (...args) {
    const app = this;

    if (!app.__akexaFacebookWebhookProbeInstalled) {
      app.__akexaFacebookWebhookProbeInstalled = true;

      originalUse.call(app, function facebookWebhookProbe(req, res, next) {
        const url = String(req.originalUrl || req.url || '');
        const path = url.split('?')[0];

        if (path === '/webhook' || path === '/webhook/facebook' || path.startsWith('/webhook/')) {
          console.log(
            `[FB WEBHOOK PROBE] incoming: method=${req.method} path=${path} content-type=${String(req.headers['content-type'] || 'missing')} user-agent=${String(req.headers['user-agent'] || 'missing')} content-length=${String(req.headers['content-length'] || 'unknown')}`
          );

          res.on('finish', () => {
            console.log(`[FB WEBHOOK PROBE] response: method=${req.method} path=${path} status=${res.statusCode}`);
          });
          res.on('close', () => {
            if (!res.writableEnded) {
              console.log(`[FB WEBHOOK PROBE] response closed before finish: method=${req.method} path=${path} status=${res.statusCode}`);
            }
          });
        }

        next();
      });
    }

    return originalUse.apply(app, args);
  };

  express.application.__akexaFacebookWebhookProbe = true;
}

console.log('✓ Facebook webhook delivery probe ready');
