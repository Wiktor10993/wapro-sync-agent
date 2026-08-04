<?php
declare(strict_types=1);

namespace Hub\Clients;

use Hub\Support\Logger;
use RuntimeException;

/**
 * Klient BaseLinker API (connector.php).
 *
 * BaseLinker przyjmuje POST x-www-form-urlencoded z polami:
 *   method     — nazwa metody
 *   parameters — JSON z parametrami
 * oraz nagłówkiem X-BLToken.
 *
 * Odpowiedź zawsze HTTP 200 — o powodzeniu decyduje pole "status"
 * ('SUCCESS' albo 'ERROR' + error_code / error_message). Dlatego nie wolno
 * polegać na kodzie HTTP.
 */
final class BaseLinkerClient
{
    private HttpClient $http;

    public function __construct(
        private array $config,
        private Logger $logger
    ) {
        $this->http = new HttpClient((int) ($config['timeout'] ?? 20));
    }

    public function call(string $method, array $parameters = []): array
    {
        $token = (string) ($this->config['token'] ?? '');
        if ($token === '') {
            throw new RuntimeException('Brak BASELINKER_TOKEN w konfiguracji.');
        }

        $res = $this->http->request(
            'POST',
            (string) $this->config['endpoint'],
            [
                'X-BLToken'    => $token,
                'Content-Type' => 'application/x-www-form-urlencoded',
            ],
            http_build_query([
                'method'     => $method,
                'parameters' => json_encode($parameters, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
            ])
        );

        if ($res['status'] !== 200) {
            throw new RuntimeException("BaseLinker {$method}: HTTP {$res['status']}");
        }

        $data = $this->http->decodeJson($res['body']);

        if (($data['status'] ?? '') !== 'SUCCESS') {
            throw new RuntimeException(sprintf(
                'BaseLinker %s zwrócił błąd [%s]: %s',
                $method,
                $data['error_code'] ?? 'UNKNOWN',
                $data['error_message'] ?? $res['body']
            ));
        }

        return $data;
    }

    /**
     * Aktualizacja stanów w katalogu produktów.
     *
     * @param array<int,array{product_id:string|int, variant_id?:string|int, quantity:int}> $items
     */
    public function setInventoryProductsQuantities(array $items, ?int $inventoryId = null, ?string $warehouseId = null): array
    {
        if ($items === []) {
            return ['status' => 'SUCCESS', 'skipped' => true];
        }

        $inventoryId ??= (int) ($this->config['inventory_id'] ?? 0);
        $warehouseId ??= (string) ($this->config['warehouse_id'] ?? 'bl_1');

        if ($inventoryId <= 0) {
            throw new RuntimeException('Nie ustawiono BASELINKER_INVENTORY_ID.');
        }

        // Limit API: 1000 produktów na wywołanie. Dzielimy paczkę.
        $results = [];
        foreach (array_chunk($items, 1000) as $chunk) {
            $products = [];
            foreach ($chunk as $item) {
                $products[] = [
                    'product_id'  => (string) $item['product_id'],
                    'variant_id'  => (string) ($item['variant_id'] ?? '0'),
                    $warehouseId  => max(0, (int) $item['quantity']),
                ];
            }

            $results[] = $this->call('setInventoryProductsQuantities', [
                'inventory_id' => $inventoryId,
                'products'     => $products,
            ]);
        }

        $this->logger->info('BaseLinker: zaktualizowano stany', [
            'count'        => count($items),
            'inventory_id' => $inventoryId,
        ]);

        return ['status' => 'SUCCESS', 'batches' => count($results)];
    }

    /**
     * Lista produktów w katalogu — źródło auto-mapowania SKU.
     * API zwraca po 1000 produktów na stronę.
     *
     * @return array<string,array> klucz = product_id
     */
    public function getInventoryProductsList(?int $inventoryId = null, int $page = 1): array
    {
        $inventoryId ??= (int) ($this->config['inventory_id'] ?? 0);
        if ($inventoryId <= 0) {
            throw new RuntimeException('Nie ustawiono BASELINKER_INVENTORY_ID.');
        }

        $res = $this->call('getInventoryProductsList', [
            'inventory_id' => $inventoryId,
            'page'         => max(1, $page),
        ]);

        return is_array($res['products'] ?? null) ? $res['products'] : [];
    }

    /**
     * Szczegóły produktów (warianty, SKU wariantów).
     *
     * @param array<int,string|int> $productIds
     */
    public function getInventoryProductsData(array $productIds, ?int $inventoryId = null): array
    {
        if ($productIds === []) {
            return [];
        }
        $inventoryId ??= (int) ($this->config['inventory_id'] ?? 0);

        $out = [];
        foreach (array_chunk($productIds, 1000) as $chunk) {
            $res = $this->call('getInventoryProductsData', [
                'inventory_id' => $inventoryId,
                'products'     => array_values(array_map('strval', $chunk)),
            ]);
            foreach (($res['products'] ?? []) as $id => $data) {
                $out[(string) $id] = $data;
            }
        }

        return $out;
    }

    /** Lista katalogów (inventories) — do wyboru w panelu. */
    public function getInventories(): array
    {
        $res = $this->call('getInventories');
        return $res['inventories'] ?? [];
    }

    /**
     * Pobranie zamówień — fallback, gdy klient nie może skonfigurować webhooka.
     *
     * @param int $dateFrom unix timestamp
     */
    public function getOrders(int $dateFrom, ?int $statusId = null, bool $getUnconfirmed = false): array
    {
        $params = [
            'date_confirmed_from' => $dateFrom,
            'get_unconfirmed_orders' => $getUnconfirmed,
        ];
        if ($statusId !== null) {
            $params['status_id'] = $statusId;
        }

        $res = $this->call('getOrders', $params);
        return $res['orders'] ?? [];
    }
}
