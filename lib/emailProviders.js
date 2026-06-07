// lib/emailProviders.js
// ─────────────────────────────────────────────────────────────────────────────
// Unified temp-email layer: Mail.tm · Guerrilla Mail · Custom (user-supplied)
// Each provider exposes:
//   createInbox()         → { address, token/session }
//   waitForCode(ctx, ms)  → string (6-digit verification code)
//   deleteInbox(ctx)      → void
// ─────────────────────────────────────────────────────────────────────────────

const axios = require('axios');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function randStr(len = 10) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// ── Mail.tm ─────────────────────────────────────────────────────────────────
// Docs: https://docs.mail.tm  — completely free, no API key needed.
// POST /accounts        { address, password }  → creates mailbox
// POST /token           { address, password }  → JWT
// GET  /messages        Authorization: Bearer <jwt>
// GET  /messages/:id    full message body
// DELETE /accounts/:id
class MailTmProvider {
  constructor() {
    this.http = axios.create({
      baseURL: 'https://api.mail.tm',
      timeout: 20_000,
      validateStatus: () => true,
      headers: { 'Content-Type': 'application/json' },
    });
    this.name = 'mailtm';
  }

  async _getDomains() {
    const r = await this.http.get('/domains');
    const items = r.data?.['hydra:member'] || r.data?.domains || [];
    if (!items.length) throw new Error('Mail.tm: no domains available');
    return items.map(d => d.domain || d);
  }

  async createInbox() {
    const domains = await this._getDomains();
    const domain = domains[0];
    const user = randStr(10);
    const address = `${user}@${domain}`;
    const password = randStr(16) + 'Aa1!';

    const create = await this.http.post('/accounts', { address, password });
    if (create.status !== 201) {
      throw new Error(`Mail.tm createInbox HTTP ${create.status}: ${JSON.stringify(create.data).slice(0, 200)}`);
    }
    const id = create.data?.id;

    const tok = await this.http.post('/token', { address, password });
    if (tok.status !== 200) throw new Error(`Mail.tm token HTTP ${tok.status}`);
    const token = tok.data?.token;

    return { address, password, token, id, provider: 'mailtm' };
  }

  async waitForCode(ctx, { maxMs = 120_000, intervalMs = 6_000, onWait, keywords = ['discord', 'verify', 'code', 'confirm'] } = {}) {
    const deadline = Date.now() + maxMs;
    const auth = { Authorization: `Bearer ${ctx.token}` };
    while (Date.now() < deadline) {
      const r = await this.http.get('/messages', { headers: auth }).catch(() => null);
      const msgs = r?.data?.['hydra:member'] || r?.data?.messages || [];
      for (const msg of msgs) {
        const subject = (msg.subject || '').toLowerCase();
        if (keywords.some(k => subject.includes(k))) {
          const full = await this.http.get(`/messages/${msg.id}`, { headers: auth }).catch(() => null);
          const body = full?.data?.text || full?.data?.html || msg.intro || '';
          const match = String(body).match(/\b(\d{6})\b/);
          if (match) return match[1];
        }
      }
      if (onWait) onWait(Math.round((deadline - Date.now()) / 1000));
      await sleep(intervalMs);
    }
    throw new Error('Email verification timeout — no code received');
  }

  async deleteInbox(ctx) {
    if (!ctx?.id || !ctx?.token) return;
    await this.http.delete(`/accounts/${ctx.id}`, {
      headers: { Authorization: `Bearer ${ctx.token}` },
    }).catch(() => {});
  }
}

// ── Guerrilla Mail ──────────────────────────────────────────────────────────
// Docs: https://www.guerrillamail.com/GuerrillaMailAPI.html
// Uses session-cookie-based API (no auth key needed).
// GET  ?f=get_email_address            → { email_addr, sid_token }
// GET  ?f=get_email_list&offset=0      → { list: [{mail_id, mail_subject, mail_excerpt}...] }
// GET  ?f=fetch_email&email_id={id}    → { mail_body }
// GET  ?f=del_email&email_ids=[id]
class GuerrillaProvider {
  constructor() {
    this.http = axios.create({
      baseURL: 'https://api.guerrillamail.com/ajax.php',
      timeout: 20_000,
      validateStatus: () => true,
    });
    this.name = 'guerrilla';
  }

  async createInbox() {
    const r = await this.http.get('', { params: { f: 'get_email_address', lang: 'en' } });
    if (r.status !== 200) throw new Error(`Guerrilla Mail HTTP ${r.status}`);
    const d = r.data;
    return {
      address: d.email_addr,
      sidToken: d.sid_token,
      provider: 'guerrilla',
    };
  }

  async waitForCode(ctx, { maxMs = 120_000, intervalMs = 7_000, onWait, keywords = ['discord', 'verify', 'code', 'confirm'] } = {}) {
    const deadline = Date.now() + maxMs;
    const seenIds = new Set();
    while (Date.now() < deadline) {
      const r = await this.http.get('', {
        params: { f: 'get_email_list', offset: 0, sid_token: ctx.sidToken },
      }).catch(() => null);
      const list = r?.data?.list || [];
      for (const item of list) {
        if (seenIds.has(item.mail_id)) continue;
        seenIds.add(item.mail_id);
        const subject = (item.mail_subject || '').toLowerCase();
        if (keywords.some(k => subject.includes(k))) {
          const full = await this.http.get('', {
            params: { f: 'fetch_email', email_id: item.mail_id, sid_token: ctx.sidToken },
          }).catch(() => null);
          const body = full?.data?.mail_body || item.mail_excerpt || '';
          const match = String(body).replace(/<[^>]+>/g, ' ').match(/\b(\d{6})\b/);
          if (match) return match[1];
        }
      }
      if (onWait) onWait(Math.round((deadline - Date.now()) / 1000));
      await sleep(intervalMs);
    }
    throw new Error('Guerrilla Mail timeout — no code received');
  }

  async deleteInbox(ctx) {
    // Guerrilla Mail sessions expire automatically; nothing needed
  }
}

// ── Custom (user-supplied) address ──────────────────────────────────────────
// User provides their own email; the platform just stores the address and
// waits for a manual code entry (or skips email verification if Discord
// doesn't require it for that flow). Used when user has a dedicated domain.
class CustomEmailProvider {
  constructor() { this.name = 'custom'; }

  async createInbox(address) {
    if (!address) throw new Error('Custom provider requires a pre-set email address');
    return { address, provider: 'custom' };
  }

  async waitForCode(_ctx, _opts) {
    // Custom email — code must be supplied manually via the UI
    throw new Error('MANUAL_CODE_REQUIRED');
  }

  async deleteInbox() {}
}

// ── Factory ─────────────────────────────────────────────────────────────────
function createEmailProvider(settings) {
  const { provider } = settings || {};
  switch ((provider || 'mailtm').toLowerCase()) {
    case 'mailtm':    return new MailTmProvider();
    case 'guerrilla': return new GuerrillaProvider();
    case 'custom':    return new CustomEmailProvider();
    default: throw new Error(`Unknown email provider: "${provider}". Use mailtm, guerrilla, or custom`);
  }
}

module.exports = { MailTmProvider, GuerrillaProvider, CustomEmailProvider, createEmailProvider };
