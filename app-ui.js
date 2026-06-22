(() => {
  const PASSLY_LOGO_URL = 'https://i.ibb.co/XrDM8by8/file-00000000993871f8a74fdfa489ebf218-3.png';
  const ROBUX_LOGO_URL = 'https://i.ibb.co/fYdkfkYY/Robux-2019-Logo.png';
  const path = window.location.pathname.replace(/\/$/, '') || '/';
  const pageKey = (path.replace(/^\//, '') || 'home').replace(/[^a-z0-9-]/gi, '-');
  document.body.dataset.passlyPage = pageKey;
  const aliases = new Map([
    ['/', ['/']], ['/dashboard', ['/dashboard']], ['/rooms', ['/rooms']], ['/game-rooms', ['/game-rooms']], ['/leaderboard', ['/leaderboard']],
    ['/profile', ['/profile']], ['/friends', ['/friends']], ['/find-player', ['/find-player']], ['/booths', ['/booths']],
    ['/livedonations', ['/livedonations']], ['/redeem', ['/redeem']], ['/admin', ['/admin']], ['/privacy', ['/privacy']], ['/terms', ['/terms']]
  ]);

  const passlyInteractionSound = (() => {
    let audioContext = null;
    let lastPlayedAt = 0;
    const getAudioContext = () => {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return null;
      audioContext ||= new AudioContext();
      return audioContext;
    };
    return () => {
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
      const now = Date.now();
      if (now - lastPlayedAt < 70) return;
      lastPlayedAt = now;
      const ctx = getAudioContext();
      if (!ctx) return;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const start = ctx.currentTime;
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(660, start);
      oscillator.frequency.exponentialRampToValueAtTime(920, start + 0.045);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.055, start + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.095);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.1);
    };
  })();

  const isSoundEligibleInteraction = (target) => {
    const interactive = target?.closest?.('button, a[href], input, select, textarea, summary, [role="button"], [role="menuitem"], [tabindex]');
    if (!interactive || interactive.dataset.passlyNoSound === 'true') return false;
    if (interactive.matches('[disabled], [aria-disabled="true"], .passly-nav-disabled')) return false;
    if (interactive.matches('input, textarea') && !interactive.matches('input[type="button"], input[type="submit"], input[type="reset"], input[type="checkbox"], input[type="radio"], input[type="range"], input[type="file"]')) return false;
    return true;
  };

  document.addEventListener('click', (event) => {
    if (isSoundEligibleInteraction(event.target)) passlyInteractionSound();
  }, true);
  document.addEventListener('change', (event) => {
    if (event.target?.matches?.('select, input[type="checkbox"], input[type="radio"], input[type="range"], input[type="file"]')) passlyInteractionSound();
  }, true);


  const applyAppTheme = (_theme = 'passly', { loading = false } = {}) => {
    const normalized = 'passly';
    document.documentElement.dataset.passlyTheme = normalized;
    document.body.dataset.passlyTheme = normalized;
    document.querySelectorAll('meta[name=\"theme-color\"]').forEach((meta) => { meta.content = '#8b5cf6'; });
    localStorage.removeItem('passly_app_theme');
    if (loading) {
      document.body.dataset.passlyThemeLoading = 'true';
      setTimeout(() => { delete document.body.dataset.passlyThemeLoading; }, 520);
    }
    window.dispatchEvent(new CustomEvent('passly:theme-changed', { detail: { theme: normalized } }));
  };
  applyAppTheme();
  const syncAppThemeFromProfile = async () => {
    const token = localStorage.getItem('passly_token');
    if (!token) return;
    try {
      const res = await fetch('/api/user', { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return;
      const data = await res.json();
      applyAppTheme();
    } catch (e) {}
  };

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


  const passlyLogoImg = (className = '') => `<img class="${className}" src="${PASSLY_LOGO_URL}" alt="Passly" loading="lazy" decoding="async">`;
  const coinIcon = (size = 'small') => `<span class="passly-coin-frame passly-coin-${size}" aria-hidden="true">${passlyLogoImg('passly-coin-logo')}</span>`;
  const renderCoins = (amount = 0, size = 'small') => `<span class="passly-coin-balance" title="Coin balance">${coinIcon(size)}<span>${Number(amount || 0).toLocaleString()}</span></span>`;
  const updateCoinDisplays = (amount = 0) => {
    document.querySelectorAll('[data-passly-coins]').forEach((el) => { el.innerHTML = renderCoins(amount, el.dataset.coinSize || 'small'); });
  };
  const ensurePasslyBranding = () => {
    document.querySelectorAll('.nav-logo, .logo-text').forEach((el) => {
      if (el.dataset.passlyLogoEnhanced === 'true') return;
      el.dataset.passlyLogoEnhanced = 'true';
      el.classList.add('passly-brand-logo');
      el.innerHTML = '<span class="passly-brand-logo-text">PASSLY</span>';
    });
  };
  const ensureDocumentLogoLinks = () => {
    const ensureLink = (rel) => {
      let link = document.head.querySelector(`link[rel="${rel}"]`);
      if (!link) {
        link = document.createElement('link');
        link.rel = rel;
        document.head.appendChild(link);
      }
      link.href = PASSLY_LOGO_URL;
    };
    ensureLink('icon');
    ensureLink('apple-touch-icon');
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
    const storedRooms = safeJsonParse(localStorage.getItem(CURRENT_ROOMS_STORAGE_KEY)) || {};
    const legacy = normalizeStoredRoom(safeJsonParse(localStorage.getItem(CURRENT_ROOM_STORAGE_KEY)));
    const candidates = roomCategories.map((category) => normalizeStoredRoom(storedRooms[category])).filter(Boolean);
    if (legacy) candidates.push(legacy);
    const newest = candidates.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    return newest ? { [newest.category]: newest } : {};
  };
  const saveStoredRooms = (rooms) => {
    const newest = Object.values(rooms).filter(Boolean).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    const singleRoomState = newest ? { [newest.category]: newest } : {};
    localStorage.setItem(CURRENT_ROOMS_STORAGE_KEY, JSON.stringify(singleRoomState));
    if (newest) localStorage.setItem(CURRENT_ROOM_STORAGE_KEY, JSON.stringify(newest));
    else localStorage.removeItem(CURRENT_ROOM_STORAGE_KEY);
    window.dispatchEvent(new CustomEvent('passly:room-state-changed', { detail: singleRoomState }));
  };
  const getStoredRoom = (category) => {
    const rooms = getStoredRooms();
    return category ? rooms[category === 'game' ? 'game' : 'passly'] || null : Object.values(rooms).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;
  };
  const setStoredRoom = (room) => {
    const normalized = normalizeStoredRoom({ ...room, updatedAt: Date.now() });
    if (!normalized) return;
    const previous = getStoredRoom(normalized.category);
    saveStoredRooms({ [normalized.category]: { ...normalized, lastMessage: normalized.lastMessage || previous?.lastMessage || 'No new messages yet.' } });
  };
  const clearStoredRoom = (category) => {
    if (!category) { saveStoredRooms({}); return; }
    const rooms = getStoredRooms();
    delete rooms[category === 'game' ? 'game' : 'passly'];
    saveStoredRooms(rooms);
  };
  window.PasslyRoomState = { get: getStoredRoom, all: getStoredRooms, set: setStoredRoom, clear: clearStoredRoom, key: CURRENT_ROOM_STORAGE_KEY, multiKey: CURRENT_ROOMS_STORAGE_KEY };

  const ensureGlobalRoomDock = async () => {
    let rooms = getStoredRooms();
    if (!Object.keys(rooms).length) return;
    const existing = document.getElementById('passlyGlobalRoomMiniDock');
    const dock = existing || document.createElement('div');
    if (!existing) {
      if (!document.getElementById('passlyGlobalRoomMiniDockStyles')) {
        const style = document.createElement('style');
        style.id = 'passlyGlobalRoomMiniDockStyles';
        style.textContent = `
          .room-mini-dock.global-room-mini-dock{position:fixed;right:18px;bottom:18px;left:auto;transform:none;width:auto;z-index:180;display:flex;flex-direction:column;gap:8px;max-width:min(430px,calc(100vw - 32px));padding:10px;border:1px solid rgba(139,92,246,.35);border-radius:20px;background:rgba(15,15,30,.94);box-shadow:0 16px 40px rgba(0,0,0,.38);backdrop-filter:blur(14px);color:#fff}
          .global-room-mini-dock .room-mini-row{display:flex;align-items:center;gap:12px;width:100%;padding:4px}.global-room-mini-dock .room-mini-main{min-width:0;flex:1}.global-room-mini-dock .room-mini-title{font-weight:900;color:#fff}.global-room-mini-dock .room-mini-label{color:#c4b5fd;font-size:.75rem;text-transform:uppercase;letter-spacing:.08em;margin-right:6px}.global-room-mini-dock .room-mini-message{font-size:.9rem;color:#d7d2ef;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.global-room-mini-dock .room-mini-open{width:42px;height:42px;flex:0 0 auto;border-radius:999px;border:none;background:linear-gradient(135deg,#8b5cf6,#7c3aed);color:white;font-size:1.2rem;font-weight:900;cursor:pointer}.global-room-mini-dock .room-mini-open:hover{transform:translateY(-1px);box-shadow:0 8px 22px rgba(139,92,246,.32)}
          @media(max-width:640px){.room-mini-dock.global-room-mini-dock{right:12px;bottom:12px;left:12px;max-width:none}}
        `;
        document.head.appendChild(style);
      }
      dock.id = 'passlyGlobalRoomMiniDock';
      dock.className = 'room-mini-dock global-room-mini-dock';
    }
    const currentPath = window.location.pathname.replace(/\/$/, '') || '/';
    const localRoomCategory = currentPath === '/game-rooms' ? 'game' : currentPath === '/rooms' ? 'passly' : null;
    const render = () => {
      rooms = getStoredRooms();
      const visibleCategories = roomCategories.filter(category => rooms[category] && category !== localRoomCategory);
      dock.innerHTML = visibleCategories.map(category => {
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
    if (!existing) document.body.appendChild(dock);
  };

  window.PasslyUI = {
    logoUrl: PASSLY_LOGO_URL,
    robuxLogoUrl: ROBUX_LOGO_URL,
    applyAppTheme,
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
    const navIcons = {
      home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11.2 12 4l8 7.2V20a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1v-8.8Z"/></svg>',
      rooms: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-4.6L12 21l-3.4-3.5H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Zm2.5 4.2v2.4h2.4V9.2H6.5Zm4.3 0v2.4h6.7V9.2h-6.7Zm-4.3 4v2.3h11v-2.3h-11Z"/></svg>',
      game: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 8h10a5 5 0 0 1 4.9 4.1l.7 4A3 3 0 0 1 17.7 19l-2.2-2H8.5l-2.2 2a3 3 0 0 1-4.9-2.9l.7-4A5 5 0 0 1 7 8Zm1 3v2H6v2h2v2h2v-2h2v-2h-2v-2H8Zm8.5 1.2a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4Zm2.5 2.6a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4Z"/></svg>',
      community: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 11a4 4 0 1 0-3.7-5.5A5 5 0 0 1 14 9c0 .7-.1 1.4-.4 2H16Zm-8 0a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 2c-3.3 0-6 1.8-6 4v2h12v-2c0-2.2-2.7-4-6-4Zm8 0c-.5 0-1 .1-1.5.2 1 .9 1.5 2.2 1.5 3.8v2h6v-2c0-2.2-2.7-4-6-4Z"/></svg>',
      settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.4 13.5c.1-.5.1-1 .1-1.5s0-1-.1-1.5l2-1.5-2-3.5-2.4 1a8 8 0 0 0-2.6-1.5L14 2h-4l-.4 2.5A8 8 0 0 0 7 6L4.6 5l-2 3.5 2 1.5c-.1.5-.1 1-.1 1.5s0 1 .1 1.5l-2 1.5 2 3.5 2.4-1a8 8 0 0 0 2.6 1.5L10 22h4l.4-2.5A8 8 0 0 0 17 18l2.4 1 2-3.5-2-1.5ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z"/></svg>',
      admin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 4 5v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V5l-8-3Zm1 6v3h3v2h-3v3h-2v-3H8v-2h3V8h2Z"/></svg>',
      support: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a8 8 0 0 0-8 8v3a3 3 0 0 0 3 3h1v-7H6.1A6 6 0 0 1 18 10h-2v7h1.7A5 5 0 0 1 13 20h-2v2h2a7 7 0 0 0 7-7v-4a8 8 0 0 0-8-8Z"/></svg>',
      terms: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2h9l5 5v15H6V2Zm8 1.5V8h4.5L14 3.5ZM9 11v2h8v-2H9Zm0 4v2h8v-2H9Zm0 4h5v-2H9v2Z"/></svg>',
      privacy: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 5 5v6c0 4.5 2.9 8.7 7 10 4.1-1.3 7-5.5 7-10V5l-7-3Zm0 4a3 3 0 0 1 3 3v2h1v6H8v-6h1V9a3 3 0 0 1 3-3Zm-1 5h2V9a1 1 0 0 0-2 0v2Z"/></svg>',
      discord: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.5 5.5A16.6 16.6 0 0 0 15.4 4l-.2.4c1.5.4 2.2 1 2.2 1a13.6 13.6 0 0 0-10.8 0s.8-.6 2.3-1L8.6 4a16.6 16.6 0 0 0-4.1 1.5C1.9 9.4 1.2 13.2 1.5 17c1.7 1.3 3.4 2 5 2.5l1.1-1.8c-.6-.2-1.1-.5-1.6-.8l.4-.3c3.1 1.5 6.5 1.5 9.6 0l.4.3c-.5.3-1 .6-1.6.8l1.1 1.8c1.6-.5 3.3-1.2 5-2.5.4-4.4-.7-8.1-3.4-11.5ZM8.6 14.7c-.9 0-1.6-.8-1.6-1.8s.7-1.8 1.6-1.8 1.6.8 1.6 1.8-.7 1.8-1.6 1.8Zm6.8 0c-.9 0-1.6-.8-1.6-1.8s.7-1.8 1.6-1.8 1.6.8 1.6 1.8-.7 1.8-1.6 1.8Z"/></svg>'
    };
    const groups = [
      { label: 'Home', href: '/dashboard', icon: 'home' },
      { label: 'Donation Rooms', href: '/rooms', icon: 'rooms' },
      { label: 'Game Rooms', href: '/game-rooms', icon: 'game' },
      { label: 'Minecraft (coming soon)', href: '#', navTheme: 'minecraft', disabled: true },
      { label: 'Community', href: '/leaderboard', icon: 'community', children: [
        { label: 'Leaderboard', href: '/leaderboard', navTheme: 'trophy' },
        { label: 'Friends', href: '/friends', navTheme: 'social' },
        { label: 'Live donations', href: '/livedonations', navTheme: 'live' }
      ]},
      { label: 'Settings', href: '/profile', icon: 'settings', children: [
        { label: 'Profile settings', href: '/profile', navTheme: 'profile' },
        { label: 'Booth settings', href: '/booths', navTheme: 'booth' },
        { label: 'Find player', href: '/find-player', navTheme: 'search' },
        { label: 'Passly rewards', href: '/booths#earn-passly', navTheme: 'rewards' },
        { label: 'Redeem coupon', href: '/redeem', navTheme: 'redeem' }
      ]}
    ];
    if (isAdmin) groups.push({ label: 'Admin', href: '/admin', icon: 'admin', children: [
      { label: 'Dashboard', href: '/admin', navTheme: 'admin' },
      { label: 'Admin Chat', href: '/admin#admin-chat-card', navTheme: 'chat' },
      { label: 'Coupons', href: '/admin#coupon-card', navTheme: 'coupon' }
    ]});
    groups.push({ label: 'Support', href: '/terms', icon: 'support', children: [
      {
        label: 'Terms of Service',
        href: '/terms',
        icon: 'terms',
        description: 'Review the rules for using Passly safely and fairly.'
      },
      {
        label: 'Privacy Policy',
        href: '/privacy',
        icon: 'privacy',
        description: 'See what data Passly collects and how it is protected.'
      },
      {
        label: 'Discord Support',
        href: 'https://discord.gg/9qNpCGztun',
        icon: 'discord',
        description: 'Open a support ticket and tell us what you need help with.',
        external: true
      }
    ]});
    const iconMarkup = (name) => name && navIcons[name] ? `<span class="passly-nav-icon">${navIcons[name]}</span>` : '';
    const renderChild = (child) => `<a href="${child.href}" data-passly-nav-theme="${child.navTheme || 'default'}"${child.external ? ' target="_blank" rel="noopener noreferrer"' : ''}${child.disabled ? ' class="passly-nav-disabled" data-passly-disabled="true" aria-disabled="true" tabindex="-1"' : ''}>${iconMarkup(child.icon)}<span class="passly-nav-copy"><span>${child.label}</span>${child.description ? `<small>${child.description}</small>` : ''}</span></a>`;
    const desktopHtml = groups.map((group) => group.children ? `
      <div class="passly-nav-group">
        <a href="${group.href}" class="passly-nav-parent">${iconMarkup(group.icon)}<span>${group.label}</span></a>
        <button type="button" class="passly-submenu-toggle" aria-expanded="false" aria-label="Show ${group.label} options">›</button>
        <div class="passly-submenu">${group.children.map(renderChild).join('')}</div>
      </div>` : `<a href="${group.href}" data-passly-nav-theme="${group.navTheme || 'default'}"${group.disabled ? ' class="passly-nav-disabled" data-passly-disabled="true" aria-disabled="true" tabindex="-1"' : ''}>${iconMarkup(group.icon)}<span>${group.label}</span></a>`).join('');
    const mobileHtml = `<button class="close-menu" id="closeMenuBtn">&times;</button>` + groups.map((group) => group.children ? `
      <div class="passly-mobile-group">
        <div class="passly-mobile-row"><a href="${group.href}">${iconMarkup(group.icon)}<span>${group.label}</span></a><button type="button" class="passly-submenu-toggle" aria-expanded="false" aria-label="Show ${group.label} options">›</button></div>
        <div class="passly-submenu">${group.children.map(renderChild).join('')}</div>
      </div>` : `<a href="${group.href}" data-passly-nav-theme="${group.navTheme || 'default'}"${group.disabled ? ' class="passly-nav-disabled" data-passly-disabled="true" aria-disabled="true" tabindex="-1"' : ''}>${iconMarkup(group.icon)}<span>${group.label}</span></a>`).join('');
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

  syncAppThemeFromProfile();
  ensureDocumentLogoLinks();
  buildPasslyMenu().then(() => {
    ensurePasslyBranding();
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
