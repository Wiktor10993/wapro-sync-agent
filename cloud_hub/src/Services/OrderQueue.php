<?php
declare(strict_types=1);

namespace Hub\Services;

use Hub\Database;
use PDO;

/**
 * Kolejka zamówień: zapis z rynków (Allegro poller / webhook BaseLinkera)
 * oraz wydawanie agentowi.
 *
 * Model "claim" zamiast prostego SELECT: agent pobiera paczkę, hub oznacza ją
 * jako 'claimed'. Agent potwierdza (ack) po faktycznym zapisaniu w Wapro.
 * Nieodebrane claimy wracają do 'pending' po timeoucie — dzięki temu awaria
 * agenta w połowie procesu nie gubi zamówień.
 */
final class OrderQueue
{
    public function __construct(private PDO $pdo) {}

    /**
     * @return bool true jeśli zamówienie zostało dodane, false jeśli duplikat
     */
    public function enqueue(
        string $tenantId,
        string $source,
        string $externalId,
        array $payload,
        ?string $eventId = null,
        ?string $occurredAt = null
    ): bool {
        $stmt = $this->pdo->prepare(
            'INSERT OR IGNORE INTO order_queue
                (tenant_id, source, external_id, event_id, payload_json, occurred_at)
             VALUES (?, ?, ?, ?, ?, ?)'
        );
        $stmt->execute([
            $tenantId,
            $source,
            $externalId,
            $eventId,
            json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
            $occurredAt,
        ]);

        return $stmt->rowCount() > 0;
    }

    /**
     * Wydaje agentowi paczkę zamówień i oznacza je jako 'claimed'.
     *
     * @return array<int,array<string,mixed>>
     */
    public function claim(string $tenantId, string $agentName, int $limit = 50, int $reclaimAfterSeconds = 900): array
    {
        return Database::transaction($this->pdo, function (PDO $pdo) use ($tenantId, $agentName, $limit, $reclaimAfterSeconds) {
            // Zwolnij zawieszone claimy.
            $pdo->prepare(
                "UPDATE order_queue
                    SET status = 'pending', claimed_by = NULL, claimed_at = NULL
                  WHERE tenant_id = :tenant
                    AND status = 'claimed'
                    AND claimed_at < datetime('now', :cutoff)"
            )->execute([
                ':tenant' => $tenantId,
                ':cutoff' => sprintf('-%d seconds', max(60, $reclaimAfterSeconds)),
            ]);

            $sel = $pdo->prepare(
                "SELECT id, source, external_id, payload_json, occurred_at, attempts
                   FROM order_queue
                  WHERE tenant_id = :tenant AND status = 'pending'
                  ORDER BY id ASC
                  LIMIT :lim"
            );
            $sel->bindValue(':tenant', $tenantId, PDO::PARAM_STR);
            $sel->bindValue(':lim', max(1, min(500, $limit)), PDO::PARAM_INT);
            $sel->execute();
            $rows = $sel->fetchAll();

            if ($rows === []) {
                return [];
            }

            $ids = array_column($rows, 'id');
            $placeholders = implode(',', array_fill(0, count($ids), '?'));
            $pdo->prepare(
                "UPDATE order_queue
                    SET status = 'claimed', claimed_by = ?, claimed_at = datetime('now'),
                        attempts = attempts + 1, updated_at = datetime('now')
                  WHERE id IN ({$placeholders})"
            )->execute(array_merge([$agentName], $ids));

            return array_map(static function (array $r): array {
                return [
                    'queue_id'    => (int) $r['id'],
                    'source'      => $r['source'],
                    'external_id' => $r['external_id'],
                    'occurred_at' => $r['occurred_at'],
                    'attempts'    => (int) $r['attempts'],
                    'order'       => json_decode((string) $r['payload_json'], true),
                ];
            }, $rows);
        });
    }

    /**
     * Potwierdzenie zapisu w Wapro.
     *
     * @param array<int,int> $queueIds
     */
    public function ack(
        string $tenantId,
        array $queueIds,
        bool $success = true,
        ?string $error = null,
        ?string $waproRef = null
    ): int {
        if ($queueIds === []) {
            return 0;
        }
        $placeholders = implode(',', array_fill(0, count($queueIds), '?'));
        $status = $success ? 'synced' : 'failed';

        $stmt = $this->pdo->prepare(
            "UPDATE order_queue
                SET status = ?, synced_at = datetime('now'), updated_at = datetime('now'),
                    last_error = ?, wapro_ref = COALESCE(?, wapro_ref)
              WHERE tenant_id = ? AND id IN ({$placeholders})"
        );
        $stmt->execute(array_merge([$status, $error, $waproRef, $tenantId], array_map('intval', $queueIds)));

        return $stmt->rowCount();
    }

    /**
     * Identyfikatory zewnętrzne dla wskazanych pozycji kolejki i źródła.
     *
     * @param array<int,int> $queueIds
     * @return array<int,string>
     */
    public function externalIds(string $tenantId, array $queueIds, string $source): array
    {
        if ($queueIds === []) {
            return [];
        }
        $placeholders = implode(',', array_fill(0, count($queueIds), '?'));

        $stmt = $this->pdo->prepare(
            "SELECT external_id FROM order_queue
              WHERE tenant_id = ? AND source = ? AND id IN ({$placeholders})"
        );
        $stmt->execute(array_merge([$tenantId, $source], array_map('intval', $queueIds)));

        return array_map('strval', $stmt->fetchAll(PDO::FETCH_COLUMN));
    }

    public function counts(string $tenantId): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT status, COUNT(*) AS c FROM order_queue WHERE tenant_id = ? GROUP BY status'
        );
        $stmt->execute([$tenantId]);
        $out = ['pending' => 0, 'claimed' => 0, 'synced' => 0, 'failed' => 0, 'skipped' => 0];
        foreach ($stmt->fetchAll() as $row) {
            $out[$row['status']] = (int) $row['c'];
        }
        return $out;
    }
}
