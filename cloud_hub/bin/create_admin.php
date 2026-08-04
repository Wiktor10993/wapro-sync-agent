<?php
declare(strict_types=1);

/**
 * Zakładanie konta do panelu administracyjnego.
 *   php cloud_hub/bin/create_admin.php <tenant_id> <login> [hasło]
 *
 * Bez podania hasła skrypt zapyta o nie interaktywnie (bez echa na terminalu).
 */

use Hub\Database;
use Hub\Security\AdminAuth;

require __DIR__ . '/../src/autoload.php';

$config = require __DIR__ . '/../config/config.php';

$tenantId = $argv[1] ?? '';
$login    = $argv[2] ?? '';
$password = $argv[3] ?? '';

if ($tenantId === '' || $login === '') {
    fwrite(STDERR, "Użycie: php create_admin.php <tenant_id> <login> [hasło]\n");
    exit(1);
}

if ($password === '') {
    echo "Hasło (min. 10 znaków): ";
    // Wyłączamy echo terminala, żeby hasło nie zostało w historii i na ekranie.
    if (function_exists('shell_exec') && DIRECTORY_SEPARATOR === '/') {
        shell_exec('stty -echo 2>/dev/null');
    }
    $password = trim((string) fgets(STDIN));
    if (function_exists('shell_exec') && DIRECTORY_SEPARATOR === '/') {
        shell_exec('stty echo 2>/dev/null');
    }
    echo "\n";
}

try {
    $pdo = Database::connect($config);
    Database::migrate($pdo);

    $auth = new AdminAuth($pdo);
    $id = $auth->createUser($tenantId, $login, $password, $login);

    echo "Konto utworzone (id={$id}).\n";
    echo "  tenant : {$tenantId}\n";
    echo "  login  : {$login}\n";
    echo "\nZaloguj się pod adresem: https://twoj-hub/admin\n";
} catch (Throwable $e) {
    fwrite(STDERR, 'BŁĄD: ' . $e->getMessage() . "\n");
    exit(1);
}
