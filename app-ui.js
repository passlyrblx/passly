(() => {
  const path = window.location.pathname.replace(/\/$/, '') || '/';
  const aliases = new Map([
    ['/', ['/']], ['/dashboard', ['/dashboard']], ['/rooms', ['/rooms']], ['/leaderboard', ['/leaderboard']],
    ['/profile', ['/profile']], ['/friends', ['/friends']],
    ['/livedonations', ['/livedonations']], ['/redeem', ['/redeem']], ['/admin', ['/admin']], ['/privacy', ['/privacy']], ['/terms', ['/terms']]
  ]);

  const ensureToastHost = () => {
    let host = document.getElementById('passlyToastHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'passlyToastHost';
      host.className = 'passly-toast-host';
      document.body.appendChild(host);
    }
    return host;
  };

  const normalizeMessage = (message) => {
    const text = String(message || 'Something went wrong. Please try again.');
    if (/guest users?.*earn passly coins/i.test(text)) return 'Guest users can’t earn Passly Coins. Please log in with Roblox to continue.';
    if (/no token|missing .*token|login required|please log in|guests? cannot|guest accounts/i.test(text)) return 'Please log in with Roblox to continue.';
    if (/database not ready|mongo|mongoose|cast to|validation failed|internal server|stack|syntaxerror|typeerror|referenceerror/i.test(text)) return 'Something went wrong on our side. Please try again in a moment.';
    return text.replace(/^Error:\s*/i, '');
  };

  const toast = (message, type = 'info') => {
    const host = ensureToastHost();
    const item = document.createElement('div');
    item.className = `passly-toast passly-toast-${type}`;
    item.setAttribute('role', type === 'error' ? 'alert' : 'status');
    item.innerHTML = `<span>${normalizeMessage(message)}</span><button type="button" aria-label="Dismiss">×</button>`;
    item.querySelector('button').addEventListener('click', () => item.remove());
    host.appendChild(item);
    setTimeout(() => item.remove(), 4800);
  };

  const modal = ({ title = 'Confirm action', message = '', confirmText = 'Continue', cancelText = 'Cancel', input = false, placeholder = '' } = {}) => new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'passly-modal-overlay';
    overlay.innerHTML = `
      <div class="passly-dialog" role="dialog" aria-modal="true" aria-label="${title}">
        <h2>${title}</h2>
        <p>${normalizeMessage(message)}</p>
        ${input ? `<textarea class="passly-dialog-input" placeholder="${placeholder}" rows="3"></textarea>` : ''}
        <div class="passly-dialog-actions">
          <button type="button" class="passly-dialog-cancel">${cancelText}</button>
          <button type="button" class="passly-dialog-confirm">${confirmText}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const inputEl = overlay.querySelector('.passly-dialog-input');
    const close = (value) => { overlay.remove(); resolve(value); };
    overlay.querySelector('.passly-dialog-cancel').addEventListener('click', () => close(input ? null : false));
    overlay.querySelector('.passly-dialog-confirm').addEventListener('click', () => close(input ? inputEl.value.trim() : true));
    overlay.addEventListener('click', (event) => { if (event.target === overlay) close(input ? null : false); });
    document.addEventListener('keydown', function onKey(event) {
      if (!document.body.contains(overlay)) return document.removeEventListener('keydown', onKey);
      if (event.key === 'Escape') { document.removeEventListener('keydown', onKey); close(input ? null : false); }
    });
    inputEl?.focus();
  });


  const PASSLY_COIN_ICON_URL = 'https://i.ibb.co/tMpcZCNh/file-00000000993871f8a74fdfa489ebf218-3.png';
  const coinIcon = (size = 'small') => `<span class="passly-coin-frame passly-coin-${size}" aria-hidden="true"><img src="${PASSLY_COIN_ICON_URL}" alt="" referrerpolicy="no-referrer"></span>`;
  const renderCoins = (amount = 0, size = 'small') => `<span class="passly-coin-balance" title="Coin balance">${coinIcon(size)}<span>${Number(amount || 0).toLocaleString()}</span></span>`;
  const updateCoinDisplays = (amount = 0) => {
    document.querySelectorAll('[data-passly-coins]').forEach((el) => { el.innerHTML = renderCoins(amount, el.dataset.coinSize || 'small'); });
  };
  const ensureNavbarCoins = async () => {
    const box = document.querySelector('.user-box');
    if (!box || box.querySelector('[data-passly-navbar-coins]')) return;
    const balance = document.createElement('span');
    balance.dataset.passlyCoins = 'true';
    balance.dataset.passlyNavbarCoins = 'true';
    balance.dataset.coinSize = 'small';
    balance.innerHTML = renderCoins(0);
    box.insertBefore(balance, box.firstChild);
    const notificationLink = document.createElement('a');
    notificationLink.href = '/friends#notifications';
    notificationLink.className = 'passly-notification-link';
    notificationLink.title = 'Open friend notifications';
    notificationLink.setAttribute('aria-label', 'Open friend notifications');
    notificationLink.innerHTML = '<span aria-hidden="true">🔔</span><span class="passly-notification-count" data-passly-notification-count hidden>0</span>';
    box.insertBefore(notificationLink, balance.nextSibling);
    const token = localStorage.getItem('passly_token');
    if (!token) return;
    try {
      const res = await fetch('/api/economy', { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        const data = await res.json();
        updateCoinDisplays(data.coins || 0);
        window.dispatchEvent(new CustomEvent('passly:economy', { detail: data }));
      }
      const notificationsRes = await fetch('/api/friends/notifications', { headers: { Authorization: `Bearer ${token}` } });
      if (notificationsRes.ok) {
        const notificationsData = await notificationsRes.json();
        const count = (notificationsData.notifications || []).length;
        const countEl = document.querySelector('[data-passly-notification-count]');
        if (countEl) {
          countEl.textContent = count > 99 ? '99+' : String(count);
          countEl.hidden = count === 0;
        }
      }
    } catch (e) {}
  };

  window.PasslyUI = {
    coinIcon,
    renderCoins,
    updateCoinDisplays,
    toast,
    error: (message) => toast(message, 'error'),
    success: (message) => toast(message, 'success'),
    confirm: (message, options = {}) => modal({ title: options.title || 'Please confirm', message, confirmText: options.confirmText || 'Confirm', cancelText: options.cancelText || 'Cancel' }),
    prompt: (message, options = {}) => modal({ title: options.title || 'Tell us more', message, confirmText: options.confirmText || 'Submit', cancelText: options.cancelText || 'Cancel', input: true, placeholder: options.placeholder || '' })
  };
  window.alert = (message) => window.PasslyUI.toast(message);


  const buildPasslyMenu = async () => {
    const desktopNav = document.querySelector('.nav-links');
    const mobileNav = document.querySelector('.mobile-menu');
    if (!desktopNav && !mobileNav) return;
    const token = localStorage.getItem('passly_token');
    let isAdmin = false;
    if (token) {
      try {
        const res = await fetch('/api/admin/check', { headers: { Authorization: `Bearer ${token}` } });
        if (res.ok) isAdmin = !!(await res.json()).isAdmin;
      } catch (e) {}
    }
    const groups = [
      { label: '🏠 Home', href: '/dashboard' },
      { label: '🚪 Rooms', href: '/rooms' },
      { label: '🌐 Community', href: '/leaderboard', children: [
        { label: 'Leaderboard', href: '/leaderboard' },
        { label: 'Friends', href: '/friends' },
        { label: 'Live donations', href: '/livedonations' }
      ]},
      { label: '⚙️ Settings', href: '/profile', children: [
        { label: 'Profile settings', href: '/profile' },
        { label: 'Booth settings', href: '/booths' },
        { label: 'Find player', href: '/find-player' },
        { label: 'Passly rewards', href: '/booths#earn-passly' },
        { label: 'Redeem coupon', href: '/redeem' }
      ]}
    ];
    if (isAdmin) groups.push({ label: '🔧 Admin', href: '/admin', children: [
      { label: 'Dashboard', href: '/admin' },
      { label: 'Admin Chat', href: '/admin#admin-chat-card' },
      { label: 'Coupons', href: '/admin#coupon-card' }
    ]});
    groups.push({ label: '🛟 Support', href: '/terms', children: [
      { label: 'Terms of Service', href: '/terms' },
      { label: 'Privacy Policy', href: '/privacy' },
      {
        label: 'Discord Support',
        href: 'https://discord.gg/9qNpCGztun',
        description: 'Open a support ticket and tell us what you need help with.',
        external: true
      }
    ]});
    const renderChild = (child) => `<a href="${child.href}"${child.external ? ' target="_blank" rel="noopener noreferrer"' : ''}><span>${child.label}</span>${child.description ? `<small>${child.description}</small>` : ''}</a>`;
    const desktopHtml = groups.map((group) => group.children ? `
      <div class="passly-nav-group">
        <a href="${group.href}" class="passly-nav-parent">${group.label}</a>
        <button type="button" class="passly-submenu-toggle" aria-expanded="false" aria-label="Show ${group.label} options">›</button>
        <div class="passly-submenu">${group.children.map(renderChild).join('')}</div>
      </div>` : `<a href="${group.href}">${group.label}</a>`).join('');
    const mobileHtml = `<button class="close-menu" id="closeMenuBtn">&times;</button>` + groups.map((group) => group.children ? `
      <div class="passly-mobile-group">
        <div class="passly-mobile-row"><a href="${group.href}">${group.label}</a><button type="button" class="passly-submenu-toggle" aria-expanded="false" aria-label="Show ${group.label} options">›</button></div>
        <div class="passly-submenu">${group.children.map(renderChild).join('')}</div>
      </div>` : `<a href="${group.href}">${group.label}</a>`).join('');
    if (desktopNav) desktopNav.innerHTML = desktopHtml;
    if (mobileNav) mobileNav.innerHTML = mobileHtml;
    document.querySelectorAll('.passly-submenu-toggle').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        const group = button.closest('.passly-nav-group, .passly-mobile-group');
        const open = group?.classList.toggle('is-open');
        button.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    });
  };

  const setupMobileMenu = () => {
    const menu = document.getElementById('mobileMenu');
    const overlay = document.getElementById('menuOverlay');
    const hamburger = document.getElementById('hamburgerBtn');
    const closeBtn = document.getElementById('closeMenuBtn');
    if (!menu || !overlay || !hamburger) return;

    hamburger.setAttribute('aria-expanded', 'false');
    hamburger.setAttribute('aria-controls', menu.id);
    menu.setAttribute('role', 'dialog');
    menu.setAttribute('aria-modal', 'true');
    menu.setAttribute('aria-label', 'Passly navigation');

    const markOpen = () => { hamburger.setAttribute('aria-expanded', 'true'); menu.dataset.open = 'true'; overlay.dataset.open = 'true'; menu.style.left = '0'; overlay.style.display = 'block'; document.body.style.overflow = 'hidden'; };
    const markClosed = () => { hamburger.setAttribute('aria-expanded', 'false'); delete menu.dataset.open; delete overlay.dataset.open; menu.style.left = '-100%'; overlay.style.display = 'none'; document.body.style.overflow = ''; };

    hamburger.addEventListener('click', () => requestAnimationFrame(markOpen));
    overlay.addEventListener('click', () => requestAnimationFrame(markClosed));
    closeBtn?.addEventListener('click', () => requestAnimationFrame(markClosed));
    menu.querySelectorAll('a').forEach((link) => link.addEventListener('click', markClosed));
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && menu.dataset.open === 'true') { closeBtn?.click(); markClosed(); } });
  };

  buildPasslyMenu().then(() => {
    ensureNavbarCoins();
    document.querySelectorAll('.nav-links a, .mobile-menu a').forEach((link) => {
      const href = new URL(link.getAttribute('href'), window.location.origin).pathname.replace(/\/$/, '') || '/';
      const isCurrent = (aliases.get(path) || [path]).includes(href);
      if (isCurrent) link.setAttribute('aria-current', 'page');
    });
    document.querySelectorAll('.passly-nav-group, .passly-mobile-group').forEach((group) => {
      if (!group.querySelector('a[aria-current="page"]')) return;
      group.classList.add('has-current-page');
      group.querySelector('.passly-nav-parent')?.setAttribute('aria-current', 'page');
    });
    setupMobileMenu();
  });
})();
