// Reliable order confirmation patch. Loaded as a server.js source transformer.
const fs = require('fs');
const Module = require('module');
const path = require('path');

const originalLoader = Module._extensions['.js'];

Module._extensions['.js'] = function orderConfirmationLoader(module, filename) {
  if (path.basename(filename) !== 'server.js') return originalLoader(module, filename);

  let source = fs.readFileSync(filename, 'utf8');

  // Deterministic order extraction. Gemini is deliberately not used here so
  // quota/timeouts can never bypass the confirmation step.
  const extractReplacement = `async function extractOrderInfo(historyArr) {
  const messages = (historyArr || []).filter(m => m.role === 'user');
  const allText = messages.map(m => (m.parts || []).map(p => p.text || '').join(' ')).join(' ');
  const normalized = allText.replace(/[০-৯]/g, d => '০১২৩৪৫৬৭৮৯'.indexOf(d));

  const clean = value => String(value || '').replace(/^[-:：\s]+|[-:：\s]+$/g, '').trim();
  const userTexts = messages.map(m => (m.parts || []).map(p => p.text || '').join(' ').trim()).filter(Boolean);
  const modelMessages = (historyArr || []).filter(m => m.role === 'model').map(m => (m.parts || []).map(p => p.text || '').join(' '));

  let name = '';
  let address = '';
  let phone = '';

  const namePatterns = [
    /(?:আমার নাম|নাম|name|my name is)\\s*[:：-]?\\s*([^,\\n।]+)/i
  ];
  const addressPatterns = [
    /(?:ঠিকানা|address|এড্রেস)\\s*[:：-]?\\s*([^\\n।]+)/i,
    /(?:থাকি|বাসা|বাড়ি|বাড়ি|বাসস্থান)\\s*[:：-]?\\s*([^\\n।]+)/i
  ];

  for (const p of namePatterns) {
    const m = allText.match(p);
    if (m && m[1]) { name = clean(m[1]); break; }
  }
  for (const p of addressPatterns) {
    const m = allText.match(p);
    if (m && m[1]) { address = clean(m[1]); break; }
  }

  const phoneMatch = normalized.match(/(?:\\+?88)?01[3-9]\\d{8}/);
  if (phoneMatch) phone = phoneMatch[0].replace(/^88/, '');

  // If the customer answered the bot's specific question with a plain value,
  // use that answer. This keeps the old conversational flow working.
  for (let i = 0; i < (historyArr || []).length - 1; i++) {
    const current = historyArr[i];
    const next = historyArr[i + 1];
    if (current?.role !== 'model' || next?.role !== 'user') continue;
    const prompt = (current.parts || []).map(p => p.text || '').join(' ').toLowerCase();
    const answer = clean((next.parts || []).map(p => p.text || '').join(' '));
    if (!answer) continue;
    if (!name && /নাম|name/.test(prompt) && !/ঠিকানা|address|ফোন|phone|নাম্বার|number/.test(prompt)) name = answer;
    if (!address && /ঠিকানা|address|এড্রেস/.test(prompt) && !/ফোন|phone|নাম্বার|number/.test(prompt)) address = answer;
    if (!phone && /ফোন|phone|নাম্বার|number/.test(prompt)) {
      const n = answer.replace(/[০-৯]/g, d => '০১২৩৪৫৬৭৮৯'.indexOf(d)).match(/(?:\\+?88)?01[3-9]\\d{8}/);
      if (n) phone = n[0].replace(/^88/, '');
    }
  }

  const confirmationWords = /^(হ্যাঁ|জি|জ্বি|ঠিক আছে|ঠিক|কনফার্ম|confirm|confirmed|নিশ্চিত|নিশ্চিত করছি|অর্ডার দিন|অর্ডার করুন|অর্ডারটা করে দিন|করে দিন|করে দেন)$/i;
  const cancelWords = /^(না|না লাগবে না|বাতিল|ক্যানসেল|cancel|বাদ দিন|বাদ দেন|অর্ডার করবেন না)$/i;
  const productKeywords = /টি-?শার্ট|t-?shirt|গেঞ্জি|পাঞ্জাবি|শার্ট|প্যান্ট|জামা|কাপড়|কাপড়|জুতা|ব্যাগ|ছাতা|পণ্য|অর্ডার/i;
  let orderDetails = '';
  for (const t of userTexts) {
    if (confirmationWords.test(t) || cancelWords.test(t)) continue;
    if (productKeywords.test(t)) orderDetails = t;
  }

  // A draft is complete only when the customer actually supplied all required data.
  if (!name || !address || !phone) return { complete: false };
  if (!orderDetails) orderDetails = 'Customer order';

  return {
    complete: true,
    customer_name: name,
    customer_address: address,
    customer_phone: phone,
    order_details: orderDetails
  };
}
`;

  const extractStart = source.indexOf('async function extractOrderInfo(historyArr) {');
  const extractEnd = source.indexOf('\n\nasync function saveOrderAndNotify', extractStart);
  if (extractStart < 0 || extractEnd < 0) throw new Error('Order confirmation patch: extract block not found');
  source = source.slice(0, extractStart) + extractReplacement + source.slice(extractEnd);

  const confirmationHelper = `
function customerConfirmedOrder(historyArr) {
  const messages = (historyArr || []).filter(m => m.role === 'user');
  if (!messages.length) return false;
  const latest = (messages[messages.length - 1].parts || []).map(p => p.text || '').join(' ').trim();
  if (!latest) return false;
  if (/^(না|না লাগবে না|বাতিল|ক্যানসেল|cancel|বাদ দিন|বাদ দেন|অর্ডার করবেন না)$/i.test(latest)) return false;
  return /^(হ্যাঁ|জি|জ্বি|ঠিক আছে|ঠিক|কনফার্ম|কনফার্ম করুন|confirm|confirmed|নিশ্চিত|নিশ্চিত করছি|অর্ডার দিন|অর্ডার করুন|অর্ডারটা করে দিন|করে দিন|করে দেন)$/i.test(latest);
}

function buildOrderConfirmationReply(orderInfo) {
  return 'আপনার অর্ডারের তথ্যগুলো পেয়েছি।\\n\\n👤 নাম: ' + orderInfo.customer_name + '\\n📍 ঠিকানা: ' + orderInfo.customer_address + '\\n📞 ফোন: ' + orderInfo.customer_phone + '\\n📦 পণ্য: ' + orderInfo.order_details + '\\n\\nঅর্ডারটি কনফার্ম করবেন? কনফার্ম করতে “জি” বা “কনফার্ম” লিখুন।';
}
`;

  if (!source.includes('function customerConfirmedOrder(historyArr)')) {
    const anchor = 'const telegramBots = {};';
    const pos = source.indexOf(anchor);
    if (pos < 0) throw new Error('Order confirmation patch: helper anchor not found');
    source = source.slice(0, pos) + confirmationHelper + '\n' + source.slice(pos);
  }

  // Before sending the AI reply, if all order data is present and the latest
  // customer message is not a confirmation, force the confirmation question.
  const replyAnchor = `let reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || "দুঃখিত, উত্তর তৈরি করা যায়নি।";`;
  const replyReplacements = [
    `${replyAnchor}\n    const telegramOrderDraft = await extractOrderInfo(bot.histories[chatId]);\n    if (telegramOrderDraft.complete && !customerConfirmedOrder(bot.histories[chatId])) {\n      reply = buildOrderConfirmationReply(telegramOrderDraft);\n    }`,
    `${replyAnchor}\n        const facebookOrderDraft = await extractOrderInfo(page.histories[senderId]);\n        if (facebookOrderDraft.complete && !customerConfirmedOrder(page.histories[senderId])) {\n          reply = buildOrderConfirmationReply(facebookOrderDraft);\n        }`
  ];

  let firstReplyPos = source.indexOf(replyAnchor);
  if (firstReplyPos < 0) throw new Error('Order confirmation patch: Telegram reply anchor not found');
  source = source.slice(0, firstReplyPos) + replyReplacements[0] + source.slice(firstReplyPos + replyAnchor.length);

  const secondReplyPos = source.indexOf(replyAnchor, firstReplyPos + replyReplacements[0].length);
  if (secondReplyPos < 0) throw new Error('Order confirmation patch: Facebook reply anchor not found');
  source = source.slice(0, secondReplyPos) + replyReplacements[1] + source.slice(secondReplyPos + replyAnchor.length);

  // CRITICAL: saving is now gated ONLY by explicit customer confirmation.
  source = source.replace(
    `if (!bot.orderSaved[chatId] && hasPhoneNumber) {\n      const orderInfo = await extractOrderInfo(bot.histories[chatId]);\n      if (orderInfo.complete) {\n        bot.orderSaved[chatId] = true;\n        await saveOrderAndNotify(bot.agentId, chatId, orderInfo, 'Telegram', token);\n      }\n    }`,
    `if (!bot.orderSaved[chatId] && customerConfirmedOrder(bot.histories[chatId])) {\n      const orderInfo = await extractOrderInfo(bot.histories[chatId]);\n      if (orderInfo.complete) {\n        const saved = await saveOrderAndNotify(bot.agentId, chatId, orderInfo, 'Telegram', token);\n        if (saved) bot.orderSaved[chatId] = true;\n      }\n    }`
  );

  source = source.replace(
    `if (!page.orderSaved[senderId] && hasPhoneNumber) {\n          const orderInfo = await extractOrderInfo(page.histories[senderId]);\n          if (orderInfo.complete) {\n            page.orderSaved[senderId] = true;\n            await saveOrderAndNotify(page.agentId, senderId, orderInfo, 'Facebook Messenger', null);\n            await notifyOwnerViaAnyTelegramBot(`,
    `if (!page.orderSaved[senderId] && customerConfirmedOrder(page.histories[senderId])) {\n          const orderInfo = await extractOrderInfo(page.histories[senderId]);\n          if (orderInfo.complete) {\n            const saved = await saveOrderAndNotify(page.agentId, senderId, orderInfo, 'Facebook Messenger', null);\n            if (saved) page.orderSaved[senderId] = true;\n            await notifyOwnerViaAnyTelegramBot(`
  );

  return module._compile(source, filename);
};
