<?php
declare(strict_types=1);

/**
 * Cloud Hub — front controller.
 *
 * Wszystkie żądania kierujemy tu przez .htaccess / nginx try_files.
 */

use Hub\Admin\Controller as AdminController;
use Hub\Clients\AllegroClient;
use Hub\Clients\BaseLinkerClient;
use Hub\Database;
use Hub\Http\Request;
use Hub\Http\Response;
use Hub\Security\AgentAuth;
use Hub\Services\AllegroOAuth;
use Hub\Services\AntiLoop;
use Hub\Services\InventoryDispatcher;
use Hub\Services\OrderQueue;
use Hub\Services\TenantSettings;
use Hub\Support\Logger;

require __DIR__ . '/../src/autoload.php';

$config = require __DIR__ . '/../config/config.php';

ini_set('display_errors', $config['app']['debug'] ? '1' : '0');
error_reporting(E_ALL);

$logger = new Logger($config['logging']['path'], $config['logging']['level']);

// Wyłapujemy WSZYSTKO — hub nigdy nie zwraca HTML-owego stack trace'a agentowi.
try {
    $pdo = Database::connect($config);
    Database::migrate($pdo);

    $method = Request::method();
    $path   = Request::path();

    // ------------------------------------------------------------------
    // GET /api/health — bez autoryzacji, do monitoringu
    // ------------------------------------------------------------------
    if ($method === 'GET' && $path === '/api/health') {
        Response::ok([
            'schema_version' => Database::SCHEMA_VERSION,
            'time'           => gmdate('c'),
        ]);
        exit;
    }

    // ------------------------------------------------------------------
    // POST /webhooks/baselinker — autoryzacja podpisem, nie kluczem agenta
    // ------------------------------------------------------------------
    if ($method === 'POST' && $path === '/webhooks/baselinker') {
        require __DIR__ . '/../src/Handlers/baselinker_webhook.php';
        exit;
    }

    // ------------------------------------------------------------------
    // GET /oauth/allegro/callback — adres powrotny OAuth.
    // Bez autoryzacji: to Allegro tu przekierowuje przeglądarkę użytkownika.
    // Bezpieczeństwo zapewnia jednorazowy, wygasający parametr `state`.
    // ------------------------------------------------------------------
    if ($method === 'GET' && $path === '/oauth/allegro/callback') {
        $oauth = new AllegroOAuth($pdo, $config['allegro'], $logger);

        $error = Request::query('error');
        if ($error !== null) {
            http_response_code(400);
            header('Content-Type: text/html; charset=utf-8');
            echo '<h1>Autoryzacja odrzucona</h1><p>Allegro zwróciło błąd: <code>'
                . htmlspecialchars($error . ' ' . (Request::query('error_description') ?? ''), ENT_QUOTES)
                . '</code></p><p><a href="/admin/settings">Wróć do ustawień</a></p>';
            exit;
        }

        try {
            $result = $oauth->callback(
                (string) (Request::query('code') ?? ''),
                (string) (Request::query('state') ?? '')
            );
            header('Location: /admin/settings', true, 302);
            $logger->info('OAuth callback OK', ['tenant' => $result['tenant_id']]);
        } catch (Throwable $e) {
            http_response_code(400);
            header('Content-Type: text/html; charset=utf-8');
            echo '<h1>Autoryzacja nieudana</h1><p>'
                . htmlspecialchars($e->getMessage(), ENT_QUOTES)
                . '</p><p><a href="/admin/settings">Spróbuj ponownie</a></p>';
        }
        exit;
    }

    // ------------------------------------------------------------------
    // /admin/* — panel administracyjny (własna sesja + CSRF)
    // ------------------------------------------------------------------
    if ($path === '/admin' || str_starts_with($path, '/admin/')) {
        $adminPath = trim(substr($path, strlen('/admin')), '/');
        (new AdminController($pdo, $config, $logger))->dispatch($adminPath, $method);
        exit;
    }

    // ------------------------------------------------------------------
    // Od tego miejsca wymagany klucz agenta
    // ------------------------------------------------------------------
    $auth  = new AgentAuth($pdo, $config['security']['api_key_pepper']);
    $agent = $auth->authenticate();

    if ($agent === null) {
        $logger->warning('Odrzucono żądanie bez ważnego klucza', [
            'path' => $path,
            'ip'   => $_SERVER['REMOTE_ADDR'] ?? '?',
        ]);
        Response::error('unauthorized', 'Nieprawidłowy lub brakujący klucz API agenta.', 401);
        exit;
    }

    $tenantId = $agent['tenant_id'];

    // ==================================================================
    // POST /api/sync-inventory  — PUSH stanów z Wapro
    // ==================================================================
    if ($method === 'POST' && $path === '/api/sync-inventory') {

        try {
            $body = Request::json();
        } catch (JsonException $e) {
            Response::error('bad_json', 'Ciało żądania nie jest poprawnym JSON-em: ' . $e->getMessage(), 400);
            exit;
        }

        $items = $body['items'] ?? null;
        if (!is_array($items)) {
            Response::error('bad_request', 'Brak pola "items" (tablica pozycji).', 422);
            exit;
        }

        $maxBatch = (int) $config['app']['max_inventory_batch'];
        if (count($items) > $maxBatch) {
            Response::error(
                'batch_too_large',
                "Paczka zawiera " . count($items) . " pozycji, limit to {$maxBatch}.",
                413,
                ['limit' => $maxBatch]
            );
            exit;
        }

        // --- walidacja i normalizacja ---------------------------------
        $normalized = [];
        $invalid    = [];

        foreach ($items as $idx => $item) {
            if (!is_array($item)) {
                $invalid[] = ['index' => $idx, 'reason' => 'pozycja nie jest obiektem'];
                continue;
            }
            $sku = isset($item['sku']) ? trim((string) $item['sku']) : '';
            if ($sku === '' || mb_strlen($sku) > 128) {
                $invalid[] = ['index' => $idx, 'reason' => 'puste lub zbyt długie SKU'];
                continue;
            }
            if (!isset($item['quantity']) || !is_numeric($item['quantity'])) {
                $invalid[] = ['index' => $idx, 'sku' => $sku, 'reason' => 'quantity nie jest liczbą'];
                continue;
            }
            $qty = (int) $item['quantity'];
            if ($qty < 0) {
                // Stan ujemny w Wapro (sprzedaż poniżej stanu) mapujemy na 0 —
                // rynki i tak nie przyjmą wartości ujemnej.
                $qty = 0;
            }

            $normalized[] = [
                'sku'      => $sku,
                'quantity' => $qty,
                'rowver'   => isset($item['rowver']) ? (string) $item['rowver'] : null,
            ];
        }

        if ($normalized === [] && $invalid !== []) {
            Response::error('validation_failed', 'Żadna pozycja nie przeszła walidacji.', 422, ['invalid' => $invalid]);
            exit;
        }

        $correlationId = (string) ($body['batch_id'] ?? AllegroClient::uuidV4());

        // Ustawienia tenanta nadpisują konfigurację globalną serwera.
        $tenantCfg = (new TenantSettings($pdo))->mergeChannelConfig($tenantId, $config);

        $antiLoop   = new AntiLoop(
            $pdo,
            (int) $tenantCfg['anti_loop']['echo_window_seconds'],
            (bool) $tenantCfg['anti_loop']['skip_unchanged']
        );
        $dispatcher = new InventoryDispatcher(
            $pdo,
            $antiLoop,
            new AllegroClient($pdo, $tenantCfg['allegro'], $logger),
            new BaseLinkerClient($tenantCfg['baselinker'], $logger),
            $logger
        );

        try {
            $report = $dispatcher->dispatch($tenantId, $normalized, $correlationId);
        } catch (Throwable $e) {
            $logger->error('SyncUp: błąd krytyczny', [
                'tenant' => $tenantId,
                'corr'   => $correlationId,
                'err'    => $e->getMessage(),
            ]);
            Response::error('dispatch_failed', $e->getMessage(), 502, ['batch_id' => $correlationId]);
            exit;
        }

        $report['batch_id'] = $correlationId;
        if ($invalid !== []) {
            $report['invalid'] = $invalid;
        }

        // 207 gdy część kanałów zawiodła — agent wie, że ma ponowić.
        $partial = $report['allegro']['errors'] !== [] || $report['baselinker']['errors'] !== [];
        Response::json(['ok' => !$partial, 'report' => $report], $partial ? 207 : 200);
        exit;
    }

    // ==================================================================
    // GET /api/get-orders — agent pobiera zamówienia do realizacji
    // ==================================================================
    if ($method === 'GET' && $path === '/api/get-orders') {
        $limit = (int) (Request::query('limit') ?? 50);
        $queue = new OrderQueue($pdo);

        try {
            $orders = $queue->claim($tenantId, $agent['name'], $limit);
        } catch (Throwable $e) {
            $logger->error('SyncDown: błąd pobierania kolejki', ['err' => $e->getMessage()]);
            Response::error('queue_error', $e->getMessage(), 500);
            exit;
        }

        Response::ok([
            'orders' => $orders,
            'counts' => $queue->counts($tenantId),
        ]);
        exit;
    }

    // ==================================================================
    // POST /api/ack-orders — potwierdzenie zapisu w Wapro
    // ==================================================================
    if ($method === 'POST' && $path === '/api/ack-orders') {
        try {
            $body = Request::json();
        } catch (JsonException $e) {
            Response::error('bad_json', $e->getMessage(), 400);
            exit;
        }

        $ids = $body['queue_ids'] ?? [];
        if (!is_array($ids) || $ids === []) {
            Response::error('bad_request', 'Brak "queue_ids".', 422);
            exit;
        }

        $success   = (bool) ($body['success'] ?? true);
        $error     = isset($body['error']) ? (string) $body['error'] : null;
        $waproRef  = isset($body['wapro_ref']) ? (string) $body['wapro_ref'] : null;

        $queue   = new OrderQueue($pdo);
        $updated = $queue->ack($tenantId, array_map('intval', $ids), $success, $error, $waproRef);

        // Opcjonalnie: oznacz zamówienia w Allegro jako przyjęte do realizacji.
        $fulfillment = (new TenantSettings($pdo))->get($tenantId, 'orders.auto_fulfillment_status');
        if ($success && is_string($fulfillment) && $fulfillment !== '') {
            $allegro = new AllegroClient($pdo, $config['allegro'], $logger);
            foreach ($queue->externalIds($tenantId, array_map('intval', $ids), 'allegro') as $checkoutFormId) {
                try {
                    $allegro->setFulfillmentStatus($tenantId, $checkoutFormId, $fulfillment);
                } catch (Throwable $e) {
                    // Nieudana zmiana statusu nie może cofnąć potwierdzenia zapisu w Wapro.
                    $logger->warning('Nie udało się ustawić statusu realizacji w Allegro', [
                        'order' => $checkoutFormId,
                        'err'   => $e->getMessage(),
                    ]);
                }
            }
        }

        Response::ok(['updated' => $updated]);
        exit;
    }

    Response::error('not_found', "Nieznany endpoint: {$method} {$path}", 404);

} catch (Throwable $e) {
    $logger->error('Nieobsłużony wyjątek', [
        'err'  => $e->getMessage(),
        'file' => $e->getFile() . ':' . $e->getLine(),
    ]);
    Response::error(
        'internal_error',
        $config['app']['debug'] ? $e->getMessage() : 'Wystąpił błąd wewnętrzny.',
        500
    );
}
