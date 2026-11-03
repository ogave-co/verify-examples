// Offline tests: the Express app against a stub of the Verify API. No network, no key needed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createVerifyClient, ApiError } from '../src/verify-client.js';
import { normalizePhone } from '../src/phone.js';
import { stubVerifyApi } from './stub-api.js';
import { listen, browser } from './helpers.js';

const KEY = 'test_stubkey';
const quiet = { warn() {}, error() {} };
let api, stub, app, users;

before(async () => {
  stub = stubVerifyApi({ cooldown: 30, maxResends: 2, maxAttempts: 3 });
  api = await listen(stub.handler);
  users = new Map();
  const verify = createVerifyClient({ baseUrl: api.url, apiKey: KEY });
  // resendCooldown 0: the button is enabled at once, so the API's 429 + Retry-After path is exercised.
  app = await listen(createApp({ verify, sessionSecret: 'x'.repeat(32), users, resendCooldown: 0, log: quiet }));
});
after(async () => { await app.close(); await api.close(); });

const startRequests = () => stub.state.requests.filter((r) => r.method === 'POST' && r.url === '/v1/verify');

test('phone validation accepts E.164 with separators and rejects the rest', () => {
  assert.equal(normalizePhone('+57 300 123-4567'), '+573001234567');
  assert.equal(normalizePhone('0057 (300) 1234567'), '+573001234567');
  assert.equal(normalizePhone('3001234567'), null);
  assert.equal(normalizePhone('+0123456789'), null);
  assert.equal(normalizePhone('+57abc'), null);
  assert.equal(normalizePhone(undefined), null);
});

test('client sends Bearer auth and Idempotency-Key, and exposes Retry-After on 429', async () => {
  const c = createVerifyClient({ baseUrl: api.url + '/', apiKey: KEY });
  const v = await c.start({ to: '+573001110000' }, 'idem-1');
  assert.match(v.id, /^ver_/);
  const req = stub.state.requests.at(-1);
  assert.equal(req.headers.authorization, `Bearer ${KEY}`);
  assert.equal(req.headers['idempotency-key'], 'idem-1');

  await assert.rejects(c.resend(v.id), (e) => e instanceof ApiError && e.status === 429 && e.code === 'resend_cooldown' && e.retryAfter > 0);
  await assert.rejects(c.start({ to: 'abc' }), (e) => e.code === 'invalid_number' && e.param === 'to');
  const bad = createVerifyClient({ baseUrl: api.url, apiKey: 'test_wrong' });
  await assert.rejects(bad.get(v.id), (e) => e.status === 401 && !String(e.message).includes('test_wrong'));
});

test('sign-up: invalid phone, wrong code, right code, then sign in again', async () => {
  const b = browser(app.url);
  await b.get('/signup');
  let r = await b.post('/signup', { name: 'Ana', phone: '300 123' });
  assert.equal(r.status, 422);
  assert.match(r.html, /international format/);

  r = await b.post('/signup', { name: 'Ana', phone: '+57 300 222 0001' });
  assert.match(r.html, /Enter your code/);
  assert.match(r.html, /\+57•+01/); // masked number
  assert.ok(!r.html.includes(KEY), 'the API key must never reach the browser');

  r = await b.post('/verify/check', { code: '000000' });
  assert.match(r.html, /not right\. 2 attempt\(s\) left/);
  r = await b.post('/verify/check', { code: '123456' });
  assert.match(r.html, /Signed in as <strong>Ana<\/strong>/);
  assert.ok(users.has('+573002220001'));

  r = await b.post('/logout');
  assert.match(r.html, /Sign in/);
  r = await b.post('/login', { phone: '+573002220001' });
  r = await b.post('/verify/check', { code: '123456' });
  assert.match(r.html, /Signed in as <strong>Ana/);
});

test('resend: 429 Retry-After disables the button and is never retried in a loop', async () => {
  const b = browser(app.url);
  await b.get('/signup');
  await b.post('/signup', { name: 'Bo', phone: '+573002220002' });
  const before = stub.state.requests.length;

  let r = await b.post('/verify/resend');
  assert.match(r.html, /Please wait (29|30) s/);
  assert.match(r.html, /<button id="resend" disabled data-wait="(29|30)"/);
  assert.equal(stub.state.requests.length, before + 1, 'exactly one API call');

  r = await b.post('/verify/resend'); // still cooling down: no API call at all
  assert.equal(stub.state.requests.length, before + 1);
  assert.match(r.html, /disabled/);
});

test('start: 429 shows the wait and does not retry', async () => {
  const b = browser(app.url);
  await b.get('/signup');
  const n = startRequests().length;
  const r = await b.post('/signup', { name: 'Cy', phone: '+15005550429' });
  assert.match(r.html, /Please wait 60 s/);
  assert.equal(startRequests().length, n + 1);
});

test('double submit of the same form starts only one verification (Idempotency-Key)', async () => {
  const b = browser(app.url);
  await b.get('/signup');
  const html = b.html;
  const form = { _csrf: html.match(/name="_csrf" value="([^"]+)"/)[1], nonce: html.match(/name="nonce" value="([^"]+)"/)[1], name: 'Di', phone: '+573002220003' };
  const created = stub.state.verifications.size;
  const post = () => b.post('/signup', form);
  await post();
  await b.post('/verify/cancel'); // back to the form, then submit the very same form again
  await post();
  const keys = startRequests().slice(-2).map((r) => r.headers['idempotency-key']);
  assert.equal(keys[0], keys[1]);
  assert.equal(stub.state.verifications.size, created + 1);
});

test('too many wrong codes ends the verification', async () => {
  const b = browser(app.url);
  await b.get('/signup');
  await b.post('/signup', { name: 'Ed', phone: '+573002220004' });
  await b.post('/verify/check', { code: '111111' });
  await b.post('/verify/check', { code: '222222' });
  const r = await b.post('/verify/check', { code: '333333' });
  assert.match(r.html, /Too many wrong codes/);
  assert.match(r.html, /Create an account/);
});

test('sign in with an unknown number and forms without CSRF token are refused', async () => {
  const b = browser(app.url);
  await b.get('/login');
  let r = await b.post('/login', { phone: '+573009999999' });
  assert.match(r.html, /No account uses this number/);
  r = await fetch(app.url + '/login', { method: 'POST', body: new URLSearchParams({ phone: '+573009999999' }) });
  assert.equal(r.status, 403);
});
