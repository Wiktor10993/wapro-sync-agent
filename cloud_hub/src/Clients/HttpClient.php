<?php
declare(strict_types=1);

namespace Hub\Clients;

use RuntimeException;

/** Minimalny wrapper na cURL — bez zależności zewnętrznych. */
final class HttpClient
{
    public function __construct(private int $timeout = 20) {}

    /**
     * @param array<string,string> $headers
     * @return array{status:int, body:string, headers:array<string,string>}
     */
    public function request(string $method, string $url, array $headers = [], ?string $body = null): array
    {
        $ch = curl_init();
        if ($ch === false) {
            throw new RuntimeException('curl_init() nie powiodło się');
        }

        $headerLines = [];
        foreach ($headers as $k => $v) {
            $headerLines[] = $k . ': ' . $v;
        }

        $responseHeaders = [];

        curl_setopt_array($ch, [
            CURLOPT_URL            => $url,
            CURLOPT_CUSTOMREQUEST  => strtoupper($method),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => $this->timeout,
            CURLOPT_CONNECTTIMEOUT => min(10, $this->timeout),
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_HTTPHEADER     => $headerLines,
            CURLOPT_POSTFIELDS     => $body,
            CURLOPT_HEADERFUNCTION => function ($ch, string $line) use (&$responseHeaders) {
                $len = strlen($line);
                $parts = explode(':', $line, 2);
                if (count($parts) === 2) {
                    $responseHeaders[strtolower(trim($parts[0]))] = trim($parts[1]);
                }
                return $len;
            },
        ]);

        $raw = curl_exec($ch);

        if ($raw === false) {
            $err = curl_error($ch);
            $no  = curl_errno($ch);
            curl_close($ch);
            throw new RuntimeException("Błąd HTTP ({$no}): {$err}");
        }

        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);

        return ['status' => $status, 'body' => (string) $raw, 'headers' => $responseHeaders];
    }

    public function decodeJson(string $body): array
    {
        if (trim($body) === '') {
            return [];
        }
        $decoded = json_decode($body, true);
        return is_array($decoded) ? $decoded : ['_raw' => $body];
    }
}
