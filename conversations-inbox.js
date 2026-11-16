// Authenticated Facebook Messenger Inbox API.
// Routes are additive and scoped to facebook_pages.customer_user_id + agent_id.
const express = require('express');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const originalGet = express.application.get;
const originalPost = express.application.post;
const originalPatch = express.application.patch;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yhspipyrgdcdfqqxxges.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || 'sb_publishable_IcyDHTLjyPPspvcgnYZZiw_q1lUn8QW';
const clean = (v,n=500) => String(v ?? '').trim().slice(0,n);

async function auth(req) {
  const h=String(req.headers.authorization||'');
  if(!h.startsWith('Bearer ') || !SUPABASE_KEY) return null;
  try {
    const r=await fetch(SUPABASE_URL+'/auth/v1/user',{headers:{apikey:SUPABASE_KEY,Authorization:h}});
    if(!r.ok) return null;
    const u=await r.json(); return u?.id ? u : null;
  } catch(e) { console.error('Inbox auth failed:',e.message); return null; }
}
async function ownedPage(req,res,agentId,pageId) {
  const user=await auth(req);
  if(!user) { res.status(401).json({success:false,error:'Login required'}); return null; }
  const r=await pool.query(
    'SELECT page_id,page_access_token,agent_id,customer_user_id FROM facebook_pages WHERE page_id=$1 AND agent_id=$2 AND customer_user_id=$3 LIMIT 1',
    [String(pageId),String(agentId),String(user.id)]);
  if(!r.rows[0]) { res.status(403).json({success:false,error:'Facebook Page access denied'}); return null; }
  return {user,page:r.rows[0]};
}
async function init() {
  await pool.query(`CREATE TABLE IF NOT EXISTS messenger_inbox_controls(
    page_id TEXT NOT NULL, chat_id TEXT NOT NULL, ai_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    updated_by UUID, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(page_id,chat_id))`);
  console.log('✓ Secure Messenger Inbox API ready');
}
init().catch(e=>console.error('Messenger Inbox DB init failed:',e.message));

originalGet.call(express.application,'/conversations/:agentId/facebook-pages',async(req,res)=>{
  try {
    const user=await auth(req); if(!user) return res.status(401).json({success:false,error:'Login required'});
    const r=await pool.query('SELECT page_id,agent_id FROM facebook_pages WHERE agent_id=$1 AND customer_user_id=$2 ORDER BY created_at DESC',[clean(req.params.agentId,200),String(user.id)]);
    res.json({success:true,pages:r.rows});
  } catch(e) { console.error('Inbox pages:',e.message); res.status(500).json({success:false,error:'Pages could not be loaded'}); }
});
originalGet.call(express.application,'/conversations/:agentId/facebook',async(req,res)=>{
  try {
    const agentId=clean(req.params.agentId,200), pageId=clean(req.query.pageId,100);
    if(!pageId) return res.status(400).json({success:false,error:'pageId required'});
    const access=await ownedPage(req,res,agentId,pageId); if(!access) return;
    const q=clean(req.query.q,200), limit=Math.min(Math.max(Number(req.query.limit)||100,1),200);
    const r=await pool.query(`
      SELECT m.chat_id,MAX(m.created_at) last_message_at,COUNT(*)::int message_count,
      (ARRAY_AGG(m.content ORDER BY m.created_at DESC))[1] last_message,
      COALESCE((SELECT c.ai_enabled FROM messenger_inbox_controls c
       WHERE c.page_id=$2 AND c.chat_id IN ('*',m.chat_id)
       ORDER BY CASE WHEN c.chat_id='*' THEN 0 ELSE 1 END LIMIT 1),TRUE) ai_enabled
      FROM chat_messages m WHERE m.agent_id=$1 AND m.platform='facebook'
      AND ($3='' OR m.chat_id ILIKE $3) GROUP BY m.chat_id
      ORDER BY MAX(m.created_at) DESC LIMIT $4`,
      [agentId,pageId,q?'%'+q+'%':'',limit]);
    res.json({success:true,conversations:r.rows});
  } catch(e) { console.error('Inbox list:',e.message); res.status(500).json({success:false,error:'Inbox load failed'}); }
});
originalGet.call(express.application,'/conversations/:agentId/facebook/:chatId',async(req,res)=>{
  try {
    const agentId=clean(req.params.agentId,200),chatId=clean(req.params.chatId,300),pageId=clean(req.query.pageId,100);
    if(!pageId) return res.status(400).json({success:false,error:'pageId required'});
    const access=await ownedPage(req,res,agentId,pageId); if(!access) return;
    const limit=Math.min(Math.max(Number(req.query.limit)||100,1),200);
    const [m,c]=await Promise.all([
      pool.query("SELECT id,role,content,created_at FROM chat_messages WHERE agent_id=$1 AND platform='facebook' AND chat_id=$2 ORDER BY created_at DESC LIMIT $3",[agentId,chatId,limit]),
      pool.query("SELECT ai_enabled FROM messenger_inbox_controls WHERE page_id=$1 AND chat_id IN ('*',$2) ORDER BY CASE WHEN chat_id=$2 THEN 0 ELSE 1 END LIMIT 1",[pageId,chatId])
    ]);
    res.json({success:true,messages:m.rows.reverse(),ai_enabled:c.rows[0]?.ai_enabled ?? true});
  } catch(e) { console.error('Inbox messages:',e.message); res.status(500).json({success:false,error:'Messages load failed'}); }
});
originalPost.call(express.application,'/conversations/:agentId/facebook/:chatId/reply',async(req,res)=>{
  try {
    const agentId=clean(req.params.agentId,200),chatId=clean(req.params.chatId,300);
    const pageId=clean(req.body?.pageId,100),message=clean(req.body?.message,2000);
    if(!pageId||!message) return res.status(400).json({success:false,error:'pageId and message required'});
    const access=await ownedPage(req,res,agentId,pageId); if(!access) return;
    const graph=process.env.FB_GRAPH_VERSION||'v26.0';
    const url=`https://graph.facebook.com/${graph}/me/messages?access_token=${encodeURIComponent(access.page.page_access_token)}`;
    const fb=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({recipient:{id:chatId},message:{text:message}})});
    const data=await fb.json().catch(()=>({}));
    if(!fb.ok||data.error) return res.status(502).json({success:false,error:data.error?.message||'Facebook send failed'});
    await pool.query("INSERT INTO chat_messages(platform,chat_id,agent_id,role,content) VALUES('facebook',$1,$2,'human',$3)",[chatId,agentId,message]);
    res.json({success:true,message_id:data.message_id||null});
  } catch(e) { console.error('Manual reply:',e.message); res.status(500).json({success:false,error:'Could not send reply'}); }
});
originalPatch.call(express.application,'/conversations/:agentId/facebook/:chatId/ai',async(req,res)=>{
  try {
    const agentId=clean(req.params.agentId,200),chatId=clean(req.params.chatId,300);
    const pageId=clean(req.body?.pageId,100),enabled=req.body?.enabled;
    if(!pageId||typeof enabled!=='boolean') return res.status(400).json({success:false,error:'pageId and boolean enabled required'});
    const access=await ownedPage(req,res,agentId,pageId); if(!access) return;
    await pool.query(`INSERT INTO messenger_inbox_controls(page_id,chat_id,ai_enabled,updated_by)
      VALUES($1,$2,$3,$4) ON CONFLICT(page_id,chat_id) DO UPDATE
      SET ai_enabled=EXCLUDED.ai_enabled,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
      [pageId,chatId,enabled,access.user.id]);
    res.json({success:true,ai_enabled:enabled});
  } catch(e) { console.error('Conversation AI toggle:',e.message); res.status(500).json({success:false,error:'Could not update AI setting'}); }
});
originalPatch.call(express.application,'/conversations/:agentId/facebook/page-ai',async(req,res)=>{
  try {
    const agentId=clean(req.params.agentId,200),pageId=clean(req.body?.pageId,100),enabled=req.body?.enabled;
    if(!pageId||typeof enabled!=='boolean') return res.status(400).json({success:false,error:'pageId and boolean enabled required'});
    const access=await ownedPage(req,res,agentId,pageId); if(!access) return;
    await pool.query(`INSERT INTO messenger_inbox_controls(page_id,chat_id,ai_enabled,updated_by)
      VALUES($1,'*',$2,$3) ON CONFLICT(page_id,chat_id) DO UPDATE
      SET ai_enabled=EXCLUDED.ai_enabled,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
      [pageId,enabled,access.user.id]);
    res.json({success:true,ai_enabled:enabled});
  } catch(e) { console.error('Page AI toggle:',e.message); res.status(500).json({success:false,error:'Could not update Page AI setting'}); }
});
