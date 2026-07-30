const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Database Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// টেবিল তৈরি করা (প্রথমবার চালু হওয়ার সময়)
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS telegram_bots (
        bot_token TEXT PRIMARY KEY,
        system_prompt TEXT NOT NULL,
        agent_id TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS agent_knowledge (
        id SERIAL PRIMARY KEY,
        agent_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        agent_id TEXT,
        customer_name TEXT,
        customer_address TEXT,
        customer_phone TEXT,
        order_details TEXT,
        chat_id TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS facebook_pages (
        page_id TEXT PRIMARY KEY,
        page_access_token TEXT NOT NULL,
        system_prompt TEXT NOT NULL,
        agent_id TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id SERIAL PRIMARY KEY,
        platform TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        agent_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`ALTER TABLE telegram_bots ADD COLUMN IF NOT EXISTS agent_id TEXT`);
    console.log('✓ Database ready');
  } catch (err) {
    console.error('Database init error:', err.message);
  }
}

// ==== Knowledge Base হেল্পার ====
async function getKnowledgeText(agentId) {
  if (!agentId) return '';
  try {
    const result = await pool.query(
      "SELECT content FROM agent_knowledge WHERE agent_id = $1 ORDER BY created_at ASC",
      [agentId]
    );
    if (result.rows.length === 0) return '';
    const points = result.rows.map(r => `- ${r.content}`).join('\n');
    return `\n\nনিচের তথ্যগুলো ব্যবহার করে উত্তর দাও (Knowledge Base):\n${points}\n\nযদি কোনো Knowledge Base তথ্যে ছবির লিংক (URL) থাকে এবং গ্রাহক সেই পণ্যের ছবি দেখতে চায়, তাহলে তোমার উত্তরের একদম শেষে এই ফরম্যাটে লিখো: [IMAGE: ছবির-লিংক]। এই ট্যাগ শুধু তখনই ব্যবহার করবে যখন গ্রাহক সত্যিই ছবি দেখতে চেয়েছে বা ছবি দেখানো প্রাসঙ্গিক।`;
  } catch (err) {
    console.error('getKnowledgeText error:', err.message);
    return '';
  }
}

// ==== Chat History হেল্পার ====
async function saveChatMessage(platform, chatId, agentId, role, content) {
  try {
    await pool.query(
      "INSERT INTO chat_messages (platform, chat_id, agent_id, role, content) VALUES ($1, $2, $3, $4, $5)",
      [platform, String(chatId), agentId, role, content]
    );
  } catch (err) {
    console.error('saveChatMessage error:', err.message);
  }
}

async function loadChatHistory(platform, chatId) {
  try {
    const result = await pool.query(
      "SELECT role, content FROM chat_messages WHERE platform = $1 AND chat_id = $2 ORDER BY created_at ASC LIMIT 20",
      [platform, String(chatId)]
    );
    return result.rows.map(r => ({ role: r.role, parts: [{ text: r.content }] }));
  } catch (err) {
    console.error('loadChatHistory error:', err.message);
    return [];
  }
}

app.post("/knowledge/add", async (req, res) => {
  const { agentId, content } = req.body;
  if (!agentId || !content) return res.json({ success: false, error: "agentId ও content প্রয়োজন" });
  try {
    await pool.query("INSERT INTO agent_knowledge (agent_id, content) VALUES ($1, $2)", [agentId, content]);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.post("/knowledge/delete", async (req, res) => {
  const { id } = req.body;
  if (!id) return res.json({ success: false, error: "id প্রয়োজন" });
  try {
    await pool.query("DELETE FROM agent_knowledge WHERE id = $1", [id]);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get("/knowledge/list/:agentId", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, content, created_at FROM agent_knowledge WHERE agent_id = $1 ORDER BY created_at DESC",
      [req.params.agentId]
    );
    res.json(result.rows);
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ==== Order Detection ====

async function extractOrderInfo(historyArr) {
  const API_KEY = process.env.GEMINI_API_KEY;
  const extractPrompt = `তুমি একটা তথ্য বের করার টুল। নিচের কথোপকথন থেকে গ্রাহকের অর্ডার তথ্য (নাম, ঠিকানা, ফোন) বের করো।

কড়া নিয়ম: তোমার উত্তর অবশ্যই শুধুমাত্র একটা valid JSON object হতে হবে। কোনো ব্যাখ্যা, ভূমিকা, মন্তব্য বা মার্কডাউন লিখবে না। শুধু নিচের যেকোনো একটা ফরম্যাট, আর কিছু না:

তথ্য সম্পূর্ণ থাকলে:
{"complete": true, "customer_name": "নাম", "customer_address": "ঠিকানা", "customer_phone": "ফোন", "order_details": "সংক্ষিপ্ত বিবরণ"}

তথ্য অসম্পূর্ণ বা অর্ডার না থাকলে:
{"complete": false}`;

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: extractPrompt }] },
        contents: historyArr,
        generationConfig: { responseMimeType: "application/json" }
      })
    });
    const data = await res.json();
    let text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{"complete": false}';
    text = text.replace(/```json|```/g, '').trim();

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { complete: false };

    const parsed = JSON.parse(match[0]);
    return parsed;
  } catch (err) {
    console.error('extractOrderInfo error:', err.message);
    return { complete: false };
  }
}

async function saveOrderAndNotify(agentId, chatId, orderInfo, notifyPlatform, notifyToken) {
  try {
    await pool.query(
      `INSERT INTO orders (agent_id, customer_name, customer_address, customer_phone, order_details, chat_id) VALUES ($1, $2, $3, $4, $5, $6)`,
      [agentId, orderInfo.customer_name, orderInfo.customer_address, orderInfo.customer_phone, orderInfo.order_details, String(chatId)]
    );

    const notifyText = `🛒 নতুন অর্ডার এসেছে! (${notifyPlatform})\n\n👤 নাম: ${orderInfo.customer_name}\n📍 ঠিকানা: ${orderInfo.customer_address}\n📞 ফোন: ${orderInfo.customer_phone}\n📦 বিবরণ: ${orderInfo.order_details}`;

    const myChatId = process.env.MY_TELEGRAM_CHAT_ID;
    if (myChatId && notifyToken) {
      await fetch(`https://api.telegram.org/bot${notifyToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: myChatId, text: notifyText })
      });
    }
  } catch (err) {
    console.error('saveOrderAndNotify error:', err.message);
  }
}

async function notifyOwnerViaAnyTelegramBot(text) {
  try {
    const myChatId = process.env.MY_TELEGRAM_CHAT_ID;
    if (!myChatId) return;
    const result = await pool.query("SELECT bot_token FROM telegram_bots LIMIT 1");
    const anyToken = result.rows[0]?.bot_token;
    if (!anyToken) return;
    await fetch(`https://api.telegram.org/bot${anyToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: myChatId, text })
    });
  } catch (err) {
    console.error('notifyOwnerViaAnyTelegramBot error:', err.message);
  }
}

app.get("/orders/list", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM orders ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (err) {
    res.json({ error: err.message });
  }
});

// API Endpoint (টেস্ট সেন্টার থেকে কল হয়)
app.post("/chat", async (req, res) => {
  const { message, systemPrompt, history, agentId } = req.body;
  const API_KEY = process.env.GEMINI_API_KEY;

  if (!API_KEY) {
    return res.json({ reply: "Error: API Key সেট করা নেই।" });
  }

  try {
    const knowledgeText = await getKnowledgeText(agentId);
    const fullPrompt = (systemPrompt || "তুমি একজন সহকারী।") + knowledgeText;

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: fullPrompt }] },
        contents: history
      })
    });

    const data = await response.json();
    
    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || 
                  data?.error?.message || 
                  "দুঃখিত, কোনো উত্তর পাওয়া যায়নি।";

    res.json({ reply });
  } catch (err) {
    res.json({ reply: "সার্ভার এরর: " + err.message });
  }
});

// ==== Telegram Bot Integration ====

const telegramBots = {};

app.post("/telegram/connect", async (req, res) => {
  const { botToken, systemPrompt, agentId } = req.body;
  if (!botToken) return res.json({ success: false, error: "Bot token প্রয়োজন" });

  const prompt = systemPrompt || "তুমি একজন সহকারী।";
  telegramBots[botToken] = { systemPrompt: prompt, agentId: agentId || null, histories: {}, orderSaved: {} };

  try {
    const webhookUrl = `https://kajim-ai-agent-backend.onrender.com/telegram/webhook/${botToken}`;
    const setResp = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
    const setData = await setResp.json();
    if (!setData.ok) return res.json({ success: false, error: setData.description || "Webhook সেট করা যায়নি" });

    await pool.query(
      `INSERT INTO telegram_bots (bot_token, system_prompt, agent_id) VALUES ($1, $2, $3)
       ON CONFLICT (bot_token) DO UPDATE SET system_prompt = $2, agent_id = $3`,
      [botToken, prompt, agentId || null]
    );

    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

async function getTelegramFileBase64(token, fileId) {
  try {
    const fileRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
    const fileData = await fileRes.json();
    const filePath = fileData?.result?.file_path;
    if (!filePath) return null;
    const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
    const fileBuffer = await fetch(fileUrl).then(r => r.arrayBuffer());
    return Buffer.from(fileBuffer).toString('base64');
  } catch (err) {
    console.error('getTelegramFileBase64 error:', err.message);
    return null;
  }
}

app.post("/telegram/webhook/:token", async (req, res) => {
  const token = req.params.token;
  const bot = telegramBots[token];
  res.sendStatus(200);
  if (!bot) return;

  const update = req.body;
  const chatId = update?.message?.chat?.id;
  if (!chatId) return;

  const textMsg = update?.message?.text;
  const photo = update?.message?.photo;
  const voice = update?.message?.voice;

  if (!textMsg && !photo && !voice) return;

  let userParts = [];
  let text = textMsg || '';

  try {
    if (photo && photo.length > 0) {
      const largestPhoto = photo[photo.length - 1];
      const base64 = await getTelegramFileBase64(token, largestPhoto.file_id);
      if (base64) {
        userParts.push({ inline_data: { mime_type: "image/jpeg", data: base64 } });
        text = textMsg || 'এই ছবিটা দেখে সাহায্য করো।';
      }
    } else if (voice) {
      const base64 = await getTelegramFileBase64(token, voice.file_id);
      if (base64) {
        userParts.push({ inline_data: { mime_type: "audio/ogg", data: base64 } });
        text = 'এই ভয়েস মেসেজটা শুনে উত্তর দাও।';
      }
    }
  } catch (err) {
    console.error('File processing error:', err.message);
  }

  userParts.push({ text });

  if (!bot.histories[chatId]) bot.histories[chatId] = await loadChatHistory('telegram', chatId);
  bot.histories[chatId].push({ role: "user", parts: userParts });
  await saveChatMessage('telegram', chatId, bot.agentId, 'user', text);

  const API_KEY = process.env.GEMINI_API_KEY;
  try {
    const knowledgeText = await getKnowledgeText(bot.agentId);
    const fullPrompt = bot.systemPrompt + knowledgeText;

    const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: fullPrompt }] },
        contents: bot.histories[chatId]
      })
    });
    const data = await geminiRes.json();
    let reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || "দুঃখিত, উত্তর তৈরি করা যায়নি।";

    bot.histories[chatId].push({ role: "model", parts: [{ text: reply }] });
    if (bot.histories[chatId].length > 20) bot.histories[chatId] = bot.histories[chatId].slice(-20);
    await saveChatMessage('telegram', chatId, bot.agentId, 'model', reply);

    const imageMatch = reply.match(/\[IMAGE:\s*(https?:\/\/[^\]\s]+)\]/);
    let imageUrl = null;
    if (imageMatch) {
      imageUrl = imageMatch[1];
      reply = reply.replace(imageMatch[0], '').trim();
    }

    if (imageUrl) {
      await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, photo: imageUrl, caption: reply })
      });
    } else {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: reply })
      });
    }

    const banglaToEnglishDigits = text.replace(/[০-৯]/g, d => '০১২৩৪৫৬৭৮৯'.indexOf(d));
    const cleanedText = banglaToEnglishDigits.replace(/[\s-]/g, '');
    const hasPhoneNumber = /\d{10,11}/.test(cleanedText);
    if (!bot.orderSaved[chatId] && hasPhoneNumber) {
      const orderInfo = await extractOrderInfo(bot.histories[chatId]);
      if (orderInfo.complete) {
        bot.orderSaved[chatId] = true;
        await saveOrderAndNotify(bot.agentId, chatId, orderInfo, 'Telegram', token);
      }
    }
  } catch (err) {
    console.error("Telegram bot error:", err.message);
  }
});

app.get("/telegram/list", async (req, res) => {
  try {
    const result = await pool.query("SELECT bot_token, system_prompt, agent_id, created_at FROM telegram_bots ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ==== Facebook Messenger Integration ====

const facebookPages = {};

app.post("/facebook/connect", async (req, res) => {
  const { pageId, pageAccessToken, systemPrompt, agentId } = req.body;
  if (!pageId || !pageAccessToken) return res.json({ success: false, error: "pageId ও pageAccessToken প্রয়োজন" });

  const prompt = systemPrompt || "তুমি একজন সহকারী।";
  facebookPages[pageId] = { pageAccessToken, systemPrompt: prompt, agentId: agentId || null, histories: {}, orderSaved: {} };

  try {
    await pool.query(
      `INSERT INTO facebook_pages (page_id, page_access_token, system_prompt, agent_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (page_id) DO UPDATE SET page_access_token = $2, system_prompt = $3, agent_id = $4`,
      [pageId, pageAccessToken, prompt, agentId || null]
    );
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get("/webhook/facebook", (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.FB_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

async function getUrlAsBase64(url) {
  try {
    const fileBuffer = await fetch(url).then(r => r.arrayBuffer());
    return Buffer.from(fileBuffer).toString('base64');
  } catch (err) {
    console.error('getUrlAsBase64 error:', err.message);
    return null;
  }
}

app.post("/webhook/facebook", async (req, res) => {
  res.sendStatus(200);
  const body = req.body;
  if (body.object !== 'page') return;

  for (const entry of body.entry || []) {
    const pageId = entry.id;
    const page = facebookPages[pageId];
    if (!page) continue;

    for (const event of entry.messaging || []) {
      const senderId = event.sender?.id;
      const textMsg = event.message?.text;
      const attachments = event.message?.attachments;
      if (!senderId) continue;
      if (!textMsg && !attachments) continue;

      let userParts = [];
      let text = textMsg || '';

      try {
        if (attachments && attachments.length > 0) {
          const att = attachments[0];
          if (att.type === 'image') {
            const base64 = await getUrlAsBase64(att.payload.url);
            if (base64) {
              userParts.push({ inline_data: { mime_type: "image/jpeg", data: base64 } });
              text = textMsg || 'এই ছবিটা দেখে সাহায্য করো।';
            }
          } else if (att.type === 'audio') {
            const base64 = await getUrlAsBase64(att.payload.url);
            if (base64) {
              userParts.push({ inline_data: { mime_type: "audio/mp4", data: base64 } });
              text = 'এই ভয়েস মেসেজটা শুনে উত্তর দাও।';
            }
          }
        }
      } catch (err) {
        console.error('FB attachment error:', err.message);
      }

      userParts.push({ text });

      if (!page.histories[senderId]) page.histories[senderId] = await loadChatHistory('facebook', senderId);
      page.histories[senderId].push({ role: "user", parts: userParts });
      await saveChatMessage('facebook', senderId, page.agentId, 'user', text);

      const API_KEY = process.env.GEMINI_API_KEY;
      try {
        const knowledgeText = await getKnowledgeText(page.agentId);
        const fullPrompt = page.systemPrompt + knowledgeText;

        const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: fullPrompt }] },
            contents: page.histories[senderId]
          })
        });
        const data = await geminiRes.json();
        let reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || "দুঃখিত, উত্তর তৈরি করা যায়নি।";

        page.histories[senderId].push({ role: "model", parts: [{ text: reply }] });
        if (page.histories[senderId].length > 20) {
          page.histories[senderId] = page.histories[senderId].slice(-20);
        }
        await saveChatMessage('facebook', senderId, page.agentId, 'model', reply);

        const imageMatch = reply.match(/\[IMAGE:\s*(https?:\/\/[^\]\s]+)\]/);
        let imageUrl = null;
        if (imageMatch) {
          imageUrl = imageMatch[1];
          reply = reply.replace(imageMatch[0], '').trim();
        }

        if (imageUrl) {
          await fetch(`https://graph.facebook.com/v20.0/me/messages?access_token=${page.pageAccessToken}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              recipient: { id: senderId },
              message: { attachment: { type: "image", payload: { url: imageUrl, is_reusable: true } } }
            })
          });
          if (reply) {
            await fetch(`https://graph.facebook.com/v20.0/me/messages?access_token=${page.pageAccessToken}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ recipient: { id: senderId }, message: { text: reply } })
            });
          }
        } else {
          await fetch(`https://graph.facebook.com/v20.0/me/messages?access_token=${page.pageAccessToken}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ recipient: { id: senderId }, message: { text: reply } })
          });
        }

        const banglaToEnglishDigits = text.replace(/[০-৯]/g, d => '০১২৩৪৫৬৭৮৯'.indexOf(d));
        const cleanedText = banglaToEnglishDigits.replace(/[\s-]/g, '');
        const hasPhoneNumber = /\d{10,11}/.test(cleanedText);
        if (!page.orderSaved[senderId] && hasPhoneNumber) {
          const orderInfo = await extractOrderInfo(page.histories[senderId]);
          if (orderInfo.complete) {
            page.orderSaved[senderId] = true;
            await saveOrderAndNotify(page.agentId, senderId, orderInfo, 'Facebook Messenger', null);
            await notifyOwnerViaAnyTelegramBot(`🛒 নতুন অর্ডার এসেছে! (Facebook Messenger)\n\n👤 নাম: ${orderInfo.customer_name}\n📍 ঠিকানা: ${orderInfo.customer_address}\n📞 ফোন: ${orderInfo.customer_phone}\n📦 বিবরণ: ${orderInfo.order_details}`);
          }
        }
      } catch (err) {
        console.error("Facebook bot error:", err.message);
      }
    }
  }
});

app.get("/facebook/list", async (req, res) => {
  try {
    const result = await pool.query("SELECT page_id, system_prompt, agent_id, created_at FROM facebook_pages ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (err) {
    res.json({ error: err.message });
  }
});

async function restoreBots() {
  try {
    const result = await pool.query("SELECT bot_token, system_prompt, agent_id FROM telegram_bots");
    for (const row of result.rows) {
      telegramBots[row.bot_token] = { systemPrompt: row.system_prompt, agentId: row.agent_id, histories: {}, orderSaved: {} };

      const webhookUrl = `https://kajim-ai-agent-backend.onrender.com/telegram/webhook/${row.bot_token}`;
      await fetch(`https://api.telegram.org/bot${row.bot_token}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
    }
    console.log(`✓ ${result.rows.length} টা bot auto-reconnect হয়েছে`);

    const fbResult = await pool.query("SELECT page_id, page_access_token, system_prompt, agent_id FROM facebook_pages");
    for (const row of fbResult.rows) {
      facebookPages[row.page_id] = {
        pageAccessToken: row.page_access_token,
        systemPrompt: row.system_prompt,
        agentId: row.agent_id,
        histories: {},
        orderSaved: {}
      };
    }
    console.log(`✓ ${fbResult.rows.length} টা Facebook Page লোড হয়েছে`);
  } catch (err) {
    console.error('Restore bots error:', err.message);
  }
}

// Start Server
app.listen(port, async () => {
  console.log(`Server running on port ${port}`);
  await initDB();
  await restoreBots();
});
