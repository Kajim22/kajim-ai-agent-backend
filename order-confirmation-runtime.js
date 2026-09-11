// Final Messenger order runtime.
// Adds confirmation + reliable save/notification while preserving the existing orders table/UI.
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

  const reliableSaveFunction = `async function saveOrderAndNotify(agentId, chatId, orderInfo, notifyPlatform, notifyToken) {
  try {
    const saved = await pool.query(
      \`INSERT INTO orders (agent_id, customer_name, customer_address, customer_phone, order_details, chat_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id\`,
      [agentId, orderInfo.customer_name, orderInfo.customer_address, orderInfo.customer_phone, orderInfo.order_details, String(chatId)]
    );
    console.log(\`✓ Order saved in New Orders: id=\${saved.rows[0]?.id}, chat_id=\${chatId}\`);

    const notifyText = \`🛒 নতুন অর্ডার এসেছে! (\${notifyPlatform})\\n\\n👤 নাম: \${orderInfo.customer_name}\\n📍 ঠিকানা: \${orderInfo.customer_address}\\n📞 ফোন: \${orderInfo.customer_phone}\\n📦 বিবরণ: \${orderInfo.order_details}\`;
    const myChatId = process.env.MY_TELEGRAM_CHAT_ID;
    if (!myChatId) { console.error('❌ MY_TELEGRAM_CHAT_ID is not set'); return; }

    let token = notifyToken;
    if (!token) {
      const tokenResult = await pool.query('SELECT bot_token FROM telegram_bots LIMIT 1');
      token = tokenResult.rows[0]?.bot_token;
    }
    if (!token) { console.error('❌ No Telegram bot token found'); return; }

    const telegramResponse = await fetch(\`https://api.telegram.org/bot\${token}/sendMessage\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: myChatId, text: notifyText })
    });
    const telegramResult = await telegramResponse.json().catch(() => ({}));
    if (!telegramResponse.ok || !telegramResult.ok) {
      console.error('❌ Telegram order notification failed:', JSON.stringify(telegramResult));
      return;
    }
    console.log('✓ Order notification sent to Telegram');
  } catch (err) {
    console.error('❌ saveOrderAndNotify error:', err.message);
  }
}
`;
  source = source.slice(0, saveStart) + reliableSaveFunction + source.slice(saveEnd);

  const helper = `
function buildOrderConfirmationReply(orderInfo) {
  return 'আপনার অর্ডারের তথ্যগুলো পেয়েছি।\\n\\n👤 নাম: ' + orderInfo.customer_name + '\\n📍 ঠিকানা: ' + orderInfo.customer_address + '\\n📞 ফোন: ' + orderInfo.customer_phone + '\\n📦 পণ্য: ' + orderInfo.order_details + '\\n\\nঅর্ডারটি কনফার্ম করবেন? কনফার্ম করতে “জি” বা “কনফার্ম” লিখুন।';
}
`;
  const helperAnchor = 'const telegramBots = {};';
  const helperPos = source.indexOf(helperAnchor);
  if (helperPos < 0) throw new Error('Final order runtime: helper anchor not found');
  if (!source.includes('function buildOrderConfirmationReply(')) source = source.slice(0, helperPos) + helper + source.slice(helperPos);

  const webhookPos = source.indexOf('app.post("/webhook/facebook"');
  if (webhookPos < 0) throw new Error('Final order runtime: Facebook webhook not found');

  // Declare these at webhook-handler scope so the later save block can never
  // hit "finalConfirmed is not defined".
  const webhookBodyAnchor = '      try {\n        const knowledgeText = await getKnowledgeText(page.agentId);';
  const webhookBodyPos = source.indexOf(webhookBodyAnchor, webhookPos);
  if (webhookBodyPos < 0) throw new Error('Final order runtime: Facebook try anchor not found');
  const scopeVars = `      let finalConfirmed = false;\n      let finalOrderDraft = null;\n\n`;
  source = source.slice(0, webhookBodyPos) + scopeVars + source.slice(webhookBodyPos);

  const replyAnchor = 'let reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || "দুঃখিত, উত্তর তৈরি করা যায়নি।";';
  const replyPos = source.indexOf(replyAnchor, webhookPos);
  if (replyPos < 0) throw new Error('Final order runtime: Facebook reply anchor not found');

  const confirmationGuard = `
        if (!page.pendingOrderDrafts) page.pendingOrderDrafts = {};
        const finalOrderText = String(text || '').trim();
        const finalNormalized = finalOrderText.toLowerCase()
          .replace(/[“”"'\\x60]/g, '')
          .replace(/[\\s,،।.!?;:؛ঃ\\-_/\\\\]+/g, '');
        finalConfirmed = /^(হ্যাঁ|হ্যা|হা|জি|জ্বি|জী|জ্বী|ঠিকআছে|কনফার্ম|কনফার্মকরুন|নিশ্চিত|নিশ্চিতকরছি|অর্ডারদিন|অর্ডারকরুন|অর্ডারটাকরেদিন|করেদিন|করেদেন|confirm|confirmed|yes|ok|okay)$/.test(finalNormalized);

        finalOrderDraft = page.pendingOrderDrafts[senderId] || null;
        if (!finalOrderDraft) finalOrderDraft = await extractOrderInfo(page.histories[senderId]);

        if (finalOrderDraft?.complete && !finalConfirmed) {
          page.pendingOrderDrafts[senderId] = finalOrderDraft;
          reply = buildOrderConfirmationReply(finalOrderDraft);
          console.log('✓ Final order guard: confirmation question enforced');
        }

        if (finalConfirmed && page.pendingOrderDrafts[senderId]?.complete) {
          finalOrderDraft = page.pendingOrderDrafts[senderId];
        }
`;

  source = source.slice(0, replyPos + replyAnchor.length) + confirmationGuard + source.slice(replyPos + replyAnchor.length);

  // Replace the original Facebook phone-only save block.
  const oldStart = source.indexOf('        const banglaToEnglishDigits = text.replace(/[০-৯]/g, d => \'০১২৩৪৫৬৭৮৯\'.indexOf(d));', webhookPos);
  const oldIf = source.indexOf('        if (!page.orderSaved[senderId] && hasPhoneNumber) {', oldStart);
  const oldEndMarker = '\n        }\n      } catch (err) {';
  const oldEnd = source.indexOf(oldEndMarker, oldIf);
  if (oldStart < 0 || oldIf < 0 || oldEnd < 0) throw new Error('Final order runtime: Facebook save block not found');

  const newFacebookSave = `        if (!page.orderSaved[senderId] && finalConfirmed && finalOrderDraft?.complete) {
          page.orderSaved[senderId] = true;
          await saveOrderAndNotify(page.agentId, senderId, finalOrderDraft, 'Facebook Messenger', null);
          delete page.pendingOrderDrafts[senderId];
          console.log(\`✓ Confirmed Messenger order saved and notified: chat_id=\${senderId}\`);
        } else if (!page.orderSaved[senderId] && finalOrderDraft?.complete && !finalConfirmed) {
          console.log(\`⏳ Waiting for Messenger confirmation: chat_id=\${senderId}\`);
        }`;

  source = source.slice(0, oldStart) + newFacebookSave + source.slice(oldEnd);

  console.log('✓ Final Messenger confirmation/save/notification runtime active');
  return module._compile(source, filename);
};
