// Agent-scoped Conversations Inbox API.
// Additive: preserves existing Telegram/Facebook/chat flows.
const express = require('express');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const originalGet = express.application.get;
let patched = false;

function clean(v, max = 500) { return String(v ?? '').trim().slice(0, max); }

async function listConversations(agentId, platform = '', q = '', limit = 100) {
  if (!agentId) return [];
  const params = [agentId];
  const filters = ['agent_id = $1'];
  if (platform && ['telegram','facebook'].includes(platform)) {
    params.push(platform); filters.push(`platform = $${params.length}`);
  }
  if (q) {
    params.push('%' + q + '%');
    filters.push(`chat_id ILIKE $${params.length}`);
  }
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
  const r = await pool.query(`
    SELECT platform, chat_id,
      MAX(created_at) AS last_message_at,
      COUNT(*)::int AS message_count,
      COUNT(*) FILTER (WHERE role='user')::int AS customer_messages,
      COUNT(*) FILTER (WHERE role='model')::int AS agent_messages,
      (ARRAY_AGG(content ORDER BY created_at DESC))[1] AS last_message
    FROM chat_messages
    WHERE ${filters.join(' AND ')}
    GROUP BY platform, chat_id
    ORDER BY MAX(created_at) DESC
    LIMIT ${safeLimit}`, params);
  return r.rows;
}

async function getMessages(agentId, platform, chatId, limit = 100) {
  if (!agentId || !['telegram','facebook'].includes(platform) || !chatId) return [];
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
  const r = await pool.query(`
    SELECT id, role, content, created_at
    FROM chat_messages
    WHERE agent_id=$1 AND platform=$2 AND chat_id=$3
    ORDER BY created_at DESC LIMIT ${safeLimit}`,
    [agentId, platform, String(chatId)]);
  return r.rows.reverse();
}

originalGet.call(express.application, '/conversations/:agentId', async (req,res) => {
  try {
    const agentId = clean(req.params.agentId, 200);
    const platform = clean(req.query.platform, 30).toLowerCase();
    const q = clean(req.query.q, 200);
    const limit = req.query.limit;
    res.json({ success:true, conversations: await listConversations(agentId, platform, q, limit) });
  } catch(e) { res.json({ success:false, error:e.message }); }
});

originalGet.call(express.application, '/conversations/:agentId/:platform/:chatId', async (req,res) => {
  try {
    const agentId = clean(req.params.agentId, 200);
    const platform = clean(req.params.platform, 30).toLowerCase();
    const chatId = clean(req.params.chatId, 300);
    const limit = req.query.limit;
    res.json({ success:true, messages: await getMessages(agentId, platform, chatId, limit) });
  } catch(e) { res.json({ success:false, error:e.message }); }
});

async function init() {
  await pool.query('CREATE INDEX IF NOT EXISTS idx_chat_messages_agent_platform_chat_created ON chat_messages(agent_id, platform, chat_id, created_at DESC)');
  console.log('✓ Conversations inbox API ready');
}
init().catch(e => console.error('Conversations inbox init error:', e.message));
