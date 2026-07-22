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
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✓ Database ready');
  } catch (err) {
    console.error('Database init error:', err.message);
  }
}

// API Endpoint
app.post("/chat", async (req, res) => {
  const { message, systemPrompt, history } = req.body;
  const API_KEY = process.env.GEMINI_API_KEY;

  if (!API_KEY) {
    return res.json({ reply: "Error: API Key সেট করা নেই।" });
  }

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt || "তুমি একজন সহকারী।" }] },
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

// প্রতিটা bot token -> { systemPrompt, histories } (chat history মেমোরিতেই থাকবে, শুধু token+prompt DB-তে সেভ হবে)
const telegramBots = {};

// টেলিগ্রাম বট কানেক্ট করা
app.post("/telegram/connect", async (req, res) => {
  const { botToken, systemPrompt } = req.body;
  if (!botToken) return res.json({ success: false, error: "Bot token প্রয়োজন" });

  const prompt = systemPrompt || "তুমি একজন সহকারী।";
  telegramBots[botToken] = { systemPrompt: prompt, histories: {} };

  try {
    const webhookUrl = `https://kajim-ai-agent-backend.onrender.com/telegram/webhook/${botToken}`;
    const setResp = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
    const setData = await setResp.json();
    if (!setData.ok) return res.json({ success: false, error: setData.description || "Webhook সেট করা যায়নি" });

    // ডাটাবেসে সেভ করা (আগে থাকলে আপডেট করা)
    await pool.query(
      `INSERT INTO telegram_bots (bot_token, system_prompt) VALUES ($1, $2)
       ON CONFLICT (bot_token) DO UPDATE SET system_prompt = $2`,
      [botToken, prompt]
    );

    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// টেলিগ্রাম থেকে আসা মেসেজ রিসিভ করা
app.post("/telegram/webhook/:token", async (req, res) => {
  const token = req.params.token;
  const bot = telegramBots[token];
  res.sendStatus(200);
  if (!bot) return;

  const update = req.body;
  const chatId = update?.message?.chat?.id;
  const text = update?.message?.text;
  if (!chatId || !text) return;

  if (!bot.histories[chatId]) bot.histories[chatId] = [];
  bot.histories[chatId].push({ role: "user", parts: [{ text }] });

  const API_KEY = process.env.GEMINI_API_KEY;
  try {
    const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: bot.systemPrompt }] },
        contents: bot.histories[chatId]
      })
    });
    const data = await geminiRes.json();
    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || "দুঃখিত, উত্তর তৈরি করা যায়নি।";

    bot.histories[chatId].push({ role: "model", parts: [{ text: reply }] });
    if (bot.histories[chatId].length > 20) bot.histories[chatId] = bot.histories[chatId].slice(-20);

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: reply })
    });
  } catch (err) {
    console.error("Telegram bot error:", err.message);
  }
});

// সেভ করা সব bot দেখার এন্ডপয়েন্ট (ডাটাবেসে কী আছে যাচাই করতে)
app.get("/telegram/list", async (req, res) => {
  try {
    const result = await pool.query("SELECT bot_token, system_prompt, created_at FROM telegram_bots ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ==== Facebook Messenger Integration ====

let facebookConfig = { systemPrompt: 'তুমি একজন সহকারী।', histories: {} };

app.post("/facebook/connect", (req, res) => {
  const { systemPrompt } = req.body;
  facebookConfig.systemPrompt = systemPrompt || 'তুমি একজন সহকারী।';
  res.json({ success: true });
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

app.post("/webhook/facebook", async (req, res) => {
  res.sendStatus(200);
  const body = req.body;
  if (body.object !== 'page') return;

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      const senderId = event.sender?.id;
      const text = event.message?.text;
      if (!senderId || !text) continue;

      if (!facebookConfig.histories[senderId]) facebookConfig.histories[senderId] = [];
      facebookConfig.histories[senderId].push({ role: "user", parts: [{ text }] });

      const API_KEY = process.env.GEMINI_API_KEY;
      try {
        const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: facebookConfig.systemPrompt }] },
            contents: facebookConfig.histories[senderId]
          })
        });
        const data = await geminiRes.json();
        const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || "দুঃখিত, উত্তর তৈরি করা যায়নি।";

        facebookConfig.histories[senderId].push({ role: "model", parts: [{ text: reply }] });
        if (facebookConfig.histories[senderId].length > 20) {
          facebookConfig.histories[senderId] = facebookConfig.histories[senderId].slice(-20);
        }

        await fetch(`https://graph.facebook.com/v20.0/me/messages?access_token=${process.env.FB_PAGE_ACCESS_TOKEN}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            recipient: { id: senderId },
            message: { text: reply }
          })
        });
      } catch (err) {
        console.error("Facebook bot error:", err.message);
      }
    }
  }
});

// সার্ভার চালু হওয়ার সময় ডাটাবেস থেকে পুরনো bot গুলো লোড করে auto-reconnect করা
async function restoreBots() {
  try {
    const result = await pool.query("SELECT bot_token, system_prompt FROM telegram_bots");
    for (const row of result.rows) {
      telegramBots[row.bot_token] = { systemPrompt: row.system_prompt, histories: {} };

      const webhookUrl = `https://kajim-ai-agent-backend.onrender.com/telegram/webhook/${row.bot_token}`;
      await fetch(`https://api.telegram.org/bot${row.bot_token}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
    }
    console.log(`✓ ${result.rows.length} টা bot auto-reconnect হয়েছে`);
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
