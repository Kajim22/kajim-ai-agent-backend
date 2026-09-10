const express = require('express');

// Some additive API modules register routes directly on express.application
// before server.js creates the real app. Capture those route layers, but DO NOT
// create express.application.request/response here. Express itself must create
// those prototypes when express() is called so they get the real app instance
// attached as `.app`.
const proto = express.application;
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
