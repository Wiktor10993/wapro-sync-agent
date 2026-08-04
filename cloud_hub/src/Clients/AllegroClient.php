<?php
declare(strict_types=1);

namespace Hub\Clients;

use Hub\Support\Logger;
use PDO;
use RuntimeException;

/**
 * Klient Allegro REST API.
 *
 * Zakres użyty w projekcie:
 *  - PUT  /sale/offer-quantity-change-commands/{commandId}  (zmiana stanów)
 *  - GET  /order/events                                     (nasłuch zamówień)
 *  - GET  /order/checkout-forms/{id}                        (szczegóły zamówienia)
 *
 * Token odświeżamy automatycznie (refresh_token grant) i utrwalamy w auth_tokens.
 */
final class AllegroClient
{
    private HttpClient $http;

    public function __construct(
        private PDO $pdo,
        private array $config,
        private Logger $logger
    ) {
        $this->http = new HttpClient((int) ($config['timeout'] ?? 20));
    }

    // ------------------------------------------------------------------
    // Tokeny
    // ------------------------------------------------------------------

    private function loadToken(string $tenantId): array
    {
        $stmt = $this->pdo->prepare(
            "SELECT * FROM auth_tokens
             WHERE tenant_id = ? AND provider = 'allegro' AND account_label = 'default'
             LIMIT 1"
        );
        $stmt->execute([$tenantId]);
        $row = $stmt->fetch();

        if (!$row) {
            throw new RuntimeException("Brak tokenu Allegro dla tenanta {$tenantId}. Wykonaj autoryzację OAuth.");
        }
        return $row;
    }

    private function accessToken(string $tenantId): string
    {
        $token = $this->loadToken($tenantId);

        $expiresAt = $token['expires_at'] ? strtotime((string) $token['expires_at']) : 0;
        // 120 s marginesu, żeby nie trafić w wygaśnięcie w trakcie żądania.
        if ($expiresAt > 0 && $expiresAt - 120 > time()) {
            return (string) $token['access_token'];
        }

        if (empty($token['refresh_token'])) {
            throw new RuntimeException('Token Allegro wygasł i brak refresh_token — wymagana ponowna autoryzacja.');
        }

        return $this->refresh($tenantId, (string) $token['refresh_token']);
    }

    private function refresh(string $tenantId, string $refreshToken): string
    {
        $clientId     = (string) $this->config['client_id'];
        $clientSecret = (string) $this->config['client_secret'];

        if ($clientId === '' || $clientSecret === '') {
            throw new RuntimeException('Brak ALLEGRO_CLIENT_ID / ALLEGRO_CLIENT_SECRET w konfiguracji.');
        }

        $res = $this->http->request(
            'POST',
            rtrim((string) $this->config['auth_base'], '/') . '/token',
            [
                'Authorization' => 'Basic ' . base64_encode($clientId . ':' . $clientSecret),
                'Content-Type'  => 'application/x-www-form-urlencoded',
            ],
            http_build_query([
                'grant_type'    => 'refresh_token',
                'refresh_token' => $refreshToken,
            ])
        );

        $body = $this->http->decodeJson($res['body']);

        if ($res['status'] !== 200 || empty($body['access_token'])) {
            throw new RuntimeException(
                'Odświeżenie tokenu Allegro nie powiodło się (HTTP ' . $res['status'] . '): ' . $res['body']
            );
        }

        $expiresAt = gmdate('Y-m-d H:i:s', time() + (int) ($body['expires_in'] ?? 3600));

        $this->pdo->prepare(
            "UPDATE auth_tokens
                SET access_token = :at, refresh_token = :rt, expires_at = :exp,
                    updated_at = datetime('now')
              WHERE tenant_id = :tenant AND provider = 'allegro' AND account_label = 'default'"
        )->execute([
            ':at'     => $body['access_token'],
            ':rt'     => $body['refresh_token'] ?? $refreshToken,
            ':exp'    => $expiresAt,
            ':tenant' => $tenantId,
        ]);

        $this->logger->info('Odświeżono token Allegro', ['tenant' => $tenantId]);

        return (string) $body['access_token'];
    }

    // ------------------------------------------------------------------
    // Wywołania API
    // ------------------------------------------------------------------

    private function call(string $tenantId, string $method, string $path, ?array $json = null): array
    {
        $headers = [
            'Authorization' => 'Bearer ' . $this->accessToken($tenantId),
            'Accept'        => (string) $this->config['accept_header'],
        ];
        $body = null;
        if ($json !== null) {
            $headers['Content-Type'] = (string) $this->config['accept_header'];
            $body = json_encode($json, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        }

        $res = $this->http->request(
            $method,
            rtrim((string) $this->config['api_base'], '/') . $path,
            $headers,
            $body
        );

        return [
            'status' => $res['status'],
            'data'   => $this->http->decodeJson($res['body']),
            'raw'    => $res['body'],
        ];
    }

    /**
     * Ustawia stan magazynowy dla listy ofert.
     * Allegro używa tu komendy idempotentnej: klient generuje commandId (UUID).
     * Ponowne PUT z tym samym commandId nie wykona operacji drugi raz — to
     * kluczowe przy retry po timeoucie.
     *
     * @param array<int,string> $offerIds
     */
    public function setOfferQuantity(string $tenantId, array $offerIds, int $quantity, ?string $commandId = null): array
    {
        if ($offerIds === []) {
            return ['status' => 204, 'data' => [], 'skipped' => true];
        }
        if ($quantity < 0) {
            throw new RuntimeException("Stan nie może być ujemny (otrzymano {$quantity}).");
        }

        $commandId ??= self::uuidV4();

        $payload = [
            'modification' => [
                'changeType' => 'FIXED',
                'value'      => $quantity,
            ],
            'offerCriteria' => [[
                'offers' => array_map(static fn($id) => ['id' => (string) $id], array_values($offerIds)),
                'type'   => 'CONTAINS_OFFERS',
            ]],
        ];

        $res = $this->call($tenantId, 'PUT', '/sale/offer-quantity-change-commands/' . $commandId, $payload);
        $res['commandId'] = $commandId;

        if ($res['status'] >= 400) {
            throw new RuntimeException(
                'Allegro odrzuciło zmianę stanu (HTTP ' . $res['status'] . '): ' . $res['raw']
            );
        }

        return $res;
    }

    /**
     * Pobiera zdarzenia zamówień. Filtrowanie po typie robimy po stronie huba,
     * bo API zwraca pełen strumień.
     */
    public function getOrderEvents(string $tenantId, ?string $fromEventId = null, int $limit = 100): array
    {
        $query = ['limit' => max(1, min(1000, $limit))];
        if ($fromEventId !== null && $fromEventId !== '') {
            $query['from'] = $fromEventId;
        }
        $res = $this->call($tenantId, 'GET', '/order/events?' . http_build_query($query));

        if ($res['status'] >= 400) {
            throw new RuntimeException('Allegro /order/events HTTP ' . $res['status'] . ': ' . $res['raw']);
        }

        return $res['data']['events'] ?? [];
    }

    /**
     * Lista ofert sprzedawcy — źródło auto-mapowania SKU.
     *
     * Pole `external.id` w ofercie Allegro to "sygnatura" ustawiana przez
     * sprzedawcę; w praktyce trzymamy tam indeks katalogowy z Wapro.
     * Oferty bez wypełnionej sygnatury nie dadzą się zmapować automatycznie.
     *
     * @return array{offers:array<int,array>, total:int}
     */
    public function listOffers(string $tenantId, int $offset = 0, int $limit = 100, array $publication = ['ACTIVE', 'ACTIVATING']): array
    {
        $query = [
            'offset' => max(0, $offset),
            'limit'  => max(1, min(1000, $limit)),
        ];

        $qs = http_build_query($query);
        foreach ($publication as $statusValue) {
            $qs .= '&publication.status=' . rawurlencode($statusValue);
        }

        $res = $this->call($tenantId, 'GET', '/sale/offers?' . $qs);

        if ($res['status'] >= 400) {
            throw new RuntimeException('Allegro /sale/offers HTTP ' . $res['status'] . ': ' . $res['raw']);
        }

        return [
            'offers' => $res['data']['offers'] ?? [],
            'total'  => (int) ($res['data']['totalCount'] ?? 0),
        ];
    }

    /**
     * Zmiana statusu zamówienia (np. oznaczenie jako gotowe do wysyłki).
     * Używane opcjonalnie po zaimportowaniu zamówienia do Wapro.
     */
    public function setFulfillmentStatus(string $tenantId, string $checkoutFormId, string $status): array
    {
        return $this->call(
            $tenantId,
            'PUT',
            '/order/checkout-forms/' . rawurlencode($checkoutFormId) . '/fulfillment',
            ['status' => $status]
        );
    }

    public function getCheckoutForm(string $tenantId, string $checkoutFormId): array
    {
        $res = $this->call($tenantId, 'GET', '/order/checkout-forms/' . rawurlencode($checkoutFormId));
        if ($res['status'] >= 400) {
            throw new RuntimeException('Allegro checkout-form HTTP ' . $res['status'] . ': ' . $res['raw']);
        }
        return $res['data'];
    }

    public static function uuidV4(): string
    {
        $d = random_bytes(16);
        $d[6] = chr((ord($d[6]) & 0x0f) | 0x40);
        $d[8] = chr((ord($d[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($d), 4));
    }
}
