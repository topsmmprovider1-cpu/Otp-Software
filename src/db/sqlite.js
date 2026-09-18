const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const config = require('../config');

const file = path.resolve(config.sqliteFile);
fs.mkdirSync(path.dirname(file), { recursive: true });

const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

const now = () => new Date().toISOString();

function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name     TEXT NOT NULL,
      email         TEXT NOT NULL UNIQUE,
      phone         TEXT,
      password_hash TEXT NOT NULL,
      balance       REAL NOT NULL DEFAULT 0,
      role          TEXT NOT NULL DEFAULT 'user',
      is_active     INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS numbers (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      number     TEXT NOT NULL,
      country    TEXT NOT NULL,
      platform   TEXT NOT NULL,
      price      REAL NOT NULL DEFAULT 0,
      api_url    TEXT NOT NULL DEFAULT '',
      status     TEXT NOT NULL DEFAULT 'available',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_numbers_find ON numbers(status, country, platform);
    CREATE TABLE IF NOT EXISTS orders (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id     TEXT NOT NULL UNIQUE,
      user_id      INTEGER NOT NULL,
      number_id    INTEGER NOT NULL,
      number       TEXT NOT NULL,
      country      TEXT NOT NULL,
      platform     TEXT NOT NULL,
      price        REAL NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pending',
      otp_code     TEXT,
      otp_message  TEXT,
      otp_time     TEXT,
      pull_count   INTEGER NOT NULL DEFAULT 0,
      api_url      TEXT NOT NULL DEFAULT '',
      created_at   TEXT NOT NULL,
      completed_at TEXT,
      cancelled_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE TABLE IF NOT EXISTS otp_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id   INTEGER,
      number     TEXT,
      code       TEXT,
      message    TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_otp_logs_order ON otp_logs(order_id);
    CREATE TABLE IF NOT EXISTS platforms (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
CREATE TABLE IF NOT EXISTS countries (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS services (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      platform   TEXT NOT NULL,
      country    TEXT NOT NULL,
      price      REAL NOT NULL DEFAULT 0,
      api_url    TEXT NOT NULL DEFAULT '',
      status     TEXT NOT NULL DEFAULT 'enabled',
      created_at TEXT NOT NULL,
      UNIQUE(platform, country)
    );
    CREATE INDEX IF NOT EXISTS idx_services_status ON services(status);
    CREATE TABLE IF NOT EXISTS api_keys (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      api_key    TEXT NOT NULL UNIQUE,
      label      TEXT NOT NULL DEFAULT 'Default',
      last_used  TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
    CREATE TABLE IF NOT EXISTS tickets (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      subject    TEXT NOT NULL,
      category   TEXT NOT NULL DEFAULT 'general',
      status     TEXT NOT NULL DEFAULT 'open',
      priority   TEXT NOT NULL DEFAULT 'normal',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(user_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
    CREATE TABLE IF NOT EXISTS ticket_messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id     INTEGER NOT NULL,
      sender_id     INTEGER,
      sender_role   TEXT NOT NULL DEFAULT 'user',
      message       TEXT NOT NULL,
      created_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tm_ticket ON ticket_messages(ticket_id);
    CREATE TABLE IF NOT EXISTS wallet_entries (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      amount     REAL NOT NULL,
      type       TEXT NOT NULL DEFAULT 'adjustment',
      note       TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wallet_user ON wallet_entries(user_id);
    CREATE TABLE IF NOT EXISTS order_pull_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id   INTEGER NOT NULL,
      number     TEXT,
      result     TEXT NOT NULL DEFAULT 'poll',
      message    TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pull_logs_order ON order_pull_logs(order_id);
    CREATE TABLE IF NOT EXISTS payments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      utr         TEXT NOT NULL UNIQUE,
      amount      REAL NOT NULL,
      method      TEXT NOT NULL DEFAULT 'BharatPe',
      status      TEXT NOT NULL DEFAULT 'pending',
      credit      REAL NOT NULL DEFAULT 0,
      ip          TEXT,
      note        TEXT,
      created_at  TEXT NOT NULL,
      verified_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
    CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL,
      role         TEXT NOT NULL DEFAULT 'user',
      token_hash   TEXT NOT NULL UNIQUE,
      device_fp    TEXT,
      device_name  TEXT,
      ip           TEXT,
      user_agent   TEXT,
      is_active    INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      expires_at   TEXT NOT NULL,
      revoked_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_hash ON sessions(token_hash);
    CREATE TABLE IF NOT EXISTS login_activity (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      type        TEXT NOT NULL,
      detail      TEXT,
      device_fp   TEXT,
      device_name TEXT,
      ip          TEXT,
      user_agent  TEXT,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_activity_user ON login_activity(user_id);
  `);
  // seed master platform/country rows from any existing numbers
  for (const row of all('SELECT DISTINCT platform AS platform, country AS country FROM numbers')) {
    if (row.platform) addPlatform(row.platform);
    if (row.country) addCountry(row.country);
  }
  seedServicesFromNumbers();
}

// ---------- helpers ----------
function get(sql, params = []) { return db.prepare(sql).get(...params); }
function all(sql, params = []) { return db.prepare(sql).all(...params); }
function run(sql, params = []) { return db.prepare(sql).run(...params); }

const COL_MAP = { fullName: 'full_name', isActive: 'is_active', createdAt: 'created_at' };
function updateGeneric(table, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const set = keys.map((k) => `${COL_MAP[k] || k} = ?`).join(', ');
  const params = keys.map((k) => (typeof fields[k] === 'boolean' ? (fields[k] ? 1 : 0) : fields[k]));
  run(`UPDATE ${table} SET ${set} WHERE id = ?`, [...params, id]);
}

// ---------- users ----------
function createUser({ fullName, email, phone, passwordHash, role = 'user', balance = 0 }) {
  const t = now();
  run(
    'INSERT INTO users (full_name, email, phone, password_hash, role, balance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [fullName, email, phone || null, passwordHash, role, balance, t]
  );
  return getUserByEmail(email);
}
function getUserByEmail(email) { return get('SELECT * FROM users WHERE email = ?', [email]); }
function getUserById(id) { return get('SELECT * FROM users WHERE id = ?', [id]); }
function updateUser(id, fields) { updateGeneric('users', id, fields); return getUserById(id); }
function listUsers() { return all('SELECT * FROM users ORDER BY id DESC'); }
function addBalance(id, amount) { run('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, id]); }

// ---------- numbers ----------
function insertNumbers(rows) {
  const stmt = db.prepare(
    'INSERT INTO numbers (number, country, platform, price, api_url, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  db.exec('BEGIN');
  let n = 0;
  try {
    for (const r of rows) {
      stmt.run(r.number, r.country, r.platform, r.price, r.api_url || '', now());
      n++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return n;
}
function listNumbers() { return all('SELECT * FROM numbers ORDER BY id DESC'); }
function getNumberById(id) { return get('SELECT * FROM numbers WHERE id = ?', [id]); }
function setNumberStatus(id, status) { run('UPDATE numbers SET status = ? WHERE id = ?', [status, id]); }
function updateNumber(id, fields) { updateGeneric('numbers', id, fields); return getNumberById(id); }

function allocateNumber(platform, country) {
  // atomically pick one free number and mark it sold
  db.exec('BEGIN IMMEDIATE');
  try {
    // prefer numbers with an api_url so OTP auto-pulling works
    let row = get(
      "SELECT * FROM numbers WHERE platform = ? AND country = ? AND status = 'available' AND api_url != '' ORDER BY id LIMIT 1",
      [platform, country]
    );
    if (!row) {
      row = get(
        "SELECT * FROM numbers WHERE platform = ? AND country = ? AND status = 'available' ORDER BY id LIMIT 1",
        [platform, country]
      );
    }
    if (!row) {
      db.exec('ROLLBACK');
      return null;
    }
    run("UPDATE numbers SET status = 'sold' WHERE id = ?", [row.id]);
    db.exec('COMMIT');
    return row;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------- orders ----------
function createOrder({ orderId, userId, numberId, number, country, platform, price, apiUrl = '', status = 'pending' }) {
  const t = now();
  run(
    'INSERT INTO orders (order_id, user_id, number_id, number, country, platform, price, status, api_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [orderId, userId, numberId, number, country, platform, price, status, apiUrl, t]
  );
  return getOrderByOrderId(orderId);
}
function getOrderById(id) { return get('SELECT * FROM orders WHERE id = ?', [id]); }
function getOrderByOrderId(orderId) { return get('SELECT * FROM orders WHERE order_id = ?', [orderId]); }
function getOrdersByUser(userId) { return all('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC', [userId]); }
function listAllOrders() { return all('SELECT o.*, u.full_name, u.email FROM orders o LEFT JOIN users u ON u.id = o.user_id ORDER BY o.id DESC'); }
function listPendingOrders() { return all("SELECT * FROM orders WHERE status = 'pending'"); }
function updateOrder(id, fields) { updateGeneric('orders', id, fields); return getOrderById(id); }
function countOrdersByStatus(status) {
  const row = get('SELECT COUNT(*) as c FROM orders WHERE status = ?', [status]);
  return row.c;
}

// ---------- otp logs ----------
function addOtpLog({ orderId, number, code, message }) {
  run('INSERT INTO otp_logs (order_id, number, code, message, created_at) VALUES (?, ?, ?, ?, ?)',
    [orderId, number, code, message || '', now()]);
}
function listOtpLogs(limit = 100) { return all('SELECT * FROM otp_logs ORDER BY id DESC LIMIT ?', [limit]); }

// ---------- services ----------
function upsertServiceByPair({ platform, country, price, apiUrl = '', status = 'enabled' }) {
  const ex = get('SELECT * FROM services WHERE platform = ? AND country = ?', [platform, country]);
  if (ex) {
    run('UPDATE services SET price = ?, api_url = ? WHERE id = ?', [price, ex.api_url || apiUrl, ex.id]);
    return getServiceById(ex.id);
  }
  run('INSERT INTO services (platform, country, price, api_url, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [platform, country, price, apiUrl, status, now()]);
  return getServiceById(db.prepare('SELECT last_insert_rowid() AS id').get().id);
}
function serviceStats(id, platform, country) {
  const row = get(
    `SELECT
      (SELECT COUNT(*) FROM numbers n WHERE n.platform = ? AND n.country = ?) AS number_count,
      (SELECT COUNT(*) FROM numbers n WHERE n.platform = ? AND n.country = ? AND n.status = 'available') AS available_count,
      (SELECT COUNT(*) FROM numbers n WHERE n.platform = ? AND n.country = ? AND n.api_url != '') AS api_count,
      (SELECT COALESCE(MIN(n.price),0) FROM numbers n WHERE n.platform = ? AND n.country = ?) AS min_price,
      (SELECT AVG((julianday(o.otp_time) - julianday(o.created_at)) * 86400)
         FROM orders o WHERE o.platform = ? AND o.country = ? AND o.status = 'completed' AND o.otp_time IS NOT NULL) AS avg_time_sec`,
    [platform, country, platform, country, platform, country, platform, country, platform, country]
  );
  return { id, number_count: row.number_count, available_count: row.available_count,
    api_count: row.api_count || 0, min_price: row.min_price || 0, avg_time_sec: row.avg_time_sec };
}
function seedServicesFromNumbers() {
  const rows = all('SELECT platform, country, MIN(price) AS price FROM numbers GROUP BY platform, country');
  for (const r of rows) {
    if (!r.platform || !r.country) continue;
    const ex = get('SELECT * FROM services WHERE platform = ? AND country = ?', [r.platform, r.country]);
    if (!ex) run('INSERT INTO services (platform, country, price, api_url, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [r.platform, r.country, r.price || 0, '', 'enabled', now()]);
  }
}
function createService({ platform, country, price, apiUrl = '' }) {
  const p = String(platform || '').trim(), c = String(country || '').trim();
  if (!p) return { ok: false, error: 'Platform required' };
  if (!c) return { ok: false, error: 'Country required' };
  const ex = get('SELECT * FROM services WHERE platform = ? AND country = ?', [p, c]);
  if (ex) return { ok: false, error: `Service '${p} / ${c}' already exists` };
  addPlatform(p); addCountry(c);
  const svc = upsertServiceByPair({ platform: p, country: c, price: Number(price) || 0, apiUrl });
  return { ok: true, service: svc, platform: p, country: c };
}
function getService(platform, country) {
  return get('SELECT * FROM services WHERE platform = ? AND country = ?', [platform, country]);
}
function getServiceById(id) {
  return get('SELECT * FROM services WHERE id = ?', [id]);
}
function listServices() {
  return all('SELECT * FROM services ORDER BY platform, country').map((s) =>
    ({ ...s, ...serviceStats(s.id, s.platform, s.country) }));
}
function updateService(id, fields) {
  updateGeneric('services', id, fields);
  return getServiceById(id);
}
function deleteService(id) {
  const s = getServiceById(id);
  if (!s) return { ok: false, error: 'Not found' };
  const cnt = get('SELECT COUNT(*) c FROM numbers WHERE platform = ? AND country = ?', [s.platform, s.country]);
  if (cnt.c > 0) return { ok: false, error: `Service still has ${cnt.c} number(s). Delete numbers first.` };
  run('DELETE FROM services WHERE id = ?', [id]);
  return { ok: true };
}

// ---------- platforms & countries ----------
function addPlatform(name) {
  const n = String(name).trim();
  if (!n) return { ok: false, error: 'Name required' };
  const ex = get('SELECT * FROM platforms WHERE name = ?', [n]);
  if (ex) return { ok: false, error: 'Platform already exists' };
  run('INSERT INTO platforms (name, created_at) VALUES (?, ?)', [n, now()]);
  return { ok: true };
}
function listPlatforms() {
  return all(`SELECT p.id, p.name, p.created_at,
      (SELECT COUNT(*) FROM numbers n WHERE n.platform = p.name) AS number_count,
      (SELECT COUNT(*) FROM numbers n WHERE n.platform = p.name AND n.status = 'available') AS available_count,
      (SELECT COUNT(DISTINCT n.country) FROM numbers n WHERE n.platform = p.name) AS country_count,
      (SELECT MIN(n.price) FROM numbers n WHERE n.platform = p.name) AS min_price
      FROM platforms p ORDER BY p.name`);
}
function deletePlatform(id) {
  const p = get('SELECT * FROM platforms WHERE id = ?', [id]);
  if (!p) return { ok: false, error: 'Not found' };
  const cnt = get('SELECT COUNT(*) c FROM numbers WHERE platform = ?', [p.name]);
  if (cnt.c > 0) return { ok: false, error: `Platform '${p.name}' still has ${cnt.c} number(s). Delete numbers first.` };
  run('DELETE FROM platforms WHERE id = ?', [id]);
  return { ok: true };
}
function addCountry(name) {
  const n = String(name).trim();
  if (!n) return { ok: false, error: 'Name required' };
  const ex = get('SELECT * FROM countries WHERE name = ?', [n]);
  if (ex) return { ok: false, error: 'Country already exists' };
  run('INSERT INTO countries (name, created_at) VALUES (?, ?)', [n, now()]);
  return { ok: true };
}
function listCountries() {
  return all(`SELECT c.id, c.name, c.created_at,
      (SELECT COUNT(*) FROM numbers n WHERE n.country = c.name) AS number_count,
      (SELECT COUNT(*) FROM numbers n WHERE n.country = c.name AND n.status = 'available') AS available_count,
      (SELECT COUNT(DISTINCT n.platform) FROM numbers n WHERE n.country = c.name) AS platform_count
      FROM countries c ORDER BY c.name`);
}
function deleteCountry(id) {
  const c = get('SELECT * FROM countries WHERE id = ?', [id]);
  if (!c) return { ok: false, error: 'Not found' };
  const cnt = get('SELECT COUNT(*) c FROM numbers WHERE country = ?', [c.name]);
  if (cnt.c > 0) return { ok: false, error: `Country '${c.name}' still has ${cnt.c} number(s). Delete numbers first.` };
  run('DELETE FROM countries WHERE id = ?', [id]);
  return { ok: true };
}

// ---------- api keys ----------
function createApiKey({ userId, apiKey, label = 'Default' }) {
  run('INSERT INTO api_keys (user_id, api_key, label, created_at) VALUES (?, ?, ?, ?)',
    [userId, apiKey, label, now()]);
  return getApiKeyByKey(apiKey);
}
function getApiKeyByKey(apiKey) {
  return get('SELECT k.*, u.email, u.full_name FROM api_keys k LEFT JOIN users u ON u.id = k.user_id WHERE k.api_key = ?', [apiKey]);
}
function getApiKeyById(id) { return get('SELECT * FROM api_keys WHERE id = ?', [id]); }
function listApiKeys(userId) { return all('SELECT * FROM api_keys WHERE user_id = ? ORDER BY id DESC', [userId]); }
function touchApiKey(id) { run('UPDATE api_keys SET last_used = ? WHERE id = ?', [now(), id]); }
function revokeApiKey(id, userId) {
  const k = get('SELECT * FROM api_keys WHERE id = ? AND user_id = ?', [id, userId]);
  if (!k) return { ok: false, error: 'API key not found' };
  run('DELETE FROM api_keys WHERE id = ?', [id]);
  return { ok: true };
}

// ---------- tickets ----------
function createTicket({ userId, subject, category = 'general', priority = 'normal' }) {
  const t = now();
  run('INSERT INTO tickets (user_id, subject, category, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [userId, subject, category, 'open', priority, t, t]);
  return getTicketById(db.prepare('SELECT last_insert_rowid() AS id').get().id);
}
function getTicketById(id) {
  return get('SELECT t.*, u.email, u.full_name FROM tickets t LEFT JOIN users u ON u.id = t.user_id WHERE t.id = ?', [id]);
}
function getTicketsByUser(userId) { return all('SELECT * FROM tickets WHERE user_id = ? ORDER BY id DESC', [userId]); }
function listTickets() {
  return all(`SELECT t.*, u.email, u.full_name,
      (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id) AS reply_count,
      (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id AND m.sender_role != 'admin') AS user_count
      FROM tickets t LEFT JOIN users u ON u.id = t.user_id ORDER BY t.id DESC`);
}
function updateTicket(id, fields) { updateGeneric('tickets', id, fields); return getTicketById(id); }
function updateTicketStamp(id) { run('UPDATE tickets SET updated_at = ? WHERE id = ?', [now(), id]); }

// ---------- ticket messages ----------
function addTicketMessage({ ticketId, senderId, senderRole = 'user', message }) {
  run('INSERT INTO ticket_messages (ticket_id, sender_id, sender_role, message, created_at) VALUES (?, ?, ?, ?, ?)',
    [ticketId, senderId, senderRole, message, now()]);
  updateTicketStamp(ticketId);
  return getTicketMessages(ticketId).pop();
}
function getTicketMessages(ticketId) {
  return all('SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY id ASC', [ticketId]);
}

// ---------- wallet history ----------
function addWalletEntry({ userId, amount, type = 'adjustment', note = '' }) {
  run('INSERT INTO wallet_entries (user_id, amount, type, note, created_at) VALUES (?, ?, ?, ?, ?)',
    [userId, amount, type, note, now()]);
}
function listWalletEntries(userId) {
  return all('SELECT * FROM wallet_entries WHERE user_id = ? ORDER BY id DESC LIMIT 200', [userId]);
}

// ---------- order pull logs ----------
function addPullLog({ orderId, number, result = 'poll', message = '' }) {
  run('INSERT INTO order_pull_logs (order_id, number, result, message, created_at) VALUES (?, ?, ?, ?, ?)',
    [orderId, number || '', result, message || '', now()]);
}
function listPullLogsByOrder(orderId) {
  return all('SELECT * FROM order_pull_logs WHERE order_id = ? ORDER BY id DESC LIMIT 200', [orderId]);
}
function listPullLogs(limit = 500) {
  return all(`SELECT l.*, o.order_id AS order_code FROM order_pull_logs l
    LEFT JOIN orders o ON o.id = l.order_id ORDER BY l.id DESC LIMIT ?`, [limit]);
}

// ---------- payments ----------
function createPayment({ userId, utr, amount, method = 'BharatPe', credit = 0, ip = '', note = '' }) {
  const t = now();
  run(`INSERT INTO payments (user_id, utr, amount, method, status, credit, ip, note, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    [userId, utr, amount, method, credit, ip || '', note || '', t]);
  return getPaymentByUtr(utr);
}
function getPaymentByUtr(utr) { return get('SELECT * FROM payments WHERE utr = ?', [utr]); }
function getPaymentById(id) { return get('SELECT * FROM payments WHERE id = ?', [id]); }
function listPaymentsForUser(userId) {
  return all('SELECT * FROM payments WHERE user_id = ? ORDER BY id DESC LIMIT 200', [userId]);
}
function listAllPayments() {
  return all('SELECT p.*, u.email, u.full_name FROM payments p LEFT JOIN users u ON u.id = p.user_id ORDER BY p.id DESC');
}
function updatePayment(id, fields) { updateGeneric('payments', id, fields); return getPaymentById(id); }
function countPaymentsByStatus(status) {
  const row = get('SELECT COUNT(*) as c FROM payments WHERE status = ?', [status]);
  return row.c;
}

// ---------- settings ----------
const DEFAULT_SETTINGS = {
  siteName: 'SMSOTP',
  currency: 'USD',
  paymentEnabled: '1',
  paymentMode: 'upi',              // 'qr' (uploaded image) | 'upi' (auto QR from UPI id)
  paymentQr: '',                   // base64 data URI of uploaded QR (mode 'qr')
  paymentUpiId: '',                // e.g. merchant@ybl (mode 'upi')
  paymentMerchantName: '',
  bharatpeMerchantId: '',
  bharatpeToken: '',
  paymentFeePct: '0',
  paymentRateInrUsd: '0.012',      // INR paid -> site currency credit
  paymentMin: '0',
  paymentInstructions: '',
};
function getSetting(key) {
  const row = get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : (DEFAULT_SETTINGS[key] !== undefined ? DEFAULT_SETTINGS[key] : null);
}
function setSetting(key, value) {
  const v = value === undefined || value === null ? '' : String(value);
  const ex = get('SELECT key FROM settings WHERE key = ?', [key]);
  if (ex) run('UPDATE settings SET value = ? WHERE key = ?', [v, key]);
  else run('INSERT INTO settings (key, value) VALUES (?, ?)', [key, v]);
}
function getAllSettings() {
  const obj = { ...DEFAULT_SETTINGS };
  for (const row of all('SELECT key, value FROM settings')) obj[row.key] = row.value;
  return obj;
}
function setSettings(obj) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (DEFAULT_SETTINGS[k] !== undefined) setSetting(k, v);
  }
  return getAllSettings();
}
function publicSettings() {
  const s = getAllSettings();
  return {
    siteName: s.siteName || 'SMSOTP',
    currency: s.currency || 'USD',
    paymentEnabled: s.paymentEnabled === '1' || s.paymentEnabled === 'true',
  };
}

// ---------- sessions ----------
function createSession({ userId, role = 'user', tokenHash, deviceFp, deviceName, ip, userAgent, expiresAt }) {
  const t = now();
  const info = run(
    'INSERT INTO sessions (user_id, role, token_hash, device_fp, device_name, ip, user_agent, is_active, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)',
    [userId, role, tokenHash, deviceFp || '', deviceName || '', ip || '', userAgent || '', t, t, expiresAt]
  );
  return get('SELECT * FROM sessions WHERE id = ?', [info.lastInsertRowid]);
}
function getSessionById(id) { return get('SELECT * FROM sessions WHERE id = ?', [id]); }
function getSessionByTokenHash(tokenHash) { return get('SELECT * FROM sessions WHERE token_hash = ?', [tokenHash]); }
function listSessionsForUser(userId) {
  return all('SELECT * FROM sessions WHERE user_id = ? ORDER BY is_active DESC, last_seen_at DESC', [userId]);
}
function listActiveSessionsForUser(userId) {
  return all('SELECT * FROM sessions WHERE user_id = ? AND is_active = 1 ORDER BY last_seen_at DESC', [userId]);
}
function deactivateSession(id) {
  run('UPDATE sessions SET is_active = 0, revoked_at = ? WHERE id = ?', [now(), id]);
}
function deactivateAllSessions(userId, exceptId) {
  if (exceptId !== null && exceptId !== undefined) {
    run('UPDATE sessions SET is_active = 0, revoked_at = ? WHERE user_id = ? AND id != ?', [now(), userId, exceptId]);
  } else {
    run('UPDATE sessions SET is_active = 0, revoked_at = ? WHERE user_id = ?', [now(), userId]);
  }
}
function touchSession(id, ip) {
  run('UPDATE sessions SET last_seen_at = ?, ip = ? WHERE id = ?', [now(), ip || null, id]);
}
function countActiveSessions(userId) {
  const r = get('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND is_active = 1', [userId]);
  return r ? Number(r.n) || 0 : 0;
}
function updateSessionToken(id, newHash, expiresAt) {
  run('UPDATE sessions SET token_hash = ?, expires_at = ? WHERE id = ?', [newHash, expiresAt, id]);
}

// ---------- login activity ----------
function addLoginActivity({ userId, type = 'login', detail = '', deviceFp, deviceName, ip, userAgent }) {
  run(
    'INSERT INTO login_activity (user_id, type, detail, device_fp, device_name, ip, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [userId, type, detail || '', deviceFp || '', deviceName || '', ip || '', userAgent || '', now()]
  );
}
function listLoginActivity(userId, limit = 50) {
  return all('SELECT * FROM login_activity WHERE user_id = ? ORDER BY id DESC LIMIT ?', [userId, limit]);
}

module.exports = {
  init, now, get, all, run, updateGeneric,
  createUser, getUserByEmail, getUserById, updateUser, listUsers, addBalance,
  insertNumbers, listNumbers, getNumberById, setNumberStatus, updateNumber, allocateNumber,
  createOrder, getOrderById, getOrderByOrderId, getOrdersByUser, listAllOrders,
  listPendingOrders, updateOrder, countOrdersByStatus,
  addOtpLog, listOtpLogs,
  upsertServiceByPair, seedServicesFromNumbers, createService, getService, getServiceById,
  listServices, updateService, deleteService,
  addPlatform, listPlatforms, deletePlatform,
  addCountry, listCountries, deleteCountry,
  createApiKey, getApiKeyByKey, getApiKeyById, listApiKeys, touchApiKey, revokeApiKey,
  createTicket, getTicketById, getTicketsByUser, listTickets, updateTicket, updateTicketStamp,
  addTicketMessage, getTicketMessages,
  addWalletEntry, listWalletEntries,
  addPullLog, listPullLogsByOrder, listPullLogs,
  createPayment, getPaymentByUtr, getPaymentById, listPaymentsForUser, listAllPayments,
  updatePayment, countPaymentsByStatus,
  getSetting, setSetting, getAllSettings, setSettings, publicSettings, DEFAULT_SETTINGS,
  createSession, getSessionById, getSessionByTokenHash, listSessionsForUser,
  listActiveSessionsForUser, deactivateSession, deactivateAllSessions, touchSession,
  countActiveSessions, updateSessionToken, addLoginActivity, listLoginActivity,
};