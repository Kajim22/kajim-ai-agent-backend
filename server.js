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

// Facebook webhook event de-duplication (DB-backed for restarts/multiple instances)
async function isFacebookEventProcessed(eventId) {
  if (!eventId) return false;
  try {
    const result = await pool.query(
      `INSERT INTO facebook_events (event_id) VALUES ($1)
       ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [String(eventId)]
    );
    return result.rowCount === 0;
  } catch (err) {
    console.error('Facebook event de-duplication error:', err.message);
    return false;
  }
}

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
      CREATE TABLE IF NOT EXISTS facebook_events (
        event_id TEXT PRIMARY KEY,
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
    console.log('✓ Database ready');
  } catch (err) {
    console.error('Database initialization error:', err.message);
  }
}

async function saveChatMessage(platform, chatId, agentId, role, content) {
  try {
    await pool.query(
      `INSERT INTO chat_messages (platform, chat_id, agent_id, role, content) VALUES ($1, $2, $3, $4, $5)`,
      [platform, String(chatId), agentId || null, role, String(content || '')]
    );
  } catch (err) {
    console.error('saveChatMessage error:', err.message);
  }
}

async function loadChatHistory(platform, chatId) {
  try {
    const result = await pool.query(
      `SELECT role, content FROM chat_messages WHERE platform = $1 AND chat_id = $2 ORDER BY created_at ASC LIMIT 100`,
      [platform, String(chatId)]
    );
    return result.rows.map(row => ({
      role: row.role,
      parts: [{ text: row.content }]
    }));
  } catch (err) {
    console.error('loadChatHistory error:', err.message);
    return [];
  }
}

async function getKnowledgeText(agentId) {
  if (!agentId) return '';
  try {
    const result = await pool.query(
      `SELECT content FROM agent_knowledge WHERE agent_id = $1 ORDER BY created_at ASC`,
      [agentId]
    );
    if (!result.rows.length) return '';
    return `\n\nতথ্যভান্ডার:\n${result.rows.map(r => r.content).join('\n')}`;
  } catch (err) {
    console.error('getKnowledgeText error:', err.message);
    return '';
  }
}

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
    // Save to the existing orders table. The existing New Orders section reads this table.
    const saved = await pool.query(
      `INSERT INTO orders (agent_id, customer_name, customer_address, customer_phone, order_details, chat_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [agentId, orderInfo.customer_name, orderInfo.customer_address, orderInfo.customer_phone, orderInfo.order_details, String(chatId)]
    );

    console.log(`✓ Order saved: id=${saved.rows[0]?.id}, chat_id=${chatId}`);

    const notifyText = `🛒 নতুন অর্ডার এসেছে! (${notifyPlatform})\n\n👤 নাম: ${orderInfo.customer_name}\n📍 ঠিকানা: ${orderInfo.customer_address}\n📞 ফোন: ${orderInfo.customer_phone}\n📦 বিবরণ: ${orderInfo.order_details}`;

    const myChatId = process.env.MY_TELEGRAM_CHAT_ID;
    if (!myChatId) {
      console.error('❌ MY_TELEGRAM_CHAT_ID is not set');
      return;
    }

    // Messenger passes null; in that case use the existing connected Telegram bot token.
    let token = notifyToken;
    if (!token) {
      const result = await pool.query(`SELECT bot_token FROM telegram_bots LIMIT 1`);
      token = result.rows[0]?.bot_token;
    }

    if (!token) {
      console.error('❌ No Telegram bot token found for order notification');
      return;
    }

    const telegramResponse = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || data?.error?.message || "দুঃখিত, কোনো উত্তর পাওয়া যায়নি।";
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
      body: JSON.stringify({ system_instruction: { parts: [{ text: fullPrompt }] }, contents: bot.histories[chatId] })
    });
    const data = await geminiRes.json();
    let reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || "দুঃখিত, উত্তর তৈরি করা যায়নি।";
    bot.histories[chatId].push({ role: "model", parts: [{ text: reply }] });
    if (bot.histories[chatId].length > 20) bot.histories[chatId] = bot.histories[chatId].slice(-20);
    await saveChatMessage('telegram', chatId, bot.agentId, 'model', reply);

    const imageMatch = reply.match(/\[IMAGE:\s*(https?:\/\/[^\]\s]+)\]/);
    let imageUrl = null;
    if (imageMatch) { imageUrl = imageMatch[1]; reply = reply.replace(imageMatch[0], '').trim(); }
    if (imageUrl) {
      await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, photo: imageUrl, caption: reply }) });
    } else {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text: reply }) });
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

// Meta webhook verification: keep the verify token only in the server environment.
app.get("/webhook/facebook", (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const verifyToken = process.env.FB_VERIFY_TOKEN;

  if (mode === 'subscribe' && verifyToken && token === verifyToken && challenge) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
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

async function getFacebookPage(pageId) {
  if (facebookPages[pageId]) return facebookPages[pageId];
  try {
    const result = await pool.query(
      "SELECT page_id, page_access_token, system_prompt, agent_id FROM facebook_pages WHERE page_id = $1 LIMIT 1",
      [String(pageId)]
    );
    const row = result.rows[0];
    if (!row) return null;
    facebookPages[row.page_id] = {
      pageAccessToken: row.page_access_token,
      systemPrompt: row.system_prompt,
      agentId: row.agent_id,
      histories: {},
      orderSaved: {},
      pendingOrders: {}
    };
    return facebookPages[row.page_id];
  } catch (err) {
    console.error('getFacebookPage error:', err.message);
    return null;
  }
}

async function sendFacebookMessage(page, senderId, message) {
  const graphVersion = process.env.FB_GRAPH_VERSION || 'v20.0';
  const url = `https://graph.facebook.com/${graphVersion}/me/messages?access_token=${page.pageAccessToken}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { id: senderId }, message })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    throw new Error(`Facebook send failed: ${data?.error?.message || response.statusText}`);
  }
  return data;
}

app.post("/webhook/facebook", async (req, res) => {
  res.sendStatus(200);
  const body = req.body;
  if (!body || body.object !== 'page' || !Array.isArray(body.entry)) return;

  for (const entry of body.entry) {
    const pageId = entry?.id;
    if (!pageId || !Array.isArray(entry.messaging)) continue;

    const page = await getFacebookPage(pageId);
    if (!page) {
      console.warn(`Facebook Page not connected: ${pageId}`);
      continue;
    }

    if (!page.pendingOrders) page.pendingOrders = {};

    for (const event of entry.messaging) {
      const senderId = event?.sender?.id;
      const eventId = event?.message?.mid || event?.postback?.mid || event?.message?.metadata;
      const textMsg = event?.message?.text;
      const attachments = event?.message?.attachments;

      if (!senderId) continue;
      if (!textMsg && !attachments) continue;
      if (eventId && await isFacebookEventProcessed(eventId)) continue;

      let userParts = [];
      let text = textMsg || '';

      try {
        if (attachments && attachments.length > 0) {
          const att = attachments[0];
          const attachmentUrl = att?.payload?.url;
          if (att.type === 'image' && attachmentUrl) {
            const base64 = await getUrlAsBase64(attachmentUrl);
            if (base64) {
              userParts.push({ inline_data: { mime_type: "image/jpeg", data: base64 } });
              text = textMsg || 'এই ছবিটা দেখে সাহায্য করো।';
            }
          } else if (att.type === 'audio' && attachmentUrl) {
            const base64 = await getUrlAsBase64(attachmentUrl);
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
      if (!API_KEY) {
        console.error('Facebook bot error: GEMINI_API_KEY is not configured');
        continue;
      }

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
        if (!geminiRes.ok || data?.error) throw new Error(`Gemini request failed: ${data?.error?.message || geminiRes.statusText}`);

        let reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || "দুঃখিত, উত্তর তৈরি করা যায়নি।";

        const normalized = String(text || '').trim().toLowerCase().replace(/[“”"'`]/g, '').replace(/[\s,،।.!?;:؛ঃ\-_/\\]+/g, '');
        const confirmed = /^(হ্যাঁ|হ্যা|হা|জি|জ্বি|জী|জ্বী|ঠিকআছে|কনফার্ম|কনফার্মকরুন|নিশ্চিত|নিশ্চিতকরছি|অর্ডারদিন|অর্ডারকরুন|অর্ডারটাকরেদিন|করেদিন|করেদেন|confirm|confirmed|yes|ok|okay)$/.test(normalized);

        let currentDraft = page.pendingOrders[senderId] || null;
        if (!currentDraft) currentDraft = await extractOrderInfo(page.histories[senderId]);

        if (currentDraft?.complete && !confirmed) {
          page.pendingOrders[senderId] = currentDraft;
          reply = `আপনার অর্ডারের তথ্যগুলো পেয়েছি।\n\n👤 নাম: ${currentDraft.customer_name}\n📍 ঠিকানা: ${currentDraft.customer_address}\n📞 ফোন: ${currentDraft.customer_phone}\n📦 পণ্য: ${currentDraft.order_details}\n\nঅর্ডারটি কনফার্ম করবেন? কনফার্ম করতে “জি” বা “কনফার্ম” লিখুন।`;
          console.log(`✓ Order confirmation question sent: chat_id=${senderId}`);
        }

        if (confirmed && page.pendingOrders[senderId]?.complete) {
          currentDraft = page.pendingOrders[senderId];
        }

        page.histories[senderId].push({ role: "model", parts: [{ text: reply }] });
        if (page.histories[senderId].length > 20) page.histories[senderId] = page.histories[senderId].slice(-20);
        await saveChatMessage('facebook', senderId, page.agentId, 'model', reply);

        const imageMatch = reply.match(/\[IMAGE:\s*(https?:\/\/[^\]\s]+)\]/);
        let imageUrl = null;
        if (imageMatch) {
          imageUrl = imageMatch[1];
          reply = reply.replace(imageMatch[0], '').trim();
        }

        if (imageUrl) {
          await sendFacebookMessage(page, senderId, { attachment: { type: "image", payload: { url: imageUrl, is_reusable: true } } });
          if (reply) await sendFacebookMessage(page, senderId, { text: reply });
        } else {
          await sendFacebookMessage(page, senderId, { text: reply });
        }

        if (!page.orderSaved[senderId]) {
          if (confirmed && currentDraft?.complete) {
            page.orderSaved[senderId] = true;
            await saveOrderAndNotify(page.agentId, senderId, currentDraft, 'Facebook Messenger', null);
            delete page.pendingOrders[senderId];
            console.log(`✓ Confirmed Messenger order processed: chat_id=${senderId}`);
          } else if (!confirmed && currentDraft?.complete) {
            console.log(`⏳ Waiting for Messenger confirmation: chat_id=${senderId}`);
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
        orderSaved: {},
        pendingOrders: {}
      };
    }
    console.log(`✓ ${fbResult.rows.length} টা Facebook Page লোড হয়েছে`);
  } catch (err) {
    console.error('restoreBots error:', err.message);
  }
}

initDB();
app.listen(port, () => console.log(`Server running on port ${port}`));
