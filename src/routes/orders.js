const express = require('express');
const db = require('../db');
const config = require('../config');
const { auth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');
const { purchase, AppError } = require('../services/purchase');
const poller = require('../services/poller');

const router = express.Router();
router.use(auth);

const rl = config.rateLimit;
const buyL = rateLimit({ windowMs: rl.purchase.windowMs, max: rl.purchase.max, message: 'Purchase rate limit reached. Please wait before buying again.' });
const cancelL = rateLimit({ windowMs: rl.cancel.windowMs, max: rl.cancel.max, message: 'Too many cancel requests. Please try again shortly.' });

const { sanitizeOtpMessage } = require('../helpers');

// public order shape (no api_url leaked to client)
const pub = (o) => ({
  id: o.id,
  orderId: o.order_id,
  number: o.number,
  country: o.country,
  platform: o.platform,
  price: o.price,
  status: o.status,
  otpCode: o.otp_code || '',
  otpMessage: sanitizeOtpMessage(o.otp_message || ''),
  otpTime: o.otp_time || null,
  expiresInMs: (o.status === 'pending')
    ? Math.max(0, config.otpExpireMs - (Date.now() - new Date(o.created_at).getTime()))
    : 0,
  createdAt: o.created_at,
  completedAt: o.completed_at || null,
  cancelledAt: o.cancelled_at || null,
});

function canCancelGood(order) {
  return order.status === 'pending' && !(order.otp_code && String(order.otp_code).length);
}

router.post('/', buyL, async (req, res) => {
  try {
    const order = await purchase(req.userId, req.body.platform, req.body.country);
    // Wake up backend continuous poller immediately (0ms latency)
    poller.triggerImmediatePoll();
    res.json({ order: pub(order) });
  } catch (e) {
    if (e instanceof AppError) return res.status(e.status).json({ error: e.message, ...e.extra });
    res.status(500).json({ error: e.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const orders = await db.getOrdersByUser(req.userId);
    res.json({ orders: orders.map(pub) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const order = await db.getOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.user_id !== req.userId && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not your order' });
    }
    res.json({ order: pub(order) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/poll-now', async (req, res) => {
  try {
    const order = await db.getOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.user_id !== req.userId && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not your order' });
    }
    if (order.status === 'pending') {
      await poller.pollSingleOrder(order);
    }
    const updated = await db.getOrderById(order.id);
    res.json({ order: pub(updated) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/cancel', cancelL, async (req, res) => {
  try {
    const order = await db.getOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.user_id !== req.userId && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not your order' });
    }
    if (!canCancelGood(order)) {
      return res.status(400).json({
        error: order.status === 'completed'
          ? 'OTP already received - order cannot be cancelled'
          : 'Order can only be cancelled while waiting for OTP',
      });
    }
    await db.updateOrder(order.id, { status: 'cancelled', cancelled_at: db.now() });
    // refund + return number to inventory
    await db.addBalance(req.userId, Number(order.price) || 0);
    await db.addWalletEntry({
      userId: req.userId, amount: Number(order.price) || 0, type: 'refund',
      note: `Refund — ${order.order_id}`,
    });
    await db.setNumberStatus(order.number_id, 'available');
    const updated = await db.getOrderById(order.id);
    res.json({ order: pub(updated), refunded: Number(order.price) || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;