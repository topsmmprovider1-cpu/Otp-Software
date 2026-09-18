// Shared user-panel sidebar — enterprise SaaS nav with icons, collapse and top header.
window.TOP_USER_TABS = [
  { key: 'index', label: 'Dashboard', href: '/app/index' },
  { key: 'buy', label: 'Buy Numbers', href: '/app/dashboard' },
  { key: 'orders', label: 'My Orders', href: '/app/orders' },
  { key: 'wallet', label: 'Wallet', href: '/app/wallet' },
  { key: 'api-docs', label: 'API Docs', href: '/app/api-docs' },
  { key: 'account', label: 'Account', href: '/app/account' },
  { key: 'tickets', label: 'Support', href: '/app/tickets' },
];

window.mountUserSidebar = function (active) {
  const groups = [
    { label: 'Overview', items: [
      { key: 'index', label: 'Dashboard', href: '/app/index', icon: 'dashboard' },
      { key: 'orders', label: 'My Orders', href: '/app/orders', icon: 'orders' },
    ] },
    { label: 'Shop', items: [
      { key: 'buy', label: 'Buy Numbers', href: '/app/dashboard', icon: 'numbers' },
    ] },
    { label: 'Billing', items: [
      { key: 'wallet', label: 'Wallet', href: '/app/wallet', icon: 'wallet' },
    ] },
    { label: 'Developer', items: [
      { key: 'api-docs', label: 'API Docs', href: '/app/api-docs', icon: 'services' },
      { key: 'account', label: 'Account & API Key', href: '/app/account', icon: 'key' },
    ] },
  ];
  const bottom = [
    { key: 'tickets', label: 'Support / Tickets', href: '/app/tickets', icon: 'flag' },
    { key: 'logout', label: 'Sign out', onClick: 'logout()', icon: 'logout' },
  ];

  const link = (it) => {
    const cls = it.key === active ? ' class="active"' : '';
    const attr = it.onClick ? ' onclick="' + it.onClick + '"' : (it.href ? ' href="' + it.href + '"' : '');
    const tip = it.href ? ' title="' + it.label + '" data-plain="1"' : '';
    return '<a' + cls + attr + tip + '><span class="side-ico">' + uiIcon(it.icon, 18) + '</span><span class="side-label-text">' + it.label + '</span></a>';
  };

  let html = '<div class="side-brand"><span class="logo"><span class="dot"></span><span>SMS<b>OTP</b></span></span><span class="side-brand-sub">My Account</span></div>';
  html += '<div class="side-bal"><span class="sbl">Balance</span><span class="sbn" id="sideBal">$0.00</span><a class="sbt" href="/app/wallet"><span class="side-ico">' + uiIcon('plus', 13) + '</span> Top up</a></div>';
  for (const g of groups) {
    html += '<div class="side-group"><span class="side-label">' + g.label + '</span>' + g.items.map(link).join('') + '</div>';
  }
  html += '<div class="side-group side-bottom">' + bottom.map(link).join('') + '</div>';
  document.getElementById('side').innerHTML = html;

  setSideBalance(API.user ? API.user.balance : 0);
  ensureTopbar(active);
  if (window.initSideState) window.initSideState();
};

window.setSideBalance = function (b) {
  const el = document.getElementById('sideBal');
  if (el) el.textContent = fmtNum(b);
};

window.refreshSideBalance = async function () {
  const u = await refreshMe();
  if (u) setSideBalance(u.balance);
};

function ensureTopbar(active) {
  if (!document.querySelector('.admin-main')) return;
  function mount() {
    if (window.mountTopbar && document.querySelector('.admin-main') && !document.getElementById('topbar')) {
      window.mountTopbar({
        active, tabs: window.TOP_USER_TABS,
        user: API.user,
        docs: '/app/api-docs',
        brand: 'SMS<b>OTP</b>',
        settingsOnClick: "window.location.href='/app/account'",
      });
      if (window.initSideState) window.initSideState();
    }
  }
  if (window.mountTopbar) { mount(); return; }
  const s = document.createElement('script');
  s.src = '/js/layout.js';
  document.head.appendChild(s);
  s.onload = mount;
  window.addEventListener('DOMContentLoaded', () => { if (window.mountTopbar) mount(); });
  window.addEventListener('load', () => { if (window.mountTopbar) mount(); });
}