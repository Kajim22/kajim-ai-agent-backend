// Compatibility alias for Meta webhook verification and delivery.
// Keeps the canonical /webhook/facebook endpoint while also accepting /webhook.
const express = require('express');

const originalGet = express.application.get;
const originalPost = express.application.post;

express.application.get = function (path, ...handlers) {
  const result = originalGet.call(this, path, ...handlers);

  if (path === '/webhook/facebook') {
    originalGet.call(this, '/webhook', ...handlers);
  }

  return result;
};

express.application.post = function (path, ...handlers) {
  const result = originalPost.call(this, path, ...handlers);

  if (path === '/webhook/facebook') {
    originalPost.call(this, '/webhook', ...handlers);
  }

  return result;
};
