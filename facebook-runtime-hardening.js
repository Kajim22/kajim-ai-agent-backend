// Facebook Graph API runtime hardening.
// Keep existing server.js behavior unchanged while moving Facebook calls
// to the current Graph API version by default. An explicit Render env value
// still takes precedence.

if (!process.env.FB_GRAPH_VERSION) {
  process.env.FB_GRAPH_VERSION = 'v26.0';
  console.log('✓ Facebook Graph API version: v26.0');
}
