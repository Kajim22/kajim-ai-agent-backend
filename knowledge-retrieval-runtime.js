// Runtime bridge for relevant Knowledge retrieval.
// Keeps the existing server.js Telegram/Facebook/chat flows intact while replacing
// the old full Knowledge Base prompt with agent-scoped relevant context.
const express = require('express');
const { Pool } = require('pg');
const { AsyncLocalStorage } = require('node:async_hooks');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const context = new AsyncLocalStorage();
const originalPost = express.application.post;
const originalFetch = global.fetch;
let patched = false;

function clean(value, max = 5000) {
  return String(value ?? '').trim().slice(0, max);
}

function userTextFromContents(contents) {
  if (!Array.isArray(contents)) return '';
  for (let i = contents.length - 1; i >= 0; i--) {
    if (contents[i]?.role !== 'user') continue;
    const parts = Array.isArray(contents[i]?.parts) ? contents[i].parts : [];
    const text = parts.map(p => p?.text || '').filter(Boolean).join(' ').trim();
    if (text) return text;
  }
  return '';
}

function tokenize(text) {
  return clean(text, 2000)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2)
    .slice(0, 24);
}

async function getRelevantKnowledge(agentId, query, limit = 6) {
  if (!agentId || !query) return [];
  const tokens = tokenize(query);
  if (!tokens.length) return [];
  try {
    const conditions = [];
    const params = [agentId];
    tokens.forEach((token, index) => {
      const p = `%${token}%`;
      params.push(p);
      const n = index + 2;
      conditions.push(`(COALESCE(title,'') ILIKE $${n} OR COALESCE(question,'') ILIKE $${n} OR COALESCE(answer,'') ILIKE $${n} OR content ILIKE $${n} OR COALESCE(source_url,'') ILIKE $${n})`);
    });
    const sql = `SELECT id, title, question, answer, content, source_type, source_url
                 FROM agent_knowledge
                 WHERE agent_id=$1 AND (${conditions.join(' OR ')})
                 ORDER BY created_at DESC LIMIT 100`;
    const result = await pool.query(sql, params);
    const scored = result.rows.map(row => {
      const haystack = [row.title, row.question, row.answer, row.content, row.source_url]
        .filter(Boolean).join(' ').toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (haystack.includes(token)) score += 1;
        if (String(row.title || '').toLowerCase().includes(token)) score += 2;
        if (String(row.question || '').toLowerCase().includes(token)) score += 2;
      }
      return { row, score };
    });
    return scored.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(12, limit))).map(x => x.row);
  } catch (err) {
    console.error('Knowledge retrieval runtime error:', err.message);
    return [];
  }
}

function formatKnowledge(rows) {
  if (!rows.length) return '';
  const points = rows.map(row => {
    const title = row.title ? `【${row.title}】` : '';
    const question = row.question ? `\nপ্রশ্ন: ${row.question}` : '';
    const answer = row.answer || row.content || '';
    const source = row.source_url ? `\nSource: ${row.source_url}` : '';
    return `- ${title}${question}\nউত্তর/তথ্য: ${answer}${source}`.trim();
  }).join('\n');
  return `\n\nপ্রাসঙ্গিক Knowledge Base তথ্য (এই প্রশ্নের জন্য):\n${points}\n\nশুধু উপরের তথ্যের সাথে সম্পর্কিত তথ্য ব্যবহার করো। তথ্য না থাকলে অনুমান কোরো না। যদি কোনো Knowledge Base তথ্যে ছবির URL থাকে এবং গ্রাহক ছবিটি দেখতে চায় বা ছবি দেখানো প্রাসঙ্গিক হয়, উত্তরের শেষে [IMAGE: ছবির-লিংক] ব্যবহার করো।`;
}

function replaceOldKnowledge(prompt, relevantText) {
  const marker = '\n\nনিচের তথ্যগুলো ব্যবহার করে উত্তর দাও (Knowledge Base):';
  const index = prompt.indexOf(marker);
  if (index === -1) return prompt + relevantText;
  return prompt.slice(0, index) + relevantText;
}

async function resolveAgentId(req, routePath) {
  if (routePath === '/chat') return clean(req.body?.agentId, 200);
  if (routePath === '/telegram/webhook/:token') {
    const token = clean(req.params?.token, 500);
    if (!token) return '';
    const result = await pool.query('SELECT agent_id FROM telegram_bots WHERE bot_token=$1 LIMIT 1', [token]);
    return clean(result.rows[0]?.agent_id, 200);
  }
  if (routePath === '/webhook/facebook') {
    const pageId = clean(req.body?.entry?.[0]?.id, 200);
    if (!pageId) return '';
    const result = await pool.query('SELECT agent_id FROM facebook_pages WHERE page_id=$1 LIMIT 1', [pageId]);
    return clean(result.rows[0]?.agent_id, 200);
  }
  return '';
}

function patch() {
  if (patched) return;
  patched = true;

  express.application.post = function patchedPost(path, ...handlers) {
    const watched = path === '/chat' || path === '/telegram/webhook/:token' || path === '/webhook/facebook';
    if (!watched) return originalPost.call(this, path, ...handlers);
    const wrapped = handlers.map(handler => {
      if (typeof handler !== 'function') return handler;
      return function knowledgeContextMiddleware(req, res, next) {
        const run = async () => {
          try {
            const agentId = await resolveAgentId(req, path);
            return await context.run({ agentId, path }, () => handler.call(this, req, res, next));
          } catch (err) {
            console.error('Knowledge context setup error:', err.message);
            return handler.call(this, req, res, next);
          }
        };
        return run();
      };
    });
    return originalPost.call(this, path, ...wrapped);
  };

  global.fetch = async function knowledgeAwareFetch(url, options = {}) {
    const urlText = String(url || '');
    const isGemini = urlText.includes('generativelanguage.googleapis.com') && urlText.includes('generateContent');
    if (!isGemini || !options?.body) return originalFetch(url, options);

    const store = context.getStore();
    if (!store?.agentId) return originalFetch(url, options);

    try {
      const body = JSON.parse(String(options.body));
      const query = userTextFromContents(body.contents);
      const rows = await getRelevantKnowledge(store.agentId, query, 6);
      if (!rows.length) return originalFetch(url, options);

      const originalPrompt = body?.system_instruction?.parts?.[0]?.text || '';
      const relevantText = formatKnowledge(rows);
      body.system_instruction = { parts: [{ text: replaceOldKnowledge(originalPrompt, relevantText) }] };
      const nextOptions = { ...options, body: JSON.stringify(body) };
      console.log(`✓ Relevant Knowledge injected: agent=${store.agentId} items=${rows.length}`);
      return originalFetch(url, nextOptions);
    } catch (err) {
      console.error('Knowledge prompt injection error:', err.message);
      return originalFetch(url, options);
    }
  };
}

patch();
console.log('✓ Relevant Knowledge runtime enabled');
