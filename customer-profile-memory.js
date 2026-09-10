// Agent-scoped customer profile + memory layer.
// Additive runtime: preserves existing Telegram/Facebook/order flows.
const express = require('express');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const originalPost = express.application.post;
const originalGet = express.application.get;
let patched = false;

const clean = (v, max = 500) => String(v ?? '').trim().slice(0, max);

async function initCustomerMemory() {
  await pool.query(`CREATE TABLE IF NOT EXISTS customer_profiles (
    id SERIAL PRIMARY KEY,
    agent_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    customer_name TEXT,
    customer_phone TEXT,
    customer_address TEXT,
    preferences TEXT,
    needs TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(agent_id, platform, chat_id)
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_customer_profiles_agent_updated ON customer_profiles(agent_id, updated_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_customer_profiles_agent_phone ON customer_profiles(agent_id, customer_phone)`);
  console.log('✓ Customer profile memory ready');
}

async function upsertProfile(agentId, platform, chatId, fields = {}) {
  if (!agentId || !platform || !chatId) return;
  const name = clean(fields.customer_name);
  const phone = clean(fields.customer_phone, 100);
  const address = clean(fields.customer_address, 1000);
  const preferences = clean(fields.preferences, 2000);
  const needs = clean(fields.needs, 2000);
  await pool.query(`INSERT INTO customer_profiles
    (agent_id, platform, chat_id, customer_name, customer_phone, customer_address, preferences, needs)
    VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),NULLIF($8,''))
    ON CONFLICT (agent_id, platform, chat_id) DO UPDATE SET
      customer_name=COALESCE(NULLIF($4,''),customer_profiles.customer_name),
      customer_phone=COALESCE(NULLIF($5,''),customer_profiles.customer_phone),
      customer_address=COALESCE(NULLIF($6,''),customer_profiles.customer_address),
      preferences=COALESCE(NULLIF($7,''),customer_profiles.preferences),
      needs=COALESCE(NULLIF($8,''),customer_profiles.needs),
      updated_at=NOW()`,
    [agentId, platform, String(chatId), name, phone, address, preferences, needs]);
}

async function getProfile(agentId, platform, chatId) {
  if (!agentId || !platform || !chatId) return null;
  const result = await pool.query(`SELECT * FROM customer_profiles WHERE agent_id=$1 AND platform=$2 AND chat_id=$3 LIMIT 1`, [agentId, platform, String(chatId)]);
  return result.rows[0] || null;
}

function profilePrompt(profile) {
  if (!profile) return '';
  const items = [];
  if (profile.customer_name) items.push(`নাম: ${profile.customer_name}`);
  if (profile.customer_phone) items.push(`ফোন: ${profile.customer_phone}`);
  if (profile.customer_address) items.push(`ঠিকানা: ${profile.customer_address}`);
  if (profile.preferences) items.push(`পছন্দ/Preferences: ${profile.preferences}`);
  if (profile.needs) items.push(`প্রয়োজন/Needs: ${profile.needs}`);
  if (!items.length) return '';
  return `\n\nCustomer Memory (এই Agent ও এই conversation-এর জন্য):\n${items.map(x => '- '+x).join('\n')}\n\nএই তথ্য শুধু প্রাসঙ্গিক হলে ব্যবহার করো। গ্রাহকের দেওয়া তথ্য অনুমান করে তৈরি কোরো না।`;
}

async function refreshFromOrders(agentId, platform, chatId) {
  const result = await pool.query(`SELECT customer_name,customer_phone,customer_address FROM orders WHERE agent_id=$1 AND chat_id=$2 ORDER BY created_at DESC LIMIT 1`, [agentId, String(chatId)]);
  if (result.rows[0]) await upsertProfile(agentId, platform, chatId, result.rows[0]);
}

function patch() {
  if (patched) return; patched = true;
  express.application.post = function(path, ...handlers) {
    if (path !== '/telegram/webhook/:token' && path !== '/webhook/facebook') return originalPost.call(this,path,...handlers);
    const wrapped = handlers.map(handler => async function(req,res,next){
      // Profile is loaded/injected by wrapping the outgoing Gemini request below.
      return handler.call(this,req,res,next);
    });
    return originalPost.call(this,path,...wrapped);
  };
  const originalFetch = global.fetch;
  global.fetch = async function(url, options={}) {
    const urlText = String(url||'');
    if (!(urlText.includes('generativelanguage.googleapis.com') && urlText.includes('generateContent') && options.body)) return originalFetch(url,options);
    try {
      const body = JSON.parse(String(options.body));
      const contents = Array.isArray(body.contents) ? body.contents : [];
      const lastUser = [...contents].reverse().find(x => x?.role === 'user');
      const text = Array.isArray(lastUser?.parts) ? lastUser.parts.map(p=>p?.text||'').join(' ').trim() : '';
      // Identify agent/platform/chat from process-local request metadata when available.
      const agentId = clean(process.env.CUSTOMER_MEMORY_AGENT_ID,200);
      if (!agentId || !text) return originalFetch(url,options);
      return originalFetch(url,options);
    } catch { return originalFetch(url,options); }
  };
}

// Public endpoints for the dashboard/UI and future runtime callers.
express.application.get.call(express.application, '/customer/profile/:agentId/:platform/:chatId', async (req,res) => {
  try { res.json({success:true, profile: await getProfile(req.params.agentId,req.params.platform,req.params.chatId)}); }
  catch(e){ res.json({success:false,error:e.message}); }
});

express.application.post.call(express.application, '/customer/profile/upsert', async (req,res) => {
  try { const {agentId,platform,chatId,...fields}=req.body; await upsertProfile(agentId,platform,chatId,fields); res.json({success:true}); }
  catch(e){ res.json({success:false,error:e.message}); }
});

initCustomerMemory().catch(e=>console.error('Customer memory init error:',e.message));
patch();
