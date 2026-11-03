// Small client for the Verify (OTP) API. Server-side only: the API key never leaves this process.

export class ApiError extends Error {
  constructor(status, code, message, { param = null, retryAfter = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;          // HTTP status (0 = network error / timeout)
    this.code = code;              // e.g. invalid_number, resend_cooldown, verification_closed
    this.param = param;            // request field that caused the error, if any
    this.retryAfter = retryAfter;  // seconds, from the Retry-After header (429)
  }
}

export function createVerifyClient({ baseUrl, apiKey, timeoutMs = 10000 }) {
  if (!baseUrl) throw new Error('BASE_URL is not set');
  if (!apiKey) throw new Error('API_KEY is not set');
  const api = baseUrl.replace(/\/+$/, '') + '/v1';

  async function request(method, path, body, idempotencyKey) {
    const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    let res;
    try {
      res = await fetch(api + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Never include the request (and its Authorization header) in the error.
      throw new ApiError(0, 'network_error', `Could not reach the Verify API (${err.name}).`);
    }

    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;

    const e = data.error || {};
    const retry = parseInt(res.headers.get('retry-after') ?? '', 10);
    throw new ApiError(res.status, e.code || `http_${res.status}`, e.message || `HTTP ${res.status}`, {
      param: e.param ?? null,
      retryAfter: Number.isFinite(retry) && retry >= 0 ? retry : null,
    });
  }

  const id = (v) => encodeURIComponent(v);
  return {
    // POST /v1/verify -> 201 { id: "ver_...", status: "pending", expires_at, attempts_remaining, ... }
    start: ({ to, locale, appId, deviceId, ip }, idem) =>
      request('POST', '/verify', clean({ to, locale, app_id: appId, device_id: deviceId, ip }), idem),
    // POST /v1/verify/{id}/check -> 200 { result: approved | invalid | expired | max_attempts, ... }
    check: (verificationId, code, idem) => request('POST', `/verify/${id(verificationId)}/check`, { code }, idem),
    // POST /v1/verify/{id}/resend -> 200, or 429 resend_cooldown (Retry-After) / 429 max_resends
    resend: (verificationId, idem) => request('POST', `/verify/${id(verificationId)}/resend`, {}, idem),
    cancel: (verificationId, idem) => request('POST', `/verify/${id(verificationId)}/cancel`, {}, idem),
    get: (verificationId) => request('GET', `/verify/${id(verificationId)}`),
  };
}

function clean(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}
