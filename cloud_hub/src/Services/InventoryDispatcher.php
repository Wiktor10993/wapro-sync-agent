<?php
declare(strict_types=1);

namespace Hub\Services;

use Hub\Clients\AllegroClient;
use Hub\Clients\BaseLinkerClient;
use Hub\Support\Logger;
use PDO;
use Throwable;

/**
 * Rozdziela paczkę stanów z Wapro na kanały sprzedaży.
 *
 * Kolejność operacji jest istotna:
 *   1. filtr Anti-Loop (pomiń niezmienione),
 *   2. rozwiązanie SKU -> identyfikatory kanałowe (sku_map),
 *   3. LOG outbound PRZED wysyłką — inaczej webhook zwrotny może dotrzeć
 *      szybciej niż zdążymy zapisać ślad i zostanie uznany za zmianę z rynku,
 *   4. wysyłka,
 *   5. commit stanu tylko dla SKU, które faktycznie poszły na kanał.
 */
final class InventoryDispatcher
{
    public function __construct(
        private PDO $pdo,
        private AntiLoop $antiLoop,
        private AllegroClient $allegro,
        private BaseLinkerClient $baseLinker,
        private Logger $logger
    ) {}

    /**
     * @param array<int,array{sku:string, quantity:int, rowver?:string|null}> $items
     * @return array<string,mixed> raport wykonania
     */
    public function dispatch(string $tenantId, array $items, string $correlationId): array
    {
        $report = [
            'received'   => count($items),
            'skipped'    => 0,
            'unmapped'   => [],
            'allegro'    => ['offers' => 0, 'errors' => []],
            'baselinker' => ['products' => 0, 'errors' => []],
            'committed'  => 0,
        ];

        // --- 1. Filtr Anti-Loop -------------------------------------------
        $pending = [];
        foreach ($items as $item) {
            $sku = trim((string) $item['sku']);
            $qty = (int) $item['quantity'];

            if ($sku === '') {
                continue;
            }
            if ($this->antiLoop->isUnchanged($tenantId, $sku, $qty)) {
                $report['skipped']++;
                continue;
            }
            $pending[$sku] = ['sku' => $sku, 'quantity' => $qty, 'rowver' => $item['rowver'] ?? null];
        }

        if ($pending === []) {
            $this->logger->info('SyncUp: nic do wypchnięcia', ['tenant' => $tenantId, 'corr' => $correlationId]);
            return $report;
        }

        // --- 2. Mapowanie SKU ---------------------------------------------
        $map = $this->resolveMappings($tenantId, array_keys($pending));

        // --- 3. Log outbound PRZED wysyłką ---------------------------------
        foreach ($pending as $sku => $row) {
            $this->antiLoop->record(
                $tenantId, 'stock', $sku, 'hub', 'outbound', 'wapro_agent',
                AntiLoop::valueHash($tenantId, $sku, $row['quantity']),
                $row['quantity'], 'ok', null, $correlationId
            );
        }

        // --- 4. Wysyłka na kanały ------------------------------------------
        $delivered = [];

        // Allegro: grupujemy oferty po wartości stanu — jedna komenda na wartość.
        $byQuantity = [];
        foreach ($pending as $sku => $row) {
            foreach ($map['allegro'][$sku] ?? [] as $offerId) {
                $byQuantity[$row['quantity']][] = $offerId;
                $delivered[$sku] = true;
            }
        }

        foreach ($byQuantity as $qty => $offerIds) {
            try {
                $this->allegro->setOfferQuantity($tenantId, array_unique($offerIds), (int) $qty);
                $report['allegro']['offers'] += count($offerIds);
            } catch (Throwable $e) {
                $report['allegro']['errors'][] = $e->getMessage();
                $this->antiLoop->record(
                    $tenantId, 'stock', 'batch:' . $qty, 'allegro', 'outbound', 'wapro_agent',
                    null, (int) $qty, 'error', $e->getMessage(), $correlationId
                );
                // Oferty z tej paczki nie dotarły — nie wolno ich commitować.
                foreach ($offerIds as $offerId) {
                    $sku = $map['reverse_allegro'][$offerId] ?? null;
                    if ($sku !== null) {
                        unset($delivered[$sku]);
                    }
                }
            }
        }

        // BaseLinker: jeden batch na wszystko.
        $blItems = [];
        foreach ($pending as $sku => $row) {
            foreach ($map['baselinker'][$sku] ?? [] as $ref) {
                $blItems[] = [
                    'product_id' => $ref['external_ref'],
                    'variant_id' => $ref['variant_ref'],
                    'quantity'   => $row['quantity'],
                ];
                $delivered[$sku] = $delivered[$sku] ?? true;
            }
        }

        if ($blItems !== []) {
            try {
                $this->baseLinker->setInventoryProductsQuantities($blItems);
                $report['baselinker']['products'] = count($blItems);
            } catch (Throwable $e) {
                $report['baselinker']['errors'][] = $e->getMessage();
                $this->antiLoop->record(
                    $tenantId, 'stock', 'batch:baselinker', 'baselinker', 'outbound', 'wapro_agent',
                    null, null, 'error', $e->getMessage(), $correlationId
                );
            }
        }

        // SKU bez żadnego mapowania — raportujemy, żeby klient wiedział co skonfigurować.
        foreach ($pending as $sku => $_) {
            if (!isset($map['allegro'][$sku]) && !isset($map['baselinker'][$sku])) {
                $report['unmapped'][] = $sku;
            }
        }

        // --- 5. Commit stanu ------------------------------------------------
        foreach (array_keys($delivered) as $sku) {
            $this->antiLoop->commitState(
                $tenantId,
                (string) $sku,
                $pending[$sku]['quantity'],
                $pending[$sku]['rowver']
            );
            $report['committed']++;
        }

        $this->logger->info('SyncUp zakończony', [
            'tenant'    => $tenantId,
            'corr'      => $correlationId,
            'committed' => $report['committed'],
            'skipped'   => $report['skipped'],
            'unmapped'  => count($report['unmapped']),
        ]);

        return $report;
    }

    /**
     * @param array<int,string> $skus
     * @return array{allegro:array<string,array<int,string>>, baselinker:array<string,array<int,array{external_ref:string,variant_ref:string}>>, reverse_allegro:array<string,string>}
     */
    private function resolveMappings(string $tenantId, array $skus): array
    {
        $out = ['allegro' => [], 'baselinker' => [], 'reverse_allegro' => []];
        if ($skus === []) {
            return $out;
        }

        // SQLite ma limit ~999 parametrów — dzielimy zapytanie.
        foreach (array_chunk($skus, 500) as $chunk) {
            $placeholders = implode(',', array_fill(0, count($chunk), '?'));
            $stmt = $this->pdo->prepare(
                "SELECT sku, channel, external_ref, variant_ref
                   FROM sku_map
                  WHERE tenant_id = ? AND active = 1 AND sku IN ({$placeholders})"
            );
            $stmt->execute(array_merge([$tenantId], $chunk));

            foreach ($stmt->fetchAll() as $row) {
                $sku = (string) $row['sku'];
                if ($row['channel'] === 'allegro') {
                    $out['allegro'][$sku][] = (string) $row['external_ref'];
                    $out['reverse_allegro'][(string) $row['external_ref']] = $sku;
                } elseif ($row['channel'] === 'baselinker') {
                    $out['baselinker'][$sku][] = [
                        'external_ref' => (string) $row['external_ref'],
                        'variant_ref'  => (string) $row['variant_ref'],
                    ];
                }
            }
        }

        return $out;
    }
}
