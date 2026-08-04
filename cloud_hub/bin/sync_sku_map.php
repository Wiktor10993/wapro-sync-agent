<?php
declare(strict_types=1);

/**
 * Cron: automatyczne odświeżanie mapowań SKU.
 *   php cloud_hub/bin/sync_sku_map.php <tenant_id> [allegro|baselinker|both]
 *
 * Zalecana częstotliwość: raz na dobę. Częściej nie ma sensu — oferty
 * nie zmieniają identyfikatorów, a każdy przebieg to setki wywołań API.
 */

use Hub\Clients\AllegroClient;
use Hub\Clients\BaseLinkerClient;
use Hub\Database;
use Hub\Services\SkuMapService;
use Hub\Services\TenantSettings;
use Hub\Support\JobRunner;
use Hub\Support\Logger;

require __DIR__ . '/../src/autoload.php';

$config = require __DIR__ . '/../config/config.php';
$logger = new Logger($config['logging']['path'], $config['logging']['level']);

$tenantId = $argv[1] ?? (getenv('HUB_TENANT_ID') ?: '');
$which    = strtolower($argv[2] ?? 'both');

if ($tenantId === '') {
    fwrite(STDERR, "Użycie: php sync_sku_map.php <tenant_id> [allegro|baselinker|both]\n");
    exit(1);
}

$pdo = Database::connect($config);
Database::migrate($pdo);

$runner = new JobRunner($pdo, $logger);

exit($runner->run($tenantId, 'sync_sku_map', static function () use ($pdo, $config, $logger, $tenantId, $which): array {
    $service  = new SkuMapService($pdo, $logger);
    $settings = new TenantSettings($pdo);
    $cfg      = $settings->mergeChannelConfig($tenantId, $config);

    $summary = [];

    if ($which === 'allegro' || $which === 'both') {
        $summary['allegro'] = $service->syncFromAllegro(
            $tenantId,
            new AllegroClient($pdo, $cfg['allegro'], $logger)
        );
    }

    if ($which === 'baselinker' || $which === 'both') {
        $summary['baselinker'] = $service->syncFromBaseLinker(
            $tenantId,
            new BaseLinkerClient($cfg['baselinker'], $logger)
        );
    }

    // Redukujemy raport do liczb — pełne listy błędów są już w logu.
    foreach ($summary as $channel => $r) {
        $summary[$channel] = [
            'scanned'   => $r['scanned'] ?? 0,
            'inserted'  => $r['inserted'] ?? 0,
            'updated'   => $r['updated'] ?? 0,
            'no_sku'    => $r['no_sku'] ?? 0,
            'errors'    => count($r['errors'] ?? []),
        ];
    }

    return $summary;
}));
