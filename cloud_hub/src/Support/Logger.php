<?php
declare(strict_types=1);

namespace Hub\Support;

final class Logger
{
    private const LEVELS = ['debug' => 10, 'info' => 20, 'warning' => 30, 'error' => 40];

    public function __construct(
        private string $path,
        private string $minLevel = 'info'
    ) {
        $dir = dirname($this->path);
        if (!is_dir($dir)) {
            @mkdir($dir, 0770, true);
        }
    }

    public function debug(string $m, array $c = []): void   { $this->log('debug', $m, $c); }
    public function info(string $m, array $c = []): void    { $this->log('info', $m, $c); }
    public function warning(string $m, array $c = []): void { $this->log('warning', $m, $c); }
    public function error(string $m, array $c = []): void   { $this->log('error', $m, $c); }

    private function log(string $level, string $message, array $context): void
    {
        if ((self::LEVELS[$level] ?? 0) < (self::LEVELS[$this->minLevel] ?? 20)) {
            return;
        }
        $line = sprintf(
            "[%s] %-7s %s %s\n",
            gmdate('Y-m-d\TH:i:s\Z'),
            strtoupper($level),
            $message,
            $context ? json_encode($context, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) : ''
        );
        @file_put_contents($this->path, $line, FILE_APPEND | LOCK_EX);
    }
}
