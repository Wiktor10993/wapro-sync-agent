<?php
declare(strict_types=1);

namespace Hub\Http;

use JsonException;

final class Request
{
    public static function method(): string
    {
        return strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
    }

    public static function path(): string
    {
        $uri = $_SERVER['REQUEST_URI'] ?? '/';
        $path = parse_url($uri, PHP_URL_PATH) ?: '/';
        return '/' . trim($path, '/');
    }

    public static function header(string $name, ?string $default = null): ?string
    {
        $key = 'HTTP_' . str_replace('-', '_', strtoupper($name));
        if (isset($_SERVER[$key])) {
            return $_SERVER[$key];
        }
        // Niektóre konfiguracje (CGI/FPM) gubią nagłówek Authorization.
        if (strcasecmp($name, 'Authorization') === 0 && function_exists('apache_request_headers')) {
            $headers = apache_request_headers();
            foreach ($headers as $hName => $hValue) {
                if (strcasecmp($hName, 'Authorization') === 0) {
                    return $hValue;
                }
            }
        }
        return $default;
    }

    /** Surowe ciało requestu (potrzebne do weryfikacji podpisu webhooka). */
    public static function rawBody(): string
    {
        static $body = null;
        if ($body === null) {
            $body = file_get_contents('php://input');
            if ($body === false) {
                $body = '';
            }
        }
        return $body;
    }

    /**
     * @throws JsonException gdy ciało nie jest poprawnym JSON-em
     */
    public static function json(): array
    {
        $raw = self::rawBody();
        if ($raw === '') {
            return [];
        }
        $decoded = json_decode($raw, true, 64, JSON_THROW_ON_ERROR);
        return is_array($decoded) ? $decoded : [];
    }

    public static function query(string $key, ?string $default = null): ?string
    {
        $v = $_GET[$key] ?? null;
        return is_string($v) ? $v : $default;
    }
}
