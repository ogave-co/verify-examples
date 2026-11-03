<?php
// Smoke test: php tests/smoke.php
//  1. Offline, always: runs the app (php -S) against a stub API (php -S tests/stub_api.php) and walks the whole flow.
//  2. Live, only when BASE_URL and API_KEY (a test_ key) are set: the client and the app against your sandbox.
// The API key is never printed.
declare(strict_types=1);

require __DIR__ . '/../verify.php';

$failures = 0;
function check(bool $ok, string $label): void
{
    global $failures;
    echo ($ok ? 'ok      ' : 'FAIL    ') . $label . PHP_EOL;
    if (!$ok) $failures++;
}

/** Start `php -S` on a free port with the given environment; returns [url, process]. */
function serve(array $args, array $env): array
{
    $port = random_int(20000, 45000);
    $cmd = array_merge([PHP_BINARY, '-S', "localhost:$port"], $args);
    $proc = proc_open($cmd, [0 => ['pipe', 'r'], 1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes, dirname(__DIR__), $env + ['PATH' => getenv('PATH')]);
    for ($i = 0; $i < 50; $i++) {
        if (@fsockopen('localhost', $port)) return ["http://localhost:$port", $proc];
        usleep(100_000);
    }
    throw new RuntimeException('php -S did not start');
}

/** A tiny browser: keeps the session cookie, follows redirects, re-sends the last page's CSRF token and nonce. */
final class Browser
{
    public string $html = '';
    private string $cookie = '';
    public function __construct(private readonly string $base) {}
    public function get(string $path): string { return $this->go('GET', $path); }
    public function post(array $data): string
    {
        $field = fn (string $n) => preg_match('/name="' . $n . '" value="([^"]*)"/', $this->html, $m) ? $m[1] : '';
        return $this->go('POST', '/', ['_csrf' => $field('_csrf'), 'nonce' => $field('nonce')] + $data);
    }
    private function go(string $method, string $path, ?array $form = null): string
    {
        $ch = curl_init($this->base . $path);
        $headers = ['Accept-Language: en'];
        if ($this->cookie !== '') $headers[] = 'Cookie: ' . $this->cookie;
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_HEADER => true, CURLOPT_HTTPHEADER => $headers, CURLOPT_CUSTOMREQUEST => $method]);
        if ($form !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query($form));
        $raw = (string) curl_exec($ch);
        $size = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
        curl_close($ch);
        $head = substr($raw, 0, $size);
        if (preg_match('/^Set-Cookie:\s*(sid=[^;]+)/mi', $head, $m)) $this->cookie = $m[1];
        if (preg_match('/^Location:\s*(\S+)/mi', $head, $m)) return $this->go('GET', $m[1]);
        return $this->html = substr($raw, $size);
    }
}

$randomPhone = fn () => '+57300' . str_pad((string) random_int(0, 9_999_999), 7, '0', STR_PAD_LEFT);

/** The full sign-up flow through the pages. $resendWaitExpected: the API answers the first resend with 429. */
function app_flow(string $appUrl, string $phone, string $label, ?string $secret = null): void
{
    $b = new Browser($appUrl);
    $b->get('/?page=signup');
    check(str_contains($b->post(['action' => 'signup', 'name' => 'Ana', 'phone' => '300 123']), 'international format'), "$label: rejects a number without country code");
    $html = $b->post(['action' => 'signup', 'name' => 'Ana', 'phone' => $phone]);
    check(str_contains($html, 'Enter your code'), "$label: sign-up sends a code");
    check($secret === null || !str_contains($html, $secret), "$label: the API key never reaches the browser");
    check(str_contains($b->post(['action' => 'check', 'code' => '000000']), 'attempt(s) left'), "$label: wrong code shows attempts left");
    $html = $b->post(['action' => 'resend']);
    check((bool) preg_match('/Please wait \d+ s/', $html) && str_contains($html, 'id="resend" name="action" value="resend" disabled'), "$label: resend 429 shows the wait and disables the button");
    check(str_contains($b->post(['action' => 'check', 'code' => '123456']), 'Signed in as <strong>Ana</strong>'), "$label: right code signs in");
    $b->post(['action' => 'logout']);
    $b->post(['action' => 'login', 'phone' => $phone]);
    check(str_contains($b->post(['action' => 'check', 'code' => '123456']), 'Signed in as <strong>Ana'), "$label: sign in again with the same number");
}

$tmp = sys_get_temp_dir() . '/verify-smoke-' . bin2hex(random_bytes(4));
mkdir($tmp, 0700);
$procs = [];

// ---------- 1. offline ----------
echo "# offline (stub API)\n";
[$stubUrl, $procs[]] = serve(['tests/stub_api.php'], ['STUB_STATE' => "$tmp/stub.json"]);
$appEnv = ['BASE_URL' => $stubUrl, 'API_KEY' => 'test_stubkey', 'RESEND_COOLDOWN' => '0', 'USERS_FILE' => "$tmp/users-offline.json"];
[$appUrl, $procs[]] = serve(['-t', 'public'], $appEnv);

check(normalize_phone('+57 300 123-4567') === '+573001234567' && normalize_phone('3001234567') === null, 'phone validation');
$c = new VerifyClient($stubUrl, 'test_stubkey');
$v = $c->start('+573001110000', [], 'idem-1');
try { $c->resend($v['id']); check(false, 'client: resend during cooldown fails'); }
catch (VerifyApiError $e) { check($e->status === 429 && $e->errorCode === 'resend_cooldown' && $e->retryAfter > 0, 'client: 429 resend_cooldown with Retry-After'); }
check($c->start('+573001110000', [], 'idem-1')['id'] === $v['id'], 'client: same Idempotency-Key replays the first response');
try { (new VerifyClient($stubUrl, 'test_wrong'))->get($v['id']); } catch (VerifyApiError $e) { check($e->status === 401 && !str_contains($e->getMessage(), 'test_wrong'), 'client: 401 without leaking the key'); }

app_flow($appUrl, '+573002220001', 'offline', 'test_stubkey');
$b = new Browser($appUrl);
$b->get('/?page=signup');
check(str_contains($b->post(['action' => 'signup', 'name' => 'Cy', 'phone' => '+15005550429']), 'Please wait 60 s'), 'offline: 429 on start shows the wait');
$log = json_decode((string) file_get_contents("$tmp/stub.json"), true)['log'];
check(count(array_filter($log, fn ($r) => $r['path'] === '/v1/verify' && $r['method'] === 'POST')) === 4, 'offline: no automatic retries (exactly 4 starts sent)');
check(count(array_filter($log, fn ($r) => $r['idem'] !== null && strlen($r['idem']) > 64)) === 0, 'offline: Idempotency-Key always <= 64 characters');
$ch = curl_init("$appUrl/");
curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_POSTFIELDS => 'action=login&phone=%2B573001234567']);
curl_exec($ch);
check(curl_getinfo($ch, CURLINFO_RESPONSE_CODE) === 403, 'offline: POST without CSRF token is refused');

// ---------- 2. live ----------
$base = (string) getenv('BASE_URL');
$key = (string) getenv('API_KEY');
if ($base === '' || $key === '') {
    echo "# live: SKIPPED (set BASE_URL and API_KEY to run it)\n";
} elseif (!str_starts_with($key, 'test_')) {
    echo "# live: SKIPPED (only runs with a test_ key)\n";
} else {
    echo "# live (" . preg_replace('#^(https?://[^/]+).*#', '$1', $base) . ", test key)\n";
    $c = new VerifyClient($base, $key);
    $v = $c->start($randomPhone(), ['locale' => 'en'], hash('sha256', random_bytes(16)));
    check(str_starts_with($v['id'], 'ver_') && $v['status'] === 'pending' && $v['mode'] === 'test', 'live client: start -> pending test verification');
    check($c->check($v['id'], '000000')['result'] === 'invalid', 'live client: wrong code -> invalid');
    try { $c->resend($v['id']); check(false, 'live client: resend during cooldown'); }
    catch (VerifyApiError $e) { check($e->status === 429 && $e->errorCode === 'resend_cooldown' && $e->retryAfter > 0, "live client: resend -> 429 resend_cooldown, Retry-After {$e->retryAfter}"); }
    check($c->check($v['id'], '123456')['result'] === 'approved', 'live client: 123456 -> approved');
    try { $c->check($v['id'], '123456'); check(false, 'live client: check after approval'); }
    catch (VerifyApiError $e) { check($e->status === 409 && $e->errorCode === 'verification_closed', 'live client: check again -> 409 verification_closed'); }
    $v2 = $c->start($randomPhone());
    check($c->cancel($v2['id'])['status'] === 'canceled', 'live client: cancel');
    try { $c->start('abc'); } catch (VerifyApiError $e) { check($e->status === 422 && $e->param === 'to', 'live client: invalid number -> 422 param to'); }

    [$liveApp, $procs[]] = serve(['-t', 'public'], ['BASE_URL' => $base, 'API_KEY' => $key, 'RESEND_COOLDOWN' => '0', 'USERS_FILE' => "$tmp/users-live.json"]);
    app_flow($liveApp, $randomPhone(), 'live app', $key);
}

foreach ($procs as $p) proc_terminate($p);
array_map('unlink', glob("$tmp/*"));
rmdir($tmp);
echo $failures === 0 ? "\nAll checks passed.\n" : "\n$failures check(s) failed.\n";
exit($failures === 0 ? 0 : 1);
