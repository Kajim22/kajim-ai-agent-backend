// Final order-verification accuracy layer.
// This preload runs after order-save-reliability.js.
// It ONLY improves extraction quality. The actual save gate remains the
// explicit customer confirmation implemented by order-save-reliability.js.
const fs = require('fs');
const Module = require('module');
const path = require('path');

const previousLoader = Module._extensions['.js'];

Module._extensions['.js'] = function orderVerificationAccuracyLoader(module, filename) {
  if (path.basename(filename) !== 'server.js') return previousLoader(module, filename);

  let source = fs.readFileSync(filename, 'utf8');

  const replacement = `async function extractOrderInfo(historyArr) {
  const messages = (historyArr || []).filter(m => m.role === 'user');
  const userTexts = messages
    .map(m => (m.parts || []).map(p => p.text || '').join(' ').trim())
    .filter(Boolean);
  const allText = userTexts.join(' ');
  const normalized = allText.replace(/[০-৯]/g, d => '০১২৩৪৫৬৭৮৯'.indexOf(d));
  const clean = value => String(value || '').replace(/^[-:：\\s]+|[-:：\\s]+$/g, '').trim();

  let customer_name = '';
  let customer_address = '';
  let customer_phone = '';

  const namePatterns = [
    /(?:আমার নাম|নাম|name|my name is)\\s*[:：-]?\\s*([^,\\n।!?]+)/i
  ];
  const addressPatterns = [
    /(?:ঠিকানা|address|এড্রেস)\\s*[:：-]?\\s*([^\\n।]+)/i,
    /(?:থাকি|বাসা|বাড়ি|বাড়ি|বাসস্থান)\\s*[:：-]?\\s*([^\\n।]+)/i
  ];

  for (const pattern of namePatterns) {
    const match = allText.match(pattern);
    if (match && match[1]) { customer_name = clean(match[1]); break; }
  }
  for (const pattern of addressPatterns) {
    const match = allText.match(pattern);
    if (match && match[1]) { customer_address = clean(match[1]); break; }
  }

  const phoneMatch = normalized.match(/(?:\\+?88)?01[3-9]\\d{8}/);
  if (phoneMatch) customer_phone = phoneMatch[0].replace(/^88/, '');

  // If the bot previously asked for a specific field, accept the customer's
  // following answer as that field when no explicit label was used.
  for (let i = 0; i < (historyArr || []).length - 1; i++) {
    const current = historyArr[i];
    const next = historyArr[i + 1];
    if (current?.role !== 'model' || next?.role !== 'user') continue;

    const prompt = clean((current.parts || []).map(p => p.text || '').join(' ')).toLowerCase();
    const answer = clean((next.parts || []).map(p => p.text || '').join(' '));
    if (!answer) continue;

    if (!customer_name && /নাম|name/.test(prompt) && !/ঠিকানা|address|ফোন|phone|নাম্বার|number/.test(prompt)) {
      customer_name = answer;
    }
    if (!customer_address && /ঠিকানা|address|এড্রেস|কোথায়|কোথায়|থাকেন|বাসা/.test(prompt) && !/ফোন|phone|নাম্বার|number/.test(prompt)) {
      customer_address = answer;
    }
    if (!customer_phone && /ফোন|phone|নাম্বার|number/.test(prompt)) {
      const n = answer.replace(/[০-৯]/g, d => '০১২৩৪৫৬৭৮৯'.indexOf(d)).match(/(?:\\+?88)?01[3-9]\\d{8}/);
      if (n) customer_phone = n[0].replace(/^88/, '');
    }
  }

  // Do NOT classify general inquiries as orders. A real order must contain:
  // 1) a recognizable product, and 2) a quantity. Questions such as
  // "কি কি পণ্য আছে?" or "অর্ডার করতে চাই" alone are never order details.
  const productPattern = /টি-?শার্ট|t-?shirt|গেঞ্জি|পাঞ্জাবি|শার্ট|প্যান্ট|জামা|কাপড়|কাপড়|জুতা|ব্যাগ|ছাতা|পণ্য/i;
  const quantityPattern = /(?:\\d+|[০-৯]+)\\s*(?:টা|টি|পিস|pcs|piece|pieces|জোড়া|জোড়া|pair|কপি)|(?:এক|দুই|তিন|চার|পাঁচ|ছয়|ছয়|সাত|আট|নয়|নয়|দশ)\\s*(?:টা|টি|পিস|জোড়া|জোড়া|কপি)?/i;
  const inquiryOnly = /^(?:অর্ডার করতে চাই|অর্ডার করতে চাই\\s*[।.!?]?|কি কি পণ্য আছে|কী কী পণ্য আছে|কি কি পণ্য আছে[?!.]|কী কী পণ্য আছে[?!.]|পণ্য কি কি আছে|পণ্যের লিস্ট দিন|প্রোডাক্ট কি কি আছে)[\\s?!.।]*$/i;

  let order_details = '';
  for (const text of userTexts) {
    if (inquiryOnly.test(text)) continue;
    if (productPattern.test(text) && quantityPattern.test(text)) {
      order_details = text;
    }
  }

  // Also allow a product line and a separate quantity answer in the same
  // conversation, e.g. "গেঞ্জি" followed by "২টা".
  if (!order_details) {
    const productText = userTexts.find(text => productPattern.test(text) && !inquiryOnly.test(text));
    const quantityText = userTexts.find(text => quantityPattern.test(text));
    if (productText && quantityText) {
      order_details = productText + ' — ' + quantityText;
    }
  }

  // Require all order-critical fields before declaring the draft complete.
  // The final save is still separately gated by explicit "জি/কনফার্ম/...".
  if (!customer_name || !customer_address || !customer_phone || !order_details) {
    return { complete: false };
  }

  return {
    complete: true,
    customer_name,
    customer_address,
    customer_phone,
    order_details
  };
}`;

  const start = source.indexOf('async function extractOrderInfo(historyArr) {');
  const end = source.indexOf('\\n\\nasync function saveOrderAndNotify', start);
  if (start < 0 || end < 0) {
    throw new Error('Order verification accuracy: extractOrderInfo block not found');
  }

  source = source.slice(0, start) + replacement + source.slice(end);

  // IMPORTANT: do not modify the save/confirmation gates here.
  // order-save-reliability.js must remain authoritative: an order is saved only
  // after the customer explicitly confirms it.

  return module._compile(source, filename);
};
