<?php
declare(strict_types=1);

namespace Hub\Services;

use Hub\Clients\HttpClient;
use Hub\Support\Logger;
use PDO;
use RuntimeException;

/**
 * OAuth 2.0 Authorization Code + PKCE dla Allegro.
 *
 * Przepływ:
 *   1. Panel → start()   — generuje state + code_verifier, zwraca URL do Allegro.
 *   2. Allegro → callback() — wymienia code na tokeny i zapisuje w auth_tokens.
 *
 * PKCE (S256) stosujemy mimo posiadania client_secret — chroni przed przechwyceniem
 * kodu autoryzacyjnego, gdyby redirect_uri kiedykolwiek wyciekł.
 *
 * `state` jest jednorazowy i wygasa po 10 minutach; próba ponownego użycia kończy
 * się odrzuceniem (ochrona przed CSRF i replayem).
 */
final class AllegroOAuth
{
    private HttpClient $http;

    public function __construct(
        private PDO $pdo,
        private array $config,
        private Logger $logger
    ) {
        $this->http = new HttpClient((int) ($config['timeout'] ?? 20));
    }

    private static function base64Url(string $bin): string
    {
        return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
    }

    /**
     * Krok 1 — zwraca URL, pod który należy przekierować przeglądarkę.
     */
    public function start(string $tenantId, string $redirectUri): string
    {
        $clientId = (string) ($this->config['client_id'] ?? '');
        if ($clientId === '') {
            throw new RuntimeException('Brak ALLEGRO_CLIENT_ID w konfiguracji huba.');
        }
        if (!preg_match('#^https?://#i', $redirectUri)) {
            throw new RuntimeException('redirect_uri musi być pełnym adresem URL.');
        }

        $state = self::base64Url(random_bytes(24));
        $verifier = self::base64Url(random_bytes(48));
        $challenge = self::base64Url(hash('sha256', $verifier, true));

        // Sprzątamy przeterminowane wpisy przy okazji — bez osobnego crona.
        $this->pdo->exec("DELETE FROM oauth_states WHERE expires_at < datetime('now')");

        $this->pdo->prepare(
            "INSERT INTO oauth_states (state, tenant_id, provider, code_verifier, redirect_uri, expires_at)
             VALUES (?, ?, 'allegro', ?, ?, datetime('now', '+10 minutes'))"
        )->execute([$state, $tenantId, $verifier, $redirectUri]);

        $query = http_build_query([
            'response_type'         => 'code',
            'client_id'             => $clientId,
            'redirect_uri'          => $redirectUri,
            'state'                 => $state,
            'code_challenge_method' => 'S256',
            'code_challenge'        => $challenge,
        ]);

        return rtrim((string) $this->config['auth_base'], '/') . '/authorize?' . $query;
    }

    /**
     * Krok 2 — wymiana kodu na tokeny.
     *
     * @return array{tenant_id:string, expires_at:string}
     */
    public function callback(string $code, string $state): array
    {
        $stmt = $this->pdo->prepare(
            "SELECT * FROM oauth_states
              WHERE state = ? AND provider = 'allegro' AND expires_at >= datetime('now')
              LIMIT 1"
        );
        $stmt->execute([$state]);
        $row = $stmt->fetch();

        if (!$row) {
            throw new RuntimeException(
                'Nieznany lub przeterminowany parametr state. Rozpocznij autoryzację ponownie.'
            );
        }

        // Jednorazowość — usuwamy natychmiast, niezależnie od wyniku wymiany.
        $this->pdo->prepare('DELETE FROM oauth_states WHERE state = ?')->execute([$state]);

        $clientId     = (string) $this->config['client_id'];
        $clientSecret = (string) $this->config['client_secret'];

        $res = $this->http->request(
            'POST',
            rtrim((string) $this->config['auth_base'], '/') . '/token',
            [
                'Authorization' => 'Basic ' . base64_encode($clientId . ':' . $clientSecret),
                'Content-Type'  => 'application/x-www-form-urlencoded',
            ],
            http_build_query([
                'grant_type'    => 'authorization_code',
                'code'          => $code,
                'redirect_uri'  => $row['redirect_uri'],
                'code_verifier' => $row['code_verifier'],
            ])
        );

        $body = $this->http->decodeJson($res['body']);

        if ($res['status'] !== 200 || empty($body['access_token'])) {
            $this->logger->error('OAuth Allegro: wymiana kodu nieudana', [
                'status' => $res['status'],
                'body'   => mb_substr($res['body'], 0, 500),
            ]);
            throw new RuntimeException(
                'Allegro odrzuciło kod autoryzacyjny (HTTP ' . $res['status'] . '). '
                . ($body['error_description'] ?? $body['error'] ?? '')
            );
        }

        $tenantId  = (string) $row['tenant_id'];
        $expiresAt = gmdate('Y-m-d H:i:s', time() + (int) ($body['expires_in'] ?? 43200));

        $this->pdo->prepare(
            "INSERT INTO auth_tokens
                (tenant_id, provider, account_label, access_token, refresh_token, token_type, scope, expires_at, updated_at)
             VALUES (:tenant, 'allegro', 'default', :at, :rt, :tt, :scope, :exp, datetime('now'))
             ON CONFLICT(tenant_id, provider, account_label) DO UPDATE SET
                access_token  = excluded.access_token,
                refresh_token = excluded.refresh_token,
                token_type    = excluded.token_type,
                scope         = excluded.scope,
                expires_at    = excluded.expires_at,
                updated_at    = excluded.updated_at"
        )->execute([
            ':tenant' => $tenantId,
            ':at'     => $body['access_token'],
            ':rt'     => $body['refresh_token'] ?? null,
            ':tt'     => $body['token_type'] ?? 'Bearer',
            ':scope'  => $body['scope'] ?? null,
            ':exp'    => $expiresAt,
        ]);

        $this->logger->info('OAuth Allegro: autoryzacja zakończona', [
            'tenant'  => $tenantId,
            'expires' => $expiresAt,
        ]);

        return ['tenant_id' => $tenantId, 'expires_at' => $expiresAt];
    }

    /** Status autoryzacji do wyświetlenia w panelu. */
    public function status(string $tenantId): array
    {
        $stmt = $this->pdo->prepare(
            "SELECT scope, expires_at, updated_at, (refresh_token IS NOT NULL) AS has_refresh
               FROM auth_tokens
              WHERE tenant_id = ? AND provider = 'allegro' AND account_label = 'default'"
        );
        $stmt->execute([$tenantId]);
        $row = $stmt->fetch();

        if (!$row) {
            return ['authorized' => false];
        }

        $expiresTs = $row['expires_at'] ? strtotime((string) $row['expires_at']) : 0;

        return [
            'authorized'  => true,
            'expires_at'  => $row['expires_at'],
            'expired'     => $expiresTs > 0 && $expiresTs <= time(),
            'has_refresh' => (bool) $row['has_refresh'],
            'scope'       => $row['scope'],
            'updated_at'  => $row['updated_at'],
        ];
    }

    public function revoke(string $tenantId): void
    {
        $this->pdo->prepare(
            "DELETE FROM auth_tokens WHERE tenant_id = ? AND provider = 'allegro'"
        )->execute([$tenantId]);
    }
}
