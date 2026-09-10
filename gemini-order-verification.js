// Gemini order verification layer.
// Loaded after order-confirmation-finalizer.js and replaces only its order extractor.
// Gemini is called only when the existing flow detects a phone number, not on every message.
const fs = require('fs');
const Module = require('module');
const path = require('path');

const previousLoader = Module._extensions['.js'];

Module._extensions['.js'] = function geminiOrderVerificationLoader(module, filename) {
  if (path.basename(filename) !== 'server.js') return previousLoader(module, filename);

  let source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf('async function extractOrderInfo(historyArr) {');
  const end = source.indexOf('\n\nasync function saveOrderAndNotify', start);
  if (start < 0 || end < 0) return previousLoader(module, filename);

  const replacement = `async function extractOrderInfo(historyArr) {
  const API_KEY = process.env.GEMINI_API_KEY;
  if (!API_KEY) return { complete: false };

  const extractPrompt = \`তুমি customer conversation থেকে order যাচাই করবে।

শুধুমাত্র তখন complete=true দেবে যখন customer-এর অর্ডারের জন্য এই সব তথ্য conversation-এ বাস্তবে পাওয়া যায়:
1) customer-এর নাম
2) delivery address
3) valid Bangladesh mobile number
4) পণ্যের নাম এবং যথেষ্ট order details (যেমন quantity/variant থাকলে তা সহ)

Customer শুধু দাম জিজ্ঞেস করলে, আগ্রহ দেখালে, "নেব" বললে কিন্তু প্রয়োজনীয় তথ্য অসম্পূর্ণ থাকলে complete=false।
তথ্য আলাদা আলাদা message-এ থাকলে সব message মিলিয়ে দেখবে।
কোনো required তথ্য অনুমান করবে না।

শুধু valid JSON দাও:
complete হলে: {"complete":true,"customer_name":"...","customer_address":"...","customer_phone":"...","order_details":"..."}
অন্যথায়: {"complete":false}\`;

  try {
    const res = await fetch(\`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=\${API_KEY}\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: extractPrompt }] },
        contents: historyArr,
        generationConfig: { responseMimeType: 'application/json' }
      })
    });

    const data = await res.json();
    if (!res.ok || data?.error) return { complete: false };
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { complete: false };

    const parsed = JSON.parse(match[0]);
    if (!parsed.complete) return { complete: false };

    const name = String(parsed.customer_name || '').trim();
    const address = String(parsed.customer_address || '').trim();
    const details = String(parsed.order_details || '').trim();
    const phone = String(parsed.customer_phone || '').replace(/[\s-]/g, '');
    const normalizedPhone = phone.replace(/^\+88/, '').replace(/^88(?=01)/, '');

    if (!name || !address || !details || !/^01[3-9]\d{8}$/.test(normalizedPhone)) {
      return { complete: false };
    }

    return {
      complete: true,
      customer_name: name,
      customer_address: address,
      customer_phone: normalizedPhone,
      order_details: details
    };
  } catch (err) {
    console.error('Gemini order verification error:', err.message);
    return { complete: false };
  }
}`;

  source = source.slice(0, start) + replacement + source.slice(end);
  return module._compile(source, filename);
};
