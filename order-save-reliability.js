// Make order extraction independent of fragile JSON-mode/model combinations
// and make the order insert report success before the in-memory flag is set.
const fs = require('fs');
const Module = require('module');
const path = require('path');

const originalLoader = Module._extensions['.js'];

Module._extensions['.js'] = function orderSaveReliabilityLoader(module, filename) {
  if (path.basename(filename) !== 'server.js') return originalLoader(module, filename);

  let source = fs.readFileSync(filename, 'utf8');

  const extractReplacement = 'async function extractOrderInfo(historyArr) {\n' +
`  const API_KEY = process.env.GEMINI_API_KEY;
  const extractPrompt = 'তুমি একটি অর্ডার তথ্য বের করার টুল। নিচের কথোপকথন থেকে গ্রাহকের অর্ডারের নাম, ঠিকানা, ফোন ও পণ্যের বিবরণ বের করো।\n\nশুধু valid JSON object দাও। কোনো markdown, ব্যাখ্যা বা অতিরিক্ত লেখা দেবে না।\nসম্পূর্ণ হলে:\n{"complete":true,"customer_name":"নাম","customer_address":"ঠিকানা","customer_phone":"ফোন","order_details":"পণ্যের সংক্ষিপ্ত বিবরণ"}\nঅসম্পূর্ণ হলে:\n{"complete":false}';

  const fallbackExtract = () => {
    const text = (historyArr || []).map(m =>
      (m.parts || []).map(p => p.text || '').join(' ')
    ).join(' ');
    const normalized = text.replace(/[০-৯]/g, d => '০১২৩৪৫৬৭৮৯'.indexOf(d));
    const phoneMatch = normalized.match(/(?:\\+?88)?01[3-9]\\d{8}/);
    if (!phoneMatch) return { complete: false };

    const phone = phoneMatch[0].replace(/^88/, '');
    const nameMatch = text.match(/(?:নাম|name)\\s*[:：-]?\\s*([^,\\n।]+)/i);
    const addressMatch = text.match(/(?:ঠিকানা|address|এড্রেস)\\s*[:：-]?\\s*([^\\n।]+)/i);
    const orderMatch = text.match(/(?:অর্ডার|order|পণ্য|product)\\s*[:：-]?\\s*([^\\n।]+)/i);
    if (!nameMatch || !addressMatch) return { complete: false };

    return {
      complete: true,
      customer_name: nameMatch[1].trim(),
      customer_address: addressMatch[1].trim(),
      customer_phone: phone,
      order_details: (orderMatch && orderMatch[1].trim()) || 'অর্ডার'
    };
  };

  try {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + encodeURIComponent(API_KEY || ''), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: extractPrompt }] },
        contents: historyArr
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
      if (parsed && parsed.complete === true && parsed.customer_phone) return parsed;
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

    const notifyText = '🛒 নতুন অর্ডার এসেছে! (' + notifyPlatform + ')\\n\\n👤 নাম: ' + orderInfo.customer_name + '\\n📍 ঠিকানা: ' + orderInfo.customer_address + '\\n📞 ফোন: ' + orderInfo.customer_phone + '\\n📦 বিবরণ: ' + orderInfo.order_details;
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

  const telegramOld = `bot.orderSaved[chatId] = true;
        await saveOrderAndNotify(bot.agentId, chatId, orderInfo, 'Telegram', token);`;
  const telegramNew = `const saved = await saveOrderAndNotify(bot.agentId, chatId, orderInfo, 'Telegram', token);
        if (saved) bot.orderSaved[chatId] = true;`;
  source = source.replace(telegramOld, telegramNew);

  const facebookOld = `page.orderSaved[senderId] = true;
            await saveOrderAndNotify(page.agentId, senderId, orderInfo, 'Facebook Messenger', null);`;
  const facebookNew = `const saved = await saveOrderAndNotify(page.agentId, senderId, orderInfo, 'Facebook Messenger', null);
            if (saved) page.orderSaved[senderId] = true;`;
  source = source.replace(facebookOld, facebookNew);

  return module._compile(source, filename);
};
