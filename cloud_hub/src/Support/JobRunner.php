<?php
declare(strict_types=1);

namespace Hub\Support;

use PDO;
use Throwable;

/**
 * Wspólna obudowa zadań crona:
 *  - lock plikowy (cron co minutę nie może nakładać przebiegów),
 *  - wpis w `job_runs` widoczny w panelu,
 *  - jednolity kod wyjścia i komunikat na stderr.
 */
final class JobRunner
{
    public function __construct(
        private PDO $pdo,
        private Logger $logger
    ) {}

    /**
     * @param callable(): array $work zwraca podsumowanie do zapisania
     */
    public function run(string $tenantId, string $job, callable $work): int
    {
        $lockFile = sys_get_temp_dir() . '/hub_' . $job . '_' . md5($tenantId) . '.lock';
        $lock = fopen($lockFile, 'c');

        if ($lock === false || !flock($lock, LOCK_EX | LOCK_NB)) {
            fwrite(STDERR, "[{$job}] Poprzedni przebieg wciąż trwa — pomijam.\n");
            return 0;
        }

        $started = microtime(true);

        $this->pdo->prepare(
            "INSERT INTO job_runs (tenant_id, job, status) VALUES (?, ?, 'running')"
        )->execute([$tenantId, $job]);
        $runId = (int) $this->pdo->lastInsertId();

        try {
            $summary = $work();
            $duration = (int) round((microtime(true) - $started) * 1000);

            $this->pdo->prepare(
                "UPDATE job_runs
                    SET status = 'ok', finished_at = datetime('now'), duration_ms = ?, summary = ?
                  WHERE id = ?"
            )->execute([
                $duration,
                json_encode($summary, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
                $runId,
            ]);

            $this->logger->info("Zadanie {$job} zakończone", ['tenant' => $tenantId, 'ms' => $duration] + $summary);
            echo "[{$job}] OK ({$duration} ms): "
                . json_encode($summary, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n";

            return 0;
        } catch (Throwable $e) {
            $duration = (int) round((microtime(true) - $started) * 1000);

            $this->pdo->prepare(
                "UPDATE job_runs
                    SET status = 'error', finished_at = datetime('now'), duration_ms = ?, error = ?
                  WHERE id = ?"
            )->execute([$duration, mb_substr($e->getMessage(), 0, 2000), $runId]);

            $this->logger->error("Zadanie {$job} nie powiodło się", [
                'tenant' => $tenantId,
                'err'    => $e->getMessage(),
            ]);
            fwrite(STDERR, "[{$job}] BŁĄD: " . $e->getMessage() . "\n");

            return 1;
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }

    /**
     * Ponowienie z wykładniczym opóźnieniem — dla wywołań API, które potrafią
     * zwrócić 429/5xx pod obciążeniem.
     *
     * @template T
     * @param callable(): T $fn
     * @return T
     */
    public static function retry(callable $fn, int $attempts = 3, int $baseDelayMs = 500)
    {
        $lastError = null;

        for ($i = 0; $i < $attempts; $i++) {
            try {
                return $fn();
            } catch (Throwable $e) {
                $lastError = $e;

                // Błędy walidacji nie miną same — nie ma sensu ponawiać.
                if (str_contains($e->getMessage(), 'HTTP 4') && !str_contains($e->getMessage(), 'HTTP 429')) {
                    throw $e;
                }
                if ($i < $attempts - 1) {
                    usleep($baseDelayMs * 1000 * (2 ** $i));
                }
            }
        }

        throw $lastError;
    }
}
