const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Render-এ এনভায়রনমেন্ট ভেরিয়েবল হিসেবে GEMINI_API_KEY সেট করুন
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

app.get("/", (req, res) => {
  res.send("AI Agent Backend Running 🚀");
});

// chat route (Gemini updated)
app.post("/chat", async (req, res) => {
  try {
    const { message, systemPrompt, history } = req.body;

    // Gemini API URL
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

    // Gemini-এর ফরম্যাট অনুযায়ী রিকোয়েস্ট তৈরি করা
    const payload = {
      system_instruction: { parts: [{ text: systemPrompt || "তুমি একজন সহকারী।" }] },
      contents: history || [{ role: "user", parts: [{ text: message }] }]
    };

    const response = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    // রেসপন্স থেকে টেক্সট বের করা
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || "উত্তরের কোনো অংশ পাওয়া যায়নি।";

    res.json({ reply });

  } catch (err) {
    console.error("Backend Error:", err);
    res.status(500).json({ error: "Server error during API call" });
  }
});

app.listen(PORT, () => {
  console.log("AI Agent Backend running on port", PORT);
});
