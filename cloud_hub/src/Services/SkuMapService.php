<?php
declare(strict_types=1);

namespace Hub\Services;

use Hub\Clients\AllegroClient;
use Hub\Clients\BaseLinkerClient;
use Hub\Support\Logger;
use PDO;
use RuntimeException;
use Throwable;

/**
 * Mapowanie SKU (Wapro) → identyfikatory kanałów sprzedaży.
 *
 * Trzy źródła, w kolejności zaufania:
 *   1. `manual` — wpis z panelu; NIGDY nie jest nadpisywany przez auto-discovery,
 *   2. `csv`    — import pliku,
 *   3. `auto`   — zaciągnięte z API kanału.
 *
 * Auto-discovery nie usuwa wpisów, których nie zobaczył — dezaktywuje je
 * (`active = 0`) i zostawia ślad w `last_seen_at`. Usunięcie oferty w Allegro
 * nie może po cichu skasować mapowania, bo operator musiałby zgadywać,
 * czemu SKU przestało się synchronizować.
 */
final class SkuMapService
{
    public function __construct(
        private PDO $pdo,
        private Logger $logger
    ) {}

    // ------------------------------------------------------------------
    // Zapis
    // ------------------------------------------------------------------

    /**
     * @return string 'inserted'|'updated'|'skipped'
     */
    public function upsert(
        string $tenantId,
        string $sku,
        string $channel,
        string $externalRef,
        string $variantRef = '0',
        string $origin = 'manual',
        ?string $title = null
    ): string {
        $sku = trim($sku);
        $externalRef = trim($externalRef);

        if ($sku === '' || $externalRef === '') {
            throw new RuntimeException('SKU i identyfikator w kanale nie mogą być puste.');
        }
        if (!in_array($channel, ['allegro', 'baselinker'], true)) {
            throw new RuntimeException("Nieznany kanał: {$channel}");
        }

        $stmt = $this->pdo->prepare(
            'SELECT id, sku, origin FROM sku_map
              WHERE tenant_id = ? AND channel = ? AND external_ref = ? AND variant_ref = ?'
        );
        $stmt->execute([$tenantId, $channel, $externalRef, $variantRef]);
        $existing = $stmt->fetch();

        if ($existing) {
            // Auto-discovery nie dotyka wpisów ustawionych ręcznie.
            if ($origin === 'auto' && $existing['origin'] === 'manual') {
                $this->pdo->prepare(
                    "UPDATE sku_map SET last_seen_at = datetime('now') WHERE id = ?"
                )->execute([$existing['id']]);
                return 'skipped';
            }

            $this->pdo->prepare(
                "UPDATE sku_map
                    SET sku = ?, origin = ?, title = ?, active = 1,
                        last_seen_at = datetime('now'), updated_at = datetime('now')
                  WHERE id = ?"
            )->execute([$sku, $origin, $title, $existing['id']]);

            return $existing['sku'] === $sku ? 'skipped' : 'updated';
        }

        $this->pdo->prepare(
            "INSERT INTO sku_map
                (tenant_id, sku, channel, external_ref, variant_ref, origin, title, active, last_seen_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))"
        )->execute([$tenantId, $sku, $channel, $externalRef, $variantRef, $origin, $title]);

        return 'inserted';
    }

    public function delete(string $tenantId, int $id): bool
    {
        $stmt = $this->pdo->prepare('DELETE FROM sku_map WHERE tenant_id = ? AND id = ?');
        $stmt->execute([$tenantId, $id]);
        return $stmt->rowCount() > 0;
    }

    public function setActive(string $tenantId, int $id, bool $active): bool
    {
        $stmt = $this->pdo->prepare(
            "UPDATE sku_map SET active = ?, updated_at = datetime('now') WHERE tenant_id = ? AND id = ?"
        );
        $stmt->execute([$active ? 1 : 0, $tenantId, $id]);
        return $stmt->rowCount() > 0;
    }

    // ------------------------------------------------------------------
    // Odczyt
    // ------------------------------------------------------------------

    /** @return array{rows:array, total:int} */
    public function list(string $tenantId, array $filters = [], int $page = 1, int $perPage = 50): array
    {
        $where = ['tenant_id = :tenant'];
        $params = [':tenant' => $tenantId];

        if (!empty($filters['channel'])) {
            $where[] = 'channel = :channel';
            $params[':channel'] = $filters['channel'];
        }
        if (!empty($filters['origin'])) {
            $where[] = 'origin = :origin';
            $params[':origin'] = $filters['origin'];
        }
        if (isset($filters['active']) && $filters['active'] !== '') {
            $where[] = 'active = :active';
            $params[':active'] = (int) $filters['active'];
        }
        if (!empty($filters['q'])) {
            $where[] = '(sku LIKE :q OR external_ref LIKE :q OR title LIKE :q)';
            $params[':q'] = '%' . $filters['q'] . '%';
        }

        $whereSql = implode(' AND ', $where);

        $countStmt = $this->pdo->prepare("SELECT COUNT(*) FROM sku_map WHERE {$whereSql}");
        $countStmt->execute($params);
        $total = (int) $countStmt->fetchColumn();

        $perPage = max(10, min(500, $perPage));
        $offset  = max(0, ($page - 1) * $perPage);

        $stmt = $this->pdo->prepare(
            "SELECT * FROM sku_map WHERE {$whereSql}
             ORDER BY sku, channel LIMIT {$perPage} OFFSET {$offset}"
        );
        $stmt->execute($params);

        return ['rows' => $stmt->fetchAll(), 'total' => $total];
    }

    public function stats(string $tenantId): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT channel, origin, active, COUNT(*) AS c
               FROM sku_map WHERE tenant_id = ?
              GROUP BY channel, origin, active'
        );
        $stmt->execute([$tenantId]);

        $out = ['total' => 0, 'by_channel' => [], 'by_origin' => [], 'inactive' => 0];
        foreach ($stmt->fetchAll() as $r) {
            $c = (int) $r['c'];
            $out['total'] += $c;
            $out['by_channel'][$r['channel']] = ($out['by_channel'][$r['channel']] ?? 0) + $c;
            $out['by_origin'][$r['origin']] = ($out['by_origin'][$r['origin']] ?? 0) + $c;
            if ((int) $r['active'] === 0) {
                $out['inactive'] += $c;
            }
        }

        return $out;
    }

    /** SKU, które przyszły z Wapro, ale nie mają żadnego mapowania. */
    public function unmapped(string $tenantId, int $limit = 100): array
    {
        $stmt = $this->pdo->prepare(
            "SELECT i.sku, i.quantity, i.pushed_at
               FROM inventory_state i
              WHERE i.tenant_id = :tenant
                AND NOT EXISTS (
                    SELECT 1 FROM sku_map m
                     WHERE m.tenant_id = i.tenant_id AND m.sku = i.sku AND m.active = 1
                )
              ORDER BY i.sku LIMIT :lim"
        );
        $stmt->bindValue(':tenant', $tenantId);
        $stmt->bindValue(':lim', max(1, min(1000, $limit)), PDO::PARAM_INT);
        $stmt->execute();

        return $stmt->fetchAll();
    }

    // ------------------------------------------------------------------
    // Auto-discovery: Allegro
    // ------------------------------------------------------------------

    public function syncFromAllegro(string $tenantId, AllegroClient $allegro, int $maxPages = 50): array
    {
        $report = ['scanned' => 0, 'inserted' => 0, 'updated' => 0, 'skipped' => 0, 'no_sku' => 0, 'errors' => []];
        $seen = [];
        $offset = 0;
        $limit = 100;

        for ($page = 0; $page < $maxPages; $page++) {
            try {
                $batch = $allegro->listOffers($tenantId, $offset, $limit);
            } catch (Throwable $e) {
                $report['errors'][] = $e->getMessage();
                break;
            }

            $offers = $batch['offers'];
            if ($offers === []) {
                break;
            }

            foreach ($offers as $offer) {
                $report['scanned']++;

                $offerId = (string) ($offer['id'] ?? '');
                $sku = trim((string) ($offer['external']['id'] ?? ''));

                if ($offerId === '' || $sku === '') {
                    $report['no_sku']++;
                    continue;
                }

                try {
                    $result = $this->upsert(
                        $tenantId,
                        $sku,
                        'allegro',
                        $offerId,
                        '0',
                        'auto',
                        (string) ($offer['name'] ?? '')
                    );
                    $report[$result]++;
                    $seen[] = $offerId;
                } catch (Throwable $e) {
                    $report['errors'][] = "Oferta {$offerId}: " . $e->getMessage();
                }
            }

            $offset += $limit;
            if ($offset >= $batch['total']) {
                break;
            }
        }

        $report['deactivated'] = $this->deactivateUnseen($tenantId, 'allegro', $seen);

        $this->logger->info('Auto-mapowanie Allegro', ['tenant' => $tenantId] + $report);
        return $report;
    }

    // ------------------------------------------------------------------
    // Auto-discovery: BaseLinker
    // ------------------------------------------------------------------

    public function syncFromBaseLinker(string $tenantId, BaseLinkerClient $bl, ?int $inventoryId = null, int $maxPages = 50): array
    {
        $report = ['scanned' => 0, 'inserted' => 0, 'updated' => 0, 'skipped' => 0, 'no_sku' => 0, 'errors' => []];
        $seen = [];

        for ($page = 1; $page <= $maxPages; $page++) {
            try {
                $products = $bl->getInventoryProductsList($inventoryId, $page);
            } catch (Throwable $e) {
                $report['errors'][] = $e->getMessage();
                break;
            }

            if ($products === []) {
                break;
            }

            // Warianty mają własne SKU — pobieramy szczegóły paczkami.
            $details = [];
            try {
                $details = $bl->getInventoryProductsData(array_keys($products), $inventoryId);
            } catch (Throwable $e) {
                $report['errors'][] = 'Szczegóły produktów: ' . $e->getMessage();
            }

            foreach ($products as $productId => $product) {
                $report['scanned']++;

                $productId = (string) $productId;
                $detail = $details[$productId] ?? [];
                $variants = $detail['variants'] ?? [];

                if (is_array($variants) && $variants !== []) {
                    foreach ($variants as $variantId => $variant) {
                        $sku = trim((string) ($variant['sku'] ?? ''));
                        if ($sku === '') {
                            $report['no_sku']++;
                            continue;
                        }
                        try {
                            $report[$this->upsert(
                                $tenantId, $sku, 'baselinker', $productId, (string) $variantId,
                                'auto', (string) ($variant['name'] ?? $product['name'] ?? '')
                            )]++;
                            $seen[] = $productId . ':' . $variantId;
                        } catch (Throwable $e) {
                            $report['errors'][] = "Produkt {$productId}/{$variantId}: " . $e->getMessage();
                        }
                    }
                    continue;
                }

                $sku = trim((string) ($product['sku'] ?? $detail['sku'] ?? ''));
                if ($sku === '') {
                    $report['no_sku']++;
                    continue;
                }

                try {
                    $report[$this->upsert(
                        $tenantId, $sku, 'baselinker', $productId, '0',
                        'auto', (string) ($product['name'] ?? '')
                    )]++;
                    $seen[] = $productId . ':0';
                } catch (Throwable $e) {
                    $report['errors'][] = "Produkt {$productId}: " . $e->getMessage();
                }
            }
        }

        $report['deactivated'] = $this->deactivateUnseen($tenantId, 'baselinker', $seen, true);

        $this->logger->info('Auto-mapowanie BaseLinker', ['tenant' => $tenantId] + $report);
        return $report;
    }

    /**
     * Dezaktywuje wpisy `auto`, których bieżący przebieg nie zobaczył.
     * Wpisy manual/csv zostawiamy nietknięte.
     */
    private function deactivateUnseen(string $tenantId, string $channel, array $seenRefs, bool $composite = false): int
    {
        if ($seenRefs === []) {
            // Pusty przebieg (np. błąd API) — nie dezaktywujemy niczego,
            // inaczej awaria kanału wyłączyłaby całą synchronizację.
            return 0;
        }

        $stmt = $this->pdo->prepare(
            "SELECT id, external_ref, variant_ref FROM sku_map
              WHERE tenant_id = ? AND channel = ? AND origin = 'auto' AND active = 1"
        );
        $stmt->execute([$tenantId, $channel]);

        $seenSet = array_flip($seenRefs);
        $toDeactivate = [];

        foreach ($stmt->fetchAll() as $row) {
            $key = $composite
                ? $row['external_ref'] . ':' . $row['variant_ref']
                : (string) $row['external_ref'];

            if (!isset($seenSet[$key])) {
                $toDeactivate[] = (int) $row['id'];
            }
        }

        if ($toDeactivate === []) {
            return 0;
        }

        foreach (array_chunk($toDeactivate, 500) as $chunk) {
            $ph = implode(',', array_fill(0, count($chunk), '?'));
            $this->pdo->prepare(
                "UPDATE sku_map SET active = 0, updated_at = datetime('now') WHERE id IN ({$ph})"
            )->execute($chunk);
        }

        return count($toDeactivate);
    }

    // ------------------------------------------------------------------
    // Import CSV
    // ------------------------------------------------------------------

    /**
     * Import z CSV. Oczekiwane kolumny (nagłówek wymagany):
     *   sku;channel;external_ref;variant_ref;title
     *
     * Separator wykrywany automatycznie (`;` albo `,`), BOM usuwany.
     */
    public function importCsv(string $tenantId, string $csvContent, string $origin = 'csv'): array
    {
        $report = ['rows' => 0, 'inserted' => 0, 'updated' => 0, 'skipped' => 0, 'errors' => []];

        $csvContent = preg_replace('/^\xEF\xBB\xBF/', '', $csvContent) ?? $csvContent;
        $lines = preg_split('/\r\n|\r|\n/', trim($csvContent)) ?: [];

        if (count($lines) < 2) {
            throw new RuntimeException('Plik CSV jest pusty albo zawiera tylko nagłówek.');
        }

        $delimiter = substr_count($lines[0], ';') >= substr_count($lines[0], ',') ? ';' : ',';

        $header = array_map(
            static fn($h) => strtolower(trim((string) $h)),
            str_getcsv($lines[0], $delimiter)
        );

        $required = ['sku', 'channel', 'external_ref'];
        foreach ($required as $col) {
            if (!in_array($col, $header, true)) {
                throw new RuntimeException(
                    "Brak wymaganej kolumny \"{$col}\". Oczekiwany nagłówek: sku{$delimiter}channel{$delimiter}external_ref{$delimiter}variant_ref{$delimiter}title"
                );
            }
        }

        $idx = array_flip($header);

        $this->pdo->beginTransaction();
        try {
            foreach (array_slice($lines, 1) as $lineNo => $line) {
                if (trim($line) === '') {
                    continue;
                }
                $report['rows']++;

                $cells = str_getcsv($line, $delimiter);
                $get = static fn(string $name, string $default = '') =>
                    isset($idx[$name], $cells[$idx[$name]]) ? trim((string) $cells[$idx[$name]]) : $default;

                try {
                    $result = $this->upsert(
                        $tenantId,
                        $get('sku'),
                        strtolower($get('channel')),
                        $get('external_ref'),
                        $get('variant_ref', '0') !== '' ? $get('variant_ref', '0') : '0',
                        $origin,
                        $get('title') !== '' ? $get('title') : null
                    );
                    $report[$result]++;
                } catch (Throwable $e) {
                    // Numeracja od 2, bo wiersz 1 to nagłówek.
                    $report['errors'][] = 'Wiersz ' . ($lineNo + 2) . ': ' . $e->getMessage();
                }
            }
            $this->pdo->commit();
        } catch (Throwable $e) {
            $this->pdo->rollBack();
            throw $e;
        }

        $this->logger->info('Import CSV mapowań', ['tenant' => $tenantId] + $report);
        return $report;
    }

    /** Eksport do CSV — kopia zapasowa mapowań. */
    public function exportCsv(string $tenantId): string
    {
        $stmt = $this->pdo->prepare(
            'SELECT sku, channel, external_ref, variant_ref, title, origin, active
               FROM sku_map WHERE tenant_id = ? ORDER BY sku, channel'
        );
        $stmt->execute([$tenantId]);

        $out = fopen('php://temp', 'r+');
        fputcsv($out, ['sku', 'channel', 'external_ref', 'variant_ref', 'title', 'origin', 'active'], ';');
        foreach ($stmt->fetchAll() as $row) {
            fputcsv($out, array_values($row), ';');
        }
        rewind($out);
        $csv = stream_get_contents($out) ?: '';
        fclose($out);

        return "\xEF\xBB\xBF" . $csv; // BOM — żeby Excel poprawnie odczytał UTF-8
    }
}
