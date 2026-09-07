// Resilient Gemini model compatibility and fallback layer.
// Primary: Gemini 3.5 Flash.
// Fallbacks: Gemini 3.8 Flash -> Gemini 3.5 Flash-Lite.
// Temporary 429/5xx errors are retried with short exponential backoff.
const originalFetch = global.fetch;

const GEMINI_OLD_PATH = '/models/gemini-2.5-flash:generateContent';
const GEMINI_PRIMARY_PATH = '/models/gemini-3.5-flash:generateContent';
const GEMINI_FALLBACK_PATH = '/models/gemini-3.8-flash:generateContent';
const GEMINI_LITE_PATH = '/models/gemini-3.5-flash-lite:generateContent';

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [800, 1600, 3200];

function rewriteGeminiUrl(input, targetPath = GEMINI_PRIMARY_PATH) {
  if (typeof input === 'string') {
    for (const modelPath of [GEMINI_OLD_PATH, GEMINI_PRIMARY_PATH, GEMINI_FALLBACK_PATH, GEMINI_LITE_PATH]) {
      if (input.includes(modelPath)) return input.replace(modelPath, targetPath);
    }
    return input;
  }

  if (input instanceof URL) {
    const url = new URL(input.toString());
    for (const modelPath of [GEMINI_OLD_PATH, GEMINI_PRIMARY_PATH, GEMINI_FALLBACK_PATH, GEMINI_LITE_PATH]) {
      if (url.pathname.includes(modelPath)) {
        url.pathname = url.pathname.replace(modelPath, targetPath);
        break;
      }
    }
    return url;
  }

  if (typeof Request !== 'undefined' && input instanceof Request) {
    const url = new URL(input.url);
    for (const modelPath of [GEMINI_OLD_PATH, GEMINI_PRIMARY_PATH, GEMINI_FALLBACK_PATH, GEMINI_LITE_PATH]) {
      if (url.pathname.includes(modelPath)) {
        url.pathname = url.pathname.replace(modelPath, targetPath);
        break;
      }
    }
    return new Request(url, input);
  }

  return input;
}

function isGeminiRequest(input) {
  const value = input instanceof Request || input instanceof URL ? input.url : String(input || '');
  return value.includes('/models/gemini-2.5-flash:generateContent') ||
    value.includes('/models/gemini-3.5-flash:generateContent') ||
    value.includes('/models/gemini-3.8-flash:generateContent') ||
    value.includes('/models/gemini-3.5-flash-lite:generateContent');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetries(input, init, label) {
  let lastResponse;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[attempt - 1];
      console.warn(`↻ Gemini ${label} retry ${attempt}/${RETRY_DELAYS_MS.length} after ${delay}ms`);
      await sleep(delay);
    }

    try {
      const response = await originalFetch.call(this, input, init);
      lastResponse = response;

      if (!RETRYABLE_STATUS.has(response.status)) return response;
      console.warn(`⚠ Gemini ${label} returned HTTP ${response.status}`);
    } catch (error) {
      console.warn(`⚠ Gemini ${label} network error: ${error.message}`);
      if (attempt === RETRY_DELAYS_MS.length) throw error;
    }
  }

  return lastResponse;
}

if (typeof originalFetch === 'function') {
  global.fetch = async function (input, init) {
    if (!isGeminiRequest(input)) return originalFetch.call(this, input, init);

    const models = [
      ['gemini-3.5-flash', GEMINI_PRIMARY_PATH],
      ['gemini-3.8-flash', GEMINI_FALLBACK_PATH],
      ['gemini-3.5-flash-lite', GEMINI_LITE_PATH]
    ];

    let lastResponse;

    for (let index = 0; index < models.length; index += 1) {
      const [modelName, modelPath] = models[index];
      const modelInput = rewriteGeminiUrl(input, modelPath);

      if (index === 0) console.log('✓ Gemini primary: gemini-3.5-flash');
      else console.warn(`⚠ Switching to Gemini fallback: ${modelName}`);

      const response = await fetchWithRetries(modelInput, init, modelName);
      lastResponse = response;

      if (response && response.ok) {
        if (index > 0) console.log(`✓ Gemini fallback succeeded with ${modelName}`);
        return response;
      }

      const status = response ? response.status : 'unknown';
      console.error(`✗ Gemini ${modelName} exhausted retries (HTTP ${status})`);
    }

    console.error('✗ All Gemini models exhausted; returning final provider response');
    return lastResponse;
  };
}
