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
        const finalUserConfirmed = /^(হ্যাঁ|জি|জ্বি|ঠিক আছে|কনফার্ম|কনফার্ম করুন|confirm|confirmed|নিশ্চিত|নিশ্চিত করছি|অর্ডার দিন|অর্ডার করুন|অর্ডারটা করে দিন|করে দিন|করে দেন)[\\s,।.!?]*$/i.test(finalUserText);
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
        const finalFacebookConfirmed = /^(হ্যাঁ|জি|জ্বি|ঠিক আছে|কনফার্ম|কনফার্ম করুন|confirm|confirmed|নিশ্চিত|নিশ্চিত করছি|অর্ডার দিন|অর্ডার করুন|অর্ডারটা করে দিন|করে দিন|করে দেন)[\\s,।.!?]*$/i.test(String(text || '').trim());
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
              await notifyOwnerViaAnyTelegramBot('🛒 নতুন অর্ডার এসেছে! (Facebook Messenger)\\n\\n👤 নাম: ' + finalFacebookDraft.customer_name + '\\n📍 ঠিকানা: ' + finalFacebookDraft.customer_address + '\\n📞 ফোন: ' + finalFacebookDraft.customer_phone + '\\n📦 বিবরণ: ' + finalFacebookDraft.order_details);
              console.log('✓ Telegram order notification sent for order=' + (savedId || 'unknown'));
              if (typeof global.notifyOrderCreated === 'function') {
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

  console.log('✓ Final order confirmation runtime guard active');
  return module._compile(source, filename);
};
