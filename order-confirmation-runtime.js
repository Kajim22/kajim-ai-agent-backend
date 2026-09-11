// Final runtime guard for Messenger order confirmation.
// Loaded after all existing order preloads. It guarantees that Gemini cannot
// claim an order is confirmed before the customer explicitly confirms it.
const fs = require('fs');
const Module = require('module');
const path = require('path');

const previousLoader = Module._extensions['.js'];

Module._extensions['.js'] = function finalOrderRuntimeLoader(module, filename) {
  if (path.basename(filename) !== 'server.js') return previousLoader(module, filename);

  let source = fs.readFileSync(filename, 'utf8');
  const webhookPos = source.indexOf('app.post("/webhook/facebook"');
  if (webhookPos < 0) throw new Error('Final order runtime: Facebook webhook not found');

  const helper = `
function normalizeOrderConfirmationText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[“”‘’]/g, '')
    .replace(/[\s,،।.!?;:؛ঃ\-_/\\]+/g, '')
    .toLowerCase()
    .trim();
}

function confirmationEditDistance(a, b) {
  const aa = Array.from(a), bb = Array.from(b);
  const dp = Array(bb.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= aa.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= bb.length; j++) {
      const old = dp[j];
      dp[j] = aa[i - 1] === bb[j - 1]
        ? prev
        : Math.min(prev + 1, dp[j] + 1, dp[j - 1] + 1);
      prev = old;
    }
  }
  return dp[bb.length];
}

function isFinalOrderConfirmation(value) {
  const normalized = normalizeOrderConfirmationText(value);
  if (!normalized) return false;

  const exact = new Set([
    'হ্যাঁ', 'হ্যা', 'হা', 'জি', 'জ্বি', 'জী', 'জ্বী',
    'ঠিকআছে', 'নিশ্চিত', 'নিশ্চিতকরছি', 'অর্ডারদিন', 'অর্ডারকরুন',
    'অর্ডারটাকরেদিন', 'করেদিন', 'করেদেন',
    'কনফার্ম', 'কনফার্মকরুন', 'কনফার্মকরলাম', 'কনফার্মকরছি', 'কনফার্মড',
    'confirm', 'confirmed', 'confirmorder', 'yes', 'ok', 'okay'
  ]);
  if (exact.has(normalized)) return true;

  // Accept common Bengali spelling/typing variants without accepting arbitrary sentences.
  const bengaliTargets = ['জি', 'জ্বি', 'জী', 'জ্বী', 'হ্যাঁ', 'হ্যা', 'কনফার্ম', 'কনফার্মড'];
  if (bengaliTargets.some(target => {
    const distance = confirmationEditDistance(normalized, target);
    return distance <= (target.length <= 3 ? 1 : 2);
  })) return true;

  // Common English keyboard typos such as confrm / cnfirm / confim.
  const englishTargets = ['confirm', 'confirmed'];
  return englishTargets.some(target => confirmationEditDistance(normalized, target) <= 2);
}

function buildOrderConfirmationReply(orderInfo) {
  return 'আপনার অর্ডারের তথ্যগুলো পেয়েছি।\\n\\n👤 নাম: ' + orderInfo.customer_name + '\\n📍 ঠিকানা: ' + orderInfo.customer_address + '\\n📞 ফোন: ' + orderInfo.customer_phone + '\\n📦 পণ্য: ' + orderInfo.order_details + '\\n\\nঅর্ডারটি কনফার্ম করবেন? কনফার্ম করতে “জি” বা “কনফার্ম” লিখুন।';
}
`;
  const helperAnchor = 'const telegramBots = {};';
  const helperPos = source.indexOf(helperAnchor);
  if (helperPos < 0) throw new Error('Final order runtime: helper anchor not found');
  source = source.slice(0, helperPos) + helper + '\n' + source.slice(helperPos);

  const replyAnchor = 'let reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || "দুঃখিত, উত্তর তৈরি করা যায়নি।";';
  const replyPos = source.indexOf(replyAnchor, webhookPos);
  if (replyPos < 0) throw new Error('Final order runtime: Facebook reply anchor not found');

  const guard = `
        const finalUserText = String(text || '').trim();
        const finalUserConfirmed = isFinalOrderConfirmation(finalUserText);
        page.pendingOrderDrafts = page.pendingOrderDrafts || {};
        const finalDraft = await extractOrderInfo(page.histories[senderId]);
        if (finalDraft.complete && !finalUserConfirmed) {
          page.pendingOrderDrafts[senderId] = finalDraft;
          reply = buildOrderConfirmationReply(finalDraft);
          console.log('✓ Final order guard: confirmation question enforced');
          console.log('✓ Pending Facebook order draft stored for chat=' + senderId);
        }
`;
  source = source.slice(0, replyPos + replyAnchor.length) + guard + source.slice(replyPos + replyAnchor.length);

  const saveAnchor = 'const banglaToEnglishDigits = text.replace(/[০-৯]/g, d => \'০১২৩৪৫৬৭৮৯\'.indexOf(d));';
  const savePos = source.indexOf(saveAnchor, webhookPos);
  if (savePos < 0) throw new Error('Final order runtime: Facebook save anchor not found');

  const finalSave = `
        page.pendingOrderDrafts = page.pendingOrderDrafts || {};
        const finalFacebookConfirmed = isFinalOrderConfirmation(String(text || '').trim());
        const pendingFacebookDraft = page.pendingOrderDrafts[senderId];
        const finalFacebookDraft = pendingFacebookDraft || await extractOrderInfo(page.histories[senderId]);
        console.log('Order gate FB final:', JSON.stringify({ complete: !!finalFacebookDraft?.complete, confirmed: finalFacebookConfirmed, chatId: senderId, pendingDraft: !!pendingFacebookDraft }));
        if (finalFacebookConfirmed && finalFacebookDraft?.complete) {
          const existingOrder = await pool.query('SELECT id FROM orders WHERE chat_id = $1 LIMIT 1', [String(senderId)]).catch(() => ({ rows: [] }));
          if (!existingOrder.rows.length) {
            try {
              const savedResult = await pool.query(
                'INSERT INTO orders (agent_id, customer_name, customer_address, customer_phone, order_details, chat_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
                [page.agentId, finalFacebookDraft.customer_name, finalFacebookDraft.customer_address, finalFacebookDraft.customer_phone, finalFacebookDraft.order_details, String(senderId)]
              );
              const savedId = savedResult.rows[0]?.id;
              console.log('✓ Order saved: id=' + (savedId || 'unknown') + ' agent=' + page.agentId + ' chat=' + senderId);
              try {
                await notifyOwnerViaAnyTelegramBot('🛒 নতুন অর্ডার এসেছে! (Facebook Messenger)\\n\\n👤 নাম: ' + finalFacebookDraft.customer_name + '\\n📍 ঠিকানা: ' + finalFacebookDraft.customer_address + '\\n📞 ফোন: ' + finalFacebookDraft.customer_phone + '\\n📦 বিবরণ: ' + finalFacebookDraft.order_details);
                console.log('✓ Telegram order notification sent for order=' + (savedId || 'unknown'));
              } catch (notifyErr) {
                console.error('Final Facebook Telegram notification error:', notifyErr.message);
              }
              if (typeof global.notifyOrderCreated === 'function') {
                try {
                  await global.notifyOrderCreated({
                    id: savedId,
                    agent_id: page.agentId,
                    customer_name: finalFacebookDraft.customer_name,
                    customer_phone: finalFacebookDraft.customer_phone,
                    customer_address: finalFacebookDraft.customer_address,
                    order_details: finalFacebookDraft.order_details,
                    chat_id: String(senderId),
                    created_at: new Date().toISOString()
                  });
                } catch (eventErr) {
                  console.error('Final Facebook order event notification error:', eventErr.message);
                }
              }
            } catch (saveErr) {
              console.error('Final Facebook order save error:', saveErr.message);
            }
          } else {
            console.log('Order save result FB final: already exists id=' + existingOrder.rows[0].id);
          }
          page.orderSaved[senderId] = true;
          delete page.pendingOrderDrafts[senderId];
        }
`;
  source = source.slice(0, savePos) + finalSave + '\n        ' + source.slice(savePos);

  // Replace the generic notifier with a DB-backed multi-token notifier. It tries
  // every saved Telegram bot and logs Telegram's actual API response when one fails.
  const notifierStart = source.indexOf('async function notifyOwnerViaAnyTelegramBot(text) {', webhookPos);
  if (notifierStart < 0) throw new Error('Final order runtime: Telegram notifier not found');
  const notifierEnd = source.indexOf('\n}\n\napp.get("/orders/list"', notifierStart);
  if (notifierEnd < 0) throw new Error('Final order runtime: Telegram notifier end not found');
  const notifierReplacement = `async function notifyOwnerViaAnyTelegramBot(text) {
  const myChatId = process.env.MY_TELEGRAM_CHAT_ID;
  if (!myChatId) {
    throw new Error('MY_TELEGRAM_CHAT_ID is not configured');
  }

  const result = await pool.query('SELECT bot_token FROM telegram_bots ORDER BY created_at DESC');
  const tokens = result.rows.map(r => r.bot_token).filter(Boolean);
  if (!tokens.length) {
    throw new Error('No Telegram bot token found in telegram_bots table');
  }

  let lastError = 'unknown Telegram error';
  for (const anyToken of tokens) {
    try {
      const response = await fetch(\`https://api.telegram.org/bot\${anyToken}/sendMessage\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: myChatId, text })
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data?.ok) {
        console.log('✓ Telegram API accepted order notification');
        return true;
      }
      lastError = data?.description || ('HTTP ' + response.status);
      console.error('Telegram notification attempt failed:', lastError);
    } catch (err) {
      lastError = err.message;
      console.error('Telegram notification attempt error:', lastError);
    }
  }

  throw new Error(lastError);
}`;
  source = source.slice(0, notifierStart) + notifierReplacement + source.slice(notifierEnd + 2);

  console.log('✓ Final order confirmation runtime guard active');
  return module._compile(source, filename);
};
