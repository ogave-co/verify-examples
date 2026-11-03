<?php
// Sign up / sign in with a phone number and a one-time code (Verify API), in plain PHP.
// Run: php -S localhost:8000 -t public   (only this folder is web-visible; .env and data/ stay private)
declare(strict_types=1);

require __DIR__ . '/../verify.php';
load_env(__DIR__ . '/../.env');

$env = fn (string $k, string $d = '') => in_array($v = getenv($k), [false, ''], true) ? $d : (string) $v;
$resendCooldown = max(0, (int) $env('RESEND_COOLDOWN', '30')); // match your Verify app's resend cooldown
$usersFile = $env('USERS_FILE', __DIR__ . '/../data/users.json'); // demo storage: use your database

session_name('sid');
session_set_cookie_params(['httponly' => true, 'samesite' => 'Lax', 'secure' => $env('SECURE_COOKIES') === 'true']);
session_start();
$_SESSION['csrf'] ??= bin2hex(random_bytes(16));

try {
    $verify = new VerifyClient($env('BASE_URL'), $env('API_KEY'));
} catch (InvalidArgumentException $e) {
    http_response_code(500);
    exit('Missing configuration: ' . htmlspecialchars($e->getMessage()) . '. Copy .env.example to .env and fill it in.');
}

// ---------- helpers ----------
function e(mixed $s): string { return htmlspecialchars((string) $s, ENT_QUOTES); }
function go(string $to): never { header('Location: ' . $to, true, 303); exit; }
function flash(string $text, bool $ok = false): void { $_SESSION['flash'] = ['text' => $text, 'ok' => $ok]; }
function users(string $file): array { return is_file($file) ? (json_decode((string) file_get_contents($file), true) ?: []) : []; }
function save_user(string $file, string $phone, string $name): void
{
    if (!is_dir(dirname($file))) mkdir(dirname($file), 0700, true);
    $all = users($file);
    $all[$phone] ??= ['name' => $name];
    file_put_contents($file, json_encode($all, JSON_PRETTY_PRINT), LOCK_EX);
}
/** One random nonce per rendered form, hashed into the Idempotency-Key: a double submit is not sent twice. */
function idem(string $action): string
{
    $nonce = is_string($_POST['nonce'] ?? null) && preg_match('/^[a-f0-9]{32}$/', $_POST['nonce']) ? $_POST['nonce'] : bin2hex(random_bytes(16));
    return hash('sha256', "$action:$nonce"); // 64 characters, the API's maximum
}
/** API error -> message for the end user. Details go to the server log (never the key). */
function user_message(VerifyApiError $err): string
{
    error_log("verify api: {$err->status} {$err->errorCode}");
    return match (true) {
        $err->status === 429 => $err->retryAfter ? "Too many requests. Please wait {$err->retryAfter} s and try again." : 'Too many requests. Please try again later.',
        $err->status === 0 => 'The verification service is not reachable right now. Please try again later.',
        in_array($err->status, [401, 402], true) || $err->status >= 500 => 'Verification is temporarily unavailable. Please try again later.',
        in_array($err->errorCode, ['country_not_allowed', 'number_blocked', 'prefix_blocked', 'ip_blocked'], true) => 'We cannot send a code to this number. Please use another one.',
        default => $err->getMessage(),
    };
}
function locale(): ?string
{
    $lang = strtolower(substr((string) ($_SERVER['HTTP_ACCEPT_LANGUAGE'] ?? ''), 0, 2));
    return in_array($lang, ['en', 'es', 'pt', 'fr', 'de', 'it'], true) ? $lang : null;
}

// ---------- actions (POST) ----------
$p = &$_SESSION['pending']; // the verification in progress, if any
$formError = null;
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    if (!is_string($_POST['_csrf'] ?? null) || !hash_equals($_SESSION['csrf'], $_POST['_csrf'])) {
        http_response_code(403);
        exit('Invalid form token. Reload the page.');
    }
    $action = (string) ($_POST['action'] ?? '');

    if ($action === 'signup' || $action === 'login') {
        $phone = normalize_phone($_POST['phone'] ?? null);
        $name = mb_substr(trim((string) ($_POST['name'] ?? '')), 0, 60);
        $known = $phone !== null && isset(users($usersFile)[$phone]);
        $formError = match (true) {
            $phone === null => 'Enter your number in international format, e.g. +57 300 123 4567.',
            $action === 'signup' && $name === '' => 'Enter your name.',
            $action === 'signup' && $known => 'This number already has an account. Sign in instead.',
            $action === 'login' && !$known => 'No account uses this number. Create one first.',
            default => null,
        };
        if ($formError === null) {
            try {
                $v = $verify->start($phone, ['locale' => locale(), 'ip' => $_SERVER['REMOTE_ADDR'] ?? null], idem('start'));
                $p = ['id' => $v['id'], 'phone' => $phone, 'mode' => $action, 'name' => $name, 'resend_at' => time() + $resendCooldown, 'resend_blocked' => false];
                go('/');
            } catch (VerifyApiError $err) {
                $formError = user_message($err);
            }
        }
        http_response_code(422);
        $_GET['page'] = $action;
    } elseif ($action === 'check' && $p) {
        $code = trim((string) ($_POST['code'] ?? ''));
        if (!preg_match('/^[A-Za-z0-9]{4,10}$/', $code)) { flash('Enter the code from the SMS.'); go('/'); }
        try {
            $r = $verify->check($p['id'], $code, idem("check:{$p['id']}"));
            if ($r['result'] === 'approved') {
                if ($p['mode'] === 'signup') save_user($usersFile, $p['phone'], $p['name']);
                $name = users($usersFile)[$p['phone']]['name'] ?? $p['phone'];
                [$mode, $phone] = [$p['mode'], $p['phone']];
                $p = null;
                session_regenerate_id(true); // new session id after login (prevents session fixation)
                $_SESSION['user'] = ['phone' => $phone, 'name' => $name];
                flash($mode === 'signup' ? 'Your number is verified. Welcome!' : 'Signed in.', true);
                go('/');
            }
            if ($r['result'] === 'invalid') { flash("That code is not right. {$r['attempts_remaining']} attempt(s) left."); go('/'); }
            $mode = $p['mode'];
            $p = null; // expired or max_attempts: start again
            flash($r['result'] === 'expired' ? 'The code expired. Request a new one.' : 'Too many wrong codes. Request a new one.');
            go("/?page=$mode");
        } catch (VerifyApiError $err) {
            if ($err->errorCode === 'verification_closed' || $err->status === 404) {
                $mode = $p['mode'];
                $p = null;
                flash('This code is no longer valid. Request a new one.');
                go("/?page=$mode");
            }
            flash(user_message($err));
            go('/');
        }
    } elseif ($action === 'resend' && $p) {
        // Respect the cooldown locally too: no API call while the button should be disabled.
        if ($p['resend_blocked'] || time() < $p['resend_at']) go('/');
        try {
            $verify->resend($p['id'], idem("resend:{$p['id']}"));
            $p['resend_at'] = time() + $resendCooldown;
            flash('New code sent. The previous one no longer works.', true);
        } catch (VerifyApiError $err) {
            if ($err->errorCode === 'resend_cooldown') {
                $wait = $err->retryAfter ?? $resendCooldown; // the API knows the real cooldown
                $p['resend_at'] = time() + $wait;
                flash("Please wait $wait s before requesting another code.");
            } elseif ($err->errorCode === 'max_resends') {
                $p['resend_blocked'] = true;
                flash('No more codes can be sent for this attempt. Enter the last code or use another number.');
            } elseif ($err->errorCode === 'verification_closed') {
                $mode = $p['mode'];
                $p = null;
                flash('This code is no longer valid. Request a new one.');
                go("/?page=$mode");
            } else {
                if ($err->retryAfter) $p['resend_at'] = time() + $err->retryAfter;
                flash(user_message($err));
            }
        }
        go('/');
    } elseif ($action === 'cancel' && $p) {
        $mode = $p['mode'];
        try { $verify->cancel($p['id'], hash('sha256', "cancel:{$p['id']}")); } catch (VerifyApiError $err) { error_log("cancel: {$err->errorCode}"); }
        $p = null;
        go("/?page=$mode");
    } elseif ($action === 'logout') {
        session_destroy();
        go('/?page=login');
    }
    if ($formError === null) go('/');
}

// ---------- pages (GET) ----------
$flash = $_SESSION['flash'] ?? null;
unset($_SESSION['flash']);
if ($formError !== null) $flash = ['text' => $formError, 'ok' => false];
$csrf = $_SESSION['csrf'];
$nonce = bin2hex(random_bytes(16));
$hidden = '<input type="hidden" name="_csrf" value="' . e($csrf) . '"><input type="hidden" name="nonce" value="' . e($nonce) . '">';
$user = $_SESSION['user'] ?? null;
$page = $user ? 'home' : ($p ? 'verify' : (($_GET['page'] ?? '') === 'signup' ? 'signup' : 'login'));
$title = ['home' => 'Welcome', 'verify' => 'Enter your code', 'signup' => 'Create an account', 'login' => 'Sign in'][$page];
$wait = $p ? max(0, $p['resend_at'] - time()) : 0;
?>
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title><?= e($title) ?></title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 26rem; margin: 3rem auto; padding: 0 1rem; color: #1a1a1a; }
  label { display: block; margin: .8rem 0 .3rem; } input { width: 100%; padding: .5rem; box-sizing: border-box; font-size: 1rem; }
  button { margin-top: 1rem; padding: .5rem 1rem; font-size: 1rem; } button[disabled] { opacity: .5; }
  .flash { padding: .6rem .8rem; border-radius: 4px; background: #fff4e5; border: 1px solid #f0b35b; }
  .ok { background: #e8f6ec; border-color: #6cbf84; } .row { display: flex; gap: .5rem; align-items: center; }
</style></head><body>
<h1><?= e($title) ?></h1>
<?php if ($flash): ?><p class="flash <?= $flash['ok'] ? 'ok' : '' ?>" role="status"><?= e($flash['text']) ?></p><?php endif ?>

<?php if ($page === 'home'): ?>
  <p>Signed in as <strong><?= e($user['name']) ?></strong> (<?= e(mask_phone($user['phone'])) ?>).</p>
  <form method="post"><?= $hidden ?><button name="action" value="logout">Sign out</button></form>

<?php elseif ($page === 'verify'): ?>
  <p>We sent a code to <strong><?= e(mask_phone($p['phone'])) ?></strong>.</p>
  <form method="post"><?= $hidden ?>
    <label for="code">Code</label>
    <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" required autofocus>
    <button name="action" value="check">Verify</button>
  </form>
  <form method="post" class="row"><?= $hidden ?>
    <button id="resend" name="action" value="resend" <?= $wait > 0 || $p['resend_blocked'] ? 'disabled' : '' ?> data-wait="<?= $p['resend_blocked'] ? -1 : $wait ?>">Resend code</button>
    <span id="resend-hint"><?= $p['resend_blocked'] ? 'No more resends for this code.' : ($wait > 0 ? "Available in $wait s" : '') ?></span>
  </form>
  <form method="post"><?= $hidden ?><button name="action" value="cancel">Use another number</button></form>
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
  </script>

<?php else: $signup = $page === 'signup'; ?>
  <form method="post"><?= $hidden ?>
    <?php if ($signup): ?><label for="name">Your name</label><input id="name" name="name" maxlength="60" required value="<?= e($_POST['name'] ?? '') ?>"><?php endif ?>
    <label for="phone">Mobile number (with country code)</label>
    <input id="phone" name="phone" type="tel" autocomplete="tel" placeholder="+57 300 123 4567" required value="<?= e($_POST['phone'] ?? '') ?>">
    <button name="action" value="<?= $signup ? 'signup' : 'login' ?>">Send code</button>
  </form>
  <p><?= $signup ? 'Already registered? <a href="/?page=login">Sign in</a>' : 'New here? <a href="/?page=signup">Create an account</a>' ?></p>
<?php endif ?>
</body></html>
