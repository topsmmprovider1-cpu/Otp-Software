const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const config = require('../config');
const {
  auth,
  signAccessToken,
  newRefreshToken,
  hashRefreshToken,
  clientContext,
  sessionRow,
} = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');

const router = express.Router();

const pub = (u) => ({
  id: u.id, fullName: u.full_name, email: u.email, phone: u.phone || '',
  balance: Number(u.balance) || 0, role: u.role, isActive: u.is_active === true || u.is_active === 1,
  createdAt: u.created_at,
});

const loginLimiter = rateLimit({
  windowMs: config.rateLimit.login.windowMs,
  max: config.rateLimit.login.max,
  keyFn: require('../middleware/rate-limit').ipKey,
  message: 'Too many login attempts. Please retry in a few minutes.',
});
const registerLimiter = rateLimit({
  windowMs: config.rateLimit.register.windowMs,
  max: config.rateLimit.register.max,
  keyFn: require('../middleware/rate-limit').ipKey,
  message: 'Too many accounts created from this address. Please try again later.',
});

// Create a session for a user from the current request. Returns access + refresh tokens.
async function openSession(user, req, { type = 'login', detail = '' } = {}) {
  const ctx = clientContext(req);
  const refreshToken = newRefreshToken();
  const expires = new Date(Date.now() + config.sessionDays * 24 * 60 * 60 * 1000).toISOString();
  const session = await db.createSession({
    userId: user.id,
    role: user.role,
    tokenHash: hashRefreshToken(refreshToken),
    deviceFp: ctx.fp,
    deviceName: ctx.name,
    ip: ctx.ip,
    userAgent: ctx.ua,
    expiresAt: expires,
  });

  await db.addLoginActivity({
    userId: user.id,
    type,
    detail,
    deviceFp: ctx.fp,
    deviceName: ctx.name,
    ip: ctx.ip,
    userAgent: ctx.ua,
  });

  // enforce a sane cap on active devices per account (oldest signed out)
  const active = await db.listActiveSessionsForUser(user.id);
  if (active.length > config.sessionMaxDevices) {
    const toRevoke = active.slice(config.sessionMaxDevices).map((s) => s.id);
    for (const id of toRevoke) await db.deactivateSession(id);
  }

  return {
    token: signAccessToken(user, session.id),
    refreshToken,
    session: sessionRow(session, null),
    user: pub(user),
    device: { name: ctx.name, ip: ctx.ip, fp: ctx.fp },
  };
}

router.post('/register', registerLimiter, async (req, res) => {
  try {
    const { fullName, email, phone, password } = req.body || {};
    if (!fullName || !email || !password) {
      return res.status(400).json({ error: 'fullName, email and password are required' });
    }
    if (String(password).length < 5) {
      return res.status(400).json({ error: 'Password must be at least 5 characters' });
    }
    const emailNorm = String(email).trim().toLowerCase();
    const existing = await db.getUserByEmail(emailNorm);
    if (existing) return res.status(400).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(String(password), 10);
    const user = await db.createUser({
      fullName: String(fullName).trim(),
      email: emailNorm,
      phone: (phone || '').trim(),
      passwordHash: hash,
      role: 'user',
      balance: 0,
    });
    const result = await openSession(user, req, { type: 'register', detail: 'Account created' });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const user = await db.getUserByEmail(String(email).trim().toLowerCase());
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(String(password), user.password_hash);
    if (!ok) return res.status(400).json({ error: 'Invalid credentials' });
    if (user.is_active === false || user.is_active === 0) {
      return res.status(403).json({ error: 'Account disabled. Contact admin.' });
    }
    const result = await openSession(user, req, { type: 'login', detail: 'Signed in' });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin-login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const user = await db.getUserByEmail(String(email).trim().toLowerCase());
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(String(password), user.password_hash);
    if (!ok) return res.status(400).json({ error: 'Invalid credentials' });
    if (user.role !== 'admin') return res.status(403).json({ error: 'Unauthorized. Admin access only.' });
    if (user.is_active === false || user.is_active === 0) {
      return res.status(403).json({ error: 'Account disabled. Contact admin.' });
    }
    const result = await openSession(user, req, { type: 'login', detail: 'Admin signed in' });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/refresh', async (req, res) => {
  try {
    const refreshToken = String((req.body || {}).refreshToken || '');
    if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });
    const session = await db.getSessionByTokenHash(hashRefreshToken(refreshToken));
    if (!session || Number(session.is_active) !== 1) {
      return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    }
    if (session.expires_at && new Date(session.expires_at) < new Date()) {
      await db.deactivateSession(session.id);
      return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    }
    const user = await db.getUserById(session.user_id);
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (user.is_active === false || user.is_active === 0) {
      await db.deactivateAllSessions(user.id);
      return res.status(403).json({ error: 'Account disabled' });
    }
    if (String(user.role) !== String(session.role)) {
      await db.deactivateSession(session.id);
      return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    }

    // rotate the refresh token (sliding expiry)
    const newPlain = newRefreshToken();
    const expires = new Date(Date.now() + config.sessionDays * 24 * 60 * 60 * 1000).toISOString();
    await db.updateSessionToken(session.id, hashRefreshToken(newPlain), expires);

    const refreshed = await db.getSessionById(session.id);
    const ctx = clientContext(req);
    await db.touchSession(session.id, ctx.ip);
    await db.addLoginActivity({
      userId: user.id,
      type: 'refresh',
      detail: 'Token refreshed',
      deviceFp: ctx.fp,
      deviceName: ctx.name,
      ip: ctx.ip,
      userAgent: ctx.ua,
    });

    res.json({
      token: signAccessToken(user, session.id),
      refreshToken: newPlain,
      session: sessionRow(refreshed, null),
      user: pub(user),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/logout', async (req, res) => {
  try {
    const refreshToken = String((req.body || {}).refreshToken || '');
    const ctx = clientContext(req);
    if (refreshToken) {
      const session = await db.getSessionByTokenHash(hashRefreshToken(refreshToken));
      if (session && Number(session.is_active) === 1) {
        await db.deactivateSession(session.id);
        await db.addLoginActivity({
          userId: session.user_id,
          type: 'logout',
          detail: 'Signed out',
          deviceFp: ctx.fp,
          deviceName: ctx.name,
          ip: ctx.ip,
          userAgent: ctx.ua,
        });
      }
    } else if (req.headers.authorization) {
      const { auth: _a, signAccessToken: _s, ...rest } = require('../middleware/auth');
      // derive session from access token when refresh not available
      const token = req.headers.authorization.replace(/^Bearer /, '');
      let payload = null;
      try { payload = require('jsonwebtoken').verify(token, config.jwtSecret); } catch (e) {}
      if (payload && payload.sid) {
        const session = await db.getSessionById(payload.sid);
        if (session && Number(session.is_active) === 1) {
          await db.deactivateSession(session.id);
          await db.addLoginActivity({
            userId: session.user_id,
            type: 'logout',
            detail: 'Signed out',
            deviceFp: ctx.fp,
            deviceName: ctx.name,
            ip: ctx.ip,
            userAgent: ctx.ua,
          });
        }
      }
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/me', auth, async (req, res) => {
  try {
    res.json({ user: pub(req.user), session: sessionRow(req.session, req.sessionId) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;