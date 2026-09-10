// Final order-verification accuracy layer.
// This preload runs after order-save-reliability.js.
// It patches server.js directly so the final compiled source always has one
// deterministic order flow: complete draft -> ask confirmation -> explicit
// confirmation -> save existing order -> notify.
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

  const nameMatch = allText.match(/(?:আমার নাম|নাম|name|my name is)\\s*[:：-]?\\s*([^,\\n।!?]+)/i);
  const addressMatch = allText.match(/(?:ঠিকানা|address|এড্রেস)\\s*[:：-]?\\s*([^\\n।]+)/i) || allText.match(/(?:থাকি|বাসা|বাড়ি|বাড়ি|বাসস্থান)\\s*[:：-]?\\s*([^\\n।]+)/i);
  if (nameMatch?.[1]) customer_name = clean(nameMatch[1]);
  if (addressMatch?.[1]) customer_address = clean(addressMatch[1]);

  const phoneMatch = normalized.match(/(?:\\+?88)?01[3-9]\\d{8}/);
  if (phoneMatch) customer_phone = phoneMatch[0].replace(/^88/, '');

  // Plain answers to the bot's specific questions are valid values.
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

  const extractStart = source.indexOf('async function extractOrderInfo(historyArr) {');
  const saveAnchor = '\\n\\nasync function saveOrderAndNotify';
  const savePos = source.indexOf(saveAnchor);
  if (extractStart >= 0) {
    const extractEnd = source.indexOf(saveAnchor, extractStart);
    if (extractEnd < 0) throw new Error('Order verification accuracy: extractOrderInfo end not found');
    source = source.slice(0, extractStart) + replacement + source.slice(extractEnd);
  } else {
    if (savePos < 0) throw new Error('Order verification accuracy: saveOrderAndNotify anchor not found');
    source = source.slice(0, savePos + 2) + replacement + '\\n\\n' + source.slice(savePos + 2);
  }

  const helpers = `
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
    const helperAnchor = 'const telegramBots = {};';
    const helperPos = source.indexOf(helperAnchor);
    if (helperPos < 0) throw new Error('Order confirmation patch: helper anchor not found');
    source = source.slice(0, helperPos) + helpers + '\\n' + source.slice(helperPos);
  }

  // Replace the entire Messenger save block by stable markers rather than an
  // exact indentation-sensitive string. This prevents false confirmations and
  // ensures saveOrderAndNotify runs only after an explicit confirmation.
  const fbStart = source.indexOf('const banglaToEnglishDigits = text.replace(/[০-৯]/g, d => \'০১২৩৪৫৬৭৮৯\'.indexOf(d));', source.indexOf('app.post("/webhook/facebook"'));
  if (fbStart < 0) throw new Error('Order confirmation patch: Facebook order gate start not found');
  const fbEnd = source.indexOf('\n      } catch (err) {', fbStart);
  if (fbEnd < 0) throw new Error('Order confirmation patch: Facebook order gate end not found');

  const fbGate = `const facebookOrderDraft = await extractOrderInfo(page.histories[senderId]);
        const facebookConfirmed = customerConfirmedOrder(page.histories[senderId]);
        if (!page.orderSaved[senderId] && facebookConfirmed && facebookOrderDraft.complete) {
          const saved = await saveOrderAndNotify(page.agentId, senderId, facebookOrderDraft, 'Facebook Messenger', null);
          if (saved) {
            page.orderSaved[senderId] = true;
            await notifyOwnerViaAnyTelegramBot('🛒 নতুন অর্ডার এসেছে! (Facebook Messenger)\\n\\n👤 নাম: ' + facebookOrderDraft.customer_name + '\\n📍 ঠিকানা: ' + facebookOrderDraft.customer_address + '\\n📞 ফোন: ' + facebookOrderDraft.customer_phone + '\\n📦 বিবরণ: ' + facebookOrderDraft.order_details);
          }
        }`;
  source = source.slice(0, fbStart) + fbGate + source.slice(fbEnd);

  const tgStart = source.indexOf('const banglaToEnglishDigits = text.replace(/[০-৯]/g, d => \'০১২৩৪৫৬৭৮৯\'.indexOf(d));', source.indexOf('app.post("/telegram/webhook/'));
  if (tgStart >= 0) {
    const tgEnd = source.indexOf('\n  } catch (err) {', tgStart);
    if (tgEnd >= 0) {
      const tgGate = `const telegramOrderDraft = await extractOrderInfo(bot.histories[chatId]);
    const telegramConfirmed = customerConfirmedOrder(bot.histories[chatId]);
    if (!bot.orderSaved[chatId] && telegramConfirmed && telegramOrderDraft.complete) {
      const saved = await saveOrderAndNotify(bot.agentId, chatId, telegramOrderDraft, 'Telegram', token);
      if (saved) bot.orderSaved[chatId] = true;
    }`;
      source = source.slice(0, tgStart) + tgGate + source.slice(tgEnd);
    }
  }

  // The model must never tell a customer an order is confirmed merely because
  // the draft became complete. On the latest customer message, if the draft is
  // complete and that message is not an explicit confirmation, replace the AI
  // reply with the confirmation question before sending it.
  const replyAnchor = `let reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || "দুঃখিত, উত্তর তৈরি করা যায়নি।";`;
  const fbReplyPos = source.indexOf(replyAnchor, source.indexOf('app.post("/webhook/facebook"'));
  if (fbReplyPos < 0) throw new Error('Order confirmation patch: Facebook reply anchor not found');
  const fbReplyPatch = `${replyAnchor}
        const facebookDraftForReply = await extractOrderInfo(page.histories[senderId]);
        if (facebookDraftForReply.complete && !customerConfirmedOrder(page.histories[senderId]) && !customerCancelledOrder(page.histories[senderId])) {
          reply = buildOrderConfirmationReply(facebookDraftForReply);
        }`;
  source = source.slice(0, fbReplyPos) + fbReplyPatch + source.slice(fbReplyPos + replyAnchor.length);

  return module._compile(source, filename);
};
