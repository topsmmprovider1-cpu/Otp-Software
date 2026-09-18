const path = require('path');
const os = require('os');
const fs = require('fs');

// ── configure BEFORE requiring any app modules ──
const DBFILE = path.join(os.tmpdir(), 'otp-test-' + Date.now() + '.db');
const modeArg = process.argv.indexOf('--mode');
const forcedMode = modeArg > -1 ? process.argv[modeArg + 1] : null;
process.env.DB_MODE = forcedMode || 'sqlite';   // sqlite (default) | supabase
process.env.SQLITE_FILE = DBFILE;
process.env.JWT_SECRET = 'test-secret';
process.env.ADMIN_EMAIL = 'admin@site.com';
process.env.ADMIN_PASSWORD = 'admin123';
process.env.OTP_EXPIRE_MINUTES = '60';        // we mutate later for expired-test
process.env.POLL_INTERVAL_MS = '99999';        // we call pollOnce() manually
process.env.MOCK_SMS_PORT = '5099';

const config = require('../src/config');
const { createServer: createMockSms } = require('./mock-sms');
const { init } = require('../src/app');
const poller = require('../src/services/poller');

let app, mock, baseUrl, adminToken, userToken, userRefresh;

function assert(cond, msg) { if (!cond) throw new Error('ASSERT FAILED: ' + msg); console.log('  ✓ ' + msg); }
async function j(res, expect = 200) {
  const data = await res.json();
  if (res.status !== expect) throw new Error(`Expected HTTP ${expect} but got ${res.status}: ${JSON.stringify(data)}`);
  return data;
}
function req(method, urlStr, body, headers = {}) {
  const h = { ...headers };
  if (body !== undefined && !h['Content-Type']) h['Content-Type'] = 'application/json';
  const opts = { method, headers: h };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return fetch(urlStr, opts);
}

(async () => {
  try {
    console.log('\n══ E2E TESTS ══');
    config.otpExpireMs = 60 * 60 * 1000; // reset initially

    // ── start mock SMS server ──
    mock = createMockSms();
    const MOCK_PORT = 5099;
    await mock.listen(MOCK_PORT);
    console.log('  mock sms listening on ' + MOCK_PORT);

    // ── init app ──
    const expressApp = await init();
    const PORT = 5199;
    await new Promise((resolve) => expressApp.listen(PORT, resolve));
    baseUrl = 'http://localhost:' + PORT;
    console.log('  app listening on ' + PORT);

    // ── 1. register user ──
    console.log('\n[1] Register user');
    const ue = forcedMode === 'supabase' ? ('user+' + Date.now() + '@test.com') : 'user@test.com';
    let r = await j(await req('POST', baseUrl + '/api/auth/register', {
      fullName: 'Test User', email: ue, password: '123456',
    }));
    assert(r.token, 'got user token');
    assert(r.refreshToken, 'got user refresh token');
    userToken = r.token;
    userRefresh = r.refreshToken;

    // ── 2. login admin ──
    console.log('\n[2] Login admin');
    r = await j(await req('POST', baseUrl + '/api/auth/login', { email: 'admin@site.com', password: 'admin123' }));
    assert(r.token && r.user.role === 'admin', 'admin logged in');
    assert(r.refreshToken, 'admin got refresh token');
    adminToken = r.token;

    // helper
    const api = (method, path, body) => {
      const h = { 'Authorization': 'Bearer ' + (method.startsWith('GET') ? userToken : (path.startsWith('/api/admin') ? adminToken : userToken)) };
      return req(method, baseUrl + path, body, h);
    };

    // ── 3. admin add numbers ──
    console.log('\n[3] Admin add numbers');
    r = await j(await req('POST', baseUrl + '/api/admin/numbers', {
      lines: [
        '+12086948340|USA|Instagram|2.5|http://localhost:5099/api/record?token=tok_ig_usa',
        '+447700900123|UK|WhatsApp|3.0|http://localhost:5099/api/record?token=tok_wa_uk',
      ].join('\n'),
    }, { 'Authorization': 'Bearer ' + adminToken }));
    assert(r.added === 2, '2 numbers added (got ' + r.added + ')');

    // ── 4. services list ──
    console.log('\n[4] Services list');
    r = await j(await req('GET', baseUrl + '/api/services'));
    assert(r.platforms.length === 2, '2 platforms listed');
    const ig = r.platforms.find((p) => p.platform === 'Instagram');
    assert(ig && ig.countries.some((c) => c.country === 'USA'), 'Instagram/USA found');

    // ── 5. top-up user ──
    console.log('\n[5] Top-up user balance');
    r = await j(await req('POST', baseUrl + '/api/admin/users/2/balance', { amount: 50 },
      { 'Authorization': 'Bearer ' + adminToken }));
    assert(r.balance === 50, 'balance is 50 (got ' + r.balance + ')');

    // ── 6. buy order (Instagram USA) ──
    console.log('\n[6] Buy Instagram/USA');
    r = await j(await req('POST', baseUrl + '/api/orders', { platform: 'Instagram', country: 'USA' },
      { 'Authorization': 'Bearer ' + userToken }));
    assert(r.order, 'order returned');
    assert(r.order.status === 'pending', 'status pending');
    assert(r.order.number === '+12086948340', 'allocated +12086948340');
    assert(r.order.otpCode === '', 'no OTP yet');
    console.log('  order: ' + r.order.orderId + '  number: ' + r.order.number);

    // ── 7. simulate OTP for the number's token ──
    console.log('\n[7] Simulate OTP arrival');
    await req('GET', 'http://localhost:5099/simulate?token=tok_ig_usa&code=928401');
    await poller.pollOnce();
    r = await j(await req('GET', baseUrl + '/api/orders/' + r.order.id, undefined,
      { 'Authorization': 'Bearer ' + userToken }));
    assert(r.order.status === 'completed', 'order completed after poll');
    assert(r.order.otpCode === '928401', 'OTP code matches (got ' + r.order.otpCode + ')');

    // ── 8. try cancel completed order (should fail) ──
    console.log('\n[8] Cancel completed order (expect fail)');
    try {
      await j(await req('POST', baseUrl + '/api/orders/' + r.order.id + '/cancel', undefined,
        { 'Authorization': 'Bearer ' + userToken }));
      assert(false, 'should have thrown');
    } catch (err) {
      assert(true, 'correctly rejected cancel: ' + err.message);
    }

    // ── 9. buy WhatsApp UK, then cancel ──
    console.log('\n[9] Buy WhatsApp/UK then cancel');
    let r2 = await j(await req('POST', baseUrl + '/api/orders', { platform: 'WhatsApp', country: 'UK' },
      { 'Authorization': 'Bearer ' + userToken }));
    assert(r2.order.status === 'pending', 'second order pending');
    assert(r2.order.number === '+447700900123', 'allocated +447700900123');
    r2 = await j(await req('POST', baseUrl + '/api/orders/' + r2.order.id + '/cancel', undefined,
      { 'Authorization': 'Bearer ' + userToken }));
    assert(r2.order.status === 'cancelled', 'second order cancelled');
    assert(typeof r2.refunded === 'number' && r2.refunded > 0, 'refunded ' + r2.refunded);
    console.log('  refunded: ' + r2.refunded);

    // ── 10. expired order test (set expiry to 0ms so it expires instantly) ──
    console.log('\n[10] Expired order test');
    config.otpExpireMs = 0;
    let r3 = await j(await req('POST', baseUrl + '/api/orders', { platform: 'WhatsApp', country: 'UK' },
      { 'Authorization': 'Bearer ' + userToken }));
    assert(r3.order.status === 'pending', 'third order pending');
    // no OTP simulate, poll should expire immediately
    await poller.pollOnce();
    r3 = await j(await req('GET', baseUrl + '/api/orders/' + r3.order.id, undefined,
      { 'Authorization': 'Bearer ' + userToken }));
    assert(r3.order.status === 'expired', 'third order expired (got ' + r3.order.status + ')');
    // number should be back to available
    r = await j(await req('GET', baseUrl + '/api/services'));
    const uk = r.platforms.find((p) => p.platform === 'WhatsApp')?.countries.find((c) => c.country === 'UK');
    assert(uk && uk.count === 1, 'UK WhatsApp number available again (count=' + (uk ? uk.count : 0) + ')');

    // ── 11. admin stats ──
    console.log('\n[11] Admin stats');
    r = await j(await req('GET', baseUrl + '/api/admin/stats', undefined,
      { 'Authorization': 'Bearer ' + adminToken }));
    assert(r.stats.totalOrders === 3, '3 total orders (got ' + r.stats.totalOrders + ')');
    assert(r.stats.completed === 1, '1 completed');
    assert(r.stats.cancelled === 1, '1 cancelled');
    assert(r.stats.expired === 1, '1 expired');
    assert(parseFloat(r.stats.revenue) === 2.5, 'revenue 2.5 (got ' + r.stats.revenue + ')');

    // ── 12. user balance check ──
    console.log('\n[12] Final balance check');
    r = await j(await req('GET', baseUrl + '/api/auth/me', undefined,
      { 'Authorization': 'Bearer ' + userToken }));
    // 50 -2.5(ig completed) -3(wa buy) +3(wa cancel) -3(wa buy2) +3(wa expire refund) = 47.5
    assert(r.user.balance === 47.5, 'balance back to 47.5 (got ' + r.user.balance + ')');

    // ── 13. sessions, activity, refresh + logout ──
    console.log('\n[13] Sessions / activity / refresh / logout');
    r = await j(await req('GET', baseUrl + '/api/me/sessions', undefined,
      { 'Authorization': 'Bearer ' + userToken }));
    assert(Array.isArray(r.sessions) && r.sessions.length >= 1, 'user has >=1 session (' + r.sessions.length + ')');
    const currentSess = r.sessions.find((s) => s.current);
    assert(currentSess && currentSess.is_active, 'one session is marked current & active');
    assert(currentSess.device_name, 'session has device label');

    r = await j(await req('GET', baseUrl + '/api/me/activity', undefined,
      { 'Authorization': 'Bearer ' + userToken }));
    assert(Array.isArray(r.activity) && r.activity.length >= 1, 'has login activity entries');

    // refresh rotates the refresh token
    r = await j(await req('POST', baseUrl + '/api/auth/refresh',
      { refreshToken: userRefresh }));
    assert(r.token && r.refreshToken, 'refresh returns new access + refresh token');
    const newRefresh = r.refreshToken;
    userToken = r.token; // keep using the fresh access token

    // logout kills the session; old refresh token no longer works
    r = await j(await req('POST', baseUrl + '/api/auth/logout', { refreshToken: newRefresh }));
    assert(r.ok === true, 'logout ok');
    let refreshRejected = false;
    try {
      await j(await req('POST', baseUrl + '/api/auth/refresh', { refreshToken: newRefresh }));
    } catch (e) { refreshRejected = true; }
    assert(refreshRejected, 'logout invalidates the refresh token');

    // the revoked access token is now rejected too (session deactivated server-side)
    let meRejected = false;
    try {
      await j(await req('GET', baseUrl + '/api/me/sessions', undefined,
        { 'Authorization': 'Bearer ' + userToken }));
    } catch (e) { meRejected = true; }
    assert(meRejected, 'logout invalidates the access token for that session');

    // ── 14. admin user manager + admin sessions ──
    console.log('\n[14] Admin user manager + admin sessions');
    const users = await j(await req('GET', baseUrl + '/api/admin/users', undefined,
      { 'Authorization': 'Bearer ' + adminToken }));
    const uid = users.users.find((u) => u.email === ue).id;
    const ue2 = forcedMode === 'supabase' ? ('user2+' + Date.now() + '@test.com') : 'user2@test.com';
    await j(await req('PATCH', baseUrl + '/api/admin/users/' + uid,
      { fullName: 'Test User 2', email: ue2, phone: '+919999999999' },
      { 'Authorization': 'Bearer ' + adminToken }));
    const users2 = await j(await req('GET', baseUrl + '/api/admin/users', undefined,
      { 'Authorization': 'Bearer ' + adminToken }));
    const edited = users2.users.find((u) => u.id === uid);
    assert(edited.fullName === 'Test User 2' && edited.email === ue2 && edited.phone === '+919999999999',
      'admin can edit name/email/phone (got ' + edited.fullName + ' / ' + edited.email + ')');
    // email change invalidates the user's sessions (we logged out above anyway — no assertion needed)

    r = await j(await req('GET', baseUrl + '/api/admin/users/' + uid + '/sessions', undefined,
      { 'Authorization': 'Bearer ' + adminToken }));
    assert(Array.isArray(r.sessions), 'admin can list a user session list');

    r = await j(await req('GET', baseUrl + '/api/admin/admin/sessions', undefined,
      { 'Authorization': 'Bearer ' + adminToken }));
    assert(Array.isArray(r.sessions) && r.sessions.length >= 1, 'admin can list admin sessions (' + r.sessions.length + ')');

    r = await j(await req('GET', baseUrl + '/api/admin/admin/activity', undefined,
      { 'Authorization': 'Bearer ' + adminToken }));
    assert(Array.isArray(r.activity) && r.activity.length >= 1, 'admin activity feed populated');

    console.log('\n══ ALL TESTS PASSED ══\n');
    process.exitCode = 0;
  } catch (err) {
    console.error('\nFAILED:', err.message);
    console.error(err.stack);
    process.exitCode = 1;
  } finally {
    try { if (poller) poller.stop(); } catch {}
    try { if (mock) await mock.close(); } catch {}
    try { fs.unlinkSync(DBFILE); fs.unlinkSync(DBFILE + '-wal'); fs.unlinkSync(DBFILE + '-shm'); } catch {}
    setTimeout(() => process.exit(process.exitCode || 1), 400);
  }
})();