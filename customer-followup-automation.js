// Delivery-triggered customer follow-up automation.
// Sends one satisfaction check 24 hours after an order is explicitly marked delivered.
const express = require('express');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yhspipyrgdcdfqqxxges.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || 'sb_publishable_IcyDHTLjyPPspvcgnYZZiw_q1lUn8QW';
const GRAPH_VERSION = process.env.FACEBOOK_GRAPH_VERSION || 'v26.0';
let ready = false, busy = false;

async function authUser(req) {
  const h=String(req.headers.authorization||'');
  if(!h.startsWith('Bearer '))return null;
  try {
    const r=await fetch(SUPABASE_URL+'/auth/v1/user',{headers:{apikey:SUPABASE_KEY,Authorization:h}});
    if(!r.ok)return null; return await r.json();
  } catch(e){return null;}
}
async function canManage(userId,agentId){
  const own=await pool.query('SELECT id FROM user_agents WHERE id=$1 AND owner_user_id=$2 LIMIT 1',[String(agentId),String(userId)]);
  if(own.rows[0])return true;
  const admin=await pool.query('SELECT user_id FROM platform_admins WHERE user_id=$1 LIMIT 1',[String(userId)]);
  return !!admin.rows[0];
}
async function init(){
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'pending'`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS followup_opted_out BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`CREATE TABLE IF NOT EXISTS customer_followups (
    id BIGSERIAL PRIMARY KEY, order_id BIGINT NOT NULL UNIQUE, agent_id TEXT NOT NULL,
    platform TEXT NOT NULL, chat_id TEXT NOT NULL, due_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', sent_at TIMESTAMPTZ, last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_customer_followups_due ON customer_followups(status,due_at)`);
  ready=true; console.log('✓ Delivery follow-up automation ready');
}
async function sendFollowup(row){
  const message='আসসালামু আলাইকুম! আপনার অর্ডারটি ডেলিভারি হয়েছে। পণ্যটি কেমন পেয়েছেন? আপনার মতামত আমাদের কাছে গুরুত্বপূর্ণ। কোনো সমস্যা হলে জানাবেন, আমরা সাহায্য করব।\n\nআর কোনো Follow-up মেসেজ পেতে না চাইলে STOP লিখুন।';
  if(row.platform==='telegram'){
    const b=await pool.query('SELECT bot_token FROM telegram_bots WHERE agent_id=$1 ORDER BY created_at DESC LIMIT 1',[row.agent_id]);
    if(!b.rows[0]?.bot_token)throw new Error('Telegram bot not connected');
    const r=await fetch('https://api.telegram.org/bot'+b.rows[0].bot_token+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:row.chat_id,text:message})});
    const j=await r.json().catch(()=>({}));if(!r.ok||!j.ok)throw new Error(j.description||'Telegram send failed');
    return;
  }
  const p=await pool.query('SELECT page_access_token FROM facebook_pages WHERE agent_id=$1 ORDER BY created_at DESC LIMIT 1',[row.agent_id]);
  if(!p.rows[0]?.page_access_token)throw new Error('Facebook Page not connected');
  const r=await fetch('https://graph.facebook.com/'+GRAPH_VERSION+'/me/messages?access_token='+encodeURIComponent(p.rows[0].page_access_token),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({recipient:{id:row.chat_id},message:{text:message},messaging_type:'MESSAGE_TAG',tag:'POST_PURCHASE_UPDATE'})});
  const j=await r.json().catch(()=>({}));if(!r.ok||j.error)throw new Error(j.error?.message||'Facebook send failed');
}
async function processQueue(){
  if(!ready||busy)return;busy=true;
  try{
    const r=await pool.query(`SELECT f.*,o.followup_opted_out FROM customer_followups f
      JOIN orders o ON o.id=f.order_id
      WHERE f.status='pending' AND f.due_at<=NOW() AND o.delivery_status='delivered'
        AND o.followup_opted_out=FALSE
      ORDER BY f.due_at ASC LIMIT 10`);
    for(const row of r.rows){
      try{await sendFollowup(row);await pool.query("UPDATE customer_followups SET status='sent',sent_at=NOW(),last_error=NULL WHERE id=$1",[row.id]);console.log('✓ Customer delivery follow-up sent: order='+row.order_id);}
      catch(e){await pool.query("UPDATE customer_followups SET status='failed',last_error=$2 WHERE id=$1",[row.id,String(e.message).slice(0,500)]);console.error('Customer follow-up failed:',e.message);}
    }
  }catch(e){console.error('Follow-up queue error:',e.message);}finally{busy=false;}
}
express.application.patch.call(express.application,'/orders/:orderId/delivery-status',async(req,res)=>{
  try{
    const user=await authUser(req);if(!user?.id)return res.status(401).json({success:false,error:'Login required'});
    const status=String(req.body?.status||'').toLowerCase();
    if(!['pending','shipped','delivered','cancelled'].includes(status))return res.status(400).json({success:false,error:'Invalid delivery status'});
    const found=await pool.query('SELECT id,agent_id,chat_id FROM orders WHERE id=$1 LIMIT 1',[String(req.params.orderId)]);
    if(!found.rows[0])return res.status(404).json({success:false,error:'Order not found'});
    const order=found.rows[0];if(!await canManage(user.id,order.agent_id))return res.status(403).json({success:false,error:'Agent access denied'});
    if(status==='delivered'){
      await pool.query("UPDATE orders SET delivery_status='delivered',delivered_at=COALESCE(delivered_at,NOW()) WHERE id=$1",[order.id]);
      const p=String(req.body?.platform||'facebook').toLowerCase()==='telegram'?'telegram':'facebook';
      await pool.query(`INSERT INTO customer_followups(order_id,agent_id,platform,chat_id,due_at)
        VALUES($1,$2,$3,$4,NOW()+INTERVAL '24 hours')
        ON CONFLICT(order_id) DO UPDATE SET status=CASE WHEN customer_followups.status='sent' THEN 'sent' ELSE 'pending' END,
        due_at=EXCLUDED.due_at,platform=EXCLUDED.platform,chat_id=EXCLUDED.chat_id`,[order.id,String(order.agent_id),p,String(order.chat_id)]);
    }else{
      await pool.query('UPDATE orders SET delivery_status=$2 WHERE id=$1',[order.id,status]);
      if(status==='cancelled')await pool.query("UPDATE customer_followups SET status='cancelled' WHERE order_id=$1 AND status='pending'",[order.id]);
    }
    res.json({success:true,deliveryStatus:status,followup:status==='delivered'?'scheduled for 24 hours after delivery':'not scheduled'});
  }catch(e){console.error('Delivery status update failed:',e.message);res.status(500).json({success:false,error:'Delivery status update failed'});}
});
express.application.post.call(express.application,'/customers/followup-optout',async(req,res)=>{
  try{
    const {agentId,chatId}=req.body||{};const platform=String(req.body?.platform||'').toLowerCase();
    if(!agentId||!chatId||!['facebook','telegram'].includes(platform))return res.status(400).json({success:false,error:'agentId, platform and chatId required'});
    await pool.query('UPDATE orders SET followup_opted_out=TRUE WHERE agent_id=$1 AND chat_id=$2',[String(agentId),String(chatId)]);
    await pool.query("UPDATE customer_followups SET status='cancelled' WHERE agent_id=$1 AND chat_id=$2 AND status='pending'",[String(agentId),String(chatId)]);
    res.json({success:true});
  }catch(e){res.status(500).json({success:false,error:'Opt-out failed'});}
});
init().then(()=>{setInterval(processQueue,5*60*1000);processQueue();}).catch(e=>console.error('Follow-up init failed:',e.message));
