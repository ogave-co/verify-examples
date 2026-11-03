// Optional live smoke test against a real sandbox. Runs only when BASE_URL and API_KEY are set,
// and only with a test_ key (nothing is sent, the code is always 123456). The key is never printed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createVerifyClient, ApiError } from '../src/verify-client.js';
import { listen, browser, randomPhone } from './helpers.js';

const { BASE_URL, API_KEY } = process.env;
const skip = !BASE_URL || !API_KEY ? 'set BASE_URL and API_KEY to run the live smoke test'
  : !API_KEY.startsWith('test_') ? 'the live smoke test only runs with a test_ key' : false;

let client, app;
before(async () => {
  if (skip) return;
  client = createVerifyClient({ baseUrl: BASE_URL, apiKey: API_KEY });
  app = await listen(createApp({ verify: client, sessionSecret: 'live-smoke-'.repeat(3), resendCooldown: 0, log: { warn() {}, error() {} } }));
});
after(async () => { await app?.close(); });

test('API: start, wrong code, resend cooldown, right code, closed', { skip }, async () => {
  const v = await client.start({ to: randomPhone(), locale: 'en' }, `smoke-${Date.now()}`);
  assert.match(v.id, /^ver_/);
  assert.equal(v.status, 'pending');
  assert.equal(v.mode, 'test');

  const wrong = await client.check(v.id, '000000');
  assert.equal(wrong.result, 'invalid');
  assert.equal(typeof wrong.attempts_remaining, 'number');

  // Right after sending, the resend cooldown applies: 429 with Retry-After. We read it and do not retry.
  await assert.rejects(client.resend(v.id), (e) => e instanceof ApiError && e.status === 429 && e.code === 'resend_cooldown' && e.retryAfter > 0);

  const ok = await client.check(v.id, '123456');
  assert.equal(ok.result, 'approved');
  assert.equal((await client.get(v.id)).status, 'approved');
  await assert.rejects(client.check(v.id, '123456'), (e) => e.status === 409 && e.code === 'verification_closed');
});

test('API: cancel and validation errors', { skip }, async () => {
  const v = await client.start({ to: randomPhone() });
  assert.equal((await client.cancel(v.id, `cancel-${v.id}`)).status, 'canceled');
  await assert.rejects(client.start({ to: 'abc' }), (e) => e.status === 422 && e.param === 'to');
});

test('App: sign up through the Express pages against the sandbox', { skip }, async () => {
  const b = browser(app.url);
  await b.get('/signup');
  let r = await b.post('/signup', { name: 'Smoke', phone: randomPhone() });
  assert.match(r.html, /Enter your code/);
  assert.ok(!r.html.includes(API_KEY));
  r = await b.post('/verify/resend');
  assert.match(r.html, /Please wait \d+ s/);
  assert.match(r.html, /id="resend" disabled/);
  r = await b.post('/verify/check', { code: '123456' });
  assert.match(r.html, /Signed in as <strong>Smoke<\/strong>/);
});
