app.post("/chat", async (req, res) => {
  try {
    const { message, systemPrompt, history } = req.body;
    const API_KEY = process.env.GEMINI_API_KEY;

    // Gemini API URL
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${API_KEY}`;

    // সঠিক ফরম্যাট তৈরি করা
    const payload = {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: history // ফ্রন্টএন্ড থেকে আসা হিস্ট্রি সরাসরি পাঠাচ্ছি
    };

    const response = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    // রেসপন্স চেক করা
    console.log("Gemini API Response:", JSON.stringify(data)); // এটি Render লগে দেখবেন

    // রেসপন্স থেকে টেক্সট বের করার সঠিক রাস্তা
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || "No response";

    res.json({ reply });

  } catch (err) {
    console.error("Backend Error:", err);
    res.status(500).json({ error: err.message });
  }
});
