<?php
use Hub\Admin\View as V;

$statuses = ['' => 'wszystkie', 'pending' => 'oczekujące', 'claimed' => 'pobrane', 'synced' => 'zapisane', 'failed' => 'błędne', 'skipped' => 'pominięte'];
$sources  = ['' => 'wszystkie', 'allegro' => 'Allegro', 'baselinker' => 'BaseLinker'];
?>
<h1>Kolejka zamówień <small><?= (int) $total ?></small></h1>

<form method="get" class="filters">
  <label>Status
    <select name="status" onchange="this.form.submit()">
      <?php foreach ($statuses as $k => $label): ?>
        <option value="<?= V::e($k) ?>" <?= $status === $k ? 'selected' : '' ?>><?= V::e($label) ?></option>
      <?php endforeach; ?>
    </select>
  </label>
  <label>Źródło
    <select name="source" onchange="this.form.submit()">
      <?php foreach ($sources as $k => $label): ?>
        <option value="<?= V::e($k) ?>" <?= $source === $k ? 'selected' : '' ?>><?= V::e($label) ?></option>
      <?php endforeach; ?>
    </select>
  </label>
  <noscript><button class="btn">Filtruj</button></noscript>
</form>

<form method="post" action="/admin/orders/action">
  <input type="hidden" name="_csrf" value="<?= V::e($csrf) ?>">

  <div class="bulkbar">
    <button class="btn" name="action" value="requeue">Ponów (→ oczekujące)</button>
    <button class="btn" name="action" value="skip">Oznacz jako pominięte</button>
    <button class="btn btn--danger" name="action" value="delete"
            onclick="return confirm('Trwale usunąć zaznaczone zamówienia z kolejki?')">Usuń</button>
    <span class="hint">Zaznacz wiersze, na których ma zadziałać akcja.</span>
  </div>

  <table class="tbl tbl--zebra">
    <thead>
      <tr>
        <th><input type="checkbox" onclick="document.querySelectorAll('.rowcheck').forEach(c=>c.checked=this.checked)"></th>
        <th>ID</th><th>Źródło</th><th>Nr zewnętrzny</th><th>Status</th>
        <th class="num">Prób</th><th>Agent</th><th>Zapisane</th><th>Ref. Wapro</th><th>Błąd</th>
      </tr>
    </thead>
    <tbody>
    <?php if (!$rows): ?>
      <tr><td colspan="10" class="empty">Brak zamówień spełniających kryteria.</td></tr>
    <?php endif; ?>
    <?php foreach ($rows as $r): ?>
      <tr>
        <td><input type="checkbox" class="rowcheck" name="ids[]" value="<?= (int) $r['id'] ?>"></td>
        <td><?= (int) $r['id'] ?></td>
        <td><?= V::e($r['source']) ?></td>
        <td><code><?= V::e($r['external_id']) ?></code></td>
        <td>
          <?php
          $cls = match ($r['status']) {
              'synced'  => 'ok',
              'failed'  => 'error',
              'pending' => 'warn',
              default   => 'muted',
          };
          ?>
          <span class="tag tag--<?= $cls ?>"><?= V::e($r['status']) ?></span>
        </td>
        <td class="num"><?= (int) $r['attempts'] ?></td>
        <td><?= V::e($r['claimed_by'] ?? '—') ?></td>
        <td class="nowrap"><?= V::e($r['synced_at'] ?? '—') ?></td>
        <td><?= V::e($r['wapro_ref'] ?? '—') ?></td>
        <td class="wrap small"><?= V::e($r['last_error'] ?? '') ?></td>
      </tr>
    <?php endforeach; ?>
    </tbody>
  </table>
</form>

<?php if ($pages > 1): ?>
<nav class="pager">
  <?php for ($p = max(1, $page - 3); $p <= min($pages, $page + 3); $p++): ?>
    <a href="?status=<?= V::e($status) ?>&source=<?= V::e($source) ?>&page=<?= $p ?>"
       class="<?= $p === $page ? 'active' : '' ?>"><?= $p ?></a>
  <?php endfor; ?>
  <span class="hint">strona <?= $page ?> z <?= $pages ?></span>
</nav>
<?php endif; ?>
