<?php
declare(strict_types=1);

namespace Hub\Http;

final class Response
{
    public static function json(array $payload, int $status = 200): void
    {
        if (!headers_sent()) {
            http_response_code($status);
            header('Content-Type: application/json; charset=utf-8');
            header('X-Content-Type-Options: nosniff');
            header('Cache-Control: no-store');
        }
        echo json_encode(
            $payload,
            JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR
        );
    }

    public static function ok(array $data = []): void
    {
        self::json(['ok' => true] + $data, 200);
    }

    public static function error(string $code, string $message, int $status = 400, array $extra = []): void
    {
        self::json([
            'ok'    => false,
            'error' => ['code' => $code, 'message' => $message] + $extra,
        ], $status);
    }
}
