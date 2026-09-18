const path = require('path');
const os = require('os');
const fs = require('fs');
process.env.DB_MODE = 'sqlite';
process.env.SQLITE_FILE = path.join(os.tmpdir(), 'otp-svc-' + Date.now() + '.db');
process.env.JWT_SECRET = 'test-secret';
process.env.ADMIN_EMAIL = 'admin@site.com';
process.env.ADMIN_PASSWORD = 'admin123';
process.env.OTP_EXPIRE_MINUTES = '60';
process.env.POLL_INTERVAL_MS = '99999';

const { createServer } = require('./mock-sms');
const { init } = require('../src/app');
const poller = require('../src/services/poller');

let run = 0;
const ok = (cond, msg) => { if (!cond) throw new Error('ASSERT FAILED: ' + msg); console.log('  ✓ ' + msg); run++; };
const req = (m, url, body, h = {}) => {
  const headers = { ...h };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(url, { method: m, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
};
const j = async (r, expect = 200) => {
  const d = await r.json();
  if (r.status !== expect) throw new Error('Expected ' + expect + ' got ' + r.status + ': ' + JSON.stringify(d));
  return d;
};

const LINES = [
  '+12089795910----http://localhost:5099/api/record?token=AAA1',
  '+12089754497----http://localhost:5099/api/record?token=BBB2',
  '+12089790338----http://localhost:5099/api/record?token=CCC3',
  '+12089774794----http://localhost:5099/api/record?token=DDD4',
  '+12087232242----http://localhost:5099/api/record?token=EEE5',
  '+12086947536----http://localhost:5099/api/record?token=FFF6',
  '+12089884818----http://localhost:5099/api/record?token=GGG7',
  '+12088403484----http://localhost:5099/api/record?token=HHH8',
  '+12089789706----http://localhost:5099/api/record?token=III9',
  '+12089758767----http://localhost:5099/api/record?token=JJJ0',
].join('\n');

(async () => {
  try {
    const mock = createServer();
    await mock.listen(5099);
    const app = await init();
    await new Promise((r) => app.listen(5199, r));
    const B = 'http://localhost:5199';
    console.log('\n[1] Admin creates service with 10 "number----url" lines');
    let r = await j(await req('POST', B + '/api/auth/login', { email: 'admin@site.com', password: 'admin123' }));
    const adminT = r.token;
    const adminH = { 'Authorization': 'Bearer ' + adminT };
    r = await j(await req('POST', B + '/api/admin/services', { platform: 'SMS8API', country: 'USA', price: 1, apiUrl: '', lines: LINES }, adminH));
    ok(r.created === true, 'service created');
    ok(r.added === 10, '10 numbers added (got ' + r.added + ')');

    console.log('[2] Each number kept its own api_url/token');
    const nums = (await j(await req('GET', B + '/api/admin/numbers', undefined, adminH))).numbers.filter((n) => n.platform === 'SMS8API');
    const withUrl = nums.filter((n) => n.api_url.includes('token='));
    ok(withUrl.length === 10, '10/10 numbers have their own api_url');
    ok(nums.some((n) => n.api_url.endsWith('token=AAA1')) && nums.some((n) => n.api_url.endsWith('token=JJJ0')), 'per-number tokens stored');

    console.log('[3] Buyer registration + balance');
    r = await j(await req('POST', B + '/api/auth/register', { fullName: 'Buyer', email: 'buyer@test.com', password: '123456' }));
    const userT = r.token; const userH = { 'Authorization': 'Bearer ' + userT };
    const uid = r.user.id;
    r = await j(await req('POST', B + '/api/admin/users/' + uid + '/balance', { amount: 20 }, adminH));
    ok(+r.balance === 20, 'balance topped up to ' + r.balance);

    console.log('[4] Buy -> allocates a number FROM the list with its own URL');
    r = await j(await req('POST', B + '/api/orders', { platform: 'SMS8API', country: 'USA' }, userH));
    ok(r.order.status === 'pending', 'order pending');
    const allocated = nums.find((n) => n.number === r.order.number);
    ok(allocated && allocated.api_url, 'allocated number is one of the listed numbers');

    console.log('[5] OTP arrives on THAT number token -> pulled & returned');
    const tok = new URL(allocated.api_url).searchParams.get('token');
    await fetch('http://localhost:5099/simulate?token=' + tok + '&code=987654');
    await poller.pollOnce();
    r = await j(await req('GET', B + '/api/orders/' + r.order.id, undefined, userH));
    ok(r.order.status === 'completed', 'order completed');
    ok(r.order.otpCode === '987654', 'OTP from the number' + "'" + 's own url+token: ' + r.order.otpCode);

    console.log('[6] External API response (api/v1) returns the OTP');
    const keyRes = await j(await req('POST', B + '/api/me/api-keys', {}, userH));
    const ak = keyRes.apiKey.apiKey;
    r = await j(await req('GET', B + '/api/v1/order/' + r.order.orderId, undefined, { 'Authorization': 'Bearer ' + ak }));
    ok(r.success === true && r.order.otp === '987654', 'api/v1/order returns otp=987654');

    console.log('[7] Plain number line uses the service api_url');
    r = await j(await req('POST', B + '/api/admin/services', { platform: 'SMS8API', country: 'UK', price: 2, apiUrl: '', lines: '+447700900000' }, adminH));
    ok(r.added === 1, 'plain number added');
    const nums2 = (await j(await req('GET', B + '/api/admin/numbers', undefined, adminH))).numbers.filter((n) => n.platform === 'SMS8API' && n.country === 'UK');
    ok(nums2.length === 1 && nums2[0].api_url === '', 'plain line has empty api_url (service-level only)');

    console.log('[8] Numbers page gives clear error for ---- lines');
    r = await j(await req('POST', B + '/api/admin/numbers', { lines: '+12089795910----http://localhost:5099/api/record?token=Z' }, adminH), 400);
    ok(r.errors && r.errors.length === 1, 'clear error returned: ' + (r.errors[0] || '').slice(0, 50) + '…');

    console.log('\n══ ALL ' + run + ' CHECKS PASSED ══\n');
    poller.stop();
    await mock.close();
    process.exit(0);
  } catch (e) {
    console.error('\nFAILED:', e.message);
    process.exit(1);
  }
})();