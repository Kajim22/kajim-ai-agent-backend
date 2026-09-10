// Agent-scoped customer profile + memory layer.
// Additive runtime: preserves existing Telegram/Facebook/order flows.
const express = require('express');
const { Pool } = require('pg');
const { AsyncLocalStorage } = require('node:async_hooks');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const context = new AsyncLocalStorage();
const originalPost = express.application.post;
const originalFetch = global.fetch;
let patched = false;
const clean = (v, max=500) => String(v ?? '').trim().slice(0,max);

async function initCustomerMemory(){
  await pool.query(`CREATE TABLE IF NOT EXISTS customer_profiles (
    id SERIAL PRIMARY KEY, agent_id TEXT NOT NULL, platform TEXT NOT NULL, chat_id TEXT NOT NULL,
    customer_name TEXT, customer_phone TEXT, customer_address TEXT, preferences TEXT, needs TEXT,
    created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(agent_id, platform, chat_id))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_customer_profiles_agent_updated ON customer_profiles(agent_id, updated_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_customer_profiles_agent_phone ON customer_profiles(agent_id, customer_phone)`);
  console.log('✓ Customer profile memory ready');
}
async function upsertProfile(agentId,platform,chatId,fields={}){
  if(!agentId||!platform||!chatId)return;
  const values=[agentId,platform,String(chatId),clean(fields.customer_name),clean(fields.customer_phone,100),clean(fields.customer_address,1000),clean(fields.preferences,2000),clean(fields.needs,2000)];
  await pool.query(`INSERT INTO customer_profiles(agent_id,platform,chat_id,customer_name,customer_phone,customer_address,preferences,needs)
    VALUES($1,$2,$3,NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),NULLIF($8,''))
    ON CONFLICT(agent_id,platform,chat_id) DO UPDATE SET
    customer_name=COALESCE(NULLIF($4,''),customer_profiles.customer_name), customer_phone=COALESCE(NULLIF($5,''),customer_profiles.customer_phone),
    customer_address=COALESCE(NULLIF($6,''),customer_profiles.customer_address), preferences=COALESCE(NULLIF($7,''),customer_profiles.preferences),
    needs=COALESCE(NULLIF($8,''),customer_profiles.needs), updated_at=NOW()`,values);
}
async function getProfile(agentId,platform,chatId){
  if(!agentId||!platform||!chatId)return null;
  const r=await pool.query('SELECT * FROM customer_profiles WHERE agent_id=$1 AND platform=$2 AND chat_id=$3 LIMIT 1',[agentId,platform,String(chatId)]);
  return r.rows[0]||null;
}
function profilePrompt(p){
  if(!p)return '';
  const a=[]; if(p.customer_name)a.push(`নাম: ${p.customer_name}`); if(p.customer_phone)a.push(`ফোন: ${p.customer_phone}`); if(p.customer_address)a.push(`ঠিকানা: ${p.customer_address}`); if(p.preferences)a.push(`পছন্দ: ${p.preferences}`); if(p.needs)a.push(`প্রয়োজন: ${p.needs}`);
  return a.length?`\n\nCustomer Memory (শুধু প্রাসঙ্গিক হলে ব্যবহার করো):\n${a.map(x=>'- '+x).join('\n')}\nগ্রাহকের দেওয়া তথ্য অনুমান করে তৈরি কোরো না।`:'';
}
function patch(){
  if(patched)return; patched=true;
  express.application.post=function(path,...handlers){
    const watched=path==='/telegram/webhook/:token'||path==='/webhook/facebook';
    if(!watched)return originalPost.call(this,path,...handlers);
    const wrapped=handlers.map(handler=>async function(req,res,next){
      let agentId='',platform='',chatId='';
      try{
        if(path==='/telegram/webhook/:token'){
          const token=clean(req.params?.token,500); const r=await pool.query('SELECT agent_id FROM telegram_bots WHERE bot_token=$1 LIMIT 1',[token]);
          agentId=clean(r.rows[0]?.agent_id,200); platform='telegram'; chatId=clean(req.body?.message?.chat?.id,200);
        }else{
          const pageId=clean(req.body?.entry?.[0]?.id,200); const r=await pool.query('SELECT agent_id FROM facebook_pages WHERE page_id=$1 LIMIT 1',[pageId]);
          agentId=clean(r.rows[0]?.agent_id,200); platform='facebook'; chatId=clean(req.body?.entry?.[0]?.messaging?.[0]?.sender?.id,200);
        }
        return context.run({agentId,platform,chatId},()=>handler.call(this,req,res,next));
      }catch(e){console.error('Customer memory context error:',e.message); return handler.call(this,req,res,next);}
    });
    return originalPost.call(this,path,...wrapped);
  };
  global.fetch=async function(url,options={}){
    const u=String(url||''); if(!(u.includes('generativelanguage.googleapis.com')&&u.includes('generateContent')&&options.body))return originalFetch(url,options);
    const store=context.getStore(); if(!store?.agentId||!store?.chatId)return originalFetch(url,options);
    try{
      const body=JSON.parse(String(options.body)); const p=await getProfile(store.agentId,store.platform,store.chatId);
      if(p){ const base=body?.system_instruction?.parts?.[0]?.text||''; body.system_instruction={parts:[{text:base+profilePrompt(p)}]}; }
      return originalFetch(url,{...options,body:JSON.stringify(body)});
    }catch(e){console.error('Customer memory injection error:',e.message); return originalFetch(url,options);}
  };
}

express.application.get.call(express.application,'/customer/profile/:agentId/:platform/:chatId',async(req,res)=>{try{res.json({success:true,profile:await getProfile(req.params.agentId,req.params.platform,req.params.chatId)});}catch(e){res.json({success:false,error:e.message});}});
express.application.post.call(express.application,'/customer/profile/upsert',async(req,res)=>{try{const{agentId,platform,chatId,...fields}=req.body;await upsertProfile(agentId,platform,chatId,fields);res.json({success:true});}catch(e){res.json({success:false,error:e.message});}});
initCustomerMemory().catch(e=>console.error('Customer memory init error:',e.message));
patch();
