// Gemini model compatibility and fallback layer.
// Primary: Gemini 3.5 Flash.
// Fallback: Gemini 3.8 Flash when 3.5 is temporarily unavailable or overloaded.
const originalFetch = global.fetch;

const GEMINI_OLD_PATH = '/models/gemini-2.5-flash:generateContent';
const GEMINI_PRIMARY_PATH = '/models/gemini-3.5-flash:generateContent';
const GEMINI_FALLBACK_PATH = '/models/gemini-3.8-flash:generateContent';

function rewriteGeminiUrl(input, targetPath = GEMINI_PRIMARY_PATH) {
  if (typeof input === 'string') {
    return input.includes(GEMINI_OLD_PATH) ? input.replace(GEMINI_OLD_PATH, targetPath) : input;
  }

  if (input instanceof URL) {
    const url = new URL(input.toString());
    if (url.pathname.includes(GEMINI_OLD_PATH)) {
      url.pathname = url.pathname.replace(GEMINI_OLD_PATH, targetPath);
    } else if (url.pathname.includes(GEMINI_PRIMARY_PATH)) {
      url.pathname = url.pathname.replace(GEMINI_PRIMARY_PATH, targetPath);
    }
    return url;
  }

  if (typeof Request !== 'undefined' && input instanceof Request) {
    const url = new URL(input.url);
    if (url.pathname.includes(GEMINI_OLD_PATH)) {
      url.pathname = url.pathname.replace(GEMINI_OLD_PATH, targetPath);
    } else if (url.pathname.includes(GEMINI_PRIMARY_PATH)) {
      url.pathname = url.pathname.replace(GEMINI_PRIMARY_PATH, targetPath);
    }
    return new Request(url, input);
  }

  return input;
}

function isGeminiRequest(input) {
  const value = input instanceof Request || input instanceof URL ? input.url : String(input || '');
  return value.includes('/models/gemini-2.5-flash:generateContent') ||
    value.includes('/models/gemini-3.5-flash:generateContent');
}

if (typeof originalFetch === 'function') {
  global.fetch = async function (input, init) {
    if (!isGeminiRequest(input)) {
      return originalFetch.call(this, input, init);
    }

    const primaryInput = rewriteGeminiUrl(input, GEMINI_PRIMARY_PATH);
    console.log('✓ Gemini model request routed to gemini-3.5-flash');

    const primaryResponse = await originalFetch.call(this, primaryInput, init);

    // 429/5xx commonly indicate temporary capacity/service problems.
    // Retry once with the current stable Gemini 3.8 Flash model.
    if (![429, 500, 502, 503, 504].includes(primaryResponse.status)) {
      return primaryResponse;
    }

    console.warn(`⚠ Gemini 3.5 Flash returned HTTP ${primaryResponse.status}; trying gemini-3.8-flash fallback`);

    const fallbackInput = rewriteGeminiUrl(primaryInput, GEMINI_FALLBACK_PATH);
    const fallbackResponse = await originalFetch.call(this, fallbackInput, init);

    if (fallbackResponse.ok) {
      console.log('✓ Gemini fallback succeeded with gemini-3.8-flash');
    } else {
      console.error(`✗ Gemini fallback failed with HTTP ${fallbackResponse.status}`);
    }

    return fallbackResponse;
  };
}
