const express = require("express");
const app = express();

app.get("/", (req, res) => {
  res.send("Server OK");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Running");
});
app.post("/chat", async (req, res) => {
  try {
    const { message } = req.body;

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: message
      })
    });

    const data = await response.json();

    const reply =
      data.output?.[0]?.content?.[0]?.text ||
      "No response";

    res.json({ reply });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log("Server running on", PORT);
});
  agents.push(agent);

  res.json(agent);
});

// Get Agents
app.get("/agents", (req, res) => {
  res.json(agents);
});

// Chat
app.post("/chat", async (req, res) => {
  try {
    const { message } = req.body;

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: message
      })
    });

    const data = await response.json();

    const reply =
      data.output?.[0]?.content?.[0]?.text ||
      "No response from AI";

    res.json({ reply });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});  res.json(agents);
});

// Chat API
app.post("/chat", async (req, res) => {
  try {
    const { message } = req.body;

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: message
      })
    });

    const data = await response.json();

    const reply =
      data.output?.[0]?.content?.[0]?.text ||
      "No response from AI";

    res.json({ reply });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
    const agent = agents.find(a => a.id == agentId);

    if (!agent) {
      return res.json({ reply: "Agent not found" });
    }

    const prompt = `
${agent.system}

Instructions:
${agent.instructions}

User: ${message}
`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || "No response";

    res.json({ reply });

  } catch (err) {
    res.json({ reply: "Error: " + err.message });
  }
});

// Root
app.get("/", (req, res) => {
  res.send("AI Agent Builder Backend Running 🚀");
});

// ✅ FIXED (no extra bracket)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
    const agent = agents.find(a => a.id == agentId);

    if (!agent) {
      return res.json({ reply: "Agent not found" });
    }

    const prompt = `
${agent.system}

Instructions:
${agent.instructions}

User: ${message}
`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await response.json();

    const reply = data.choices?.[0]?.message?.content || "No response";

    res.json({ reply });

  } catch (err) {
    res.json({ reply: "Error: " + err.message });
  }
});

app.get("/", (req, res) => {
  res.send("AI Agent Builder Backend Running 🚀");
});

app.listen(3000, () => console.log("Server running"));  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running"));
