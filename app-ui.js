(() => {
  const path = window.location.pathname.replace(/\/$/, '') || '/';
  const aliases = new Map([
    ['/', ['/']], ['/dashboard', ['/dashboard']], ['/rooms', ['/rooms']], ['/game-rooms', ['/game-rooms']], ['/leaderboard', ['/leaderboard']],
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


  const coinIcon = (size = 'small') => `<span class="passly-coin-frame passly-coin-${size}" aria-hidden="true"></span>`;
  const renderCoins = (amount = 0, size = 'small') => `<span class="passly-coin-balance" title="Coin balance">${coinIcon(size)}<span>${Number(amount || 0).toLocaleString()}</span></span>`;
  const updateCoinDisplays = (amount = 0) => {
    document.querySelectorAll('[data-passly-coins]').forEach((el) => { el.innerHTML = renderCoins(amount, el.dataset.coinSize || 'small'); });
  };
  const ensureNavbarCoins = async () => {
    const box = document.querySelector('.user-box');
    if (!box || box.querySelector('[data-passly-navbar-coins]')) return;
    const avatar = box.querySelector('.user-avatar');
    const balance = document.createElement('span');
    balance.dataset.passlyCoins = 'true';
    balance.dataset.passlyNavbarCoins = 'true';
    balance.dataset.coinSize = 'small';
    balance.innerHTML = renderCoins(0);
    const notificationLink = document.createElement('a');
    notificationLink.href = '/friends#notifications';
    notificationLink.className = 'passly-notification-link';
    notificationLink.title = 'Open friend notifications';
    notificationLink.setAttribute('aria-label', 'Open friend notifications');
    notificationLink.innerHTML = '<span aria-hidden="true">🔔</span><span class="passly-notification-count" data-passly-notification-count hidden>0</span>';
    box.appendChild(notificationLink);
    box.appendChild(balance);
    if (avatar) box.appendChild(avatar);
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


  const CURRENT_ROOM_STORAGE_KEY = 'passly_current_room';
  const CURRENT_ROOMS_STORAGE_KEY = 'passly_current_rooms';
  const roomCategories = ['passly', 'game'];
  const safeJsonParse = (value) => {
    try { return value ? JSON.parse(value) : null; } catch (e) { return null; }
  };
  const escapeHtml = (value) => String(value || '').replace(/[&<>"']/g, (m) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[m]));
  const normalizeStoredRoom = (room) => room?.id ? {
    id: room.id,
    name: room.name || (room.category === 'game' ? 'this game room' : 'this room'),
    category: room.category === 'game' ? 'game' : 'passly',
    minimized: room.minimized !== false,
    lastMessage: room.lastMessage || 'No new messages yet.',
    updatedAt: room.updatedAt || Date.now()
  } : null;
  const getStoredRooms = () => {
    const rooms = safeJsonParse(localStorage.getItem(CURRENT_ROOMS_STORAGE_KEY)) || {};
    const legacy = normalizeStoredRoom(safeJsonParse(localStorage.getItem(CURRENT_ROOM_STORAGE_KEY)));
    if (legacy && !rooms[legacy.category]) rooms[legacy.category] = legacy;
    return roomCategories.reduce((acc, category) => {
      const room = normalizeStoredRoom(rooms[category]);
      if (room) acc[category] = room;
      return acc;
    }, {});
  };
  const saveStoredRooms = (rooms) => {
    localStorage.setItem(CURRENT_ROOMS_STORAGE_KEY, JSON.stringify(rooms));
    const newest = Object.values(rooms).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    if (newest) localStorage.setItem(CURRENT_ROOM_STORAGE_KEY, JSON.stringify(newest));
    else localStorage.removeItem(CURRENT_ROOM_STORAGE_KEY);
    window.dispatchEvent(new CustomEvent('passly:room-state-changed', { detail: rooms }));
  };
  const getStoredRoom = (category) => {
    const rooms = getStoredRooms();
    return category ? rooms[category === 'game' ? 'game' : 'passly'] || null : Object.values(rooms).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;
  };
  const setStoredRoom = (room) => {
    const normalized = normalizeStoredRoom({ ...room, updatedAt: Date.now() });
    if (!normalized) return;
    const rooms = getStoredRooms();
    const previous = rooms[normalized.category];
    rooms[normalized.category] = { ...normalized, lastMessage: normalized.lastMessage || previous?.lastMessage || 'No new messages yet.' };
    saveStoredRooms(rooms);
  };
  const clearStoredRoom = (category) => {
    if (!category) { saveStoredRooms({}); return; }
    const rooms = getStoredRooms();
    delete rooms[category === 'game' ? 'game' : 'passly'];
    saveStoredRooms(rooms);
  };
  window.PasslyRoomState = { get: getStoredRoom, all: getStoredRooms, set: setStoredRoom, clear: clearStoredRoom, key: CURRENT_ROOM_STORAGE_KEY, multiKey: CURRENT_ROOMS_STORAGE_KEY };

  const ensureGlobalRoomDock = async () => {
    if (document.getElementById('roomMiniDock')) return;
    let rooms = getStoredRooms();
    if (!Object.keys(rooms).length) return;
    const style = document.createElement('style');
    style.textContent = `
      .room-mini-dock.global-room-mini-dock{position:fixed;right:18px;bottom:18px;left:auto;z-index:180;display:flex;flex-direction:column;gap:8px;max-width:min(430px,calc(100vw - 32px));padding:10px;border:1px solid rgba(139,92,246,.35);border-radius:20px;background:rgba(15,15,30,.94);box-shadow:0 16px 40px rgba(0,0,0,.38);backdrop-filter:blur(14px);color:#fff}
      .global-room-mini-dock .room-mini-row{display:flex;align-items:center;gap:12px;width:100%;padding:4px}.global-room-mini-dock .room-mini-main{min-width:0;flex:1}.global-room-mini-dock .room-mini-title{font-weight:900;color:#fff}.global-room-mini-dock .room-mini-label{color:#c4b5fd;font-size:.75rem;text-transform:uppercase;letter-spacing:.08em;margin-right:6px}.global-room-mini-dock .room-mini-message{font-size:.9rem;color:#d7d2ef;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.global-room-mini-dock .room-mini-open{width:42px;height:42px;flex:0 0 auto;border-radius:999px;border:none;background:linear-gradient(135deg,#8b5cf6,#7c3aed);color:white;font-size:1.2rem;font-weight:900;cursor:pointer}.global-room-mini-dock .room-mini-open:hover{transform:translateY(-1px);box-shadow:0 8px 22px rgba(139,92,246,.32)}
      @media(max-width:640px){.room-mini-dock.global-room-mini-dock{right:12px;bottom:12px;left:12px;max-width:none}}
    `;
    document.head.appendChild(style);
    const dock = document.createElement('div');
    dock.id = 'roomMiniDock';
    dock.className = 'room-mini-dock global-room-mini-dock';
    const render = () => {
      rooms = getStoredRooms();
      dock.innerHTML = roomCategories.filter(category => rooms[category]).map(category => {
        const room = rooms[category];
        return `<div class="room-mini-row" data-room-category="${category}"><div class="room-mini-main"><div class="room-mini-title"><span class="room-mini-label">${category === 'game' ? 'Game' : 'Passly'}</span>${escapeHtml(room.name)}</div><div class="room-mini-message">${escapeHtml(room.lastMessage || 'No new messages yet.')}</div></div><button class="room-mini-open" type="button" aria-label="Return to ${escapeHtml(room.name)}">↩</button></div>`;
      }).join('');
      dock.style.display = dock.innerHTML ? 'flex' : 'none';
      dock.querySelectorAll('.room-mini-row').forEach(row => {
        row.querySelector('button').addEventListener('click', () => {
          window.location.href = row.dataset.roomCategory === 'game' ? '/game-rooms' : '/rooms';
        });
      });
    };
    render();
    window.addEventListener('passly:room-state-changed', render);
    window.addEventListener('storage', (event) => { if ([CURRENT_ROOM_STORAGE_KEY, CURRENT_ROOMS_STORAGE_KEY].includes(event.key)) render(); });
    document.body.appendChild(dock);
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
      { label: '🎮 Game Rooms', href: '/game-rooms' },
      { label: '⛏️ Minecraft (coming soon)', href: '#', disabled: true },
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
    const renderChild = (child) => `<a href="${child.href}"${child.external ? ' target="_blank" rel="noopener noreferrer"' : ''}${child.disabled ? ' class="passly-nav-disabled" data-passly-disabled="true" aria-disabled="true" tabindex="-1"' : ''}><span>${child.label}</span>${child.description ? `<small>${child.description}</small>` : ''}</a>`;
    const desktopHtml = groups.map((group) => group.children ? `
      <div class="passly-nav-group">
        <a href="${group.href}" class="passly-nav-parent">${group.label}</a>
        <button type="button" class="passly-submenu-toggle" aria-expanded="false" aria-label="Show ${group.label} options">›</button>
        <div class="passly-submenu">${group.children.map(renderChild).join('')}</div>
      </div>` : `<a href="${group.href}"${group.disabled ? ' class="passly-nav-disabled" data-passly-disabled="true" aria-disabled="true" tabindex="-1"' : ''}>${group.label}</a>`).join('');
    const mobileHtml = `<button class="close-menu" id="closeMenuBtn">&times;</button>` + groups.map((group) => group.children ? `
      <div class="passly-mobile-group">
        <div class="passly-mobile-row"><a href="${group.href}">${group.label}</a><button type="button" class="passly-submenu-toggle" aria-expanded="false" aria-label="Show ${group.label} options">›</button></div>
        <div class="passly-submenu">${group.children.map(renderChild).join('')}</div>
      </div>` : `<a href="${group.href}"${group.disabled ? ' class="passly-nav-disabled" data-passly-disabled="true" aria-disabled="true" tabindex="-1"' : ''}>${group.label}</a>`).join('');
    if (desktopNav) desktopNav.innerHTML = desktopHtml;
    if (mobileNav) mobileNav.innerHTML = mobileHtml;
    document.querySelectorAll('[data-passly-disabled="true"]').forEach((link) => {
      link.addEventListener('click', (event) => event.preventDefault());
    });
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
    menu.querySelectorAll('a').forEach((link) => link.addEventListener('click', (event) => {
      if (link.dataset.passlyDisabled === 'true') { event.preventDefault(); return; }
      markClosed();
    }));
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && menu.dataset.open === 'true') { closeBtn?.click(); markClosed(); } });
  };

  buildPasslyMenu().then(() => {
    ensureNavbarCoins();
    ensureGlobalRoomDock();
    document.querySelectorAll('.nav-links a, .mobile-menu a').forEach((link) => {
      if (link.dataset.passlyDisabled === 'true') return;
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
