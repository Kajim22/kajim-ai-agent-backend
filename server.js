const express = require('express');
const cors = require('cors');
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

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
    
    // রেসপন্স ফিল্টার করা
    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || 
                  data?.error?.message || 
                  "দুঃখিত, কোনো উত্তর পাওয়া যায়নি।";

    res.json({ reply });
  } catch (err) {
    res.json({ reply: "সার্ভার এরর: " + err.message });
  }
});

// ==== Telegram Bot Integration ====

// প্রতিটা bot token -> { systemPrompt, histories }
const telegramBots = {};

// টেলিগ্রাম বট কানেক্ট করা
app.post("/telegram/connect", async (req, res) => {
  const { botToken, systemPrompt } = req.body;
  if (!botToken) return res.json({ success: false, error: "Bot token প্রয়োজন" });

  telegramBots[botToken] = {
    systemPrompt: systemPrompt || "তুমি একজন সহকারী।",
    histories: {}
  };

  try {
    const webhookUrl = `https://kajim-ai-agent-backend.onrender.com/telegram/webhook/${botToken}`;
    const setResp = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
    const setData = await setResp.json();
    if (!setData.ok) return res.json({ success: false, error: setData.description || "Webhook সেট করা যায়নি" });
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// টেলিগ্রাম থেকে আসা মেসেজ রিসিভ করা
app.post("/telegram/webhook/:token", async (req, res) => {
  const token = req.params.token;
  const bot = telegramBots[token];
  res.sendStatus(200); // Telegram-কে সাথে সাথে acknowledge
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

// Start Server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
