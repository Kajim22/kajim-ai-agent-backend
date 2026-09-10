// Order notification runtime: additive, production-safe notifications for website and Telegram.
const express = require('express');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

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

function getWebsiteNotificationUrl() {
  return String(process.env.ORDER_NOTIFICATION_WEBHOOK_URL || '').trim();
}

async function notifyWebsite(row) {
  const url = getWebsiteNotificationUrl();
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

async function notifyTelegram(row) {
  const chatId = String(process.env.MY_TELEGRAM_CHAT_ID || '').trim();
  if (!chatId) return { ok: false, skipped: true };

  try {
    const result = await pool.query('SELECT bot_token FROM telegram_bots ORDER BY created_at ASC LIMIT 1');
    const token = result.rows[0]?.bot_token;
    if (!token) return { ok: false, skipped: true };

    const text = `🛒 নতুন অর্ডার এসেছে!\n\n🆔 #${row.id}\n👤 নাম: ${row.customer_name}\n📞 ফোন: ${row.customer_phone}\n📍 ঠিকানা: ${row.customer_address}\n📦 পণ্য: ${row.order_details}`;
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { ok: true };
  } catch (err) {
    console.error('Telegram order notification failed:', err.message);
    return { ok: false, error: err.message };
  }
}

async function notifyOrderCreated(row) {
  const [website, telegram] = await Promise.all([notifyWebsite(row), notifyTelegram(row)]);
  console.log(`✓ Order notifications: order=${row.id} website=${website.ok ? 'sent' : 'skipped/failed'} telegram=${telegram.ok ? 'sent' : 'skipped/failed'}`);
}

// Public API for the existing server-side order saver.
global.notifyOrderCreated = notifyOrderCreated;

// Website polling fallback: useful even if the frontend does not have a webhook yet.
express.application.get.call(express.application, '/orders/notifications/:agentId', async (req, res) => {
  try {
    const agentId = String(req.params.agentId || '').trim();
    if (!agentId) return res.json({ success: false, error: 'agentId প্রয়োজন' });
    const sinceId = Number(req.query.sinceId || 0);
    const r = await pool.query(
      `SELECT id, agent_id, customer_name, customer_phone, customer_address, order_details, chat_id, created_at
       FROM orders WHERE agent_id=$1 AND id>$2 ORDER BY id ASC LIMIT 50`,
      [agentId, Number.isFinite(sinceId) ? sinceId : 0]
    );
    res.json({ success: true, orders: r.rows.map(orderNotificationPayload) });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

console.log('✓ Order notification runtime ready');
