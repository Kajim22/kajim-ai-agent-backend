// Final order-confirmation hardening layer.
// Loaded after order-save-reliability.js so order extraction never needs Gemini quota.
const fs = require('fs');
const Module = require('module');
const path = require('path');

const previousLoader = Module._extensions['.js'];

Module._extensions['.js'] = function orderConfirmationFinalizerLoader(module, filename) {
  if (path.basename(filename) !== 'server.js') return previousLoader(module, filename);

  let source = fs.readFileSync(filename, 'utf8');

  const replacement = `async function extractOrderInfo(historyArr) {
  const messages = (historyArr || []).filter(m => m.role === 'user');
  const text = messages.map(m =>
    (m.parts || []).map(p => p.text || '').join(' ')
  ).join(' ');

  const normalized = text.replace(/[০-৯]/g, d => '০১২৩৪৫৬৭৮৯'.indexOf(d));
  const phoneMatch = normalized.match(/(?:\\+?88)?01[3-9]\\d{8}/);
  if (!phoneMatch) return { complete: false };

  const customer_phone = phoneMatch[0].replace(/^88/, '');

  let customer_name = '';
  const namePatterns = [
    /(?:আমার নাম|নাম|my name is)\\s*[:：-]?\\s*([^,\\n।]+)/i,
    /(?:আমি|i am)\\s+([^,\\n।]{2,40})/i
  ];
  for (const pattern of namePatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      customer_name = match[1].trim();
      break;
    }
  }

  let customer_address = '';
  const addressPatterns = [
    /(?:ঠিকানা|address|এড্রেস)\\s*[:：-]?\\s*([^\\n।]+)/i,
    /(?:থাকি|বাসা|বাড়ি|বাড়ি|বাসস্থান)\\s*[:：-]?\\s*([^\\n।]+)/i
  ];
  for (const pattern of addressPatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      customer_address = match[1].trim();
      break;
    }
  }

  if (!customer_address) return { complete: false };
  if (!customer_name) customer_name = 'গ্রাহক';

  const productKeywords = /টি-?শার্ট|t-?shirt|গেঞ্জি|পাঞ্জাবি|শার্ট|প্যান্ট|জামা|কাপড়|কাপড়|জুতা|ব্যাগ|ছাতা|product|পণ্য|অর্ডার/i;
  let order_details = '';
  for (const message of messages) {
    const messageText = (message.parts || []).map(p => p.text || '').join(' ').trim();
    if (messageText && productKeywords.test(messageText) &&
        !/^(হ্যাঁ|জি|জ্বি|ঠিক আছে|ঠিক|কনফার্ম|confirm|confirmed|নিশ্চিত)$/i.test(messageText)) {
      order_details = messageText;
    }
  }

  if (!order_details) order_details = 'Confirmed order';

  return {
    complete: true,
    customer_name,
    customer_address,
    customer_phone,
    order_details
  };
}`;

  const start = source.indexOf('async function extractOrderInfo(historyArr) {');
  const end = source.indexOf('\n\nasync function saveOrderAndNotify', start);
  if (start < 0 || end < 0) {
    throw new Error('Order confirmation finalizer: extractOrderInfo block not found');
  }

  source = source.slice(0, start) + replacement + source.slice(end);

  source = source.replace(
    /if \(!bot\.orderSaved\[chatId\] && hasPhoneNumber && customerConfirmedOrder\(bot\.histories\[chatId\]\)\)/g,
    'if (!bot.orderSaved[chatId] && customerConfirmedOrder(bot.histories[chatId]))'
  );
  source = source.replace(
    /if \(!page\.orderSaved\[senderId\] && hasPhoneNumber && customerConfirmedOrder\(page\.histories\[senderId\]\)\)/g,
    'if (!page.orderSaved[senderId] && customerConfirmedOrder(page.histories[senderId]))'
  );

  return module._compile(source, filename);
};
