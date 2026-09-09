// Advanced Knowledge Base foundation.
// Adds structured FAQ fields, scoped CRUD/update/search APIs, and safe DB indexes.
// Loaded before server.js without changing existing Messenger/Telegram routes.

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

  await kbPool.query(`
    CREATE INDEX IF NOT EXISTS idx_agent_knowledge_agent_source
    ON agent_knowledge(agent_id, source_type)
  `);
}

function clean(value, max = 10000) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, max);
}

function registerRoutes(app) {
  if (registered) return;
  registered = true;

  // Create a structured text/FAQ knowledge item.
  app.post('/knowledge/advanced/add', async (req, res) => {
    const agentId = clean(req.body?.agentId, 200);
    const title = clean(req.body?.title, 500);
    const question = clean(req.body?.question, 2000);
    const answer = clean(req.body?.answer, 10000);
    const content = clean(req.body?.content, 10000);
    const sourceType = clean(req.body?.sourceType || 'text', 50) || 'text';
    const sourceUrl = clean(req.body?.sourceUrl, 2000);

    if (!agentId || (!content && !answer)) {
      return res.json({ success: false, error: 'agentId এবং content/answer প্রয়োজন' });
    }

    const finalAnswer = answer || content;
    const finalContent = content || (question ? `প্রশ্ন: ${question}\nউত্তর: ${answer}` : answer);

    try {
      const result = await kbPool.query(
        `INSERT INTO agent_knowledge
          (agent_id, content, title, question, answer, source_type, source_url, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
         RETURNING id, agent_id, content, title, question, answer, source_type, source_url, created_at, updated_at`,
        [agentId, finalContent, title || null, question || null, finalAnswer, sourceType, sourceUrl || null]
      );
      res.json({ success: true, item: result.rows[0] });
    } catch (err) {
      console.error('advanced knowledge add error:', err.message);
      res.json({ success: false, error: err.message });
    }
  });

  // Agent-scoped edit. Existing /knowledge/delete remains untouched.
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
      console.error('advanced knowledge update error:', err.message);
      res.json({ success: false, error: err.message });
    }
  });

  // Agent-scoped delete so one agent cannot delete another agent's KB item.
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
      console.error('advanced knowledge delete error:', err.message);
      res.json({ success: false, error: err.message });
    }
  });

  // Search only within the selected agent's knowledge.
  app.get('/knowledge/advanced/search/:agentId', async (req, res) => {
    const agentId = clean(req.params.agentId, 200);
    const q = clean(req.query?.q, 500);
    const limit = Math.min(Math.max(Number(req.query?.limit) || 20, 1), 50);
    if (!agentId) return res.json({ success: false, error: 'agentId প্রয়োজন' });

    try {
      if (!q) {
        const result = await kbPool.query(
          `SELECT id, agent_id, content, title, question, answer, source_type, source_url, created_at, updated_at
           FROM agent_knowledge WHERE agent_id=$1 ORDER BY created_at DESC LIMIT $2`,
          [agentId, limit]
        );
        return res.json({ success: true, items: result.rows });
      }

      const pattern = `%${q}%`;
      const result = await kbPool.query(
        `SELECT id, agent_id, content, title, question, answer, source_type, source_url, created_at, updated_at
         FROM agent_knowledge
         WHERE agent_id=$1
           AND (content ILIKE $2 OR title ILIKE $2 OR question ILIKE $2 OR answer ILIKE $2)
         ORDER BY CASE
           WHEN question ILIKE $2 THEN 0
           WHEN title ILIKE $2 THEN 1
           ELSE 2
         END, created_at DESC
         LIMIT $3`,
        [agentId, pattern, limit]
      );
      res.json({ success: true, items: result.rows });
    } catch (err) {
      console.error('advanced knowledge search error:', err.message);
      res.json({ success: false, error: err.message });
    }
  });
}

// server.js creates the Express app before calling listen. Register immediately
// before listen so the existing routes and Messenger/Telegram flow stay intact.
const originalListen = express.application.listen;
express.application.listen = function patchedListen(...args) {
  registerRoutes(this);
  originalListen.apply(this, args);
};

setTimeout(async () => {
  try {
    await ensureSchema();
    console.log('✓ Advanced Knowledge Base ready');
  } catch (err) {
    console.error('Advanced Knowledge Base init error:', err.message);
  }
}, 5000);
