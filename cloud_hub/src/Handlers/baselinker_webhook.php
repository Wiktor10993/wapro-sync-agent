<?php
declare(strict_types=1);

/**
 * Webhook Receiver dla BaseLinkera (sprzedaż z WooCommerce, Amazon itd.).
 *
 * Włączany z public/index.php. W scope: $pdo, $config, $logger.
 *
 * Anti-Loop: BaseLinker potrafi odesłać zdarzenie wywołane naszą własną
 * aktualizacją stanów. Zanim wrzucimy cokolwiek do kolejki, sprawdzamy
 * action_logs — jeżeli w oknie echa jest nasz outbound o tym samym odcisku
 * wartości, zdarzenie oznaczamy jako 'skipped' i kończymy.
 */

use Hub\Http\Request;
use Hub\Http\Response;
use Hub\Services\AntiLoop;
use Hub\Services\OrderQueue;

/** @var PDO $pdo */
/** @var array $config */
/** @var \Hub\Support\Logger $logger */

$raw = Request::rawBody();

// --- 1. Weryfikacja podpisu -------------------------------------------------
$secret = (string) $config['security']['baselinker_webhook_secret'];
if ($secret !== '') {
    $given = (string) (Request::header('X-BL-Signature') ?? '');
    $expected = hash_hmac('sha256', $raw, $secret);

    if ($given === '' || !hash_equals($expected, $given)) {
        $logger->warning('Webhook BaseLinker: nieprawidłowy podpis', [
            'ip' => $_SERVER['REMOTE_ADDR'] ?? '?',
        ]);
        Response::error('bad_signature', 'Nieprawidłowy podpis webhooka.', 401);
        return;
    }
}

// --- 2. Parsowanie ----------------------------------------------------------
try {
    $payload = Request::json();
} catch (JsonException $e) {
    Response::error('bad_json', $e->getMessage(), 400);
    return;
}

$tenantId = trim((string) (Request::header('X-Tenant-Id') ?? ($payload['tenant_id'] ?? '')));
if ($tenantId === '') {
    Response::error('bad_request', 'Brak identyfikatora tenanta (X-Tenant-Id).', 422);
    return;
}

$antiLoop = new AntiLoop(
    $pdo,
    (int) $config['anti_loop']['echo_window_seconds'],
    (bool) $config['anti_loop']['skip_unchanged']
);
$queue = new OrderQueue($pdo);

$eventType = (string) ($payload['event_type'] ?? $payload['type'] ?? 'unknown');

// --- 3a. Zdarzenie zmiany stanu — kandydat na echo --------------------------
if (in_array($eventType, ['inventory_products_stock', 'stock_update', 'product_quantity'], true)) {
    $products = $payload['products'] ?? [];
    $echo = 0;
    $real = 0;

    foreach ((is_array($products) ? $products : []) as $p) {
        $sku = trim((string) ($p['sku'] ?? ''));
        $qty = (int) ($p['quantity'] ?? 0);
        if ($sku === '') {
            continue;
        }

        if ($antiLoop->isEcho($tenantId, $sku, $qty)) {
            $echo++;
            $antiLoop->record(
                $tenantId, 'stock', $sku, 'baselinker', 'inbound', 'baselinker',
                AntiLoop::valueHash($tenantId, $sku, $qty), $qty, 'skipped',
                'Echo własnego pushu — zignorowano.'
            );
            continue;
        }

        $real++;
        // Wapro jest Masterem stanów — zmiana z rynku jest tylko odnotowywana,
        // NIE nadpisuje stanu w Wapro. Reakcją jest zamówienie, nie korekta stanu.
        $antiLoop->record(
            $tenantId, 'stock', $sku, 'baselinker', 'inbound', 'baselinker',
            AntiLoop::valueHash($tenantId, $sku, $qty), $qty, 'ok',
            'Zmiana stanu z rynku — tylko log (Wapro pozostaje Masterem).'
        );
    }

    $logger->info('Webhook BaseLinker: stany', [
        'tenant' => $tenantId, 'echo' => $echo, 'real' => $real,
    ]);
    Response::ok(['event' => $eventType, 'echo_skipped' => $echo, 'logged' => $real]);
    return;
}

// --- 3b. Zdarzenie zamówienia ----------------------------------------------
if (in_array($eventType, ['order_new', 'order_status_change', 'new_order'], true)) {
    $order = $payload['order'] ?? $payload;
    $externalId = trim((string) ($order['order_id'] ?? $payload['order_id'] ?? ''));

    if ($externalId === '') {
        Response::error('bad_request', 'Brak order_id w payloadzie.', 422);
        return;
    }

    // Ochrona przed zapętleniem zamówień: jeśli to zamówienie już przeszło
    // przez huba jako inbound, INSERT OR IGNORE i tak je odrzuci, ale logujemy
    // fakt dla audytu.
    try {
        $added = $queue->enqueue(
            $tenantId,
            'baselinker',
            $externalId,
            is_array($order) ? $order : [],
            null,
            isset($order['date_add']) ? gmdate('Y-m-d H:i:s', (int) $order['date_add']) : null
        );
    } catch (Throwable $e) {
        $logger->error('Webhook BaseLinker: błąd zapisu do kolejki', ['err' => $e->getMessage()]);
        Response::error('queue_error', $e->getMessage(), 500);
        return;
    }

    $antiLoop->record(
        $tenantId, 'order', $externalId, 'baselinker', 'inbound', 'baselinker',
        null, null, $added ? 'ok' : 'skipped',
        $added ? 'Dodano do kolejki.' : 'Duplikat — pominięto.'
    );

    Response::ok(['event' => $eventType, 'external_id' => $externalId, 'queued' => $added]);
    return;
}

// --- 3c. Nieznany typ -------------------------------------------------------
$logger->info('Webhook BaseLinker: nieobsługiwany typ zdarzenia', ['type' => $eventType]);
Response::ok(['event' => $eventType, 'handled' => false]);
