<?php
declare(strict_types=1);

/**
 * Rejestracja agenta desktopowego i wygenerowanie klucza API.
 *   php cloud_hub/bin/register_agent.php <tenant_id> <nazwa_agenta>
 *
 * Klucz wyświetlany jest RAZ — w bazie ląduje wyłącznie jego HMAC.
 */

use Hub\Database;
use Hub\Security\AgentAuth;

require __DIR__ . '/../src/autoload.php';

$config = require __DIR__ . '/../config/config.php';

$tenantId = $argv[1] ?? '';
$name     = $argv[2] ?? '';

if ($tenantId === '' || $name === '') {
    fwrite(STDERR, "Użycie: php register_agent.php <tenant_id> <nazwa_agenta>\n");
    exit(1);
}

if (($config['security']['api_key_pepper'] ?? '') === 'zmien-mnie-w-produkcji') {
    fwrite(STDERR, "UWAGA: HUB_API_KEY_PEPPER ma wartość domyślną. Ustaw własną przed produkcją.\n");
}

try {
    $pdo = Database::connect($config);
    Database::migrate($pdo);

    $auth = new AgentAuth($pdo, $config['security']['api_key_pepper']);
    $key  = $auth->register($tenantId, $name);

    echo "Agent zarejestrowany.\n";
    echo "  tenant_id : {$tenantId}\n";
    echo "  nazwa     : {$name}\n";
    echo "  API KEY   : {$key}\n";
    echo "\nWklej powyższy klucz w zakładce \"Konto Cloud\" aplikacji desktopowej.\n";
    echo "Nie zostanie pokazany ponownie.\n";
} catch (Throwable $e) {
    fwrite(STDERR, 'BŁĄD: ' . $e->getMessage() . "\n");
    exit(1);
}
