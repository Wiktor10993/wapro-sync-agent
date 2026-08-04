<?php
declare(strict_types=1);

/**
 * Cron: nasłuch zamówień Allegro.
 *
 *   * * * * * php /sciezka/cloud_hub/bin/poll_allegro_events.php <tenant_id>
 *
 * Allegro udostępnia strumień /order/events z kursorem. Ostatni przetworzony
 * event trzymamy w `sync_cursors` — restart procesu nie gubi ani nie duplikuje
 * zamówień. Lock plikowy i wpis w `job_runs` obsługuje JobRunner.
 */

use Hub\Clients\AllegroClient;
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
    fwrite(STDERR, "Użycie: php poll_allegro_events.php <tenant_id>\n");
    exit(1);
}

/** Typy zdarzeń oznaczające zamówienie gotowe do realizacji. */
const INTERESTING_EVENTS = ['BOUGHT', 'READY_FOR_PROCESSING'];

$pdo = Database::connect($config);
Database::migrate($pdo);

$runner = new JobRunner($pdo, $logger);

exit($runner->run($tenantId, 'poll_allegro_events', static function () use ($pdo, $config, $logger, $tenantId): array {
    $cfg = (new TenantSettings($pdo))->mergeChannelConfig($tenantId, $config);

    $allegro  = new AllegroClient($pdo, $cfg['allegro'], $logger);
    $queue    = new OrderQueue($pdo);
    $antiLoop = new AntiLoop($pdo, (int) $cfg['anti_loop']['echo_window_seconds']);

    // --- kursor ---------------------------------------------------------
    $stmt = $pdo->prepare('SELECT value FROM sync_cursors WHERE tenant_id = ? AND name = ?');
    $stmt->execute([$tenantId, 'allegro_order_events']);
    $cursorValue = $stmt->fetchColumn();
    $cursor = ($cursorValue === false || $cursorValue === null || $cursorValue === '')
        ? null
        : (string) $cursorValue;

    $events = JobRunner::retry(static fn() => $allegro->getOrderEvents($tenantId, $cursor, 100));

    if ($events === []) {
        return ['events' => 0, 'queued' => 0];
    }

    $queued = 0;
    $failed = 0;
    $lastEventId = $cursor;

    foreach ($events as $event) {
        // Kursor przesuwamy dla KAŻDEGO zdarzenia, także nieinteresującego —
        // inaczej strumień zatrzymałby się na pierwszym zdarzeniu innego typu.
        if (!empty($event['id'])) {
            $lastEventId = (string) $event['id'];
        }

        $type = (string) ($event['type'] ?? '');
        if (!in_array($type, INTERESTING_EVENTS, true)) {
            continue;
        }

        $checkoutFormId = (string) ($event['order']['checkoutForm']['id'] ?? '');
        if ($checkoutFormId === '') {
            continue;
        }

        try {
            $order = JobRunner::retry(static fn() => $allegro->getCheckoutForm($tenantId, $checkoutFormId));
        } catch (Throwable $e) {
            $failed++;
            $logger->error('Allegro: nie udało się pobrać checkout-form', [
                'id'  => $checkoutFormId,
                'err' => $e->getMessage(),
            ]);
            $antiLoop->record(
                $tenantId, 'order', $checkoutFormId, 'allegro', 'inbound', 'allegro',
                null, null, 'error', $e->getMessage()
            );
            continue;
        }

        $added = $queue->enqueue(
            $tenantId,
            'allegro',
            $checkoutFormId,
            $order,
            (string) ($event['id'] ?? ''),
            isset($event['occurredAt'])
                ? gmdate('Y-m-d H:i:s', (int) strtotime((string) $event['occurredAt']))
                : null
        );

        $antiLoop->record(
            $tenantId, 'order', $checkoutFormId, 'allegro', 'inbound', 'allegro',
            null, null, $added ? 'ok' : 'skipped',
            $added ? "Event {$type} → kolejka." : 'Duplikat.'
        );

        if ($added) {
            $queued++;
        }
    }

    if ($lastEventId !== null && $lastEventId !== $cursor) {
        $pdo->prepare(
            "INSERT INTO sync_cursors (tenant_id, name, value, updated_at)
             VALUES (?, 'allegro_order_events', ?, datetime('now'))
             ON CONFLICT(tenant_id, name) DO UPDATE SET
                value = excluded.value, updated_at = excluded.updated_at"
        )->execute([$tenantId, $lastEventId]);
    }

    return [
        'events' => count($events),
        'queued' => $queued,
        'failed' => $failed,
        'cursor' => $lastEventId,
    ];
}));
