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
    // পুরনো টেবিলে agent_id কলাম না থাকলে যোগ করা (safe upgrade)
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
    return `\n\nনিচের তথ্যগুলো ব্যবহার করে উত্তর দাও (Knowledge Base):\n${points}`;
  } catch (err) {
    console.error('getKnowledgeText error:', err.message);
    return '';
  }
}

// Knowledge যোগ করা
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

// Knowledge মুছা
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

// একটা এজেন্টের সব knowledge লিস্ট দেখা
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

// প্রতিটা bot token -> { systemPrompt, agentId, histories }
const telegramBots = {};

// টেলিগ্রাম বট কানেক্ট করা
app.post("/telegram/connect", async (req, res) => {
  const { botToken, systemPrompt, agentId } = req.body;
  if (!botToken) return res.json({ success: false, error: "Bot token প্রয়োজন" });

  const prompt = systemPrompt || "তুমি একজন সহকারী।";
  telegramBots[botToken] = { systemPrompt: prompt, agentId: agentId || null, histories: {} };

  try {
    const webhookUrl = `https://kajim-ai-agent-backend.onrender.com/telegram/webhook/${botToken}`;
    const setResp = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
    const setData = await setResp.json();
    if (!setData.ok) return res.json({ success: false, error: setData.description || "Webhook সেট করা যায়নি" });

    // ডাটাবেসে সেভ করা (আগে থাকলে আপডেট করা)
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
    const result = await pool.query("SELECT bot_token, system_prompt, agent_id, created_at FROM telegram_bots ORDER BY created_at DESC");
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
    const result = await pool.query("SELECT bot_token, system_prompt, agent_id FROM telegram_bots");
    for (const row of result.rows) {
      telegramBots[row.bot_token] = { systemPrompt: row.system_prompt, agentId: row.agent_id, histories: {} };

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
