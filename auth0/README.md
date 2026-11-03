# Auth0: send Auth0's SMS codes through the Verify API

Auth0 can send its MFA, enrollment and blocked-account SMS through your account with a **custom phone provider**:
an Action you paste as is. Auth0 creates and checks the code; the Verify API delivers it with your Verify app's
sender ID, template, language and fraud protection. Each delivery appears on your Verify page tagged `auth0`.

```
Auth0 Action ──POST event.notification──▶ BASE_URL/v1/verify/connectors/auth0?app_id=app_…  ──SMS──▶ user
             ◀── 201 {id: "ver_…"} / 4xx {error: {code, message}} (the Action throws, Auth0 logs it)
```

## 1. Create a key with only the `verify` permission

1. In the portal: **Developers › API keys › Create key**.
2. Choose **limited access** and tick only **verify**.
3. Use a `live_…` key for real users. A `test_…` key answers the same way but sends nothing (good for a first try).

## 2. Set up the custom phone provider in Auth0

1. Auth0 Dashboard › **Branding › Phone Provider** › choose **Custom**.
2. In the Action editor, replace the code with [`custom-phone-provider.js`](custom-phone-provider.js) (also below).
3. Open **Secrets** (the key icon in the editor) and add:

   | Secret | Value |
   |---|---|
   | `API_KEY` | your key (`live_…`) |
   | `BASE_URL` | your platform URL, e.g. `https://app.ogave.co` |
   | `APP_ID` | optional: the Verify app id (`app_…`, portal › Verify). Without it the first active app is used. |

4. **Deploy**, choose the delivery methods (Text, and Voice if your account has the voice channel) and **Save**.
5. Use **Send test message** with a phone number you control. With a `live_` key you get the SMS; with a `test_` key
   the delivery appears on your Verify page but nothing is sent.
6. Make sure phone factors are on: **Security › Multi-factor Auth › Phone Message**, delivery via your custom provider.

## The Action

```js
/**
 * Auth0 Action: Custom Phone Provider (Branding > Phone Provider > Custom).
 * Auth0 makes and checks the one-time code; this Action asks the Verify API to deliver it by SMS
 * (or voice) with your Verify app's sender, template, language and fraud protection.
 *
 * Action secrets (never hard-code them):
 *   API_KEY   a key with only the "verify" permission (live_... sends real SMS, test_... sends nothing)
 *   BASE_URL  your platform URL, e.g. https://app.ogave.co
 *   APP_ID    optional Verify app id (app_...); default: your first active app
 */
const crypto = require('crypto');

exports.onExecuteCustomPhoneProvider = async (event, api) => {
  const { API_KEY, BASE_URL, APP_ID } = event.secrets;
  const url = new URL(BASE_URL.replace(/\/+$/, '') + '/v1/verify/connectors/auth0');
  if (APP_ID) url.searchParams.set('app_id', APP_ID);

  // Same recipient + code = same delivery: if Auth0 retries, the code is not sent twice.
  const n = event.notification;
  const idempotencyKey = crypto.createHash('sha256').update(`${n.recipient}:${n.code}`).digest('base64url');

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(n),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    // Throwing makes Auth0 log the failure (no retry loop here). 429 means a rate limit was hit.
    const body = await res.json().catch(() => ({}));
    const wait = res.headers.get('retry-after');
    throw new Error(body.error ? `${body.error.code}: ${body.error.message}${wait ? ` (retry after ${wait} s)` : ''}` : `HTTP ${res.status}`);
  }
};
```

What it does:

- Sends `event.notification` unchanged. The connector reads `recipient` (E.164), `code` (4–10 letters or digits),
  `delivery_method` (`text` or `voice`) and `locale` (first two letters, when a template exists in that language).
- Sends an `Idempotency-Key` made from the recipient and the code: if Auth0 runs the Action twice for the same code,
  the second call is answered from the first one and no second SMS is sent.
- Throws on any non-2xx answer, so Auth0 logs the failure (Monitoring › Logs). It never retries in a loop. A `429`
  means a rate limit was hit; the message includes the `Retry-After` seconds.

## Answers

| HTTP | Body | When |
|---|---|---|
| `201` | `{"id": "ver_…", "object": "verification", "status": "pending", "channel": "sms"}` | Code sent. |
| `422` | `{"error": {"code": "validation_failed", "param": "recipient", …}}` | `recipient` or `code` missing. |
| `422` | `{"error": {"code": "validation_failed", "param": "code", …}}` | The code is not 4–10 letters or digits. |
| `422` | `{"error": {"code": "invalid_number", "param": "to", …}}` | Not a valid phone number. |
| `422` | `{"error": {"code": "validation_failed", "param": "app_id", "message": "Unknown app_id."}}` | Wrong `APP_ID`. |
| `401` | `{"error": {"code": "invalid_api_key", …}}` | Missing or wrong key. |
| `403` | `{"error": {"code": "insufficient_scope", …}}` | The key does not have the `verify` permission (or `ip_not_allowed`: IP restriction on the key). |
| `402` / `403` / `429` | `{"error": {…}}` | Balance, blocked country or number, rate limits (`429` has `Retry-After`). |

## Older "Send Phone Message" Action

If your tenant still uses the **Send Phone Message** trigger (`event.message_options`), use
[`send-phone-message.js`](send-phone-message.js) with the same three secrets. The connector accepts that body too
(`message_type: "sms"` or `"voice"`). New setups should use the custom phone provider above.

## Test the Actions locally

[`test-actions.js`](test-actions.js) runs both Actions with a fake Auth0 event against your account. It only accepts a
`test_` key, so nothing is sent:

```bash
cd auth0
export BASE_URL=https://app.ogave.co
read -rs API_KEY && export API_KEY        # paste your test_ key, then Enter
# export APP_ID=app_xxx                   # optional
node test-actions.js                      # Node 18+
```

Expected output:

```
ok   custom phone provider: code delivered (201)
ok   custom phone provider: same notification again is replayed, not resent (Idempotency-Key)
ok   send phone message (legacy): code delivered (201)
ok   invalid number: the Action throws with the API error code
ok   wrong key: the Action throws invalid_api_key
```

Or with curl:

```bash
curl -s "$BASE_URL/v1/verify/connectors/auth0" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"recipient": "+573001234567", "code": "731904", "delivery_method": "text", "locale": "en"}'
```

## Notes

- Auth0 checks the code itself, so these verifications do not count in your Verify conversion figures or the
  approval-rate fraud detectors. Rate limits, the premium-number list and new-country protection still apply.
- The verification expires on our side after 5 minutes; Auth0 keeps its own expiry for the code.
