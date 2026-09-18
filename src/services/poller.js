const config = require('../config');
const db = require('../db');
const { fetchSms } = require('./sms');

let running = false;
let queuedRerun = false;
let timer = null;
let lastRunAt = null;
let errorLog = [];

function state() {
  return { running, lastRunAt, errors: errorLog.slice(-5) };
}

async function pollSingleOrder(order) {
  if (!order || order.status !== 'pending') return null;

  const age = Date.now() - new Date(order.created_at).getTime();
  const expireLimitMs = typeof config.otpExpireMs === 'number' ? config.otpExpireMs : (20 * 60 * 1000);

  // Expire old pending orders and return the number to inventory
  if (age > expireLimitMs) {
    const nid = order.number_id;
    await db.updateOrder(order.id, { status: 'expired', completed_at: db.now() });
    if (nid) await db.setNumberStatus(nid, 'available');
    await db.addBalance(order.user_id, Number(order.price) || 0);
    await db.addWalletEntry({
      userId: order.user_id, amount: Number(order.price) || 0, type: 'refund',
      note: `Expired — ${order.order_id} (no OTP)`,
    });
    console.log(`[poller] order #${order.order_id} expired (no OTP), ${Number(order.price) || 0} refunded`);
    return { status: 'expired' };
  }

  let targetApiUrl = String(order.api_url || '').trim();
  if (!targetApiUrl && order.platform && order.country) {
    try {
      const svc = await db.getService(order.platform, order.country);
      if (svc && svc.api_url) targetApiUrl = String(svc.api_url).trim();
    } catch (se) { /* ignore */ }
  }

  const result = await fetchSms(targetApiUrl, order.number);
  if (result.ok) {
    await db.updateOrder(order.id, {
      status: 'completed',
      otp_code: result.otp,
      otp_message: result.message,
      otp_time: db.now(),
      completed_at: db.now(),
      pull_count: (order.pull_count || 0) + 1,
    });
    try {
      await db.addOtpLog({
        orderId: order.id, number: order.number,
        code: result.otp, message: result.message,
      });
    } catch (e) { console.warn('[poller] addOtpLog error:', e.message); }
    try {
      await db.addPullLog({
        orderId: order.id, number: order.number, result: 'ok',
        message: `OTP received: ${result.otp}${result.message ? ' — ' + result.message : ''}`,
      });
    } catch (e) { console.warn('[poller] addPullLog error:', e.message); }
    console.log(`[poller] OTP ${result.otp} received for order #${order.order_id}`);
    return { status: 'completed', otp: result.otp, message: result.message };
  } else {
    await db.updateOrder(order.id, { pull_count: (order.pull_count || 0) + 1 });
    try {
      await db.addPullLog({
        orderId: order.id, number: order.number, result: result.error ? 'error' : 'no_otp',
        message: result.message || (result.error ? `Error: ${result.error}` : 'No OTP yet'),
      });
    } catch (e) { console.warn('[poller] addPullLog error:', e.message); }
    return { status: 'pending', pull_count: (order.pull_count || 0) + 1 };
  }
}

async function pollOnce() {
  if (running) {
    queuedRerun = true;
    return;
  }
  running = true;
  try {
    const pending = await db.listPendingOrders();
    if (pending && pending.length > 0) {
      // Process pending orders concurrently (up to 10 parallel requests)
      const CONCURRENCY = 10;
      for (let i = 0; i < pending.length; i += CONCURRENCY) {
        const chunk = pending.slice(i, i + CONCURRENCY);
        await Promise.allSettled(chunk.map((o) => pollSingleOrder(o)));
      }
    }
  } catch (err) {
    console.error('[poller] error:', err.message);
    errorLog.push({ at: new Date().toISOString(), msg: err.message });
    if (errorLog.length > 20) errorLog.shift();
  } finally {
    running = false;
    lastRunAt = new Date().toISOString();
    if (queuedRerun) {
      queuedRerun = false;
      setImmediate(() => pollOnce());
    }
  }
}

function triggerImmediatePoll() {
  setImmediate(() => pollOnce());
}

function start() {
  if (timer) return;
  const pollIntervalMs = config.pollIntervalMs || 3000;
  console.log(`[poller] continuous background engine started (every ${pollIntervalMs}ms)`);
  pollOnce();
  timer = setInterval(pollOnce, pollIntervalMs);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, pollOnce, pollSingleOrder, triggerImmediatePoll, state };