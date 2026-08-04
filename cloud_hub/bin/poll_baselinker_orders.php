<?php
declare(strict_types=1);

/**
 * Cron: pobieranie zamówień z BaseLinkera.
 *
 *   php cloud_hub/bin/poll_baselinker_orders.php <tenant_id>
 *
 * To ścieżka zapasowa wobec webhooka — przydatna, gdy klient nie może
 * skonfigurować webhooka albo gdy hub był chwilowo niedostępny i zdarzenia
 * przepadły. Kursor (`baselinker_orders_since`) chroni przed ponownym
 * przetwarzaniem tych samych zamówień; dodatkowo `INSERT OR IGNORE`
 * w kolejce wychwytuje duplikaty.
 */

use Hub\Clients\BaseLinkerClient;
use Hub\Database;
use Hub\Services\AntiLoop;
use Hub\Services\OrderQueue;
use Hub\Services\TenantSettings;
use Hub\Support\JobRunner;
use Hub\Support\Logger;

require __DIR__ . '/../src/autoload.php';

$config = require __DIR__ . '/../config/config.php';
$logger = new Logger($config['logging']['path'], $config['logging']['level']);

$tenantId = $argv[1] ?? (getenv('HUB_TENANT_ID') ?: '');
if ($tenantId === '') {
    fwrite(STDERR, "Użycie: php poll_baselinker_orders.php <tenant_id>\n");
    exit(1);
}

$pdo = Database::connect($config);
Database::migrate($pdo);

$runner = new JobRunner($pdo, $logger);

exit($runner->run($tenantId, 'poll_baselinker_orders', static function () use ($pdo, $config, $logger, $tenantId): array {
    $settings = new TenantSettings($pdo);
    $cfg      = $settings->mergeChannelConfig($tenantId, $config);

    $bl       = new BaseLinkerClient($cfg['baselinker'], $logger);
    $queue    = new OrderQueue($pdo);
    $antiLoop = new AntiLoop($pdo, (int) $cfg['anti_loop']['echo_window_seconds']);

    // --- kursor ---------------------------------------------------------
    $stmt = $pdo->prepare('SELECT value FROM sync_cursors WHERE tenant_id = ? AND name = ?');
    $stmt->execute([$tenantId, 'baselinker_orders_since']);
    $cursor = $stmt->fetchColumn();

    // Pierwsze uruchomienie: bierzemy ostatnią dobę, nie całą historię.
    $since = $cursor !== false && is_numeric($cursor) ? (int) $cursor : time() - 86400;

    $orders = JobRunner::retry(static fn() => $bl->getOrders($since));

    $queued = 0;
    $skipped = 0;
    $maxDate = $since;

    foreach ($orders as $order) {
        $externalId = (string) ($order['order_id'] ?? '');
        if ($externalId === '') {
            continue;
        }

        $confirmed = (int) ($order['date_confirmed'] ?? $order['date_add'] ?? 0);
        if ($confirmed > $maxDate) {
            $maxDate = $confirmed;
        }

        $added = $queue->enqueue(
            $tenantId,
            'baselinker',
            $externalId,
            $order,
            null,
            $confirmed > 0 ? gmdate('Y-m-d H:i:s', $confirmed) : null
        );

        $antiLoop->record(
            $tenantId, 'order', $externalId, 'baselinker', 'inbound', 'baselinker',
            null, null, $added ? 'ok' : 'skipped',
            $added ? 'Poller → kolejka.' : 'Duplikat (webhook już go dodał).'
        );

        $added ? $queued++ : $skipped++;
    }

    // +1 sekunda, żeby nie pobierać w kółko ostatniego zamówienia.
    $pdo->prepare(
        "INSERT INTO sync_cursors (tenant_id, name, value, updated_at)
         VALUES (?, 'baselinker_orders_since', ?, datetime('now'))
         ON CONFLICT(tenant_id, name) DO UPDATE SET
            value = excluded.value, updated_at = excluded.updated_at"
    )->execute([$tenantId, (string) ($maxDate + 1)]);

    return [
        'fetched' => count($orders),
        'queued'  => $queued,
        'skipped' => $skipped,
        'cursor'  => gmdate('c', $maxDate + 1),
    ];
}));
