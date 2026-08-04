<?php
declare(strict_types=1);

namespace Hub\Services;

use PDO;

/**
 * Ustawienia per tenant (klucz -> wartość).
 *
 * Nadpisują wartości globalne z config.php. Dzięki temu jeden hub obsługuje
 * wielu klientów z różnymi `inventory_id` BaseLinkera czy różnymi oknami echa,
 * bez mnożenia zmiennych środowiskowych.
 */
final class TenantSettings
{
    /** @var array<string, array<string,string|null>> cache per tenant */
    private array $cache = [];

    public function __construct(private PDO $pdo) {}

    /** @return array<string,string|null> */
    public function all(string $tenantId): array
    {
        if (isset($this->cache[$tenantId])) {
            return $this->cache[$tenantId];
        }

        $stmt = $this->pdo->prepare('SELECT key, value FROM tenant_settings WHERE tenant_id = ?');
        $stmt->execute([$tenantId]);

        $out = [];
        foreach ($stmt->fetchAll() as $row) {
            $out[(string) $row['key']] = $row['value'];
        }

        return $this->cache[$tenantId] = $out;
    }

    public function get(string $tenantId, string $key, mixed $default = null): mixed
    {
        $all = $this->all($tenantId);
        return array_key_exists($key, $all) && $all[$key] !== null && $all[$key] !== ''
            ? $all[$key]
            : $default;
    }

    public function getInt(string $tenantId, string $key, int $default = 0): int
    {
        $v = $this->get($tenantId, $key);
        return is_numeric($v) ? (int) $v : $default;
    }

    public function set(string $tenantId, string $key, ?string $value): void
    {
        $this->pdo->prepare(
            "INSERT INTO tenant_settings (tenant_id, key, value, updated_at)
             VALUES (?, ?, ?, datetime('now'))
             ON CONFLICT(tenant_id, key) DO UPDATE SET
                value = excluded.value, updated_at = excluded.updated_at"
        )->execute([$tenantId, $key, $value]);

        unset($this->cache[$tenantId]);
    }

    /** @param array<string,string|null> $pairs */
    public function setMany(string $tenantId, array $pairs): void
    {
        foreach ($pairs as $k => $v) {
            $this->set($tenantId, (string) $k, $v === null ? null : (string) $v);
        }
    }

    /**
     * Scala konfigurację globalną z ustawieniami tenanta.
     * Zwraca tablicę w kształcie config['baselinker'] / config['anti_loop'].
     */
    public function mergeChannelConfig(string $tenantId, array $globalConfig): array
    {
        $cfg = $globalConfig;

        $map = [
            'baselinker.token'        => ['baselinker', 'token'],
            'baselinker.inventory_id' => ['baselinker', 'inventory_id'],
            'baselinker.warehouse_id' => ['baselinker', 'warehouse_id'],
            'anti_loop.echo_window'   => ['anti_loop', 'echo_window_seconds'],
        ];

        foreach ($map as $settingKey => [$section, $field]) {
            $value = $this->get($tenantId, $settingKey);
            if ($value === null) {
                continue;
            }
            $cfg[$section][$field] = is_numeric($value) && $field !== 'token' && $field !== 'warehouse_id'
                ? (int) $value
                : $value;
        }

        return $cfg;
    }
}
