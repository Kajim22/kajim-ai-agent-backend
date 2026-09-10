const express = require('express');

// Some additive API modules used to register routes directly on
// express.application before the real app existed. Express then created its
// internal router on the prototype and initialized expressInit with an object
// that has no request/response prototypes, causing:
// TypeError: Object prototype may only be an Object or null: undefined
//
// Repair this without changing those modules: keep their route layers, remove
// the accidental prototype router, and attach only the route layers to the
// real app immediately before listen().
const proto = express.application;
const protoRouter = proto && proto._router;
const preloadedRoutes = protoRouter && Array.isArray(protoRouter.stack)
  ? protoRouter.stack.filter(layer => layer && layer.route)
  : [];

if (protoRouter) {
  delete proto._router;
}

const originalListen = proto.listen;
proto.listen = function repairedListen(...args) {
  if (preloadedRoutes.length) {
    this.lazyrouter();
    for (const layer of preloadedRoutes) {
      if (!this._router.stack.includes(layer)) this._router.stack.push(layer);
    }
  }
  return originalListen.apply(this, args);
};

console.log(`✓ Express preload repair ready (${preloadedRoutes.length} preloaded routes)`);
