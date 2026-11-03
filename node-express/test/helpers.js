// Test helpers: a tiny "browser" (cookie jar + form fields) and a server starter.
export async function listen(handler) {
  const { createServer } = await import('node:http');
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, 'localhost', resolve));
  return { url: `http://localhost:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

export function browser(baseUrl) {
  let cookie = '';
  let last = '';
  async function go(method, path, form) {
    const res = await fetch(baseUrl + path, {
      method,
      redirect: 'manual',
      headers: { ...(cookie && { cookie }), ...(form && { 'content-type': 'application/x-www-form-urlencoded' }), 'accept-language': 'en' },
      body: form ? new URLSearchParams(form) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    if (res.status === 302 || res.status === 303) return go('GET', res.headers.get('location'));
    last = await res.text();
    return { status: res.status, html: last };
  }
  const field = (name) => last.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1] ?? '';
  return {
    get: (path) => go('GET', path),
    // Submits a form of the last page: adds its CSRF token and nonce.
    post: (path, data = {}) => go('POST', path, { _csrf: field('_csrf'), nonce: field('nonce'), ...data }),
    get html() { return last; },
  };
}

// Random Colombian-style mobile number, so repeated runs do not hit per-number limits.
export const randomPhone = () => '+57300' + String(Math.floor(Math.random() * 1e7)).padStart(7, '0');
