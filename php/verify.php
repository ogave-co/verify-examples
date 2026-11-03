<?php
// Small Verify (OTP) API client for PHP 8.1+ with curl. Server-side only: the API key never reaches the browser.
declare(strict_types=1);

final class VerifyApiError extends RuntimeException
{
    public function __construct(
        public readonly int $status,        // HTTP status (0 = network error / timeout)
        public readonly string $errorCode,  // e.g. invalid_number, resend_cooldown, verification_closed
        string $message,
        public readonly ?string $param = null,
        public readonly ?int $retryAfter = null, // seconds, from the Retry-After header (429)
    ) {
        parent::__construct($message);
    }
}

final class VerifyClient
{
    private string $api;

    public function __construct(string $baseUrl, private readonly string $apiKey, private readonly int $timeout = 10)
    {
        if ($baseUrl === '') throw new InvalidArgumentException('BASE_URL is not set');
        if ($apiKey === '') throw new InvalidArgumentException('API_KEY is not set');
        $this->api = rtrim($baseUrl, '/') . '/v1';
    }

    /** POST /v1/verify -> 201 {id: "ver_...", status: "pending", expires_at, attempts_remaining, ...} */
    public function start(string $to, array $options = [], ?string $idempotencyKey = null): array
    {
        $body = array_filter(['to' => $to] + array_intersect_key($options, array_flip(['locale', 'app_id', 'device_id', 'ip'])),
            fn ($v) => $v !== null && $v !== '');
        return $this->request('POST', '/verify', $body, $idempotencyKey);
    }

    /** POST /v1/verify/{id}/check -> 200 {result: approved | invalid | expired | max_attempts, ...} */
    public function check(string $id, string $code, ?string $idempotencyKey = null): array
    {
        return $this->request('POST', '/verify/' . rawurlencode($id) . '/check', ['code' => $code], $idempotencyKey);
    }

    /** POST /v1/verify/{id}/resend -> 200, or 429 resend_cooldown (Retry-After) / 429 max_resends */
    public function resend(string $id, ?string $idempotencyKey = null): array
    {
        return $this->request('POST', '/verify/' . rawurlencode($id) . '/resend', [], $idempotencyKey);
    }

    public function cancel(string $id, ?string $idempotencyKey = null): array
    {
        return $this->request('POST', '/verify/' . rawurlencode($id) . '/cancel', [], $idempotencyKey);
    }

    public function get(string $id): array
    {
        return $this->request('GET', '/verify/' . rawurlencode($id));
    }

    private function request(string $method, string $path, ?array $body = null, ?string $idempotencyKey = null): array
    {
        $headers = ['Authorization: Bearer ' . $this->apiKey, 'Accept: application/json'];
        if ($body !== null) $headers[] = 'Content-Type: application/json';
        if ($idempotencyKey !== null) $headers[] = 'Idempotency-Key: ' . $idempotencyKey; // max 64 characters

        $retryAfter = null;
        $ch = curl_init($this->api . $path);
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_TIMEOUT => $this->timeout,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_HEADERFUNCTION => function ($ch, string $line) use (&$retryAfter) {
                if (preg_match('/^Retry-After:\s*(\d+)/i', $line, $m)) $retryAfter = (int) $m[1];
                return strlen($line);
            },
        ]);
        if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body ?: new stdClass()));

        $raw = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $errno = curl_errno($ch);
        curl_close($ch);
        if ($raw === false || $errno !== 0) {
            // Never include the request (or its Authorization header) in the error.
            throw new VerifyApiError(0, 'network_error', 'Could not reach the Verify API (curl error ' . $errno . ').');
        }

        $data = json_decode((string) $raw, true);
        $data = is_array($data) ? $data : [];
        if ($status >= 200 && $status < 300) return $data;

        $e = is_array($data['error'] ?? null) ? $data['error'] : [];
        throw new VerifyApiError($status, (string) ($e['code'] ?? "http_$status"), (string) ($e['message'] ?? "HTTP $status"),
            isset($e['param']) ? (string) $e['param'] : null, $retryAfter);
    }
}

/** E.164 check at our boundary (the API validates again): accepts spaces, dashes, dots, parentheses and a 00 prefix. */
function normalize_phone(mixed $input): ?string
{
    if (!is_string($input)) return null;
    $compact = preg_replace('/^00/', '+', preg_replace('/[\s().-]/', '', trim($input)));
    return preg_match('/^\+[1-9]\d{7,14}$/', $compact) ? $compact : null;
}

function mask_phone(string $phone): string
{
    return strlen($phone) > 4 ? substr($phone, 0, 3) . str_repeat('•', strlen($phone) - 5) . substr($phone, -2) : $phone;
}

/** Load KEY=VALUE lines from a .env file without overriding variables that are already set. */
function load_env(string $file): void
{
    if (!is_readable($file)) return;
    foreach (file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        if (str_starts_with(ltrim($line), '#') || !str_contains($line, '=')) continue;
        [$name, $value] = array_map('trim', explode('=', $line, 2));
        if (getenv($name) === false) putenv("$name=" . trim($value, "\"'"));
    }
}
