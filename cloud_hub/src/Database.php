<?php
declare(strict_types=1);

namespace Hub;

use PDO;
use PDOException;
use RuntimeException;

/**
 * Cienka warstwa nad PDO/SQLite + wersjonowane migracje schematu.
 *
 * SQLite w trybie WAL radzi sobie z jednym procesem piszącym i wieloma
 * czytającymi — to wystarcza dla huba obsługującego kilku agentów.
 */
final class Database
{
    private static ?PDO $pdo = null;

    /** Aktualna wersja schematu. Podnieś przy dodaniu nowej migracji. */
    public const SCHEMA_VERSION = 2;

    public static function connect(array $config): PDO
    {
        if (self::$pdo instanceof PDO) {
            return self::$pdo;
        }

        $path = $config['database']['path'];
        $dir  = dirname($path);

        if (!is_dir($dir) && !@mkdir($dir, 0770, true) && !is_dir($dir)) {
            throw new RuntimeException("Nie mogę utworzyć katalogu bazy: {$dir}");
        }

        try {
            $pdo = new PDO('sqlite:' . $path, null, null, [
                PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES   => false,
            ]);
        } catch (PDOException $e) {
            throw new RuntimeException(
                'Nie udało się otworzyć bazy SQLite: ' . $e->getMessage(),
                0,
                $e
            );
        }

        $busy = (int) ($config['database']['busy_timeout_ms'] ?? 5000);
        $pdo->exec('PRAGMA journal_mode = WAL');
        $pdo->exec('PRAGMA foreign_keys = ON');
        $pdo->exec('PRAGMA synchronous = NORMAL');
        $pdo->exec('PRAGMA busy_timeout = ' . $busy);

        self::$pdo = $pdo;
        return $pdo;
    }

    /**
     * Uruchamia migracje do SCHEMA_VERSION. Idempotentne — można wołać
     * przy każdym starcie procesu.
     */
    public static function migrate(PDO $pdo): int
    {
        $pdo->exec('CREATE TABLE IF NOT EXISTS schema_meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )');

        $stmt = $pdo->prepare('SELECT value FROM schema_meta WHERE key = ?');
        $stmt->execute(['schema_version']);
        $current = (int) ($stmt->fetchColumn() ?: 0);

        if ($current >= self::SCHEMA_VERSION) {
            return $current;
        }

        $pdo->beginTransaction();
        try {
            if ($current < 1) {
                self::migrationV1($pdo);
            }
            if ($current < 2) {
                self::migrationV2($pdo);
            }

            $pdo->prepare(
                'INSERT INTO schema_meta (key, value) VALUES (?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value'
            )->execute(['schema_version', (string) self::SCHEMA_VERSION]);

            $pdo->commit();
        } catch (PDOException $e) {
            $pdo->rollBack();
            throw new RuntimeException('Migracja nie powiodła się: ' . $e->getMessage(), 0, $e);
        }

        return self::SCHEMA_VERSION;
    }

    private static function migrationV1(PDO $pdo): void
    {
        // ------------------------------------------------------------------
        // agents — agenci desktopowi uprawnieni do wołania API huba
        // ------------------------------------------------------------------
        $pdo->exec("CREATE TABLE IF NOT EXISTS agents (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id     TEXT    NOT NULL,
            name          TEXT    NOT NULL,
            api_key_hash  TEXT    NOT NULL,
            active        INTEGER NOT NULL DEFAULT 1,
            last_seen_at  TEXT,
            created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
        )");
        $pdo->exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_key ON agents (api_key_hash)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_agents_tenant ON agents (tenant_id)');

        // ------------------------------------------------------------------
        // auth_tokens — tokeny OAuth Allegro (i ewentualnie inne kanały)
        // ------------------------------------------------------------------
        $pdo->exec("CREATE TABLE IF NOT EXISTS auth_tokens (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id      TEXT    NOT NULL,
            provider       TEXT    NOT NULL,           -- allegro | baselinker
            account_label  TEXT    NOT NULL DEFAULT 'default',
            access_token   TEXT    NOT NULL,
            refresh_token  TEXT,
            token_type     TEXT    NOT NULL DEFAULT 'Bearer',
            scope          TEXT,
            expires_at     TEXT,                       -- ISO8601 UTC
            created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
        )");
        $pdo->exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tokens_unique
                    ON auth_tokens (tenant_id, provider, account_label)');

        // ------------------------------------------------------------------
        // sku_map — mapowanie SKU z Wapro na identyfikatory kanałów
        // ------------------------------------------------------------------
        $pdo->exec("CREATE TABLE IF NOT EXISTS sku_map (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id    TEXT    NOT NULL,
            sku          TEXT    NOT NULL,
            channel      TEXT    NOT NULL,             -- allegro | baselinker
            external_ref TEXT    NOT NULL,             -- offerId / product_id
            variant_ref  TEXT    NOT NULL DEFAULT '0',
            active       INTEGER NOT NULL DEFAULT 1,
            updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
        )");
        $pdo->exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_skumap_unique
                    ON sku_map (tenant_id, channel, external_ref, variant_ref)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_skumap_sku ON sku_map (tenant_id, sku)');

        // ------------------------------------------------------------------
        // inventory_state — ostatni znany stan wypchnięty na kanały.
        // Służy do pomijania niezmienionych SKU (redukcja ruchu + anti-loop).
        // ------------------------------------------------------------------
        $pdo->exec("CREATE TABLE IF NOT EXISTS inventory_state (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id      TEXT    NOT NULL,
            sku            TEXT    NOT NULL,
            quantity       INTEGER NOT NULL,
            value_hash     TEXT    NOT NULL,
            source_rowver  TEXT,                       -- ROWVERSION z Wapro (hex)
            pushed_at      TEXT    NOT NULL DEFAULT (datetime('now'))
        )");
        $pdo->exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_invstate_unique
                    ON inventory_state (tenant_id, sku)');

        // ------------------------------------------------------------------
        // order_queue — kolejka zamówień do pobrania przez agenta
        // ------------------------------------------------------------------
        $pdo->exec("CREATE TABLE IF NOT EXISTS order_queue (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id     TEXT    NOT NULL,
            source        TEXT    NOT NULL,            -- allegro | baselinker
            external_id   TEXT    NOT NULL,            -- checkoutForm.id / order_id
            event_id      TEXT,                        -- id eventu (dedup Allegro)
            status        TEXT    NOT NULL DEFAULT 'pending',
                                                        -- pending|claimed|synced|failed|skipped
            attempts      INTEGER NOT NULL DEFAULT 0,
            payload_json  TEXT    NOT NULL,
            claimed_by    TEXT,
            claimed_at    TEXT,
            synced_at     TEXT,
            last_error    TEXT,
            occurred_at   TEXT,
            created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
            CHECK (status IN ('pending','claimed','synced','failed','skipped'))
        )");
        $pdo->exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_unique
                    ON order_queue (tenant_id, source, external_id)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_orders_pending
                    ON order_queue (tenant_id, status, id)');
        $pdo->exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_event
                    ON order_queue (tenant_id, source, event_id)
                    WHERE event_id IS NOT NULL');

        // ------------------------------------------------------------------
        // action_logs — rejestr KTO zainicjował zmianę (rdzeń Anti-Loop)
        // ------------------------------------------------------------------
        $pdo->exec("CREATE TABLE IF NOT EXISTS action_logs (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id    TEXT    NOT NULL,
            entity_type  TEXT    NOT NULL,             -- stock | order
            entity_key   TEXT    NOT NULL,             -- SKU lub external_id
            channel      TEXT    NOT NULL,             -- allegro|baselinker|wapro|hub
            direction    TEXT    NOT NULL,             -- outbound|inbound
            initiator    TEXT    NOT NULL,             -- wapro_agent|allegro|baselinker|hub
            value_hash   TEXT,                         -- odcisk wartości (anti-loop)
            quantity     INTEGER,
            status       TEXT    NOT NULL DEFAULT 'ok',-- ok|error|skipped
            message      TEXT,
            correlation  TEXT,                         -- id paczki / requestu
            created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
        )");
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_actionlogs_lookup
                    ON action_logs (tenant_id, entity_type, entity_key, created_at)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_actionlogs_hash
                    ON action_logs (tenant_id, value_hash, created_at)');

        // ------------------------------------------------------------------
        // sync_cursors — kursory (np. ostatni event Allegro /order/events)
        // ------------------------------------------------------------------
        $pdo->exec("CREATE TABLE IF NOT EXISTS sync_cursors (
            tenant_id  TEXT NOT NULL,
            name       TEXT NOT NULL,
            value      TEXT,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (tenant_id, name)
        )");
    }

    /**
     * Migracja v2 — panel administracyjny, OAuth, ustawienia per tenant,
     * historia zadań w tle.
     */
    private static function migrationV2(PDO $pdo): void
    {
        // ------------------------------------------------------------------
        // admin_users — logowanie do panelu huba
        // ------------------------------------------------------------------
        $pdo->exec("CREATE TABLE IF NOT EXISTS admin_users (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id      TEXT    NOT NULL,
            login          TEXT    NOT NULL,
            password_hash  TEXT    NOT NULL,
            display_name   TEXT,
            role           TEXT    NOT NULL DEFAULT 'admin',
            active         INTEGER NOT NULL DEFAULT 1,
            failed_logins  INTEGER NOT NULL DEFAULT 0,
            locked_until   TEXT,
            last_login_at  TEXT,
            created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
        )");
        $pdo->exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_login ON admin_users (login)');

        // ------------------------------------------------------------------
        // admin_sessions — sesje panelu (własne, bez polegania na session.save_path)
        // ------------------------------------------------------------------
        $pdo->exec("CREATE TABLE IF NOT EXISTS admin_sessions (
            id           TEXT PRIMARY KEY,          -- losowy token (hash)
            user_id      INTEGER NOT NULL,
            ip           TEXT,
            user_agent   TEXT,
            csrf_token   TEXT NOT NULL,
            expires_at   TEXT NOT NULL,
            created_at   TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES admin_users (id) ON DELETE CASCADE
        )");
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON admin_sessions (expires_at)');

        // ------------------------------------------------------------------
        // oauth_states — ochrona CSRF przepływu authorization code + PKCE
        // ------------------------------------------------------------------
        $pdo->exec("CREATE TABLE IF NOT EXISTS oauth_states (
            state          TEXT PRIMARY KEY,
            tenant_id      TEXT NOT NULL,
            provider       TEXT NOT NULL,
            code_verifier  TEXT,
            redirect_uri   TEXT NOT NULL,
            created_at     TEXT NOT NULL DEFAULT (datetime('now')),
            expires_at     TEXT NOT NULL
        )");

        // ------------------------------------------------------------------
        // tenant_settings — konfiguracja per klient (klucz -> wartość)
        // Pozwala trzymać np. inventory_id BaseLinkera osobno dla każdego tenanta,
        // zamiast jednej wartości globalnej ze zmiennej środowiskowej.
        // ------------------------------------------------------------------
        $pdo->exec("CREATE TABLE IF NOT EXISTS tenant_settings (
            tenant_id   TEXT NOT NULL,
            key         TEXT NOT NULL,
            value       TEXT,
            updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (tenant_id, key)
        )");

        // ------------------------------------------------------------------
        // job_runs — historia zadań w tle (pollery, synchronizacja mapowań)
        // ------------------------------------------------------------------
        $pdo->exec("CREATE TABLE IF NOT EXISTS job_runs (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id    TEXT NOT NULL,
            job          TEXT NOT NULL,
            status       TEXT NOT NULL DEFAULT 'running',  -- running|ok|error
            started_at   TEXT NOT NULL DEFAULT (datetime('now')),
            finished_at  TEXT,
            duration_ms  INTEGER,
            summary      TEXT,
            error        TEXT
        )");
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_jobruns_lookup
                    ON job_runs (tenant_id, job, started_at)');

        // ------------------------------------------------------------------
        // sku_map: rozszerzenie o metadane pochodzenia
        // ------------------------------------------------------------------
        foreach ([
            "ALTER TABLE sku_map ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'", // manual|auto|csv
            'ALTER TABLE sku_map ADD COLUMN title TEXT',
            'ALTER TABLE sku_map ADD COLUMN last_seen_at TEXT',
        ] as $alter) {
            try {
                $pdo->exec($alter);
            } catch (PDOException $e) {
                // Kolumna już istnieje (np. częściowo wykonana migracja) — idziemy dalej.
                if (!str_contains($e->getMessage(), 'duplicate column')) {
                    throw $e;
                }
            }
        }

        // ------------------------------------------------------------------
        // order_queue: powiązanie z dokumentem utworzonym w Wapro
        // ------------------------------------------------------------------
        foreach ([
            'ALTER TABLE order_queue ADD COLUMN wapro_ref TEXT',
        ] as $alter) {
            try {
                $pdo->exec($alter);
            } catch (PDOException $e) {
                if (!str_contains($e->getMessage(), 'duplicate column')) {
                    throw $e;
                }
            }
        }
    }

    /** Pomocnik: transakcja z automatycznym rollbackiem. */
    public static function transaction(PDO $pdo, callable $fn)
    {
        $pdo->beginTransaction();
        try {
            $result = $fn($pdo);
            $pdo->commit();
            return $result;
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }
}
