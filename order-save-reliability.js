// Restore the original order workflow safely.
// This file is loaded before server.js and patches only the order-related logic.
const fs = require('fs');
const Module = require('module');
const path = require('path');

const originalLoader = Module._extensions['.js'];

Module._extensions['.js'] = function orderConfirmationLoader(module, filename) {
  if (path.basename(filename) !== 'server.js') return originalLoader(module, filename);

  let source = fs.readFileSync(filename, 'utf8');

  const extractReplacement = `async function extractOrderInfo(historyArr) {
  const messages = (historyArr || []).filter(m => m.role === 'user');
  const allText = messages.map(m => (m.parts || []).map(p => p.text || '').join(' ')).join(' ');
  const normalized = allText.replace(/[০-৯]/g, d => '০১২৩৪৫৬৭৮৯'.indexOf(d));
  const clean = value => String(value || '').replace(/^[-:：\\s]+|[-:：\\s]+$/g, '').trim();
  const userTexts = messages.map(m => (m.parts || []).map(p => p.text || '').join(' ').trim()).filter(Boolean);

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

  for (const pattern of namePatterns) {
    const match = allText.match(pattern);
    if (match && match[1]) { name = clean(match[1]); break; }
  }
  for (const pattern of addressPatterns) {
    const match = allText.match(pattern);
    if (match && match[1]) { address = clean(match[1]); break; }
  }

  const phoneMatch = normalized.match(/(?:\\+?88)?01[3-9]\\d{8}/);
  if (phoneMatch) phone = phoneMatch[0].replace(/^88/, '');

  // If the customer answered the bot's specific question with a plain value,
  // use that answer. This preserves the old conversational collection flow.
  for (let i = 0; i < (historyArr || []).length - 1; i++) {
    const current = historyArr[i];
    const next = historyArr[i + 1];
    if (current?.role !== 'model' || next?.role !== 'user') continue;
    const prompt = (current.parts || []).map(p => p.text || '').join(' ').toLowerCase();
    const answer = clean((next.parts || []).map(p => p.text || '').join(' '));
    if (!answer) continue;
    if (!name && /নাম|name/.test(prompt) && !/ঠিকানা|address|ফোন|phone|নাম্বার|number/.test(prompt)) name = answer;
    if (!address && /ঠিকানা|address|এড্রেস|কোথায়|কোথায়|থাকেন|বাসা/.test(prompt) && !/ফোন|phone|নাম্বার|number/.test(prompt)) address = answer;
    if (!phone && /ফোন|phone|নাম্বার|number/.test(prompt)) {
      const n = answer.replace(/[০-৯]/g, d => '০১২৩৪৫৬৭৮৯'.indexOf(d)).match(/(?:\\+?88)?01[3-9]\\d{8}/);
      if (n) phone = n[0].replace(/^88/, '');
    }
  }

  const confirmationWords = /^(হ্যাঁ|জি|জ্বি|ঠিক আছে|ঠিক|কনফার্ম|confirm|confirmed|নিশ্চিত|নিশ্চিত করছি|অর্ডার দিন|অর্ডার করুন|অর্ডারটা করে দিন|করে দিন|করে দেন)$/i;
  const cancelWords = /^(না|না লাগবে না|বাতিল|ক্যানসেল|cancel|বাদ দিন|বাদ দেন|অর্ডার করবেন না)$/i;
  const productKeywords = /টি-?শার্ট|t-?shirt|গেঞ্জি|পাঞ্জাবি|শার্ট|প্যান্ট|জামা|কাপড়|কাপড়|জুতা|ব্যাগ|ছাতা|পণ্য|অর্ডার/i;
  let orderDetails = '';
  for (const text of userTexts) {
    if (confirmationWords.test(text) || cancelWords.test(text)) continue;
    if (productKeywords.test(text)) orderDetails = text;
  }

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
  return /^(হ্যাঁ|জি|জ্বি|ঠিক আছে|ঠিক|কনফার্ম|কনফার্ম করুন|confirm|confirmed|নিশ্চিত|নিশ্চিত করছি|অর্ডার দিন|অর্ডার করুন|অর্ডারটা করে দিন|করে দিন|করে দেন)([\s,।.!?]|$)/i.test(latest);
}

function buildOrderConfirmationReply(orderInfo) {
  return 'আপনার অর্ডারের তথ্যগুলো পেয়েছি।\n\n👤 নাম: ' + orderInfo.customer_name + '\n📍 ঠিকানা: ' + orderInfo.customer_address + '\n📞 ফোন: ' + orderInfo.customer_phone + '\n📦 পণ্য: ' + orderInfo.order_details + '\n\nঅর্ডারটি কনফার্ম করবেন? কনফার্ম করতে “জি” বা “কনফার্ম” লিখুন।';
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
    if (telegramOrderDraft.complete && !customerConfirmedOrder(bot.histories[chatId]) && !customerCancelledOrder(bot.histories[chatId])) {
      reply = buildOrderConfirmationReply(telegramOrderDraft);
    }`;
  const firstReplyPos = source.indexOf(replyAnchor);
  if (firstReplyPos < 0) throw new Error('Order confirmation patch: Telegram reply anchor not found');
  source = source.slice(0, firstReplyPos) + telegramReply + source.slice(firstReplyPos + replyAnchor.length);

  const secondReplyPos = source.indexOf(replyAnchor, firstReplyPos + telegramReply.length);
  if (secondReplyPos < 0) throw new Error('Order confirmation patch: Facebook reply anchor not found');
  const facebookReply = `${replyAnchor}
        const facebookOrderDraft = await extractOrderInfo(page.histories[senderId]);
        if (facebookOrderDraft.complete && !customerConfirmedOrder(page.histories[senderId]) && !customerCancelledOrder(page.histories[senderId])) {
          reply = buildOrderConfirmationReply(facebookOrderDraft);
        }`;
  source = source.slice(0, secondReplyPos) + facebookReply + source.slice(secondReplyPos + replyAnchor.length);

  // Saving is now gated ONLY by explicit customer confirmation.
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

  // Save first, then notify. Read each fetch response body at most once.
  const saveStart = source.indexOf('async function saveOrderAndNotify(agentId, chatId, orderInfo, notifyPlatform, notifyToken) {');
  const saveEnd = source.indexOf('\n\nasync function notifyOwnerViaAnyTelegramBot', saveStart);
  if (saveStart >= 0 && saveEnd >= 0) {
    const saveReplacement = `async function saveOrderAndNotify(agentId, chatId, orderInfo, notifyPlatform, notifyToken) {
  try {
    const result = await pool.query(
      'INSERT INTO orders (agent_id, customer_name, customer_address, customer_phone, order_details, chat_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [agentId, orderInfo.customer_name, orderInfo.customer_address, orderInfo.customer_phone, orderInfo.order_details, String(chatId)]
    );
    console.log('✓ Order saved: id=' + (result.rows[0]?.id || 'unknown') + ' agent=' + agentId + ' chat=' + chatId);

    const notifyText = '🛒 নতুন অর্ডার এসেছে! (' + notifyPlatform + ')\\n\\n👤 নাম: ' + orderInfo.customer_name + '\\n📍 ঠিকানা: ' + orderInfo.customer_address + '\\n📞 ফোন: ' + orderInfo.customer_phone + '\\n📦 বিবরণ: ' + orderInfo.order_details;
    const myChatId = process.env.MY_TELEGRAM_CHAT_ID;
    if (myChatId && notifyToken) {
      const notifyResponse = await fetch('https://api.telegram.org/bot' + notifyToken + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: myChatId, text: notifyText })
      });
      await notifyResponse.text().catch(() => '');
    }
    return true;
  } catch (err) {
    console.error('saveOrderAndNotify error:', err.message);
    return false;
  }
}
`;
    source = source.slice(0, saveStart) + saveReplacement + source.slice(saveEnd);
  }

  return module._compile(source, filename);
};
