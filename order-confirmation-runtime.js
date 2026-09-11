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

  // This loader reads the original server.js source. Therefore helpers needed
  // by the final guard are defined here as well.
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
        // A complete draft is not a confirmation. Only the latest raw customer
        // message can confirm the order.
        const finalUserText = String(text || '').trim();
        const finalUserConfirmed = /^(হ্যাঁ|জি|জ্বি|ঠিক আছে|কনফার্ম|কনফার্ম করুন|confirm|confirmed|নিশ্চিত|নিশ্চিত করছি|অর্ডার দিন|অর্ডার করুন|অর্ডারটা করে দিন|করে দিন|করে দেন)[\\s,।.!?]*$/i.test(finalUserText);
        const finalDraft = await extractOrderInfo(page.histories[senderId]);
        if (finalDraft.complete && !finalUserConfirmed) {
          reply = buildOrderConfirmationReply(finalDraft);
          console.log('✓ Final order guard: confirmation question enforced');
        }
`;
  source = source.slice(0, replyPos + replyAnchor.length) + guard + source.slice(replyPos + replyAnchor.length);

  // Inject a final save check before the original legacy save block. This uses
  // the stable anchor rather than depending on the exact shape of the old block.
  const saveAnchor = 'const banglaToEnglishDigits = text.replace(/[০-৯]/g, d => \'০১২৩৪৫৬৭৮৯\'.indexOf(d));';
  const savePos = source.indexOf(saveAnchor, webhookPos);
  if (savePos < 0) throw new Error('Final order runtime: Facebook save anchor not found');

  const finalSave = `
        const finalFacebookDraft = await extractOrderInfo(page.histories[senderId]);
        const finalFacebookConfirmed = /^(হ্যাঁ|জি|জ্বি|ঠিক আছে|কনফার্ম|কনফার্ম করুন|confirm|confirmed|নিশ্চিত|নিশ্চিত করছি|অর্ডার দিন|অর্ডার করুন|অর্ডারটা করে দিন|করে দিন|করে দেন)[\\s,।.!?]*$/i.test(String(text || '').trim());
        console.log('Order gate FB final:', JSON.stringify({ complete: finalFacebookDraft.complete, confirmed: finalFacebookConfirmed, chatId: senderId }));
        if (finalFacebookConfirmed && finalFacebookDraft.complete) {
          const existingOrder = await pool.query('SELECT id FROM orders WHERE chat_id = $1 LIMIT 1', [String(senderId)]).catch(() => ({ rows: [] }));
          if (!existingOrder.rows.length) {
            await saveOrderAndNotify(page.agentId, senderId, finalFacebookDraft, 'Facebook Messenger', null);
            console.log('Order save result FB final: attempted');
          } else {
            console.log('Order save result FB final: already exists id=' + existingOrder.rows[0].id);
          }
          page.orderSaved[senderId] = true;
        }
`;
  source = source.slice(0, savePos) + finalSave + '\n        ' + source.slice(savePos);

  console.log('✓ Final order confirmation runtime guard active');
  return module._compile(source, filename);
};
