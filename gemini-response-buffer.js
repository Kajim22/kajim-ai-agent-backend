// Normalize Gemini fetch responses and centralize conversation-context behavior.
// This keeps the existing server/order flow unchanged while making customer replies
// use the latest 10 messages and sound more natural.
const previousFetch = global.fetch;
const MAX_CONVERSATION_MESSAGES = 10;

const NATURAL_REPLY_GUIDANCE = `

Conversation style rules:
- গ্রাহকের সাথে স্বাভাবিক, উষ্ণ ও সংক্ষিপ্তভাবে কথা বলো।
- আগের কথোপকথনের তথ্য মনে রেখে ধারাবাহিকভাবে উত্তর দাও; একই তথ্য অযথা আবার জিজ্ঞেস করো না।
- গ্রাহক যে ভাষায় লিখেছে, সম্ভব হলে সেই ভাষাতেই উত্তর দাও।
- অপ্রয়োজনীয় ভূমিকা, অতিরিক্ত আনুষ্ঠানিকতা, রোবোটিক বাক্য বা একই কথা বারবার বলা এড়িয়ে চলো।
- তথ্য না থাকলে অনুমান কোরো না; প্রয়োজন হলে স্বাভাবিকভাবে শুধু প্রয়োজনীয় প্রশ্নটি করো।
- উত্তরকে মানুষের স্বাভাবিক কথোপকথনের মতো রাখো, তবে ব্যবসার তথ্য ও মূল system prompt-এর নিয়ম অবশ্যই মেনে চলো।`;

function isGeminiUrl(input) {
  const value = input instanceof Request || input instanceof URL ? input.url : String(input || '');
  return value.includes('generativelanguage.googleapis.com') && value.includes(':generateContent');
}

function isOrderExtractionPrompt(payload) {
  const text = payload?.system_instruction?.parts
    ?.map(part => part?.text || '')
    .join('\n') || '';
  return text.includes('তুমি একটা তথ্য বের করার টুল') || text.includes('valid JSON object');
}

function prepareGeminiRequest(init) {
  if (!init || typeof init.body !== 'string') return init;

  try {
    const payload = JSON.parse(init.body);
    if (!payload || typeof payload !== 'object') return init;

    // Keep the internal order-extraction request untouched so existing order
    // detection/save behavior is not weakened by the customer-memory limit.
    if (!isOrderExtractionPrompt(payload) && Array.isArray(payload.contents)) {
      payload.contents = payload.contents.slice(-MAX_CONVERSATION_MESSAGES);
    }

    // Add natural-conversation guidance only to normal customer-facing replies.
    if (!isOrderExtractionPrompt(payload) && payload.system_instruction?.parts?.length) {
      const firstText = payload.system_instruction.parts[0]?.text;
      if (typeof firstText === 'string' && !firstText.includes('Conversation style rules:')) {
        payload.system_instruction.parts[0].text = firstText + NATURAL_REPLY_GUIDANCE;
      }
    }

    return { ...init, body: JSON.stringify(payload) };
  } catch (err) {
    console.error('Gemini request context preparation error:', err.message);
    return init;
  }
}

if (typeof previousFetch === 'function' && !global.__akexaGeminiResponseBufferInstalled) {
  global.__akexaGeminiResponseBufferInstalled = true;
  global.fetch = async function (input, init) {
    const geminiRequest = isGeminiUrl(input);
    const preparedInit = geminiRequest ? prepareGeminiRequest(init) : init;
    const response = await previousFetch.call(this, input, preparedInit);
    if (!geminiRequest) return response;

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

  console.log(`✓ Gemini response buffer ready (customer context: last ${MAX_CONVERSATION_MESSAGES} messages)`);
}
