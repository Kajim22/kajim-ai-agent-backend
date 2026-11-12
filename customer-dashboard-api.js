// Customer CRM API — authenticated, agent-scoped customer and purchase history.
const express = require('express');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yhspipyrgdcdfqqxxges.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || 'sb_publishable_IcyDHTLjyPPspvcgnYZZiw_q1lUn8QW';

async function authenticate(req) {
  const auth=String(req.headers.authorization||'');
  if(!auth.startsWith('Bearer ')||!SUPABASE_KEY)return null;
  try {
    const r=await fetch(SUPABASE_URL+'/auth/v1/user',{headers:{apikey:SUPABASE_KEY,Authorization:auth}});
    if(!r.ok)return null;
    return await r.json();
  } catch(e){ console.error('[CUSTOMER CRM] auth error:',e.message); return null; }
}
async function canViewAgent(userId,agentId) {
  const own=await pool.query('SELECT id FROM user_agents WHERE id=$1 AND owner_user_id=$2 LIMIT 1',[String(agentId),String(userId)]);
  if(own.rows[0])return true;
  const admin=await pool.query('SELECT user_id FROM platform_admins WHERE user_id=$1 LIMIT 1',[String(userId)]);
  if(admin.rows[0])return true;
  const sub=await pool.query(`SELECT 1 FROM marketplace_subscriptions s
    JOIN marketplace_agents a ON a.id=s.marketplace_agent_id
    WHERE s.buyer_user_id=$1 AND a.agent_id=$2
    AND (s.status IN ('active','free') OR (s.status='admin_granted' AND (s.access_expires_at IS NULL OR s.access_expires_at>NOW())))
    LIMIT 1`,[String(userId),String(agentId)]);
  return !!sub.rows[0];
}

express.application.get.call(express.application, '/customer/profiles/:agentId', async (req,res)=>{
  try {
    const user=await authenticate(req);
    if(!user?.id)return res.status(401).json({success:false,error:'Login required'});
    const agentId=String(req.params.agentId||'').trim();
    if(!agentId)return res.status(400).json({success:false,error:'agentId প্রয়োজন'});
    if(!await canViewAgent(user.id,agentId))return res.status(403).json({success:false,error:'এই Agent-এর Customer দেখার অনুমতি নেই'});
    const r=await pool.query(`SELECT cp.id,cp.agent_id,cp.platform,cp.chat_id,cp.customer_name,cp.customer_phone,cp.customer_address,cp.preferences,cp.needs,cp.created_at,cp.updated_at,
      COUNT(o.id)::int AS order_count, MAX(o.created_at) AS last_order_at,
      COALESCE(json_agg(json_build_object('id',o.id,'order_details',o.order_details,'created_at',o.created_at) ORDER BY o.created_at DESC) FILTER (WHERE o.id IS NOT NULL),'[]'::json) AS orders
      FROM customer_profiles cp LEFT JOIN orders o ON o.agent_id=cp.agent_id AND o.chat_id=cp.chat_id
      WHERE cp.agent_id=$1 GROUP BY cp.id ORDER BY cp.updated_at DESC`,[agentId]);
    const customers=r.rows;
    res.json({success:true,customers,stats:{total:customers.length,repeat:customers.filter(c=>c.order_count>1).length,new:customers.filter(c=>c.order_count===0).length,withFollowup:customers.filter(c=>!c.customer_phone||!c.customer_address).length}});
  } catch(e){ console.error('[CUSTOMER CRM] list error:',e.message); res.status(500).json({success:false,error:'Customer data load failed'}); }
});
