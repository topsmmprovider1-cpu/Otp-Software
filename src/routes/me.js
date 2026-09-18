const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const config = require('../config');
const { auth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');

const router = express.Router();
router.use(auth);

const rl = config.rateLimit;
const topupL = rateLimit({ windowMs: rl.topup.windowMs, max: rl.topup.max, message: 'Too many top-ups. Please retry in a minute.' });
const patchL = rateLimit({ windowMs: 60 * 1000, max: 20, message: 'Too many profile updates. Please retry in a minute.' });
const keyGenL = rateLimit({ windowMs: rl.keyGen.windowMs, max: rl.keyGen.max, message: 'Maximum API keys per hour reached. Try again later.' });

const pubKeys = (k) => ({
  id: k.id, label: k.label, apiKey: k.api_key, lastUsed: k.last_used || null, createdAt: k.created_at,
});

// GET /api/me — profile + balance + api keys
router.get('/', async (req, res) => {
  try {
    const u = req.user;
    const keys = await db.listApiKeys(u.id);
    res.json({
      user: {
        id: u.id, fullName: u.full_name, email: u.email, phone: u.phone || '',
        role: u.role, createdAt: u.created_at,
      },
      balance: Number(u.balance) || 0,
      apiKeys: keys.map(pubKeys),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/me — edit profile (name, phone, email, password)
router.patch('/', patchL, async (req, res) => {
  try {
    const { fullName, phone, email, currentPassword, newPassword } = req.body || {};
    const u = req.user;
    const patch = {};

    if (fullName !== undefined && String(fullName).trim()) patch.fullName = String(fullName).trim();
    if (phone !== undefined) patch.phone = String(phone).trim();

    if (email !== undefined && String(email).trim()) {
      const norm = String(email).trim().toLowerCase();
      if (norm !== u.email) {
        const existing = await db.getUserByEmail(norm);
        if (existing) return res.status(400).json({ error: 'Email already in use' });
        patch.email = norm;
      }
    }

    if (newPassword !== undefined && String(newPassword)) {
      if (String(newPassword).length < 5) return res.status(400).json({ error: 'New password must be at least 5 characters' });
      if (!currentPassword) return res.status(400).json({ error: 'Current password required to change password' });
      const ok = await bcrypt.compare(String(currentPassword), u.password_hash);
      if (!ok) return res.status(400).json({ error: 'Current password is incorrect' });
      patch.passwordHash = await bcrypt.hash(String(newPassword), 10);
    }

    if (Object.keys(patch).length) {
      // map to driver fields
      const driverPatch = {
        ...(patch.fullName ? { fullName: patch.fullName } : {}),
        ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
        ...(patch.email ? { email: patch.email } : {}),
        ...(patch.passwordHash ? { password_hash: patch.passwordHash } : {}),
      };
      await db.updateUser(u.id, driverPatch);
    }
    const updated = await db.getUserById(u.id);
    res.json({ msg: 'Profile updated', user: {
      id: updated.id, fullName: updated.full_name, email: updated.email,
      phone: updated.phone || '', role: updated.role, createdAt: updated.created_at,
    } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/me/topup — add wallet balance
router.post('/topup', topupL, async (req, res) => {
  try {
    const amount = parseFloat(req.body.amount);
    if (!amount || amount <= 0 || isNaN(amount)) return res.status(400).json({ error: 'Valid positive amount required' });
    if (amount > 1000) return res.status(400).json({ error: 'Max $1000 per top-up' });
    await db.addBalance(req.userId, amount);
    await db.addWalletEntry({
      userId: req.userId, amount, type: 'deposit',
      note: `Demo deposit $${amount} (no payment gateway)`,
    });
    const u = await db.getUserById(req.userId);
    res.json({ msg: `$${amount} added`, balance: Number(u.balance) || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/me/wallet — wallet history
router.get('/wallet', async (req, res) => {
  try {
    const entries = await db.listWalletEntries(req.userId);
    res.json({ entries });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/me/api-keys — generate a new API key
router.post('/api-keys', keyGenL, async (req, res) => {
  try {
    const { label } = req.body || {};
    const key = 'sotp_' + crypto.randomBytes(24).toString('hex');
    const k = await db.createApiKey({ userId: req.userId, apiKey: key, label: String(label || 'Default').trim() });
    res.json({ apiKey: pubKeys(k), msg: 'API key generated. It is shown only once.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/me/api-keys/:id
router.delete('/api-keys/:id', async (req, res) => {
  try {
    const r = await db.revokeApiKey(req.params.id, req.userId);
    if (!r.ok) return res.status(404).json({ error: r.error });
    res.json({ msg: 'API key revoked' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/me/sessions — devices & active sessions
router.get('/sessions', async (req, res) => {
  try {
    const rows = await db.listSessionsForUser(req.userId);
    res.json({ sessions: rows.map((s) => require('../middleware/auth').sessionRow(s, req.sessionId)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/me/sessions/:id — sign this device out
router.delete('/sessions/:id', async (req, res) => {
  try {
    const s = await db.getSessionById(Number(req.params.id));
    if (!s || Number(s.user_id) !== Number(req.userId)) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (Number(s.id) === Number(req.sessionId)) {
      return res.status(400).json({ error: 'Use the Sign out button instead' });
    }
    await db.deactivateSession(s.id);
    res.json({ msg: 'Session signed out' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/me/sessions — sign out every other device
router.delete('/sessions', async (req, res) => {
  try {
    await db.deactivateAllSessions(req.userId, req.sessionId);
    await db.addLoginActivity({
      userId: req.userId, type: 'logout', detail: 'Signed out all other devices',
      deviceFp: req.session.device_fp, deviceName: req.session.device_name,
      ip: req.session.ip, userAgent: req.session.user_agent,
    });
    res.json({ msg: 'All other devices signed out' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/me/activity — recent account activity
router.get('/activity', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 100);
    const rows = await db.listLoginActivity(req.userId, limit);
    res.json({ activity: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;