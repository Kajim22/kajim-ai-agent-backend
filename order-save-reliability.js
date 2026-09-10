// Reliable order extraction/save patch. Loaded as a server.js source transformer.
const fs = require('fs');
const Module = require('module');
const path = require('path');

const originalLoader = Module._extensions['.js'];

Module._extensions['.js'] = function orderSaveReliabilityLoader(module, filename) {
  if (path.basename(filename) !== 'server.js') return originalLoader(module, filename);

  let source = fs.readFileSync(filename, 'utf8');

  const extractReplacement = 'async function extractOrderInfo(historyArr) {\n' +
`  const API_KEY = process.env.GEMINI_API_KEY;

  // Deterministic extraction first. This is also what the confirmation prompt uses,
  // so an order draft never depends on Gemini quota.
  const fallbackExtract = () => {
    const messages = (historyArr || []).filter(m => m.role === 'user');
    const text = messages.map(m =>
      (m.parts || []).map(p => p.text || '').join(' ')
    ).join(' ');
    const normalized = text.replace(/[০-৯]/g, d => '০১২৩৪৫৬৭৮৯'.indexOf(d));
    const phoneMatch = normalized.match(/(?:\\+?88)?01[3-9]\\d{8}/);
    if (!phoneMatch) return { complete: false };

    const phone = phoneMatch[0].replace(/^88/, '');

    let name = '';
    const namePatterns = [
      /(?:নাম|name)\\s*[:：-]?\\s*([^,\\n।]+)/i,
      /(?:আমার নাম|my name is)\\s*[:：-]?\\s*([^,\\n।]+)/i,
      /(?:আমি|i am)\\s+([^,\\n।]{2,40})/i
    ];
    for (const pattern of namePatterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        name = match[1].trim();
        break;
      }
    }

    let address = '';
    const addressPatterns = [
      /(?:ঠিকানা|address|এড্রেস)\\s*[:：-]?\\s*([^\\n।]+)/i,
      /(?:থাকি|বাসা|বাড়ি|বাড়ি|বাসস্থান)\\s*[:：-]?\\s*([^\\n।]+)/i
    ];
    for (const pattern of addressPatterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        address = match[1].trim();
        break;
      }
    }

    const productKeywords = /টি-?শার্ট|t-?shirt|গেঞ্জি|পাঞ্জাবি|শার্ট|প্যান্ট|জামা|কাপড়|কাপড়|জুতা|ব্যাগ|ছাতা|product|পণ্য|অর্ডার/i;
    let orderDetails = '';
    for (const message of messages) {
      const messageText = (message.parts || []).map(p => p.text || '').join(' ').trim();
      if (messageText && productKeywords.test(messageText) && !/^(হ্যাঁ|জি|জ্বি|ঠিক আছে|ঠিক|কনফার্ম|confirm|confirmed)$/i.test(messageText)) {
        orderDetails = messageText;
      }
    }

    if (!name) name = 'গ্রাহক';
    if (!address) return { complete: false };
    if (!orderDetails) orderDetails = 'Confirmed order';

    return {
      complete: true,
      customer_name: name,
      customer_address: address,
      customer_phone: phone,
      order_details: orderDetails
    };
  };

  const deterministic = fallbackExtract();
  if (deterministic.complete) return deterministic;

  // Gemini is only an enhancement when deterministic extraction is incomplete.
  // A quota/429/network failure must never block a confirmed order.
  try {
    if (!API_KEY) return deterministic;

    const extractPrompt = 'তুমি একটি অর্ডার তথ্য বের করার টুল। কথোপকথন থেকে শুধু গ্রাহকের দেওয়া নাম, ঠিকানা, ফোন ও পণ্যের বিবরণ বের করো। বটের নিজের প্রশ্ন বা উত্তরকে গ্রাহকের তথ্য হিসেবে কখনো নিও না। শুধু valid JSON object দাও: {"complete":true,"customer_name":"নাম","customer_address":"ঠিকানা","customer_phone":"ফোন","order_details":"পণ্যের বিবরণ"} অথবা {"complete":false}';

    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + encodeURIComponent(API_KEY), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: extractPrompt }] },
        contents: historyArr,
        generationConfig: { responseMimeType: 'application/json' }
      })
    });

    const raw = await response.text();
    if (!response.ok) {
      console.error('extractOrderInfo Gemini HTTP ' + response.status + ': ' + raw.slice(0, 500));
      return fallbackExtract();
    }

    let data;
    try { data = JSON.parse(raw); } catch (_) { return fallbackExtract(); }
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const match = text.match(/\\{[\\s\\S]*\\}/);
    if (!match) return fallbackExtract();

    try {
      const parsed = JSON.parse(match[0]);
      if (parsed && parsed.complete === true && parsed.customer_phone && parsed.customer_address) return parsed;
      return fallbackExtract();
    } catch (_) {
      return fallbackExtract();
    }
  } catch (err) {
    console.error('extractOrderInfo error:', err.message);
    return fallbackExtract();
  }
}`;

  const extractStart = source.indexOf('async function extractOrderInfo(historyArr) {');
  const extractEnd = source.indexOf('\n\nasync function saveOrderAndNotify', extractStart);
  if (extractStart < 0 || extractEnd < 0) throw new Error('Order save reliability: extractOrderInfo block not found');
  source = source.slice(0, extractStart) + extractReplacement + source.slice(extractEnd);

  const saveReplacement = 'async function saveOrderAndNotify(agentId, chatId, orderInfo, notifyPlatform, notifyToken) {\n' +
`  try {
    const result = await pool.query(
      'INSERT INTO orders (agent_id, customer_name, customer_address, customer_phone, order_details, chat_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [agentId, orderInfo.customer_name, orderInfo.customer_address, orderInfo.customer_phone, orderInfo.order_details, String(chatId)]
    );

    console.log('✓ Order saved: id=' + (result.rows[0]?.id || 'unknown') + ' agent=' + agentId + ' chat=' + chatId);

    const notifyText = '🛒 নতুন অর্ডার এসেছে! (' + notifyPlatform + ') | নাম: ' + orderInfo.customer_name + ' | ঠিকানা: ' + orderInfo.customer_address + ' | ফোন: ' + orderInfo.customer_phone + ' | বিবরণ: ' + orderInfo.order_details;
    const myChatId = process.env.MY_TELEGRAM_CHAT_ID;
    if (myChatId && notifyToken) {
      await fetch('https://api.telegram.org/bot' + notifyToken + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: myChatId, text: notifyText })
      });
    }
    return true;
  } catch (err) {
    console.error('saveOrderAndNotify error:', err.message);
    return false;
  }
}`;

  const saveStart = source.indexOf('async function saveOrderAndNotify(agentId, chatId, orderInfo, notifyPlatform, notifyToken) {');
  const saveEnd = source.indexOf('\n\nasync function notifyOwnerViaAnyTelegramBot', saveStart);
  if (saveStart < 0 || saveEnd < 0) throw new Error('Order save reliability: saveOrderAndNotify block not found');
  source = source.slice(0, saveStart) + saveReplacement + source.slice(saveEnd);

  const confirmationHelper = `
// Save an order only after the customer explicitly confirms it.
function customerConfirmedOrder(historyArr) {
  const messages = (historyArr || []).filter(m => m.role === 'user');
  if (!messages.length) return false;
  const latest = (messages[messages.length - 1].parts || []).map(p => p.text || '').join(' ').trim().toLowerCase();
  if (!latest) return false;
  if (/cancel|ক্যানসেল|বাতিল|লাগবে না|বাদ দিন|বাদ দেন|না,? ?লাগবে না|অর্ডার করবেন না/.test(latest)) return false;
  return /(^|[\\s,।.!?])(?:হ্যাঁ|জি|জ্বি|ঠিক আছে|ঠিক|কনফার্ম|কনফার্ম করুন|confirm|confirmed|অর্ডার দিন|অর্ডার করুন|অর্ডারটা করে দিন|করে দিন|করে দেন|নিশ্চিত|নিশ্চিত করছি|হ্যাঁ অর্ডার করুন|জি অর্ডার করুন)(?=$|[\\s,।.!?])/i.test(latest);
}

function buildOrderConfirmationReply(orderInfo) {
  return 'আপনার অর্ডারের তথ্যগুলো পেয়েছি। নাম: ' + orderInfo.customer_name + ' | ঠিকানা: ' + orderInfo.customer_address + ' | ফোন: ' + orderInfo.customer_phone + '। অর্ডারটি কনফার্ম করতে দয়া করে “জি, অর্ডার করুন” বা “কনফার্ম” লিখুন।';
}
`;
  const helperAnchor = 'const telegramBots = {};';
  if (!source.includes('function customerConfirmedOrder(historyArr)')) {
    const helperPos = source.indexOf(helperAnchor);
    if (helperPos < 0) throw new Error('Order save reliability: telegramBots anchor not found');
    source = source.slice(0, helperPos) + confirmationHelper + '\n' + source.slice(helperPos);
  }

  // Before sending the normal AI reply, detect a complete order draft. If the
  // latest customer message is not an explicit confirmation, replace the AI
  // reply with a clear confirmation request. No order is saved at this stage.
  const telegramReplyAnchor = `let reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || "দুঃখিত, উত্তর তৈরি করা যায়নি।";`;
  const telegramReplyReplacement = `${telegramReplyAnchor}
    const orderDraft = await extractOrderInfo(bot.histories[chatId]);
    if (orderDraft.complete && !customerConfirmedOrder(bot.histories[chatId])) {
      reply = buildOrderConfirmationReply(orderDraft);
    }`;
  source = source.replace(telegramReplyAnchor, telegramReplyReplacement);

  const facebookReplyAnchor = `let reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || "দুঃখিত, উত্তর তৈরি করা যায়নি।";`;
  const facebookReplyReplacement = `${facebookReplyAnchor}
        const orderDraft = await extractOrderInfo(page.histories[senderId]);
        if (orderDraft.complete && !customerConfirmedOrder(page.histories[senderId])) {
          reply = buildOrderConfirmationReply(orderDraft);
        }`;
  source = source.replace(facebookReplyAnchor, facebookReplyReplacement);

  const telegramOld = `if (!bot.orderSaved[chatId] && hasPhoneNumber && customerConfirmedOrder(bot.histories[chatId])) {
      const orderInfo = await extractOrderInfo(bot.histories[chatId]);`;
  const telegramNew = `if (!bot.orderSaved[chatId] && customerConfirmedOrder(bot.histories[chatId])) {
      const orderInfo = await extractOrderInfo(bot.histories[chatId]);`;
  source = source.replace(telegramOld, telegramNew);

  const facebookOld = `if (!page.orderSaved[senderId] && hasPhoneNumber && customerConfirmedOrder(page.histories[senderId])) {
          const orderInfo = await extractOrderInfo(page.histories[senderId]);`;
  const facebookNew = `if (!page.orderSaved[senderId] && customerConfirmedOrder(page.histories[senderId])) {
          const orderInfo = await extractOrderInfo(page.histories[senderId]);`;
  source = source.replace(facebookOld, facebookNew);

  const telegramSavedOld = `bot.orderSaved[chatId] = true;
        await saveOrderAndNotify(bot.agentId, chatId, orderInfo, 'Telegram', token);`;
  const telegramSavedNew = `const saved = await saveOrderAndNotify(bot.agentId, chatId, orderInfo, 'Telegram', token);
        if (saved) bot.orderSaved[chatId] = true;`;
  source = source.replace(telegramSavedOld, telegramSavedNew);

  const facebookSavedOld = `page.orderSaved[senderId] = true;
            await saveOrderAndNotify(page.agentId, senderId, orderInfo, 'Facebook Messenger', null);`;
  const facebookSavedNew = `const saved = await saveOrderAndNotify(page.agentId, senderId, orderInfo, 'Facebook Messenger', null);
            if (saved) page.orderSaved[senderId] = true;`;
  source = source.replace(facebookSavedOld, facebookSavedNew);

  return module._compile(source, filename);
};
