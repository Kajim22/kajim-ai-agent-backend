// tools/registry.js

const tools = new Map();

function registerTool(tool) {
  if (!tool || typeof tool !== "object") {
    throw new Error("Invalid tool definition.");
  }

  if (!tool.name || typeof tool.name !== "string") {
    throw new Error("Tool name is required.");
  }

  if (typeof tool.execute !== "function") {
    throw new Error(`Tool "${tool.name}" must have an execute() function.`);
  }

  if (tools.has(tool.name)) {
    throw new Error(`Tool "${tool.name}" is already registered.`);
  }

  tools.set(tool.name, {
    name: tool.name,
    description: tool.description || "",
    riskLevel: tool.riskLevel || "low",
    parameters: tool.parameters || {
      type: "object",
      properties: {},
      required: []
    },
    execute: tool.execute
  });

  return tools.get(tool.name);
}

function getTool(name) {
  return tools.get(name);
}

function listTools() {
  return Array.from(tools.values()).map((tool) => ({
    name: tool.name,
    description: tool.description,
    riskLevel: tool.riskLevel,
    parameters: tool.parameters
  }));
}

async function executeTool(name, args = {}, context = {}) {
  const tool = getTool(name);

  if (!tool) {
    return {
      success: false,
      tool: name,
      error: `Unknown tool: ${name}`
    };
  }

  try {
    const result = await tool.execute(args, context);

    return {
      success: true,
      tool: name,
      result
    };
  } catch (error) {
    console.error(`Tool execution failed [${name}]:`, error);

    return {
      success: false,
      tool: name,
      error:
        error && error.message
          ? error.message
          : "Tool execution failed."
    };
  }
}

module.exports = {
  registerTool,
  getTool,
  listTools,
  executeTool
};
