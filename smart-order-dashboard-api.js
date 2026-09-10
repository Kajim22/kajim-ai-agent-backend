// Smart Orders Dashboard API — additive, agent-scoped order management.
const express = require('express');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// These routes are preloaded before server.js registers its global CORS middleware.
// Set CORS headers here too, otherwise browsers may report a generic "Failed to fetch".
function allowCors(res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
}

async function ensureOrderStatusColumn(){
  try{
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'new'`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_agent_status_created ON orders(agent_id,status,created_at DESC)`);
  }catch(e){ console.error('Smart Order schema error:',e.message); }
}
ensureOrderStatusColumn();

express.application.get.call(express.application,'/orders/dashboard/:agentId',async(req,res)=>{
  allowCors(res);
  try{
    const agentId=String(req.params.agentId||'').trim();
    if(!agentId)return res.json({success:false,error:'agentId প্রয়োজন'});
    const r=await pool.query(`SELECT id,agent_id,customer_name,customer_address,customer_phone,order_details,chat_id,status,created_at FROM orders WHERE agent_id=$1 ORDER BY created_at DESC`,[agentId]);
    const summary={new:0,confirmed:0,processing:0,delivered:0,cancelled:0,total:r.rows.length};
    r.rows.forEach(o=>{const s=String(o.status||'new').toLowerCase();if(Object.prototype.hasOwnProperty.call(summary,s))summary[s]++;});
    res.json({success:true,summary,orders:r.rows});
  }catch(e){
    console.error('Smart Order dashboard error:',e.message);
    res.json({success:false,error:e.message});
  }
});

express.application.options.call(express.application,'/orders/status',async(req,res)=>{
  allowCors(res);
  res.sendStatus(204);
});

express.application.post.call(express.application,'/orders/status',async(req,res)=>{
  allowCors(res);
  try{
    const id=Number(req.body?.id), agentId=String(req.body?.agentId||'').trim();
    const allowed=['new','confirmed','processing','delivered','cancelled'];
    const status=String(req.body?.status||'').toLowerCase();
    if(!id||!agentId||!allowed.includes(status))return res.json({success:false,error:'id, agentId ও বৈধ status প্রয়োজন'});
    const r=await pool.query(`UPDATE orders SET status=$1 WHERE id=$2 AND agent_id=$3 RETURNING id,status`,[status,id,agentId]);
    if(!r.rowCount)return res.json({success:false,error:'Order পাওয়া যায়নি'});
    res.json({success:true,order:r.rows[0]});
  }catch(e){
    console.error('Smart Order status error:',e.message);
    res.json({success:false,error:e.message});
  }
});
