import { TrueStudioManager }    from './components/TrueStudioManager.js';
import { AccountCreatorManager } from './components/AccountCreatorManager.js';
import { applyLang, setLang, getLang, t } from './utils/i18n.js';
import { icon } from './utils/icons.js';

window.t = t;

const ICON_MOON = icon('moon');
const ICON_SUN  = icon('sun');

function initTheme() {
  const saved = localStorage.getItem('theme');
  if (saved === 'light') document.body.classList.add('light-theme');
  const btn = document.getElementById('themeToggleBtn');
  if (btn) btn.innerHTML = saved === 'light' ? ICON_SUN : ICON_MOON;
}

function toggleTheme() {
  const isLight = document.body.classList.toggle('light-theme');
  const btn = document.getElementById('themeToggleBtn');
  if (btn) btn.innerHTML = isLight ? ICON_SUN : ICON_MOON;
  localStorage.setItem('theme', isLight ? 'light' : 'dark');
}

initTheme();
applyLang();

document.getElementById('themeToggleBtn')?.addEventListener('click', toggleTheme);
document.getElementById('langToggleBtn')?.addEventListener('click', () => {
  setLang(getLang() === 'ar' ? 'en' : 'ar');
});

// ── Page navigation ──────────────────────────────────────────────────────────
const pages = {
  bots:     { page: document.getElementById('ts-page'), nav: document.getElementById('nav-bots') },
  accounts: { page: document.getElementById('ac-page'), nav: document.getElementById('nav-accounts') },
};

let activePageKey = 'bots';
let acManagerInited = false;

function switchPage(key) {
  if (activePageKey === key) return;
  activePageKey = key;
  for (const [k, p] of Object.entries(pages)) {
    if (p.page) p.page.classList.toggle('active', k === key);
    if (p.nav)  p.nav.classList.toggle('active', k === key);
  }
  // Lazy-init Account Creator on first visit
  if (key === 'accounts' && !acManagerInited) {
    acManagerInited = true;
    window.accountCreatorManager.init();
  }
}

document.getElementById('nav-bots')?.addEventListener('click', () => switchPage('bots'));
document.getElementById('nav-accounts')?.addEventListener('click', () => switchPage('accounts'));

// ── Managers ─────────────────────────────────────────────────────────────────
const studioRoot = document.getElementById('ts-page');
const acRoot     = document.getElementById('ac-page');

window.trueStudioManager    = new TrueStudioManager(studioRoot);
window.accountCreatorManager = new AccountCreatorManager(acRoot);

document.addEventListener('DOMContentLoaded', () => {
  window.trueStudioManager.init();
});
