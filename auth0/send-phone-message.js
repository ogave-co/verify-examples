/**
 * Auth0 Action for the older "Send Phone Message" trigger (event.message_options).
 * Use custom-phone-provider.js for new setups. Same secrets: API_KEY, BASE_URL, APP_ID (optional).
 */
const crypto = require('crypto');

exports.onExecuteSendPhoneMessage = async (event, api) => {
  const { API_KEY, BASE_URL, APP_ID } = event.secrets;
  const url = new URL(BASE_URL.replace(/\/+$/, '') + '/v1/verify/connectors/auth0');
  if (APP_ID) url.searchParams.set('app_id', APP_ID);

  const m = event.message_options;
  const idempotencyKey = crypto.createHash('sha256').update(`${m.recipient}:${m.code}`).digest('base64url');

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ message_options: m }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ? `${body.error.code}: ${body.error.message}` : `HTTP ${res.status}`);
  }
};
