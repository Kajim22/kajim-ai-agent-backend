// Optional startup bootstrap for protecting dashboard/API routes.
// Enable in Render with: NODE_OPTIONS=--require=./auth-bootstrap.js
const express = require('express');
const { requireSupabaseUser } = require('./auth-middleware');

const originalUse = express.application.use;
let installed = false;

express.application.use = function patchedUse(...args) {
  const result = originalUse.apply(this, args);

  // Install once, immediately after the JSON middleware is registered.
  if (!installed && args.length === 1 && typeof args[0] === 'function') {
    installed = true;
    originalUse.call(this, (req, res, next) => {
      const path = req.path || '';
      const publicWebhook = path.startsWith('/telegram/webhook/') || path === '/webhook/facebook';
      if (publicWebhook) return next();
      return requireSupabaseUser(req, res, next);
    });
  }

  return result;
};
