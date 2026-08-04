<?php
declare(strict_types=1);

namespace Hub\Admin;

use Hub\Clients\AllegroClient;
use Hub\Clients\BaseLinkerClient;
use Hub\Http\Request;
use Hub\Security\AdminAuth;
use Hub\Security\AgentAuth;
use Hub\Services\AllegroOAuth;
use Hub\Services\AntiLoop;
use Hub\Services\OrderQueue;
use Hub\Services\SkuMapService;
use Hub\Services\TenantSettings;
use Hub\Support\Logger;
use PDO;
use Throwable;

/**
 * Panel administracyjny Cloud Huba.
 *
 * Routing prosty i jawny — jeden `match` zamiast frameworka. Każda akcja
 * modyfikująca dane wymaga POST + poprawnego tokenu CSRF.
 */
final class Controller
{
    private View $view;
    private AdminAuth $auth;
    private ?array $user = null;
    private array $flash = [];

    public function __construct(
        private PDO $pdo,
        private array $config,
        private Logger $logger
    ) {
        $this->view = new View(__DIR__ . '/views');
        $this->auth = new AdminAuth($pdo);
    }

    /**
     * @param string $path ścieżka po zdjęciu prefiksu /admin (np. '' , 'orders')
     */
    public function dispatch(string $path, string $method): void
    {
        $this->user = $this->auth->currentUser();

        // --- strony publiczne ------------------------------------------
        if ($path === 'login') {
            $method === 'POST' ? $this->postLogin() : $this->getLogin();
            return;
        }

        if ($this->user === null) {
            $this->redirect('/admin/login');
            return;
        }

        // --- ochrona CSRF dla wszystkich POST --------------------------
        if ($method === 'POST' && !$this->auth->verifyCsrf($_POST['_csrf'] ?? null)) {
            http_response_code(419);
            $this->render('error', [
                'title'   => 'Sesja wygasła',
                'message' => 'Token bezpieczeństwa jest nieważny. Odśwież stronę i spróbuj ponownie.',
            ]);
            return;
        }

        try {
            match (true) {
                $path === '' || $path === 'dashboard' => $this->dashboard(),
                $path === 'logout'                    => $this->logout(),
                $path === 'orders'                    => $this->orders(),
                $path === 'orders/action'             => $this->ordersAction(),
                $path === 'logs'                      => $this->logs(),
                $path === 'mappings'                  => $this->mappings(),
                $path === 'mappings/action'           => $this->mappingsAction(),
                $path === 'mappings/export'           => $this->mappingsExport(),
                $path === 'agents'                    => $this->agents(),
                $path === 'agents/action'             => $this->agentsAction(),
                $path === 'settings'                  => $this->settings(),
                $path === 'settings/save'             => $this->settingsSave(),
                $path === 'oauth/allegro/start'       => $this->oauthStart(),
                $path === 'oauth/allegro/revoke'      => $this->oauthRevoke(),
                default                               => $this->notFound(),
            };
        } catch (Throwable $e) {
            $this->logger->error('Panel: nieobsłużony błąd', [
                'path' => $path,
                'err'  => $e->getMessage(),
            ]);
            http_response_code(500);
            $this->render('error', [
                'title'   => 'Błąd',
                'message' => $this->config['app']['debug']
                    ? $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine()
                    : 'Wystąpił błąd. Szczegóły w logu serwera.',
            ]);
        }
    }

    // ==================================================================
    // Logowanie
    // ==================================================================

    private function getLogin(): void
    {
        if ($this->user !== null) {
            $this->redirect('/admin');
            return;
        }
        $this->render('login', ['error' => null], null);
    }

    private function postLogin(): void
    {
        $result = $this->auth->login(
            (string) ($_POST['login'] ?? ''),
            (string) ($_POST['password'] ?? '')
        );

        if ($result['ok']) {
            $this->logger->info('Panel: zalogowano', ['login' => $_POST['login'] ?? '']);
            $this->redirect('/admin');
            return;
        }

        $this->logger->warning('Panel: nieudane logowanie', [
            'login' => $_POST['login'] ?? '',
            'ip'    => $_SERVER['REMOTE_ADDR'] ?? '?',
        ]);

        http_response_code(401);
        $this->render('login', ['error' => $result['error']], null);
    }

    private function logout(): void
    {
        $this->auth->logout();
        $this->redirect('/admin/login');
    }

    // ==================================================================
    // Dashboard
    // ==================================================================

    private function dashboard(): void
    {
        $tenant = $this->user['tenant_id'];

        $queue  = new OrderQueue($this->pdo);
        $skuMap = new SkuMapService($this->pdo, $this->logger);
        $oauth  = new AllegroOAuth($this->pdo, $this->config['allegro'], $this->logger);

        $counts = $queue->counts($tenant);

        // Aktywność ostatniej doby
        $stmt = $this->pdo->prepare(
            "SELECT direction, status, COUNT(*) AS c
               FROM action_logs
              WHERE tenant_id = ? AND created_at >= datetime('now', '-1 day')
              GROUP BY direction, status"
        );
        $stmt->execute([$tenant]);
        $activity = $stmt->fetchAll();

        $stmt = $this->pdo->prepare(
            'SELECT COUNT(*) FROM inventory_state WHERE tenant_id = ?'
        );
        $stmt->execute([$tenant]);
        $trackedSkus = (int) $stmt->fetchColumn();

        $stmt = $this->pdo->prepare(
            'SELECT name, last_seen_at FROM agents WHERE tenant_id = ? AND active = 1 ORDER BY last_seen_at DESC'
        );
        $stmt->execute([$tenant]);
        $agents = $stmt->fetchAll();

        $stmt = $this->pdo->prepare(
            'SELECT * FROM job_runs WHERE tenant_id = ? ORDER BY id DESC LIMIT 10'
        );
        $stmt->execute([$tenant]);
        $jobs = $stmt->fetchAll();

        $stmt = $this->pdo->prepare(
            "SELECT * FROM action_logs
              WHERE tenant_id = ? AND status = 'error'
              ORDER BY id DESC LIMIT 10"
        );
        $stmt->execute([$tenant]);
        $recentErrors = $stmt->fetchAll();

        $this->render('dashboard', [
            'counts'       => $counts,
            'activity'     => $activity,
            'trackedSkus'  => $trackedSkus,
            'mapStats'     => $skuMap->stats($tenant),
            'unmapped'     => $skuMap->unmapped($tenant, 20),
            'allegro'      => $oauth->status($tenant),
            'agents'       => $agents,
            'jobs'         => $jobs,
            'recentErrors' => $recentErrors,
        ]);
    }

    // ==================================================================
    // Kolejka zamówień
    // ==================================================================

    private function orders(): void
    {
        $tenant = $this->user['tenant_id'];

        $status = (string) (Request::query('status') ?? '');
        $source = (string) (Request::query('source') ?? '');
        $page   = max(1, (int) (Request::query('page') ?? 1));
        $perPage = 50;

        $where = ['tenant_id = :tenant'];
        $params = [':tenant' => $tenant];

        if ($status !== '') {
            $where[] = 'status = :status';
            $params[':status'] = $status;
        }
        if ($source !== '') {
            $where[] = 'source = :source';
            $params[':source'] = $source;
        }

        $whereSql = implode(' AND ', $where);

        $countStmt = $this->pdo->prepare("SELECT COUNT(*) FROM order_queue WHERE {$whereSql}");
        $countStmt->execute($params);
        $total = (int) $countStmt->fetchColumn();

        $offset = ($page - 1) * $perPage;
        $stmt = $this->pdo->prepare(
            "SELECT id, source, external_id, status, attempts, claimed_by, claimed_at,
                    synced_at, last_error, occurred_at, created_at, wapro_ref
               FROM order_queue WHERE {$whereSql}
              ORDER BY id DESC LIMIT {$perPage} OFFSET {$offset}"
        );
        $stmt->execute($params);

        $this->render('orders', [
            'rows'    => $stmt->fetchAll(),
            'total'   => $total,
            'page'    => $page,
            'pages'   => max(1, (int) ceil($total / $perPage)),
            'status'  => $status,
            'source'  => $source,
        ]);
    }

    private function ordersAction(): void
    {
        $tenant = $this->user['tenant_id'];
        $action = (string) ($_POST['action'] ?? '');
        $ids    = array_map('intval', (array) ($_POST['ids'] ?? []));

        if ($ids === []) {
            $this->redirect('/admin/orders');
            return;
        }

        $ph = implode(',', array_fill(0, count($ids), '?'));

        match ($action) {
            'requeue' => $this->pdo->prepare(
                "UPDATE order_queue
                    SET status = 'pending', claimed_by = NULL, claimed_at = NULL,
                        last_error = NULL, updated_at = datetime('now')
                  WHERE tenant_id = ? AND id IN ({$ph})"
            )->execute(array_merge([$tenant], $ids)),

            'skip' => $this->pdo->prepare(
                "UPDATE order_queue SET status = 'skipped', updated_at = datetime('now')
                  WHERE tenant_id = ? AND id IN ({$ph})"
            )->execute(array_merge([$tenant], $ids)),

            'delete' => $this->pdo->prepare(
                "DELETE FROM order_queue WHERE tenant_id = ? AND id IN ({$ph})"
            )->execute(array_merge([$tenant], $ids)),

            default => null,
        };

        $this->logger->info('Panel: akcja na kolejce', [
            'action' => $action,
            'count'  => count($ids),
            'user'   => $this->user['login'],
        ]);

        $this->redirect('/admin/orders');
    }

    // ==================================================================
    // Logi akcji (audyt Anti-Loop)
    // ==================================================================

    private function logs(): void
    {
        $tenant = $this->user['tenant_id'];

        $filters = [
            'entity_type' => (string) (Request::query('entity_type') ?? ''),
            'channel'     => (string) (Request::query('channel') ?? ''),
            'status'      => (string) (Request::query('status') ?? ''),
            'q'           => (string) (Request::query('q') ?? ''),
        ];
        $page = max(1, (int) (Request::query('page') ?? 1));
        $perPage = 100;

        $where = ['tenant_id = :tenant'];
        $params = [':tenant' => $tenant];

        foreach (['entity_type', 'channel', 'status'] as $f) {
            if ($filters[$f] !== '') {
                $where[] = "{$f} = :{$f}";
                $params[":{$f}"] = $filters[$f];
            }
        }
        if ($filters['q'] !== '') {
            $where[] = '(entity_key LIKE :q OR message LIKE :q)';
            $params[':q'] = '%' . $filters['q'] . '%';
        }

        $whereSql = implode(' AND ', $where);

        $countStmt = $this->pdo->prepare("SELECT COUNT(*) FROM action_logs WHERE {$whereSql}");
        $countStmt->execute($params);
        $total = (int) $countStmt->fetchColumn();

        $offset = ($page - 1) * $perPage;
        $stmt = $this->pdo->prepare(
            "SELECT * FROM action_logs WHERE {$whereSql} ORDER BY id DESC LIMIT {$perPage} OFFSET {$offset}"
        );
        $stmt->execute($params);

        $this->render('logs', [
            'rows'    => $stmt->fetchAll(),
            'total'   => $total,
            'page'    => $page,
            'pages'   => max(1, (int) ceil($total / $perPage)),
            'filters' => $filters,
        ]);
    }

    // ==================================================================
    // Mapowania SKU
    // ==================================================================

    private function mappings(): void
    {
        $tenant = $this->user['tenant_id'];
        $service = new SkuMapService($this->pdo, $this->logger);

        $filters = [
            'channel' => (string) (Request::query('channel') ?? ''),
            'origin'  => (string) (Request::query('origin') ?? ''),
            'active'  => (string) (Request::query('active') ?? ''),
            'q'       => (string) (Request::query('q') ?? ''),
        ];
        $page = max(1, (int) (Request::query('page') ?? 1));

        $result = $service->list($tenant, $filters, $page, 50);

        $this->render('mappings', [
            'rows'     => $result['rows'],
            'total'    => $result['total'],
            'page'     => $page,
            'pages'    => max(1, (int) ceil($result['total'] / 50)),
            'filters'  => $filters,
            'stats'    => $service->stats($tenant),
            'unmapped' => $service->unmapped($tenant, 50),
            'report'   => $this->flash['report'] ?? null,
        ]);
    }

    private function mappingsAction(): void
    {
        $tenant  = $this->user['tenant_id'];
        $service = new SkuMapService($this->pdo, $this->logger);
        $action  = (string) ($_POST['action'] ?? '');

        try {
            switch ($action) {
                case 'add':
                    $service->upsert(
                        $tenant,
                        (string) ($_POST['sku'] ?? ''),
                        (string) ($_POST['channel'] ?? ''),
                        (string) ($_POST['external_ref'] ?? ''),
                        (string) ($_POST['variant_ref'] ?? '0') ?: '0',
                        'manual',
                        (string) ($_POST['title'] ?? '') ?: null
                    );
                    break;

                case 'delete':
                    $service->delete($tenant, (int) ($_POST['id'] ?? 0));
                    break;

                case 'toggle':
                    $service->setActive($tenant, (int) ($_POST['id'] ?? 0), (bool) ($_POST['active'] ?? false));
                    break;

                case 'import':
                    if (!isset($_FILES['csv']) || $_FILES['csv']['error'] !== UPLOAD_ERR_OK) {
                        throw new \RuntimeException('Nie udało się odebrać pliku (kod ' . ($_FILES['csv']['error'] ?? '?') . ').');
                    }
                    if ($_FILES['csv']['size'] > 8 * 1024 * 1024) {
                        throw new \RuntimeException('Plik większy niż 8 MB.');
                    }
                    $content = file_get_contents($_FILES['csv']['tmp_name']);
                    $report = $service->importCsv($tenant, (string) $content);
                    $this->flashSet('report', ['type' => 'import', 'data' => $report]);
                    break;

                case 'sync_allegro':
                    $report = $service->syncFromAllegro(
                        $tenant,
                        new AllegroClient($this->pdo, $this->config['allegro'], $this->logger)
                    );
                    $this->flashSet('report', ['type' => 'allegro', 'data' => $report]);
                    break;

                case 'sync_baselinker':
                    $settings = new TenantSettings($this->pdo);
                    $cfg = $settings->mergeChannelConfig($tenant, $this->config);
                    $report = $service->syncFromBaseLinker(
                        $tenant,
                        new BaseLinkerClient($cfg['baselinker'], $this->logger)
                    );
                    $this->flashSet('report', ['type' => 'baselinker', 'data' => $report]);
                    break;
            }
        } catch (Throwable $e) {
            $this->flashSet('report', ['type' => 'error', 'data' => ['errors' => [$e->getMessage()]]]);
        }

        $this->mappings();
    }

    private function mappingsExport(): void
    {
        $service = new SkuMapService($this->pdo, $this->logger);
        $csv = $service->exportCsv($this->user['tenant_id']);

        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="sku_map_' . date('Ymd_His') . '.csv"');
        header('Content-Length: ' . strlen($csv));
        echo $csv;
    }

    // ==================================================================
    // Agenci
    // ==================================================================

    private function agents(): void
    {
        $stmt = $this->pdo->prepare(
            'SELECT id, name, active, last_seen_at, created_at FROM agents WHERE tenant_id = ? ORDER BY id'
        );
        $stmt->execute([$this->user['tenant_id']]);

        $this->render('agents', [
            'rows'   => $stmt->fetchAll(),
            'newKey' => $this->flash['new_key'] ?? null,
        ]);
    }

    private function agentsAction(): void
    {
        $tenant = $this->user['tenant_id'];
        $action = (string) ($_POST['action'] ?? '');
        $agentAuth = new AgentAuth($this->pdo, $this->config['security']['api_key_pepper']);

        if ($action === 'create') {
            $name = trim((string) ($_POST['name'] ?? ''));
            if ($name !== '') {
                $key = $agentAuth->register($tenant, $name);
                $this->flashSet('new_key', ['name' => $name, 'key' => $key]);
                $this->logger->info('Panel: utworzono agenta', ['name' => $name, 'by' => $this->user['login']]);
            }
        } elseif ($action === 'toggle') {
            $this->pdo->prepare('UPDATE agents SET active = ? WHERE tenant_id = ? AND id = ?')
                      ->execute([(int) ($_POST['active'] ?? 0), $tenant, (int) ($_POST['id'] ?? 0)]);
        } elseif ($action === 'delete') {
            $this->pdo->prepare('DELETE FROM agents WHERE tenant_id = ? AND id = ?')
                      ->execute([$tenant, (int) ($_POST['id'] ?? 0)]);
        }

        $this->agents();
    }

    // ==================================================================
    // Ustawienia
    // ==================================================================

    private function settings(): void
    {
        $tenant = $this->user['tenant_id'];
        $settings = new TenantSettings($this->pdo);
        $oauth = new AllegroOAuth($this->pdo, $this->config['allegro'], $this->logger);

        $this->render('settings', [
            'values'      => $settings->all($tenant),
            'allegro'     => $oauth->status($tenant),
            'redirectUri' => $this->redirectUri(),
            'globals'     => [
                'allegro_client_id' => $this->config['allegro']['client_id'] !== '',
                'baselinker_token'  => $this->config['baselinker']['token'] !== '',
                'webhook_secret'    => $this->config['security']['baselinker_webhook_secret'] !== '',
                'pepper_default'    => $this->config['security']['api_key_pepper'] === 'zmien-mnie-w-produkcji',
            ],
            'saved' => $this->flash['saved'] ?? false,
        ]);
    }

    private function settingsSave(): void
    {
        $tenant = $this->user['tenant_id'];
        $settings = new TenantSettings($this->pdo);

        $allowed = [
            'baselinker.token',
            'baselinker.inventory_id',
            'baselinker.warehouse_id',
            'anti_loop.echo_window',
            'orders.auto_fulfillment_status',
        ];

        $pairs = [];
        foreach ($allowed as $key) {
            $field = str_replace('.', '_', $key);
            if (array_key_exists($field, $_POST)) {
                $value = trim((string) $_POST[$field]);
                $pairs[$key] = $value === '' ? null : $value;
            }
        }

        $settings->setMany($tenant, $pairs);
        $this->logger->info('Panel: zapisano ustawienia', ['user' => $this->user['login'], 'keys' => array_keys($pairs)]);

        $this->flashSet('saved', true);
        $this->settings();
    }

    // ==================================================================
    // OAuth
    // ==================================================================

    private function oauthStart(): void
    {
        $oauth = new AllegroOAuth($this->pdo, $this->config['allegro'], $this->logger);
        $url = $oauth->start($this->user['tenant_id'], $this->redirectUri());
        $this->redirect($url, true);
    }

    private function oauthRevoke(): void
    {
        (new AllegroOAuth($this->pdo, $this->config['allegro'], $this->logger))
            ->revoke($this->user['tenant_id']);
        $this->logger->info('Panel: odłączono konto Allegro', ['user' => $this->user['login']]);
        $this->redirect('/admin/settings');
    }

    /** Adres, pod który Allegro odsyła po autoryzacji. Musi zgadzać się co do znaku z konfiguracją aplikacji w Allegro. */
    private function redirectUri(): string
    {
        $configured = getenv('ALLEGRO_REDIRECT_URI');
        if (is_string($configured) && $configured !== '') {
            return $configured;
        }

        $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
            || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https') ? 'https' : 'http';
        $host = $_SERVER['HTTP_HOST'] ?? 'localhost';

        return "{$scheme}://{$host}/oauth/allegro/callback";
    }

    // ==================================================================
    // Pomocnicze
    // ==================================================================

    private function render(string $template, array $data = []): void
    {
        $this->view->render($template, $data + [
            'user' => $this->user,
            'csrf' => $this->auth->csrfToken(),
        ]);
    }

    private function redirect(string $url, bool $external = false): void
    {
        if (!$external) {
            // Ochrona przed open redirect — akceptujemy wyłącznie ścieżki lokalne.
            $url = '/' . ltrim(parse_url($url, PHP_URL_PATH) ?: '/', '/');
        }
        header('Location: ' . $url, true, 302);
    }

    private function notFound(): void
    {
        http_response_code(404);
        $this->render('error', ['title' => 'Nie znaleziono', 'message' => 'Taka strona nie istnieje.']);
    }

    private function flashSet(string $key, mixed $value): void
    {
        $this->flash[$key] = $value;
    }
}
