// Website order-notification runtime.
// Telegram notifications already happen in the existing order-save flow,
// so this layer intentionally handles only the website side to avoid duplicates.
const express = require('express');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yhspipyrgdcdfqqxxges.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || 'sb_publishable_IcyDHTLjyPPspvcgnYZZiw_q1lUn8QW';
async function authorizeAgent(req, agentId) {
  const auth = String(req.headers.authorization || '');
  if (!auth.startsWith('Bearer ')) return false;
  try {
    const response = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: { apikey: SUPABASE_KEY, Authorization: auth } });
    if (!response.ok) return false;
    const user = await response.json();
    if (!user?.id) return false;
    const [owner, marketplace, connected, admin] = await Promise.all([
      pool.query('SELECT id FROM user_agents WHERE id=$1 AND owner_user_id=$2 LIMIT 1', [String(agentId), String(user.id)]),
      pool.query('SELECT id FROM marketplace_agents WHERE agent_id=$1 AND owner_user_id=$2 LIMIT 1', [String(agentId), String(user.id)]),
      pool.query('SELECT page_id FROM facebook_pages WHERE agent_id=$1 AND customer_user_id=$2 UNION ALL SELECT bot_token AS page_id FROM telegram_bots WHERE agent_id=$1 AND customer_user_id=$2 LIMIT 1', [String(agentId), String(user.id)]),
      pool.query('SELECT user_id FROM platform_admins WHERE user_id=$1 LIMIT 1', [String(user.id)])
    ]);
    return !!(owner.rows[0] || marketplace.rows[0] || connected.rows[0] || admin.rows[0]);
  } catch (error) { console.error('Order notification auth error:', error.message); return false; }
}

function orderNotificationPayload(row) {
  return {
    id: row.id,
    agentId: row.agent_id,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    customerAddress: row.customer_address,
    orderDetails: row.order_details,
    chatId: row.chat_id,
    createdAt: row.created_at
  };
}

async function notifyWebsite(row) {
  const url = String(process.env.ORDER_NOTIFICATION_WEBHOOK_URL || '').trim();
  if (!url) return { ok: false, skipped: true };
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'new_order', order: orderNotificationPayload(row) })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { ok: true };
  } catch (err) {
    console.error('Website order notification failed:', err.message);
    return { ok: false, error: err.message };
  }
}

global.notifyOrderCreated = async function notifyOrderCreated(row) {
  const result = await notifyWebsite(row);
  console.log(`✓ Website order notification: order=${row.id} ${result.ok ? 'sent' : 'skipped/failed'}`);
  return result;
};

// Polling fallback: the website can detect new orders even when no webhook URL is configured.
express.application.get.call(express.application, '/orders/notifications/:agentId', async (req, res) => {
  try {
    const agentId = String(req.params.agentId || '').trim();
    if (!agentId) return res.status(400).json({ success: false, error: 'agentId প্রয়োজন' });
    if (!await authorizeAgent(req, agentId)) return res.status(403).json({ success: false, error: 'Order notification access denied' });

    const rawSinceId = Number(req.query.sinceId || 0);
    const sinceId = Number.isFinite(rawSinceId) && rawSinceId >= 0 ? rawSinceId : 0;
    const result = await pool.query(
      `SELECT id, agent_id, customer_name, customer_phone, customer_address, order_details, chat_id, created_at
       FROM orders
       WHERE agent_id = $1 AND id > $2
       ORDER BY id ASC
       LIMIT 50`,
      [agentId, sinceId]
    );

    res.json({ success: true, orders: result.rows.map(orderNotificationPayload) });
  } catch (err) {
    console.error('Order notification polling error:', err.message);
    res.status(500).json({ success: false, error: 'Order notification polling failed' });
  }
});

console.log('✓ Order notification runtime ready');
