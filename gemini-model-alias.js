// Fast/resilient Gemini compatibility/fallback layer.
// Primary: Gemini 3.5 Flash.
// Fallback: Gemini 3.5 Flash-Lite.
//
// Important: a confirmed order must not depend on a third Gemini model.
// 429 is never retried. Transient 5xx/timeouts get at most one retry.
const originalFetch = global.fetch;

const GEMINI_OLD_PATH = '/models/gemini-2.5-flash:generateContent';
const GEMINI_PRIMARY_PATH = '/models/gemini-3.5-flash:generateContent';
const GEMINI_LITE_PATH = '/models/gemini-3.5-flash-lite:generateContent';

const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);
const MAX_RETRIES = 1;
const RETRY_DELAY_MS = 250;
const REQUEST_TIMEOUT_MS = 6500;
const MODEL_COOLDOWN_MS = 30000;

const unhealthyUntil = new Map();

function rewriteGeminiUrl(input, targetPath = GEMINI_PRIMARY_PATH) {
  if (typeof input === 'string') {
    for (const modelPath of [GEMINI_OLD_PATH, GEMINI_PRIMARY_PATH, GEMINI_LITE_PATH]) {
      if (input.includes(modelPath)) return input.replace(modelPath, targetPath);
    }
    return input;
  }

  if (input instanceof URL) {
    const url = new URL(input.toString());
    for (const modelPath of [GEMINI_OLD_PATH, GEMINI_PRIMARY_PATH, GEMINI_LITE_PATH]) {
      if (url.pathname.includes(modelPath)) {
        url.pathname = url.pathname.replace(modelPath, targetPath);
        break;
      }
    }
    return url;
  }

  if (typeof Request !== 'undefined' && input instanceof Request) {
    const url = new URL(input.url);
    for (const modelPath of [GEMINI_OLD_PATH, GEMINI_PRIMARY_PATH, GEMINI_LITE_PATH]) {
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
    value.includes('/models/gemini-3.5-flash-lite:generateContent');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isCoolingDown(modelName) {
  const until = unhealthyUntil.get(modelName) || 0;
  if (until <= Date.now()) {
    unhealthyUntil.delete(modelName);
    return false;
  }
  return true;
}

function markUnhealthy(modelName, status) {
  if (status === 429 || RETRYABLE_STATUS.has(status)) {
    unhealthyUntil.set(modelName, Date.now() + MODEL_COOLDOWN_MS);
  }
}

function buildInitWithTimeout(init) {
  const nextInit = { ...(init || {}) };
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    if (nextInit.signal && typeof AbortSignal.any === 'function') {
      nextInit.signal = AbortSignal.any([nextInit.signal, timeoutSignal]);
    } else if (!nextInit.signal) {
      nextInit.signal = timeoutSignal;
    }
  }
  return nextInit;
}

async function fetchWithFastRetry(input, init, label) {
  let lastResponse;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    if (attempt > 0) {
      console.warn(`↻ Gemini ${label} quick retry after ${RETRY_DELAY_MS}ms`);
      await sleep(RETRY_DELAY_MS);
    }

    try {
      const response = await originalFetch.call(this, input, buildInitWithTimeout(init));
      lastResponse = response;

      if (response.status === 429) {
        markUnhealthy(label, 429);
        return response;
      }

      if (!RETRYABLE_STATUS.has(response.status)) return response;

      markUnhealthy(label, response.status);
      console.warn(`⚠ Gemini ${label} returned HTTP ${response.status}`);
    } catch (error) {
      console.warn(`⚠ Gemini ${label} network/timeout error: ${error.message}`);
      if (attempt === MAX_RETRIES) throw error;
    }
  }

  return lastResponse;
}

if (typeof originalFetch === 'function') {
  global.fetch = async function (input, init) {
    if (!isGeminiRequest(input)) return originalFetch.call(this, input, init);

    const models = [
      ['gemini-3.5-flash', GEMINI_PRIMARY_PATH],
      ['gemini-3.5-flash-lite', GEMINI_LITE_PATH]
    ];

    let lastResponse;
    let attemptedAny = false;

    for (let index = 0; index < models.length; index += 1) {
      const [modelName, modelPath] = models[index];

      if (isCoolingDown(modelName)) {
        console.warn(`⏭ Skipping Gemini ${modelName}: temporary cooldown`);
        continue;
      }

      attemptedAny = true;
      const modelInput = rewriteGeminiUrl(input, modelPath);

      if (index === 0) console.log('✓ Gemini primary: gemini-3.5-flash');
      else console.warn(`⚠ Switching to Gemini fallback: ${modelName}`);

      try {
        const response = await fetchWithFastRetry(modelInput, init, modelName);
        lastResponse = response;

        if (response && response.ok) {
          if (index > 0) console.log(`✓ Gemini fallback succeeded with ${modelName}`);
          unhealthyUntil.delete(modelName);
          return response;
        }

        const status = response ? response.status : 'unknown';
        console.error(`✗ Gemini ${modelName} failed (HTTP ${status}); trying next model`);
      } catch (error) {
        unhealthyUntil.set(modelName, Date.now() + MODEL_COOLDOWN_MS);
        console.error(`✗ Gemini ${modelName} failed (${error.name || 'Error'}); trying next model`);
      }
    }

    if (!attemptedAny) {
      console.warn('⏭ All Gemini models are cooling down; returning final provider response without another API burst');
    }

    console.error('✗ All Gemini models exhausted; returning final provider response');
    return lastResponse;
  };
}
