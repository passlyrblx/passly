(() => {
  const path = window.location.pathname.replace(/\/$/, '') || '/';
  const aliases = new Map([
    ['/', ['/']],
    ['/dashboard', ['/dashboard']],
    ['/rooms', ['/rooms']],
    ['/leaderboard', ['/leaderboard']],
    ['/profile', ['/profile']],
    ['/friends', ['/friends']],
    ['/advertisement', ['/advertisement']],
    ['/livedonations', ['/livedonations']],
    ['/admin', ['/admin']],
    ['/privacy', ['/privacy']],
    ['/terms', ['/terms']]
  ]);

  document.querySelectorAll('.nav-links a, .mobile-menu a').forEach((link) => {
    const href = new URL(link.getAttribute('href'), window.location.origin).pathname.replace(/\/$/, '') || '/';
    const isCurrent = (aliases.get(path) || [path]).includes(href);
    if (isCurrent) link.setAttribute('aria-current', 'page');
  });

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

  const markOpen = () => {
    hamburger.setAttribute('aria-expanded', 'true');
    menu.dataset.open = 'true';
  };
  const markClosed = () => {
    hamburger.setAttribute('aria-expanded', 'false');
    delete menu.dataset.open;
  };

  hamburger.addEventListener('click', () => requestAnimationFrame(markOpen));
  overlay.addEventListener('click', () => requestAnimationFrame(markClosed));
  closeBtn?.addEventListener('click', () => requestAnimationFrame(markClosed));
  menu.querySelectorAll('a').forEach((link) => link.addEventListener('click', markClosed));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menu.dataset.open === 'true') {
      closeBtn?.click();
      markClosed();
    }
  });
})();
