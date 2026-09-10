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
  const userTexts = messages.map(m => (m.parts || []).map(p => p.text || '').join(' ').trim()).filter(Boolean);
  const allText = userTexts.join(' ');
  const normalized = allText.replace(/[০-৯]/g, d => '০১২৩৪৫৬৭৮৯'.indexOf(d));
  const clean = value => String(value || '').replace(/^[-:：\\s]+|[-:：\\s]+$/g, '').trim();

  let customer_name = '';
  let customer_address = '';
  let customer_phone = '';

  const namePatterns = [/(?:আমার নাম|নাম|name|my name is)\\s*[:：-]?\\s*([^,\\n।!?]+)/i];
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

  for (let i = 0; i < (historyArr || []).length - 1; i++) {
    const current = historyArr[i];
    const next = historyArr[i + 1];
    if (current?.role !== 'model' || next?.role !== 'user') continue;
    const prompt = clean((current.parts || []).map(p => p.text || '').join(' ')).toLowerCase();
    const answer = clean((next.parts || []).map(p => p.text || '').join(' '));
    if (!answer) continue;
    if (!customer_name && /নাম|name/.test(prompt) && !/ঠিকানা|address|ফোন|phone|নাম্বার|number/.test(prompt)) customer_name = answer;
    if (!customer_address && /ঠিকানা|address|এড্রেস|কোথায়|কোথায়|থাকেন|বাসা/.test(prompt) && !/ফোন|phone|নাম্বার|number/.test(prompt)) customer_address = answer;
    if (!customer_phone && /ফোন|phone|নাম্বার|number/.test(prompt)) {
      const n = answer.replace(/[০-৯]/g, d => '০১২৩৪৫৬৭৮৯'.indexOf(d)).match(/(?:\\+?88)?01[3-9]\\d{8}/);
      if (n) customer_phone = n[0].replace(/^88/, '');
    }
  }

  const productPattern = /টি-?শার্ট|t-?shirt|গেঞ্জি|পাঞ্জাবি|শার্ট|প্যান্ট|জামা|কাপড়|কাপড়|জুতা|ব্যাগ|ছাতা/i;
  const quantityPattern = /(?:\\d+|[০-৯]+)\\s*(?:টা|টি|পিস|pcs|piece|pieces|জোড়া|জোড়া|pair|কপি)|(?:এক|দুই|তিন|চার|পাঁচ|ছয়|ছয়|সাত|আট|নয়|নয়|দশ)\\s*(?:টা|টি|পিস|জোড়া|জোড়া|কপি)?/i;
  const inquiryOnly = /^(?:অর্ডার করতে চাই|কি কি পণ্য আছে|কী কী পণ্য আছে|পণ্য কি কি আছে|পণ্যের লিস্ট দিন|প্রোডাক্ট কি কি আছে)[\\s?!.।]*$/i;

  let order_details = '';
  for (const text of userTexts) {
    if (inquiryOnly.test(text)) continue;
    if (productPattern.test(text) && quantityPattern.test(text)) order_details = text;
  }

  if (!order_details) {
    const productText = userTexts.find(text => productPattern.test(text) && !inquiryOnly.test(text));
    const quantityText = userTexts.find(text => quantityPattern.test(text));
    if (productText && quantityText) order_details = productText + ' — ' + quantityText;
  }

  if (!customer_name || !customer_address || !customer_phone || !order_details) return { complete: false };

  return { complete: true, customer_name, customer_address, customer_phone, order_details };
}`;

  const start = source.indexOf('async function extractOrderInfo(historyArr) {');
  const saveAnchor = '\n\nasync function saveOrderAndNotify';
  const savePos = source.indexOf(saveAnchor);

  if (start < 0) {
    if (savePos < 0) throw new Error('Order verification accuracy: saveOrderAndNotify anchor not found');
    source = source.slice(0, savePos + 2) + replacement + '\n\n' + source.slice(savePos + 2);
  } else {
    const end = source.indexOf(saveAnchor, start);
    if (end < 0) throw new Error('Order verification accuracy: extractOrderInfo end not found');
    source = source.slice(0, start) + replacement + source.slice(end);
  }

  const confirmationHelper = `
function customerCancelledOrder(historyArr) {
  const messages = (historyArr || []).filter(m => m.role === 'user');
  if (!messages.length) return false;
  const latest = (messages[messages.length - 1].parts || []).map(p => p.text || '').join(' ').trim();
  return /^(না|না লাগবে না|বাতিল|ক্যানসেল|cancel|বাদ দিন|বাদ দেন|অর্ডার করবেন না)$/i.test(latest);
}
function customerConfirmedOrder(historyArr) {
  const messages = (historyArr || []).filter(m => m.role === 'user');
  if (!messages.length) return false;
  const latest = (messages[messages.length - 1].parts || []).map(p => p.text || '').join(' ').trim();
  if (!latest || customerCancelledOrder(historyArr)) return false;
  return /^(হ্যাঁ|জি|জ্বি|ঠিক আছে|ঠিক|কনফার্ম|কনফার্ম করুন|confirm|confirmed|নিশ্চিত|নিশ্চিত করছি|অর্ডার দিন|অর্ডার করুন|অর্ডারটা করে দিন|করে দিন|করে দেন)([\\s,।.!?]|$)/i.test(latest);
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

  const replyAnchor = `let reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || "দুঃখিত, উত্তর তৈরি করা যায়নি।";`;
  const telegramReply = `${replyAnchor}
    const telegramOrderDraft = await extractOrderInfo(bot.histories[chatId]);
    if (telegramOrderDraft.complete && !customerConfirmedOrder(bot.histories[chatId]) && !customerCancelledOrder(bot.histories[chatId])) reply = buildOrderConfirmationReply(telegramOrderDraft);`;
  const firstReplyPos = source.indexOf(replyAnchor);
  if (firstReplyPos < 0) throw new Error('Order confirmation patch: Telegram reply anchor not found');
  source = source.slice(0, firstReplyPos) + telegramReply + source.slice(firstReplyPos + replyAnchor.length);

  const secondReplyPos = source.indexOf(replyAnchor, firstReplyPos + telegramReply.length);
  if (secondReplyPos < 0) throw new Error('Order confirmation patch: Facebook reply anchor not found');
  const facebookReply = `${replyAnchor}
        const facebookOrderDraft = await extractOrderInfo(page.histories[senderId]);
        if (facebookOrderDraft.complete && !customerConfirmedOrder(page.histories[senderId]) && !customerCancelledOrder(page.histories[senderId])) reply = buildOrderConfirmationReply(facebookOrderDraft);`;
  source = source.slice(0, secondReplyPos) + facebookReply + source.slice(secondReplyPos + replyAnchor.length);

  source = source.replace(
    `if (!bot.orderSaved[chatId] && hasPhoneNumber) {
      const orderInfo = await extractOrderInfo(bot.histories[chatId]);
      if (orderInfo.complete) {
        bot.orderSaved[chatId] = true;
        await saveOrderAndNotify(bot.agentId, chatId, orderInfo, 'Telegram', token);
      }
    }`,
    `if (!bot.orderSaved[chatId] && customerConfirmedOrder(bot.histories[chatId])) {
      const orderInfo = await extractOrderInfo(bot.histories[chatId]);
      if (orderInfo.complete) {
        const saved = await saveOrderAndNotify(bot.agentId, chatId, orderInfo, 'Telegram', token);
        if (saved) bot.orderSaved[chatId] = true;
      }
    }`
  );

  source = source.replace(
    `if (!page.orderSaved[senderId] && hasPhoneNumber) {
          const orderInfo = await extractOrderInfo(page.histories[senderId]);
          if (orderInfo.complete) {
            page.orderSaved[senderId] = true;
            await saveOrderAndNotify(page.agentId, senderId, orderInfo, 'Facebook Messenger', null);
            await notifyOwnerViaAnyTelegramBot(`,
    `if (!page.orderSaved[senderId] && customerConfirmedOrder(page.histories[senderId])) {
          const orderInfo = await extractOrderInfo(page.histories[senderId]);
          if (orderInfo.complete) {
            const saved = await saveOrderAndNotify(page.agentId, senderId, orderInfo, 'Facebook Messenger', null);
            if (saved) page.orderSaved[senderId] = true;
            await notifyOwnerViaAnyTelegramBot(`
  );

  return module._compile(source, filename);
};
