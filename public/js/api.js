const API = {
  get token() { return localStorage.getItem('otp_token') || ''; },
  set token(v) { v ? localStorage.setItem('otp_token', v) : localStorage.removeItem('otp_token'); },
  get refreshToken() { return localStorage.getItem('otp_refresh') || ''; },
  set refreshToken(v) { v ? localStorage.setItem('otp_refresh', v) : localStorage.removeItem('otp_refresh'); },
  get user() {
    try { return JSON.parse(localStorage.getItem('otp_user') || 'null'); } catch { return null; }
  },
  set user(v) { v ? localStorage.setItem('otp_user', JSON.stringify(v)) : localStorage.removeItem('otp_user'); },

  // persist tokens + user after login/register/refresh
  setSession(d) {
    if (d && d.token) this.token = d.token;
    if (d && d.refreshToken) this.refreshToken = d.refreshToken;
    if (d && d.user) { d.user.balance = Number(d.user.balance) || 0; this.user = d.user; }
  },

  async req(method, url, body, _retry = true) {
    const headers = {};
    if (this.token) headers['Authorization'] = 'Bearer ' + this.token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    let data = null;
    try { data = await res.json(); } catch { data = {}; }
    if (res.status === 401 && _retry && this.refreshToken) {
      const ok = await this.refreshNow();
      if (ok) return this.req(method, url, body, false);
      this.forceLogout('Session expired. Please sign in again.');
      const err = new Error(data.error || 'Session expired');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || ('Request failed (' + res.status + ')'));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  },

  // rotate the refresh token + mint a new access token
  async refreshNow() {
    const refresh = this.refreshToken;
    if (!refresh) return false;
    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: refresh }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) return false;
      this.setSession(d);
      updateBalanceUI();
      return true;
    } catch (err) { return false; }
  },

  // clear everything + bounce to the login page
  forceLogout(msg) {
    if (msg) { try { toast(msg, 'err'); } catch (e) {} }
    this.token = ''; this.refreshToken = ''; this.user = null;
    window.location.href = loginUrl();
  },

  async logout() {
    const done = () => { this.token = ''; this.refreshToken = ''; this.user = null; window.location.href = '/login'; };
    try { await this.req('POST', '/api/auth/logout', { refreshToken: this.refreshToken }, false); } catch (e) {}
    done();
  },

  get(url) { return this.req('GET', url); },
  post(url, body) { return this.req('POST', url, body); },
  patch(url, body) { return this.req('PATCH', url, body); },
  del(url) { return this.req('DELETE', url); },
};

function e_() {}

function toast(msg, type = 'ok') {
  let wrap = document.getElementById('toastWrap');
  if (!wrap) { wrap = document.createElement('div'); wrap.id = 'toastWrap'; document.body.appendChild(wrap); }
  const el = document.createElement('div');
  el.className = 'toast ' + (type === 'err' ? 'err' : type === 'info' ? '' : 'ok');
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; setTimeout(() => el.remove(), 400); }, 3800);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtNum(n, cur = '$') {
  const v = Number(n || 0);
  return cur + v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function timeAgo(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60 * 1000) return 'just now';
  const m = Math.floor(ms / 60000);
  if (m < 60) return m + 'm ago';
  return Math.floor(m / 60) + 'h ago';
}

function pad(n) { return String(n).padStart(2, '0'); }
function fmtClock(ms) {
  if (ms <= 0) return '0:00';
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + ':' + pad(s % 60);
}

function loginUrl(next) {
  const target = next || (window.location ? window.location.pathname + window.location.search : '/');
  return '/login?next=' + encodeURIComponent(target);
}

function requireAuth() {
  if (!API.token) { window.location.href = loginUrl(); throw new Error('noauth'); }
}
function requireAdmin() {
  requireAuth();
  if (!(API.user && API.user.role === 'admin')) window.location.href = '/';
}

async function refreshMe() {
  try {
    const { user } = await API.get('/api/auth/me');
    API.user = user;
    updateBalanceUI();
    return user;
  } catch (e) {
    if (e.status === 401) { API.token = ''; API.user = null; }
    return null;
  }
}

// startAutoRefresh: quietly refresh the access token early so sessions survive long idle use.
function startAutoRefresh() {
  if (window.__autoRefreshStarted || !API.refreshToken) return;
  window.__autoRefreshStarted = true;
  // refresh every 5 minutes (well under the 6h access-token life) — cheap & keeps sessions alive
  setInterval(async () => {
    if (document.visibilityState === 'visible' && API.refreshToken) await API.refreshNow();
  }, 5 * 60 * 1000);
}

function updateBalanceUI() {
  const el = document.getElementById('balanceChip');
  const u = API.user;
  if (el) {
    if (u) { el.classList.remove('hidden'); el.textContent = 'Balance: ' + fmtNum(u.balance) + '  •  ' + esc(u.fullName); }
    else el.classList.add('hidden');
  }
}

function logout() {
  API.logout();
}

window.API = API;
window.toast = toast;
window.esc = esc;
window.fmtNum = fmtNum;
window.timeAgo = timeAgo;
window.fmtClock = fmtClock;
window.loginUrl = loginUrl;
window.requireAuth = requireAuth;
window.requireAdmin = requireAdmin;
window.refreshMe = refreshMe;
window.startAutoRefresh = startAutoRefresh;
window.updateBalanceUI = updateBalanceUI;
window.logout = logout;