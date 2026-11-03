# PHP: phone sign-up / sign-in with Verify

The same flow as the Node example in plain PHP 8.1+ (sessions + curl, no framework, no Composer):
sign up or sign in with a mobile number and a one-time code.

- **Server-side only**: the API key stays in PHP; the browser sees our pages and a session cookie.
- **Start / check / resend / cancel**, phone validation (E.164), clear messages for every `result` and error.
- **Rate-limit friendly**: *Resend* is disabled for the cooldown; a `429` shows the `Retry-After` wait and is never retried in a loop.
- **Idempotency-Key** on every POST (hash of the action and a per-form nonce): a double submit does not send twice.
- CSRF token, `httpOnly` / `SameSite=Lax` cookie, `session_regenerate_id()` after sign-in.

```
php/
  public/index.php   the app (the only web-visible folder)
  verify.php         Verify API client + phone helpers + .env loader
  .env.example       configuration (copy to .env, outside public/)
  tests/smoke.php    smoke test (offline stub + optional live sandbox)
  tests/stub_api.php stub of the Verify API used by the offline test
```

## Run

```bash
cd php
cp .env.example .env        # then edit BASE_URL and API_KEY
php -S localhost:8000 -t public
```

Open http://localhost:8000. With a `test_` key nothing is sent and the code is always `123456`.

`-t public` matters: only `public/` is served, so `.env`, `verify.php` and `data/` (where the demo stores users)
cannot be downloaded. Instead of `.env` you can set real environment variables (`BASE_URL=… API_KEY=… php -S …`);
they win over the file.

| Variable | Required | Description |
|---|---|---|
| `BASE_URL` | yes | Your platform URL, e.g. `https://app.ogave.co`. The API is at `BASE_URL/v1`. |
| `API_KEY` | yes | `test_…` (nothing sent, code `123456`) or `live_…` (real SMS). |
| `RESEND_COOLDOWN` | no | Seconds before *Resend* is offered (default `30`). |
| `SECURE_COOKIES` | no | `true` over HTTPS. |
| `USERS_FILE` | no | Demo user storage (default `data/users.json`). Use your database in production. |

Requires the `curl` and `mbstring` extensions.

## Tests

```bash
php tests/smoke.php
```

1. **Offline** (always): starts the app and a stub API with `php -S` on free local ports and walks the whole flow:
   invalid number, sign-up, wrong code, resend `429` with `Retry-After` (button disabled), right code, sign-in again,
   `429` on start, no automatic retries, Idempotency-Key length, CSRF.
2. **Live** (only when `BASE_URL` and `API_KEY` are set, and only with a `test_` key): the client against your sandbox
   (start, wrong code, resend cooldown, `123456`, `409 verification_closed`, cancel, invalid number) and the same page
   flow through the app.

```bash
BASE_URL=https://app.ogave.co API_KEY=test_xxx php tests/smoke.php
```

The script exits with `0` when every check passes. The key is never printed.
