// Relevant Knowledge retrieval for existing agent_knowledge data.
// Additive: existing Telegram/Facebook/chat behavior remains unchanged unless callers opt in.
const express = require('express');
const { Pool } = require('pg');

const retrievalPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

let registered = false;

function clean(value, max = 20000) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, max);
}

function tokenize(text) {
  return clean(text, 4000)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map(x => x.trim())
    .filter(x => x.length >= 2)
    .slice(0, 80);
}

function scoreItem(item, tokens, query) {
  const title = clean(item.title).toLowerCase();
  const question = clean(item.question).toLowerCase();
  const answer = clean(item.answer || item.content).toLowerCase();
  const source = clean(item.source_url).toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (title.includes(token)) score += 8;
    if (question.includes(token)) score += 7;
    if (answer.includes(token)) score += 3;
    if (source.includes(token)) score += 1;
  }
  if (query && title === query.toLowerCase()) score += 12;
  return score;
}

function registerRoutes(app) {
  if (registered) return;
  registered = true;

  app.get('/knowledge/relevant/:agentId', async (req, res) => {
    const agentId = clean(req.params.agentId, 200);
    const query = clean(req.query.q, 4000);
    const limit = Math.min(Math.max(Number(req.query.limit) || 6, 1), 12);
    if (!agentId || !query) {
      return res.json({ success: true, items: [] });
    }
    try {
      const result = await retrievalPool.query(
        `SELECT id, agent_id, content, title, question, answer, source_type, source_url, created_at, updated_at
         FROM agent_knowledge
         WHERE agent_id=$1
         ORDER BY created_at DESC
         LIMIT 500`,
        [agentId]
      );
      const tokens = tokenize(query);
      const ranked = result.rows
        .map(item => ({ ...item, _score: scoreItem(item, tokens, query) }))
        .filter(item => item._score > 0)
        .sort((a, b) => b._score - a._score || new Date(b.created_at) - new Date(a.created_at))
        .slice(0, limit)
        .map(({ _score, ...item }) => item);
      res.json({ success: true, items: ranked, query, count: ranked.length });
    } catch (err) {
      console.error('knowledge relevant retrieval error:', err.message);
      res.json({ success: false, error: err.message, items: [] });
    }
  });

  app.get('/knowledge/relevant-text/:agentId', async (req, res) => {
    const agentId = clean(req.params.agentId, 200);
    const query = clean(req.query.q, 4000);
    const limit = Math.min(Math.max(Number(req.query.limit) || 6, 1), 12);
    if (!agentId || !query) return res.json({ success: true, text: '' });
    try {
      const result = await retrievalPool.query(
        `SELECT id, content, title, question, answer, source_type, source_url, created_at
         FROM agent_knowledge WHERE agent_id=$1 ORDER BY created_at DESC LIMIT 500`,
        [agentId]
      );
      const tokens = tokenize(query);
      const ranked = result.rows
        .map(item => ({ ...item, _score: scoreItem(item, tokens, query) }))
        .filter(item => item._score > 0)
        .sort((a, b) => b._score - a._score || new Date(b.created_at) - new Date(a.created_at))
        .slice(0, limit);
      const text = ranked.map((item, i) => {
        const heading = item.title || `Knowledge ${i + 1}`;
        const body = item.answer || item.content || '';
        const q = item.question ? `\nপ্রশ্ন: ${item.question}` : '';
        const src = item.source_url ? `\nSource: ${item.source_url}` : '';
        return `### ${heading}${q}\n${body}${src}`;
      }).join('\n\n');
      res.json({ success: true, text, count: ranked.length });
    } catch (err) {
      console.error('knowledge relevant text error:', err.message);
      res.json({ success: false, error: err.message, text: '' });
    }
  });
}

const originalListen = express.application.listen;
express.application.listen = function patchedListen(...args) {
  registerRoutes(this);
  return originalListen.apply(this, args);
};

console.log('✓ Relevant Knowledge retrieval module loaded');
