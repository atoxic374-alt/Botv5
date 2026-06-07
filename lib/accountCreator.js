// lib/accountCreator.js
// ─────────────────────────────────────────────────────────────────────────────
// Discord account-creation engine.
//
// Pipeline per account:
//   1. Simulate initial Discord browsing (anti-detection)
//   2. Get temp email  (Mail.tm / Guerrilla / Custom)
//   3. Get temp phone  (SMSPVA / 5sim / TextVerified)  ← optional
//   4. Boot fresh HTTP client with Chrome TLS fingerprint + per-account proxy
//   5. POST /auth/register  { email, username, password, captcha_key, ... }
//   6. Confirm email  (poll inbox → click verify link OR submit 6-digit code)
//   7. Verify phone   (POST /users/@me/phone → receive SMS → POST /phone-verifications/verify)
//      ↑ only if (a) smsProvider supplied AND (b) Discord account flags it required
//   8. Release phone number back to pool
//   9. Return { email, password, token, userId }
//
// Each account gets its own isolated session (cookies, TLS state, proxy IP).
// This is the critical anti-detection requirement — never share a session.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { createClient, humanDelay, simulateBrowsing, rateLimitInfoFromResponse } = require('./trueStudio');
const { createSmsProvider, pollForCode } = require('./smsProviders');
const { createEmailProvider } = require('./emailProviders');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent }  = require('http-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

const axios = require('axios');

const API   = 'https://discord.com/api/v9';
const REGISTER_URL = `${API}/auth/register`;
const PHONE_SEND_URL = `${API}/users/@me/phone`;
const PHONE_VERIFY_URL = `${API}/phone-verifications/verify`;

// ── Usernames pool ───────────────────────────────────────────────────────────
const ADJECTIVES = [
  'Dark','Swift','Neon','Cool','Bright','Alpha','Silent','Iron','Storm','Ghost',
  'Cyber','Ultra','Prime','Royal','Sharp','Void','Lunar','Solar','Blaze','Frost',
  'Hyper','Turbo','Omega','Delta','Sigma','Pixel','Sonic','Rogue','Zenith','Apex',
  'Flash','Stealth','Mystic','Atomic','Surge','Crimson','Azure','Titan','Ember','Nova',
];
const NOUNS = [
  'Wolf','Fox','Hawk','Bear','Lion','Eagle','Tiger','Panda','Lynx','Raven',
  'Drake','Viper','Nova','Byte','Core','Comet','Pulse','Shard','Drift','Blade',
  'Storm','Crypt','Forge','Rift','Nexus','Orbit','Prism','Spark','Cipher','Grid',
  'Flare','Wraith','Specter','Claw','Void','Matrix','Realm','Epoch','Axis','Flux',
];

function randBetween(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }
function randEl(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randStr(len, chars = 'abcdefghijklmnopqrstuvwxyz0123456789') {
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function generateUsername(prefix) {
  // Add timestamp entropy so repeated calls never collide with each other
  const tsFragment = (Date.now() % 99991).toString(36); // 3-4 base36 chars
  if (prefix && prefix.trim()) {
    // prefix_<4 alphanum><ts> — much harder to collide
    return `${prefix.trim()}_${randStr(4)}${tsFragment}`;
  }
  // AdjNoun<4-digit number><ts> — very wide space
  return `${randEl(ADJECTIVES)}${randEl(NOUNS)}${randBetween(10, 9999)}${tsFragment}`;
}

function generatePassword(len = 16) {
  const upper   = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower   = 'abcdefghijklmnopqrstuvwxyz';
  const digits  = '0123456789';
  const special = '!@#$%^&*';
  const all = upper + lower + digits + special;
  let pwd = randEl([...upper]) + randEl([...lower]) + randEl([...digits]) + randEl([...special]);
  for (let i = 4; i < len; i++) pwd += all[Math.floor(Math.random() * all.length)];
  return pwd.split('').sort(() => Math.random() - 0.5).join('');
}

// ── makeAccountSession ───────────────────────────────────────────────────────
// Creates an isolated axios instance with Chrome TLS + optional proxy.
// Independent per account — never share between accounts.
function makeAccountSession(proxyUrl) {
  const client = createClient(proxyUrl || null);

  const ua = client.uaInfo;
  const http = client.http;

  // Override default headers for Discord web flow
  Object.assign(http.defaults.headers, {
    'Accept':             '*/*',
    'Accept-Language':    'en-US,en;q=0.9',
    'sec-fetch-dest':     'empty',
    'sec-fetch-mode':     'cors',
    'sec-fetch-site':     'same-origin',
  });

  return { http, uaInfo: ua, client };
}

// ── getDiscordBuildNumber ─────────────────────────────────────────────────────
// Tries to scrape the current Discord client build number from the web app.
async function getDiscordBuildNumber(http) {
  try {
    const r = await http.get('https://discord.com/login', {
      headers: { 'Accept': 'text/html', 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' },
      timeout: 12000,
    });
    const match = String(r.data).match(/\/assets\/([a-z0-9]+)\.js/g);
    if (match) {
      for (const src of match.slice(-5)) {
        const js = await http.get(`https://discord.com${src}`, { timeout: 10000 }).catch(() => null);
        const m = String(js?.data || '').match(/buildNumber\s*[:=]\s*"?(\d{5,7})"?/);
        if (m) return parseInt(m[1]);
      }
    }
  } catch (_) {}
  return 367525; // safe fallback — Discord 2025
}

// ── registerAccount ──────────────────────────────────────────────────────────
// Calls Discord's /auth/register endpoint.
//
// Modern Discord flow (2025 — docs.discord.food/topics/captcha-handling):
//   • First call:  no captcha fields at all → Discord returns 400 + captcha challenge
//   • Retry call:  captcha token in X-Captcha-Key header (NOT in body)
//                  + X-Captcha-Rqtoken and X-Captcha-Session-Id when provided
//
// dateOfBirth:    caller-supplied so it's consistent across probe + retry
// captchaKey:     null on first call (no captcha yet), solved token on retry
// captchaRqtoken: rqtoken from the challenge response — echo it back in header
// captchaSessionId: session_id from the challenge response — echo it back in header
//
// Returns { token, userId, needsPhone } on success.
// Throws with { code:'CAPTCHA', sitekey, rqdata, rqtoken, sessionId } on captcha challenge.
async function registerAccount({ http, email, username, password, dateOfBirth, captchaKey, captchaRqtoken, captchaSessionId, fingerprint, buildNumber }) {
  const superProps = Buffer.from(JSON.stringify({
    os: 'Windows', browser: 'Chrome', device: '', system_locale: 'en-US',
    browser_user_agent: http.defaults.headers['User-Agent'] || '',
    browser_version: '133.0.0.0', os_version: '10', referrer: '',
    referring_domain: '', referrer_current: '', referring_domain_current: '',
    release_channel: 'stable', client_build_number: buildNumber || 367525,
    client_event_source: null, design_id: 0,
  })).toString('base64');

  // Fallback DoB if caller didn't supply one
  const dob = dateOfBirth || `${randBetween(1985, 2002)}-${String(randBetween(1,12)).padStart(2,'0')}-${String(randBetween(1,28)).padStart(2,'0')}`;

  // captcha_key is intentionally OMITTED from the body.
  // Modern Discord (2025) reads it from X-Captcha-Key header only.
  // Sending it in both body + header causes a captcha loop on some builds.
  const body = {
    email,
    username,
    password,
    invite:                       null,
    consent:                      true,
    date_of_birth:                dob,
    gift_code_sku_id:             null,
    unique_username_registration: true,
  };

  const headers = {
    'Content-Type':       'application/json',
    'X-Super-Properties': superProps,
    'X-Fingerprint':      fingerprint || '',
    'Origin':             'https://discord.com',
    'Referer':            'https://discord.com/register',
  };

  // Add captcha headers only when we have a solved token
  if (captchaKey) {
    headers['X-Captcha-Key'] = captchaKey;
  }
  if (captchaRqtoken) {
    headers['X-Captcha-Rqtoken'] = captchaRqtoken;
  }
  if (captchaSessionId) {
    headers['X-Captcha-Session-Id'] = captchaSessionId;
  }

  const r = await http.post(REGISTER_URL, body, { headers });

  if (r.status === 201 || r.status === 200) {
    const token = r.data?.token;
    if (!token) throw new Error('Register succeeded but no token in response');
    const needsPhone = !!(r.data?.phone_number_required || r.data?.require_phone);
    return { token, userId: r.data?.user_id || null, needsPhone };
  }

  if (r.status === 429) {
    const info = rateLimitInfoFromResponse(r);
    throw Object.assign(new Error(`Rate limited — retry after ${info.retryAfter || '?'}s`), { code: 'RATE_LIMITED', retryAfter: info.retryAfter });
  }

  // Discord returned a captcha challenge — pass ALL challenge fields back to caller
  if (r.data?.captcha_sitekey) {
    const service = r.data.captcha_service || 'hcaptcha';
    throw Object.assign(new Error('Captcha required'), {
      code:      'CAPTCHA',
      service,
      sitekey:   r.data.captcha_sitekey,
      rqdata:    r.data.captcha_rqdata    || null,
      rqtoken:   r.data.captcha_rqtoken   || null,
      sessionId: r.data.captcha_session_id || null,
    });
  }

  // EMAIL_INVALID — let caller switch email and retry
  const emailErr = r.data?.errors?.email?._errors?.[0]?.code;
  if (emailErr === 'EMAIL_INVALID' || emailErr === 'EMAIL_ALREADY_REGISTERED') {
    throw Object.assign(new Error(emailErr), { code: emailErr });
  }

  // USERNAME_ALREADY_TAKEN (also surfaces here on captcha retry)
  const usernameErr = r.data?.errors?.username?._errors?.[0]?.code;
  if (usernameErr === 'USERNAME_ALREADY_TAKEN') {
    throw Object.assign(new Error('USERNAME_ALREADY_TAKEN'), { code: 'USERNAME_ALREADY_TAKEN' });
  }

  // Log full response for unexpected non-captcha failures so we can diagnose
  throw new Error(`Register failed ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
}

// ── sendPhoneVerification ─────────────────────────────────────────────────────
async function sendPhoneVerification({ http, token, phone }) {
  const r = await http.patch(PHONE_SEND_URL, { phone: `+${phone}` }, {
    headers: { 'Authorization': token, 'Content-Type': 'application/json' },
  });
  if (r.status === 400 && r.data?.message?.toLowerCase().includes('phone')) {
    // Phone already set or not needed — not a fatal error
    return false;
  }
  if (r.status >= 400) {
    throw new Error(`Send phone verification failed ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
  }
  return true;
}

// ── confirmPhoneCode ──────────────────────────────────────────────────────────
async function confirmPhoneCode({ http, token, phone, code }) {
  const r = await http.post(PHONE_VERIFY_URL, { phone: `+${phone}`, code }, {
    headers: { 'Authorization': token, 'Content-Type': 'application/json' },
  });
  if (r.status >= 400) {
    throw new Error(`Phone confirm failed ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
  }
  return true;
}

// ── getDiscordFingerprint ─────────────────────────────────────────────────────
async function getDiscordFingerprint(http) {
  const r = await http.get(`${API}/experiments`, {
    headers: { 'Referer': 'https://discord.com/register' },
  });
  return r.data?.fingerprint || '';
}

// ── verifyEmail ───────────────────────────────────────────────────────────────
// Submits an email verification code OR clicks a verification link.
async function verifyEmail({ http, token, code }) {
  // First try: treat code as a 6-digit numeric code
  if (/^\d{6}$/.test(code)) {
    const r = await http.post(`${API}/auth/verify`, { token: code }, {
      headers: { Authorization: token, 'Content-Type': 'application/json' },
    });
    if (r.status < 400) return true;
  }
  // Fallback: treat as a full verify token from a link
  const r2 = await http.post(`${API}/auth/verify`, { token: code }, {
    headers: { Authorization: token, 'Content-Type': 'application/json' },
  });
  return r2.status < 400;
}

// ── makeSession ───────────────────────────────────────────────────────────────
function makeSession() {
  return {
    state:          'idle',   // idle|running|done|cancelled|error
    total:          0,
    done:           0,
    failed:         0,
    current:        '',
    accounts:       [],       // [{email,username,token,userId,phone,createdAt}]
    log:            [],
    lastError:      null,
    startedAt:      null,
    finishedAt:     null,
    cancelRequested: false,
    cancelRef:      null,
  };
}

// ── createOneAccountAsync ─────────────────────────────────────────────────────
// Creates a single Discord account end-to-end.
// onLog(level, msg) — callback for live log streaming.
// onCaptcha({sitekey, rqdata}) → Promise<string captchaKey>  — captcha resolver
// Returns account object or throws.
async function createOneAccountAsync({
  index,
  smsProvider,    // null = skip phone verification
  emailProvider,
  customEmail,
  proxyUrl,
  usernamePrefix,
  smsCountry,
  speedFactor = 1,
  onLog,
  onCaptcha,
  buildNumber,
}) {
  const label = `acc-${String(index + 1).padStart(3, '0')}`;
  const log = (level, msg) => { if (onLog) onLog(level, `[${label}] ${msg}`); };

  // Delay multiplier: speedFactor=1 → normal, speedFactor=0.5 → half delay
  const delay = (base, jitter = 0) => humanDelay(Math.round(base * speedFactor), Math.round(jitter * speedFactor));

  log('info', 'بدء إنشاء الحساب...');

  // ── 1. Isolated session (own cookies + TLS state + proxy) ─────────────────
  const { http, client } = makeAccountSession(proxyUrl);

  // ── 2. Simulate initial browsing (anti-detection) ─────────────────────────
  log('info', 'محاكاة تصفح Discord...');
  try {
    await simulateBrowsing(client, { speedFactor });
  } catch (_) {}

  // Human pause after browsing — like a user deciding to register
  await delay(1200, 900);

  // ── 3. Fingerprint ────────────────────────────────────────────────────────
  log('info', 'جلب fingerprint...');
  const fingerprint = await getDiscordFingerprint(http).catch(() => '');

  // Fetch build number if not provided
  if (!buildNumber) {
    buildNumber = await getDiscordBuildNumber(http).catch(() => 367525);
    log('info', `رقم الإصدار: ${buildNumber}`);
  }

  // Micro-pause like a user navigating to the register page
  await delay(700, 500);

  // ── 4. Temp email ─────────────────────────────────────────────────────────
  let emailCtx, email;
  if (customEmail && emailProvider.name === 'custom') {
    emailCtx = await emailProvider.createInbox(customEmail);
    email = customEmail;
    log('info', `إيميل مخصص: ${email}`);
  } else {
    log('info', `جلب إيميل مؤقت (${emailProvider.name})...`);
    emailCtx = await emailProvider.createInbox();
    email = emailCtx.address;
    log('info', `الإيميل: ${email}`);
  }

  // Simulate typing email into the form field
  await delay(600, 400);

  // ── 5. Temp phone (optional) ──────────────────────────────────────────────
  let phoneId = null, phone = null;
  if (smsProvider) {
    log('info', `طلب رقم هاتف (${smsProvider.name})...`);
    try {
      const numResult = await smsProvider.getNumber('discord', smsCountry || 'US');
      phoneId = numResult.id;
      phone = numResult.phone;
      log('info', `📱 الرقم: +${phone}`);
    } catch (e) {
      log('warn', `فشل الحصول على رقم هاتف — متابعة بدون رقم: ${e.message}`);
      smsProvider = null;
    }
  } else {
    log('info', 'SMS غير مُفعَّل — إنشاء بدون رقم هاتف');
  }

  // Simulate filling in password + username fields with human timing
  await delay(500, 400);

  const password = generatePassword();
  let username = generateUsername(usernamePrefix);
  log('info', `المعرف: ${username}`);

  // Simulate human typing delay before filling the form
  await delay(800, 600);
  await delay(400, 300); // micro-pause like reading the page

  // ── 6 & 7. Register — modern flow: no captcha on first call, solve on challenge ─
  //
  // Modern Discord (2025) flow per docs.discord.food/topics/captcha-handling:
  //   Attempt 1: send registration body with NO captcha headers/fields
  //              → Discord returns 400 + {captcha_sitekey, captcha_rqdata,
  //                                        captcha_rqtoken, captcha_session_id}
  //   Solve:     pass rqdata to captcha service → get solved token
  //   Attempt 2: send SAME body + X-Captcha-Key / X-Captcha-Rqtoken /
  //              X-Captcha-Session-Id headers
  //   If Discord returns ANOTHER captcha challenge → re-solve and retry (max 3×)
  //
  // date_of_birth is generated ONCE here so probe + retry use the same value.

  // Generate DoB once — used in every attempt so Discord sees a consistent value
  const dateOfBirth = `${randBetween(1985, 2002)}-${String(randBetween(1,12)).padStart(2,'0')}-${String(randBetween(1,28)).padStart(2,'0')}`;

  log('info', 'تسجيل الحساب في Discord...');

  let token, userId, needsPhone;
  let captchaKey       = null;   // null = first attempt (no captcha yet)
  let captchaRqtoken   = null;
  let captchaSessionId = null;
  const MAX_USERNAME_RETRIES = 4;
  const MAX_CAPTCHA_RETRIES  = 3;
  let usernameAttempt = 0;
  let captchaAttempt  = 0;

  while (true) {
    try {
      ({ token, userId, needsPhone } = await registerAccount({
        http, email, username, password, dateOfBirth,
        captchaKey, captchaRqtoken, captchaSessionId,
        fingerprint, buildNumber,
      }));
      break; // success

    } catch (e) {
      // ── Discord returned a captcha challenge ───────────────────────────
      if (e.code === 'CAPTCHA') {
        if (captchaAttempt >= MAX_CAPTCHA_RETRIES) {
          if (phoneId && smsProvider) await smsProvider.cancelNumber(phoneId, 'discord').catch(() => {});
          await emailProvider.deleteInbox(emailCtx).catch(() => {});
          throw new Error(`فشل التسجيل بعد ${MAX_CAPTCHA_RETRIES} محاولات كابتشا`);
        }
        captchaAttempt++;
        captchaRqtoken   = e.rqtoken   || null;
        captchaSessionId = e.sessionId || null;

        const serviceLabel = e.service === 'turnstile' ? 'Cloudflare Turnstile'
          : e.rqdata ? 'hCaptcha Enterprise (rqdata)' : 'hCaptcha Standard';
        if (captchaAttempt === 1) {
          log('info', `نوع الكابتشا: ${serviceLabel} | sitekey: ${(e.sitekey||'').slice(0,8)}… | rqdata: ${e.rqdata ? 'نعم' : 'لا'} | service: ${e.service || 'hcaptcha'}`);
          log('info', `حل الكابتشا (${serviceLabel})...`);
        } else {
          log('warn', `⚠ Discord طلب كابتشا جديدة [${serviceLabel}] (محاولة ${captchaAttempt}/${MAX_CAPTCHA_RETRIES}) | rqdata: ${e.rqdata ? e.rqdata.slice(0,20)+'…' : 'لا'}`);
        }

        try {
          captchaKey = await onCaptcha({
            sitekey: e.sitekey,
            rqdata:  e.rqdata || null,
            url:     'https://discord.com/register',
          });
          log('info', captchaAttempt === 1 ? '✅ الكابتشا محلول' : `✅ الكابتشا محلول (محاولة ${captchaAttempt})`);
        } catch (captchaErr) {
          if (phoneId && smsProvider) await smsProvider.cancelNumber(phoneId, 'discord').catch(() => {});
          await emailProvider.deleteInbox(emailCtx).catch(() => {});
          throw new Error('فشل حل الكابتشا: ' + captchaErr.message);
        }

        // Human pause after solving captcha
        await delay(600, 800);
        continue;
      }

      // ── Username already taken ─────────────────────────────────────────
      if (e.message?.includes('USERNAME_ALREADY_TAKEN') && usernameAttempt < MAX_USERNAME_RETRIES) {
        usernameAttempt++;
        username = generateUsername(usernamePrefix);
        log('warn', `اسم المستخدم محجوز — محاولة ${usernameAttempt}/${MAX_USERNAME_RETRIES}: ${username}`);
        await delay(400, 300);
        continue;
      }

      // ── Other error — clean up and propagate ──────────────────────────
      if (phoneId && smsProvider) await smsProvider.cancelNumber(phoneId, 'discord').catch(() => {});
      await emailProvider.deleteInbox(emailCtx).catch(() => {});
      throw e;
    }
  }
  log('info', `✅ تم إنشاء الحساب — userId: ${userId}`);
  if (needsPhone) log('info', 'Discord يطلب تحقق الهاتف لهذا الحساب');

  await delay(1500, 1000);

  // ── 8. Phone verification (optional — only if SMS configured or needsPhone) ──
  let verifiedPhone = null;
  if (smsProvider && phoneId && phone) {
    log('info', 'إرسال رمز التحقق للهاتف...');
    try {
      const sent = await sendPhoneVerification({ http, token, phone });
      if (sent) {
        log('info', 'انتظار رمز SMS...');
        const smsCode = await pollForCode(smsProvider, phoneId, 'discord', {
          maxMs: 120_000,
          intervalMs: 6_000,
          onWait: (remaining) => log('info', `⏳ SMS — ${remaining}s متبقية...`),
        });
        log('info', `✅ رمز SMS: ${smsCode}`);
        await confirmPhoneCode({ http, token, phone, code: smsCode });
        log('info', '✅ تم التحقق من الهاتف');
        verifiedPhone = `+${phone}`;
      } else {
        log('info', 'الهاتف غير مطلوب لهذا الحساب — تخطي');
      }
    } catch (e) {
      log('warn', `تحقق الهاتف فشل (غير مميت): ${e.message}`);
    }
    await smsProvider.cancelNumber(phoneId, 'discord').catch(() => {});
  } else if (needsPhone && !smsProvider) {
    log('warn', '⚠ Discord طلب رقم هاتف لكن SMS غير مُفعَّل — الحساب قد يكون محدود الصلاحيات');
  }

  // ── 9. Email verification (if needed) ────────────────────────────────────
  if (emailProvider.name !== 'custom') {
    log('info', 'انتظار رمز التحقق من الإيميل...');
    try {
      const emailCode = await emailProvider.waitForCode(emailCtx, {
        maxMs: 90_000,
        intervalMs: 7_000,
        onWait: (remaining) => log('info', `📧 إيميل — ${remaining}s متبقية...`),
      });
      const verified = await verifyEmail({ http, token, code: emailCode });
      if (verified) {
        log('info', '✅ تم التحقق من الإيميل');
      } else {
        log('warn', 'تحقق الإيميل: استجابة غير متوقعة — متابعة');
      }
    } catch (e) {
      if (e.message === 'MANUAL_CODE_REQUIRED') {
        log('warn', 'إيميل مخصص — أدخل رمز التحقق يدوياً إن طُلب');
      } else {
        log('warn', 'تجاوز تحقق الإيميل: ' + e.message);
      }
    }
    await emailProvider.deleteInbox(emailCtx).catch(() => {});
  }

  log('info', '🎉 الحساب جاهز!');

  return {
    email,
    username,
    password,
    token,
    userId,
    phone: verifiedPhone,
    createdAt: new Date().toISOString(),
  };
}

// ── runAccountSession ─────────────────────────────────────────────────────────
// Runs a full batch of account creation.
// opts: { count, usernamePrefix, smsSettings, emailSettings, customEmail,
//         proxyUrl, smsCountry, speedFactor, onLog, onCaptcha, onProgress, onAccountCreated }
async function runAccountSession(opts) {
  const {
    count = 1,
    usernamePrefix = '',
    smsSettings,       // null = skip phone entirely
    emailSettings,
    customEmail,
    proxyUrl,
    smsCountry = 'US',
    speedFactor = 1,
    onLog,
    onCaptcha,
    onProgress,
    onAccountCreated, // called with account object after each success — for live-save
    buildNumber,
    cancelRef,
  } = opts;

  // SMS provider is optional — null means no phone verification
  let smsProvider = null;
  if (smsSettings && smsSettings.apiKey) {
    try {
      smsProvider = createSmsProvider(smsSettings);
    } catch (e) {
      if (onLog) onLog('warn', `SMS provider init failed — continuing without phone: ${e.message}`);
    }
  }
  const emailProvider = createEmailProvider(emailSettings);

  const results = { success: [], failed: [] };

  for (let i = 0; i < count; i++) {
    if (cancelRef && cancelRef.cancelled) {
      if (onLog) onLog('warn', 'إلغاء الجلسة...');
      break;
    }

    if (onProgress) onProgress(i, count);

    try {
      const account = await createOneAccountAsync({
        index: i,
        smsProvider,
        emailProvider,
        customEmail,
        proxyUrl,
        usernamePrefix,
        smsCountry,
        speedFactor,
        onLog,
        onCaptcha,
        buildNumber,
      });
      results.success.push(account);
      if (onLog) onLog('success', `✅ acc-${String(i+1).padStart(3,'0')}: ${account.email}`);
      if (onAccountCreated) onAccountCreated(account);
    } catch (e) {
      results.failed.push({ index: i, error: e.message });
      if (onLog) onLog('error', `❌ acc-${String(i+1).padStart(3,'0')}: ${e.message}`);
    }

    // Delay between accounts (anti-detection)
    if (i < count - 1 && !(cancelRef && cancelRef.cancelled)) {
      const base = Math.round(3000 / speedFactor);
      const jitter = Math.round(5000 / speedFactor);
      const delayMs = randBetween(base, base + jitter);
      if (onLog) onLog('info', `⏳ تأخير ${Math.round(delayMs/1000)}s قبل الحساب التالي...`);
      let elapsed = 0;
      while (elapsed < delayMs) {
        if (cancelRef && cancelRef.cancelled) break;
        await sleep(500);
        elapsed += 500;
      }
    }
  }

  if (onProgress) onProgress(count, count);
  return results;
}

module.exports = { makeSession, runAccountSession, createOneAccountAsync, generateUsername, generatePassword };
