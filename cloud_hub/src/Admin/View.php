<?php
declare(strict_types=1);

namespace Hub\Admin;

/**
 * Minimalny renderer widoków PHP. Bez silnika szablonów — panel jest mały,
 * a mniej zależności to mniej rzeczy do aktualizowania na serwerze klienta.
 */
final class View
{
    public function __construct(private string $viewsDir) {}

    /** Escapowanie do HTML — krótka nazwa, bo używana w widokach setki razy. */
    public static function e(mixed $value): string
    {
        return htmlspecialchars((string) ($value ?? ''), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    }

    public function render(string $template, array $data = [], ?string $layout = 'layout'): void
    {
        $content = $this->capture($template, $data);

        if ($layout === null) {
            echo $content;
            return;
        }

        echo $this->capture($layout, $data + ['content' => $content]);
    }

    private function capture(string $template, array $data): string
    {
        $file = $this->viewsDir . '/' . $template . '.php';
        if (!is_file($file)) {
            throw new \RuntimeException("Brak widoku: {$template}");
        }

        extract($data, EXTR_SKIP);
        ob_start();
        require $file;
        return (string) ob_get_clean();
    }
}
