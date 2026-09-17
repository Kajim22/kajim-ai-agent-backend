// Rescue /chat responses when the legacy handler returns an empty-message fallback.
const express = require('express');

if (!express.application.__akexaChatRouteRescue) {
  const originalPost = express.application.post;

  express.application.post = function patchedPost(path, ...handlers) {
    if (path === '/chat' && handlers.length) {
      handlers = handlers.map(handler => {
        if (typeof handler !== 'function') return handler;
        return async function akexaChatRouteRescue(req, res, next) {
          const originalStatus = res.status.bind(res);
          const originalJson = res.json.bind(res);
          let statusCode = 200;
          let sent = false;

          res.status = code => {
            statusCode = code;
            return res;
          };

          res.json = async payload => {
            const reply = payload && typeof payload.reply === 'string' ? payload.reply : '';
            const message = String(req.body?.message || req.body?.text || req.body?.prompt || '').trim();
            const needsRescue = message && (
              !reply.trim() ||
              reply.includes('বার্তা পাওয়া যায়নি') ||
              reply.includes('উত্তর পাইনি')
            );

            if (!needsRescue || sent) {
              sent = true;
              res.statusCode = statusCode;
              return originalJson(payload);
            }

            try {
              const key = process.env.GEMINI_API_KEY;
              if (!key) {
                sent = true;
                res.statusCode = statusCode;
                return originalJson(payload);
              }

              const history = Array.isArray(req.body?.history) ? req.body.history : [];
              const contents = history
                .filter(x => x && Array.isArray(x.parts) && x.parts.some(p => typeof p?.text === 'string' && p.text.trim()))
                .map(x => ({
                  role: x.role === 'assistant' ? 'model' : (x.role || 'user'),
                  parts: x.parts.filter(p => typeof p?.text === 'string' && p.text.trim()).map(p => ({ text: p.text }))
                }));

              if (!contents.length || contents[contents.length - 1].role !== 'user' || contents[contents.length - 1].parts[0].text !== message) {
                contents.push({ role: 'user', parts: [{ text: message }] });
              }

              const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  system_instruction: { parts: [{ text: req.body?.systemPrompt || 'তুমি একজন সহকারী।' }] },
                  contents
                })
              });
              const data = await response.json();
              const rescued = data?.candidates?.[0]?.content?.parts?.map(p => p?.text || '').join('').trim() || data?.error?.message || reply || 'দুঃখিত, কোনো উত্তর পাওয়া যায়নি।';
              sent = true;
              res.statusCode = 200;
              return originalJson({ reply: rescued, response: rescued, text: rescued, message: rescued, rescued: true });
            } catch (err) {
              sent = true;
              res.statusCode = statusCode;
              return originalJson({ ...payload, rescueError: err.message });
            }
          };

          try {
            return await handler.call(this, req, res, next);
          } catch (err) {
            return next(err);
          }
        };
      });
    }
    return originalPost.call(this, path, ...handlers);
  };

  express.application.__akexaChatRouteRescue = true;
  console.log('✓ Chat route rescue ready');
}
