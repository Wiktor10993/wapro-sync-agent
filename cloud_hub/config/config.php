<?php
declare(strict_types=1);

/**
 * Konfiguracja Cloud Huba.
 * Wartości wrażliwe czytamy ze zmiennych środowiskowych (getenv),
 * z sensownymi wartościami domyślnymi dla środowiska developerskiego.
 */

$root = dirname(__DIR__);

return [
    'app' => [
        'env'   => getenv('HUB_ENV') ?: 'production',
        'debug' => (getenv('HUB_DEBUG') ?: '0') === '1',
        // Maksymalna liczba pozycji stanów w jednym POST /api/sync-inventory
        'max_inventory_batch' => (int) (getenv('HUB_MAX_BATCH') ?: 1000),
    ],

    'database' => [
        // Plik SQLite. MUSI leżeć poza katalogiem public/.
        'path' => getenv('HUB_DB_PATH') ?: $root . '/storage/hub.sqlite',
        // Czas oczekiwania na zwolnienie blokady zapisu (ms)
        'busy_timeout_ms' => 5000,
    ],

    'security' => [
        // Pieprz do HMAC kluczy API agentów. Wygeneruj: openssl rand -hex 32
        'api_key_pepper' => getenv('HUB_API_KEY_PEPPER') ?: 'zmien-mnie-w-produkcji',
        // Sekret do weryfikacji podpisu webhooka BaseLinkera
        'baselinker_webhook_secret' => getenv('HUB_BL_WEBHOOK_SECRET') ?: '',
    ],

    'anti_loop' => [
        // Okno czasowe (sekundy), w którym przychodzące zdarzenie o tej samej
        // wartości co nasz wcześniejszy push jest traktowane jako echo.
        'echo_window_seconds' => (int) (getenv('HUB_ECHO_WINDOW') ?: 180),
        // Jeśli stan dla SKU nie zmienił się od ostatniego pushu — nie wysyłamy ponownie.
        'skip_unchanged' => true,
    ],

    'allegro' => [
        'api_base'   => getenv('ALLEGRO_API_BASE') ?: 'https://api.allegro.pl',
        'auth_base'  => getenv('ALLEGRO_AUTH_BASE') ?: 'https://allegro.pl/auth/oauth',
        'client_id'  => getenv('ALLEGRO_CLIENT_ID') ?: '',
        'client_secret' => getenv('ALLEGRO_CLIENT_SECRET') ?: '',
        'accept_header' => 'application/vnd.allegro.public.v1+json',
        'timeout'    => 20,
    ],

    'baselinker' => [
        'endpoint' => getenv('BASELINKER_ENDPOINT') ?: 'https://api.baselinker.com/connector.php',
        'token'    => getenv('BASELINKER_TOKEN') ?: '',
        // ID katalogu (inventory) w BaseLinkerze oraz ID magazynu docelowego.
        'inventory_id' => (int) (getenv('BASELINKER_INVENTORY_ID') ?: 0),
        'warehouse_id' => getenv('BASELINKER_WAREHOUSE_ID') ?: 'bl_1',
        'timeout'  => 20,
    ],

    'logging' => [
        'path'  => getenv('HUB_LOG_PATH') ?: $root . '/storage/hub.log',
        'level' => getenv('HUB_LOG_LEVEL') ?: 'info',
    ],
];
