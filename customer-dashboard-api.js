// Customer dashboard API — additive, agent-scoped read endpoint.
const express = require('express');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

express.application.get.call(express.application, '/customer/profiles/:agentId', async (req,res)=>{
  try {
    const agentId=String(req.params.agentId||'').trim();
    if(!agentId) return res.json({success:false,error:'agentId প্রয়োজন'});
    const r=await pool.query(`SELECT id,agent_id,platform,chat_id,customer_name,customer_phone,customer_address,preferences,needs,created_at,updated_at FROM customer_profiles WHERE agent_id=$1 ORDER BY updated_at DESC`,[agentId]);
    res.json({success:true,customers:r.rows});
  } catch(e){ res.json({success:false,error:e.message}); }
});
