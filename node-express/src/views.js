// Minimal HTML pages (no front-end framework). Everything user-provided is escaped.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function layout(title, body, flash) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 26rem; margin: 3rem auto; padding: 0 1rem; color: #1a1a1a; }
  label { display: block; margin: .8rem 0 .3rem; } input { width: 100%; padding: .5rem; box-sizing: border-box; font-size: 1rem; }
  button { margin-top: 1rem; padding: .5rem 1rem; font-size: 1rem; } button[disabled] { opacity: .5; }
  .flash { padding: .6rem .8rem; border-radius: 4px; background: #fff4e5; border: 1px solid #f0b35b; }
  .ok { background: #e8f6ec; border-color: #6cbf84; } .row { display: flex; gap: .5rem; align-items: center; }
  a { color: #0b57d0; }
</style></head><body>
<h1>${esc(title)}</h1>
${flash ? `<p class="flash ${flash.ok ? 'ok' : ''}" role="status">${esc(flash.text)}</p>` : ''}
${body}
</body></html>`;
}

const hidden = (csrf, nonce) =>
  `<input type="hidden" name="_csrf" value="${esc(csrf)}"><input type="hidden" name="nonce" value="${esc(nonce)}">`;

export function home({ user, flash }) {
  return layout('Welcome', `<p>Signed in as <strong>${esc(user.name)}</strong> (${esc(user.maskedPhone)}).</p>
<form method="post" action="/logout"><input type="hidden" name="_csrf" value="${esc(user.csrf)}"><button>Sign out</button></form>`, flash);
}

export function start({ mode, csrf, nonce, flash, phone = '', name = '' }) {
  const signup = mode === 'signup';
  return layout(signup ? 'Create an account' : 'Sign in', `<form method="post" action="/${mode}">
${hidden(csrf, nonce)}
${signup ? `<label for="name">Your name</label><input id="name" name="name" maxlength="60" required value="${esc(name)}">` : ''}
<label for="phone">Mobile number (with country code)</label>
<input id="phone" name="phone" type="tel" autocomplete="tel" placeholder="+57 300 123 4567" required value="${esc(phone)}">
<button>Send code</button>
</form>
<p>${signup ? 'Already registered? <a href="/login">Sign in</a>' : 'New here? <a href="/signup">Create an account</a>'}</p>`, flash);
}

export function verify({ maskedPhone, csrf, nonce, flash, resendWait, resendBlocked }) {
  const wait = Math.max(0, Math.ceil(resendWait));
  return layout('Enter your code', `<p>We sent a code to <strong>${esc(maskedPhone)}</strong>.</p>
<form method="post" action="/verify/check">
${hidden(csrf, nonce)}
<label for="code">Code</label>
<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" required autofocus>
<button>Verify</button>
</form>
<form method="post" action="/verify/resend" class="row">
${hidden(csrf, nonce)}
<button id="resend" ${wait > 0 || resendBlocked ? 'disabled' : ''} data-wait="${resendBlocked ? -1 : wait}">Resend code</button>
<span id="resend-hint">${resendBlocked ? 'No more resends for this code.' : wait > 0 ? `Available in ${wait} s` : ''}</span>
</form>
<form method="post" action="/verify/cancel">${hidden(csrf, nonce)}<button>Use another number</button></form>
<script>
  // Cosmetic countdown only: the server enforces the cooldown and the API answers 429 with Retry-After.
  (function () {
    var b = document.getElementById('resend'), h = document.getElementById('resend-hint'), s = +b.dataset.wait;
    if (s <= 0) return;
    var t = setInterval(function () {
      s -= 1;
      if (s > 0) { h.textContent = 'Available in ' + s + ' s'; return; }
      clearInterval(t); b.disabled = false; h.textContent = '';
    }, 1000);
  })();
</script>`, flash);
}
