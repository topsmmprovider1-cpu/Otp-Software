const express = require('express');
const https = require('https');
const db = require('../db');
const config = require('../config');
const { auth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');

const router = express.Router();
router.use(auth);

const payL = rateLimit({
  windowMs: 60 * 1000, max: 5,
  message: 'Too many payment verification attempts. Please wait a minute.',
});

const BHARATPE_HOST = 'payments-tesseract.bharatpe.in';
const BHARATPE_PATH = '/api/v1/merchant/transactions';

// In-memory set to prevent concurrent duplicate verification requests
const processingUtrs = new Set();

// Live INR to USD Exchange Rate Cache (30 min TTL)
let cachedUsdInrRate = null;
let lastRateFetchTime = 0;

async function getLiveInrToUsdRate(fallbackRate = 0.012) {
  const now = Date.now();
  if (cachedUsdInrRate && (now - lastRateFetchTime < 30 * 60 * 1000)) {
    return 1 / cachedUsdInrRate;
  }
  try {
    const data = await new Promise((resolve, reject) => {
      const req = https.get('https://open.er-api.com/v6/latest/USD', { timeout: 5000 }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('Exchange rate API timeout')));
    });

    if (data && data.result === 'success' && data.rates && data.rates.INR) {
      const usdInr = parseFloat(data.rates.INR);
      if (usdInr > 0) {
        cachedUsdInrRate = usdInr;
        lastRateFetchTime = now;
        console.log(`[payments] Live exchange rate updated: 1 USD = ₹${usdInr} INR (1 INR = $${(1 / usdInr).toFixed(6)} USD)`);
        return 1 / usdInr;
      }
    }
  } catch (e) {
    console.warn('[payments] Failed to fetch live exchange rate, using fallback rate:', e.message);
  }
  return cachedUsdInrRate ? (1 / cachedUsdInrRate) : fallbackRate;
}

// Minimal GET with timeout via node:https
function httpsGetJson(url, headers, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`BharatPe API error (HTTP ${res.statusCode}). Check your BharatPe Merchant ID and Token.`));
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Invalid response from BharatPe gateway (HTTP ${res.statusCode}). Token or Merchant ID may be expired.`)); }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('Payment gateway timeout')); });
    req.on('error', (err) => reject(new Error('Payment gateway connection error: ' + err.message)));
  });
}

function normUtr(str) {
  if (!str) return '';
  return String(str).trim().toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^0+/, '');
}

// Fetch recent transactions from BharatPe and find a match for the UTR
async function verifyUtr(merchantId, token, utr, proxyUrl = '') {
  // Use +2 days buffer for eDate to avoid UTC vs IST timezone cutoff (e.g. late night payments)
  const eDateObj = new Date(Date.now() + 2 * 24 * 3600 * 1000);
  const sDateObj = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const fmt = (x) => x.toISOString().slice(0, 10);
  const cleanMerchantId = String(merchantId || '').trim();
  const cleanToken = String(token || '').trim().replace(/^Bearer\s+/i, '');

  let targetUrl = `https://${BHARATPE_HOST}${BHARATPE_PATH}?module=PAYMENT_QR&merchantId=${encodeURIComponent(cleanMerchantId)}&sDate=${fmt(sDateObj)}&eDate=${fmt(eDateObj)}`;
  if (proxyUrl && proxyUrl.trim().startsWith('http')) {
    const p = proxyUrl.trim();
    targetUrl = p + (p.includes('?') ? '&' : '?') + 'url=' + encodeURIComponent(targetUrl);
  }
  
  const headers = {
    'token': cleanToken,
    'user-agent': 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36',
  };

  const data = await httpsGetJson(targetUrl, headers);
  const list = data && data.data && Array.isArray(data.data.transactions) ? data.data.transactions : [];
  
  const searchRaw = String(utr || '').trim().toLowerCase();
  const searchNorm = normUtr(utr);
  const searchStripped = searchRaw.replace(/^0+/, '');
  if (!searchRaw && !searchNorm) return null;

  return list.find((t) => {
    const refRaw = String(t.bankReferenceNo || '').trim().toLowerCase();
    const utrRaw = String(t.utr || t.rrn || '').trim().toLowerCase();
    const idRaw = String(t.id || '').trim().toLowerCase();
    const internalRaw = String(t.internalUtr || '').trim().toLowerCase();

    const refNorm = normUtr(t.bankReferenceNo);
    const utrNorm = normUtr(t.utr || t.rrn);
    const idNorm = normUtr(t.id);
    const internalNorm = normUtr(t.internalUtr);

    return (searchNorm && (refNorm === searchNorm || utrNorm === searchNorm || idNorm === searchNorm || internalNorm.includes(searchNorm))) ||
           (searchStripped && (refRaw.replace(/^0+/, '') === searchStripped || utrRaw.replace(/^0+/, '') === searchStripped || idRaw.replace(/^0+/, '') === searchStripped)) ||
           (searchRaw && (refRaw === searchRaw || utrRaw === searchRaw || idRaw === searchRaw || (internalRaw && internalRaw.includes(searchRaw)) || (refRaw && refRaw.includes(searchRaw)) || (searchRaw && searchRaw.includes(refRaw))));
  }) || null;
}

// GET /api/payments — this user's payment history
router.get('/', async (req, res) => {
  try {
    const payments = await db.listPaymentsForUser(req.userId);
    res.json({ payments: payments.map((p) => ({
      id: p.id, utr: p.utr, amount: Number(p.amount) || 0, method: p.method,
      status: p.status, credit: Number(p.credit) || 0, note: p.note || '',
      createdAt: p.created_at, verifiedAt: p.verified_at || null,
    })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/payments/verify — { utr, amount } → verify via BharatPe and credit
router.post('/verify', payL, async (req, res) => {
  const rawUtr = String((req.body || {}).utr || '').trim();
  const cleanUtr = rawUtr.replace(/[^a-zA-Z0-9]/g, '');
  const strippedUtr = cleanUtr.replace(/^0+/, '');
  const lockKey = strippedUtr || cleanUtr;

  if (!cleanUtr) return res.status(400).json({ error: 'Enter a valid UTR ID / Transaction Reference' });

  if (processingUtrs.has(lockKey)) {
    return res.status(400).json({ error: 'Payment verification is already in progress for this UTR. Please wait.' });
  }

  processingUtrs.add(lockKey);

  try {
    const settings = await db.getAllSettings();
    if (String(settings.paymentEnabled) !== '1') {
      return res.status(400).json({ error: 'Online deposits are currently disabled. Please contact support.' });
    }
    const merchantId = String(settings.bharatpeMerchantId || '').trim();
    const token = String(settings.bharatpeToken || '').trim();
    if (!merchantId || !token) {
      return res.status(400).json({ error: 'Payment gateway is not configured by the admin yet.' });
    }

    const amount = parseFloat((req.body || {}).amount);
    if (!amount || amount <= 0 || isNaN(amount)) return res.status(400).json({ error: 'Enter a valid amount you paid' });

    const limit = parseFloat(String(settings.paymentMin || '0'));
    if (amount < limit) return res.status(400).json({ error: `Minimum deposit is ${fmtMin(settings)}` });

    // Strict duplicate check across raw, stripped, and zero-prefixed candidates
    const dup = await db.getPaymentByUtr(cleanUtr);
    if (dup && dup.status === 'approved') {
      return res.status(400).json({ error: 'This UTR has already been used and approved.' });
    }

    // Determine exchange rate (Live rate for USD vs 1.0 for INR)
    const isSiteInr = String(settings.currency || 'USD') === 'INR';
    const fallbackRate = parseFloat(settings.paymentRateInrUsd || '0.012');
    const rate = isSiteInr ? 1.0 : await getLiveInrToUsdRate(fallbackRate);

    let tx = null;
    try {
      const proxyUrl = String(settings.bharatpeProxyUrl || '').trim();
      tx = await verifyUtr(merchantId, token, cleanUtr, proxyUrl);
    } catch (e) {
      console.warn('[payments] BharatPe gateway API error:', e.message);
      // Fallback: save payment as pending so admin can verify & approve in 1 click from Admin Panel
      const credit = amount * rate;
      const existing = await db.getPaymentByUtr(cleanUtr);
      if (!existing) {
        await db.createPayment({
          userId: req.userId, utr: cleanUtr, amount,
          method: 'BharatPe', credit, status: 'pending', ip: req.ip || '',
          note: `Pending review (Gateway: ${e.message})`,
        });
      }
      return res.status(200).json({
        success: true,
        pending: true,
        msg: `UTR ${cleanUtr} submitted successfully! Your deposit is pending admin approval and will be credited shortly.`,
        utr: cleanUtr,
      });
    }

    if (!tx) return res.status(400).json({ error: 'UTR not found. Please check the UTR or the merchant account used for payment.' });
    if (String(tx.status || '').toUpperCase() !== 'SUCCESS') {
      return res.status(400).json({ error: 'Payment status is not successful. Please try again later.' });
    }

    const paidTxAmount = parseFloat(tx.amount);
    if (Math.abs(paidTxAmount - amount) > 0.01) {
      return res.status(400).json({ error: `The amount entered (₹${amount}) does not match the actual paid amount (₹${paidTxAmount}).` });
    }

    // Success — compute wallet credit after optional fee percentage
    let netPaidInr = paidTxAmount;
    const feePct = parseFloat(settings.paymentFeePct || '0');
    if (feePct > 0) netPaidInr = netPaidInr * (1 - feePct / 100);
    const credit = netPaidInr * rate;

    // Second atomic check before balance credit
    const existing = await db.getPaymentByUtr(cleanUtr);
    if (existing && existing.status === 'approved') {
      return res.status(400).json({ error: 'This UTR has already been processed and approved.' });
    }

    if (existing && existing.status !== 'approved') {
      // Reuse pending/rejected record and mark approved
      await db.updatePayment(existing.id, { status: 'approved', credit, verified_at: db.now() });
    } else {
      await db.createPayment({
        userId: req.userId, utr: cleanUtr, amount: paidTxAmount,
        method: 'BharatPe', credit, status: 'approved', ip: req.ip || '',
        note: `Payment of ${fmtAmount(paidTxAmount)} INR (${fmtCredit(credit, settings)})`,
      });
    }

    await db.addBalance(req.userId, credit);
    await db.addWalletEntry({
      userId: req.userId, amount: credit, type: 'deposit',
      note: `BharatPe deposit (${cleanUtr})`,
    });

    const user = await db.getUserById(req.userId);
    res.json({
      success: true,
      msg: `Payment verified! ${fmtCredit(credit, settings)} credited to your wallet.`,
      credit, utr: cleanUtr, balance: Number(user.balance) || 0,
    });
  } catch (e) {
    console.error('[payments]', e);
    res.status(500).json({ error: e.message });
  } finally {
    processingUtrs.delete(lockKey);
  }
});

function fmtMin(s) { const c = cur(s); return c + (parseFloat(s.paymentMin || '0') || 0).toFixed(2); }
function cur(s) { return String(s.currency || 'USD') === 'INR' ? '₹' : '$'; }
function fmtAmount(n) { return Number(n).toFixed(2); }
function fmtCredit(n, s) { return String(s.currency || 'USD') === 'INR' ? '₹' + Number(n).toFixed(2) : '$' + Number(n).toFixed(2) + ' USD'; }

module.exports = router;