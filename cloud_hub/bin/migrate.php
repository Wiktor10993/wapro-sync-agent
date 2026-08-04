<?php
declare(strict_types=1);

/**
 * Inicjalizacja / migracja bazy SQLite.
 *   php cloud_hub/bin/migrate.php
 */

use Hub\Database;

require __DIR__ . '/../src/autoload.php';

$config = require __DIR__ . '/../config/config.php';

try {
    $pdo = Database::connect($config);
    $version = Database::migrate($pdo);

    $tables = $pdo->query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )->fetchAll(PDO::FETCH_COLUMN);

    echo "Baza: {$config['database']['path']}\n";
    echo "Wersja schematu: {$version}\n";
    echo "Tabele: " . implode(', ', $tables) . "\n";
} catch (Throwable $e) {
    fwrite(STDERR, 'BŁĄD migracji: ' . $e->getMessage() . "\n");
    exit(1);
}
