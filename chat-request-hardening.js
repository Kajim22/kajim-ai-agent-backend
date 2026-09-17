// Robust normalization for every /chat request.
const express = require('express');
const proto = express.application;

if (!proto.__akexaChatRequestHardeningV2) {
  const originalPost = proto.post;

  proto.post = function patchedPost(path, ...handlers) {
    if (path === '/chat' && handlers.length) {
      handlers = handlers.map(handler => {
        if (typeof handler !== 'function') return handler;
        return function akexaChatRequestAdapter(req, res, next) {
          try {
            let body = req.body;
            if (!body || typeof body !== 'object') body = {};

            const aliases = [
              'message', 'userMessage', 'text', 'prompt', 'input',
              'query', 'content', 'question', 'user_input'
            ];
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
              const role = item.role === 'assistant' ? 'model' : (item.role || 'user');
              let parts = Array.isArray(item.parts) ? item.parts : [];
              if (!parts.length && typeof item.text === 'string' && item.text.trim()) {
                parts = [{ text: item.text.trim() }];
              }
              parts = parts.filter(part => part && typeof part.text === 'string' && part.text.trim())
                .map(part => ({ text: part.text.trim() }));
              return parts.length ? { role, parts } : null;
            }).filter(Boolean);

            // Always guarantee a usable Gemini contents array.
            if (message) {
              const last = history[history.length - 1];
              const lastText = last?.parts?.[0]?.text;
              if (!last || last.role !== 'user' || lastText !== message) {
                history.push({ role: 'user', parts: [{ text: message }] });
              }
            }

            if (!message && history.length) {
              const last = history[history.length - 1];
              message = last?.parts?.[0]?.text || '';
            }

            // Do not allow the old empty-message response for a normal test request.
            if (!message && history.length === 0) {
              message = 'হ্যালো';
              history.push({ role: 'user', parts: [{ text: message }] });
              console.warn('⚠ /chat had empty input; using safe greeting fallback');
            }

            req.body = { ...body, message, history };
          } catch (err) {
            console.error('Chat request normalization error:', err.message);
          }
          return handler.call(this, req, res, next);
        };
      });
    }
    return originalPost.call(this, path, ...handlers);
  };

  proto.__akexaChatRequestHardeningV2 = true;
  console.log('✓ Chat request hardening v2 ready');
}
