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
                  "দুঃখিত, কোনো উত্তর পাওয়া যায়নি।";

    res.json({ reply });
  } catch (err) {
    res.json({ reply: "সার্ভার এরর: " + err.message });
  }
});

// Start Server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
