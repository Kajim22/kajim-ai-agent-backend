const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const API_KEY = process.env.OPENAI_API_KEY;

// In-memory agents
let agents = [];

// Create agent
app.post("/create-agent", (req, res) => {
  const { name, system, instructions } = req.body;

  const newAgent = {
    id: Date.now(),
    name,
    system,
    instructions
  };

  agents.push(newAgent);
  res.json({ success: true });
});

// Get agents
app.get("/agents", (req, res) => {
  res.json(agents);
});

// Chat
app.post("/chat", async (req, res) => {
  try {
    const { agentId, message } = req.body;

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
