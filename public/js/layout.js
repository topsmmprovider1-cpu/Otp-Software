/* Shared application layout: top header (with tabs), sidebar collapse,
 * KPI cards, welcome banner, empty/skeleton helpers. Enterprise light SaaS. */

window.LAYOUT = {};

// ---------- sidebar collapse ----------
window.toggleSide = function () {
  const layout = document.querySelector('.admin-layout');
  if (!layout) return;
  const swipe = window.innerWidth <= 900;
  const side = document.getElementById('side');
  if (side && swipe) {
    const open = side.classList.contains('mobile-open');
    side.classList.toggle('mobile-open', !open);
    let scrim = document.getElementById('sideScrim');
    if (open) { if (scrim) scrim.remove(); return; }
    if (!scrim) {
      scrim = document.createElement('div');
      scrim.id = 'sideScrim';
      scrim.className = 'side-scrim';
      scrim.addEventListener('click', () => { document.getElementById('side')?.classList.remove('mobile-open'); scrim.remove(); });
      document.body.appendChild(scrim);
    }
    return;
  }
  const collapsed = layout.classList.toggle('side-collapsed');
  if (side) side.classList.toggle('collapsed', collapsed);
  localStorage.setItem('otp_side_collapsed', collapsed ? '1' : '0');
};

window.toggleFullscreen = function () {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
  } else if (document.exitFullscreen) {
    document.exitFullscreen();
  }
};

window.initSideState = function () {
  if (window.innerWidth > 900 && localStorage.getItem('otp_side_collapsed') === '1') {
    const layout = document.querySelector('.admin-layout');
    const side = document.getElementById('side');
    if (layout) layout.classList.add('side-collapsed');
    if (side) side.classList.add('collapsed');
  }
};

// ---------- avatar ----------
window.avatarHtml = function (name) {
  const p = String(name || '?').replace(/[<>]/g, '').split(/[\s@]+/).filter(Boolean);
  const ch = ((p[0] || '?')[0] || '?').toUpperCase() + (p[1] ? p[1][0].toUpperCase() : '');
  return '<span class="avatar sm">' + esc(ch) + '</span>';
};

// ---------- top header ----------
window.mountTopbar = function (opts) {
  opts = opts || {};
  const main = document.querySelector('.admin-main');
  if (!main) return;
  let bar = document.getElementById('topbar');
  if (!bar) {
    bar = document.createElement('header');
    bar.id = 'topbar';
    bar.className = 'topbar';
    main.prepend(bar);
  }

  const user = opts.user || API.user;
  const tabs = opts.tabs || [];
  const brand = opts.brand || 'SMS<b style="color:var(--accent)">OTP</b>';

  let html = '<div class="tb-left">';
  html += '<button class="tb-btn" onclick="toggleSide()" aria-label="Toggle sidebar" title="Toggle sidebar">' + uiIcon('menu', 19) + '</button>';
  html += '<span class="side-brand-sub" style="margin:0;display:inline-flex;align-items:center;gap:9px">';
  html += '<span class="logo" style="font-size:16px"><span class="dot"></span> ' + brand + '</span>';
  html += '</span>';
  html += '</div>';

  html += '<div class="tb-tabs">';
  tabs.forEach((t) => {
    const active = t.key === opts.active ? ' active' : '';
    const close = '<span class="t-x" onclick="event.stopPropagation();window.location.href=\'' + t.href + '\'">' + uiIcon('close', 11) + '</span>';
    html += '<span class="tb-tab' + active + '" onclick="window.location.href=\'' + t.href + '\'" title="' + esc(t.label) + '">' + esc(t.label) + (active ? close : '') + '</span>';
  });
  html += '</div>';
  html += '<div class="tb-equity"></div>';

  html += '<div class="tb-right">';
  if (opts.docs) html += '<button class="tb-btn" onclick="window.location.href=\'' + opts.docs + '\'">' + uiIcon('key', 16) + '<span class="breadcrumb-hide">API Docs</span></button>';
  html += '<span class="tb-sep"></span>';
  html += '<button class="tb-btn" onclick="toggleFullscreen()" aria-label="Fullscreen" title="Fullscreen">' + uiIcon('expand', 17) + '</button>';
  html += '<div class="tb-user">' + avatarHtml(user && user.fullName) + '<div><div class="tu-name">' + esc((user && user.fullName) || 'Guest') + '</div>' +
    '<div class="tu-role">' + esc((user && user.role) === 'admin' ? 'Administrator' : 'Member') + '</div></div></div>';
  html += '<button class="tb-btn" aria-label="Settings" title="Settings" onclick="' + (opts.settingsOnClick || "window.location.href='/app/account'") + '">' + uiIcon('settings', 17) + '</button>';
  html += '</div>';

  bar.innerHTML = html;
};

// ---------- welcome banner ----------
window.welcomeBanner = function (opts) {
  return '<div class="banner"><div>' +
    '<div class="b-title">' + esc(opts.title || '') + '</div>' +
    '<div class="b-sub">' + esc(opts.sub || '') + '</div>' +
    '</div>' +
    '<div class="b-illu">' + uiIcon(opts.icon || 'dashboard', 24) + '</div></div>';
};

// ---------- KPI card ----------
window.kpiCard = function (opts) {
  const cta = opts.cta
    ? '<div class="k-cta"><button class="btn sm ' + (opts.ctaCls || 'success') + '" onclick="' + opts.cta.onclick + '">' + esc(opts.cta.label) + '</button></div>'
    : '';
  return '<div class="kpi-card">' +
    '<span class="k-ic" ' + (opts.tint ? 'style="background:' + opts.tint + ';color:' + (opts.tintColor || 'var(--accent)') + '"' : '') + '>' + uiIcon(opts.icon || 'chart', 20) + '</span>' +
    '<div class="k-body"><div class="k-lbl">' + esc(opts.label) + '</div>' +
    '<div class="k-val" id="' + (opts.id || '') + '" ' + (opts.valueStyle || '') + '>' + esc(opts.value) + '</div></div>' +
    cta + '</div>';
};

// ---------- empty / error / skeleton ----------
window.emptyState = function (opts) {
  return '<div class="empty">' +
    '<span class="e-ic">' + uiIcon(opts.icon || 'inbox', 22) + '</span>' +
    '<div class="e-title">' + esc(opts.title || 'No data available') + '</div>' +
    (opts.sub ? '<div class="e-sub">' + esc(opts.sub) + '</div>' : '') +
    (opts.action ? '<button class="btn solid sm" style="margin-top:6px" onclick="' + opts.action.onclick + '">' + esc(opts.action.label) + '</button>' : '') +
    '</div>';
};

window.errorState = function (opts) {
  return '<div class="empty">' +
    '<span class="e-ic" style="background:var(--red-bg);color:var(--red)">' + uiIcon('alert', 22) + '</span>' +
    '<div class="e-title">' + esc(opts.title || 'Unable to load data') + '</div>' +
    '<div class="e-sub">' + esc(opts.sub || 'Please try again.') + '</div>' +
    '<button class="btn solid sm" style="margin-top:6px" onclick="' + opts.retry + '">Retry</button>' +
    '</div>';
};

window.skelKpis = function (n) {
  let s = '';
  for (let i = 0; i < (n || 4); i++) s += '<div class="skel skel-card" style="height:82px"></div>';
  return '<div class="kpi-grid">' + s + '</div>';
};
window.skelRows = function (n) {
  let s = '';
  for (let i = 0; i < (n || 5); i++) s += '<div class="skel skel-row"></div>';
  return s;
};

window.LAYOUT = { mountTopbar, welcomeBanner, kpiCard, emptyState, errorState, skelKpis, skelRows, toggleSide };