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

      // express-final-init-repair restores preloaded routes inside originalListen().
    // Therefore route cleanup must happen after originalListen() has returned.
    try {
      const stackBefore = app?._router?.stack;
      if (Array.isArray(stackBefore)) {
        const postIndexes = [];
        for (let i = 0; i < stackBefore.length; i++) {
          const layer = stackBefore[i];
          if (layer?.route?.path === '/webhook' && layer.route.methods?.post) {
            postIndexes.push(i);
          }
        }

        // Keep ONLY the last /webhook POST route. server.js registers its real
        // facebookWebhookHandler last, while aliases/preloaded patches are earlier.
        if (postIndexes.length > 1) {
          const keepIndex = postIndexes[postIndexes.length - 1];
          const remove = new Set(postIndexes.slice(0, -1));
          app._router.stack = stackBefore.filter((_, i) => !remove.has(i));
          console.log(`✓ Facebook webhook duplicate POST routes cleaned AFTER route restoration: kept=${keepIndex}, removed=${remove.size}`);
        } else {
          console.log(`✓ Facebook webhook POST route count after restoration: ${postIndexes.length}`);
        }
      }
    } catch (err) {
      console.error('Facebook webhook route cleanup error:', err.message);
    }

    try {
      const routes = app?._router?.stack
        ?.filter(layer => layer?.route)
        ?.map(layer => layer.route.path)
        ?.filter(path => String(path).includes('webhook'));
      console.log('✓ Facebook webhook routes active:', JSON.stringify(routes || []));
    } catch (err) {
      console.error('Facebook webhook route listing error:', err.message);
    }

    return server;
  };

  express.application.__akexaWebhookFinalizer = true;
}


console.log('✓ Facebook webhook finalizer ready');
