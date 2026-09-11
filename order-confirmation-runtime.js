// Final runtime guard for Messenger order confirmation.
// This is intentionally loaded AFTER order-confirmation-finalizer.js.
// Gemini may generate natural-language text, but only this guard can allow an
// order save: complete customer data + explicit confirmation in the latest
// customer message.
const fs = require('fs');
const Module = require('module');
const path = require('path');

const previousLoader = Module._extensions['.js'];

Module._extensions['.js'] = function finalOrderRuntimeLoader(module, filename) {
  if (path.basename(filename) !== 'server.js') return previousLoader(module, filename);

  let source = fs.readFileSync(filename, 'utf8');
  const webhookPos = source.indexOf('app.post("/webhook/facebook"');
  if (webhookPos < 0) throw new Error('Final order runtime: Facebook webhook not found');

  const replyAnchor = 'let reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || "দুঃখিত, উত্তর তৈরি করা যায়নি।";';
  const replyPos = source.indexOf(replyAnchor, webhookPos);
  if (replyPos < 0) throw new Error('Final order runtime: Facebook reply anchor not found');

  const guard = `
        // Final safety guard: a complete draft is NOT a confirmation.
        // The latest customer message must explicitly confirm the order.
        const finalUserText = String(text || '').trim();
        const finalUserConfirmed = /^(হ্যাঁ|জি|জ্বি|ঠিক আছে|কনফার্ম|কনফার্ম করুন|confirm|confirmed|নিশ্চিত|নিশ্চিত করছি|অর্ডার দিন|অর্ডার করুন|অর্ডারটা করে দিন|করে দিন|করে দেন)[\\s,।.!?]*$/i.test(finalUserText);
        const finalDraft = await extractOrderInfo(page.histories[senderId]);
        if (finalDraft.complete && !finalUserConfirmed) {
          reply = buildOrderConfirmationReply(finalDraft);
          console.log('✓ Final order guard: confirmation question enforced');
        }
`;
  source = source.slice(0, replyPos + replyAnchor.length) + guard + source.slice(replyPos + replyAnchor.length);

  // Replace the Facebook save block once more, after all earlier order layers.
  const gateStart = source.indexOf('const banglaToEnglishDigits = text.replace(/[০-৯]/g, d => \'০১২৩৪৫৬৭৮৯\'.indexOf(d));', webhookPos);
  if (gateStart < 0) throw new Error('Final order runtime: Facebook save gate not found');
  const gateEnd = source.indexOf('\\n      } catch (err) {', gateStart);
  if (gateEnd < 0) throw new Error('Final order runtime: Facebook save gate end not found');

  const finalGate = `const finalFacebookDraft = await extractOrderInfo(page.histories[senderId]);
        const finalFacebookConfirmed = /^(হ্যাঁ|জি|জ্বি|ঠিক আছে|কনফার্ম|কনফার্ম করুন|confirm|confirmed|নিশ্চিত|নিশ্চিত করছি|অর্ডার দিন|অর্ডার করুন|অর্ডারটা করে দিন|করে দিন|করে দেন)[\\s,।.!?]*$/i.test(String(text || '').trim());
        if (!page.orderSaved[senderId] && finalFacebookConfirmed && finalFacebookDraft.complete) {
          const saved = await saveOrderAndNotify(page.agentId, senderId, finalFacebookDraft, 'Facebook Messenger', null);
          console.log('Final Facebook order save:', saved);
          if (saved) page.orderSaved[senderId] = true;
        }`;
  source = source.slice(0, gateStart) + finalGate + source.slice(gateEnd);

  console.log('✓ Final order confirmation runtime guard active');
  return module._compile(source, filename);
};
