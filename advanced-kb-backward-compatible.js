// Backward-compatible Advanced Knowledge Base upgrade.
// Keeps the existing agent_knowledge.content workflow intact.
// Loaded before server.js so existing Telegram/Facebook KB routes continue to work.
const express = require('express');
const { Pool } = require('pg');

const kbPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

let registered = false;

async function ensureSchema() {
  await kbPool.query(`
    ALTER TABLE agent_knowledge
      ADD COLUMN IF NOT EXISTS title TEXT,
      ADD COLUMN IF NOT EXISTS question TEXT,
      ADD COLUMN IF NOT EXISTS answer TEXT,
      ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'text',
      ADD COLUMN IF NOT EXISTS source_url TEXT,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()
  `);
  await kbPool.query(`
    CREATE INDEX IF NOT EXISTS idx_agent_knowledge_agent_created
    ON agent_knowledge(agent_id, created_at DESC)
  `);
}

function clean(value, max = 10000) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, max);
}

function registerRoutes(app) {
  if (registered) return;
  registered = true;

  // Upgrade existing KB items without requiring old rows to be migrated.
  app.get('/knowledge/advanced/list/:agentId', async (req, res) => {
    const agentId = clean(req.params.agentId, 200);
    if (!agentId) return res.json({ success: false, error: 'agentId প্রয়োজন' });
    try {
      const result = await kbPool.query(
        `SELECT id, agent_id, content, title, question, answer, source_type, source_url, created_at, updated_at
         FROM agent_knowledge WHERE agent_id=$1 ORDER BY created_at DESC`,
        [agentId]
      );
      res.json({ success: true, items: result.rows });
    } catch (err) {
      console.error('advanced KB list error:', err.message);
      res.json({ success: false, error: err.message });
    }
  });

  // Edit an existing item. The original /knowledge/add and /knowledge/delete remain untouched.
  app.post('/knowledge/advanced/update', async (req, res) => {
    const id = Number(req.body?.id);
    const agentId = clean(req.body?.agentId, 200);
    if (!Number.isInteger(id) || id <= 0 || !agentId) {
      return res.json({ success: false, error: 'valid id এবং agentId প্রয়োজন' });
    }
    const title = clean(req.body?.title, 500);
    const question = clean(req.body?.question, 2000);
    const answer = clean(req.body?.answer, 10000);
    const content = clean(req.body?.content, 10000);
    const sourceType = clean(req.body?.sourceType || 'text', 50) || 'text';
    const sourceUrl = clean(req.body?.sourceUrl, 2000);
    const finalAnswer = answer || content;
    const finalContent = content || (question ? `প্রশ্ন: ${question}\nউত্তর: ${answer}` : answer);
    if (!finalContent) return res.json({ success: false, error: 'content বা answer প্রয়োজন' });
    try {
      const result = await kbPool.query(
        `UPDATE agent_knowledge
         SET content=$1, title=$2, question=$3, answer=$4, source_type=$5, source_url=$6, updated_at=NOW()
         WHERE id=$7 AND agent_id=$8
         RETURNING id, agent_id, content, title, question, answer, source_type, source_url, created_at, updated_at`,
        [finalContent, title || null, question || null, finalAnswer, sourceType, sourceUrl || null, id, agentId]
      );
      if (!result.rows[0]) return res.json({ success: false, error: 'Knowledge item পাওয়া যায়নি' });
      res.json({ success: true, item: result.rows[0] });
    } catch (err) {
      console.error('advanced KB update error:', err.message);
      res.json({ success: false, error: err.message });
    }
  });

  // Safe agent-scoped delete for the upgraded UI.
  app.post('/knowledge/advanced/delete', async (req, res) => {
    const id = Number(req.body?.id);
    const agentId = clean(req.body?.agentId, 200);
    if (!Number.isInteger(id) || id <= 0 || !agentId) {
      return res.json({ success: false, error: 'valid id এবং agentId প্রয়োজন' });
    }
    try {
      const result = await kbPool.query(
        'DELETE FROM agent_knowledge WHERE id=$1 AND agent_id=$2 RETURNING id',
        [id, agentId]
      );
      res.json({ success: true, deleted: Boolean(result.rows[0]) });
    } catch (err) {
      console.error('advanced KB delete error:', err.message);
      res.json({ success: false, error: err.message });
    }
  });
}

const originalListen = express.application.listen;
express.application.listen = function patchedListen(...args) {
  registerRoutes(this);
  return originalListen.apply(this, args);
};

setTimeout(async () => {
  try {
    await ensureSchema();
    console.log('✓ Advanced Knowledge Base compatibility upgrade ready');
  } catch (err) {
    console.error('Advanced KB schema upgrade error:', err.message);
  }
}, 5000);
