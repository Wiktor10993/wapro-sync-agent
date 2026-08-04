<?php
use Hub\Admin\View as V;
?>
<h1>Logi akcji <small><?= (int) $total ?></small></h1>
<p class="hint">
  Rejestr wszystkich zmian przechodzących przez huba. Wpisy <code>outbound</code> +
  <code>wapro_agent</code> stanowią podstawę mechanizmu Anti-Loop — na ich podstawie
  hub rozpoznaje echo własnych aktualizacji.
</p>

<form method="get" class="filters">
  <label>Typ
    <select name="entity_type">
      <option value="">wszystkie</option>
      <option value="stock" <?= $filters['entity_type'] === 'stock' ? 'selected' : '' ?>>stany</option>
      <option value="order" <?= $filters['entity_type'] === 'order' ? 'selected' : '' ?>>zamówienia</option>
    </select>
  </label>
  <label>Kanał
    <select name="channel">
      <option value="">wszystkie</option>
      <?php foreach (['allegro', 'baselinker', 'hub', 'wapro'] as $c): ?>
        <option value="<?= $c ?>" <?= $filters['channel'] === $c ? 'selected' : '' ?>><?= $c ?></option>
      <?php endforeach; ?>
    </select>
  </label>
  <label>Status
    <select name="status">
      <option value="">wszystkie</option>
      <?php foreach (['ok', 'error', 'skipped'] as $s): ?>
        <option value="<?= $s ?>" <?= $filters['status'] === $s ? 'selected' : '' ?>><?= $s ?></option>
      <?php endforeach; ?>
    </select>
  </label>
  <label>Szukaj
    <input name="q" value="<?= V::e($filters['q']) ?>" placeholder="SKU lub treść komunikatu">
  </label>
  <button class="btn">Filtruj</button>
  <a class="btn btn--ghost" href="/admin/logs">Wyczyść</a>
</form>

<table class="tbl tbl--zebra small">
  <thead>
    <tr>
      <th>Kiedy (UTC)</th><th>Typ</th><th>Klucz</th><th>Kanał</th>
      <th>Kierunek</th><th>Inicjator</th><th class="num">Ilość</th><th>Status</th><th>Komunikat</th>
    </tr>
  </thead>
  <tbody>
  <?php if (!$rows): ?>
    <tr><td colspan="9" class="empty">Brak wpisów.</td></tr>
  <?php endif; ?>
  <?php foreach ($rows as $r): ?>
    <tr>
      <td class="nowrap"><?= V::e($r['created_at']) ?></td>
      <td><?= V::e($r['entity_type']) ?></td>
      <td><code><?= V::e($r['entity_key']) ?></code></td>
      <td><?= V::e($r['channel']) ?></td>
      <td><?= $r['direction'] === 'outbound' ? '→ kanał' : '← kanał' ?></td>
      <td><?= V::e($r['initiator']) ?></td>
      <td class="num"><?= $r['quantity'] === null ? '—' : (int) $r['quantity'] ?></td>
      <td>
        <span class="tag tag--<?= $r['status'] === 'ok' ? 'ok' : ($r['status'] === 'error' ? 'error' : 'muted') ?>">
          <?= V::e($r['status']) ?>
        </span>
      </td>
      <td class="wrap"><?= V::e($r['message']) ?></td>
    </tr>
  <?php endforeach; ?>
  </tbody>
</table>

<?php if ($pages > 1): ?>
<nav class="pager">
  <?php
  $qs = $filters;
  for ($p = max(1, $page - 3); $p <= min($pages, $page + 3); $p++):
      $qs['page'] = $p;
  ?>
    <a href="?<?= V::e(http_build_query($qs)) ?>" class="<?= $p === $page ? 'active' : '' ?>"><?= $p ?></a>
  <?php endfor; ?>
  <span class="hint">strona <?= $page ?> z <?= $pages ?></span>
</nav>
<?php endif; ?>
