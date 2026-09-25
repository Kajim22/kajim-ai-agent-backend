// Final Facebook webhook route hardening.
// Runs immediately before server.js and, at listen time, guarantees that
// Meta's configured /webhook endpoint points to the same handlers as
// /webhook/facebook. It does not replace the existing Facebook logic.

const express = require('express');

if (!express.application.__akexaWebhookFinalizer) {
  const originalListen = express.application.listen;

  function findRoute(app, path, method) {
    const stack = app?._router?.stack;
    if (!Array.isArray(stack)) return null;

    for (const layer of stack) {
      if (!layer?.route || layer.route.path !== path) continue;
      if (layer.route.methods?.[method]) return layer.route;
    }
    return null;
  }

  function routeAlreadyExists(app, path, method) {
    return Boolean(findRoute(app, path, method));
  }

  express.application.listen = function (...args) {
    const app = this;

    try {
      const facebookGet = findRoute(app, '/webhook/facebook', 'get');
      const facebookPost = findRoute(app, '/webhook/facebook', 'post');

      if (facebookGet && !routeAlreadyExists(app, '/webhook', 'get')) {
        for (const layer of facebookGet.stack || []) {
          if (typeof layer?.handle === 'function') {
            app.get('/webhook', layer.handle);
          }
        }
        console.log('✓ Final webhook route installed: GET /webhook -> /webhook/facebook');
      }

      if (facebookPost && !routeAlreadyExists(app, '/webhook', 'post')) {
        for (const layer of facebookPost.stack || []) {
          if (typeof layer?.handle === 'function') {
            app.post('/webhook', layer.handle);
          }
        }
        console.log('✓ Final webhook route installed: POST /webhook -> /webhook/facebook');
      }

      const routes = app?._router?.stack
        ?.filter(layer => layer?.route)
        ?.map(layer => layer.route.path)
        ?.filter(path => String(path).includes('webhook'));

      console.log('✓ Facebook webhook routes active:', JSON.stringify(routes || []));
    } catch (err) {
      console.error('Facebook webhook finalizer error:', err.message);
    }

    return originalListen.apply(this, args);
  };

  express.application.__akexaWebhookFinalizer = true;
}


// After server.js finishes registering routes, keep the last direct Facebook
// webhook handlers and remove stale duplicate /webhook POST layers that can
// intercept Meta deliveries with an unrelated authentication response.
setImmediate(() => {
  try {
    const stack = express.application?._router?.stack;
    if (!Array.isArray(stack)) return;

    const webhookPostIndexes = [];
    for (let i = 0; i < stack.length; i++) {
      const layer = stack[i];
      const path = layer?.route?.path;
      const methods = layer?.route?.methods || {};
      if (path === '/webhook' && methods.post) webhookPostIndexes.push(i);
    }

    if (webhookPostIndexes.length > 1) {
      const keepIndex = webhookPostIndexes[webhookPostIndexes.length - 1];
      const remove = new Set(webhookPostIndexes.filter(i => i !== keepIndex));
      express.application._router.stack = stack.filter((_, i) => !remove.has(i));
      console.log(`✓ Facebook webhook duplicate POST routes cleaned: kept=/webhook, removed=${remove.size}`);
    }
  } catch (err) {
    console.warn('Facebook webhook route cleanup skipped:', err.message);
  }
});

console.log('✓ Facebook webhook finalizer ready');
