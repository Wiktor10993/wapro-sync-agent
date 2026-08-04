<?php
/** @var string|null $error */
use Hub\Admin\View as V;
?><!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Logowanie — Cloud Hub</title>
<link rel="stylesheet" href="/assets/admin.css">
</head>
<body class="login-page">
<form method="post" action="/admin/login" class="login-box">
  <h1>Cloud Hub</h1>
  <p class="login-box__sub">Panel administracyjny integracji Wapro</p>

  <?php if ($error): ?>
    <div class="alert alert--error"><?= V::e($error) ?></div>
  <?php endif; ?>

  <label>Login
    <input name="login" autocomplete="username" required autofocus>
  </label>
  <label>Hasło
    <input name="password" type="password" autocomplete="current-password" required>
  </label>

  <button class="btn btn--primary btn--block">Zaloguj</button>

  <p class="login-box__hint">
    Konto zakłada się poleceniem<br>
    <code>php bin/create_admin.php &lt;tenant&gt; &lt;login&gt;</code>
  </p>
</form>
</body>
</html>
