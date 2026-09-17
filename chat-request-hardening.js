// Normalize Agent Test /chat requests before the existing route handler runs.
// Additive compatibility layer: never replaces the existing /chat handler.
const express = require('express');

const proto = express.application;
if (!proto.__akexaChatRequestHardening) {
  const originalPost = proto.post;

  proto.post = function patchedPost(path, ...handlers) {
    if (path === '/chat' && handlers.length) {
      handlers = handlers.map(handler => {
        if (typeof handler !== 'function') return handler;
        return function akexaChatRequestAdapter(req, res, next) {
          try {
            let body = req.body;
            if (typeof body === 'string') {
              try { body = JSON.parse(body); } catch (_) {}
            }
            if (!body || typeof body !== 'object') body = {};

            const aliases = ['message', 'text', 'prompt', 'input', 'query', 'content'];
            let message = '';
            for (const key of aliases) {
              if (typeof body[key] === 'string' && body[key].trim()) {
                message = body[key].trim();
                break;
              }
            }

            let history = body.history;
            if (typeof history === 'string') {
              try { history = JSON.parse(history); } catch (_) { history = []; }
            }
            if (!Array.isArray(history)) history = [];

            history = history.map(item => {
              if (!item || typeof item !== 'object') return null;
              const role = item.role === 'assistant' ? 'model' : item.role;
              const parts = Array.isArray(item.parts)
                ? item.parts
                : (typeof item.text === 'string' ? [{ text: item.text }] : []);
              return { ...item, role, parts };
            }).filter(item => item && item.parts.length);

            if (message) {
              const last = history[history.length - 1];
              const lastText = last?.parts?.[0]?.text;
              if (!last || last.role !== 'user' || lastText !== message) {
                history.push({ role: 'user', parts: [{ text: message }] });
              }
            }

            req.body = { ...body, message, history };

            if (!message && history.length === 0) {
              console.warn('⚠ /chat received no message/history. body keys:', Object.keys(body));
            }
          } catch (err) {
            console.error('Chat request normalization error:', err.message);
          }
          return handler.call(this, req, res, next);
        };
      });
    }
    return originalPost.call(this, path, ...handlers);
  };

  proto.__akexaChatRequestHardening = true;
  console.log('✓ Chat request hardening ready');
}
