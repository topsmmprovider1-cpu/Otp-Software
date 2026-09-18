// Mock of https://api.sms8.net/api/record — used only for local testing.
const http = require('http');

function createServer() {
  const store = new Map(); // token -> code

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    res.setHeader('Content-Type', 'application/json');

    if (u.pathname === '/simulate' && u.searchParams.get('token')) {
      // simulate an incoming SMS: set the OTP for a token
      store.set(u.searchParams.get('token'), u.searchParams.get('code') || '123456');
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (u.pathname === '/reset' && u.searchParams.get('token')) {
      store.delete(u.searchParams.get('token'));
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (u.pathname === '/api/record') {
      const code = store.get(u.searchParams.get('token')) || '';
      res.end(JSON.stringify({
        code: code ? 1 : 0,
        msg: code ? 'verification code found' : 'No verification code',
        data: {
          code,
          code_time: code ? new Date().toLocaleString() : '',
          expired_date: '2099-01-01 00:00:00',
        },
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });

  return {
    store,
    listen: (port) => new Promise((resolve) => server.listen(port, resolve)),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { createServer };