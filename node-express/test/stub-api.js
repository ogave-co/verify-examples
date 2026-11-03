// In-memory imitation of the Verify API (same shapes as the real one, test-key behaviour: code 123456).
export function stubVerifyApi({ cooldown = 30, maxResends = 2, maxAttempts = 3 } = {}) {
  const state = { verifications: new Map(), requests: [], seq: 0, idem: new Map() };

  function handler(req, res) {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      state.requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const send = (status, data, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(data)); };
      const error = (status, code, message, extra = {}, headers) => send(status, { error: { code, message, param: extra.param ?? null } }, headers);

      if (req.headers.authorization !== 'Bearer test_stubkey') return error(401, 'invalid_api_key', 'The API key is not valid.');
      const idemKey = req.method === 'POST' && req.headers['idempotency-key'];
      if (idemKey && !/^[\x21-\x7e]{1,64}$/.test(idemKey)) return error(422, 'invalid_idempotency_key', 'Idempotency-Key must be 1-64 visible ASCII characters.');
      if (idemKey && state.idem.has(idemKey)) return send(...state.idem.get(idemKey));
      const reply = (status, data, headers) => { if (idemKey) state.idem.set(idemKey, [status, data, headers]); send(status, data, headers); };

      const m = req.url.match(/^\/v1\/verify(?:\/(ver_\w+))?(?:\/(check|resend|cancel))?$/);
      if (!m) return error(404, 'not_found', 'Not found');
      const [, id, action] = m;
      const v = id && state.verifications.get(id);
      if (id && !v) return error(404, 'not_found', 'No such verification.');

      if (req.method === 'POST' && !id) {
        if (!/^\+[1-9]\d{7,14}$/.test(body.to ?? '')) return error(422, 'invalid_number', `'${body.to}' is not a valid phone number. Use E.164, e.g. +573001234567.`, { param: 'to' });
        if (body.to === '+15005550429') return error(429, 'velocity_number', 'Too many codes for this number.', {}, { 'retry-after': '60' });
        const nv = { id: `ver_stub${++state.seq}`, object: 'verification', mode: 'test', status: 'pending', to: body.to, attempts: 0, attempts_remaining: maxAttempts, resends: 0, lastSent: Date.now() };
        state.verifications.set(nv.id, nv);
        return reply(201, view(nv));
      }
      if (req.method === 'GET' && id && !action) return send(200, view(v));
      if (req.method !== 'POST') return error(405, 'method_not_allowed', 'Method not allowed');
      if (v.status !== 'pending') return error(409, 'verification_closed', `This verification is already ${v.status}. Start a new one.`);

      if (action === 'check') {
        v.attempts += 1; v.attempts_remaining -= 1;
        if (body.code === '123456') { v.status = 'approved'; return reply(200, { result: 'approved', ...view(v) }); }
        if (v.attempts_remaining <= 0) { v.status = 'max_attempts'; return reply(200, { result: 'max_attempts', ...view(v) }); }
        return reply(200, { result: 'invalid', ...view(v) });
      }
      if (action === 'resend') {
        const wait = Math.ceil((v.lastSent + cooldown * 1000 - Date.now()) / 1000);
        if (wait > 0) return error(429, 'resend_cooldown', `Wait ${wait} s before resending.`, {}, { 'retry-after': String(wait) });
        if (v.resends >= maxResends) return error(429, 'max_resends', 'No more resends.');
        v.resends += 1; v.lastSent = Date.now();
        return reply(200, view(v));
      }
      if (action === 'cancel') { v.status = 'canceled'; return reply(200, view(v)); }
    });
  }

  const view = ({ lastSent, ...v }) => ({ ...v });
  return { handler, state };
}
