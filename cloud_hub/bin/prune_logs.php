<?php
declare(strict_types=1);

/**
 * Cron: sprzątanie starych danych.
 *   php cloud_hub/bin/prune_logs.php <tenant_id> [dni=30]
 *
 * Usuwa: stare action_logs, zamówienia zamknięte (synced/skipped) starsze niż
 * okno, zakończone job_runs, wygasłe sesje i stany OAuth.
 *
 * Uwaga: `action_logs` są podstawą Anti-Loop, ale tylko w oknie kilku minut —
 * czyszczenie po 30 dniach jest bezpieczne i utrzymuje bazę w rozsądnym rozmiarze.
 */

use Hub\Database;
use Hub\Support\JobRunner;
use Hub\Support\Logger;

require __DIR__ . '/../src/autoload.php';

$config = require __DIR__ . '/../config/config.php';
$logger = new Logger($config['logging']['path'], $config['logging']['level']);

$tenantId = $argv[1] ?? (getenv('HUB_TENANT_ID') ?: '');
$days     = max(7, (int) ($argv[2] ?? 30));

if ($tenantId === '') {
    fwrite(STDERR, "Użycie: php prune_logs.php <tenant_id> [dni=30]\n");
    exit(1);
}

$pdo = Database::connect($config);
Database::migrate($pdo);

$runner = new JobRunner($pdo, $logger);

exit($runner->run($tenantId, 'prune_logs', static function () use ($pdo, $tenantId, $days): array {
    $cutoff = sprintf('-%d days', $days);
    $out = [];

    $stmt = $pdo->prepare("DELETE FROM action_logs WHERE tenant_id = ? AND created_at < datetime('now', ?)");
    $stmt->execute([$tenantId, $cutoff]);
    $out['action_logs'] = $stmt->rowCount();

    $stmt = $pdo->prepare(
        "DELETE FROM order_queue
          WHERE tenant_id = ? AND status IN ('synced','skipped') AND updated_at < datetime('now', ?)"
    );
    $stmt->execute([$tenantId, $cutoff]);
    $out['order_queue'] = $stmt->rowCount();

    $stmt = $pdo->prepare(
        "DELETE FROM job_runs WHERE tenant_id = ? AND started_at < datetime('now', ?) AND status != 'running'"
    );
    $stmt->execute([$tenantId, $cutoff]);
    $out['job_runs'] = $stmt->rowCount();

    $out['sessions'] = $pdo->exec("DELETE FROM admin_sessions WHERE expires_at < datetime('now')");
    $out['oauth_states'] = $pdo->exec("DELETE FROM oauth_states WHERE expires_at < datetime('now')");

    // Odzyskanie miejsca po masowych DELETE.
    $pdo->exec('VACUUM');

    return $out;
}));
