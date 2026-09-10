// Backward-compatible Advanced Knowledge Base upgrade.
// Keeps the existing agent_knowledge.content workflow intact.
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

function isSafePublicUrl(value) {
  try {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host === 'localhost.localdomain' || host.endsWith('.localhost') || host === '0.0.0.0') return false;
    if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false;
    if (host === '::1' || host.startsWith('fc') || host.startsWith('fd')) return false;
    return true;
  } catch (_) {
    return false;
  }
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|section|article|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
    .slice(0, 50000);
}

function registerRoutes(app) {
  if (registered) return;
  registered = true;

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

  app.get('/knowledge/advanced/search/:agentId', async (req, res) => {
    const agentId = clean(req.params.agentId, 200);
    const q = clean(req.query.q, 200);
    if (!agentId) return res.json({ success: false, error: 'agentId প্রয়োজন' });
    try {
      const params = [agentId];
      let sql = `SELECT id, agent_id, content, title, question, answer, source_type, source_url, created_at, updated_at
                 FROM agent_knowledge WHERE agent_id=$1`;
      if (q) {
        params.push(`%${q}%`);
        sql += ` AND (title ILIKE $2 OR question ILIKE $2 OR answer ILIKE $2 OR content ILIKE $2 OR source_url ILIKE $2)`;
      }
      sql += ' ORDER BY created_at DESC LIMIT 200';
      const result = await kbPool.query(sql, params);
      res.json({ success: true, items: result.rows });
    } catch (err) {
      console.error('advanced KB search error:', err.message);
      res.json({ success: false, error: err.message });
    }
  });

  app.post('/knowledge/advanced/add', async (req, res) => {
    const agentId = clean(req.body?.agentId, 200);
    const title = clean(req.body?.title, 500);
    const question = clean(req.body?.question, 2000);
    const answer = clean(req.body?.answer, 10000);
    const sourceType = clean(req.body?.sourceType || 'text', 50) || 'text';
    const sourceUrl = clean(req.body?.sourceUrl, 2000);
    if (!agentId || !answer) return res.json({ success: false, error: 'agentId ও answer প্রয়োজন' });
    if (sourceUrl && !isSafePublicUrl(sourceUrl)) return res.json({ success: false, error: 'সঠিক public http/https URL দিন' });
    const content = question ? `প্রশ্ন: ${question}\nউত্তর: ${answer}` : answer;
    try {
      const result = await kbPool.query(
        `INSERT INTO agent_knowledge (agent_id, content, title, question, answer, source_type, source_url, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
         RETURNING id, agent_id, content, title, question, answer, source_type, source_url, created_at, updated_at`,
        [agentId, content, title || null, question || null, answer, sourceType, sourceUrl || null]
      );
      res.json({ success: true, item: result.rows[0] });
    } catch (err) {
      console.error('advanced KB add error:', err.message);
      res.json({ success: false, error: err.message });
    }
  });

  app.post('/knowledge/advanced/import-url', async (req, res) => {
    const agentId = clean(req.body?.agentId, 200);
    const sourceUrl = clean(req.body?.sourceUrl, 2000);
    if (!agentId || !sourceUrl) return res.json({ success: false, error: 'agentId ও sourceUrl প্রয়োজন' });
    if (!isSafePublicUrl(sourceUrl)) return res.json({ success: false, error: 'শুধু public http/https URL ব্যবহার করুন' });
    try {
      const response = await fetch(sourceUrl, {
        headers: { 'User-Agent': 'AgentHub-KnowledgeImporter/1.0' },
        redirect: 'follow',
        signal: AbortSignal.timeout(12000)
      });
      if (!response.ok) return res.json({ success: false, error: `Website থেকে তথ্য আনা যায়নি (HTTP ${response.status})` });
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
        return res.json({ success: false, error: 'এই ধাপে শুধু HTML/TXT URL সাপোর্ট করে' });
      }
      const raw = await response.text();
      const text = contentType.includes('text/html') ? htmlToText(raw) : raw.trim().slice(0, 50000);
      if (!text) return res.json({ success: false, error: 'URL থেকে কোনো পাঠ্য তথ্য পাওয়া যায়নি' });
      const title = sourceUrl;
      const result = await kbPool.query(
        `INSERT INTO agent_knowledge (agent_id, content, title, answer, source_type, source_url, updated_at)
         VALUES ($1,$2,$3,$4,'url',$5,NOW())
         RETURNING id, agent_id, content, title, question, answer, source_type, source_url, created_at, updated_at`,
        [agentId, text, title, text, sourceUrl]
      );
      res.json({ success: true, item: result.rows[0], characters: text.length });
    } catch (err) {
      console.error('advanced KB URL import error:', err.message);
      res.json({ success: false, error: 'URL import ব্যর্থ: ' + err.message });
    }
  });

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
    if (sourceUrl && !isSafePublicUrl(sourceUrl)) return res.json({ success: false, error: 'সঠিক public http/https URL দিন' });
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
