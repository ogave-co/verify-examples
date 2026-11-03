# Node.js + Express: phone sign-up / sign-in with Verify

A small web app where users create an account and sign in with their mobile number and a one-time code.

- **Server-side only**: every Verify API call runs in Express. The browser gets our own HTML pages and a session
  cookie; the API key never reaches it.
- **Start / check / resend / cancel** with clear messages for every `result` and error.
- **Phone validation** before calling the API (E.164: `+` country code and number; spaces, dashes and a `00` prefix are accepted).
- **Rate-limit friendly**: the *Resend* button stays disabled for the cooldown; when the API answers `429` the wait comes
  from `Retry-After`, the page shows it and nothing is retried automatically.
- **Idempotency-Key** on every POST, derived from a per-form nonce: a double click or a re-submitted form does not send a second SMS.
- CSRF token on every form, `httpOnly` / `SameSite=Lax` session cookie, new session id after sign-in.

Requires Node.js 22.9 or newer (built-in `fetch`, `--env-file-if-exists`). Two dependencies: `express` and `express-session`.

## Run

```bash
cd node-express
npm install
cp .env.example .env        # then edit .env: BASE_URL, API_KEY, SESSION_SECRET
npm start                   # http://localhost:3000
```

| Variable | Required | Description |
|---|---|---|
| `BASE_URL` | yes | Your platform URL, e.g. `https://app.ogave.co`. The API is at `BASE_URL/v1`. |
| `API_KEY` | yes | `test_…` (nothing is sent, the code is always `123456`) or `live_…` (real SMS). |
| `SESSION_SECRET` | yes | Long random string (16+ characters) to sign the session cookie. |
| `PORT` | no | Default `3000`. |
| `RESEND_COOLDOWN` | no | Seconds before *Resend* is offered (default `30`; set it to your Verify app's cooldown). |
| `SECURE_COOKIES` / `TRUST_PROXY` | no | `true` when served over HTTPS / behind a reverse proxy. |

With a test key: sign up with any valid mobile number, e.g. `+57 300 123 4567`, and enter `123456`.

## How it works

| Page | API call |
|---|---|
| `POST /signup`, `POST /login` | `POST /v1/verify` `{to, locale, ip}` → `201 {id: "ver_…", status: "pending"}`. The id is kept in the session. |
| `POST /verify/check` | `POST /v1/verify/{id}/check` `{code}` → `result`: `approved` (signed in), `invalid` (shows `attempts_remaining`), `expired` / `max_attempts` (start again). `409 verification_closed` → start again. |
| `POST /verify/resend` | `POST /v1/verify/{id}/resend`. `429 resend_cooldown` → wait `Retry-After` s; `429 max_resends` → resend disabled. |
| `POST /verify/cancel` | `POST /v1/verify/{id}/cancel` ("Use another number"). |

Files: [`src/verify-client.js`](src/verify-client.js) (API client, ~60 lines), [`src/app.js`](src/app.js) (routes),
[`src/views.js`](src/views.js) (HTML), [`src/phone.js`](src/phone.js), [`server.js`](server.js) (configuration).

For production: keep users in your database instead of the in-memory `Map`, use a shared session store (Redis,
database) instead of `MemoryStore`, serve over HTTPS with `SECURE_COOKIES=true`, and optionally pass a stable
`device_id` to `start()` for per-device fraud limits.

## Tests

```bash
npm test
```

- `test/app.test.js` always runs, offline: the app against an in-memory stub of the Verify API
  (`test/stub-api.js`). It covers phone validation, the full sign-up and sign-in flow, wrong codes, too many attempts,
  `429` + `Retry-After` on resend and on start (and that nothing is retried), double submits with the same
  Idempotency-Key, CSRF, and that the key never appears in a page.
- `test/live.test.js` runs only when `BASE_URL` and `API_KEY` are set, and only with a **test** key (nothing is sent).
  It calls your sandbox directly (start, wrong code, resend cooldown, `123456`, closed verification, cancel,
  invalid number) and walks the sign-up pages against it.

```bash
BASE_URL=https://app.ogave.co API_KEY=test_xxx npm test     # offline + live
npm run test:live                                         # live only, reads .env
```

To keep the key out of your shell history, put it in `.env` (git-ignored) or use `read -rs API_KEY && export API_KEY`.
