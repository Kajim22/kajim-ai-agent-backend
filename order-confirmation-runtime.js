// Final runtime guard for Messenger order confirmation.
// IMPORTANT: this file only adds a confirmation question before the existing
// order-save flow. It does not replace the existing save or Telegram logic.
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

  // Only intervene when all order information is complete and the latest
  // customer message is not itself a confirmation. The original save,
  // notification, deduplication and New Orders flow remains untouched.
  const guard = `
        const finalUserText = String(text || '').trim();
        const finalUserConfirmed = /^(হ্যাঁ|হ্যা|হা|জি|জ্বি|জী|জ্বী|ঠিক আছে|কনফার্ম|কনফার্ম করুন|নিশ্চিত|নিশ্চিত করছি|অর্ডার দিন|অর্ডার করুন|অর্ডারটা করে দিন|করে দিন|করে দেন|confirm|confirmed|yes|ok|okay)[\\s,،।.!?;:؛ঃ\\-_/\\\\]*$/i.test(finalUserText);
        const finalDraft = await extractOrderInfo(page.histories[senderId]);
        if (finalDraft?.complete && !finalUserConfirmed) {
          reply = buildOrderConfirmationReply(finalDraft);
          console.log('✓ Final order guard: confirmation question enforced');
        }
`;
  source = source.slice(0, replyPos + replyAnchor.length) + guard + source.slice(replyPos + replyAnchor.length);

  console.log('✓ Final order confirmation question runtime active');
  return module._compile(source, filename);
};
