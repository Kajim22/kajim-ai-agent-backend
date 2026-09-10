// Restore the original order trigger behavior while also recognizing a phone
// number that was provided earlier in the same conversation.
// This preload changes only the phone-number trigger; order extraction,
// saving, notifications, Telegram, Facebook, and duplicate protection remain unchanged.

const fs = require('fs');
const Module = require('module');
const path = require('path');

const originalLoader = Module._extensions['.js'];

Module._extensions['.js'] = function orderHistoryPhoneFixLoader(module, filename) {
  if (path.basename(filename) !== 'server.js') {
    return originalLoader(module, filename);
  }

  let source = fs.readFileSync(filename, 'utf8');

  const helper = `\n// Check the complete conversation history for a phone number.\nfunction historyHasPhoneNumber(historyArr) {\n  const combined = (historyArr || []).map(m =>\n    (m.parts || []).map(p => p.text || '').join(' ')\n  ).join(' ');\n  const normalized = combined\n    .replace(/[০-৯]/g, d => '০১২৩৪৫৬৭৮৯'.indexOf(d))\n    .replace(/[\\s-]/g, '');\n  return /\\d{10,11}/.test(normalized);\n}\n`;

  if (!source.includes('function historyHasPhoneNumber(historyArr)')) {
    const marker = '// ==== Order Detection ====\n';
    if (!source.includes(marker)) {
      throw new Error('Order history phone fix: Order Detection marker not found');
    }
    source = source.replace(marker, marker + helper + '\n');
  }

  const telegramOld = `const banglaToEnglishDigits = text.replace(/[০-৯]/g, d => '০১২৩৪৫৬৭৮৯'.indexOf(d));\n    const cleanedText = banglaToEnglishDigits.replace(/[\\s-]/g, '');\n    const hasPhoneNumber = /\\d{10,11}/.test(cleanedText);\n    if (!bot.orderSaved[chatId] && hasPhoneNumber) {\n      const orderInfo = await extractOrderInfo(bot.histories[chatId]);\n      if (orderInfo.complete) {\n        bot.orderSaved[chatId] = true;\n        await saveOrderAndNotify(bot.agentId, chatId, orderInfo, 'Telegram', token);\n      }\n    }`;

  const telegramNew = `const hasPhoneNumber = historyHasPhoneNumber(bot.histories[chatId]);\n    if (!bot.orderSaved[chatId] && hasPhoneNumber) {\n      const orderInfo = await extractOrderInfo(bot.histories[chatId]);\n      if (orderInfo.complete) {\n        bot.orderSaved[chatId] = true;\n        await saveOrderAndNotify(bot.agentId, chatId, orderInfo, 'Telegram', token);\n      }\n    }`;

  const facebookOld = `const banglaToEnglishDigits = text.replace(/[০-৯]/g, d => '০১২৩৪৫৬৭৮৯'.indexOf(d));\n        const cleanedText = banglaToEnglishDigits.replace(/[\\s-]/g, '');\n        const hasPhoneNumber = /\\d{10,11}/.test(cleanedText);\n        if (!page.orderSaved[senderId] && hasPhoneNumber) {\n          const orderInfo = await extractOrderInfo(page.histories[senderId]);\n          if (orderInfo.complete) {\n            page.orderSaved[senderId] = true;\n            await saveOrderAndNotify(page.agentId, senderId, orderInfo, 'Facebook Messenger', null);\n            await notifyOwnerViaAnyTelegramBot(` + '`🛒 নতুন অর্ডার এসেছে! (Facebook Messenger)\\n\\n👤 নাম: ${orderInfo.customer_name}\\n📍 ঠিকানা: ${orderInfo.customer_address}\\n📞 ফোন: ${orderInfo.customer_phone}\\n📦 বিবরণ: ${orderInfo.order_details}`' + `);\n          }\n        }`;

  const facebookNew = `const hasPhoneNumber = historyHasPhoneNumber(page.histories[senderId]);\n        if (!page.orderSaved[senderId] && hasPhoneNumber) {\n          const orderInfo = await extractOrderInfo(page.histories[senderId]);\n          if (orderInfo.complete) {\n            page.orderSaved[senderId] = true;\n            await saveOrderAndNotify(page.agentId, senderId, orderInfo, 'Facebook Messenger', null);\n            await notifyOwnerViaAnyTelegramBot(` + '`🛒 নতুন অর্ডার এসেছে! (Facebook Messenger)\\n\\n👤 নাম: ${orderInfo.customer_name}\\n📍 ঠিকানা: ${orderInfo.customer_address}\\n📞 ফোন: ${orderInfo.customer_phone}\\n📦 বিবরণ: ${orderInfo.order_details}`' + `);\n          }\n        }`;

  if (source.includes(telegramOld)) source = source.replace(telegramOld, telegramNew);
  if (source.includes(facebookOld)) source = source.replace(facebookOld, facebookNew);

  if (source.includes(telegramOld) || source.includes(facebookOld)) {
    throw new Error('Order history phone fix: expected trigger replacement did not complete');
  }

  return module._compile(source, filename);
};
