const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const API_KEY = process.env.OPENAI_API_KEY;

// memory
let agents = [];
let id = 1;

// home
app.get("/", (req, res) => {
  res.send("AI Agent Backend Running 🚀");
});

// create agent
app.post("/create-agent", (req, res) => {
  const { name, system, instructions } = req.body;

  if (!name || !system || !instructions) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const agent = { id: id++, name, system, instructions };
  agents.push(agent);

  res.json(agent);
});

// list agents
app.get("/agents", (req, res) => {
  res.json(agents);
});

// chat
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
  console.log("Server running on port", PORT);
});
