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

    // Persist verified order identity into long-term customer memory.
    try {
      await pool.query(\`CREATE TABLE IF NOT EXISTS customer_profiles (
        id SERIAL PRIMARY KEY, agent_id TEXT NOT NULL, platform TEXT NOT NULL, chat_id TEXT NOT NULL,
        customer_name TEXT, customer_phone TEXT, customer_address TEXT, preferences TEXT, needs TEXT,
        created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(agent_id, platform, chat_id)
       )\`);
      await pool.query(\`INSERT INTO customer_profiles
        (agent_id, platform, chat_id, customer_name, customer_phone, customer_address)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (agent_id, platform, chat_id) DO UPDATE SET
          customer_name=COALESCE(NULLIF(EXCLUDED.customer_name,''),customer_profiles.customer_name),
          customer_phone=COALESCE(NULLIF(EXCLUDED.customer_phone,''),customer_profiles.customer_phone),
          customer_address=COALESCE(NULLIF(EXCLUDED.customer_address,''),customer_profiles.customer_address),
          updated_at=NOW()\`,
        [String(agentId), String(notifyPlatform).toLowerCase().includes('telegram')?'telegram':'facebook',
         String(chatId), String(orderInfo.customer_name||''), String(orderInfo.customer_phone||''), String(orderInfo.customer_address||'')]);
      console.log('✓ Customer memory updated from confirmed order');
    } catch (memoryErr) { console.error('Customer memory update failed:', memoryErr.message); }
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

  // server.js now exposes a shared named Facebook webhook handler on both
  // /webhook and /webhook/facebook. Patch the handler body itself so this
  // runtime remains compatible with the consolidated route registration.
  const webhookPos = source.indexOf('async function facebookWebhookHandler(');
  if (webhookPos < 0) throw new Error('Final order runtime: Facebook webhook handler not found');

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
        const startsNewOrder = /(নতুন\\s*অর্ডার|অর্ডার\\s*(করতে|দিতে|দিন|করব|করবো|চাই)|কিনতে\\s*চাই|নিতে\\s*চাই|অর্ডার\\s*প্লেস|place\\s*an?\\s*order|i\\s*want\\s*to\\s*(buy|order)|i\\s*would\\s*like\\s*to\\s*(buy|order))/i.test(finalOrderText);
        if (!page.activeOrderSessions) page.activeOrderSessions = {};
        const activeOrderSession = startsNewOrder || page.activeOrderSessions[senderId] === true;
        let orderHistory = page.histories[senderId] || [];
        const priorSavedOrder = await pool.query(
          'SELECT id FROM orders WHERE agent_id = $1 AND chat_id = $2 ORDER BY created_at DESC LIMIT 1',
          [String(page.agentId), String(senderId)]
        );
        if (activeOrderSession) {
          // Keep multi-turn collection inside the new order session, excluding older completed orders.
          let startAt = -1;
          for (let i = orderHistory.length - 1; i >= 0; i--) {
            if (orderHistory[i]?.role === 'user' && /(অর্ডার|কিনতে|নিতে চাই|buy|order)/i.test((orderHistory[i].parts || []).map(p => p.text || '').join(' '))) { startAt = i; break; }
          }
          if (startAt >= 0) orderHistory = orderHistory.slice(startAt);
          if (startsNewOrder) {
            page.activeOrderSessions[senderId] = true;
            delete page.pendingOrderDrafts[senderId];
            delete page.pendingOrderConfirmationKeys[senderId];
            page.orderSaved[senderId] = false;
            console.log('New Messenger order session started: chat_id=' + senderId);
          }
        } else if (priorSavedOrder.rows[0]) {
          // An already-saved order is historical context, not an active draft.
          orderHistory = [];
          delete page.pendingOrderDrafts[senderId];
          delete page.pendingOrderConfirmationKeys[senderId];
          page.orderSaved[senderId] = true;
        }
        finalOrderDraft = page.pendingOrderDrafts[senderId] || null;
        if (!finalOrderDraft && orderHistory.length) finalOrderDraft = await extractOrderInfo(orderHistory);
        const confirmationAlreadyAskedInHistory = orderHistory.some(item =>
          item?.role === 'model' && (item.parts || []).some(part => /অর্ডারটি কনফার্ম করবেন|কনফার্ম করতে/.test(String(part?.text || '')))
        );
        if (finalOrderDraft?.complete && !finalConfirmed && !confirmationAlreadyAskedInHistory && (!priorSavedOrder.rows[0] || activeOrderSession)) {
          const confirmationKey = [finalOrderDraft.customer_name, finalOrderDraft.customer_address, finalOrderDraft.customer_phone, finalOrderDraft.order_details]
            .map(v => String(v || '').trim().toLowerCase()).join('|');
          const alreadyAskedForSameDraft = page.pendingOrderConfirmationKeys[senderId] === confirmationKey;
          page.pendingOrderDrafts[senderId] = finalOrderDraft;
          if (!alreadyAskedForSameDraft) {
            page.pendingOrderConfirmationKeys[senderId] = confirmationKey;
            reply = buildOrderConfirmationReply(finalOrderDraft);
            console.log('✓ Final order guard: confirmation question enforced');
          }
        }
        if (finalConfirmed && page.pendingOrderDrafts[senderId]?.complete) finalOrderDraft = page.pendingOrderDrafts[senderId];
`;
  source = source.slice(0, replyPos + replyAnchor.length) + guard + source.slice(replyPos + replyAnchor.length);

  const oldStart = source.indexOf('        const banglaToEnglishDigits = text.replace(/[০-৯]/g, d => \'০১২৩৪৫৬৭৮৯\'.indexOf(d));', webhookPos);
  const oldIf = source.indexOf('        if (!page.orderSaved[senderId] && confirmsOrder) {', oldStart);
  const catchMarker = source.indexOf('\n      } catch (err) {', oldIf);
  if (oldStart < 0 || oldIf < 0 || catchMarker < 0) throw new Error('Final order runtime: Facebook save block not found');

  const replacement = `        if (!page.orderSaved[senderId] && finalConfirmed && finalOrderDraft?.complete) {
          page.orderSaved[senderId] = true;
          await saveOrderAndNotify(page.agentId, senderId, finalOrderDraft, 'Facebook Messenger', null);
          delete page.pendingOrderDrafts[senderId];
          delete page.pendingOrderConfirmationKeys[senderId];
          if (page.activeOrderSessions) delete page.activeOrderSessions[senderId];
          console.log(\`✓ Confirmed Messenger order saved and notified: chat_id=\${senderId}\`);
        } else if (!page.orderSaved[senderId] && finalOrderDraft?.complete && !finalConfirmed) {
          console.log(\`⏳ Waiting for Messenger confirmation: chat_id=\${senderId}\`);
        }
`;
  source = source.slice(0, oldStart) + replacement + source.slice(catchMarker + 1);

  console.log('✓ Final Messenger confirmation/save/notification runtime active');
  return module._compile(source, filename);
};
