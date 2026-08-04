<?php
use Hub\Admin\View as V;
?>
<div class="card">
  <h1><?= V::e($title ?? 'Błąd') ?></h1>
  <p><?= V::e($message ?? '') ?></p>
  <p><a href="/admin" class="btn">Wróć do pulpitu</a></p>
</div>
