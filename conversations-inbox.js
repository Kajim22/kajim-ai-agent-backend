// Agent-scoped Conversations Inbox API.
// Authenticated, Page-aware inbox for Facebook and Telegram.
const express = require('express');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const originalGet = express.application.get;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yhspipyrgdcdfqqxxges.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || 'sb_publishable_IcyDHTLjyPPspvcgnYZZiw_q1lUn8QW';

function clean(v, max = 500) { return String(v ?? '').trim().slice(0, max); }

async function authenticatedUser(req) {
  const auth = String(req.headers.authorization || '');
  if (!auth.startsWith('Bearer ') || !SUPABASE_ANON_KEY) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  try {
    const response = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token }
    });
    return response.ok ? await response.json() : null;
  } catch (error) {
    console.error('Inbox auth validation error:', error.message);
    return null;
  }
}

async function hasAgentAccess(userId, agentId) {
  const r = await pool.query(`
    SELECT EXISTS (
      SELECT 1 FROM user_agents WHERE id = $1 AND owner_user_id = $2
      UNION ALL
      SELECT 1 FROM marketplace_agents WHERE agent_id = $1 AND owner_user_id = $2
      UNION ALL
      SELECT 1 FROM facebook_pages WHERE agent_id = $1 AND customer_user_id = $2
      UNION ALL
      SELECT 1 FROM telegram_bots WHERE agent_id = $1 AND customer_user_id = $2
    ) AS allowed`, [String(agentId), String(userId)]);
  return Boolean(r.rows[0]?.allowed);
}

async function listConversations(agentId, userId, platform = '', q = '', limit = 100, pageId = '') {
  const params = [agentId, userId];
  const filters = [
    'cm.agent_id = $1',
    `(
      EXISTS (SELECT 1 FROM user_agents ua WHERE ua.id = cm.agent_id AND ua.owner_user_id = $2)
      OR EXISTS (SELECT 1 FROM marketplace_agents ma WHERE ma.agent_id = cm.agent_id AND ma.owner_user_id = $2)
      OR EXISTS (SELECT 1 FROM facebook_pages fp WHERE fp.agent_id = cm.agent_id AND fp.customer_user_id = $2)
      OR EXISTS (SELECT 1 FROM telegram_bots tb WHERE tb.agent_id = cm.agent_id AND tb.customer_user_id = $2)
    )`
  ];
  if (platform && ['telegram','facebook'].includes(platform)) {
    params.push(platform); filters.push(`cm.platform = $${params.length}`);
  }
  if (q) {
    params.push('%' + q + '%'); filters.push(`cm.chat_id ILIKE $${params.length}`);
  }
  if (pageId) {
    params.push(pageId); filters.push(`cm.page_id = $${params.length}`);
  }
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
  const r = await pool.query(`
    SELECT cm.platform, cm.chat_id, cm.page_id,
      COALESCE(fcm.mode, 'ai') AS mode,
      MAX(cm.created_at) AS last_message_at,
      COUNT(*)::int AS message_count,
      COUNT(*) FILTER (WHERE cm.role='user')::int AS customer_messages,
      COUNT(*) FILTER (WHERE cm.role='model')::int AS agent_messages,
      (ARRAY_AGG(cm.content ORDER BY cm.created_at DESC))[1] AS last_message
    FROM chat_messages cm
    LEFT JOIN facebook_conversation_modes fcm
      ON cm.platform='facebook'
     AND fcm.page_id=cm.page_id
     AND fcm.chat_id=cm.chat_id
     AND fcm.agent_id=cm.agent_id
    WHERE ${filters.join(' AND ')}
    GROUP BY cm.platform, cm.chat_id, cm.page_id, fcm.mode
    ORDER BY MAX(cm.created_at) DESC
    LIMIT ${safeLimit}`, params);
  return r.rows;
}

async function getMessages(agentId, userId, platform, chatId, limit = 100, pageId = '') {
  if (!agentId || !['telegram','facebook'].includes(platform) || !chatId) return [];
  const params = [agentId, platform, String(chatId), userId];
  const filters = [
    'cm.agent_id=$1', 'cm.platform=$2', 'cm.chat_id=$3',
    `(
      EXISTS (SELECT 1 FROM user_agents ua WHERE ua.id = cm.agent_id AND ua.owner_user_id = $4)
      OR EXISTS (SELECT 1 FROM marketplace_agents ma WHERE ma.agent_id = cm.agent_id AND ma.owner_user_id = $4)
      OR EXISTS (SELECT 1 FROM facebook_pages fp WHERE fp.agent_id = cm.agent_id AND fp.customer_user_id = $4)
      OR EXISTS (SELECT 1 FROM telegram_bots tb WHERE tb.agent_id = cm.agent_id AND tb.customer_user_id = $4)
    )`
  ];
  if (pageId) { params.push(pageId); filters.push(`cm.page_id=$${params.length}`); }
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
  const r = await pool.query(`
    SELECT cm.id, cm.role, cm.content, cm.created_at, cm.page_id
    FROM chat_messages cm
    WHERE ${filters.join(' AND ')}
    ORDER BY cm.created_at DESC LIMIT ${safeLimit}`, params);
  return r.rows.reverse();
}

originalGet.call(express.application, '/conversations/:agentId', async (req,res) => {
  try {
    const user = await authenticatedUser(req);
    if (!user?.id) return res.status(401).json({ success:false, error:'Login required.' });
    const agentId = clean(req.params.agentId, 200);
    if (!await hasAgentAccess(user.id, agentId)) return res.status(403).json({ success:false, error:'Agent access denied.' });
    const platform = clean(req.query.platform, 30).toLowerCase();
    const q = clean(req.query.q, 200);
    const pageId = clean(req.query.pageId, 200);
    const limit = req.query.limit;
    res.json({ success:true, conversations: await listConversations(agentId, user.id, platform, q, limit, pageId) });
  } catch(e) { console.error('Inbox list error:',e.message);res.status(500).json({ success:false, error:'Conversations could not be loaded.' }); }
});

originalGet.call(express.application, '/conversations/:agentId/:platform/:chatId', async (req,res) => {
  try {
    const user = await authenticatedUser(req);
    if (!user?.id) return res.status(401).json({ success:false, error:'Login required.' });
    const agentId = clean(req.params.agentId, 200);
    if (!await hasAgentAccess(user.id, agentId)) return res.status(403).json({ success:false, error:'Agent access denied.' });
    const platform = clean(req.params.platform, 30).toLowerCase();
    const chatId = clean(req.params.chatId, 300);
    const pageId = clean(req.query.pageId, 200);
    const limit = req.query.limit;
    res.json({ success:true, messages: await getMessages(agentId, user.id, platform, chatId, limit, pageId) });
  } catch(e) { console.error('Inbox messages error:',e.message);res.status(500).json({ success:false, error:'Conversation messages could not be loaded.' }); }
});

async function init() {
  await pool.query('ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS page_id TEXT');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_chat_messages_agent_platform_chat_created ON chat_messages(agent_id, platform, chat_id, created_at DESC)');
  console.log('✓ Authenticated Page-aware Conversations Inbox API ready');
}
init().catch(e => console.error('Conversations inbox init error:', e.message));
