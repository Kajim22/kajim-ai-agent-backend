// agent/runtime.js

const {
  getTool,
  executeTool
} = require("../tools/registry");

/**
 * Convert our internal tool definitions into
 * Gemini function declarations.
 */
function buildGeminiTools(enabledTools = []) {
  const declarations = [];

  for (const toolName of enabledTools) {
    const tool = getTool(toolName);

    if (!tool) {
      continue;
    }

    declarations.push({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    });
  }

  if (declarations.length === 0) {
    return [];
  }

  return [
    {
      functionDeclarations: declarations
    }
  ];
}


/**
 * Safely normalize conversation history.
 */
function normalizeHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const role =
        item.role === "assistant" ? "model" : "user";

      const text =
        typeof item.content === "string"
          ? item.content
          : typeof item.text === "string"
            ? item.text
            : "";

      return {
        role,
        parts: [
          {
            text
          }
        ]
      };
    })
    .filter((item) => item.parts[0].text.trim());
}


/**
 * Run the AI Agent Runtime.
 *
 * The runtime allows Gemini to:
 *
 * Gemini
 *   ↓
 * Function call
 *   ↓
 * Tool Registry
 *   ↓
 * Tool execution
 *   ↓
 * Tool result
 *   ↓
 * Gemini
 *   ↓
 * Final response
 */
async function runAgent({
  apiKey,
  systemPrompt = "",
  knowledgeText = "",
  history = [],
  message,
  agentId = "default",
  enabledTools = [],
  maxTurns = 8,
  model = "gemini-2.5-flash"
}) {
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  if (!message || typeof message !== "string") {
    throw new Error("Message is required.");
  }

  /*
   * Only allow tools that actually exist in the registry.
   * This prevents the model from receiving unknown tools.
   */
  const safeEnabledTools = Array.from(
    new Set(
      Array.isArray(enabledTools)
        ? enabledTools.filter(
            (name) => typeof name === "string" && getTool(name)
          )
        : []
    )
  );

  const tools = buildGeminiTools(safeEnabledTools);

  const events = [];

  const contents = normalizeHistory(history);

  contents.push({
    role: "user",
    parts: [
      {
        text: message
      }
    ]
  });

  let currentContents = contents;

  const baseSystemPrompt = [
    systemPrompt,
    knowledgeText
      ? `Knowledge Base:\n${knowledgeText}`
      : ""
  ]
    .filter(Boolean)
    .join("\n\n");

  for (let turn = 1; turn <= maxTurns; turn++) {
    const requestBody = {
      contents: currentContents
    };

    if (baseSystemPrompt) {
      requestBody.systemInstruction = {
        parts: [
          {
            text: baseSystemPrompt
          }
        ]
      };
    }

    if (tools.length > 0) {
      requestBody.tools = tools;
    }

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/` +
      `${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    let response;

    try {
      response = await fetch(url, {
        method: "POST",

        headers: {
          "Content-Type": "application/json"
        },

        body: JSON.stringify(requestBody)
      });
    } catch (error) {
      throw new Error(
        `Gemini request failed: ${
          error?.message || "Network error"
        }`
      );
    }

    let data;

    try {
      data = await response.json();
    } catch {
      throw new Error("Gemini returned an invalid response.");
    }

    if (!response.ok) {
      const apiError =
        data?.error?.message ||
        "Gemini API request failed.";

      throw new Error(apiError);
    }

    const candidate = data?.candidates?.[0];

    if (!candidate) {
      throw new Error("Gemini returned no candidate.");
    }

    const parts = Array.isArray(candidate.content?.parts)
      ? candidate.content.parts
      : [];

    /*
     * Check whether Gemini requested one or more tools.
     */
    const functionCalls = parts.filter(
      (part) =>
        part &&
        part.functionCall &&
        typeof part.functionCall.name === "string"
    );

    /*
     * Normal text response.
     */
    if (functionCalls.length === 0) {
      const text = parts
        .filter(
          (part) =>
            typeof part?.text === "string"
        )
        .map((part) => part.text)
        .join("");

      return {
        reply:
          text.trim() ||
          "I could not generate a response.",
        events
      };
    }

    /*
     * Add Gemini's function-call message to the
     * conversation before sending tool results back.
     */
    currentContents = [
      ...currentContents,
      candidate.content
    ];

    const functionResponses = [];

    for (const part of functionCalls) {
      const functionCall = part.functionCall;

      const toolName = functionCall.name;

      const args =
        functionCall.args &&
        typeof functionCall.args === "object"
          ? functionCall.args
          : {};

      /*
       * Record the tool call.
       */
      const callEvent = {
        type: "tool_call",
        agentId,
        tool: toolName,
        args,
        turn
      };

      events.push(callEvent);

      /*
       * Execute only if the tool was explicitly enabled.
       */
      let toolResult;

      if (!safeEnabledTools.includes(toolName)) {
        toolResult = {
          success: false,
          tool: toolName,
          error: `Tool "${toolName}" is not enabled for this agent.`
        };
      } else {
        toolResult = await executeTool(
          toolName,
          args,
          {
            agentId,
            turn
          }
        );
      }

      /*
       * Record the tool result.
       */
      events.push({
        type: "tool_result",
        agentId,
        tool: toolName,
        result: toolResult,
        turn
      });

      functionResponses.push({
        functionResponse: {
          name: toolName,
          response: toolResult
        }
      });
    }

    /*
     * Send tool results back to Gemini.
     */
    currentContents = [
      ...currentContents,
      {
        role: "user",
        parts: functionResponses
      }
    ];
  }

  throw new Error(
    `Agent exceeded the maximum tool turns (${maxTurns}).`
  );
}

module.exports = {
  runAgent
};
