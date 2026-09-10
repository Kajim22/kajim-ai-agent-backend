// Normalize Gemini fetch responses so downstream code gets a fresh, unreadable-once Response body.
// This prevents Undici's "Body is unusable: Body has already been read" when multiple
// compatibility layers inspect the same Gemini response.
const previousFetch = global.fetch;

function isGeminiUrl(input) {
  const value = input instanceof Request || input instanceof URL ? input.url : String(input || '');
  return value.includes('generativelanguage.googleapis.com') && value.includes(':generateContent');
}

if (typeof previousFetch === 'function' && !global.__akexaGeminiResponseBufferInstalled) {
  global.__akexaGeminiResponseBufferInstalled = true;
  global.fetch = async function (input, init) {
    const response = await previousFetch.call(this, input, init);
    if (!isGeminiUrl(input)) return response;

    if (response.bodyUsed) {
      console.error('⚠ Gemini response arrived already consumed; returning it unchanged');
      return response;
    }

    try {
      const raw = await response.text();
      return new Response(raw, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    } catch (err) {
      console.error('Gemini response buffering error:', err.message);
      return response;
    }
  };

  console.log('✓ Gemini response buffer ready');
}
