// AccountCreatorManager.js — Discord Account Creator UI
import { showNotification } from '../utils/ui.js';
import { icon } from '../utils/icons.js';

const AC_VERSION = '1.1';
const OWNER_NAME = 'Ahmed (4_3a)';
const DISCORD_INVITE = 'https://discord.gg/ens';
const DISCORD_LABEL = 'discord.gg/ens';

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escapeAttr(s) { return escapeHtml(s); }
function $(sel, root) { return (root || document).querySelector(sel); }
function $all(sel, root) { return [...(root || document).querySelectorAll(sel)]; }

export class AccountCreatorManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.snapshot = null;
    this.settings = null;
    this.library = [];           // persistent library from server
    this.sse = null;
    this._log = [];
    this._logFilter = 'all';
    this._logAutoScroll = true;
    this._inited = false;
    this._libSearch   = '';
    this._libPage     = 0;
    this._libPageSize = 20;
    this._libModal    = null;
    this._joinResults = {};   // accId → { status, guild, detail }
    this._joinCode    = '';
    this._joinLoading = false;
  }

  // ── Init ────────────────────────────────────────────────────────────────
  async init() {
    if (!this._inited) {
      await this._loadAll();
      this._openSSE();
      this._inited = true;
    } else {
      await this._loadAll();
    }
    this.render();
    this._bind();
  }

  async _loadAll() {
    try {
      const [stateR, settingsR, libR] = await Promise.all([
        window.electronAPI.acState(),
        window.electronAPI.acSettings(),
        window.electronAPI.acLibrary(),
      ]);
      if (stateR?.success !== false) this.snapshot = stateR.snapshot;
      if (settingsR?.success !== false) this.settings = settingsR.settings;
      if (libR?.accounts) this.library = libR.accounts;
    } catch (_) {}
  }

  // ── SSE ─────────────────────────────────────────────────────────────────
  _openSSE() {
    if (this.sse) { try { this.sse.close(); } catch (_) {} }
    this.sse = new EventSource('/api/ac/stream');
    this.sse.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data);
        if (evt.snapshot) this.snapshot = evt.snapshot;

        if (evt.entry) {
          this._log.push(evt.entry);
          if (this._log.length > 300) this._log.splice(0, this._log.length - 300);
          this._appendLogEntry(evt.entry);
        }

        if (evt.type === 'ac_init') {
          if (evt.log) this._log = evt.log;
          this.render();
          this._bind();
          return;
        }

        // New account arrived live — add to library and refresh panel
        if (evt.type === 'ac_account' && evt.account) {
          this.library.push(evt.account);
          this._refreshLibraryPanel();
        }

        if (evt.type === 'ac_done' || evt.type === 'ac_progress') {
          this._renderLive();
        }
      } catch (_) {}
    };
    this.sse.onerror = () => {
      setTimeout(() => { if (this._inited) this._openSSE(); }, 4000);
    };
  }

  // ── State helpers ────────────────────────────────────────────────────────
  _stateMeta(state) {
    const m = {
      idle:      { cls: '',         label: 'خامل' },
      running:   { cls: 'running',  label: `${icon('bolt','ic-xs')} يعمل` },
      done:      { cls: 'done',     label: `${icon('check','ic-xs')} اكتمل` },
      cancelled: { cls: 'warn',     label: `${icon('stop','ic-xs')} ملغي` },
      error:     { cls: 'danger',   label: `${icon('x','ic-xs')} خطأ` },
    };
    return m[state] || m.idle;
  }

  // ── Render ───────────────────────────────────────────────────────────────
  render() {
    const s = this.snapshot || { state: 'idle', total: 0, done: 0, failed: 0 };
    const cfg = this.settings || {};
    const meta = this._stateMeta(s.state);
    const isRunning = s.state === 'running';

    this.contentArea.innerHTML = `
      <div class="ts-wrap ac-wrap" dir="rtl">

        <!-- Brand bar -->
        <div class="ts-brand">
          <div class="ts-brand-main">
            <div class="ts-brand-pulse" title="online"></div>
            <div class="ts-brand-title">
              <div class="ts-brand-name">Account Creator</div>
              <div class="ts-brand-sub">Discord Registration Engine · v${AC_VERSION}</div>
            </div>
          </div>
          <div class="ts-credit-panel">
            <span class="ts-credit-kicker">OWNER</span>
            <span class="ts-credit-name">${escapeHtml(OWNER_NAME)}</span>
            <a class="ts-credit-link" href="${escapeAttr(DISCORD_INVITE)}" target="_blank" rel="noopener">${escapeHtml(DISCORD_LABEL)}</a>
          </div>
        </div>

        <!-- Stats row -->
        <div class="ts-stats">
          <div class="ts-stat">
            <div class="ts-stat-label">تقدم الإنشاء</div>
            <div class="ts-stat-value" id="ac-progress-value">${this._renderProgress(s)}</div>
          </div>
          <div class="ts-stat">
            <div class="ts-stat-label">حالة الجلسة</div>
            <div class="ts-stat-value ${meta.cls}" id="ac-status-value">${meta.label}${s.lastError ? `<div class="ac-error-hint">${escapeHtml(s.lastError.slice(0,80))}</div>` : ''}</div>
          </div>
          <div class="ts-stat">
            <div class="ts-stat-label">إجمالي المكتبة</div>
            <div class="ts-stat-value">${this.library.length} حساب</div>
          </div>
        </div>

        <!-- Settings card -->
        <div class="ts-card">
          <div class="ts-card-head">
            <div class="ts-card-title ar">${icon('gear','ic-sm')} إعدادات الإنشاء</div>
          </div>

          <!-- SMS Provider (optional) -->
          <div class="ts-field">
            <div class="ts-field-label">
              مزود أرقام الهواتف (SMS)
              <span class="ac-optional-badge">اختياري</span>
            </div>
            <div class="ts-account-row" style="grid-template-columns:1fr 1fr;">
              <select class="ts-select" id="ac-sms-provider">
                <option value="smspva"       ${(cfg.smsProvider||'smspva')==='smspva'       ? 'selected':''}>SMSPVA</option>
                <option value="5sim"         ${cfg.smsProvider==='5sim'         ? 'selected':''}>5sim</option>
                <option value="textverified" ${cfg.smsProvider==='textverified' ? 'selected':''}>TextVerified</option>
              </select>
              <select class="ts-select" id="ac-sms-country">
                <option value="US" ${(cfg.smsCountry||'US')==='US' ? 'selected':''}>🇺🇸 USA</option>
                <option value="GB" ${cfg.smsCountry==='GB' ? 'selected':''}>🇬🇧 UK</option>
                <option value="RU" ${cfg.smsCountry==='RU' ? 'selected':''}>🇷🇺 Russia</option>
                <option value="DE" ${cfg.smsCountry==='DE' ? 'selected':''}>🇩🇪 Germany</option>
                <option value="FR" ${cfg.smsCountry==='FR' ? 'selected':''}>🇫🇷 France</option>
                <option value="CA" ${cfg.smsCountry==='CA' ? 'selected':''}>🇨🇦 Canada</option>
                <option value="AU" ${cfg.smsCountry==='AU' ? 'selected':''}>🇦🇺 Australia</option>
              </select>
            </div>
            <div class="ts-field" style="margin-top:8px;">
              <div class="ts-field-label">
                مفتاح API للـ SMS
                ${cfg.hasSmsApiKey
                  ? `<span class="ac-badge-ok">${icon('check','ic-xs')} محفوظ — الرقم سيُستخدم</span>`
                  : `<span class="ac-badge-warn">${icon('warning','ic-xs')} غير محفوظ — الإنشاء بدون رقم هاتف</span>`}
              </div>
              <div class="ts-account-row" style="grid-template-columns:auto 1fr;">
                <button class="ts-btn mint" id="ac-sms-save">حفظ</button>
                <input class="ts-input" id="ac-sms-key" type="password" placeholder="أدخل مفتاح API...">
              </div>
            </div>
          </div>

          <!-- Email Provider -->
          <div class="ts-field">
            <div class="ts-field-label">مزود الإيميل المؤقت</div>
            <select class="ts-select" id="ac-email-provider">
              <option value="mailtm"    ${(cfg.emailProvider||'mailtm')==='mailtm'    ? 'selected':''}>Mail.tm (مجاني، API رسمي)</option>
              <option value="guerrilla" ${cfg.emailProvider==='guerrilla' ? 'selected':''}>Guerrilla Mail (مجاني)</option>
              <option value="custom"    ${cfg.emailProvider==='custom'    ? 'selected':''}>إيميل خاص (من عندك)</option>
            </select>
            <div id="ac-custom-email-row" style="${cfg.emailProvider==='custom' ? '' : 'display:none;'}margin-top:8px;">
              <div class="ts-field-label">الإيميل الخاص</div>
              <div class="ts-account-row" style="grid-template-columns:auto 1fr;">
                <button class="ts-btn" id="ac-email-save">حفظ</button>
                <input class="ts-input" id="ac-custom-email" type="email" placeholder="example@yourdomain.com" value="${escapeAttr(cfg.customEmail||'')}">
              </div>
            </div>
          </div>

          <!-- Proxy -->
          <div class="ts-field">
            <div class="ts-field-label">البروكسي (اختياري — يُنصح بـ Rotating)</div>
            <div class="ts-account-row" style="grid-template-columns:auto 1fr;">
              <button class="ts-btn" id="ac-proxy-save">حفظ</button>
              <input class="ts-input" id="ac-proxy-url" type="text" placeholder="http://user:pass@host:port" value="${escapeAttr(cfg.proxyUrl||'')}">
            </div>
            <div class="ts-rule-hint" style="margin-top:6px;">
              كل حساب يحصل على IP منفصل من الـ Rotating Proxy · الكابتشا وسرعة التصفح مشتركة مع إعدادات البوتات
            </div>
          </div>
        </div>

        <!-- Session config card -->
        <div class="ts-card">
          <div class="ts-card-head">
            <div class="ts-card-title ar">${icon('rocket','ic-sm')} إعدادات الجلسة</div>
          </div>
          <div class="ts-field">
            <div class="ts-field-label">عدد الحسابات المطلوب إنشاؤها</div>
            <div class="ts-account-row" style="grid-template-columns:1fr 1fr;">
              <input class="ts-input" id="ac-count" type="number" min="1" max="50" value="1" style="text-align:center;">
              <input class="ts-input" id="ac-prefix" type="text" placeholder="بادئة الاسم (اختياري)" value="">
            </div>
            <div class="ts-rule-hint" style="margin-top:6px;">
              كل حساب = جلسة + كوكيز + fingerprint مستقل · محاكاة تصفح قبل التسجيل
            </div>
          </div>

          <!-- Action buttons -->
          <div class="ts-actions">
            <button class="ts-btn danger big" id="ac-stop" ${!isRunning ? 'disabled' : ''}>إيقاف</button>
            <button class="ts-btn mint big" id="ac-start" ${isRunning ? 'disabled' : ''}>${icon('play','ic-sm')} إنشاء حسابات</button>
          </div>
          ${['done','error','cancelled'].includes(s.state) ? `
          <div class="ts-force-reset-row">
            <button class="ts-btn warn" id="ac-force-reset">${icon('bolt','ic-xs')} إعادة تعيين قسري</button>
          </div>` : ''}
        </div>

        <!-- Accounts Library trigger -->
        ${this._renderLibraryTrigger()}

        <!-- Log -->
        <div class="ts-log-wrap">
          <div class="ts-log-toolbar ac-log-toolbar">
            <div class="ts-log-filters">
              ${['all','success','info','warn','error'].map(f => `
                <button class="ts-log-filter-btn${this._logFilter===f?' active':''}" data-ac-filter="${f}">${f}</button>
              `).join('')}
            </div>
            <div class="ts-log-actions">
              <button class="ts-btn-xs" id="ac-log-autoscroll" title="التمرير التلقائي">↓</button>
              <button class="ts-btn-xs" id="ac-log-copy" title="نسخ السجل">${icon('clipboard','ic-xs')}</button>
              <button class="ts-btn-xs" id="ac-log-clear" title="مسح السجل">${icon('trash','ic-xs')}</button>
            </div>
          </div>
          <div class="ts-log" id="ac-log">${this._renderLog()}</div>
        </div>

      </div>
    `;
  }

  // ── Library trigger button ────────────────────────────────────────────────
  _renderLibraryTrigger() {
    const count = this.library.length;
    return `
      <div class="ts-libbtn-wrap" style="margin-top:0;" id="ac-libbtn-wrap">
        <button class="ts-libbtn ac-libbtn" id="ac-lib-open" type="button">
          <span class="ts-libbtn-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
              <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
          </span>
          <span class="ts-libbtn-text">
            <span class="ts-libbtn-title">مكتبة الحسابات</span>
            <span class="ts-libbtn-sub">الحسابات المنشأة · الإيميلات · التوكنات · كلمات المرور</span>
          </span>
          <span class="ts-libbtn-badges" id="ac-libbtn-badges">
            ${count ? `<span class="ts-libbtn-badge mint">${count} حساب</span>` : ''}
          </span>
        </button>
      </div>
    `;
  }

  // ── Library overlay modal ─────────────────────────────────────────────────
  _openLibraryModal() {
    if (this._libModal) { this._refreshModalBody(); return; }

    const overlay = document.createElement('div');
    overlay.className = 'ts-lib-overlay';
    overlay.innerHTML = `
      <div class="ts-lib-page">
        <header class="ts-lib-page-head">
          <button class="ts-lib-back" id="ac-lib-close" aria-label="رجوع">←</button>
          <div class="ts-lib-page-title">مكتبة الحسابات</div>
          <div class="ts-lib-head-actions">
            <button class="ts-btn mint" id="ac-lib-modal-export">
              ${icon('download','ic-xs')} تصدير JSON
            </button>
            <button class="ts-btn danger" id="ac-lib-modal-clear" ${!this.library.length ? 'disabled' : ''}>
              ${icon('trash','ic-xs')} حذف الكل
            </button>
          </div>
        </header>
        <div class="ac-lib-modal-search-wrap">
          ${icon('search')}
          <input class="ts-input" id="ac-lib-modal-search" type="text"
            placeholder="بحث بالإيميل أو الاسم أو userId…"
            value="${escapeAttr(this._libSearch)}"
            style="padding-right:36px;width:100%;">
        </div>
        <div class="ac-join-bar" id="ac-join-bar">
          <input class="ts-input" id="ac-join-code" type="text"
            placeholder="discord.gg/... أو رمز الدعوة"
            value="${escapeAttr(this._joinCode)}"
            autocomplete="off" spellcheck="false">
          <button class="ts-btn mint" id="ac-join-all-btn">
            ${icon('rocket','ic-xs')} دخّل الكل
          </button>
        </div>
        <div class="ts-lib-page-body" id="ac-lib-modal-body"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    this._libModal = overlay;

    overlay.querySelector('#ac-lib-close').addEventListener('click', () => this._closeLibraryModal());
    overlay.querySelector('#ac-lib-modal-export')?.addEventListener('click', () => this._exportLibrary());

    overlay.querySelector('#ac-lib-modal-clear')?.addEventListener('click', async () => {
      if (!confirm('حذف جميع الحسابات من المكتبة؟ هذا الإجراء لا يمكن التراجع عنه.')) return;
      try {
        await window.electronAPI.acLibraryClear();
        this.library = [];
        this._libPage = 0;
        this._refreshModalBody();
        this._updateLibTriggerBadge();
        showNotification('تم حذف جميع الحسابات', 'info');
      } catch (e) { showNotification('فشل الحذف: ' + e.message, 'error'); }
    });

    const searchInput = overlay.querySelector('#ac-lib-modal-search');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this._libSearch = e.target.value;
        this._libPage = 0;
        this._refreshModalBody();
      });
    }

    const joinCodeInput = overlay.querySelector('#ac-join-code');
    if (joinCodeInput) {
      joinCodeInput.addEventListener('input', (e) => { this._joinCode = e.target.value; });
    }

    overlay.querySelector('#ac-join-all-btn')?.addEventListener('click', () => {
      this._joinGuild(this._joinCode, 'all');
    });

    this._refreshModalBody();
  }

  _closeLibraryModal() {
    if (this._libModal?.parentNode) {
      this._libModal.parentNode.removeChild(this._libModal);
    }
    this._libModal = null;
  }

  _refreshModalBody() {
    if (!this._libModal) return;
    const body = this._libModal.querySelector('#ac-lib-modal-body');
    if (!body) return;
    body.innerHTML = this._renderAccountCards();
    this._bindModalCards(body);
  }

  _renderAccountCards() {
    const filtered = this._filteredLib();
    if (!filtered.length) {
      return `<div class="ts-lib-empty">${this._libSearch ? 'لا نتائج — جرّب بحثاً مختلفاً' : 'لا توجد حسابات بعد — ابدأ الإنشاء'}</div>`;
    }
    const totalPages = Math.ceil(filtered.length / this._libPageSize);
    const page = Math.max(0, Math.min(this._libPage, totalPages - 1));
    const slice = filtered.slice(page * this._libPageSize, (page + 1) * this._libPageSize);

    const cards = slice.map((acc, i) => {
      const idx = page * this._libPageSize + i + 1;
      const date = acc.createdAt
        ? new Date(acc.createdAt).toLocaleString('ar-SA', { dateStyle: 'short', timeStyle: 'short' })
        : '—';
      const initials = (acc.username || '?').slice(0, 2).toUpperCase();
      const tokenShort = acc.token ? acc.token.slice(0, 24) + '…' : '—';
      return `
        <div class="ac-acc-card" data-acc-id="${escapeAttr(acc._id || '')}">
          <div class="ac-acc-avatar">${escapeHtml(initials)}</div>
          <div class="ac-acc-info">
            <div class="ac-acc-username">${escapeHtml(acc.username || '—')}</div>
            <div class="ac-acc-row">
              <span class="ac-acc-label">email</span>
              <span class="ac-acc-val">${escapeHtml(acc.email || '—')}</span>
              <button class="ac-icon-btn ac-copy-btn" data-copy="${escapeAttr(acc.email || '')}" title="نسخ الإيميل">${icon('copy','ic-xs')}</button>
            </div>
            <div class="ac-acc-row">
              <span class="ac-acc-label">pwd</span>
              <span class="ac-pwd-hidden" style="color:var(--ts-muted)">••••••••</span>
              <span class="ac-pwd-shown" style="display:none;color:var(--ts-text);font-family:monospace;font-size:12px;">${escapeHtml(acc.password || '—')}</span>
              <button class="ac-icon-btn ac-show-pwd-btn" title="إظهار/إخفاء">${icon('eye','ic-xs')}</button>
              <button class="ac-icon-btn ac-copy-btn" data-copy="${escapeAttr(acc.password || '')}" title="نسخ كلمة المرور">${icon('copy','ic-xs')}</button>
            </div>
            <div class="ac-acc-row">
              <span class="ac-acc-label">token</span>
              <span class="ac-acc-token" title="${escapeAttr(acc.token || '')}">${escapeHtml(tokenShort)}</span>
              <button class="ac-icon-btn ac-copy-btn" data-copy="${escapeAttr(acc.token || '')}" title="نسخ التوكن">${icon('copy','ic-xs')}</button>
            </div>
            <div class="ac-acc-meta">
              <span>${icon('mail','ic-xs')} ${escapeHtml(date)}</span>
              ${acc.phone ? `<span>${icon('phone','ic-xs')} ${escapeHtml(acc.phone)}</span>` : ''}
              <span style="margin-inline-start:auto;opacity:0.5">#${idx}</span>
              <button class="ac-join-card-btn ac-icon-btn" data-acc-id="${escapeAttr(acc._id || '')}" title="دخول سيرفر">${icon('rocket','ic-xs')}</button>
              ${this._joinResults[acc._id] ? this._renderJoinBadge(this._joinResults[acc._id]) : ''}
            </div>
          </div>
          <button class="ac-acc-delete ts-btn danger xs" data-acc-id="${escapeAttr(acc._id || '')}" title="حذف">${icon('trash','ic-xs')}</button>
        </div>
      `;
    }).join('');

    const pagination = totalPages > 1 ? `
      <div class="ac-lib-pagination" style="padding:16px;">
        <button class="ts-btn-xs" id="ac-lib-modal-prev" ${page === 0 ? 'disabled' : ''}>→</button>
        <span>${page + 1} / ${totalPages}</span>
        <button class="ts-btn-xs" id="ac-lib-modal-next" ${page >= totalPages - 1 ? 'disabled' : ''}>←</button>
      </div>` : '';

    return `<div class="ac-acc-list">${cards}</div>${pagination}`;
  }

  // ── Join Server helpers ───────────────────────────────────────────────────
  _renderJoinBadge(result) {
    const map = {
      joined:         { cls: 'mint',   label: '✓ انضم' },
      already_member: { cls: 'info',   label: 'عضو مسبقاً' },
      invalid_token:  { cls: 'warn',   label: 'توكن منتهي' },
      banned:         { cls: 'danger', label: 'محظور' },
      invalid_invite: { cls: 'danger', label: 'دعوة خاطئة' },
      max_guilds:     { cls: 'warn',   label: '+100 سيرفر' },
      phone_required: { cls: 'warn',   label: 'يحتاج هاتف' },
      rate_limited:   { cls: 'warn',   label: 'rate limit' },
      no_token:       { cls: 'muted',  label: 'لا توكن' },
      error:          { cls: 'danger', label: escapeHtml((result.detail || 'خطأ').slice(0, 28)) },
    };
    const m = map[result.status] || { cls: 'muted', label: escapeHtml(result.status || '?') };
    return `<span class="ac-join-badge ${m.cls}">${m.label}</span>`;
  }

  async _joinGuild(code, accountIds) {
    if (!code || !code.trim()) {
      showNotification('أدخل رابط الدعوة أولاً', 'warn');
      return;
    }
    if (this._joinLoading) return;
    this._joinLoading = true;

    const joinBtn = this._libModal?.querySelector('#ac-join-all-btn');
    if (joinBtn) { joinBtn.disabled = true; joinBtn.textContent = 'جاري الانضمام…'; }

    const count = accountIds === 'all' ? this.library.length : (Array.isArray(accountIds) ? accountIds.length : 1);
    showNotification(`جاري انضمام ${count} حساب…`, 'info');

    try {
      const r = await window.electronAPI.acJoinGuild({ inviteCode: code, accountIds });
      if (r?.success === false) throw new Error(r.error || 'فشل الانضمام');

      for (const result of (r.results || [])) {
        this._joinResults[result.id] = result;
      }

      const joined  = (r.results || []).filter(x => x.status === 'joined').length;
      const already = (r.results || []).filter(x => x.status === 'already_member').length;
      const failed  = (r.results || []).length - joined - already;
      showNotification(
        `انتهى — ${joined} انضم، ${already} عضو مسبقاً، ${failed} فشل`,
        joined > 0 ? 'success' : 'warn'
      );
      this._refreshModalBody();
    } catch (e) {
      showNotification('فشل: ' + (e.message || 'خطأ غير معروف'), 'error');
    } finally {
      this._joinLoading = false;
      if (joinBtn) {
        joinBtn.disabled = false;
        joinBtn.innerHTML = `${icon('rocket','ic-xs')} دخّل الكل`;
      }
    }
  }

  _bindModalCards(root) {
    // Pagination
    root.querySelector('#ac-lib-modal-prev')?.addEventListener('click', () => {
      this._libPage = Math.max(0, this._libPage - 1);
      this._refreshModalBody();
    });
    root.querySelector('#ac-lib-modal-next')?.addEventListener('click', () => {
      this._libPage++;
      this._refreshModalBody();
    });

    // Copy buttons
    $all('.ac-copy-btn', root).forEach(btn => {
      if (btn._bound) return;
      btn._bound = true;
      btn.addEventListener('click', async () => {
        const text = btn.dataset.copy || '';
        if (!text) return;
        try {
          await navigator.clipboard.writeText(text);
          const orig = btn.innerHTML;
          btn.innerHTML = icon('check','ic-xs');
          btn.classList.add('copied');
          setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('copied'); }, 1200);
        } catch (_) { showNotification('فشل النسخ', 'warn'); }
      });
    });

    // Show/hide password
    $all('.ac-show-pwd-btn', root).forEach(btn => {
      if (btn._bound) return;
      btn._bound = true;
      btn.addEventListener('click', () => {
        const row = btn.closest('.ac-acc-row');
        const hidden = row?.querySelector('.ac-pwd-hidden');
        const shown  = row?.querySelector('.ac-pwd-shown');
        if (!hidden || !shown) return;
        const visible = shown.style.display !== 'none';
        hidden.style.display = visible ? '' : 'none';
        shown.style.display  = visible ? 'none' : '';
        btn.innerHTML = visible ? icon('eye','ic-xs') : icon('eye-off','ic-xs');
      });
    });

    // Per-card join button
    $all('.ac-join-card-btn', root).forEach(btn => {
      if (btn._bound) return;
      btn._bound = true;
      btn.addEventListener('click', () => {
        const id = btn.dataset.accId;
        if (!id) return;
        const code = this._libModal?.querySelector('#ac-join-code')?.value?.trim() || this._joinCode;
        if (!code) { showNotification('أدخل رابط الدعوة أولاً', 'warn'); return; }
        this._joinGuild(code, [id]);
      });
    });

    // Delete single account
    $all('.ac-acc-delete', root).forEach(btn => {
      if (btn._bound) return;
      btn._bound = true;
      btn.addEventListener('click', async () => {
        const id = btn.dataset.accId;
        if (!id) return;
        try {
          await window.electronAPI.acLibraryDelete(id);
          this.library = this.library.filter(a => a._id !== id);
          this._refreshModalBody();
          this._updateLibTriggerBadge();
        } catch (e) { showNotification('فشل الحذف: ' + e.message, 'error'); }
      });
    });
  }

  _updateLibTriggerBadge() {
    const badges = $('#ac-libbtn-badges', this.contentArea);
    if (!badges) return;
    const count = this.library.length;
    badges.innerHTML = count ? `<span class="ts-libbtn-badge mint">${count} حساب</span>` : '';
  }

  _filteredLib() {
    const q = this._libSearch.trim().toLowerCase();
    if (!q) return this.library;
    return this.library.filter(a =>
      (a.email || '').toLowerCase().includes(q) ||
      (a.username || '').toLowerCase().includes(q) ||
      (a.userId || '').toLowerCase().includes(q)
    );
  }

  _refreshLibraryPanel() {
    // Update trigger badge
    this._updateLibTriggerBadge();

    // If modal is open, refresh its body too
    if (this._libModal) this._refreshModalBody();

    // Also update library count in stats
    const statEls = $all('.ts-stat-value', this.contentArea);
    if (statEls[2]) statEls[2].textContent = `${this.library.length} حساب`;
  }

  _renderProgress(s) {
    if (!s || s.state === 'idle') return '<span class="ts-muted">—</span>';
    const done = s.done || 0;
    const total = s.total || 0;
    const pct = total ? Math.round((done / total) * 100) : 0;
    return `
      <div class="ts-prog-wrap">
        <span>${done} / ${total}</span>
        <div class="ts-prog-bar"><span style="width:${pct}%"></span></div>
        <span class="ts-muted">${pct}%</span>
      </div>
    `;
  }

  _renderLog() {
    const entries = this._log.filter(e => this._logFilter === 'all' || e.level === this._logFilter);
    if (!entries.length) return '<div class="ts-log-empty">لا يوجد سجل</div>';
    return entries.map(e => {
      const time = new Date(e.ts).toLocaleTimeString([], { hour12: false });
      return `<div class="ts-log-line ts-log-${e.level}"><span class="ts-log-time">${time}</span><span class="ts-log-msg">${escapeHtml(e.msg)}</span></div>`;
    }).join('');
  }

  // ── Live updates (SSE without full re-render) ────────────────────────────
  _renderLive() {
    const s = this.snapshot || {};
    const meta = this._stateMeta(s.state);

    const progress = $('#ac-progress-value', this.contentArea);
    if (progress) progress.innerHTML = this._renderProgress(s);

    const status = $('#ac-status-value', this.contentArea);
    if (status) {
      status.className = `ts-stat-value ${meta.cls}`;
      status.innerHTML = meta.label + (s.lastError ? `<div class="ac-error-hint">${escapeHtml(s.lastError.slice(0,80))}</div>` : '');
    }

    const startBtn = $('#ac-start', this.contentArea);
    const stopBtn  = $('#ac-stop',  this.contentArea);
    if (startBtn) startBtn.disabled = s.state === 'running';
    if (stopBtn)  stopBtn.disabled  = s.state !== 'running';

    // Show/hide force reset row on state change
    if (['done','error','cancelled'].includes(s.state)) {
      const sessionCard = this.contentArea.querySelectorAll('.ts-card')[1];
      if (sessionCard && !$('#ac-force-reset', sessionCard)) {
        const row = document.createElement('div');
        row.className = 'ts-force-reset-row';
        row.innerHTML = `<button class="ts-btn warn" id="ac-force-reset">${icon('bolt','ic-xs')} إعادة تعيين قسري</button>`;
        sessionCard.appendChild(row);
        row.querySelector('#ac-force-reset')?.addEventListener('click', () => this._forceReset());
      }
    }
  }

  _appendLogEntry(entry) {
    const log = $('#ac-log', this.contentArea);
    if (!log) return;
    if (this._logFilter !== 'all' && entry.level !== this._logFilter) return;
    const time = new Date(entry.ts).toLocaleTimeString([], { hour12: false });
    const div = document.createElement('div');
    div.className = `ts-log-line ts-log-${entry.level}`;
    div.innerHTML = `<span class="ts-log-time">${time}</span><span class="ts-log-msg">${escapeHtml(entry.msg)}</span>`;
    log.appendChild(div);
    if (this._logAutoScroll) log.scrollTop = log.scrollHeight;
  }

  // ── Bind ────────────────────────────────────────────────────────────────
  _bind() {
    const area = this.contentArea;

    $('#ac-start', area)?.addEventListener('click', () => this._startSession());
    $('#ac-stop',  area)?.addEventListener('click', () => this._stopSession());
    $('#ac-force-reset', area)?.addEventListener('click', () => this._forceReset());

    $('#ac-sms-save',    area)?.addEventListener('click', () => this._saveSmsKey());
    $('#ac-sms-provider', area)?.addEventListener('change', (e) => this._quickSave({ smsProvider: e.target.value }));
    $('#ac-sms-country',  area)?.addEventListener('change', (e) => this._quickSave({ smsCountry: e.target.value }));

    $('#ac-email-provider', area)?.addEventListener('change', (e) => {
      this._quickSave({ emailProvider: e.target.value });
      const row = $('#ac-custom-email-row', area);
      if (row) row.style.display = e.target.value === 'custom' ? '' : 'none';
    });
    $('#ac-email-save',   area)?.addEventListener('click', () => this._saveCustomEmail());
    $('#ac-proxy-save',   area)?.addEventListener('click', () => this._saveProxy());

    // Library trigger button
    $('#ac-lib-open', area)?.addEventListener('click', () => this._openLibraryModal());

    // Log toolbar
    $all('[data-ac-filter]', area).forEach(btn => {
      if (btn._acBound) return;
      btn._acBound = true;
      btn.addEventListener('click', () => {
        this._logFilter = btn.dataset.acFilter;
        this.render();
        this._bind();
      });
    });

    const autoScrollBtn = $('#ac-log-autoscroll', area);
    if (autoScrollBtn && !autoScrollBtn._bound) {
      autoScrollBtn._bound = true;
      autoScrollBtn.addEventListener('click', () => {
        this._logAutoScroll = !this._logAutoScroll;
        autoScrollBtn.classList.toggle('active', this._logAutoScroll);
        if (this._logAutoScroll) {
          const log = $('#ac-log', area);
          if (log) log.scrollTop = log.scrollHeight;
        }
      });
    }

    const copyBtn = $('#ac-log-copy', area);
    if (copyBtn && !copyBtn._bound) {
      copyBtn._bound = true;
      copyBtn.addEventListener('click', async () => {
        const text = this._log.map(e => `[${new Date(e.ts).toLocaleTimeString([],{hour12:false})}] [${e.level.toUpperCase()}] ${e.msg}`).join('\n');
        try { await navigator.clipboard.writeText(text); copyBtn.classList.add('flash'); setTimeout(() => copyBtn.classList.remove('flash'), 600); } catch (_) {}
      });
    }

    const clearBtn = $('#ac-log-clear', area);
    if (clearBtn && !clearBtn._bound) {
      clearBtn._bound = true;
      clearBtn.addEventListener('click', async () => {
        try { await window.electronAPI.acClearLog(); } catch (_) {}
        this._log = [];
        const log = $('#ac-log', area);
        if (log) log.innerHTML = '<div class="ts-log-empty">لا يوجد سجل</div>';
      });
    }
  }

  // ── Actions ──────────────────────────────────────────────────────────────
  async _startSession() {
    const count = parseInt($('#ac-count', this.contentArea)?.value || '1') || 1;
    const prefix = $('#ac-prefix', this.contentArea)?.value?.trim() || '';

    try {
      const r = await window.electronAPI.acStart({ count, usernamePrefix: prefix });
      if (r?.success === false) throw new Error(r.error || 'Start failed');
      showNotification('بدأت جلسة إنشاء الحسابات', 'success');
      if (r.snapshot) this.snapshot = r.snapshot;
      this._renderLive();
    } catch (e) {
      showNotification(e.message || 'Start failed', 'error');
    }
  }

  async _stopSession() {
    try {
      await window.electronAPI.acStop();
      showNotification('جاري الإيقاف...', 'warn');
      this._renderLive();
    } catch (e) {
      showNotification(e.message || 'Stop failed', 'error');
    }
  }

  async _forceReset() {
    try {
      const r = await window.electronAPI.acForceReset();
      if (r?.success === false) throw new Error(r.error || 'Reset failed');
      if (r.snapshot) this.snapshot = r.snapshot;
      showNotification('تمت إعادة التعيين', 'success');
      this.render();
      this._bind();
    } catch (e) {
      showNotification(e.message || 'Reset failed', 'error');
    }
  }

  async _exportLibrary() {
    const accounts = this._filteredLib();
    if (!accounts.length) { showNotification('لا توجد حسابات للتصدير', 'warn'); return; }
    // Export without internal _id field
    const clean = accounts.map(({ _id, ...rest }) => rest);
    const json = JSON.stringify(clean, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `discord-accounts-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showNotification(`تم تصدير ${clean.length} حساب`, 'success');
  }

  async _saveSmsKey() {
    const key = $('#ac-sms-key', this.contentArea)?.value?.trim();
    if (!key) { showNotification('أدخل مفتاح API أولاً', 'warn'); return; }
    await this._quickSave({ smsApiKey: key });
    const input = $('#ac-sms-key', this.contentArea);
    if (input) input.value = '';
    showNotification('تم حفظ مفتاح SMS', 'success');
    // Reload settings to update badge
    await this._loadAll();
    this.render();
    this._bind();
  }

  async _saveCustomEmail() {
    const email = $('#ac-custom-email', this.contentArea)?.value?.trim();
    if (!email) { showNotification('أدخل الإيميل أولاً', 'warn'); return; }
    await this._quickSave({ customEmail: email });
    showNotification('تم حفظ الإيميل', 'success');
  }

  async _saveProxy() {
    const url = $('#ac-proxy-url', this.contentArea)?.value?.trim();
    await this._quickSave({ proxyUrl: url || '' });
    showNotification(url ? 'تم حفظ البروكسي' : 'تم مسح البروكسي', url ? 'success' : 'info');
  }

  async _quickSave(payload) {
    try {
      const r = await window.electronAPI.acSaveSettings(payload);
      if (r?.settings) this.settings = r.settings;
    } catch (_) {}
  }
}
