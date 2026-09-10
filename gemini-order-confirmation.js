// Gemini-backed final order checker.
// Loaded after order-confirmation-finalizer.js so Gemini decides whether the
// conversation contains a genuine, complete order before it is saved.
const fs = require('fs');
const Module = require('module');
const path = require('path');

const previousLoader = Module._extensions['.js'];

Module._extensions['.js'] = function geminiOrderConfirmationLoader(module, filename) {
  if (path.basename(filename) !== 'server.js') return previousLoader(module, filename);

  let source = fs.readFileSync(filename, 'utf8');
  const replacement = `async function extractOrderInfo(historyArr) {
  const API_KEY = process.env.GEMINI_API_KEY;
  if (!API_KEY) return { complete: false };

  const conversation = (historyArr || []).map(m => ({
    role: m.role,
    text: (m.parts || []).map(p => p.text || '').join(' ').trim()
  })).filter(m => m.text);

  if (!conversation.length) return { complete: false };

  const prompt = \`তুমি একটি e-commerce order verification tool। নিচের customer-agent কথোপকথন বিশ্লেষণ করো।

অর্ডার COMPLETE হবে শুধু তখনই যখন:
1) customer সত্যিই কোনো পণ্য/সেবা অর্ডার করতে চায়;
2) customer-এর নাম পাওয়া গেছে;
3) ফোন নম্বর পাওয়া গেছে;
4) delivery address পাওয়া গেছে;
5) কী পণ্য/কতটি বা order-এর যথেষ্ট বিবরণ পাওয়া গেছে;
6) কথোপকথনে customer-এর পক্ষ থেকে order করার স্পষ্ট সম্মতি আছে, অথবা customer-এর শেষ কথায় অর্ডার করতে রাজি হওয়ার অর্থ পরিষ্কার।

শুধু ফোন নম্বর, শুধু product-এর নাম, বা শুধু তথ্য দেওয়া মানেই order নয়।
কোনো cancellation/না লাগবে/বাতিল থাকলে complete=false দাও।
Agent-এর নিজের বানানো নাম/ঠিকানা/ফোনকে customer তথ্য হিসেবে ধরবে না।
বাংলা ও ইংরেজি দুই ধরনের সংখ্যা/ভাষা বুঝবে।

শুধু valid JSON দাও, অন্য কোনো লেখা নয়:
{"complete":true,"customer_name":"...","customer_address":"...","customer_phone":"...","order_details":"..."}
অথবা
{"complete":false}\n\nকথোপকথন:\n\${JSON.stringify(conversation)}\`;

  try {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + encodeURIComponent(API_KEY), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: prompt }] },
        contents: [{ role: 'user', parts: [{ text: 'কথোপকথন যাচাই করে order status নির্ধারণ করো।' }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 }
      })
    });

    if (!response.ok) return { complete: false };
    const data = await response.json();
    let text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    text = text.replace(/\\`\\`\\`json|\\`\\`\\`/g, '').trim();
    const match = text.match(/\\{[\\s\\S]*\\}/);
    if (!match) return { complete: false };

    const parsed = JSON.parse(match[0]);
    if (parsed.complete !== true) return { complete: false };

    const phone = String(parsed.customer_phone || '').replace(/[\\s-]/g, '');
    if (!parsed.customer_name || !parsed.customer_address || !phone || !parsed.order_details) {
      return { complete: false };
    }

    return {
      complete: true,
      customer_name: String(parsed.customer_name).trim(),
      customer_address: String(parsed.customer_address).trim(),
      customer_phone: phone,
      order_details: String(parsed.order_details).trim()
    };
  } catch (err) {
    console.error('Gemini order checker error:', err.message);
    return { complete: false };
  }
}`;

  const start = source.indexOf('async function extractOrderInfo(historyArr) {');
  const end = source.indexOf('\n\nasync function saveOrderAndNotify', start);
  if (start < 0 || end < 0) {
    throw new Error('Gemini order checker: extractOrderInfo block not found');
  }

  source = source.slice(0, start) + replacement + source.slice(end);
  return module._compile(source, filename);
};
