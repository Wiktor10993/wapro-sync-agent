<?php
/** @var string $content */
/** @var array|null $user */
use Hub\Admin\View as V;

$nav = [
    '/admin'          => 'Pulpit',
    '/admin/orders'   => 'Zamówienia',
    '/admin/mappings' => 'Mapowania SKU',
    '/admin/logs'     => 'Logi akcji',
    '/admin/agents'   => 'Agenci',
    '/admin/settings' => 'Ustawienia',
];
$current = '/' . trim(parse_url($_SERVER['REQUEST_URI'] ?? '/admin', PHP_URL_PATH) ?: '', '/');
?><!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cloud Hub — panel</title>
<link rel="stylesheet" href="/assets/admin.css">
</head>
<body>
<header class="topbar">
  <div class="topbar__brand">Cloud Hub <span>Wapro ⇄ Allegro / BaseLinker</span></div>
  <?php if ($user): ?>
  <div class="topbar__user">
    <span><?= V::e($user['display_name']) ?> · <code><?= V::e($user['tenant_id']) ?></code></span>
    <form method="post" action="/admin/logout" class="inline">
      <input type="hidden" name="_csrf" value="<?= V::e($csrf ?? '') ?>">
      <button class="btn btn--ghost">Wyloguj</button>
    </form>
  </div>
  <?php endif; ?>
</header>

<nav class="nav">
  <?php foreach ($nav as $href => $label): ?>
    <a href="<?= V::e($href) ?>" class="<?= $current === rtrim($href, '/') ? 'active' : '' ?>"><?= V::e($label) ?></a>
  <?php endforeach; ?>
</nav>

<main class="wrap">
<?= $content ?>
</main>

<footer class="foot">
  Cloud Hub · schemat v<?= V::e(\Hub\Database::SCHEMA_VERSION) ?> · <?= V::e(gmdate('Y-m-d H:i')) ?> UTC
</footer>
</body>
</html>
