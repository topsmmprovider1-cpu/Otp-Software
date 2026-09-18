const db = require('../db');

// Authenticates requests with an API key (Authorization: Bearer <key>
// or ?api_key=<key>). Sets req.apiKey and req.user on success.
async function apiKeyAuth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    const key = m ? m[1].trim() : String(req.query.api_key || '').trim();
    if (!key) {
      return res.status(401).json({ success: false, error: 'API key required. Use header Authorization: Bearer <your_api_key>' });
    }
    const apiKey = await db.getApiKeyByKey(key);
    if (!apiKey) {
      return res.status(401).json({ success: false, error: 'Invalid API key' });
    }
    const user = await db.getUserById(apiKey.user_id);
    if (!user) return res.status(401).json({ success: false, error: 'User not found' });
    if (user.is_active === false || user.is_active === 0) {
      return res.status(403).json({ success: false, error: 'Account disabled. Contact support.' });
    }
    req.apiKey = apiKey;
    req.user = user;
    req.userId = user.id;
    try { await db.touchApiKey(apiKey.id); } catch (e) { /* non-fatal */ }
    next();
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

module.exports = { apiKeyAuth };