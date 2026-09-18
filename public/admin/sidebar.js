// Shared admin sidebar — enterprise SaaS nav with icons, collapse and top header.
window.TOP_TABS = [
  { key: 'dashboard', label: 'Dashboard', href: '/admin/index' },
  { key: 'services', label: 'Services', href: '/admin/services' },
  { key: 'numbers', label: 'Numbers', href: '/admin/numbers' },
  { key: 'users', label: 'Users', href: '/admin/users' },
  { key: 'orders', label: 'Orders', href: '/admin/orders' },
  { key: 'tickets', label: 'Tickets', href: '/admin/tickets' },
  { key: 'payments', label: 'Payments', href: '/admin/payments' },
  { key: 'settings', label: 'Settings', href: '/admin/settings' },
];

window.mountSidebar = function (active) {
  const groups = [
    { label: 'Overview', items: [
      { key: 'dashboard', label: 'Dashboard', href: '/admin/index', icon: 'dashboard' },
    ] },
    { label: 'Catalog', items: [
      { key: 'services', label: 'Services', href: '/admin/services', icon: 'services' },
      { key: 'numbers', label: 'Numbers', href: '/admin/numbers', icon: 'numbers' },
    ] },
    { label: 'Customers', items: [
      { key: 'users', label: 'Users', href: '/admin/users', icon: 'users' },
      { key: 'orders', label: 'Orders', href: '/admin/orders', icon: 'orders' },
      { key: 'tickets', label: 'Tickets', href: '/admin/tickets', icon: 'flag' },
    ] },
    { label: 'Billing', items: [
      { key: 'payments', label: 'Payments', href: '/admin/payments', icon: 'wallet' },
    ] },
  ];
  const bottom = [
    { key: 'store', label: 'Storefront', href: '/app/dashboard', icon: 'store' },
    { key: 'settings2', label: 'Settings', href: '/admin/settings', icon: 'settings' },
    { key: 'logout', label: 'Sign out', onClick: 'logout()', icon: 'logout' },
  ];

  const link = (it) => {
    const cls = it.key === active ? ' class="active"' : '';
    const attr = it.onClick ? ' onclick="' + it.onClick + '"' : (it.href ? ' href="' + it.href + '"' : '');
    const tip = it.href ? ' title="' + it.label + '" data-plain="1"' : '';
    return '<a' + cls + attr + tip + '><span class="side-ico">' + uiIcon(it.icon, 18) + '</span><span class="side-label-text">' + it.label + '</span></a>';
  };

  let html = '<div class="side-brand"><span class="logo"><span class="dot"></span><span>SMS<b>OTP</b></span></span><span class="side-brand-sub">Admin Console</span></div>';
  for (const g of groups) {
    html += '<div class="side-group"><span class="side-label">' + g.label + '</span>' + g.items.map(link).join('') + '</div>';
  }
  html += '<div class="side-group side-bottom">' + bottom.map(link).join('') + '</div>';
  document.getElementById('side').innerHTML = html;

  ensureTopbar(active);
  if (window.initSideState) window.initSideState();
};

function ensureTopbar(active) {
  if (!document.querySelector('.admin-main')) return;
  function mount() {
    if (window.mountTopbar && document.querySelector('.admin-main') && !document.getElementById('topbar')) {
      window.mountTopbar({
        active, tabs: window.TOP_TABS,
        user: API.user,
        docs: '/app/api-docs',
        brand: 'SMS<b>OTP</b>',
        settingsOnClick: "window.location.href='/admin/index'",
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