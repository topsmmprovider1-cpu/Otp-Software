const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('../config');
const db = require('../db');

const REFRESH_PREVIEW = 16; // chars of refresh token shown in session rows

function signAccessToken(user, sessionId) {
  return jwt.sign({ uid: user.id, role: user.role, sid: sessionId, typ: 'access' }, config.jwtSecret, {
    expiresIn: config.jwtAccessExpires || config.jwtExpires,
  });
}

function newRefreshToken() {
  return crypto.randomBytes(48).toString('hex');
}
function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Extract client info from a request + build a stable device fingerprint.
function clientContext(req) {
  const ua = String(req.headers['user-agent'] || '').slice(0, 300);
  const acceptLang = String(req.headers['accept-language'] || '');
  const rawIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '0.0.0.0';
  const clientId = String(req.headers['x-device-id'] || req.body?.deviceId || '').slice(0, 64);
  return {
    ua,
    ip: rawIp,
    fp: require('../helpers').deviceFingerprint(ua, acceptLang, clientId),
    name: require('../helpers').deviceLabel(ua),
  };
}

function sessionRow(row, currentSessionId) {
  return {
    id: row.id,
    current: !!currentSessionId && Number(row.id) === Number(currentSessionId),
    role: row.role,
    device_name: row.device_name || 'Unknown device',
    device_fp: row.device_fp || '',
    ip: row.ip || '',
    is_active: Number(row.is_active) === 1,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at || null,
  };
}

async function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.query.token || '');
  if (!token) return res.status(401).json({ error: 'Not authorized' });

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch (e) {
    return res.status(401).json({ error: 'Session expired' });
  }
  if (!payload.sid || !payload.uid || payload.typ !== 'access') {
    return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }

  try {
    const session = await db.getSessionById(payload.sid);
    if (!session || Number(session.user_id) !== Number(payload.uid)) {
      return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    }
    if (Number(session.is_active) !== 1) {
      return res.status(401).json({ error: 'Session signed out. Please sign in again.' });
    }
    if (session.expires_at && new Date(session.expires_at) < new Date()) {
      await db.deactivateSession(session.id);
      return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    }

    const user = await db.getUserById(payload.uid);
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (user.is_active === false || user.is_active === 0) {
      return res.status(403).json({ error: 'Account disabled' });
    }
    if (String(user.role) !== String(payload.role)) {
      await db.deactivateAllSessions(user.id);
      return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    }

    req.user = user;
    req.userId = user.id;
    req.session = session;
    req.sessionId = session.id;

    // throttle last_seen updates to 1 per 5 minutes per session
    const last = session.last_seen_at ? new Date(session.last_seen_at).getTime() : 0;
    if (Date.now() - last > 5 * 60 * 1000) {
      const ctx = clientContext(req);
      db.touchSession(session.id, ctx.ip).catch(() => {});
    }
    next();
  } catch (e) {
    console.error('[auth] db error:', e.message);
    res.status(500).json({ error: 'DB error' });
  }
}

function adminOnly(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  res.status(403).json({ error: 'Admin only' });
}

module.exports = {
  auth,
  adminOnly,
  signAccessToken,
  newRefreshToken,
  hashRefreshToken,
  clientContext,
  sessionRow,
};