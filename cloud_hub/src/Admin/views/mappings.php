<?php
use Hub\Admin\View as V;
?>
<h1>Mapowania SKU <small><?= (int) $stats['total'] ?></small></h1>

<?php if ($report): ?>
  <?php $d = $report['data']; ?>
  <div class="alert alert--<?= $report['type'] === 'error' || !empty($d['errors']) ? 'warn' : 'ok' ?>">
    <strong>
      <?= V::e(match ($report['type']) {
          'import'     => 'Import CSV',
          'allegro'    => 'Synchronizacja z Allegro',
          'baselinker' => 'Synchronizacja z BaseLinkerem',
          default      => 'Wynik',
      }) ?>:
    </strong>
    <?php if (isset($d['scanned'])): ?>przeskanowano <?= (int) $d['scanned'] ?>, <?php endif; ?>
    <?php if (isset($d['rows'])): ?>wierszy <?= (int) $d['rows'] ?>, <?php endif; ?>
    dodano <?= (int) ($d['inserted'] ?? 0) ?>,
    zaktualizowano <?= (int) ($d['updated'] ?? 0) ?>,
    bez zmian <?= (int) ($d['skipped'] ?? 0) ?><?php
    if (!empty($d['no_sku'])): ?>, bez SKU <?= (int) $d['no_sku'] ?><?php endif;
    if (!empty($d['deactivated'])): ?>, dezaktywowano <?= (int) $d['deactivated'] ?><?php endif; ?>.

    <?php if (!empty($d['errors'])): ?>
      <ul class="errlist">
        <?php foreach (array_slice($d['errors'], 0, 15) as $err): ?>
          <li><?= V::e($err) ?></li>
        <?php endforeach; ?>
        <?php if (count($d['errors']) > 15): ?>
          <li>… i <?= count($d['errors']) - 15 ?> więcej</li>
        <?php endif; ?>
      </ul>
    <?php endif; ?>
  </div>
<?php endif; ?>

<div class="cols">
  <section class="card">
    <h2>Automatyczne pobranie</h2>
    <p class="hint">
      Allegro: SKU czytane jest z pola <code>external.id</code> oferty (sygnatura).
      BaseLinker: z pola <code>sku</code> produktu lub wariantu.
      Wpisy dodane ręcznie nigdy nie są nadpisywane.
    </p>
    <form method="post" action="/admin/mappings/action" class="inline">
      <input type="hidden" name="_csrf" value="<?= V::e($csrf) ?>">
      <button class="btn" name="action" value="sync_allegro">Pobierz z Allegro</button>
      <button class="btn" name="action" value="sync_baselinker">Pobierz z BaseLinkera</button>
    </form>
  </section>

  <section class="card">
    <h2>Import / eksport CSV</h2>
    <form method="post" action="/admin/mappings/action" enctype="multipart/form-data">
      <input type="hidden" name="_csrf" value="<?= V::e($csrf) ?>">
      <input type="hidden" name="action" value="import">
      <label>Plik CSV
        <input type="file" name="csv" accept=".csv,text/csv" required>
      </label>
      <p class="hint">Nagłówek: <code>sku;channel;external_ref;variant_ref;title</code> (separator <code>;</code> lub <code>,</code>)</p>
      <button class="btn btn--primary">Importuj</button>
      <a class="btn" href="/admin/mappings/export">Pobierz eksport</a>
    </form>
  </section>

  <section class="card">
    <h2>Dodaj ręcznie</h2>
    <form method="post" action="/admin/mappings/action">
      <input type="hidden" name="_csrf" value="<?= V::e($csrf) ?>">
      <input type="hidden" name="action" value="add">
      <div class="formgrid">
        <label>SKU (Wapro)<input name="sku" required></label>
        <label>Kanał
          <select name="channel"><option value="allegro">Allegro</option><option value="baselinker">BaseLinker</option></select>
        </label>
        <label>ID w kanale<input name="external_ref" required placeholder="offerId / product_id"></label>
        <label>Wariant<input name="variant_ref" value="0"></label>
        <label class="span2">Opis<input name="title" placeholder="nazwa oferty (opcjonalnie)"></label>
      </div>
      <button class="btn btn--primary">Dodaj mapowanie</button>
    </form>
  </section>
</div>

<?php if ($unmapped): ?>
<section class="card">
  <h2>SKU bez mapowania (<?= count($unmapped) ?>)</h2>
  <div class="chips">
    <?php foreach ($unmapped as $u): ?>
      <span class="chip"><?= V::e($u['sku']) ?></span>
    <?php endforeach; ?>
  </div>
</section>
<?php endif; ?>

<form method="get" class="filters">
  <label>Kanał
    <select name="channel">
      <option value="">wszystkie</option>
      <option value="allegro" <?= $filters['channel'] === 'allegro' ? 'selected' : '' ?>>Allegro</option>
      <option value="baselinker" <?= $filters['channel'] === 'baselinker' ? 'selected' : '' ?>>BaseLinker</option>
    </select>
  </label>
  <label>Pochodzenie
    <select name="origin">
      <option value="">wszystkie</option>
      <?php foreach (['manual' => 'ręczne', 'auto' => 'automatyczne', 'csv' => 'z CSV'] as $k => $lbl): ?>
        <option value="<?= $k ?>" <?= $filters['origin'] === $k ? 'selected' : '' ?>><?= $lbl ?></option>
      <?php endforeach; ?>
    </select>
  </label>
  <label>Stan
    <select name="active">
      <option value="">wszystkie</option>
      <option value="1" <?= $filters['active'] === '1' ? 'selected' : '' ?>>aktywne</option>
      <option value="0" <?= $filters['active'] === '0' ? 'selected' : '' ?>>nieaktywne</option>
    </select>
  </label>
  <label>Szukaj<input name="q" value="<?= V::e($filters['q']) ?>"></label>
  <button class="btn">Filtruj</button>
</form>

<table class="tbl tbl--zebra">
  <thead>
    <tr><th>SKU</th><th>Kanał</th><th>ID w kanale</th><th>Wariant</th><th>Opis</th>
        <th>Pochodzenie</th><th>Widziane</th><th>Stan</th><th></th></tr>
  </thead>
  <tbody>
  <?php if (!$rows): ?>
    <tr><td colspan="9" class="empty">Brak mapowań. Zacznij od automatycznego pobrania albo importu CSV.</td></tr>
  <?php endif; ?>
  <?php foreach ($rows as $r): ?>
    <tr class="<?= (int) $r['active'] === 0 ? 'row--off' : '' ?>">
      <td><code><?= V::e($r['sku']) ?></code></td>
      <td><?= V::e($r['channel']) ?></td>
      <td><code><?= V::e($r['external_ref']) ?></code></td>
      <td><?= V::e($r['variant_ref']) ?></td>
      <td class="wrap"><?= V::e($r['title']) ?></td>
      <td><span class="tag tag--muted"><?= V::e($r['origin']) ?></span></td>
      <td class="nowrap small"><?= V::e($r['last_seen_at'] ?? '—') ?></td>
      <td><?= (int) $r['active'] === 1 ? '<span class="tag tag--ok">aktywne</span>' : '<span class="tag tag--muted">wyłączone</span>' ?></td>
      <td class="nowrap">
        <form method="post" action="/admin/mappings/action" class="inline">
          <input type="hidden" name="_csrf" value="<?= V::e($csrf) ?>">
          <input type="hidden" name="id" value="<?= (int) $r['id'] ?>">
          <input type="hidden" name="active" value="<?= (int) $r['active'] === 1 ? 0 : 1 ?>">
          <button class="btn btn--tiny" name="action" value="toggle"><?= (int) $r['active'] === 1 ? 'Wyłącz' : 'Włącz' ?></button>
        </form>
        <form method="post" action="/admin/mappings/action" class="inline"
              onsubmit="return confirm('Usunąć mapowanie <?= V::e($r['sku']) ?>?')">
          <input type="hidden" name="_csrf" value="<?= V::e($csrf) ?>">
          <input type="hidden" name="id" value="<?= (int) $r['id'] ?>">
          <button class="btn btn--tiny btn--danger" name="action" value="delete">Usuń</button>
        </form>
      </td>
    </tr>
  <?php endforeach; ?>
  </tbody>
</table>

<?php if ($pages > 1): ?>
<nav class="pager">
  <?php $qs = $filters; for ($p = max(1, $page - 3); $p <= min($pages, $page + 3); $p++): $qs['page'] = $p; ?>
    <a href="?<?= V::e(http_build_query($qs)) ?>" class="<?= $p === $page ? 'active' : '' ?>"><?= $p ?></a>
  <?php endfor; ?>
</nav>
<?php endif; ?>
