const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yhspipyrgdcdfqqxxges.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || 'sb_publishable_IcyDHTLjyPPspvcgnYZZiw_q1lUn8QW';

async function getAuthenticatedUser(req) {
  const auth = String(req.headers.authorization || '');
  if (!auth.startsWith('Bearer ') || !SUPABASE_ANON_KEY) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  try {
    const r = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token }
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (err) {
    console.error('Supabase auth validation error:', err.message);
    return null;
  }
}

async function getAgentAccess(userId, agentId, marketplaceAgentId) {
  if (!userId || !agentId) return { allowed: false };
  const owner = await pool.query(
    'SELECT id FROM user_agents WHERE id = $1 AND owner_user_id = $2 LIMIT 1',
    [String(agentId), String(userId)]
  );
  if (owner.rows[0]) return { allowed: true, role: 'owner', marketplaceAgentId: null, subscriptionId: null };

  const admin = await pool.query('SELECT user_id FROM platform_admins WHERE user_id = $1 LIMIT 1', [String(userId)]);
  if (admin.rows[0] && marketplaceAgentId) {
    return { allowed: true, role: 'admin', marketplaceAgentId: String(marketplaceAgentId), subscriptionId: null };
  }

  if (!marketplaceAgentId) return { allowed: false };
  const result = await pool.query(
    `SELECT s.id AS subscription_id, s.status, s.access_source, s.access_expires_at,
            s.marketplace_agent_id, a.owner_user_id, a.agent_id, a.monthly_price
       FROM marketplace_subscriptions s
       JOIN marketplace_agents a ON a.id = s.marketplace_agent_id
      WHERE s.buyer_user_id = $1
        AND s.marketplace_agent_id = $2
        AND (
          s.status = 'active'
          OR s.status = 'free'
          OR (s.status = 'admin_granted' AND (s.access_expires_at IS NULL OR s.access_expires_at > now()))
        )
      ORDER BY s.created_at DESC
      LIMIT 1`,
    [String(userId), String(marketplaceAgentId)]
  );
  if (result.rows[0]) {
    const row = result.rows[0];
    return {
      allowed: true,
      role: row.status === 'admin_granted' ? 'admin_granted' : 'customer',
      marketplaceAgentId: String(row.marketplace_agent_id),
      subscriptionId: row.subscription_id ? String(row.subscription_id) : null,
      sellerUserId: String(row.owner_user_id)
    };
  }
  return { allowed: false };
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function isFacebookEventProcessed(eventId) {
  if (!eventId) return false;
  try {
    const result = await pool.query(
      `INSERT INTO facebook_events (event_id) VALUES ($1)
       ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [String(eventId)]
    );
    return result.rowCount === 0;
  } catch (err) {
    console.error('Facebook event de-duplication error:', err.message);
    return false;
  }
}

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS telegram_bots (
        bot_token TEXT PRIMARY KEY,
        system_prompt TEXT NOT NULL,
        agent_id TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS agent_knowledge (
        id SERIAL PRIMARY KEY,
        agent_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        agent_id TEXT,
        customer_name TEXT,
        customer_address TEXT,
        customer_phone TEXT,
        order_details TEXT,
        chat_id TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS facebook_pages (
        page_id TEXT PRIMARY KEY,
        page_access_token TEXT NOT NULL,
        system_prompt TEXT NOT NULL,
        agent_id TEXT,
        customer_user_id UUID,
        marketplace_agent_id UUID,
        subscription_id UUID,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS facebook_events (
        event_id TEXT PRIMARY KEY,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id SERIAL PRIMARY KEY,
        platform TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        agent_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`ALTER TABLE telegram_bots ADD COLUMN IF NOT EXISTS agent_id TEXT`);
    await pool.query(`ALTER TABLE facebook_pages ADD COLUMN IF NOT EXISTS customer_user_id UUID`);
    await pool.query(`ALTER TABLE telegram_bots ADD COLUMN IF NOT EXISTS customer_user_id UUID`);
    await pool.query(`ALTER TABLE telegram_bots ADD COLUMN IF NOT EXISTS marketplace_agent_id UUID`);
    await pool.query(`ALTER TABLE telegram_bots ADD COLUMN IF NOT EXISTS subscription_id UUID`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_telegram_bots_customer_agent ON telegram_bots(customer_user_id, agent_id)`);
    await pool.query(`ALTER TABLE facebook_pages ADD COLUMN IF NOT EXISTS marketplace_agent_id UUID`);
    await pool.query(`ALTER TABLE facebook_pages ADD COLUMN IF NOT EXISTS subscription_id UUID`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_facebook_pages_customer_agent ON facebook_pages(customer_user_id, agent_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_facebook_events_created_at ON facebook_events(created_at)`);
    console.log('✓ Database ready');
  } catch (err) {
    console.error('Database init error:', err.message);
  }
}

async function getKnowledgeText(agentId) {
  if (!agentId) return '';
  try {
    const result = await pool.query(
      "SELECT content FROM agent_knowledge WHERE agent_id = $1 ORDER BY created_at ASC",
      [agentId]
    );
    if (result.rows.length === 0) return '';
    const points = result.rows.map(r => `- ${r.content}`).join('\n');
    return `\n\nনিচের তথ্যগুলো ব্যবহার করে উত্তর দাও (Knowledge Base):\n${points}\n\nযদি কোনো Knowledge Base তথ্যে ছবির লিংক (URL) থাকে এবং গ্রাহক সেই পণ্যের ছবি দেখতে চায়, তাহলে তোমার উত্তরের একদম শেষে এই ফরম্যাটে লিখো: [IMAGE: ছবির-লিংক]। এই ট্যাগ শুধু তখনই ব্যবহার করবে যখন গ্রাহক সত্যিই ছবি দেখতে চেয়েছে বা ছবি দেখানো প্রাসঙ্গিক।`;
  } catch (err) {
    console.error('getKnowledgeText error:', err.message);
    return '';
  }
}

async function saveChatMessage(platform, chatId, agentId, role, content) {
  try {
    await pool.query(
      "INSERT INTO chat_messages (platform, chat_id, agent_id, role, content) VALUES ($1, $2, $3, $4, $5)",
      [platform, String(chatId), agentId, role, content]
    );
  } catch (err) {
    console.error('saveChatMessage error:', err.message);
  }
}

async function loadChatHistory(platform, chatId) {
  try {
    const result = await pool.query(
      "SELECT role, content FROM chat_messages WHERE platform = $1 AND chat_id = $2 ORDER BY created_at ASC LIMIT 20",
      [platform, String(chatId)]
    );
    return result.rows.map(r => ({ role: r.role, parts: [{ text: r.content }] }));
  } catch (err) {
    console.error('loadChatHistory error:', err.message);
    return [];
  }
}

app.post("/knowledge/add", async (req, res) => {
  const { agentId, content } = req.body;
  if (!agentId || !content) return res.status(400).json({ success: false, error: "agentId ও content প্রয়োজন" });
  const user = await getAuthenticatedUser(req);
  if (!user?.id) return res.status(401).json({ success: false, error: "Login required" });
  try {
    const access = await getAgentAccess(user.id, agentId, req.body.marketplaceAgentId || null);
    if (!access.allowed) return res.status(403).json({ success: false, error: "Agent access denied" });
    await pool.query("INSERT INTO agent_knowledge (agent_id, content) VALUES ($1, $2)", [String(agentId), content]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/knowledge/delete", async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ success: false, error: "id প্রয়োজন" });
  const user = await getAuthenticatedUser(req);
  if (!user?.id) return res.status(401).json({ success: false, error: "Login required" });
  try {
    const row = await pool.query("SELECT agent_id FROM agent_knowledge WHERE id = $1 LIMIT 1", [id]);
    if (!row.rows[0]) return res.status(404).json({ success: false, error: "Knowledge not found" });
    const access = await getAgentAccess(user.id, row.rows[0].agent_id, req.body.marketplaceAgentId || null);
    if (!access.allowed) return res.status(403).json({ success: false, error: "Agent access denied" });
    await pool.query("DELETE FROM agent_knowledge WHERE id = $1", [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/knowledge/list/:agentId", async (req, res) => {
  const user = await getAuthenticatedUser(req);
  if (!user?.id) return res.status(401).json({ error: "Login required" });
  try {
    const access = await getAgentAccess(user.id, req.params.agentId, req.query.marketplaceAgentId || null);
    if (!access.allowed) return res.status(403).json({ error: "Agent access denied" });
    const result = await pool.query(
      "SELECT id, content, created_at FROM agent_knowledge WHERE agent_id = $1 ORDER BY created_at DESC",
      [req.params.agentId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function extractOrderInfo(historyArr) {
  const API_KEY = process.env.GEMINI_API_KEY;
  const extractPrompt = `তুমি একটা তথ্য বের করার টুল। নিচের কথোপকথন থেকে গ্রাহকের অর্ডার তথ্য (নাম, ঠিকানা, ফোন) বের করো।

কড়া নিয়ম: তোমার উত্তর অবশ্যই শুধুমাত্র একটা valid JSON object হতে হবে। কোনো ব্যাখ্যা, ভূমিকা, মন্তব্য বা মার্কডাউন লিখবে না। শুধু নিচের যেকোনো একটা ফরম্যাট, আর কিছু না:

তথ্য সম্পূর্ণ থাকলে:
{"complete": true, "customer_name": "নাম", "customer_address": "ঠিকানা", "customer_phone": "ফোন", "order_details": "সংক্ষিপ্ত বিবরণ"}

তথ্য অসম্পূর্ণ বা অর্ডার না থাকলে:
{"complete": false}`;

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: extractPrompt }] },
        contents: Array.isArray(historyArr) ? historyArr : [],
        generationConfig: { responseMimeType: "application/json" }
      })
    });
    const data = await res.json();
    let text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{"complete": false}';
    text = text.replace(/```json|```/g, '').trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { complete: false };
    return JSON.parse(match[0]);
  } catch (err) {
    console.error('extractOrderInfo error:', err.message);
    return { complete: false };
  }
}

async function saveOrderAndNotify(agentId, chatId, orderInfo, notifyPlatform, notifyToken) {
  try {
    await pool.query(
      `INSERT INTO orders (agent_id, customer_name, customer_address, customer_phone, order_details, chat_id) VALUES ($1, $2, $3, $4, $5, $6)`,
      [agentId, orderInfo.customer_name, orderInfo.customer_address, orderInfo.customer_phone, orderInfo.order_details, String(chatId)]
    );
    const notifyText = `🛒 নতুন অর্ডার এসেছে! (${notifyPlatform})\n\n👤 নাম: ${orderInfo.customer_name}\n📍 ঠিকানা: ${orderInfo.customer_address}\n📞 ফোন: ${orderInfo.customer_phone}\n📦 বিবরণ: ${orderInfo.order_details}`;
    const myChatId = process.env.MY_TELEGRAM_CHAT_ID;
    if (myChatId && notifyToken) {
      await fetch(`https://api.telegram.org/bot${notifyToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: myChatId, text: notifyText })
      });
    }
  } catch (err) {
    console.error('saveOrderAndNotify error:', err.message);
  }
}

async function notifyOwnerViaAnyTelegramBot(text) {
  try {
    const myChatId = process.env.MY_TELEGRAM_CHAT_ID;
    if (!myChatId) return;
    const result = await pool.query("SELECT bot_token FROM telegram_bots LIMIT 1");
    const anyToken = result.rows[0]?.bot_token;
    if (!anyToken) return;
    await fetch(`https://api.telegram.org/bot${anyToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: myChatId, text })
    });
  } catch (err) {
    console.error('notifyOwnerViaAnyTelegramBot error:', err.message);
  }
}

async function requirePlatformAdmin(req){
  const user = await getAuthenticatedUser(req);
  if(!user?.id) return {ok:false,status:401,error:'Login required'};
  const result = await pool.query('SELECT user_id, role FROM platform_admins WHERE user_id = $1 LIMIT 1',[String(user.id)]);
  if(!result.rows[0]) return {ok:false,status:403,error:'Platform admin permission required'};
  return {ok:true,user,admin:result.rows[0]};
}

app.get("/admin/marketplace/access", async (req,res)=>{
  const auth=await requirePlatformAdmin(req);
  if(!auth.ok) return res.status(auth.status).json({error:auth.error});
  try{
    const r=await pool.query(`SELECT s.id,s.marketplace_agent_id,s.buyer_user_id,s.status,s.monthly_price,
      s.platform_fee,s.seller_amount,s.access_source,s.access_granted_by,s.access_expires_at,
      s.started_at,s.current_period_end,s.activated_at,a.name AS agent_name
      FROM marketplace_subscriptions s
      JOIN marketplace_agents a ON a.id=s.marketplace_agent_id
      ORDER BY s.created_at DESC LIMIT 500`);
    res.json({success:true,access:r.rows});
  }catch(err){res.status(500).json({success:false,error:err.message});}
});

app.post("/admin/marketplace/access/grant", async (req,res)=>{
  const auth=await requirePlatformAdmin(req);
  if(!auth.ok) return res.status(auth.status).json({error:auth.error});
  const {buyerUserId,marketplaceAgentId,expiresAt}=req.body||{};
  if(!buyerUserId||!marketplaceAgentId) return res.status(400).json({success:false,error:'buyerUserId ও marketplaceAgentId প্রয়োজন'});
  try{
    const agent=await pool.query('SELECT id,owner_user_id,monthly_price FROM marketplace_agents WHERE id=$1 AND status=\'published\' LIMIT 1',[String(marketplaceAgentId)]);
    if(!agent.rows[0]) return res.status(404).json({success:false,error:'Published marketplace agent not found'});
    const price=Number(agent.rows[0].monthly_price||0);
    const existing=await pool.query(`SELECT id FROM marketplace_subscriptions
      WHERE buyer_user_id=$1 AND marketplace_agent_id=$2 AND status IN ('active','admin_granted','free')
      ORDER BY created_at DESC LIMIT 1`,[String(buyerUserId),String(marketplaceAgentId)]);
    if(existing.rows[0]){
      await pool.query(`UPDATE marketplace_subscriptions SET status='admin_granted',access_source='admin_grant',
        access_granted_by=$1,access_expires_at=$2,activated_at=COALESCE(activated_at,now()),
        started_at=COALESCE(started_at,now()),current_period_end=$2
        WHERE id=$3`,[String(auth.user.id),expiresAt||null,String(existing.rows[0].id)]);
    }else{
      await pool.query(`INSERT INTO marketplace_subscriptions
        (marketplace_agent_id,buyer_user_id,status,monthly_price,platform_fee,seller_amount,
         marketplace_agent_owner_user_id,access_source,access_granted_by,access_expires_at,started_at,
         current_period_end,activated_at)
        VALUES($1,$2,'admin_granted',$3,0,0,$4,'admin_grant',$5,$6,now(),$6,now())`,
        [String(marketplaceAgentId),String(buyerUserId),price,String(agent.rows[0].owner_user_id),String(auth.user.id),expiresAt||null]);
    }
    res.json({success:true,message:'Agent access granted',expiresAt:expiresAt||null});
  }catch(err){res.status(500).json({success:false,error:err.message});}
});

app.post("/admin/marketplace/access/revoke", async (req,res)=>{
  const auth=await requirePlatformAdmin(req);
  if(!auth.ok) return res.status(auth.status).json({error:auth.error});
  const {subscriptionId}=req.body||{};
  if(!subscriptionId) return res.status(400).json({success:false,error:'subscriptionId প্রয়োজন'});
  try{
    const r=await pool.query(`UPDATE marketplace_subscriptions
      SET status='cancelled',access_expires_at=now()
      WHERE id=$1 AND access_source='admin_grant'
      RETURNING id`,[String(subscriptionId)]);
    if(!r.rows[0]) return res.status(404).json({success:false,error:'Admin-granted access not found'});
    res.json({success:true,message:'Agent access revoked'});
  }catch(err){res.status(500).json({success:false,error:err.message});}
});

app.get("/orders/list", async (req, res) => {
  const user = await getAuthenticatedUser(req);
  if (!user?.id) return res.status(401).json({ error: "Login required" });
  try {
    const result = await pool.query(
      `SELECT o.* FROM orders o
       WHERE EXISTS (
         SELECT 1 FROM user_agents ua
         WHERE ua.id = o.agent_id AND ua.owner_user_id = $1
       )
       OR EXISTS (
         SELECT 1 FROM marketplace_agents ma
         WHERE ma.agent_id = o.agent_id AND ma.owner_user_id = $1
       )
       ORDER BY o.created_at DESC`,
      [String(user.id)]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/chat", async (req, res) => {
  const { message, systemPrompt, history, agentId } = req.body;
  const API_KEY = process.env.GEMINI_API_KEY;

  if (!API_KEY) {
    return res.json({ reply: "Error: API Key সেট করা নেই।" });
  }

  try {
    const knowledgeText = await getKnowledgeText(agentId);
    const fullPrompt = (systemPrompt || "তুমি একজন সহকারী।") + knowledgeText;

    // Gemini requires a non-empty contents array. Some older clients send no history on the first message.
    const safeHistory = Array.isArray(history)
      ? history.filter(item => item && typeof item === 'object' && Array.isArray(item.parts) && item.parts.length > 0)
      : [];

    if (message && message.trim()) {
      const last = safeHistory[safeHistory.length - 1];
      const lastText = last?.parts?.[0]?.text;
      if (!last || last.role !== 'user' || lastText !== message.trim()) {
        safeHistory.push({ role: "user", parts: [{ text: message.trim() }] });
      }
    }

    if (safeHistory.length === 0) {
      return res.status(400).json({ reply: "বার্তা পাওয়া যায়নি। আবার চেষ্টা করুন।" });
    }

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: fullPrompt }] },
        contents: safeHistory
      })
    });

    const data = await response.json();
    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || data?.error?.message || "দুঃখিত, কোনো উত্তর পাওয়া যায়নি।";
    res.json({ reply });
  } catch (err) {
    res.json({ reply: "সার্ভার এরর: " + err.message });
  }
});

const telegramBots = {};

app.post("/telegram/connect", async (req, res) => {
  const { botToken, systemPrompt, agentId, marketplaceAgentId } = req.body;
  if (!botToken || !agentId) return res.json({ success: false, error: "Bot token ও agentId প্রয়োজন" });

  const user = await getAuthenticatedUser(req);
  if (!user?.id) return res.status(401).json({ success: false, error: "Login required." });

  try {
    const access = await getAgentAccess(user.id, agentId, marketplaceAgentId);
    if (!access.allowed) return res.status(403).json({ success: false, error: "এই Agent আপনার account-এর জন্য authorized নয়। Agentটি কিনে/activate করে আবার চেষ্টা করুন।" });

    const prompt = systemPrompt || "তুমি একজন সহকারী।";
    telegramBots[botToken] = {
      systemPrompt: prompt,
      agentId: String(agentId),
      customerUserId: String(user.id),
      marketplaceAgentId: access.marketplaceAgentId,
      subscriptionId: access.subscriptionId,
      histories: {},
      orderSaved: {}
    };

    const webhookUrl = `https://kajim-ai-agent-backend.onrender.com/telegram/webhook/${botToken}`;
    const setResp = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
    const setData = await setResp.json();
    if (!setData.ok) return res.json({ success: false, error: setData.description || "Webhook সেট করা যায়নি" });

    await pool.query(
      `INSERT INTO telegram_bots (bot_token, system_prompt, agent_id, customer_user_id, marketplace_agent_id, subscription_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (bot_token) DO UPDATE SET
       system_prompt = EXCLUDED.system_prompt,
       agent_id = EXCLUDED.agent_id,
       customer_user_id = EXCLUDED.customer_user_id,
       marketplace_agent_id = EXCLUDED.marketplace_agent_id,
       subscription_id = EXCLUDED.subscription_id`,
      [botToken, prompt, String(agentId), String(user.id), access.marketplaceAgentId, access.subscriptionId]
    );
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get("/telegram/bots/:agentId", async (req, res) => {
  const user = await getAuthenticatedUser(req);
  if (!user?.id) return res.status(401).json({ success: false, error: "Login required." });
  const agentId = String(req.params.agentId || '');
  try {
    const access = await getAgentAccess(user.id, agentId, req.query.marketplaceAgentId || null);
    if (!access.allowed) return res.status(403).json({ success: false, error: "Agent access denied." });
    const result = await pool.query(
      `SELECT bot_token, agent_id, marketplace_agent_id, created_at
       FROM telegram_bots
       WHERE customer_user_id = $1 AND agent_id = $2
       ORDER BY created_at DESC`,
      [String(user.id), agentId]
    );
    res.json({ success: true, bots: result.rows.map(r => ({ bot_token: r.bot_token, agent_id: r.agent_id, marketplace_agent_id: r.marketplace_agent_id, created_at: r.created_at })) });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.post("/telegram/disconnect", async (req, res) => {
  const { botToken, agentId } = req.body;
  const user = await getAuthenticatedUser(req);
  if (!user?.id) return res.status(401).json({ success: false, error: "Login required." });
  if (!botToken || !agentId) return res.json({ success: false, error: "botToken ও agentId প্রয়োজন" });
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/deleteWebhook?drop_pending_updates=false`).catch(() => {});
    const result = await pool.query(
      'DELETE FROM telegram_bots WHERE bot_token = $1 AND agent_id = $2 AND customer_user_id = $3 RETURNING bot_token',
      [String(botToken), String(agentId), String(user.id)]
    );
    delete telegramBots[String(botToken)];
    res.json({ success: true, disconnected: result.rowCount > 0 });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

async function getTelegramFileBase64(token, fileId) {
  try {
    const fileRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
    const fileData = await fileRes.json();
    const filePath = fileData?.result?.file_path;
    if (!filePath) return null;
    const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
    const fileBuffer = await fetch(fileUrl).then(r => r.arrayBuffer());
    return Buffer.from(fileBuffer).toString('base64');
  } catch (err) {
    console.error('getTelegramFileBase64 error:', err.message);
    return null;
  }
}

app.post("/telegram/webhook/:token", async (req, res) => {
  const token = req.params.token;
  const bot = telegramBots[token];
  res.sendStatus(200);
  if (!bot) return;
  const update = req.body;
  const chatId = update?.message?.chat?.id;
  if (!chatId) return;
  const textMsg = update?.message?.text;
  const photo = update?.message?.photo;
  const voice = update?.message?.voice;
  if (!textMsg && !photo && !voice) return;
  let userParts = [];
  let text = textMsg || '';
  try {
    if (photo && photo.length > 0) {
      const largestPhoto = photo[photo.length - 1];
      const base64 = await getTelegramFileBase64(token, largestPhoto.file_id);
      if (base64) {
        userParts.push({ inline_data: { mime_type: "image/jpeg", data: base64 } });
        text = textMsg || 'এই ছবিটা দেখে সাহায্য করো।';
      }
    } else if (voice) {
      const base64 = await getTelegramFileBase64(token, voice.file_id);
      if (base64) {
        userParts.push({ inline_data: { mime_type: "audio/ogg", data: base64 } });
        text = 'এই ভয়েস মেসেজটা শুনে উত্তর দাও।';
      }
    }
  } catch (err) {
    console.error('File processing error:', err.message);
  }
  userParts.push({ text });
  if (!bot.histories[chatId]) bot.histories[chatId] = await loadChatHistory('telegram', chatId);
  bot.histories[chatId].push({ role: "user", parts: userParts });
  await saveChatMessage('telegram', chatId, bot.agentId, 'user', text);
  const API_KEY = process.env.GEMINI_API_KEY;
  try {
    const knowledgeText = await getKnowledgeText(bot.agentId);
    const fullPrompt = bot.systemPrompt + knowledgeText;
    const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system_instruction: { parts: [{ text: fullPrompt }] }, contents: bot.histories[chatId] })
    });
    const data = await geminiRes.json();
    let reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || "দুঃখিত, উত্তর তৈরি করা যায়নি।";
    bot.histories[chatId].push({ role: "model", parts: [{ text: reply }] });
    if (bot.histories[chatId].length > 20) bot.histories[chatId] = bot.histories[chatId].slice(-20);
    await saveChatMessage('telegram', chatId, bot.agentId, 'model', reply);
    const imageMatch = reply.match(/\[IMAGE:\s*(https?:\/\/[^\]\s]+)\]/);
    let imageUrl = null;
    if (imageMatch) { imageUrl = imageMatch[1]; reply = reply.replace(imageMatch[0], '').trim(); }
    if (imageUrl) {
      await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, photo: imageUrl, caption: reply }) });
    } else {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text: reply }) });
    }
    const banglaToEnglishDigits = text.replace(/[০-৯]/g, d => '০১২৩৪৫৬৭৮৯'.indexOf(d));
    const cleanedText = banglaToEnglishDigits.replace(/[\s-]/g, '');
    const hasPhoneNumber = /\d{10,11}/.test(cleanedText);
    if (!bot.orderSaved[chatId] && hasPhoneNumber) {
      const orderInfo = await extractOrderInfo(bot.histories[chatId]);
      if (orderInfo.complete) {
        bot.orderSaved[chatId] = true;
        await saveOrderAndNotify(bot.agentId, chatId, orderInfo, 'Telegram', token);
      }
    }
  } catch (err) {
    console.error("Telegram bot error:", err.message);
  }
});

app.get("/telegram/list", async (req, res) => {
  try {
    const result = await pool.query("SELECT bot_token, system_prompt, agent_id, created_at FROM telegram_bots ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (err) {
    res.json({ error: err.message });
  }
});

const facebookPages = {};

app.post("/facebook/connect", async (req, res) => {
  const { pageId, pageAccessToken, systemPrompt, agentId, marketplaceAgentId } = req.body;
  if (!pageId || !pageAccessToken || !agentId) return res.json({ success: false, error: "pageId, pageAccessToken ও agentId প্রয়োজন" });
  const user = await getAuthenticatedUser(req);
  if (!user?.id) return res.status(401).json({ success: false, error: "Login required." });
  try {
    const access = await getAgentAccess(user.id, agentId, marketplaceAgentId);
    if (!access.allowed) return res.status(403).json({ success: false, error: "এই Agent আপনার account-এর জন্য authorized নয়। Agentটি কিনে/activate করে আবার চেষ্টা করুন।" });
    const prompt = systemPrompt || "তুমি একজন সহকারী।";
    facebookPages[pageId] = { pageAccessToken, systemPrompt: prompt, agentId: String(agentId), customerUserId: String(user.id), marketplaceAgentId: access.marketplaceAgentId, subscriptionId: access.subscriptionId, histories: {}, orderSaved: {} };
    await pool.query(
      "INSERT INTO facebook_pages (page_id, page_access_token, system_prompt, agent_id, customer_user_id, marketplace_agent_id, subscription_id) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (page_id) DO UPDATE SET page_access_token = EXCLUDED.page_access_token, system_prompt = EXCLUDED.system_prompt, agent_id = EXCLUDED.agent_id, customer_user_id = EXCLUDED.customer_user_id, marketplace_agent_id = EXCLUDED.marketplace_agent_id, subscription_id = EXCLUDED.subscription_id",
      [pageId, pageAccessToken, prompt, String(agentId), String(user.id), access.marketplaceAgentId, access.subscriptionId]
    );
    const count = await pool.query("SELECT COUNT(*)::int AS count FROM facebook_pages WHERE customer_user_id = $1 AND agent_id = $2", [String(user.id), String(agentId)]);
    res.json({ success: true, connectedPages: count.rows[0]?.count || 1 });
  } catch (err) {
    console.error("Facebook connect error:", err.message);
    res.json({ success: false, error: err.message });
  }
});

app.get("/facebook/pages/:agentId", async (req, res) => {
  const user = await getAuthenticatedUser(req);
  if (!user?.id) return res.status(401).json({ success: false, error: "Login required." });
  const agentId = String(req.params.agentId || '');
  try {
    const access = await getAgentAccess(user.id, agentId, req.query.marketplaceAgentId || null);
    if (!access.allowed) return res.status(403).json({ success: false, error: "Agent access denied." });
    const result = await pool.query("SELECT page_id, agent_id, marketplace_agent_id, created_at FROM facebook_pages WHERE customer_user_id = $1 AND agent_id = $2 ORDER BY created_at DESC", [String(user.id), agentId]);
    res.json({ success: true, pages: result.rows });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.post("/facebook/disconnect", async (req, res) => {
  const { pageId, agentId } = req.body;
  const user = await getAuthenticatedUser(req);
  if (!user?.id) return res.status(401).json({ success: false, error: "Login required." });
  if (!pageId || !agentId) return res.json({ success: false, error: "pageId ও agentId প্রয়োজন" });
  try {
    const result = await pool.query("DELETE FROM facebook_pages WHERE page_id = $1 AND agent_id = $2 AND customer_user_id = $3 RETURNING page_id", [String(pageId), String(agentId), String(user.id)]);
    delete facebookPages[String(pageId)];
    res.json({ success: true, disconnected: result.rowCount > 0 });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

async function getUrlAsBase64(url) {
  try {
    const fileBuffer = await fetch(url).then(r => r.arrayBuffer());
    return Buffer.from(fileBuffer).toString('base64');
  } catch (err) {
    console.error('getUrlAsBase64 error:', err.message);
    return null;
  }
}

async function getFacebookPage(pageId) {
  if (facebookPages[pageId]) return facebookPages[pageId];
  try {
    const result = await pool.query(
      "SELECT page_id, page_access_token, system_prompt, agent_id FROM facebook_pages WHERE page_id = $1 LIMIT 1",
      [String(pageId)]
    );
    const row = result.rows[0];
    if (!row) return null;
    facebookPages[row.page_id] = {
      pageAccessToken: row.page_access_token,
      systemPrompt: row.system_prompt,
      agentId: row.agent_id,
      histories: {},
      orderSaved: {}
    };
    return facebookPages[row.page_id];
  } catch (err) {
    console.error('getFacebookPage error:', err.message);
    return null;
  }
}

async function sendFacebookMessage(page, senderId, message) {
  const graphVersion = process.env.FB_GRAPH_VERSION || 'v26.0';
  const url = `https://graph.facebook.com/${graphVersion}/me/messages?access_token=${page.pageAccessToken}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { id: senderId }, message })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    throw new Error(`Facebook send failed: ${data?.error?.message || response.statusText}`);
  }
  return data;
}

app.get("/webhook/facebook", (req, res) => {
  const mode = String(req.query["hub.mode"] || "");
  const token = String(req.query["hub.verify_token"] || "");
  const challenge = String(req.query["hub.challenge"] || "");
  const expected = String(process.env.FB_VERIFY_TOKEN || process.env.META_VERIFY_TOKEN || "");
  console.log(`Facebook webhook verification request: mode=${mode}, token=${token ? "provided" : "missing"}`);
  if (mode === "subscribe" && expected && token === expected) {
    console.log("✓ Facebook webhook verification successful");
    return res.status(200).send(challenge);
  }
  console.error("Facebook webhook verification failed: verify token mismatch or FB_VERIFY_TOKEN not configured");
  return res.sendStatus(403);
});

async function facebookWebhookHandler(req, res) {
  res.sendStatus(200);
  const body = req.body;
  console.log(`Facebook webhook delivery received: object=${body?.object || "unknown"}, entries=${Array.isArray(body?.entry) ? body.entry.length : 0}`);
  if (!body || body.object !== 'page' || !Array.isArray(body.entry)) return;
  for (const entry of body.entry) {
    const pageId = entry?.id;
    if (!pageId || !Array.isArray(entry.messaging)) continue;
    const page = await getFacebookPage(pageId);
    if (!page) {
      console.warn(`Facebook Page not connected: ${pageId}`);
      continue;
    }
    for (const event of entry.messaging) {
      const senderId = event?.sender?.id;
      const eventId = event?.message?.mid || event?.postback?.mid || event?.message?.metadata;
      const textMsg = event?.message?.text;
      const attachments = event?.message?.attachments;
      if (!senderId) continue;
      if (!textMsg && !attachments) continue;
      if (eventId && await isFacebookEventProcessed(eventId)) {
        console.log(`Skipping duplicate Facebook event: ${eventId}`);
        continue;
      }
      let userParts = [];
      let text = textMsg || '';
      try {
        if (attachments && attachments.length > 0) {
          const att = attachments[0];
          const attachmentUrl = att?.payload?.url;
          if (att.type === 'image' && attachmentUrl) {
            const base64 = await getUrlAsBase64(attachmentUrl);
            if (base64) {
              userParts.push({ inline_data: { mime_type: "image/jpeg", data: base64 } });
              text = textMsg || 'এই ছবিটা দেখে সাহায্য করো।';
            }
          } else if (att.type === 'audio' && attachmentUrl) {
            const base64 = await getUrlAsBase64(attachmentUrl);
            if (base64) {
              userParts.push({ inline_data: { mime_type: "audio/mp4", data: base64 } });
              text = 'এই ভয়েস মেসেজটা শুনে উত্তর দাও।';
            }
          }
        }
      } catch (err) {
        console.error('FB attachment error:', err.message);
      }
      userParts.push({ text });
      if (!page.histories[senderId]) page.histories[senderId] = await loadChatHistory('facebook', senderId);
      page.histories[senderId].push({ role: "user", parts: userParts });
      await saveChatMessage('facebook', senderId, page.agentId, 'user', text);
      const API_KEY = process.env.GEMINI_API_KEY;
      if (!API_KEY) {
        console.error('Facebook bot error: GEMINI_API_KEY is not configured');
        continue;
      }
      try {
        const knowledgeText = await getKnowledgeText(page.agentId);
        const fullPrompt = page.systemPrompt + knowledgeText;
        const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: fullPrompt }] },
            contents: page.histories[senderId]
          })
        });
        const data = await geminiRes.json();
        if (!geminiRes.ok || data?.error) {
          throw new Error(`Gemini request failed: ${data?.error?.message || geminiRes.statusText}`);
        }
        let reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || "দুঃখিত, উত্তর তৈরি করা যায়নি।";
        page.histories[senderId].push({ role: "model", parts: [{ text: reply }] });
        if (page.histories[senderId].length > 20) page.histories[senderId] = page.histories[senderId].slice(-20);
        await saveChatMessage('facebook', senderId, page.agentId, 'model', reply);
        const imageMatch = reply.match(/\[IMAGE:\s*(https?:\/\/[^\]\s]+)\]/);
        let imageUrl = null;
        if (imageMatch) {
          imageUrl = imageMatch[1];
          reply = reply.replace(imageMatch[0], '').trim();
        }
        if (imageUrl) {
          await sendFacebookMessage(page, senderId, { attachment: { type: "image", payload: { url: imageUrl, is_reusable: true } } });
          if (reply) await sendFacebookMessage(page, senderId, { text: reply });
        } else {
          await sendFacebookMessage(page, senderId, { text: reply });
        }
        const banglaToEnglishDigits = text.replace(/[০-৯]/g, d => '০১২৩৪৫৬৭৮৯'.indexOf(d));
        const cleanedText = banglaToEnglishDigits.replace(/[\s-]/g, '');
        const hasPhoneNumber = /\d{10,11}/.test(cleanedText);
        if (!page.orderSaved[senderId] && hasPhoneNumber) {
          const orderInfo = await extractOrderInfo(page.histories[senderId]);
          if (orderInfo.complete) {
            page.orderSaved[senderId] = true;
            await saveOrderAndNotify(page.agentId, senderId, orderInfo, 'Facebook Messenger', null);
            await notifyOwnerViaAnyTelegramBot(`🛒 নতুন অর্ডার এসেছে! (Facebook Messenger)\n\n👤 নাম: ${orderInfo.customer_name}\n📍 ঠিকানা: ${orderInfo.customer_address}\n📞 ফোন: ${orderInfo.customer_phone}\n📦 বিবরণ: ${orderInfo.order_details}`);
          }
        }
      } catch (err) {
        console.error("Facebook bot error:", err.message);
      }
    }
  }
}

// Register both callback paths directly on the real Express app.
// Meta is currently configured for /webhook; /webhook/facebook remains supported.
app.post("/webhook", facebookWebhookHandler);
app.post("/webhook/facebook", facebookWebhookHandler);

app.get("/facebook/list", async (req, res) => {
  try {
    const result = await pool.query("SELECT page_id, system_prompt, agent_id, created_at FROM facebook_pages ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (err) {
    res.json({ error: err.message });
  }
});

async function restoreBots() {
  try {
    const result = await pool.query("SELECT bot_token, system_prompt, agent_id FROM telegram_bots");
    for (const row of result.rows) {
      telegramBots[row.bot_token] = { systemPrompt: row.system_prompt, agentId: row.agent_id, histories: {}, orderSaved: {} };
      const webhookUrl = `https://kajim-ai-agent-backend.onrender.com/telegram/webhook/${row.bot_token}`;
      await fetch(`https://api.telegram.org/bot${row.bot_token}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
    }
    console.log(`✓ ${result.rows.length} টা bot auto-reconnect হয়েছে`);
    const fbResult = await pool.query("SELECT page_id, page_access_token, system_prompt, agent_id FROM facebook_pages");
    for (const row of fbResult.rows) {
      facebookPages[row.page_id] = {
        pageAccessToken: row.page_access_token,
        systemPrompt: row.system_prompt,
        agentId: row.agent_id,
        customerUserId: row.customer_user_id || null,
        marketplaceAgentId: row.marketplace_agent_id || null,
        subscriptionId: row.subscription_id || null,
        histories: {},
        orderSaved: {}
      };
    }
    console.log(`✓ ${fbResult.rows.length} টা Facebook Page লোড হয়েছে`);
  } catch (err) {
    console.error('Restore bots error:', err.message);
  }
}

app.listen(port, async () => {
  console.log(`Server running on port ${port}`);
  await initDB();
  await restoreBots();
});
