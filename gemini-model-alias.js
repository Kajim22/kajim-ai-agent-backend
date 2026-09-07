// Gemini model compatibility alias.
// The backend currently uses Gemini 2.5 Flash in several endpoints.
// Route those existing GenerateContent requests to the stable Gemini 3.5 Flash model
// without changing the request/response handling in the existing integrations.
const originalFetch = global.fetch;

if (typeof originalFetch === 'function') {
  global.fetch = function (input, init) {
    if (typeof input === 'string' && input.includes('/models/gemini-2.5-flash:generateContent')) {
      input = input.replace('/models/gemini-2.5-flash:generateContent', '/models/gemini-3.5-flash:generateContent');
    }
    return originalFetch.call(this, input, init);
  };
}
