<?php
// Router script for `php -S`: an in-memory imitation of the Verify API (test-key behaviour: code 123456).
// State lives in the JSON file named by STUB_STATE so it survives between requests.
declare(strict_types=1);

$stateFile = getenv('STUB_STATE');
$s = is_file($stateFile) ? json_decode(file_get_contents($stateFile), true) : ['v' => [], 'idem' => [], 'log' => [], 'seq' => 0];
$cooldown = 30;
$maxResends = 2;

function out(array &$s, string $file, int $status, array $data, array $headers = []): never
{
    file_put_contents($file, json_encode($s));
    http_response_code($status);
    header('Content-Type: application/json');
    foreach ($headers as $k => $v) header("$k: $v");
    echo json_encode($data);
    exit;
}
$err = fn (int $st, string $code, string $msg, ?string $param = null, array $h = []) => out($s, $stateFile, $st, ['error' => ['code' => $code, 'message' => $msg, 'param' => $param]], $h);

$method = $_SERVER['REQUEST_METHOD'];
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$body = json_decode(file_get_contents('php://input') ?: '{}', true) ?: [];
$idem = $_SERVER['HTTP_IDEMPOTENCY_KEY'] ?? null;
$s['log'][] = ['method' => $method, 'path' => $path, 'idem' => $idem, 'auth' => ($_SERVER['HTTP_AUTHORIZATION'] ?? '') === 'Bearer test_stubkey'];

if (($_SERVER['HTTP_AUTHORIZATION'] ?? '') !== 'Bearer test_stubkey') $err(401, 'invalid_api_key', 'The API key is not valid.');
if ($idem !== null && !preg_match('/^[\x21-\x7e]{1,64}$/', $idem)) $err(422, 'invalid_idempotency_key', 'Idempotency-Key must be 1-64 visible ASCII characters.');
if ($method === 'POST' && $idem !== null && isset($s['idem'][$idem])) out($s, $stateFile, ...$s['idem'][$idem]);
$reply = function (int $st, array $data, array $h = []) use (&$s, $stateFile, $idem): never {
    if ($idem !== null) $s['idem'][$idem] = [$st, $data, $h];
    out($s, $stateFile, $st, $data, $h);
};
$view = fn (array $v) => array_diff_key($v, ['sent' => 1]);

if (!preg_match('#^/v1/verify(?:/(ver_\w+))?(?:/(check|resend|cancel))?$#', $path, $m)) $err(404, 'not_found', 'Not found');
$id = $m[1] ?? '';
$action = $m[2] ?? '';
if ($id !== '' && !isset($s['v'][$id])) $err(404, 'not_found', 'No such verification.');
$v = &$s['v'][$id];

if ($method === 'POST' && $id === '') {
    $to = (string) ($body['to'] ?? '');
    if (!preg_match('/^\+[1-9]\d{7,14}$/', $to)) $err(422, 'invalid_number', "'$to' is not a valid phone number. Use E.164, e.g. +573001234567.", 'to');
    if ($to === '+15005550429') $err(429, 'velocity_number', 'Too many codes for this number.', null, ['Retry-After' => '60']);
    $nid = 'ver_stub' . (++$s['seq']);
    $s['v'][$nid] = ['id' => $nid, 'object' => 'verification', 'mode' => 'test', 'status' => 'pending', 'to' => $to, 'attempts' => 0, 'attempts_remaining' => 3, 'resends' => 0, 'sent' => time()];
    $reply(201, $view($s['v'][$nid]));
}
if ($method === 'GET' && $action === '') out($s, $stateFile, 200, $view($v));
if ($v['status'] !== 'pending') $err(409, 'verification_closed', "This verification is already {$v['status']}. Start a new one.");
if ($action === 'check') {
    $v['attempts']++;
    $v['attempts_remaining']--;
    if (($body['code'] ?? '') === '123456') { $v['status'] = 'approved'; $reply(200, ['result' => 'approved'] + $view($v)); }
    if ($v['attempts_remaining'] <= 0) { $v['status'] = 'max_attempts'; $reply(200, ['result' => 'max_attempts'] + $view($v)); }
    $reply(200, ['result' => 'invalid'] + $view($v));
}
if ($action === 'resend') {
    $wait = $v['sent'] + $cooldown - time();
    if ($wait > 0) $err(429, 'resend_cooldown', "Wait $wait s before resending.", null, ['Retry-After' => (string) $wait]);
    if ($v['resends'] >= $maxResends) $err(429, 'max_resends', 'No more resends.');
    $v['resends']++;
    $v['sent'] = time();
    $reply(200, $view($v));
}
if ($action === 'cancel') { $v['status'] = 'canceled'; $reply(200, $view($v)); }
$err(405, 'method_not_allowed', 'Method not allowed');
