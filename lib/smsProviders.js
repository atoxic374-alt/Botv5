// lib/smsProviders.js
// ─────────────────────────────────────────────────────────────────────────────
// Unified SMS provider layer: SMSPVA · 5sim · TextVerified
// Each provider exposes: getNumber(service, country) → { id, phone }
//                        getCode(id, service)        → { code } | null
//                        cancelNumber(id, service)   → void
//                        getBalance()                → { balance, currency }
// service slug for Discord: 'discord' (normalized per provider below)
// ─────────────────────────────────────────────────────────────────────────────

const axios = require('axios');

// ── helpers ────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function makeHttp(baseURL, headers = {}, timeout = 20_000) {
  return axios.create({ baseURL, headers, timeout, validateStatus: () => true });
}

// ── SMSPVA ─────────────────────────────────────────────────────────────────
// Docs: https://smspva.com/new_theme_api.html
// Endpoints:
//   GET  /priemnik/api/get_number/{service}/{apikey}/{country}
//   GET  /priemnik/api/get_sms/{service}/{apikey}/{id}
//   GET  /priemnik/api/denial/{service}/{apikey}/{id}
//   GET  /balance/api/get_balance/{apikey}
// service=discord, country=US (others: RU, GB, etc.)
class SmspvaProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.http = makeHttp('https://smspva.com');
    this.name = 'smspva';
  }

  async getBalance() {
    const r = await this.http.get(`/balance/api/get_balance/${this.apiKey}`);
    if (r.status !== 200) throw new Error(`SMSPVA balance error ${r.status}`);
    const d = r.data;
    return { balance: parseFloat(d?.balance ?? d?.data?.balance ?? 0), currency: 'USD' };
  }

  async getNumber(service = 'discord', country = 'US') {
    const svc = service.toLowerCase() === 'discord' ? 'opt59' : service;
    const url = `/priemnik/api/get_number/${svc}/${this.apiKey}/${country}`;
    const r = await this.http.get(url);
    if (r.status !== 200) throw new Error(`SMSPVA getNumber HTTP ${r.status}`);
    const d = r.data;
    if (d?.response !== 1) {
      throw new Error(`SMSPVA: ${d?.info || d?.text || JSON.stringify(d)}`);
    }
    return { id: String(d.id), phone: String(d.phone || '').replace(/\D/g, '') };
  }

  async getCode(id, service = 'discord') {
    const svc = service.toLowerCase() === 'discord' ? 'opt59' : service;
    const r = await this.http.get(`/priemnik/api/get_sms/${svc}/${this.apiKey}/${id}`);
    if (r.status !== 200) return null;
    const d = r.data;
    if (d?.response !== 1 || !d?.sms) return null;
    const match = String(d.sms).match(/\d{6}/);
    return match ? { code: match[0] } : null;
  }

  async cancelNumber(id, service = 'discord') {
    const svc = service.toLowerCase() === 'discord' ? 'opt59' : service;
    await this.http.get(`/priemnik/api/denial/${svc}/${this.apiKey}/${id}`).catch(() => {});
  }
}

// ── 5sim ───────────────────────────────────────────────────────────────────
// Docs: https://5sim.net/docs
// Auth: Bearer token in Authorization header
// GET  /v1/user/buy/activation/{country}/{operator}/{product}
// GET  /v1/user/check/{id}
// GET  /v1/user/cancel/{id}
// GET  /v1/user/profile  (balance)
class FiveSimProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.http = makeHttp('https://5sim.net/v1', {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    });
    this.name = '5sim';
  }

  async getBalance() {
    const r = await this.http.get('/user/profile');
    if (r.status !== 200) throw new Error(`5sim balance error ${r.status}`);
    return { balance: parseFloat(r.data?.balance ?? 0), currency: 'USD' };
  }

  async getNumber(service = 'discord', country = 'usa') {
    const product = service.toLowerCase();
    const ctry = country.toLowerCase() === 'us' ? 'usa' : country.toLowerCase();
    const r = await this.http.get(`/user/buy/activation/${ctry}/any/${product}`);
    if (r.status !== 200) {
      throw new Error(`5sim getNumber HTTP ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
    }
    const d = r.data;
    if (d?.status === 'ERROR' || !d?.id) {
      throw new Error(`5sim: ${d?.message || JSON.stringify(d)}`);
    }
    return { id: String(d.id), phone: String(d.phone || '').replace(/\D/g, '') };
  }

  async getCode(id) {
    const r = await this.http.get(`/user/check/${id}`);
    if (r.status !== 200) return null;
    const d = r.data;
    const smsList = d?.sms || [];
    if (!smsList.length) return null;
    const lastSms = smsList[smsList.length - 1];
    const text = lastSms?.text || lastSms?.code || '';
    const match = String(text).match(/\d{6}/);
    return match ? { code: match[0] } : null;
  }

  async cancelNumber(id) {
    await this.http.get(`/user/cancel/${id}`).catch(() => {});
  }
}

// ── TextVerified ────────────────────────────────────────────────────────────
// Docs: https://www.textverified.com/docs/api/v2
// Auth: X-SIMPLE-API-ACCESS-TOKEN header
// POST /api/pub/v2/authentications   → { id, number }
// GET  /api/pub/v2/authentications/{id}
// DEL  /api/pub/v2/authentications/{id}
// GET  /api/pub/v2/me  (balance)
class TextVerifiedProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.http = makeHttp('https://www.textverified.com', {
      'X-SIMPLE-API-ACCESS-TOKEN': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    });
    this.name = 'textverified';
  }

  async getBalance() {
    const r = await this.http.get('/api/pub/v2/me');
    if (r.status !== 200) throw new Error(`TextVerified balance error ${r.status}`);
    const credits = r.data?.data?.credit_balance ?? r.data?.credit_balance ?? 0;
    return { balance: parseFloat(credits), currency: 'credits' };
  }

  async getNumber(service = 'discord') {
    const r = await this.http.post('/api/pub/v2/authentications', {
      target_name: service.toLowerCase(),
    });
    if (r.status !== 201 && r.status !== 200) {
      throw new Error(`TextVerified getNumber HTTP ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
    }
    const d = r.data?.data || r.data;
    if (!d?.id) throw new Error(`TextVerified: ${JSON.stringify(d)}`);
    const phone = String(d.number || d.phone || '').replace(/\D/g, '');
    return { id: String(d.id), phone };
  }

  async getCode(id) {
    const r = await this.http.get(`/api/pub/v2/authentications/${id}`);
    if (r.status !== 200) return null;
    const d = r.data?.data || r.data;
    const code = d?.verification_code || d?.code || '';
    if (!code) return null;
    const match = String(code).match(/\d{4,8}/);
    return match ? { code: match[0] } : null;
  }

  async cancelNumber(id) {
    await this.http.delete(`/api/pub/v2/authentications/${id}`).catch(() => {});
  }
}

// ── Poll helper ─────────────────────────────────────────────────────────────
// Polls getCode every `intervalMs` for up to `maxMs`, returns code or throws.
async function pollForCode(provider, id, service, { maxMs = 120_000, intervalMs = 5_000, onWait } = {}) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const result = await provider.getCode(id, service).catch(() => null);
    if (result?.code) return result.code;
    if (onWait) onWait(Math.round((deadline - Date.now()) / 1000));
    await sleep(intervalMs);
  }
  throw new Error('SMS code timeout — no code received within limit');
}

// ── Factory ─────────────────────────────────────────────────────────────────
function createSmsProvider(settings) {
  const { provider, apiKey } = settings || {};
  if (!apiKey) throw new Error('SMS provider API key is required');
  switch ((provider || '').toLowerCase()) {
    case 'smspva':       return new SmspvaProvider(apiKey);
    case '5sim':         return new FiveSimProvider(apiKey);
    case 'textverified': return new TextVerifiedProvider(apiKey);
    default: throw new Error(`Unknown SMS provider: "${provider}". Use smspva, 5sim, or textverified`);
  }
}

module.exports = { SmspvaProvider, FiveSimProvider, TextVerifiedProvider, createSmsProvider, pollForCode };
