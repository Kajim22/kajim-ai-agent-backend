// Facebook image delivery hardening.
// For outgoing Messenger image messages, upload the remote image to Meta's
// Attachment Upload API first, then send the returned attachment_id.
// This avoids relying on the Send API to fetch the public image URL during
// the final message send and keeps the existing server.js contract unchanged.

const originalFetch = global.fetch;

function isFacebookSendRequest(url, options) {
  if (!url || !options || String(options.method || 'GET').toUpperCase() !== 'POST') return false;
  try {
    const parsed = new URL(String(url));
    return parsed.hostname === 'graph.facebook.com' && /\/me\/messages$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

function isImageMessage(body) {
  return body?.message?.attachment?.type === 'image' &&
    typeof body?.message?.attachment?.payload?.url === 'string' &&
    /^https:\/\//i.test(body.message.attachment.payload.url);
}

async function uploadRemoteImage(graphUrl, imageUrl) {
  const uploadUrl = String(graphUrl).replace(/\/me\/messages$/, '/me/message_attachments');
  const host = new URL(imageUrl).hostname;

  console.log(`Facebook image upload: host=${host}`);

  const uploadResponse = await originalFetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        attachment: {
          type: 'image',
          payload: {
            url: imageUrl,
            is_reusable: true
          }
        }
      }
    })
  });

  const uploadData = await uploadResponse.json().catch(() => ({}));
  if (!uploadResponse.ok || uploadData?.error || !uploadData?.attachment_id) {
    const message = uploadData?.error?.message || uploadResponse.statusText || 'attachment upload failed';
    throw new Error(`Facebook image upload failed (${host}): ${message}`);
  }

  console.log('✓ Facebook image attachment uploaded');
  return uploadData.attachment_id;
}

global.fetch = async function facebookImageFetch(url, options = {}) {
  if (!isFacebookSendRequest(url, options)) {
    return originalFetch(url, options);
  }

  let body;
  try {
    body = typeof options.body === 'string' ? JSON.parse(options.body) : null;
  } catch {
    body = null;
  }

  if (!isImageMessage(body)) {
    return originalFetch(url, options);
  }

  const imageUrl = body.message.attachment.payload.url;
  try {
    const attachmentId = await uploadRemoteImage(url, imageUrl);
    body.message.attachment.payload = { attachment_id: attachmentId };

    const nextOptions = {
      ...options,
      body: JSON.stringify(body)
    };
    return originalFetch(url, nextOptions);
  } catch (err) {
    console.error('Facebook image delivery error:', err.message);
    throw err;
  }
};
