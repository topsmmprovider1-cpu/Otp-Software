const express = require('express');
const db = require('../db');

const router = express.Router();

// Public site settings (site name, currency, payment availability)
router.get('/settings', async (req, res) => {
  res.json(await db.publicSettings());
});

// Payment settings for the wallet page (without any secrets)
router.get('/payment', async (req, res) => {
  const s = await db.getAllSettings();
  res.json({
    enabled: (await db.publicSettings()).paymentEnabled,
    mode: s.paymentMode === 'qr' ? 'qr' : 'upi',
    qr: s.paymentMode === 'qr' ? (s.paymentQr || '') : '',
    upiId: s.paymentUpiId || '',
    merchantName: s.paymentMerchantName || '',
    min: parseFloat(s.paymentMin || '0') || 0,
    feePct: parseFloat(s.paymentFeePct || '0') || 0,
    currency: s.currency || 'USD',
    instructions: s.paymentInstructions || '',
  });
});

// Grouped services list: platform -> countries -> price/count (only available numbers)
router.get('/services', async (req, res) => {
  try {
    const numbers = await db.listNumbers();
    const services = await db.listServices();
    const enabled = new Set(services.filter((s) => s.status === 'enabled').map((s) => `${s.platform}\u0000${s.country}`));
    const map = new Map(); // platform -> Map(country -> {price, count})
    for (const n of numbers) {
      if (n.status !== 'available') continue;
      if (services.length && !enabled.has(`${n.platform}\u0000${n.country}`)) continue;
      if (!map.has(n.platform)) map.set(n.platform, new Map());
      const cm = map.get(n.platform);
      if (!cm.has(n.country)) cm.set(n.country, { price: Number(n.price) || 0, count: 0 });
      cm.get(n.country).count++;
    }
    const platforms = [];
    for (const [platform, cm] of map) {
      const countries = [];
      for (const [country, info] of cm) {
        countries.push({ country, price: info.price, count: info.count });
      }
      countries.sort((a, b) => a.price - b.price);
      platforms.push({ platform, countries });
    }
    platforms.sort((a, b) => a.platform.localeCompare(b.platform));
    // top countries with max count for landing page stats
    const countryCount = new Map();
    for (const p of platforms) for (const c of p.countries) {
      countryCount.set(c.country, (countryCount.get(c.country) || 0) + c.count);
    }
    const countries = [...countryCount.entries()].map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
    res.json({ platforms, countries });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;