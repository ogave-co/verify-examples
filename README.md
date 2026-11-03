# Verify API examples

Working examples for the **Verify (OTP) API**: send a one-time code to a phone number and check it, with resend
cooldowns, rate limits and fraud protection handled by the API.

| Folder | What it shows |
|---|---|
| [`node-express/`](node-express) | Phone sign-up / sign-in in Node.js 22 + Express, server-side calls only, tests with `npm test`. |
| [`php/`](php) | The same flow in plain PHP 8.1+ (sessions + curl), smoke test with `php tests/smoke.php`. |
| [`okta/`](okta) | Send Okta's SMS / voice codes through your account with a Telephony Inline Hook (no code). |
| [`auth0/`](auth0) | Send Auth0's MFA codes through your account with a custom phone provider Action. |

All examples read the platform URL from `BASE_URL` (for example `https://app.ogave.co`); the API is at
`BASE_URL + "/v1"`.

## Get an API key

1. Sign in to the portal and open **Developers › API keys**.
2. Create a key. For these examples a key with only the **verify** permission is enough (and safer).
3. Copy it once and keep it in an environment variable or a git-ignored `.env` file. Never commit it, never send it to a
   browser or mobile app: call the API from your server.

### Test keys and live keys

| Key | What happens |
|---|---|
| `test_…` | Nothing is sent and nothing is charged. The code is always `123456` (the first *n* digits of `1234567890` for longer codes). Responses have `"mode": "test"`. Use it for development and CI. |
| `live_…` | Real SMS (or WhatsApp / voice) to real phones, charged to your balance. |

For app-store reviewers and QA on live keys, add `test_numbers` to your Verify app: those numbers get your fixed
code, never receive an SMS and are never charged.

## The API in one screen

All requests use `Authorization: Bearer <key>` and JSON.

| Call | Body | Answer |
|---|---|---|
| `POST /v1/verify` | `{"to": "+573001234567", "locale": "en", "app_id": "app_…", "device_id": "…", "ip": "203.0.113.7"}` (only `to` is required) | `201 {"id": "ver_…", "status": "pending", "expires_at", "attempts_remaining", …}` |
| `POST /v1/verify/{id}/check` | `{"code": "123456"}` | `200 {"result": "approved" \| "invalid" \| "expired" \| "max_attempts", "attempts_remaining", …}` |
| `POST /v1/verify/{id}/resend` | – | `200` with a **new** code (the previous one stops working) |
| `POST /v1/verify/{id}/cancel` | – | `200 {"status": "canceled"}` |
| `GET /v1/verify/{id}` | – | The verification |

Errors are JSON with an HTTP 4xx status:

```json
{"error": {"code": "invalid_number", "message": "'abc' is not a valid phone number. Use E.164, e.g. +573001234567.", "param": "to"}}
```

Common codes: `invalid_number`, `validation_failed`, `verification_closed` (409, checking a closed verification),
`resend_cooldown` and `max_resends` (429), `velocity_number` / `velocity_ip` / `velocity_device` (429, fraud limits),
`country_not_allowed`, `prefix_blocked`, `insufficient_balance` (402), `invalid_api_key` (401), `insufficient_scope` (403).

### Rate-limit friendly

Every `429` has a `Retry-After` header (seconds). The examples:

- show the wait to the user and keep the *Resend* button disabled until it is over;
- never retry automatically, and never in a loop (each retry of a start could send another SMS and counts against
  the fraud limits).

### Idempotency

Send an `Idempotency-Key` header (up to 64 characters) on POSTs. The same key with the same body within 24 hours returns
the first answer (`Idempotent-Replayed: true`) and never sends twice. The examples derive it from a random value
rendered into each form, so a double click or a re-submitted form does not send a second SMS.

## Run the tests

```bash
cd node-express && npm install && npm test        # offline; live smoke too when BASE_URL and API_KEY are set
cd php && php tests/smoke.php                     # offline; live smoke too when BASE_URL and API_KEY are set
cd auth0 && node test-actions.js                  # needs BASE_URL and a test_ API_KEY
```

The live parts only run with a `test_` key, so they never send an SMS. See each folder's README.

## License

[MIT](LICENSE)
