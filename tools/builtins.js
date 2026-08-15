// tools/builtins.js

const {
  registerTool
} = require("./registry");

/*
 * Safely evaluate basic arithmetic expressions.
 *
 * Allowed:
 * numbers
 * +
 * -
 * *
 * /
 * %
 * (
 * )
 * decimal points
 */
function safeCalculate(expression) {
  if (typeof expression !== "string") {
    throw new Error("Expression must be a string.");
  }

  const cleaned = expression.replace(/\s+/g, "");

  if (!cleaned) {
    throw new Error("Expression cannot be empty.");
  }

  // Only allow basic arithmetic characters.
  if (!/^[0-9.+\-*/%()]+$/.test(cleaned)) {
    throw new Error(
      "Only numbers and basic arithmetic operators are allowed."
    );
  }

  // Prevent dangerous or malformed operator sequences.
  if (
    cleaned.includes("++") ||
    cleaned.includes("--") ||
    cleaned.includes("**") ||
    cleaned.includes("//")
  ) {
    throw new Error("Invalid arithmetic expression.");
  }

  // Basic parenthesis validation.
  let balance = 0;

  for (const char of cleaned) {
    if (char === "(") balance++;
    if (char === ")") balance--;

    if (balance < 0) {
      throw new Error("Invalid parentheses.");
    }
  }

  if (balance !== 0) {
    throw new Error("Invalid parentheses.");
  }

  /*
   * At this point only arithmetic characters are allowed.
   * Function constructor is used only after strict character
   * validation and is NOT exposed to arbitrary JavaScript.
   */
  let result;

  try {
    result = Function(`"use strict"; return (${cleaned});`)();
  } catch {
    throw new Error("Invalid arithmetic expression.");
  }

  if (typeof result !== "number" || !Number.isFinite(result)) {
    throw new Error("Calculation produced an invalid result.");
  }

  return result;
}


/* =========================================================
   TOOL 1 — CALCULATOR
   ========================================================= */

registerTool({
  name: "calculator",

  description:
    "Perform basic arithmetic calculations using numbers and arithmetic operators.",

  riskLevel: "low",

  parameters: {
    type: "object",

    properties: {
      expression: {
        type: "string",
        description:
          "A basic arithmetic expression such as 120 * 5 or (100 + 50) / 2."
      }
    },

    required: ["expression"]
  },

  async execute(args) {
    const expression = args?.expression;

    const result = safeCalculate(expression);

    return {
      expression,
      result
    };
  }
});


/* =========================================================
   TOOL 2 — CURRENT TIME
   ========================================================= */

registerTool({
  name: "current_time",

  description:
    "Return the current server time in ISO format and Unix milliseconds.",

  riskLevel: "low",

  parameters: {
    type: "object",

    properties: {},

    required: []
  },

  async execute() {
    const now = new Date();

    return {
      iso: now.toISOString(),
      unixMs: now.getTime()
    };
  }
});


/* =========================================================
   TOOL 3 — ECHO
   ========================================================= */

registerTool({
  name: "echo",

  description:
    "Return the same text that was provided to the tool.",

  riskLevel: "low",

  parameters: {
    type: "object",

    properties: {
      text: {
        type: "string",
        description: "The text to return."
      }
    },

    required: ["text"]
  },

  async execute(args) {
    if (!args || typeof args.text !== "string") {
      throw new Error("Text must be a string.");
    }

    return {
      text: args.text
    };
  }
});


/*
 * Exporting an object is not required for registration because
 * requiring this file automatically registers the built-in tools.
 */
module.exports = {};
