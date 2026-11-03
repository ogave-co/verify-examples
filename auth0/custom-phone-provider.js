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
