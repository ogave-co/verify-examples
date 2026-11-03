// Sign up / sign in with a phone number and a one-time code (Verify API).
// All API calls happen here on the server; the browser only sees our own pages and a session cookie.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';
import session from 'express-session';
import { ApiError } from './verify-client.js';
import { normalizePhone, maskPhone } from './phone.js';
import * as views from './views.js';

const LOCALES = ['en', 'es', 'pt', 'fr', 'de', 'it'];

/**
 * @param {object} opts
 * @param {ReturnType<import('./verify-client.js').createVerifyClient>} opts.verify
 * @param {string} opts.sessionSecret
 * @param {Map<string, {name: string}>} [opts.users]  phone -> user (in memory; use your database)
 * @param {number} [opts.resendCooldown]  seconds before the first resend is offered (match your Verify app setting)
 * @param {boolean} [opts.secureCookies]  true when served over HTTPS
 */
export function createApp({ verify, sessionSecret, users = new Map(), resendCooldown = 30, secureCookies = false, trustProxy = false, log = console }) {
  if (!sessionSecret || sessionSecret.length < 16) throw new Error('SESSION_SECRET must be at least 16 characters');
  const app = express();
  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', 1);
  app.use(express.urlencoded({ extended: false, limit: '10kb' }));
  // MemoryStore is fine for a demo; use a shared store (Redis, database) in production.
  app.use(session({
    name: 'sid', secret: sessionSecret, resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: secureCookies, maxAge: 30 * 60 * 1000 },
  }));

  // CSRF token per session, checked on every POST.
  app.use((req, res, next) => {
    req.session.csrf ??= token();
    if (req.method === 'POST' && !safeEqual(req.body?._csrf, req.session.csrf)) return res.status(403).send('Invalid form token. Reload the page.');
    next();
  });

  const flash = (req, text, ok = false) => { req.session.flash = { text, ok }; };
  const takeFlash = (req) => { const f = req.session.flash; delete req.session.flash; return f; };
  // One random nonce per rendered form; reused as the Idempotency-Key, so a double submit is not sent twice.
  // The API accepts keys of up to 64 characters, so action + nonce are hashed to 43.
  const idem = (req, action) => {
    const nonce = /^[a-f0-9]{32}$/.test(req.body?.nonce ?? '') ? req.body.nonce : token();
    return idemFor(`${action}:${nonce}`);
  };

  app.get('/', (req, res) => {
    const u = req.session.user;
    if (!u) return res.redirect('/login');
    res.send(views.home({ user: { ...u, maskedPhone: maskPhone(u.phone), csrf: req.session.csrf }, flash: takeFlash(req) }));
  });

  for (const mode of ['signup', 'login']) {
    app.get(`/${mode}`, (req, res) => {
      if (req.session.pending) return res.redirect('/verify');
      res.send(views.start({ mode, csrf: req.session.csrf, nonce: token(), flash: takeFlash(req) }));
    });

    app.post(`/${mode}`, async (req, res) => {
      const phone = normalizePhone(req.body.phone);
      const name = String(req.body.name ?? '').trim().slice(0, 60);
      const again = (text) => res.status(422).send(views.start({ mode, csrf: req.session.csrf, nonce: token(), flash: { text }, phone: req.body.phone, name }));

      if (!phone) return again('Enter your number in international format, e.g. +57 300 123 4567.');
      if (mode === 'signup' && !name) return again('Enter your name.');
      if (mode === 'signup' && users.has(phone)) return again('This number already has an account. Sign in instead.');
      if (mode === 'login' && !users.has(phone)) return again('No account uses this number. Create one first.');

      try {
        const v = await verify.start({ to: phone, locale: req.acceptsLanguages(LOCALES) || undefined, ip: clientIp(req) }, idem(req, 'start'));
        req.session.pending = { id: v.id, phone, mode, name, resendAt: Date.now() + resendCooldown * 1000, resendBlocked: false };
        res.redirect('/verify');
      } catch (err) {
        again(userMessage(err, log));
      }
    });
  }

  app.get('/verify', (req, res) => {
    const p = req.session.pending;
    if (!p) return res.redirect('/login');
    res.send(views.verify({
      maskedPhone: maskPhone(p.phone), csrf: req.session.csrf, nonce: token(), flash: takeFlash(req),
      resendWait: (p.resendAt - Date.now()) / 1000, resendBlocked: p.resendBlocked,
    }));
  });

  app.post('/verify/check', async (req, res) => {
    const p = req.session.pending;
    if (!p) return res.redirect('/login');
    const code = String(req.body.code ?? '').trim();
    if (!/^[A-Za-z0-9]{4,10}$/.test(code)) { flash(req, 'Enter the code from the SMS.'); return res.redirect('/verify'); }

    try {
      const r = await verify.check(p.id, code, idem(req, `check-${p.id}`));
      if (r.result === 'approved') return signIn(req, res, p);
      if (r.result === 'invalid') {
        flash(req, `That code is not right. ${r.attempts_remaining} attempt(s) left.`);
        return res.redirect('/verify');
      }
      // expired or max_attempts: this verification is over, start again.
      delete req.session.pending;
      flash(req, r.result === 'expired' ? 'The code expired. Request a new one.' : 'Too many wrong codes. Request a new one.');
      res.redirect(`/${p.mode}`);
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'verification_closed' || err.status === 404)) {
        delete req.session.pending;
        flash(req, 'This code is no longer valid. Request a new one.');
        return res.redirect(`/${p.mode}`);
      }
      flash(req, userMessage(err, log));
      res.redirect('/verify');
    }
  });

  app.post('/verify/resend', async (req, res) => {
    const p = req.session.pending;
    if (!p) return res.redirect('/login');
    // Respect the cooldown locally too: no API call while the button should be disabled.
    if (p.resendBlocked || Date.now() < p.resendAt) return res.redirect('/verify');

    try {
      await verify.resend(p.id, idem(req, `resend-${p.id}`));
      p.resendAt = Date.now() + resendCooldown * 1000;
      flash(req, 'New code sent. The previous one no longer works.', true);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'resend_cooldown') {
        p.resendAt = Date.now() + (err.retryAfter ?? resendCooldown) * 1000; // the API knows the real cooldown
        flash(req, `Please wait ${err.retryAfter ?? resendCooldown} s before requesting another code.`);
      } else if (err instanceof ApiError && err.code === 'max_resends') {
        p.resendBlocked = true;
        flash(req, 'No more codes can be sent for this attempt. Enter the last code or use another number.');
      } else if (err instanceof ApiError && err.code === 'verification_closed') {
        delete req.session.pending;
        flash(req, 'This code is no longer valid. Request a new one.');
        return res.redirect(`/${p.mode}`);
      } else {
        if (err instanceof ApiError && err.retryAfter) p.resendAt = Date.now() + err.retryAfter * 1000;
        flash(req, userMessage(err, log));
      }
    }
    res.redirect('/verify');
  });

  app.post('/verify/cancel', async (req, res) => {
    const p = req.session.pending;
    delete req.session.pending;
    if (p) await verify.cancel(p.id, idemFor(`cancel:${p.id}`)).catch((err) => log.warn(`cancel ${p.id}: ${err.code}`));
    res.redirect(p ? `/${p.mode}` : '/login');
  });

  app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

  function signIn(req, res, p) {
    if (p.mode === 'signup' && !users.has(p.phone)) users.set(p.phone, { name: p.name });
    const user = users.get(p.phone);
    // New session id after login (prevents session fixation).
    req.session.regenerate((err) => {
      if (err) return res.status(500).send('Session error');
      req.session.user = { phone: p.phone, name: user?.name ?? p.phone };
      req.session.flash = { text: p.mode === 'signup' ? 'Your number is verified. Welcome!' : 'Signed in.', ok: true };
      res.redirect('/');
    });
  }

  return app;
}

// Turn an API error into a message for the end user. Details go to the server log (never the key).
export function userMessage(err, log = console) {
  if (!(err instanceof ApiError)) { log.error(err); return 'Something went wrong. Please try again.'; }
  log.warn(`verify api: ${err.status} ${err.code}`);
  if (err.status === 429) {
    return err.retryAfter ? `Too many requests. Please wait ${err.retryAfter} s and try again.` : 'Too many requests. Please try again later.';
  }
  if (err.status === 0) return 'The verification service is not reachable right now. Please try again later.';
  if (err.status === 401 || err.status === 402 || err.status >= 500) return 'Verification is temporarily unavailable. Please try again later.';
  if (err.param === 'to' || err.code === 'invalid_number') return err.message;
  if (['country_not_allowed', 'number_blocked', 'prefix_blocked', 'ip_blocked'].includes(err.code)) {
    return 'We cannot send a code to this number. Please use another one.';
  }
  return err.message;
}

function clientIp(req) {
  const ip = (req.ip || '').replace(/^::ffff:/, '');
  return ip || undefined;
}

function idemFor(text) { return createHash('sha256').update(text).digest('base64url'); }

function token() { return randomBytes(16).toString('hex'); }

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
