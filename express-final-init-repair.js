// Final Express safety net. This file MUST be preloaded immediately before server.js.
// Some legacy preload modules register routes on express.application before the
// real app is created. More importantly, if a preload/runtime leaves app.request
// or app.response undefined, Express's init middleware crashes on the first request.
// Repair only the concrete app instance at lazyrouter time; never mutate the
// global request/response prototypes.
const express = require('express');
const requestPrototype = require('express/lib/request');
const responsePrototype = require('express/lib/response');

const originalLazyRouter = express.application.lazyrouter;

if (!express.application.__akexaFinalInitRepair) {
  express.application.lazyrouter = function repairedLazyRouter(...args) {
    if (!this.request || typeof this.request !== 'object') {
      this.request = Object.create(requestPrototype);
    }
    if (!this.response || typeof this.response !== 'object') {
      this.response = Object.create(responsePrototype);
    }
    return originalLazyRouter.apply(this, args);
  };
  express.application.__akexaFinalInitRepair = true;
}

console.log('✓ Final Express init repair ready');
