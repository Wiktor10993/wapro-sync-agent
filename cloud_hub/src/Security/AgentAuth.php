<?php
declare(strict_types=1);

namespace Hub\Security;

use Hub\Http\Request;
use PDO;

/**
 * Uwierzytelnianie agenta desktopowego kluczem API.
 *
 * Klient wysyła: Authorization: Bearer <api_key>
 * W bazie trzymamy wyłącznie HMAC-SHA256(api_key, pepper) — nigdy klucza jawnie.
 */
final class AgentAuth
{
    public function __construct(
        private PDO $pdo,
        private string $pepper
    ) {}

    public static function hashKey(string $apiKey, string $pepper): string
    {
        return hash_hmac('sha256', $apiKey, $pepper);
    }

    public static function generateKey(): string
    {
        return 'wha_' . bin2hex(random_bytes(24));
    }

    /**
     * @return array{id:int,tenant_id:string,name:string}|null
     */
    public function authenticate(): ?array
    {
        $header = Request::header('Authorization');
        if (!is_string($header) || !preg_match('/^Bearer\s+(\S+)$/i', $header, $m)) {
            return null;
        }

        $hash = self::hashKey($m[1], $this->pepper);

        $stmt = $this->pdo->prepare(
            'SELECT id, tenant_id, name FROM agents WHERE api_key_hash = ? AND active = 1 LIMIT 1'
        );
        $stmt->execute([$hash]);
        $agent = $stmt->fetch();

        if (!$agent) {
            // Stały koszt czasowy, by nie ułatwiać enumeracji kluczy.
            usleep(random_int(50_000, 120_000));
            return null;
        }

        $this->pdo->prepare("UPDATE agents SET last_seen_at = datetime('now') WHERE id = ?")
                  ->execute([$agent['id']]);

        return [
            'id'        => (int) $agent['id'],
            'tenant_id' => (string) $agent['tenant_id'],
            'name'      => (string) $agent['name'],
        ];
    }

    /** Rejestruje nowego agenta i zwraca klucz w postaci jawnej (jedyny raz). */
    public function register(string $tenantId, string $name): string
    {
        $key = self::generateKey();
        $this->pdo->prepare(
            'INSERT INTO agents (tenant_id, name, api_key_hash) VALUES (?, ?, ?)'
        )->execute([$tenantId, $name, self::hashKey($key, $this->pepper)]);
        return $key;
    }
}
