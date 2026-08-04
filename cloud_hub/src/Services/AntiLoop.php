<?php
declare(strict_types=1);

namespace Hub\Services;

use PDO;

/**
 * Mechanizm Anti-Loop.
 *
 * Problem: Wapro -> Hub -> Allegro/BaseLinker generuje na kanale zdarzenie
 * zmiany stanu. To zdarzenie wraca webhookiem do Huba i — bez zabezpieczenia —
 * zostałoby potraktowane jako "zmiana z rynku", odesłane do Wapro i tak w kółko.
 *
 * Rozwiązanie dwuwarstwowe:
 *
 *  1. DEDUPLIKACJA WARTOŚCI (isUnchanged)
 *     Liczymy odcisk wartości (sku + quantity). Jeśli identyczny odcisk jest już
 *     zapisany w inventory_state, nie ma czego wypychać — pomijamy.
 *     To ucina pętlę u źródła i redukuje wywołania API.
 *
 *  2. OKNO ECHA (isEcho)
 *     Każdy nasz push zapisujemy w action_logs jako direction='outbound',
 *     initiator='wapro_agent' wraz z value_hash. Gdy w ciągu N sekund przyjdzie
 *     zdarzenie inbound z tym samym value_hash, wiemy że to nasze własne echo.
 *
 * Odcisk celowo NIE zawiera znacznika czasu — musi być porównywalny między
 * kierunkami.
 */
final class AntiLoop
{
    public function __construct(
        private PDO $pdo,
        private int $echoWindowSeconds = 180,
        private bool $skipUnchanged = true
    ) {}

    public static function valueHash(string $tenantId, string $sku, int $quantity): string
    {
        return hash('sha256', $tenantId . '|stock|' . strtoupper(trim($sku)) . '|' . $quantity);
    }

    /**
     * Czy stan dla SKU jest identyczny z ostatnio wypchniętym?
     */
    public function isUnchanged(string $tenantId, string $sku, int $quantity): bool
    {
        if (!$this->skipUnchanged) {
            return false;
        }

        $stmt = $this->pdo->prepare(
            'SELECT value_hash FROM inventory_state WHERE tenant_id = ? AND sku = ? LIMIT 1'
        );
        $stmt->execute([$tenantId, $sku]);
        $existing = $stmt->fetchColumn();

        if ($existing === false) {
            return false;
        }

        return hash_equals((string) $existing, self::valueHash($tenantId, $sku, $quantity));
    }

    /**
     * Czy przychodzące zdarzenie jest echem naszego własnego pushu?
     * Wołane przez webhook receiver oraz poller Allegro.
     */
    public function isEcho(string $tenantId, string $sku, int $quantity): bool
    {
        $hash  = self::valueHash($tenantId, $sku, $quantity);
        $since = gmdate('Y-m-d H:i:s', time() - $this->echoWindowSeconds);

        $stmt = $this->pdo->prepare(
            "SELECT 1 FROM action_logs
             WHERE tenant_id  = :tenant
               AND entity_type = 'stock'
               AND direction   = 'outbound'
               AND initiator   = 'wapro_agent'
               AND value_hash  = :hash
               AND status      = 'ok'
               AND created_at >= :since
             LIMIT 1"
        );
        $stmt->execute([':tenant' => $tenantId, ':hash' => $hash, ':since' => $since]);

        return (bool) $stmt->fetchColumn();
    }

    /**
     * Zapisuje ślad akcji. To jedyne miejsce, które pisze do action_logs
     * dla encji 'stock' — dzięki temu semantyka value_hash jest spójna.
     */
    public function record(
        string $tenantId,
        string $entityType,
        string $entityKey,
        string $channel,
        string $direction,
        string $initiator,
        ?string $valueHash = null,
        ?int $quantity = null,
        string $status = 'ok',
        ?string $message = null,
        ?string $correlation = null
    ): void {
        $this->pdo->prepare(
            'INSERT INTO action_logs
                (tenant_id, entity_type, entity_key, channel, direction,
                 initiator, value_hash, quantity, status, message, correlation)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )->execute([
            $tenantId, $entityType, $entityKey, $channel, $direction,
            $initiator, $valueHash, $quantity, $status,
            $message !== null ? mb_substr($message, 0, 2000) : null,
            $correlation,
        ]);
    }

    /**
     * Utrwala nowy stan po udanym pushu. Wołać DOPIERO gdy przynajmniej jeden
     * kanał potwierdził przyjęcie — inaczej przy błędzie sieci zapamiętalibyśmy
     * stan, którego kanały nie znają, i już nigdy byśmy go nie powtórzyli.
     */
    public function commitState(
        string $tenantId,
        string $sku,
        int $quantity,
        ?string $sourceRowver = null
    ): void {
        $this->pdo->prepare(
            "INSERT INTO inventory_state (tenant_id, sku, quantity, value_hash, source_rowver, pushed_at)
             VALUES (:tenant, :sku, :qty, :hash, :rowver, datetime('now'))
             ON CONFLICT(tenant_id, sku) DO UPDATE SET
                quantity      = excluded.quantity,
                value_hash    = excluded.value_hash,
                source_rowver = excluded.source_rowver,
                pushed_at     = excluded.pushed_at"
        )->execute([
            ':tenant' => $tenantId,
            ':sku'    => $sku,
            ':qty'    => $quantity,
            ':hash'   => self::valueHash($tenantId, $sku, $quantity),
            ':rowver' => $sourceRowver,
        ]);
    }

    /** Czyszczenie starych logów — wołane z crona. */
    public function prune(int $keepDays = 30): int
    {
        $stmt = $this->pdo->prepare(
            "DELETE FROM action_logs WHERE created_at < datetime('now', :cutoff)"
        );
        $stmt->execute([':cutoff' => sprintf('-%d days', max(1, $keepDays))]);
        return $stmt->rowCount();
    }
}
