// routes/tools.js

const express = require("express");

const {
  listTools
} = require("../tools/registry");

const router = express.Router();

/**
 * GET /tools
 *
 * Returns the tools currently registered
 * in the Agent Tool Registry.
 *
 * Internal execute() functions are never exposed.
 */
router.get("/", (req, res) => {
  try {
    return res.json({
      success: true,
      tools: listTools()
    });
  } catch (error) {
    console.error("Failed to list tools:", error);

    return res.status(500).json({
      success: false,
      error: "Failed to load tools."
    });
  }
});

module.exports = router;
