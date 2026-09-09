// Fast and resilient Gemini model compatibility/fallback layer.
// Primary: Gemini 3.5 Flash.
// Fast fallback: Gemini 3.5 Flash-Lite.
// Secondary fallback: Gemini 3.8 Flash.
// The old implementation could wait 5.6s+ per model before falling back.
const originalFetch = global.fetch;

const GEMINI_OLD_PATH = '/models/gemini-2.5-flash:generateContent';
const GEMINI_PRIMARY_PATH = '/models/gemini-3.5-flash:generateContent';
const GEMINI_FALLBACK_PATH = '/models/gemini-3.8-flash:generateContent';
const GEMINI_LITE_PATH = '/models/gemini-3.5-flash-lite:generateContent';

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
// Keep retries bounded: a slow retry chain makes Messenger feel unresponsive.
const MAX_RETRIES = 1;
const RETRY_DELAY_MS = 350;

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

async function fetchWithFastRetry(input, init, label) {
  let lastResponse;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    if (attempt > 0) {
      console.warn(`↻ Gemini ${label} quick retry after ${RETRY_DELAY_MS}ms`);
      await sleep(RETRY_DELAY_MS);
    }

    try {
      const response = await originalFetch.call(this, input, init);
      lastResponse = response;

      if (!RETRYABLE_STATUS.has(response.status)) return response;

      // A 429 means the model is quota/rate limited. Retrying it is usually
      // slower than switching immediately to the lightweight fallback.
      if (response.status === 429) return response;

      console.warn(`⚠ Gemini ${label} returned HTTP ${response.status}`);
    } catch (error) {
      console.warn(`⚠ Gemini ${label} network error: ${error.message}`);
      if (attempt === MAX_RETRIES) throw error;
    }
  }

  return lastResponse;
}

if (typeof originalFetch === 'function') {
  global.fetch = async function (input, init) {
    if (!isGeminiRequest(input)) return originalFetch.call(this, input, init);

    // Lite is deliberately tried before 3.8: it is the low-latency recovery
    // path and avoids waiting through another potentially overloaded model.
    const models = [
      ['gemini-3.5-flash', GEMINI_PRIMARY_PATH],
      ['gemini-3.5-flash-lite', GEMINI_LITE_PATH],
      ['gemini-3.8-flash', GEMINI_FALLBACK_PATH]
    ];

    let lastResponse;

    for (let index = 0; index < models.length; index += 1) {
      const [modelName, modelPath] = models[index];
      const modelInput = rewriteGeminiUrl(input, modelPath);

      if (index === 0) console.log('✓ Gemini primary: gemini-3.5-flash');
      else console.warn(`⚠ Switching to Gemini fallback: ${modelName}`);

      const response = await fetchWithFastRetry(modelInput, init, modelName);
      lastResponse = response;

      if (response && response.ok) {
        if (index > 0) console.log(`✓ Gemini fallback succeeded with ${modelName}`);
        return response;
      }

      const status = response ? response.status : 'unknown';
      console.error(`✗ Gemini ${modelName} failed (HTTP ${status}); trying next model`);
    }

    console.error('✗ All Gemini models exhausted; returning final provider response');
    return lastResponse;
  };
}
