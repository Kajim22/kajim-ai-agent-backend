// Gemini model compatibility alias.
// Force every existing Gemini 2.5 Flash GenerateContent request to use
// the stable Gemini 3.5 Flash model, including URL/Request inputs.
const originalFetch = global.fetch;

function rewriteGeminiUrl(input) {
  const oldPath = '/models/gemini-2.5-flash:generateContent';
  const newPath = '/models/gemini-3.5-flash:generateContent';

  if (typeof input === 'string') {
    return input.includes(oldPath) ? input.replace(oldPath, newPath) : input;
  }

  if (input instanceof URL) {
    const url = new URL(input.toString());
    if (url.pathname.includes(oldPath)) {
      url.pathname = url.pathname.replace(oldPath, newPath);
    }
    return url;
  }

  if (typeof Request !== 'undefined' && input instanceof Request) {
    const url = new URL(input.url);
    if (url.pathname.includes(oldPath)) {
      url.pathname = url.pathname.replace(oldPath, newPath);
      return new Request(url, input);
    }
  }

  return input;
}

if (typeof originalFetch === 'function') {
  global.fetch = function (input, init) {
    const rewrittenInput = rewriteGeminiUrl(input);
    if (rewrittenInput !== input) {
      console.log('✓ Gemini model request routed to gemini-3.5-flash');
    }
    return originalFetch.call(this, rewrittenInput, init);
  };
}
