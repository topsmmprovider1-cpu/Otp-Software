const { createClient } = require('@supabase/supabase-js');
const config = require('../config');

const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey);

const now = () => new Date().toISOString();

async function init() {
  // Tables expected to exist (run supabase/schema.sql once).
  // Verify connection by a lightweight query.
  const { error } = await supabase.from('users').select('id', { count: 'exact', head: true }).limit(1);
  if (error) throw new Error(`Supabase connect failed: ${error.message}. Run supabase/schema.sql first.`);
  // seed master platform/country rows from any existing numbers
  const { data: nums } = await supabase.from('numbers').select('platform,country');
  const seen = new Set();
  for (const n of nums || []) {
    const key = n.platform + '\u0000' + n.country;
    if (seen.has(key)) continue;
    seen.add(key);
    if (n.platform) await addPlatform(n.platform);
    if (n.country) await addCountry(n.country);
  }
  await seedServicesFromNumbers();
}

// ---------- users ----------
async function createUser({ fullName, email, phone, passwordHash, role = 'user', balance = 0 }) {
  const { data, error } = await supabase.from('users').insert({
    full_name: fullName, email, phone: phone || null,
    password_hash: passwordHash, role, balance, is_active: true, created_at: now(),
  }).select().single();
  if (error) throw new Error(error.message);
  return data;
}
async function getUserByEmail(email) {
  const { data } = await supabase.from('users').select('*').eq('email', email).maybeSingle();
  return data;
}
async function getUserById(id) {
  const { data } = await supabase.from('users').select('*').eq('id', id).maybeSingle();
  return data;
}
async function updateUser(id, fields) {
  const patch = {};
  if (fields.fullName !== undefined) patch.full_name = fields.fullName;
  if (fields.email !== undefined) patch.email = fields.email;
  if (fields.phone !== undefined) patch.phone = fields.phone;
  if (fields.balance !== undefined) patch.balance = fields.balance;
  if (fields.role !== undefined) patch.role = fields.role;
  if (fields.isActive !== undefined) patch.is_active = fields.isActive;
  if (fields.password_hash !== undefined) patch.password_hash = fields.password_hash;
  const { data, error } = await supabase.from('users').update(patch).eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return data;
}
async function listUsers() {
  const { data } = await supabase.from('users').select('*').order('id', { ascending: false });
  return data || [];
}
async function addBalance(id, amount) {
  const u = await getUserById(id);
  if (!u) throw new Error('User not found');
  return updateUser(id, { balance: (Number(u.balance) || 0) + Number(amount) });
}

// ---------- numbers ----------
async function insertNumbers(rows) {
  const payload = rows.map((r) => ({
    number: r.number, country: r.country, platform: r.platform,
    price: r.price, api_url: r.api_url || '',
  }));
  const { error } = await supabase.from('numbers').insert(payload);
  if (error) throw new Error(error.message);
  return rows.length;
}
async function listNumbers() {
  const { data } = await supabase.from('numbers').select('*').order('id', { ascending: false });
  return data || [];
}
async function setNumberStatus(id, status) {
  const { error } = await supabase.from('numbers').update({ status }).eq('id', id);
  if (error) throw new Error(error.message);
}

async function getNumberById(id) {
  const { data } = await supabase.from('numbers').select('*').eq('id', id).maybeSingle();
  return data;
}
async function updateNumber(id, fields) {
  const patch = {};
  if (fields.price !== undefined) patch.price = fields.price;
  if (fields.status !== undefined) patch.status = fields.status;
  if (fields.api_url !== undefined) patch.api_url = fields.api_url;
  if (fields.platform !== undefined) patch.platform = fields.platform;
  if (fields.country !== undefined) patch.country = fields.country;
  const { data, error } = await supabase.from('numbers').update(patch).eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return data;
}
async function allocateNumber(platform, country) {
  // Fetch up to 20 available candidates and pick one at random
  // (prefer numbers with api_url so OTP auto-pull works)
  const pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];

  let candidates = await supabase
    .from('numbers')
    .select('*')
    .eq('platform', platform).eq('country', country).eq('status', 'available')
    .neq('api_url', '').limit(20)
    .then((r) => r.data || []);

  if (!candidates.length) {
    candidates = await supabase
      .from('numbers')
      .select('*')
      .eq('platform', platform).eq('country', country).eq('status', 'available')
      .limit(20)
      .then((r) => r.data || []);
  }

  if (!candidates.length) return null;

  const chosen = pickRandom(candidates);
  const { data: updated, error } = await supabase
    .from('numbers').update({ status: 'sold' }).eq('id', chosen.id).eq('status', 'available')
    .select().single();
  if (error || !updated) return null; // race condition — someone else grabbed it
  return updated;
}


// ---------- orders ----------
async function createOrder({ orderId, userId, numberId, number, country, platform, price, apiUrl = '', status = 'pending' }) {
  const { data, error } = await supabase.from('orders').insert({
    order_id: orderId, user_id: userId, number_id: numberId, number, country, platform,
    price, status, api_url: apiUrl, created_at: now(),
  }).select().single();
  if (error) throw new Error(error.message);
  return data;
}
async function getOrderById(id) {
  const { data } = await supabase.from('orders').select('*').eq('id', id).maybeSingle();
  return data;
}
async function getOrderByOrderId(orderId) {
  const { data } = await supabase.from('orders').select('*').eq('order_id', orderId).maybeSingle();
  return data;
}
async function getOrdersByUser(userId) {
  const { data } = await supabase.from('orders').select('*').eq('user_id', userId).order('id', { ascending: false });
  return data || [];
}
async function listAllOrders() {
  const { data } = await supabase
    .from('orders').select('*, users(full_name, email)').order('id', { ascending: false }).limit(1000);
  return (data || []).map((o) => ({ ...o, full_name: o.users?.full_name, email: o.users?.email, users: undefined }));
}
async function listPendingOrders() {
  const { data } = await supabase.from('orders').select('*').eq('status', 'pending').limit(500);
  return data || [];
}
async function updateOrder(id, fields) {
  const patch = {};
  if (fields.status !== undefined) patch.status = fields.status;
  if (fields.otp_code !== undefined) patch.otp_code = fields.otp_code;
  if (fields.otp_message !== undefined) patch.otp_message = fields.otp_message;
  if (fields.otp_time !== undefined) patch.otp_time = fields.otp_time;
  if (fields.pull_count !== undefined) patch.pull_count = fields.pull_count;
  if (fields.completed_at !== undefined) patch.completed_at = fields.completed_at;
  if (fields.cancelled_at !== undefined) patch.cancelled_at = fields.cancelled_at;
  const { data, error } = await supabase.from('orders').update(patch).eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return data;
}
async function countOrdersByStatus(status) {
  const { count, error } = await supabase
    .from('orders').select('*', { count: 'exact', head: true }).eq('status', status);
  if (error) throw new Error(error.message);
  return count || 0;
}

// ---------- otp logs ----------
async function addOtpLog({ orderId, number, code, message }) {
  await supabase.from('otp_logs').insert({
    order_id: orderId, number, code, message: message || '', created_at: now(),
  });
}
async function listOtpLogs(limit = 100) {
  const { data } = await supabase.from('otp_logs').select('*').order('id', { ascending: false }).limit(limit);
  return data || [];
}

// ---------- services ----------
async function upsertServiceByPair({ platform, country, price, apiUrl = '', status = 'enabled' }) {
  const ex = await getService(platform, country);
  if (ex) {
    await supabase.from('services').update({ price, api_url: ex.api_url || apiUrl }).eq('id', ex.id);
    return getServiceById(ex.id);
  }
  const { data, error } = await supabase.from('services').insert({
    platform, country, price, api_url: apiUrl, status, created_at: now(),
  }).select().single();
  if (error) throw new Error(error.message);
  return data;
}
async function seedServicesFromNumbers() {
  const { data: nums } = await supabase.from('numbers').select('platform,country,price');
  const map = new Map();
  for (const n of nums || []) {
    if (!n.platform || !n.country) continue;
    const k = n.platform + '\u0000' + n.country;
    map.set(k, Math.min(map.get(k) ?? Infinity, Number(n.price) || 0));
  }
  for (const [k, price] of map) {
    const [platform, country] = k.split('\u0000');
    const ex = await getService(platform, country);
    if (!ex) await supabase.from('services').insert({
      platform, country, price: price === Infinity ? 0 : price, api_url: '', status: 'enabled', created_at: now(),
    });
  }
}
async function createService({ platform, country, price, apiUrl = '' }) {
  const p = String(platform || '').trim(), c = String(country || '').trim();
  if (!p) return { ok: false, error: 'Platform required' };
  if (!c) return { ok: false, error: 'Country required' };
  const ex = await getService(p, c);
  if (ex) return { ok: false, error: `Service '${p} / ${c}' already exists` };
  await addPlatform(p); await addCountry(c);
  const svc = await upsertServiceByPair({ platform: p, country: c, price: Number(price) || 0, apiUrl });
  return { ok: true, service: svc, platform: p, country: c };
}
async function getService(platform, country) {
  const { data } = await supabase.from('services').select('*')
    .eq('platform', platform).eq('country', country).maybeSingle();
  return data;
}
async function getServiceById(id) {
  const { data } = await supabase.from('services').select('*').eq('id', id).maybeSingle();
  return data;
}
async function serviceStats(s) {
  const { data: nums } = await supabase.from('numbers').select('status,price,api_url')
    .eq('platform', s.platform).eq('country', s.country);
  const { data: orders } = await supabase.from('orders').select('status,otp_time,created_at')
    .eq('platform', s.platform).eq('country', s.country);
  const done = (nums || []).filter((n) => n.status === 'available');
  const completed = (orders || []).filter((o) => o.status === 'completed' && o.otp_time && o.created_at);
  let avg = null;
  if (completed.length) {
    const sum = completed.reduce((a, o) => a + (new Date(o.otp_time).getTime() - new Date(o.created_at).getTime()), 0);
    avg = sum / completed.length / 1000;
  }
  return {
    number_count: (nums || []).length,
    available_count: done.length,
    api_count: (nums || []).filter((n) => n.api_url).length,
    min_price: (nums || []).length ? Math.min(...(nums || []).map((n) => Number(n.price) || 0)) : 0,
    avg_time_sec: avg,
  };
}
async function listServices() {
  const { data } = await supabase.from('services').select('*').order('platform', { ascending: true }).order('country', { ascending: true });
  const out = [];
  for (const s of data || []) out.push({ ...s, ...(await serviceStats(s)) });
  return out;
}
async function updateService(id, fields) {
  const patch = {};
  if (fields.price !== undefined) patch.price = fields.price;
  if (fields.status !== undefined) patch.status = fields.status;
  if (fields.api_url !== undefined) patch.api_url = fields.api_url;
  const { data, error } = await supabase.from('services').update(patch).eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return data;
}
async function deleteService(id) {
  const s = await getServiceById(id);
  if (!s) return { ok: false, error: 'Not found' };
  const { count } = await supabase.from('numbers').select('*', { count: 'exact', head: true })
    .eq('platform', s.platform).eq('country', s.country);
  if (count > 0) return { ok: false, error: `Service still has ${count} number(s). Delete numbers first.` };
  const { error } = await supabase.from('services').delete().eq('id', id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// ---------- platforms & countries ----------
async function addPlatform(name) {
  const n = String(name).trim();
  if (!n) return { ok: false, error: 'Name required' };
  const { data } = await supabase.from('platforms').select('id').eq('name', n).maybeSingle();
  if (data) return { ok: false, error: 'Platform already exists' };
  const { error } = await supabase.from('platforms').insert({ name: n, created_at: now() });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
async function listPlatforms() {
  const { data: list } = await supabase.from('platforms').select('*').order('name', { ascending: true });
  const { data: nums } = await supabase.from('numbers').select('platform,country,status,price');
  return (list || []).map((p) => {
    const rel = (nums || []).filter((n) => n.platform === p.name);
    return {
      id: p.id, name: p.name, created_at: p.created_at,
      number_count: rel.length,
      available_count: rel.filter((n) => n.status === 'available').length,
      country_count: new Set(rel.map((n) => n.country)).size,
      min_price: rel.length ? Math.min(...rel.map((n) => Number(n.price) || 0)) : null,
    };
  });
}
async function deletePlatform(id) {
  const { data: p } = await supabase.from('platforms').select('name').eq('id', id).maybeSingle();
  if (!p) return { ok: false, error: 'Not found' };
  const { count } = await supabase.from('numbers').select('*', { count: 'exact', head: true }).eq('platform', p.name);
  if (count > 0) return { ok: false, error: `Platform '${p.name}' still has ${count} number(s). Delete numbers first.` };
  const { error } = await supabase.from('platforms').delete().eq('id', id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
async function addCountry(name) {
  const n = String(name).trim();
  if (!n) return { ok: false, error: 'Name required' };
  const { data } = await supabase.from('countries').select('id').eq('name', n).maybeSingle();
  if (data) return { ok: false, error: 'Country already exists' };
  const { error } = await supabase.from('countries').insert({ name: n, created_at: now() });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
async function listCountries() {
  const { data: list } = await supabase.from('countries').select('*').order('name', { ascending: true });
  const { data: nums } = await supabase.from('numbers').select('platform,country,status,price');
  return (list || []).map((c) => {
    const rel = (nums || []).filter((n) => n.country === c.name);
    return {
      id: c.id, name: c.name, created_at: c.created_at,
      number_count: rel.length,
      available_count: rel.filter((n) => n.status === 'available').length,
      platform_count: new Set(rel.map((n) => n.platform)).size,
    };
  });
}
async function deleteCountry(id) {
  const { data: c } = await supabase.from('countries').select('name').eq('id', id).maybeSingle();
  if (!c) return { ok: false, error: 'Not found' };
  const { count } = await supabase.from('numbers').select('*', { count: 'exact', head: true }).eq('country', c.name);
  if (count > 0) return { ok: false, error: `Country '${c.name}' still has ${count} number(s). Delete numbers first.` };
  const { error } = await supabase.from('countries').delete().eq('id', id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// ---------- api keys ----------
async function createApiKey({ userId, apiKey, label = 'Default' }) {
  const { data, error } = await supabase.from('api_keys').insert({
    user_id: userId, api_key: apiKey, label, created_at: now(),
  }).select().single();
  if (error) throw new Error(error.message);
  return data;
}
async function getApiKeyByKey(apiKey) {
  const { data } = await supabase.from('api_keys')
    .select('*, users(email, full_name)').eq('api_key', apiKey).maybeSingle();
  if (data) return { ...data, email: data.users?.email, full_name: data.users?.full_name };
  return data;
}
async function getApiKeyById(id) {
  const { data } = await supabase.from('api_keys').select('*').eq('id', id).maybeSingle();
  return data;
}
async function listApiKeys(userId) {
  const { data } = await supabase.from('api_keys').select('*').eq('user_id', userId).order('id', { ascending: false });
  return data || [];
}
async function touchApiKey(id) {
  await supabase.from('api_keys').update({ last_used: now() }).eq('id', id);
}
async function revokeApiKey(id, userId) {
  const { data: k } = await supabase.from('api_keys').select('id').eq('id', id).eq('user_id', userId).maybeSingle();
  if (!k) return { ok: false, error: 'API key not found' };
  const { error } = await supabase.from('api_keys').delete().eq('id', id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// ---------- tickets ----------
async function createTicket({ userId, subject, category = 'general', priority = 'normal' }) {
  const t = now();
  const { data, error } = await supabase.from('tickets').insert({
    user_id: userId, subject, category, status: 'open', priority, created_at: t, updated_at: t,
  }).select().single();
  if (error) throw new Error(error.message);
  return data;
}
async function getTicketById(id) {
  const { data } = await supabase.from('tickets')
    .select('*, users(email, full_name)').eq('id', id).maybeSingle();
  if (data) return { ...data, email: data.users?.email, full_name: data.users?.full_name };
  return data;
}
async function getTicketsByUser(userId) {
  const { data } = await supabase.from('tickets').select('*').eq('user_id', userId).order('id', { ascending: false });
  return data || [];
}
async function listTickets() {
  const { data } = await supabase.from('tickets')
    .select('*, users(email, full_name), ticket_messages(count)').order('id', { ascending: false });
  return (data || []).map((t) => ({
    ...t, email: t.users?.email, full_name: t.users?.full_name,
    reply_count: t.ticket_messages?.[0]?.count || 0,
  }));
}
async function updateTicket(id, fields) {
  const patch = {};
  if (fields.status !== undefined) patch.status = fields.status;
  if (fields.priority !== undefined) patch.priority = fields.priority;
  if (fields.category !== undefined) patch.category = fields.category;
  if (fields.closed_at !== undefined) patch.closed_at = fields.closed_at;
  if (Object.keys(patch).length) {
    const { error } = await supabase.from('tickets').update(patch).eq('id', id);
    if (error) throw new Error(error.message);
  }
  return getTicketById(id);
}
async function updateTicketStamp(id) {
  await supabase.from('tickets').update({ updated_at: now() }).eq('id', id);
}
async function addTicketMessage({ ticketId, senderId, senderRole = 'user', message }) {
  const { data, error } = await supabase.from('ticket_messages').insert({
    ticket_id: ticketId, sender_id: senderId || null, sender_role: senderRole, message, created_at: now(),
  }).select().single();
  if (error) throw new Error(error.message);
  await updateTicketStamp(ticketId);
  return data;
}
async function getTicketMessages(ticketId) {
  const { data } = await supabase.from('ticket_messages')
    .select('*, users(full_name, email)').eq('ticket_id', ticketId).order('id', { ascending: true });
  return (data || []).map((m) => ({ ...m, sender_name: m.users?.full_name }));
}
async function addWalletEntry({ userId, amount, type = 'adjustment', note = '' }) {
  const { error } = await supabase.from('wallet_entries').insert({
    user_id: userId, amount, type, note: note || '', created_at: now(),
  });
  if (error) throw new Error(error.message);
}
async function listWalletEntries(userId) {
  const { data } = await supabase.from('wallet_entries')
    .select('*').eq('user_id', userId).order('id', { ascending: false }).limit(200);
  return data || [];
}

// ---------- pull logs ----------
async function addPullLog({ orderId, number, result = 'poll', message = '', code, error, attempt }) {
  const { error: err } = await supabase.from('order_pull_logs').insert({
    order_id: orderId, number, result,
    message: (error ? `Error: ${error}` : message) || null,
    code: code || null, error: error || null, attempt: attempt || null, created_at: now(),
  });
  if (err) throw new Error(err.message);
}
async function listPullLogsByOrder(orderId, limit = 100) {
  const { data } = await supabase.from('order_pull_logs')
    .select('*').eq('order_id', orderId).order('id', { ascending: false }).limit(limit);
  return data || [];
}
async function listPullLogs(limit = 200) {
  const { data } = await supabase.from('order_pull_logs')
    .select('*').order('id', { ascending: false }).limit(limit);
  return data || [];
}

// ---------- payments ----------
async function createPayment({ userId, utr, amount, method = 'BharatPe', credit = 0, status = 'pending', note = '', ip = '' }) {
  const { data, error } = await supabase.from('payments').insert({
    user_id: userId, utr, amount, method, credit, status, note: note || '', ip: ip || '', created_at: now(),
  }).select().single();
  if (error) throw new Error(error.message);
  return data;
}
async function getPaymentByUtr(utr) {
  if (!utr) return null;
  const raw = String(utr).trim();
  const stripped = raw.replace(/^0+/, '');
  const candidates = Array.from(new Set([raw, stripped, '0' + stripped])).filter(Boolean);
  const { data } = await supabase.from('payments').select('*').in('utr', candidates).limit(1).maybeSingle();
  return data;
}
async function getPaymentById(id) {
  const { data } = await supabase.from('payments').select('*').eq('id', id).maybeSingle();
  return data;
}
async function listPaymentsForUser(userId) {
  const { data } = await supabase.from('payments')
    .select('*').eq('user_id', userId).order('id', { ascending: false }).limit(200);
  return data || [];
}
async function listAllPayments(limit = 300) {
  const { data } = await supabase.from('payments')
    .select('*, users(full_name, email)').order('id', { ascending: false }).limit(limit);
  return (data || []).map((p) => ({ ...p, full_name: p.users?.full_name, email: p.users?.email, users: undefined }));
}
async function updatePayment(id, fields) {
  const patch = {};
  if (fields.status !== undefined) patch.status = fields.status;
  if (fields.credit !== undefined) patch.credit = fields.credit;
  if (fields.verified_at !== undefined) patch.verified_at = fields.verified_at;
  if (fields.note !== undefined) patch.note = fields.note;
  const { error } = await supabase.from('payments').update(patch).eq('id', id);
  if (error) throw new Error(error.message);
  return getPaymentById(id);
}
async function countPaymentsByStatus(status) {
  const { count, error } = await supabase
    .from('payments').select('*', { count: 'exact', head: true }).eq('status', status);
  if (error) throw new Error(error.message);
  return count || 0;
}

// ---------- settings ----------
const DEFAULT_SETTINGS = {
  siteName: 'SMSOTP',
  currency: 'USD',
  paymentEnabled: 'false',
  paymentMode: '',
  upiId: '',
  merchantName: '',
  qrDataUrl: '',
  feePercent: '0',
  minDeposit: '1',
};
async function getSetting(key) {
  const { data } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
  return data ? data.value : null;
}
async function setSetting(key, value) {
  const v = value === undefined || value === null ? '' : String(value);
  const { data } = await supabase.from('settings').select('key').eq('key', key).maybeSingle();
  if (data) {
    const { error } = await supabase.from('settings').update({ value: v }).eq('key', key);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabase.from('settings').insert({ key, value: v });
    if (error) throw new Error(error.message);
  }
}
async function getAllSettings() {
  const { data } = await supabase.from('settings').select('key,value');
  const out = { ...DEFAULT_SETTINGS };
  for (const r of data || []) out[r.key] = r.value;
  return out;
}
async function setSettings(obj) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (v !== undefined && v !== null) await setSetting(k, v);
  }
  return getAllSettings();
}
async function publicSettings() {
  const s = await getAllSettings();
  return {
    siteName: s.siteName || 'SMSOTP',
    currency: s.currency || 'USD',
    paymentEnabled: s.paymentEnabled === '1' || s.paymentEnabled === 'true',
  };
}

// ---------- sessions ----------
async function createSession({ userId, role = 'user', tokenHash, deviceFp, deviceName, ip, userAgent, expiresAt }) {
  const { data, error } = await supabase.from('sessions').insert({
    user_id: userId, role, token_hash: tokenHash,
    device_fp: deviceFp || '', device_name: deviceName || '',
    ip: ip || '', user_agent: userAgent || '',
    is_active: true, created_at: now(), last_seen_at: now(), expires_at: expiresAt,
  }).select().single();
  if (error) throw new Error(error.message);
  return data;
}
async function getSessionById(id) {
  const { data } = await supabase.from('sessions').select('*').eq('id', id).maybeSingle();
  return data;
}
async function getSessionByTokenHash(tokenHash) {
  const { data } = await supabase.from('sessions').select('*').eq('token_hash', tokenHash).maybeSingle();
  return data;
}
async function listSessionsForUser(userId) {
  const { data } = await supabase.from('sessions')
    .select('*').eq('user_id', userId).order('is_active', { ascending: false }).order('last_seen_at', { ascending: false });
  return data || [];
}
async function listActiveSessionsForUser(userId) {
  const { data } = await supabase.from('sessions')
    .select('*').eq('user_id', userId).eq('is_active', true).order('last_seen_at', { ascending: false });
  return data || [];
}
async function deactivateSession(id) {
  const { error } = await supabase.from('sessions')
    .update({ is_active: false, revoked_at: now() }).eq('id', id);
  if (error) throw new Error(error.message);
}
async function deactivateAllSessions(userId, exceptId) {
  let q = supabase.from('sessions').update({ is_active: false, revoked_at: now() }).eq('user_id', userId);
  if (exceptId !== null && exceptId !== undefined) q = q.neq('id', exceptId);
  const { error } = await q;
  if (error) throw new Error(error.message);
}
async function touchSession(id, ip) {
  const { error } = await supabase.from('sessions')
    .update({ last_seen_at: now(), ip: ip || undefined }).eq('id', id);
  if (error) throw new Error(error.message);
}
async function countActiveSessions(userId) {
  const { count } = await supabase.from('sessions')
    .select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('is_active', true);
  return count || 0;
}
async function updateSessionToken(id, newHash, expiresAt) {
  const { error } = await supabase.from('sessions')
    .update({ token_hash: newHash, expires_at: expiresAt, last_seen_at: now() }).eq('id', id);
  if (error) throw new Error(error.message);
}

// ---------- login activity ----------
async function addLoginActivity({ userId, type = 'login', detail = '', deviceFp, deviceName, ip, userAgent }) {
  const { error } = await supabase.from('login_activity').insert({
    user_id: userId, type, detail: detail || '',
    device_fp: deviceFp || '', device_name: deviceName || '',
    ip: ip || '', user_agent: userAgent || '', created_at: now(),
  });
  if (error) throw new Error(error.message);
}
async function listLoginActivity(userId, limit = 50) {
  const { data } = await supabase.from('login_activity')
    .select('*').eq('user_id', userId).order('id', { ascending: false }).limit(limit);
  return data || [];
}

module.exports = {
  init, now,
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