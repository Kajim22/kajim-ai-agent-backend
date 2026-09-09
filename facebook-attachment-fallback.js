// Facebook attachment fallback hardening.
// If Meta rejects an image attachment, let the existing text-reply path continue
// instead of failing the whole Messenger response.

const originalFetch = global.fetch;

if (typeof originalFetch === 'function') {
  global.fetch = async function patchedFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input?.url || '';
    const isFacebookSend = url.includes('graph.facebook.com/') && url.includes('/me/messages');

    if (!isFacebookSend || !init?.body) {
      return originalFetch(input, init);
    }

    let body;
    try {
      body = JSON.parse(init.body);
    } catch (_) {
      return originalFetch(input, init);
    }

    const isImageAttachment = body?.message?.attachment?.type === 'image';
    if (!isImageAttachment) {
      return originalFetch(input, init);
    }

    const response = await originalFetch(input, init);
    if (response.ok) return response;

    let errorMessage = response.statusText || 'Facebook attachment request failed';
    try {
      const data = await response.clone().json();
      errorMessage = data?.error?.message || errorMessage;
    } catch (_) {}

    console.warn(`⚠ Facebook image attachment failed; continuing with text reply: ${errorMessage}`);

    // Return a synthetic successful response so the existing server.js flow
    // can continue and send the normal text reply immediately afterwards.
    return new Response(
      JSON.stringify({ recipient_id: body?.recipient?.id || '', message_id: 'attachment-fallback' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };
}
