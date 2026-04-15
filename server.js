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

    console.log("OPENAI RESPONSE:", JSON.stringify(data, null, 2));

    let reply = "No response";

    // SAFE parsing (FIXED)
    if (data.output && data.output.length > 0) {
      const content = data.output[0].content;
      if (content && content.length > 0) {
        reply = content[0].text || reply;
      }
    }

    res.json({ reply });

  } catch (error) {
    console.log("ERROR:", error);
    res.status(500).json({ error: error.message });
  }
});
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
