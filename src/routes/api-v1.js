const express = require('express');
const db = require('../db');
const config = require('../config');
const poller = require('../services/poller');
const { apiKeyAuth } = require('../middleware/api-key');
const { rateLimit, ipKey } = require('../middleware/rate-limit');
const { purchase, AppError } = require('../services/purchase');

const router = express.Router();
router.use(apiKeyAuth);

const rl = config.rateLimit;
// global guard for the whole v1 API (per api key + ip)
router.use(rateLimit({
  windowMs: rl.apiV1.windowMs, max: rl.apiV1.max, v1: true,
  keyFn: (req) => ipKey(req) + ':k:' + (req.apiKey?.id || ''),
  message: 'API rate limit exceeded (240 req/min). Please slow down.',
}));
// purchase endpoints are expensive — stricter
const buyL = rateLimit({
  windowMs: rl.purchase.windowMs, max: rl.purchase.max, v1: true,
  keyFn: (req) => ipKey(req) + ':k:' + (req.apiKey?.id || ''),
  message: 'Purchase rate limit reached (' + rl.purchase.max + '/min). Please wait.',
});
const otpL = rateLimit({
  windowMs: rl.otpPoll.windowMs, max: rl.otpPoll.max, v1: true,
  keyFn: (req) => ipKey(req) + ':k:' + (req.apiKey?.id || ''),
  message: 'OTP polling rate limit reached (' + rl.otpPoll.max + '/min). Please wait.',
});
const cancelV1L = rateLimit({
  windowMs: rl.cancel.windowMs, max: rl.cancel.max, v1: true,
  keyFn: (req) => ipKey(req) + ':k:' + (req.apiKey?.id || ''),
  message: 'Too many cancel requests. Please try again shortly.',
});

const fail = (res, e) => {
  if (e instanceof AppError) {
    return res.status(e.status || 400).json({ success: false, error: e.message, ...e.extra });
  }
  console.error('[api/v1]', e);
  return res.status(500).json({ success: false, error: e.message });
};
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => fail(res, e));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- account ----------

// GET /api/v1/me — account + balance
router.get('/me', wrap(async (req, res) => {
  const u = req.user;
  res.json({
    success: true,
    user: {
      id: u.id, fullName: u.full_name, email: u.email, phone: u.phone || '',
      role: u.role, createdAt: u.created_at,
    },
    balance: Number(u.balance) || 0,
    currency: 'USD',
  });
}));

// GET /api/v1/balance — wallet balance
router.get('/balance', wrap(async (req, res) => {
  res.json({ success: true, balance: Number(req.user.balance) || 0, currency: 'USD' });
}));

// ---------- catalogue ----------

// GET /api/v1/services — enabled services with inventory
router.get('/services', wrap(async (req, res) => {
  const services = await db.listServices();
  res.json({
    success: true,
    count: services.filter((s) => s.status === 'enabled').length,
    services: services.filter((s) => s.status === 'enabled').map((s) => ({
      platform: s.platform,
      country: s.country,
      price: Number(s.price) || 0,
      count: s.available_count || 0,           // available numbers right now
      avgTimeSec: s.avg_time_sec,              // avg OTP wait (completed orders)
    })),
  });
}));

// GET /api/v1/inventory — per platform/country availability
router.get('/inventory', wrap(async (req, res) => {
  const services = await db.listServices();
  const platforms = [...new Set(services.map((s) => s.platform))];
  const countries = [...new Set(services.map((s) => s.country))];
  res.json({
    success: true,
    platforms: platforms.map((p) => ({
      name: p,
      services: services.filter((s) => s.platform === p && s.status === 'enabled')
        .map((s) => ({ country: s.country, count: s.available_count || 0, price: Number(s.price) || 0 })),
    })),
    countries: countries.map((c) => ({
      name: c,
      count: services.filter((s) => s.country === c && s.status === 'enabled')
        .reduce((a, s) => a + (s.available_count || 0), 0),
    })),
  });
}));

// ---------- purchase & otp ----------

// POST /api/v1/getNumber — buy a number (balance deducted, OTP pulling starts)
router.post('/getNumber', buyL, wrap(async (req, res) => {
  const { platform, country } = req.body || {};
  const order = await purchase(req.userId, platform, country);
  poller.triggerImmediatePoll();
  const user = await db.getUserById(req.userId);
  res.json({
    success: true,
    orderId: order.order_id,
    number: order.number,
    platform: order.platform,
    country: order.country,
    price: Number(order.price) || 0,
    balance: Number(user.balance) || 0,
    status: 'pending',                        // pulling started automatically
    expiresInSec: Math.floor(config.otpExpireMs / 1000),
    createdAt: order.created_at,
    tip: 'Call GET /api/v1/otp/' + order.order_id + ' to receive the OTP',
  });
}));

// POST /api/v1/getNumber/sync — buy + wait up to `wait` seconds for the OTP
router.post('/getNumber/sync', buyL, wrap(async (req, res) => {
  const { platform, country } = req.body || {};
  const wait = Math.min(60, Math.max(1, parseInt(req.query.wait || req.body.wait, 10) || 30));
  const order = await purchase(req.userId, platform, country);
  const deadline = Date.now() + wait * 1000;
  let current = order;
  while (Date.now() < deadline) {
    await poller.pollOnce().catch(() => {});
    current = await db.getOrderByOrderId(order.order_id);
    if (current.status !== 'pending') break;
    await sleep(800);
  }
  if (current.status === 'completed') {
    const user = await db.getUserById(req.userId);
    return res.json({
      success: true,
      orderId: order.order_id,
      number: order.number,
      platform: order.platform,
      country: order.country,
      price: Number(order.price) || 0,
      status: 'completed',
      otp: current.otp_code,
      otpMessage: current.otp_message || '',
      otpTime: current.otp_time,
      balance: Number(user.balance) || 0,
    });
  }
  res.json({
    success: false,
    orderId: order.order_id,
    number: order.number,
    status: current.status,
    balance: (await db.getUserById(req.userId)).balance,
    message: current.status === 'pending'
      ? 'OTP not received yet. Poll GET /api/v1/otp/' + order.order_id
      : 'Order ' + current.status,
  });
}));

// GET /api/v1/otp/:orderId — wait (long-poll) until OTP arrives, then return it
router.get('/otp/:orderId', otpL, wrap(async (req, res) => {
  const order = await db.getOrderByOrderId(String(req.params.orderId).trim());
  if (!order) return fail(res, new AppError('Order not found', 404));
  if (order.user_id !== req.userId) return fail(res, new AppError('Not your order', 403));

  const want = parseInt(req.query.wait, 10);
  const wait = Math.min(60, isNaN(want) ? 30 : Math.max(1, want));
  const deadline = Date.now() + wait * 1000;
  let current = order;
  while (Date.now() < deadline) {
    await poller.pollOnce().catch(() => {});
    current = await db.getOrderByOrderId(order.order_id);
    if (current.status !== 'pending') break;
    await sleep(800);
  }
  if (current.status === 'completed') {
    return res.json({
      success: true,
      status: 'completed',
      orderId: current.order_id,
      number: current.number,
      otp: current.otp_code,
      otpMessage: current.otp_message || '',
      otpTime: current.otp_time,
      price: Number(current.price) || 0,
    });
  }
  res.json({
    success: false,
    status: current.status,
    orderId: current.order_id,
    number: current.number,
    otp: '',
    message: current.status === 'pending'
      ? 'No OTP yet. Keep polling this endpoint.'
      : 'Order ' + current.status + '. No OTP.',
  });
}));

// GET /api/v1/order/:orderId — status of one order
router.get('/order/:orderId', wrap(async (req, res) => {
  await poller.pollOnce().catch(() => {});
  const order = await db.getOrderByOrderId(String(req.params.orderId).trim());
  if (!order) return fail(res, new AppError('Order not found', 404));
  if (order.user_id !== req.userId) return fail(res, new AppError('Not your order', 403));
  res.json({
    success: true,
    order: {
      orderId: order.order_id, number: order.number, platform: order.platform,
      country: order.country, price: Number(order.price) || 0, status: order.status,
      otp: order.otp_code || '', otpMessage: order.otp_message || '',
      otpTime: order.otp_time || null, pullCount: order.pull_count || 0,
      createdAt: order.created_at, completedAt: order.completed_at || null,
      cancelledAt: order.cancelled_at || null,
    },
  });
}));

// GET /api/v1/orders — all orders of the user
router.get('/orders', wrap(async (req, res) => {
  await poller.pollOnce().catch(() => {});
  const orders = await db.getOrdersByUser(req.userId);
  res.json({
    success: true,
    count: orders.length,
    orders: orders.map((o) => ({
      orderId: o.order_id, number: o.number, platform: o.platform, country: o.country,
      price: Number(o.price) || 0, status: o.status, otp: o.otp_code || '',
      otpTime: o.otp_time || null, pullCount: o.pull_count || 0,
      createdAt: o.created_at,
    })),
  });
}));

// POST /api/v1/cancelOrder/:orderId — cancel pending order (refund + number back)
router.post('/cancelOrder/:orderId', cancelV1L, wrap(async (req, res) => {
  const order = await db.getOrderByOrderId(String(req.params.orderId).trim());
  if (!order) return fail(res, new AppError('Order not found', 404));
  if (order.user_id !== req.userId) return fail(res, new AppError('Not your order', 403));
  if (order.status === 'completed') return fail(res, new AppError('OTP already received - order cannot be cancelled', 400));
  if (order.status !== 'pending') return fail(res, new AppError('Order is already ' + order.status, 400));

  await db.updateOrder(order.id, { status: 'cancelled', cancelled_at: db.now() });
  await db.addBalance(req.userId, Number(order.price) || 0);
  await db.addWalletEntry({
    userId: req.userId, amount: Number(order.price) || 0, type: 'refund',
    note: `Refund — ${order.order_id}`,
  });
  await db.setNumberStatus(order.number_id, 'available');
  const user = await db.getUserById(req.userId);
  res.json({
    success: true,
    orderId: order.order_id, status: 'cancelled',
    refunded: Number(order.price) || 0, balance: Number(user.balance) || 0,
  });
}));

module.exports = router;