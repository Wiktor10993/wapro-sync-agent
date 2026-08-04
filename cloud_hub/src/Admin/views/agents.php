<?php
use Hub\Admin\View as V;
?>
<h1>Agenci desktopowi</h1>

<?php if ($newKey): ?>
<div class="alert alert--ok">
  <strong>Utworzono agenta „<?= V::e($newKey['name']) ?>”.</strong>
  <p>Skopiuj klucz i wklej go w aplikacji desktopowej (zakładka „Konto Cloud”). <b>Nie zostanie pokazany ponownie</b> — w bazie zapisany jest wyłącznie jego skrót.</p>
  <pre class="keybox"><?= V::e($newKey['key']) ?></pre>
</div>
<?php endif; ?>

<section class="card">
  <h2>Nowy agent</h2>
  <form method="post" action="/admin/agents/action">
    <input type="hidden" name="_csrf" value="<?= V::e($csrf) ?>">
    <input type="hidden" name="action" value="create">
    <label>Nazwa (np. „Biuro Warszawa”, „Magazyn”)
      <input name="name" required maxlength="64">
    </label>
    <button class="btn btn--primary">Utwórz i wygeneruj klucz</button>
  </form>
</section>

<table class="tbl tbl--zebra">
  <thead><tr><th>ID</th><th>Nazwa</th><th>Ostatni kontakt (UTC)</th><th>Utworzony</th><th>Stan</th><th></th></tr></thead>
  <tbody>
  <?php if (!$rows): ?>
    <tr><td colspan="6" class="empty">Brak agentów.</td></tr>
  <?php endif; ?>
  <?php foreach ($rows as $r):
      $ts = $r['last_seen_at'] ? strtotime((string) $r['last_seen_at']) : 0;
      $stale = $ts === 0 || (time() - $ts) > 3600;
  ?>
    <tr class="<?= (int) $r['active'] === 0 ? 'row--off' : '' ?>">
      <td><?= (int) $r['id'] ?></td>
      <td><?= V::e($r['name']) ?></td>
      <td class="<?= $stale ? 'bad' : '' ?>"><?= $r['last_seen_at'] ? V::e($r['last_seen_at']) : 'nigdy' ?></td>
      <td class="small"><?= V::e($r['created_at']) ?></td>
      <td><?= (int) $r['active'] === 1 ? '<span class="tag tag--ok">aktywny</span>' : '<span class="tag tag--muted">zablokowany</span>' ?></td>
      <td class="nowrap">
        <form method="post" action="/admin/agents/action" class="inline">
          <input type="hidden" name="_csrf" value="<?= V::e($csrf) ?>">
          <input type="hidden" name="id" value="<?= (int) $r['id'] ?>">
          <input type="hidden" name="active" value="<?= (int) $r['active'] === 1 ? 0 : 1 ?>">
          <button class="btn btn--tiny" name="action" value="toggle"><?= (int) $r['active'] === 1 ? 'Zablokuj' : 'Odblokuj' ?></button>
        </form>
        <form method="post" action="/admin/agents/action" class="inline"
              onsubmit="return confirm('Usunąć agenta? Jego klucz przestanie działać natychmiast.')">
          <input type="hidden" name="_csrf" value="<?= V::e($csrf) ?>">
          <input type="hidden" name="id" value="<?= (int) $r['id'] ?>">
          <button class="btn btn--tiny btn--danger" name="action" value="delete">Usuń</button>
        </form>
      </td>
    </tr>
  <?php endforeach; ?>
  </tbody>
</table>
