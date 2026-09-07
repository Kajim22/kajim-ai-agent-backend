// Compatibility alias for Meta webhook verification.
// Keeps the canonical /webhook/facebook endpoint while also accepting /webhook.
const express = require('express');

const originalGet = express.application.get;

express.application.get = function (path, ...handlers) {
  const result = originalGet.call(this, path, ...handlers);

  if (path === '/webhook/facebook') {
    originalGet.call(this, '/webhook', ...handlers);
  }

  return result;
};
