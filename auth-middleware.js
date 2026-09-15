// Supabase Auth middleware for protected dashboard/API routes.
// This module is intentionally separate so public Telegram/Meta webhooks
// can remain available without a dashboard session.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;

async function requireSupabaseUser(req, res, next) {
  const authorization = req.get('authorization') || '';
  const accessToken = authorization.startsWith('Bearer ')
    ? authorization.slice(7).trim()
    : '';

  if (!accessToken) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('Supabase Auth is not configured');
    return res.status(503).json({ error: 'Authentication service is not configured' });
  }

  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: 'GET',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      return res.status(401).json({ error: 'Invalid or expired access token' });
    }

    req.user = await response.json();
    return next();
  } catch (error) {
    console.error('Supabase Auth verification failed:', error.message);
    return res.status(503).json({ error: 'Authentication service unavailable' });
  }
}

module.exports = { requireSupabaseUser };
