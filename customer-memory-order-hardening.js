const { Pool } = require('pg');

// Production hardening: customer conversation data already lives in PostgreSQL.
// This module adds DB indexes and makes order creation idempotent across restarts.
// It does not alter the existing Messenger request/response flow.

async function applyHardening() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return;

  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
  try {
    await pool.query(`
      CREATE OR REPLACE FUNCTION prevent_duplicate_order() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtext(
          COALESCE(NEW.agent_id,'') || '|' || COALESCE(NEW.chat_id,'') || '|' ||
          COALESCE(NEW.customer_phone,'') || '|' || COALESCE(NEW.order_details,'')
        ));

        IF EXISTS (
          SELECT 1 FROM orders
          WHERE COALESCE(agent_id,'') = COALESCE(NEW.agent_id,'')
            AND COALESCE(chat_id,'') = COALESCE(NEW.chat_id,'')
            AND COALESCE(customer_phone,'') = COALESCE(NEW.customer_phone,'')
            AND COALESCE(order_details,'') = COALESCE(NEW.order_details,'')
        ) THEN
          RETURN NULL;
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_prevent_duplicate_order ON orders;
      CREATE TRIGGER trg_prevent_duplicate_order
      BEFORE INSERT ON orders
      FOR EACH ROW EXECUTE FUNCTION prevent_duplicate_order();

      CREATE INDEX IF NOT EXISTS idx_chat_messages_platform_chat_agent_created
        ON chat_messages(platform, chat_id, agent_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_orders_agent_chat_phone
        ON orders(agent_id, chat_id, customer_phone);
    `);
    console.log('✓ Customer memory/order hardening ready');
  } catch (err) {
    console.error('Customer memory/order hardening error:', err.message);
  } finally {
    await pool.end();
  }
}

// server.js creates its tables during startup; apply after that initialization.
setTimeout(applyHardening, 5000);
