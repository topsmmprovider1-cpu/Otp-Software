const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const db = require('./db');
const { seedAdmin } = require('./seed');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// URL rebase: when the app is mounted under a subpath (e.g. /otp),
// every absolute app link (HTML attrs + quoted JS strings) gets the prefix,
// so navigation, assets and /api calls all stay under the mount path.
const BP = config.basePath ? '/' + config.basePath : '';
const REBASE_EXTS = /\.(html?|js)$/i;
const SEG_ALLOW = /^(app|admin|admin-login|login|register|js|styles|api|images)$/i;

function rebaseText(text) {
  if (!BP) return text;
  // HTML/JS attributes:  href="/x"  src="/x"  action="/x"
  text = text.replace(/((?:href|src|action)\s*=\s*["'])\/(?!\/)/g, '$1' + BP + '/');
  // Quoted JS/HTML strings that start with a known app path segment:  '/app/x', '/login?x'
  text = text.replace(/(["'])\/(?!\/)([a-zA-Z0-9_./?#=&%-]*)/g, (m, q, tail) => {
    const seg = tail.split(/[/?#.]/)[0];
    return SEG_ALLOW.test(seg) ? q + BP + '/' + tail : m;
  });
  // Bare root strings:  '/'  (home / redirect targets)
  text = text.replace(/(["'])\/(["'])/g, '$1' + BP + '/$2');
  return text;
}

function sendWithRebase(file, res) {
  const ext = path.extname(file).toLowerCase();
  if (!BP || !REBASE_EXTS.test(ext)) return res.sendFile(file);
  let body;
  try { body = fs.readFileSync(file, 'utf8'); } catch (e) { return res.sendFile(file); }
  res.type(ext || 'text/plain').send(rebaseText(body));
}

function buildInner() {
  const app = express();

  app.use('/api/v1', require('./routes/api-v1'));
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/me', require('./routes/me'));
  app.use('/api/orders', require('./routes/orders'));
  app.use('/api/payments', require('./routes/payments'));
  app.use('/api/tickets', require('./routes/tickets'));
  app.use('/api/admin', require('./routes/admin'));
  app.use('/api', require('./routes/shop'));
  app.use('/api/shop', require('./routes/shop'));

  // ---- clean (extensionless) URLs: /app/orders  ->  /app/orders.html ----
  app.use((req, res, next) => {
    const p = decodeURIComponent(req.path || '/');
    if (p === '/' || p.startsWith('/api') || p.includes('.')) return next();
    const file = path.join(PUBLIC_DIR, p + '.html');
    const dirFile = path.join(PUBLIC_DIR, p, 'index.html');
    if (fs.existsSync(file)) return sendWithRebase(file, res);
    if (fs.existsSync(dirFile)) return sendWithRebase(dirFile, res);
    next();
  });

  // legacy: redirect any requested *.html page to its clean URL
  app.use((req, res, next) => {
    if (!/\.html$/.test(req.path)) return next();
    const clean = req.path.slice(0, -5) || '/';
    const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    res.redirect(301, clean + qs);
  });

  // static files (html/js rewritten for the mount path, everything else streamed)
  app.use((req, res, next) => {
    const p = decodeURIComponent(req.path || '/');
    const file = path.join(PUBLIC_DIR, p);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return next();
    return sendWithRebase(file, res);
  });

  app.get(['/admin-login', '/admin-login.html'], (req, res) => {
    sendWithRebase(path.join(PUBLIC_DIR, 'admin-login.html'), res);
  });

  app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
    sendWithRebase(path.join(PUBLIC_DIR, 'index.html'), res);
  });

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: err.message || 'Server error' });
  });

  return app;
}

function buildApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));

  if (BP) {
    // root -> subpath, and anything outside the subpath -> subpath
    app.get('/', (req, res) => res.redirect(302, BP + '/'));
    app.use(BP, buildInner());
    app.use((req, res) => res.redirect(302, BP + '/'));
  } else {
    app.use(buildInner());
  }

  return app;
}

async function init() {
  await db.init();
  await seedAdmin();
  return buildApp();
}

module.exports = { init, buildApp, seedAdmin, rebaseText };