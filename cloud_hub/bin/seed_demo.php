<?php
declare(strict_types=1);

/**
 * Dane demonstracyjne do testów lokalnych.
 *
 *   php cloud_hub/bin/seed_demo.php <tenant_id> [--orders=2] [--reset]
 *
 * Wstrzykuje do bazy huba:
 *   - mapowania SKU zgodne z atrapą bazy Wapro (przyklady/mock_wapro.sql),
 *   - przykładowe zamówienia z Allegro i BaseLinkera w kolejce.
 *
 * Dzięki temu można przejść cały przepływ SyncDown BEZ konta Allegro,
 * tokenu BaseLinkera i bez czekania na prawdziwą sprzedaż.
 *
 * NIE uruchamiaj na produkcji — wstawia fikcyjne zamówienia do kolejki.
 */

use Hub\Database;
use Hub\Services\SkuMapService;
use Hub\Support\Logger;

require __DIR__ . '/../src/autoload.php';

$config = require __DIR__ . '/../config/config.php';
$logger = new Logger($config['logging']['path'], $config['logging']['level']);

$tenantId = $argv[1] ?? '';
if ($tenantId === '' || str_starts_with($tenantId, '--')) {
    fwrite(STDERR, "Użycie: php seed_demo.php <tenant_id> [--orders=2] [--reset]\n");
    exit(1);
}

$args    = array_slice($argv, 2);
$reset   = in_array('--reset', $args, true);
$howMany = 2;
foreach ($args as $a) {
    if (preg_match('/^--orders=(\d+)$/', $a, $m)) {
        $howMany = max(1, min(20, (int) $m[1]));
    }
}

$pdo = Database::connect($config);
Database::migrate($pdo);

if ($reset) {
    $pdo->prepare("DELETE FROM order_queue WHERE tenant_id = ? AND external_id LIKE 'DEMO-%'")
        ->execute([$tenantId]);
    $pdo->prepare("DELETE FROM sku_map WHERE tenant_id = ? AND origin = 'csv'")
        ->execute([$tenantId]);
    $pdo->prepare('DELETE FROM inventory_state WHERE tenant_id = ?')->execute([$tenantId]);
    $pdo->prepare("DELETE FROM action_logs WHERE tenant_id = ?")->execute([$tenantId]);
    echo "Wyczyszczono dane demonstracyjne.\n";
}

// ---------------------------------------------------------------------------
// 1. Mapowania SKU — zgodne z atrapą bazy Wapro
// ---------------------------------------------------------------------------

$skuMap = new SkuMapService($pdo, $logger);

$mappings = [
    ['WIERT-06',        'allegro',    '10000000001', '0', 'Wiertło HSS 6 mm'],
    ['WIERT-08',        'allegro',    '10000000002', '0', 'Wiertło HSS 8 mm'],
    ['SRUB-M8',         'allegro',    '10000000003', '0', 'Śruba M8x40'],
    ['FARBA-BIALA-5L',  'baselinker', '5501',        '0', 'Farba biała 5 l'],
    ['FARBA-BIALA-10L', 'baselinker', '5502',        '0', 'Farba biała 10 l'],
    ['KOSZULKA-M',      'baselinker', '6001',        '1', 'Koszulka rozm. M'],
    ['KOSZULKA-L',      'baselinker', '6001',        '2', 'Koszulka rozm. L'],
];

$added = 0;
foreach ($mappings as [$sku, $channel, $ref, $variant, $title]) {
    $skuMap->upsert($tenantId, $sku, $channel, $ref, $variant, 'csv', $title);
    $added++;
}
echo "Mapowania SKU: {$added}\n";

// ---------------------------------------------------------------------------
// 2. Zamówienia demonstracyjne
// ---------------------------------------------------------------------------

/** Zamówienie w strukturze Allegro checkout-form. */
function demoAllegroOrder(int $n): array
{
    return [
        'id'        => "DEMO-ALLEGRO-{$n}",
        'boughtAt'  => gmdate('c', time() - $n * 3600),
        'messageToSeller' => $n === 1 ? 'Proszę o fakturę na firmę.' : '',
        'buyer' => [
            'login'       => 'jan_kowalski',
            'firstName'   => 'Jan',
            'lastName'    => 'Kowalski',
            'email'       => 'jan.kowalski@example.pl',
            'phoneNumber' => '600100200',
        ],
        'delivery' => [
            'address' => [
                'street'      => 'Długa 5/2',
                'zipCode'     => '00-001',
                'city'        => 'Warszawa',
                'countryCode' => 'PL',
            ],
            'method' => ['name' => 'Kurier DPD'],
            'cost'   => ['amount' => '15.99'],
        ],
        'lineItems' => [
            [
                'offer'    => ['id' => '10000000001', 'name' => 'Wiertło HSS 6 mm', 'external' => ['id' => 'WIERT-06']],
                'quantity' => 2 + $n,
                'price'    => ['amount' => '24.90'],
            ],
            [
                'offer'    => ['id' => '10000000003', 'name' => 'Śruba M8x40', 'external' => ['id' => 'SRUB-M8']],
                'quantity' => 50,
                'price'    => ['amount' => '0.45'],
            ],
            [
                // Celowo bez sygnatury i bez odpowiednika w kartotece —
                // sprawdza obsługę BRAK_ARTYKULU.
                'offer'    => ['id' => '99999999999', 'name' => 'Towar spoza kartoteki'],
                'quantity' => 1,
                'price'    => ['amount' => '9.99'],
            ],
        ],
        'summary' => ['totalToPay' => ['amount' => '108.28', 'currency' => 'PLN']],
    ];
}

/** Zamówienie w strukturze BaseLinkera. */
function demoBaseLinkerOrder(int $n): array
{
    return [
        'order_id'              => "DEMO-BL-{$n}",
        'date_confirmed'        => time() - $n * 5400,
        'currency'              => 'PLN',
        'email'                 => 'anna.nowak@example.pl',
        'phone'                 => '501200300',
        'user_comments'         => 'Prezent — proszę bez paragonu w paczce.',
        'invoice_company'       => $n % 2 === 0 ? 'ACME sp. z o.o.' : '',
        'invoice_nip'           => $n % 2 === 0 ? '5252445767' : '',
        'delivery_fullname'     => 'Anna Nowak',
        'delivery_address'      => 'Polna 12',
        'delivery_postcode'     => '31-000',
        'delivery_city'         => 'Kraków',
        'delivery_country_code' => 'PL',
        'delivery_method'       => 'InPost Paczkomat',
        'delivery_price'        => 12.99,
        'products' => [
            [
                'product_id'   => '5501',
                'sku'          => 'FARBA-BIALA-5L',
                'ean'          => '5901234000047',
                'name'         => 'Farba akrylowa biała 5 l',
                'quantity'     => 2,
                'price_brutto' => 89.00,
                'tax_rate'     => 23,
            ],
            [
                'product_id'   => '6001',
                'variant_id'   => '1',
                'sku'          => 'KOSZULKA-M',
                'ean'          => '5901234000061',
                'name'         => 'Koszulka bawełniana — rozm. M',
                'quantity'     => 3,
                'price_brutto' => 49.90,
                'tax_rate'     => 23,
            ],
        ],
    ];
}

$queued = 0;
$stmt = $pdo->prepare(
    'INSERT OR IGNORE INTO order_queue
        (tenant_id, source, external_id, event_id, payload_json, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?)'
);

for ($n = 1; $n <= $howMany; $n++) {
    foreach ([['allegro', demoAllegroOrder($n)], ['baselinker', demoBaseLinkerOrder($n)]] as [$source, $order]) {
        $externalId = $order['id'] ?? $order['order_id'];

        $stmt->execute([
            $tenantId,
            $source,
            $externalId,
            null,
            json_encode($order, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
            gmdate('Y-m-d H:i:s'),
        ]);

        if ($stmt->rowCount() > 0) {
            $queued++;
        }
    }
}

echo "Zamówienia w kolejce: {$queued} (pominięto duplikaty)\n";

// ---------------------------------------------------------------------------
// 3. Podsumowanie
// ---------------------------------------------------------------------------

$counts = $pdo->prepare('SELECT status, COUNT(*) AS c FROM order_queue WHERE tenant_id = ? GROUP BY status');
$counts->execute([$tenantId]);

echo "\nStan kolejki:\n";
foreach ($counts->fetchAll() as $row) {
    printf("  %-10s %d\n", $row['status'], $row['c']);
}

echo "\nGotowe. W agencie kliknij „Pobierz zamówienia teraz”.\n";
echo "Uwaga: dane są fikcyjne — nie uruchamiaj tego skryptu na produkcji.\n";
