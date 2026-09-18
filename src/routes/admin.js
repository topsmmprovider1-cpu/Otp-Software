const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const db = require('../db');
const config = require('../config');
const poller = require('../services/poller');
const { auth, adminOnly } = require('../middleware/auth');
const { parseNumberRows, parseNumberFile, splitNumberApiLine } = require('../helpers');
const { rateLimit } = require('../middleware/rate-limit');

const router = express.Router();
router.use(auth, adminOnly);
router.use(rateLimit({
  windowMs: config.rateLimit.admin.windowMs,
  max: config.rateLimit.admin.max,
  message: 'Too many admin requests. Please try again shortly.',
}));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// make sure platform/country master rows exist for added numbers
async function ensureServices(rows) {
  const seen = new Set();
  for (const r of rows) {
    const key = r.platform + '\u0000' + r.country;
    if (seen.has(key)) continue;
    seen.add(key);
    if (r.platform) await db.addPlatform(r.platform);
    if (r.country) await db.addCountry(r.country);
  }
}

const pubOrder = (o) => ({
  id: o.id, orderId: o.order_id, userId: o.user_id, number: o.number, country: o.country, platform: o.platform,
  price: o.price, status: o.status, otpCode: o.otp_code || '', otpMessage: o.otp_message || '',
  otpTime: o.otp_time || null, createdAt: o.created_at, completedAt: o.completed_at || null,
  cancelledAt: o.cancelled_at || null, user: o.full_name || '', email: o.email || '',
});

// ---------- dashboard stats ----------
router.get('/stats', async (req, res) => {
  try {
    const users = await db.listUsers();
    const orders = await db.listAllOrders();
    const numbers = await db.listNumbers();

    const completedOrders = orders.filter((o) => o.status === 'completed');
    const revenue = completedOrders.reduce((s, o) => s + (Number(o.price) || 0), 0);

    let otpSpanMs = null;
    if (completedOrders.length) {
      const spans = completedOrders
        .map((o) => (o.otp_time ? new Date(o.otp_time).getTime() - new Date(o.created_at).getTime() : null))
        .filter((v) => v !== null && v >= 0);
      if (spans.length) otpSpanMs = spans.reduce((a, b) => a + b, 0) / spans.length;
    }

    const byStatus = (s) => orders.filter((o) => o.status === s).length;

    const platforms = new Set(numbers.filter((n) => n.status === 'available').map((n) => n.platform));
    const countries = new Set(numbers.filter((n) => n.status === 'available').map((n) => n.country));

    res.json({
      stats: {
        users: users.length,
        totalOrders: orders.length,
        pending: byStatus('pending'),
        completed: byStatus('completed'),
        cancelled: byStatus('cancelled'),
        expired: byStatus('expired'),
        revenue: revenue.toFixed(2),
        avgOtpSec: otpSpanMs != null ? Math.round(otpSpanMs / 1000) : null,
        availableNumbers: numbers.filter((n) => n.status === 'available').length,
        soldNumbers: numbers.filter((n) => n.status === 'sold').length,
        totalNumbers: numbers.length,
        platforms: platforms.size,
        countries: countries.size,
      },
      recentOrders: orders.slice(0, 10).map(pubOrder),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- analytics (charts) ----------
router.get('/analytics', async (req, res) => {
  try {
    const orders = await db.listAllOrders();

    // daily buckets — last 14 days
    const days = 14;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const daily = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      daily.push({ date: d.toISOString().slice(0, 10), label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), orders: 0, completed: 0, revenue: 0 });
    }
    for (const o of orders) {
      const dt = new Date(o.created_at);
      const key = dt.toISOString().slice(0, 10);
      const bucket = daily.find((b) => b.date === key);
      if (!bucket) continue;
      bucket.orders++;
      if (o.status === 'completed') { bucket.completed++; bucket.revenue += Number(o.price) || 0; }
    }

    // status distribution
    const statusMap = { pending: 0, completed: 0, cancelled: 0, expired: 0 };
    for (const o of orders) if (statusMap[o.status] !== undefined) statusMap[o.status]++;
    const statusDist = Object.keys(statusMap).map((k) => ({ name: k, value: statusMap[k] }));

    // platform distribution
    const pMap = new Map();
    for (const o of orders) {
      if (!pMap.has(o.platform)) pMap.set(o.platform, { name: o.platform, orders: 0, revenue: 0, completed: 0 });
      const p = pMap.get(o.platform);
      p.orders++;
      if (o.status === 'completed') { p.completed++; p.revenue += Number(o.price) || 0; }
    }
    const platformDist = [...pMap.values()].sort((a, b) => b.orders - a.orders).slice(0, 8);

    // country distribution
    const cMap = new Map();
    for (const o of orders) {
      if (!cMap.has(o.country)) cMap.set(o.country, { name: o.country, orders: 0 });
      cMap.get(o.country).orders++;
    }
    const countryDist = [...cMap.values()].sort((a, b) => b.orders - a.orders).slice(0, 8);

    const completedOrders = orders.filter((o) => o.status === 'completed');
    const spans = completedOrders.map((o) => (o.otp_time ? new Date(o.otp_time).getTime() - new Date(o.created_at).getTime() : null)).filter((v) => v !== null && v >= 0);
    const avgOtpSec = spans.length ? Math.round(spans.reduce((a, b) => a + b, 0) / spans.length / 1000) : null;
    const totalRevenue = completedOrders.reduce((s, o) => s + (Number(o.price) || 0), 0);
    const completionRate = orders.length ? Math.round((statusMap.completed / orders.length) * 100) : 0;

    res.json({
      daily, statusDist, platformDist, countryDist, avgOtpSec,
      totalRevenue: +totalRevenue.toFixed(2), totalOrders: orders.length,
      completed: statusMap.completed, pending: statusMap.pending,
      cancelled: statusMap.cancelled, expired: statusMap.expired, completionRate,
      poller: { active: !!(poller.state().lastRunAt), intervalMs: config.pollIntervalMs, lastRunAt: poller.state().lastRunAt },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- numbers ----------
router.get('/numbers', async (req, res) => {
  try {
    const numbers = await db.listNumbers();
    res.json({ numbers });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// add numbers: body can be {lines: "text"}\n separated, {rows:[...]}, or {single:{...}}
router.post('/numbers', async (req, res) => {
  try {
    let parsed;
    if (req.body.rows && Array.isArray(req.body.rows)) {
      parsed = { rows: req.body.rows };
    } else {
      parsed = parseNumberRows(req.body.lines || '');
    }
    if (!parsed.rows.length) {
      return res.status(400).json({ error: 'No valid lines found', errors: parsed.errors || [] });
    }
    await ensureServices(parsed.rows);
    const n = await db.insertNumbers(parsed.rows);
    res.json({ added: n, errors: parsed.errors || [], msg: `${n} numbers added` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/numbers/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const ext = (req.file.originalname.split('.').pop() || '').toLowerCase();
    if (!['txt', 'csv', 'xlsx', 'xls'].includes(ext)) {
      return res.status(400).json({ error: 'Only .txt, .csv, .xlsx files are supported' });
    }
    const { rows, errors } = parseNumberFile(req.file.originalname, req.file.buffer);
    if (!rows.length) return res.status(400).json({ error: 'No valid rows in file' });
    await ensureServices(rows);
    const n = await db.insertNumbers(rows);
    res.json({ added: n, errors, msg: `${n} numbers imported from ${req.file.originalname}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/numbers/:id', async (req, res) => {
  try {
    const { status, price } = req.body || {};
    const num = await db.getNumberById(req.params.id);
    if (!num) return res.status(404).json({ error: 'Number not found' });
    const patch = {};
    if (status && ['available', 'sold', 'disabled'].includes(status)) patch.status = status;
    if (price !== undefined) patch.price = Number(price) || 0;
    if (Object.keys(patch).length) await db.updateNumber(num.id, patch);
    res.json({ msg: 'Number updated' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- users ----------
router.get('/users', async (req, res) => {
  try {
    const users = await db.listUsers();
    res.json({ users: users.map((u) => ({
      id: u.id, fullName: u.full_name, email: u.email, phone: u.phone || '',
      balance: Number(u.balance) || 0, role: u.role,
      isActive: u.is_active === true || u.is_active === 1, createdAt: u.created_at,
    })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/users/:id/balance', async (req, res) => {
  try {
    const amount = parseFloat(req.body.amount);
    if (!amount || isNaN(amount)) return res.status(400).json({ error: 'valid amount required' });
    await db.addBalance(req.params.id, amount);
    await db.addWalletEntry({
      userId: req.params.id, amount, type: 'adjustment', note: `Admin adjustment`,
    });
    const u = await db.getUserById(req.params.id);
    res.json({ msg: 'Balance updated', balance: Number(u.balance) || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/users/:id', async (req, res) => {
  try {
    const { role, isActive, password, fullName, email, phone } = req.body || {};
    const u = await db.getUserById(req.params.id);
    if (!u) return res.status(404).json({ error: 'User not found' });
    if (Number(u.id) === Number(req.userId) && isActive === false) {
      return res.status(400).json({ error: 'You cannot disable your own account' });
    }
    const patch = {};
    if (fullName !== undefined && String(fullName).trim()) patch.fullName = String(fullName).trim();
    if (phone !== undefined) patch.phone = String(phone).trim();
    if (role && ['admin', 'user'].includes(role)) patch.role = role;
    if (isActive !== undefined) patch.isActive = !!isActive;
    if (password) patch.password_hash = await bcrypt.hash(String(password), 10);
    if (email !== undefined && String(email).trim()) {
      const norm = String(email).trim().toLowerCase();
      if (norm !== u.email) {
        const existing = await db.getUserByEmail(norm);
        if (existing) return res.status(400).json({ error: 'Email already in use' });
        patch.email = norm;
      }
    }
    // email/phone/role change → sign user out everywhere for security
    if (patch.email || patch.phone || (patch.role && patch.role !== u.role) || patch.isActive === false) {
      await db.deactivateAllSessions(u.id);
    }
    await db.updateUser(u.id, patch);
    res.json({ msg: 'User updated' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /users/:id/sessions — list a user's devices/sessions
router.get('/users/:id/sessions', async (req, res) => {
  try {
    const u = await db.getUserById(req.params.id);
    if (!u) return res.status(404).json({ error: 'User not found' });
    const rows = await db.listSessionsForUser(u.id);
    const { sessionRow } = require('../middleware/auth');
    res.json({ sessions: rows.map((s) => sessionRow(s, null)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /users/:id/sessions/:sid — admin revokes a specific device
router.delete('/users/:id/sessions/:sid', async (req, res) => {
  try {
    const s = await db.getSessionById(Number(req.params.sid));
    if (!s || Number(s.user_id) !== Number(req.params.id)) {
      return res.status(404).json({ error: 'Session not found' });
    }
    await db.deactivateSession(s.id);
    await db.addLoginActivity({
      userId: Number(req.params.id), type: 'logout', detail: 'Signed out by admin',
      deviceFp: s.device_fp, deviceName: s.device_name, ip: s.ip, userAgent: s.user_agent,
    });
    res.json({ msg: 'Session signed out' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /users/:id/sessions — sign every device out
router.delete('/users/:id/sessions', async (req, res) => {
  try {
    await db.deactivateAllSessions(Number(req.params.id));
    res.json({ msg: 'All devices signed out' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- admin's own sessions / security ----------
// GET /admin/sessions — every admin session (for the signed-in admin)
router.get('/admin/sessions', async (req, res) => {
  try {
    const admins = await db.listUsers();
    const adminIds = admins.filter((a) => a.role === 'admin').map((a) => a.id);
    const rows = [];
    for (const id of adminIds) {
      for (const s of await db.listSessionsForUser(id)) rows.push({ ...s, sessionOwner: id });
    }
    rows.sort((a, b) => (b.last_seen_at || '').localeCompare(a.last_seen_at || ''));
    const { sessionRow } = require('../middleware/auth');
    res.json({ sessions: rows.map((s) => ({
      ...sessionRow(s, null),
      ownerId: s.sessionOwner,
      ownerName: (admins.find((a) => Number(a.id) === Number(s.sessionOwner)) || {}).full_name || 'Admin',
    })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /admin/sessions/:id — admin revokes ANY admin session (incl. others)
router.delete('/admin/sessions/:id', async (req, res) => {
  try {
    const s = await db.getSessionById(Number(req.params.id));
    if (!s) return res.status(404).json({ error: 'Session not found' });
    const owner = await db.getUserById(s.user_id);
    if (!owner || owner.role !== 'admin') return res.status(400).json({ error: 'Not an admin session' });
    if (Number(s.id) === Number(req.sessionId)) {
      return res.status(400).json({ error: 'Use the Sign out button instead' });
    }
    await db.deactivateSession(s.id);
    res.json({ msg: 'Admin session signed out' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /admin/activity — recent admin sign-ins / actions
router.get('/admin/activity', async (req, res) => {
  try {
    const admins = await db.listUsers();
    const adminIds = admins.filter((a) => a.role === 'admin').map((a) => a.id);
    const all = [];
    for (const id of adminIds) {
      for (const e of await db.listLoginActivity(id, 25)) all.push({ ...e, ownerId: id });
    }
    all.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    const byName = (uid) => (admins.find((a) => Number(a.id) === Number(uid)) || {}).full_name || 'Admin';
    res.json({ activity: all.slice(0, 50).map((e) => ({
      ...e, ownerName: byName(e.ownerId),
    })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- services ----------
router.get('/services', async (req, res) => {
  try {
    const services = await db.listServices();
    res.json({ services });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// create service + optional numbers in one shot
router.post('/services', async (req, res) => {
  try {
    const { platform, country, price, apiUrl, lines, rows } = req.body || {};
    const r = await db.createService({ platform, country, price, apiUrl });
    if (!r.ok) return res.status(400).json({ error: r.error });

    let added = 0; const errors = [];
    const enriched = [];
    if (rows && Array.isArray(rows) && rows.length) {
      for (const x of rows) {
        if (!String(x.number || '').trim()) { errors.push('Empty number skipped'); continue; }
        enriched.push({
          number: String(x.number).trim(),
          country: x.country || r.country,
          platform: x.platform || r.platform,
          price: (x.price !== undefined && x.price !== null && x.price !== '') ? x.price : Number(price) || 0,
          api_url: x.api_url || apiUrl || '',
        });
      }
    } else if (lines && String(lines).trim()) {
      for (const raw of String(lines).split(/\r?\n/)) {
        const line = String(raw || '').trim();
        if (!line) continue;
        // format: +12089778478----https://api.sms8.net/api/record?token=...  (number + api url per line)
        const sep = splitNumberApiLine(line);
        if (sep) {
          enriched.push({
            number: sep.number,
            country: r.country,
            platform: r.platform,
            price: Number(price) || 0,
            api_url: sep.api_url || apiUrl || '',
          });
          continue;
        }
        if (/[|,;\t]/.test(line)) {
          const parsed = parseNumberRows(line);
          if (parsed.rows.length) {
            for (const x of parsed.rows) enriched.push({
              ...x,
              country: x.country || r.country,
              platform: x.platform || r.platform,
              price: (x.price || x.price === 0) ? x.price : Number(price) || 0,
              api_url: x.api_url || apiUrl || '',
            });
          } else {
            errors.push(`Bad line: ${line}`);
          }
        } else {
          enriched.push({
            number: line, country: r.country, platform: r.platform,
            price: Number(price) || 0, api_url: apiUrl || '',
          });
        }
      }
    }
    if (enriched.length) {
      await ensureServices(enriched);
      added = await db.insertNumbers(enriched);
    }

    res.json({ created: true, added, errors, msg: `Service '${r.platform} / ${r.country}' created${added ? ' with ' + added + ' number(s)' : ''}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/services/:id', async (req, res) => {
  try {
    const { price, status, apiUrl } = req.body || {};
    const svc = await db.getServiceById(req.params.id);
    if (!svc) return res.status(404).json({ error: 'Service not found' });
    const patch = {};
    if (price !== undefined) patch.price = Number(price) || 0;
    if (apiUrl !== undefined) patch.api_url = String(apiUrl).trim();
    if (status !== undefined) {
      if (!['enabled', 'disabled'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
      patch.status = status;
    }
    if (Object.keys(patch).length) await db.updateService(svc.id, patch);
    res.json({ msg: 'Service updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/services/:id', async (req, res) => {
  try {
    const r = await db.deleteService(req.params.id);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ msg: 'Service deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- platforms & countries (services) ----------
router.get('/platforms', async (req, res) => {
  try {
    const platforms = await db.listPlatforms();
    res.json({ platforms });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/platforms', async (req, res) => {
  try {
    const r = await db.addPlatform((req.body || {}).name);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ msg: `Platform '${String((req.body || {}).name).trim()}' added` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/platforms/:id', async (req, res) => {
  try {
    const r = await db.deletePlatform(req.params.id);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ msg: 'Platform deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/countries', async (req, res) => {
  try {
    const countries = await db.listCountries();
    res.json({ countries });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/countries', async (req, res) => {
  try {
    const r = await db.addCountry((req.body || {}).name);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ msg: `Country '${String((req.body || {}).name).trim()}' added` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/countries/:id', async (req, res) => {
  try {
    const r = await db.deleteCountry(req.params.id);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ msg: 'Country deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- orders ----------
router.get('/orders', async (req, res) => {
  try {
    await poller.pollOnce().catch((e) => console.warn('[admin] poll error:', e.message));
    const orders = await db.listAllOrders();
    res.json({ orders: orders.map(pubOrder) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/orders/:id', async (req, res) => {
  try {
    const order = await db.getOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ order: pubOrder(order) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- tickets (admin) ----------
router.get('/tickets', async (req, res) => {
  try {
    const tickets = await db.listTickets();
    res.json({ tickets });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/tickets/:id', async (req, res) => {
  try {
    const ticket = await db.getTicketById(req.params.id);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const messages = await db.getTicketMessages(ticket.id);
    res.json({
      ticket,
      messages: messages.map((m) => ({
        id: m.id, senderRole: m.sender_role, senderName: m.sender_name || (m.sender_role === 'admin' ? 'Support' : m.full_name || 'User'),
        message: m.message, createdAt: m.created_at,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/tickets/:id/messages', async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message || !String(message).trim()) return res.status(400).json({ error: 'Message required' });
    const ticket = await db.getTicketById(req.params.id);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (ticket.status === 'closed') return res.status(400).json({ error: 'Ticket is closed' });
    const msg = await db.addTicketMessage({
      ticketId: ticket.id, senderId: req.userId, senderRole: 'admin', message: String(message).trim(),
    });
    await db.updateTicket(ticket.id, { status: 'answered' });
    res.json({ msg: 'Reply sent', message: { id: msg.id, message: msg.message, senderRole: 'admin', createdAt: msg.created_at } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/tickets/:id', async (req, res) => {
  try {
    const { status, priority } = req.body || {};
    const ticket = await db.getTicketById(req.params.id);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const patch = {};
    if (status && ['open', 'answered', 'closed'].includes(status)) {
      patch.status = status;
      patch.closed_at = status === 'closed' ? db.now() : null;
    }
    if (priority && ['low', 'normal', 'high'].includes(priority)) patch.priority = priority;
    if (Object.keys(patch).length) await db.updateTicket(ticket.id, patch);
    res.json({ msg: 'Ticket updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- otp logs ----------
router.get('/otp-logs', async (req, res) => {
  try {
    const logs = await db.listOtpLogs(200);
    res.json({ logs: logs.map((l) => ({
      id: l.id, orderId: l.order_id, number: l.number, code: l.code,
      message: l.message || '', createdAt: l.created_at,
    })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- order pull logs ----------
router.get('/orders/:id/logs', async (req, res) => {
  try {
    await poller.pollOnce().catch((e) => console.warn('[admin] poll error:', e.message));
    const order = await db.getOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const pulls = await db.listPullLogsByOrder(order.id);
    const otps = await db.listOtpLogs(200);
    res.json({
      order: pubOrder(order),
      pulls: pulls.map((l) => ({ id: l.id, result: l.result, message: l.message || '', createdAt: l.created_at })),
      otpLogs: otps.filter((l) => l.order_id === order.id).map((l) => ({
        id: l.id, code: l.code, message: l.message || '', createdAt: l.created_at,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- payments ----------
router.get('/payments', async (req, res) => {
  try {
    const payments = await db.listAllPayments();
    res.json({ payments: payments.map((p) => ({
      id: p.id, userId: p.user_id, utr: p.utr, amount: Number(p.amount) || 0,
      method: p.method, status: p.status, credit: Number(p.credit) || 0,
      ip: p.ip || '', note: p.note || '', email: p.email || '', fullName: p.full_name || '',
      createdAt: p.created_at, verifiedAt: p.verified_at || null,
    })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/payments/manual', async (req, res) => {
  try {
    const { userId, amount, note } = req.body || {};
    const amt = parseFloat(amount);
    if (!userId || !amt || isNaN(amt)) return res.status(400).json({ error: 'User id and amount required' });
    const u = await db.getUserById(userId);
    if (!u) return res.status(404).json({ error: 'User not found' });
    await db.addBalance(userId, amt);
    await db.addWalletEntry({
      userId, amount: amt, type: 'adjustment',
      note: note ? `Admin adjustment: ${String(note).slice(0, 200)}` : 'Admin balance adjustment',
    });
    const updated = await db.getUserById(userId);
    res.json({ msg: 'Balance updated', balance: Number(updated.balance) || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/payments/:id/approve', async (req, res) => {
  try {
    const p = await db.getPaymentById(req.params.id);
    if (!p) return res.status(404).json({ error: 'Payment not found' });
    if (p.status === 'approved') return res.status(400).json({ error: 'Payment already approved' });
    const rate = await db.getSetting('paymentRateInrUsd');
    const credit = Number(p.credit) || (Number(p.amount) || 0) * parseFloat(rate || '0.012');
    await db.updatePayment(p.id, { status: 'approved', credit, verified_at: db.now() });
    await db.addBalance(p.user_id, credit);
    await db.addWalletEntry({ userId: p.user_id, amount: credit, type: 'deposit', note: `BharatPe deposit (${p.utr})` });
    res.json({ msg: 'Payment approved and balance credited' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/payments/:id/reject', async (req, res) => {
  try {
    const p = await db.getPaymentById(req.params.id);
    if (!p) return res.status(404).json({ error: 'Payment not found' });
    if (p.status === 'approved') return res.status(400).json({ error: 'Approved payments cannot be rejected' });
    await db.updatePayment(p.id, { status: 'rejected' });
    res.json({ msg: 'Payment rejected' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- settings ----------
const SETTING_KEYS = [
  'siteName', 'currency', 'paymentEnabled', 'paymentMode', 'paymentQr', 'paymentUpiId',
  'paymentMerchantName', 'bharatpeMerchantId', 'bharatpeToken', 'paymentFeePct',
  'paymentRateInrUsd', 'paymentMin', 'paymentInstructions',
];

router.get('/settings', async (req, res) => {
  try {
    res.json({ settings: await db.getAllSettings() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/settings', async (req, res) => {
  try {
    const body = req.body || {};
    const obj = {};
    for (const k of SETTING_KEYS) if (body[k] !== undefined) obj[k] = body[k];
    const saved = await db.setSettings(obj);
    res.json({ msg: 'Settings saved', settings: saved });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/settings/upload-qr', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (req.file.size > 2 * 1024 * 1024) return res.status(400).json({ error: 'Image too large (max 2MB)' });
    const mime = req.file.mimetype || 'image/png';
    await db.setSetting('paymentQr', `data:${mime};base64,${req.file.buffer.toString('base64')}`);
    await db.setSetting('paymentMode', 'qr');
    res.json({ msg: 'QR code uploaded and activated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Test the BharatPe credentials — fires a real transactions lookup and reports status.
router.post('/settings/test-payment', async (req, res) => {
  try {
    const s = await db.getAllSettings();
    const merchantId = String(s.bharatpeMerchantId || '').trim();
    const token = String(s.bharatpeToken || '').trim();
    if (!merchantId || !token) return res.json({ ok: false, error: 'Merchant ID and token are required first.' });
    const https = require('https');
    const d = new Date();
    const fmt = (x) => x.toISOString().slice(0, 10);
    const from = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    const url = `https://payments-tesseract.bharatpe.in/api/v1/merchant/transactions?module=PAYMENT_QR&merchantId=${encodeURIComponent(merchantId)}&sDate=${fmt(from)}&eDate=${fmt(d)}`;
    const body = await new Promise((resolve, reject) => {
      https.get(url, { headers: { token, 'user-agent': 'Mozilla/5.0' } }, (resp) => {
        let data = ''; resp.setEncoding('utf8');
        resp.on('data', (c) => { data += c; });
        resp.on('end', () => {
          if (resp.statusCode === 401) return resolve({ ok: false, error: 'Unauthorized — check the merchant ID and token.' });
          if (resp.statusCode >= 400) return resolve({ ok: false, error: `Gateway replied with HTTP ${resp.statusCode}` });
          resolve({ ok: true, data });
        });
      }).on('error', (e) => resolve({ ok: false, error: e.message }));
    });
    if (!body.ok) return res.json(body);
    try {
      const j = JSON.parse(body.data);
      const tx = (j.data && j.data.transactions) || [];
      return res.json({ ok: true, msg: `Connected. Last 2 days: ${tx.length} transaction(s).` });
    } catch (e) {
      return res.json({ ok: true, msg: 'Connected — but the response format was unexpected.', raw: String(body.data).slice(0, 160) });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;