// AccountCreatorManager.js — Discord Account Creator UI
import { showNotification } from '../utils/ui.js';

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
    this._libSearch = '';
    this._libPage = 0;
    this._libPageSize = 20;
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
      running:   { cls: 'running',  label: '⚡ يعمل' },
      done:      { cls: 'done',     label: '✅ اكتمل' },
      cancelled: { cls: 'warn',     label: '⛔ ملغي' },
      error:     { cls: 'danger',   label: '❌ خطأ' },
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
            <div class="ts-card-title ar">⚙️ إعدادات الإنشاء</div>
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
                  ? '<span class="ac-badge-ok">✓ محفوظ — الرقم سيُستخدم</span>'
                  : '<span class="ac-badge-warn">⚠ غير محفوظ — الإنشاء بدون رقم هاتف</span>'}
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
            <div class="ts-card-title ar">🚀 إعدادات الجلسة</div>
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
            <button class="ts-btn mint big" id="ac-start" ${isRunning ? 'disabled' : ''}>▶ إنشاء حسابات</button>
          </div>
          ${['done','error','cancelled'].includes(s.state) ? `
          <div class="ts-force-reset-row">
            <button class="ts-btn warn" id="ac-force-reset">⚡ إعادة تعيين قسري</button>
          </div>` : ''}
        </div>

        <!-- Accounts Library -->
        ${this._renderLibraryCard()}

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
              <button class="ts-btn-xs" id="ac-log-copy" title="نسخ السجل">📋</button>
              <button class="ts-btn-xs" id="ac-log-clear" title="مسح السجل">🗑</button>
            </div>
          </div>
          <div class="ts-log" id="ac-log">${this._renderLog()}</div>
        </div>

      </div>
    `;
  }

  // ── Library card ─────────────────────────────────────────────────────────
  _renderLibraryCard() {
    const total = this.library.length;
    const filtered = this._filteredLib();
    const totalPages = Math.ceil(filtered.length / this._libPageSize);
    const page = Math.max(0, Math.min(this._libPage, totalPages - 1));
    const slice = filtered.slice(page * this._libPageSize, (page + 1) * this._libPageSize);

    return `
      <div class="ts-card" id="ac-library-card">
        <div class="ts-card-head">
          <div class="ts-card-title ar">📋 مكتبة الحسابات (${total})</div>
          <div style="display:flex;gap:6px;align-items:center;">
            <button class="ts-btn mint" id="ac-lib-export">⬇ تصدير JSON</button>
            ${total ? `<button class="ts-btn danger" id="ac-lib-clear">🗑 حذف الكل</button>` : ''}
          </div>
        </div>

        ${total === 0 ? `<div class="ts-rule-hint" style="padding:16px 0;">لا توجد حسابات بعد — ابدأ الإنشاء أعلاه</div>` : `
          <div class="ac-lib-search-row">
            <input class="ts-input" id="ac-lib-search" type="text" placeholder="🔍 بحث (إيميل / اسم / userId)..." value="${escapeAttr(this._libSearch)}" style="width:100%;">
          </div>

          <div class="ac-lib-table-wrap">
            <table class="ac-lib-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>الإيميل</th>
                  <th>الاسم</th>
                  <th>كلمة المرور</th>
                  <th>Token</th>
                  <th>الهاتف</th>
                  <th>التاريخ</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${slice.length === 0 ? `<tr><td colspan="8" style="text-align:center;color:var(--ts-muted)">لا نتائج</td></tr>` :
                  slice.map((acc, i) => {
                    const idx = page * this._libPageSize + i + 1;
                    const date = acc.createdAt ? new Date(acc.createdAt).toLocaleString('ar-SA', { dateStyle: 'short', timeStyle: 'short' }) : '—';
                    const tokenShort = acc.token ? acc.token.slice(0, 12) + '…' : '—';
                    return `<tr data-acc-id="${escapeAttr(acc._id || '')}">
                      <td class="ac-lib-num">${idx}</td>
                      <td class="ac-lib-email">
                        <span>${escapeHtml(acc.email || '—')}</span>
                        <button class="ac-copy-btn" data-copy="${escapeAttr(acc.email || '')}" title="نسخ">⧉</button>
                      </td>
                      <td>${escapeHtml(acc.username || '—')}</td>
                      <td class="ac-lib-pwd">
                        <span class="ac-pwd-hidden">••••••••</span>
                        <span class="ac-pwd-shown" style="display:none;">${escapeHtml(acc.password || '—')}</span>
                        <button class="ac-show-pwd-btn" title="إظهار">👁</button>
                        <button class="ac-copy-btn" data-copy="${escapeAttr(acc.password || '')}" title="نسخ">⧉</button>
                      </td>
                      <td class="ac-lib-token">
                        <span title="${escapeAttr(acc.token || '')}">${escapeHtml(tokenShort)}</span>
                        <button class="ac-copy-btn" data-copy="${escapeAttr(acc.token || '')}" title="نسخ التوكن">⧉</button>
                      </td>
                      <td>${escapeHtml(acc.phone || '—')}</td>
                      <td class="ac-lib-date">${date}</td>
                      <td>
                        <button class="ac-del-btn ts-btn danger xs" data-acc-id="${escapeAttr(acc._id || '')}" title="حذف">✕</button>
                      </td>
                    </tr>`;
                  }).join('')}
              </tbody>
            </table>
          </div>

          ${totalPages > 1 ? `
          <div class="ac-lib-pagination">
            <button class="ts-btn-xs" id="ac-lib-prev" ${page === 0 ? 'disabled' : ''}>→</button>
            <span>${page + 1} / ${totalPages}</span>
            <button class="ts-btn-xs" id="ac-lib-next" ${page >= totalPages - 1 ? 'disabled' : ''}>←</button>
          </div>` : ''}
        `}
      </div>
    `;
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
    const card = $('#ac-library-card', this.contentArea);
    if (!card) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = this._renderLibraryCard();
    const newCard = tmp.firstElementChild;
    card.replaceWith(newCard);
    this._bindLibrary(newCard);

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
        row.innerHTML = `<button class="ts-btn warn" id="ac-force-reset">⚡ إعادة تعيين قسري</button>`;
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

    // Library
    const libCard = $('#ac-library-card', area);
    if (libCard) this._bindLibrary(libCard);

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

  _bindLibrary(card) {
    // Export button
    $('#ac-lib-export', card)?.addEventListener('click', () => this._exportLibrary());

    // Clear all
    $('#ac-lib-clear', card)?.addEventListener('click', async () => {
      if (!confirm('حذف جميع الحسابات من المكتبة؟ هذا الإجراء لا يمكن التراجع عنه.')) return;
      try {
        await window.electronAPI.acLibraryClear();
        this.library = [];
        this._libPage = 0;
        this._refreshLibraryPanel();
        showNotification('🗑 تم حذف جميع الحسابات', 'info');
      } catch (e) { showNotification('❌ ' + e.message, 'error'); }
    });

    // Search
    const searchInput = $('#ac-lib-search', card);
    if (searchInput && !searchInput._bound) {
      searchInput._bound = true;
      searchInput.addEventListener('input', (e) => {
        this._libSearch = e.target.value;
        this._libPage = 0;
        this._refreshLibraryPanel();
      });
    }

    // Pagination
    $('#ac-lib-prev', card)?.addEventListener('click', () => { this._libPage = Math.max(0, this._libPage - 1); this._refreshLibraryPanel(); });
    $('#ac-lib-next', card)?.addEventListener('click', () => { this._libPage++; this._refreshLibraryPanel(); });

    // Copy buttons
    $all('.ac-copy-btn', card).forEach(btn => {
      if (btn._bound) return;
      btn._bound = true;
      btn.addEventListener('click', async () => {
        const text = btn.dataset.copy || '';
        if (!text) return;
        try {
          await navigator.clipboard.writeText(text);
          const orig = btn.textContent;
          btn.textContent = '✓';
          setTimeout(() => { btn.textContent = orig; }, 1000);
        } catch (_) { showNotification('فشل النسخ', 'warn'); }
      });
    });

    // Show/hide password
    $all('.ac-show-pwd-btn', card).forEach(btn => {
      if (btn._bound) return;
      btn._bound = true;
      btn.addEventListener('click', () => {
        const row = btn.closest('td');
        const hidden = row?.querySelector('.ac-pwd-hidden');
        const shown  = row?.querySelector('.ac-pwd-shown');
        if (!hidden || !shown) return;
        const visible = shown.style.display !== 'none';
        hidden.style.display = visible ? '' : 'none';
        shown.style.display  = visible ? 'none' : '';
        btn.textContent = visible ? '👁' : '🙈';
      });
    });

    // Delete single account
    $all('.ac-del-btn', card).forEach(btn => {
      if (btn._bound) return;
      btn._bound = true;
      btn.addEventListener('click', async () => {
        const id = btn.dataset.accId;
        if (!id) return;
        try {
          await window.electronAPI.acLibraryDelete(id);
          this.library = this.library.filter(a => a._id !== id);
          this._refreshLibraryPanel();
        } catch (e) { showNotification('❌ ' + e.message, 'error'); }
      });
    });
  }

  // ── Actions ──────────────────────────────────────────────────────────────
  async _startSession() {
    const count = parseInt($('#ac-count', this.contentArea)?.value || '1') || 1;
    const prefix = $('#ac-prefix', this.contentArea)?.value?.trim() || '';

    try {
      const r = await window.electronAPI.acStart({ count, usernamePrefix: prefix });
      if (r?.success === false) throw new Error(r.error || 'Start failed');
      showNotification('✅ بدأت جلسة إنشاء الحسابات', 'success');
      if (r.snapshot) this.snapshot = r.snapshot;
      this._renderLive();
    } catch (e) {
      showNotification('❌ ' + (e.message || 'Start failed'), 'error');
    }
  }

  async _stopSession() {
    try {
      await window.electronAPI.acStop();
      showNotification('⛔ جاري الإيقاف...', 'warn');
      this._renderLive();
    } catch (e) {
      showNotification('❌ ' + (e.message || 'Stop failed'), 'error');
    }
  }

  async _forceReset() {
    try {
      const r = await window.electronAPI.acForceReset();
      if (r?.success === false) throw new Error(r.error || 'Reset failed');
      if (r.snapshot) this.snapshot = r.snapshot;
      showNotification('✅ تمت إعادة التعيين', 'success');
      this.render();
      this._bind();
    } catch (e) {
      showNotification('❌ ' + (e.message || 'Reset failed'), 'error');
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
    showNotification(`✅ تم تصدير ${clean.length} حساب`, 'success');
  }

  async _saveSmsKey() {
    const key = $('#ac-sms-key', this.contentArea)?.value?.trim();
    if (!key) { showNotification('أدخل مفتاح API أولاً', 'warn'); return; }
    await this._quickSave({ smsApiKey: key });
    const input = $('#ac-sms-key', this.contentArea);
    if (input) input.value = '';
    showNotification('✅ تم حفظ مفتاح SMS', 'success');
    // Reload settings to update badge
    await this._loadAll();
    this.render();
    this._bind();
  }

  async _saveCustomEmail() {
    const email = $('#ac-custom-email', this.contentArea)?.value?.trim();
    if (!email) { showNotification('أدخل الإيميل أولاً', 'warn'); return; }
    await this._quickSave({ customEmail: email });
    showNotification('✅ تم حفظ الإيميل', 'success');
  }

  async _saveProxy() {
    const url = $('#ac-proxy-url', this.contentArea)?.value?.trim();
    await this._quickSave({ proxyUrl: url || '' });
    showNotification(url ? '✅ تم حفظ البروكسي' : 'تم مسح البروكسي', url ? 'success' : 'info');
  }

  async _quickSave(payload) {
    try {
      const r = await window.electronAPI.acSaveSettings(payload);
      if (r?.settings) this.settings = r.settings;
    } catch (_) {}
  }
}
