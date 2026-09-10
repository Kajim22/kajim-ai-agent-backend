// Final Express safety net. This file MUST be preloaded immediately before server.js.
// Legacy additive modules register routes on express.application before the real
// app is created. Capture those routes here, then attach them to the real app
// when it starts listening. Also repair app.request/app.response only on the
// concrete app instance, never on the global request/response prototypes.
const express = require('express');
const requestPrototype = require('express/lib/request');
const responsePrototype = require('express/lib/response');

const proto = express.application;
const protoRouter = proto && proto._router;
const preloadedRoutes = protoRouter && Array.isArray(protoRouter.stack)
  ? protoRouter.stack.filter(layer => layer && layer.route)
  : [];

if (protoRouter) delete proto._router;

if (!proto.__akexaFinalExpressRepair) {
  const originalLazyRouter = proto.lazyrouter;
  const originalListen = proto.listen;

  proto.lazyrouter = function repairedLazyRouter(...args) {
    if (!this.request || typeof this.request !== 'object') {
      this.request = Object.create(requestPrototype);
    }
    if (!this.response || typeof this.response !== 'object') {
      this.response = Object.create(responsePrototype);
    }
    return originalLazyRouter.apply(this, args);
  };

  proto.listen = function repairedListen(...args) {
    if (preloadedRoutes.length) {
      this.lazyrouter();
      for (const layer of preloadedRoutes) {
        if (!this._router.stack.includes(layer)) this._router.stack.push(layer);
      }
    }
    return originalListen.apply(this, args);
  };

  proto.__akexaFinalExpressRepair = true;
}

console.log(`✓ Final Express init repair ready (${preloadedRoutes.length} preloaded routes)`);
