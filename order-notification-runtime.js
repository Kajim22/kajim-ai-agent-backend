// Website order-notification runtime.
// Telegram notifications already happen in the existing order-save flow,
// so this layer intentionally handles only the website side to avoid duplicates.
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
    if (!agentId) return res.json({ success: false, error: 'agentId প্রয়োজন' });

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
    res.json({ success: false, error: err.message });
  }
});

console.log('✓ Order notification runtime ready');
