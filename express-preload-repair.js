const express = require('express');
const request = require('express/lib/request');
const response = require('express/lib/response');

// Some additive API modules register routes directly on express.application
// before server.js creates the real app. That can leave a prototype router in
// place and, in some startup orders, Express request/response prototypes can
// also be missing. expressInit then crashes at setPrototypeOf(..., undefined).
const proto = express.application;

// Defensive repair: Express normally creates these in express/lib/express.js.
// Re-create them only when missing; never replace valid prototypes.
if (!proto.request || (typeof proto.request !== 'object' && typeof proto.request !== 'function')) {
  proto.request = Object.create(request);
}
if (!proto.response || (typeof proto.response !== 'object' && typeof proto.response !== 'function')) {
  proto.response = Object.create(response);
}

const protoRouter = proto && proto._router;
const preloadedRoutes = protoRouter && Array.isArray(protoRouter.stack)
  ? protoRouter.stack.filter(layer => layer && layer.route)
  : [];

if (protoRouter) {
  delete proto._router;
}

// Install the repair only once. This matters if the preload is evaluated more
// than once by a deployment/runtime wrapper.
if (!proto.__akexaExpressPreloadRepair) {
  const originalListen = proto.listen;
  proto.listen = function repairedListen(...args) {
    // Make sure the real application has a router before attaching the legacy
    // preloaded route layers.
    if (preloadedRoutes.length) {
      this.lazyrouter();
      for (const layer of preloadedRoutes) {
        if (!this._router.stack.includes(layer)) this._router.stack.push(layer);
      }
    }
    return originalListen.apply(this, args);
  };
  proto.__akexaExpressPreloadRepair = true;
}

console.log(`✓ Express preload repair ready (${preloadedRoutes.length} preloaded routes)`);
