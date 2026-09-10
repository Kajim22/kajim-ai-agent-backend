// Website Chat Widget API — additive, agent-scoped.
const express = require('express');
const { Pool } = require('pg');
const { randomUUID } = require('node:crypto');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

function cleanAgentId(v){ return String(v || '').trim(); }
function cleanText(v, max=4000){ return String(v || '').trim().slice(0,max); }

express.application.get.call(express.application, '/widget/config/:agentId', async (req,res)=>{
  try{
    const agentId=cleanAgentId(req.params.agentId);
    if(!agentId) return res.json({success:false,error:'agentId প্রয়োজন'});
    const r=await pool.query('SELECT agent_id FROM telegram_bots WHERE agent_id=$1 LIMIT 1',[agentId]);
    const f=await pool.query('SELECT agent_id FROM facebook_pages WHERE agent_id=$1 LIMIT 1',[agentId]);
    const exists=r.rowCount>0 || f.rowCount>0;
    res.json({success:true,agentId,available:exists});
  }catch(e){res.json({success:false,error:e.message});}
});

express.application.post.call(express.application, '/widget/chat', async (req,res)=>{
  const agentId=cleanAgentId(req.body?.agentId);
  const message=cleanText(req.body?.message);
  const sessionId=cleanText(req.body?.sessionId,120) || randomUUID();
  if(!agentId || !message) return res.json({success:false,error:'agentId ও message প্রয়োজন'});
  const API_KEY=process.env.GEMINI_API_KEY;
  if(!API_KEY) return res.json({success:false,error:'AI API Key সেট করা নেই'});
  try{
    const promptSources=await pool.query('SELECT system_prompt FROM telegram_bots WHERE agent_id=$1 ORDER BY created_at DESC LIMIT 1',[agentId]);
    let systemPrompt=promptSources.rows[0]?.system_prompt || '';
    if(!systemPrompt){
      const fb=await pool.query('SELECT system_prompt FROM facebook_pages WHERE agent_id=$1 ORDER BY created_at DESC LIMIT 1',[agentId]);
      systemPrompt=fb.rows[0]?.system_prompt || '';
    }
    if(!systemPrompt) systemPrompt='তুমি একজন সহকারী।';

    const history=await pool.query(`SELECT role,content FROM chat_messages WHERE platform='website' AND chat_id=$1 AND agent_id=$2 ORDER BY created_at DESC LIMIT 19`,[sessionId,agentId]);
    const ordered=history.rows.reverse().map(r=>({role:r.role,parts:[{text:r.content}]}));
    ordered.push({role:'user',parts:[{text:message}]});

    const response=await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key='+API_KEY,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({system_instruction:{parts:[{text:systemPrompt}]},contents:ordered})});
    const data=await response.json();
    const reply=data?.candidates?.[0]?.content?.parts?.[0]?.text || data?.error?.message || 'দুঃখিত, কোনো উত্তর পাওয়া যায়নি।';
    await pool.query('INSERT INTO chat_messages (platform,chat_id,agent_id,role,content) VALUES ($1,$2,$3,$4,$5)', ['website',sessionId,agentId,'user',message]);
    await pool.query('INSERT INTO chat_messages (platform,chat_id,agent_id,role,content) VALUES ($1,$2,$3,$4,$5)', ['website',sessionId,agentId,'model',reply]);
    res.json({success:true,sessionId,reply});
  }catch(e){console.error('website widget chat error:',e.message);res.json({success:false,error:'সার্ভার এরর'});}
});
