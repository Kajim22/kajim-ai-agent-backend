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

    // express-final-init-repair wraps/restores routes inside its own listen
    // wrapper. We must let the full listen chain finish first, then clean the
    // final Express stack in the callback scheduled after server startup.
    const originalCallback = typeof args[args.length - 1] === 'function'
      ? args[args.length - 1]
      : null;

    if (originalCallback) {
      args[args.length - 1] = (...callbackArgs) => {
        try {
          const stack = app?._router?.stack;
          if (Array.isArray(stack)) {
            const postIndexes = [];
            for (let i = 0; i < stack.length; i++) {
              const layer = stack[i];
              if (layer?.route?.path === '/webhook' && layer.route.methods?.post) {
                postIndexes.push(i);
              }
            }

            // Keep only the final /webhook POST route. server.js registers
            // facebookWebhookHandler last; earlier routes are compatibility aliases.
            if (postIndexes.length > 1) {
              const remove = new Set(postIndexes.slice(0, -1));
              app._router.stack = stack.filter((_, i) => !remove.has(i));
              console.log(`✓ Facebook webhook duplicate POST routes cleaned AFTER full listen chain: kept=${postIndexes[postIndexes.length - 1]}, removed=${remove.size}`);
            } else {
              console.log(`✓ Facebook webhook POST route count after full listen chain: ${postIndexes.length}`);
            }

            const routes = app._router.stack
              .filter(layer => layer?.route)
              .map(layer => layer.route.path)
              .filter(path => String(path).includes('webhook'));
            console.log('✓ Facebook webhook routes active:', JSON.stringify(routes));
          }
        } catch (err) {
          console.error('Facebook webhook final cleanup error:', err.message);
        }

        return originalCallback(...callbackArgs);
      };
    }

    return originalListen.apply(this, args);
  };

  express.application.__akexaWebhookFinalizer = true;
}


console.log('✓ Facebook webhook finalizer ready');
