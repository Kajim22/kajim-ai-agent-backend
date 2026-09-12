// Final Messenger order runtime.
// Confirmation gate + reliable save/notification. Existing orders table/UI is preserved.
const fs = require('fs');
const Module = require('module');
const path = require('path');
const previousLoader = Module._extensions['.js'];

Module._extensions['.js'] = function finalOrderRuntimeLoader(module, filename) {
  if (path.basename(filename) !== 'server.js') return previousLoader(module, filename);
  let source = fs.readFileSync(filename, 'utf8');

  const saveStart = source.indexOf('async function saveOrderAndNotify(');
  const saveEnd = source.indexOf('\nasync function notifyOwnerViaAnyTelegramBot', saveStart);
  if (saveStart < 0 || saveEnd < 0) throw new Error('Final order runtime: saveOrderAndNotify block not found');

  const reliableSave = `async function saveOrderAndNotify(agentId, chatId, orderInfo, notifyPlatform, notifyToken) {
  try {
    const saved = await pool.query(\`INSERT INTO orders (agent_id, customer_name, customer_address, customer_phone, order_details, chat_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id\`, [agentId, orderInfo.customer_name, orderInfo.customer_address, orderInfo.customer_phone, orderInfo.order_details, String(chatId)]);
    console.log(\`✓ Order saved in New Orders: id=\${saved.rows[0]?.id}, chat_id=\${chatId}\`);
    const myChatId = process.env.MY_TELEGRAM_CHAT_ID;
    if (!myChatId) { console.error('❌ MY_TELEGRAM_CHAT_ID is not set'); return; }
    let token = notifyToken;
    if (!token) {
      const r = await pool.query('SELECT bot_token FROM telegram_bots LIMIT 1');
      token = r.rows[0]?.bot_token;
    }
    if (!token) { console.error('❌ No Telegram bot token found'); return; }
    const text = \`🛒 নতুন অর্ডার এসেছে! (\${notifyPlatform})\\n\\n👤 নাম: \${orderInfo.customer_name}\\n📍 ঠিকানা: \${orderInfo.customer_address}\\n📞 ফোন: \${orderInfo.customer_phone}\\n📦 বিবরণ: \${orderInfo.order_details}\`;
    const response = await fetch(\`https://api.telegram.org/bot\${token}/sendMessage\`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({chat_id:myChatId,text}) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) { console.error('❌ Telegram order notification failed:', JSON.stringify(result)); return; }
    console.log('✓ Order notification sent to Telegram');
  } catch (err) { console.error('❌ saveOrderAndNotify error:', err.message); }
}
`;
  source = source.slice(0, saveStart) + reliableSave + source.slice(saveEnd);

  const helperAnchor = 'const telegramBots = {};';
  const helperPos = source.indexOf(helperAnchor);
  if (helperPos < 0) throw new Error('Final order runtime: helper anchor not found');
  if (!source.includes('function buildOrderConfirmationReply(')) {
    const helper = `\nfunction buildOrderConfirmationReply(orderInfo) { return 'আপনার অর্ডারের তথ্যগুলো পেয়েছি।\\n\\n👤 নাম: ' + orderInfo.customer_name + '\\n📍 ঠিকানা: ' + orderInfo.customer_address + '\\n📞 ফোন: ' + orderInfo.customer_phone + '\\n📦 পণ্য: ' + orderInfo.order_details + '\\n\\nঅর্ডারটি কনফার্ম করবেন? কনফার্ম করতে “জি” বা “কনফার্ম” লিখুন।'; }\n`;
    source = source.slice(0, helperPos) + helper + source.slice(helperPos);
  }

  const webhookPos = source.indexOf('app.post("/webhook/facebook"');
  if (webhookPos < 0) throw new Error('Final order runtime: Facebook webhook not found');

  const tryAnchor = '      try {\n        const knowledgeText = await getKnowledgeText(page.agentId);';
  const tryPos = source.indexOf(tryAnchor, webhookPos);
  if (tryPos < 0) throw new Error('Final order runtime: Facebook try anchor not found');
  source = source.slice(0, tryPos) + '      let finalConfirmed = false;\n      let finalOrderDraft = null;\n\n' + source.slice(tryPos);

  const replyAnchor = 'let reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || "দুঃখিত, উত্তর তৈরি করা যায়নি।";';
  const replyPos = source.indexOf(replyAnchor, webhookPos);
  if (replyPos < 0) throw new Error('Final order runtime: Facebook reply anchor not found');

  const guard = `
        if (!page.pendingOrderDrafts) page.pendingOrderDrafts = {};
        if (!page.pendingOrderConfirmationKeys) page.pendingOrderConfirmationKeys = {};
        const finalOrderText = String(text || '').trim();
        const finalNormalized = finalOrderText.toLowerCase().replace(/[“”"'\\x60]/g, '').replace(/[\\s,،।.!?;:؛ঃ\\-_/\\\\]+/g, '');
        finalConfirmed = /^(হ্যাঁ|হ্যা|হা|জি|জ্বি|জী|জ্বী|ঠিকআছে|কনফার্ম|কনফার্মকরুন|নিশ্চিত|নিশ্চিতকরছি|অর্ডারদিন|অর্ডারকরুন|অর্ডারটাকরেদিন|করেদিন|করেদেন|confirm|confirmed|yes|ok|okay)$/.test(finalNormalized);
        finalOrderDraft = page.pendingOrderDrafts[senderId] || null;
        if (!finalOrderDraft) finalOrderDraft = await extractOrderInfo(page.histories[senderId]);
        if (finalOrderDraft?.complete && !finalConfirmed) {
          const confirmationKey = [finalOrderDraft.customer_name, finalOrderDraft.customer_address, finalOrderDraft.customer_phone, finalOrderDraft.order_details]
            .map(v => String(v || '').trim().toLowerCase()).join('|');
          const alreadyAskedForSameDraft = page.pendingOrderConfirmationKeys[senderId] === confirmationKey;
          page.pendingOrderDrafts[senderId] = finalOrderDraft;
          if (!alreadyAskedForSameDraft) {
            page.pendingOrderConfirmationKeys[senderId] = confirmationKey;
            reply = buildOrderConfirmationReply(finalOrderDraft);
            console.log('✓ Final order guard: confirmation question enforced');
          } else {
            console.log(\`↩️ Messenger confirmation already sent for current draft: chat_id=\${senderId}\`);
          }
        }
        if (finalConfirmed && page.pendingOrderDrafts[senderId]?.complete) finalOrderDraft = page.pendingOrderDrafts[senderId];
`;
  source = source.slice(0, replyPos + replyAnchor.length) + guard + source.slice(replyPos + replyAnchor.length);

  const oldStart = source.indexOf('        const banglaToEnglishDigits = text.replace(/[০-৯]/g, d => \'০১২৩৪৫৬৭৮৯\'.indexOf(d));', webhookPos);
  const oldIf = source.indexOf('        if (!page.orderSaved[senderId] && hasPhoneNumber) {', oldStart);
  const catchMarker = source.indexOf('\n      } catch (err) {', oldIf);
  if (oldStart < 0 || oldIf < 0 || catchMarker < 0) throw new Error('Final order runtime: Facebook save block not found');

  const replacement = `        if (!page.orderSaved[senderId] && finalConfirmed && finalOrderDraft?.complete) {
          page.orderSaved[senderId] = true;
          await saveOrderAndNotify(page.agentId, senderId, finalOrderDraft, 'Facebook Messenger', null);
          delete page.pendingOrderDrafts[senderId];
          delete page.pendingOrderConfirmationKeys[senderId];
          console.log(\`✓ Confirmed Messenger order saved and notified: chat_id=\${senderId}\`);
        } else if (!page.orderSaved[senderId] && finalOrderDraft?.complete && !finalConfirmed) {
          console.log(\`⏳ Waiting for Messenger confirmation: chat_id=\${senderId}\`);
        }
`;
  source = source.slice(0, oldStart) + replacement + source.slice(catchMarker + 1);

  console.log('✓ Final Messenger confirmation/save/notification runtime active');
  return module._compile(source, filename);
};
