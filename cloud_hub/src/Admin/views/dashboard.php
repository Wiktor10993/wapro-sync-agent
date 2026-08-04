<?php
use Hub\Admin\View as V;

$act = ['outbound_ok' => 0, 'inbound_ok' => 0, 'skipped' => 0, 'errors' => 0];
foreach ($activity as $a) {
    if ($a['status'] === 'error')        { $act['errors']  += (int) $a['c']; }
    elseif ($a['status'] === 'skipped')  { $act['skipped'] += (int) $a['c']; }
    elseif ($a['direction'] === 'outbound') { $act['outbound_ok'] += (int) $a['c']; }
    else                                 { $act['inbound_ok'] += (int) $a['c']; }
}
?>
<h1>Pulpit</h1>

<div class="stats">
  <div class="stat"><span class="stat__num"><?= (int) $counts['pending'] ?></span>zamówień czeka</div>
  <div class="stat"><span class="stat__num"><?= (int) $counts['claimed'] ?></span>pobranych przez agenta</div>
  <div class="stat"><span class="stat__num"><?= (int) $counts['synced'] ?></span>zapisanych w Wapro</div>
  <div class="stat <?= $counts['failed'] > 0 ? 'stat--bad' : '' ?>"><span class="stat__num"><?= (int) $counts['failed'] ?></span>błędnych</div>
  <div class="stat"><span class="stat__num"><?= (int) $trackedSkus ?></span>SKU pod kontrolą</div>
  <div class="stat"><span class="stat__num"><?= (int) $mapStats['total'] ?></span>mapowań</div>
</div>

<div class="cols">
  <section class="card">
    <h2>Ruch w ostatniej dobie</h2>
    <table class="tbl">
      <tr><td>Wysłane na kanały</td><td class="num"><?= $act['outbound_ok'] ?></td></tr>
      <tr><td>Odebrane z kanałów</td><td class="num"><?= $act['inbound_ok'] ?></td></tr>
      <tr><td>Pominięte przez Anti-Loop</td><td class="num"><?= $act['skipped'] ?></td></tr>
      <tr><td>Błędy</td><td class="num <?= $act['errors'] > 0 ? 'bad' : '' ?>"><?= $act['errors'] ?></td></tr>
    </table>
    <?php if ($act['skipped'] > 0): ?>
      <p class="hint">Pominięcia to zdrowy objaw — Anti-Loop odciął echo własnych aktualizacji.</p>
    <?php endif; ?>
  </section>

  <section class="card">
    <h2>Połączenie z Allegro</h2>
    <?php if (!$allegro['authorized']): ?>
      <p class="alert alert--warn">Brak autoryzacji. Zamówienia z Allegro nie będą pobierane.</p>
      <a class="btn btn--primary" href="/admin/oauth/allegro/start">Połącz konto Allegro</a>
    <?php else: ?>
      <table class="tbl">
        <tr><td>Status</td><td><?= $allegro['expired'] ? '<span class="tag tag--warn">token wygasł</span>' : '<span class="tag tag--ok">aktywne</span>' ?></td></tr>
        <tr><td>Ważny do</td><td><?= V::e($allegro['expires_at']) ?> UTC</td></tr>
        <tr><td>Odświeżanie</td><td><?= $allegro['has_refresh'] ? 'automatyczne' : '<span class="tag tag--warn">brak refresh_token</span>' ?></td></tr>
      </table>
      <?php if ($allegro['expired'] && !$allegro['has_refresh']): ?>
        <p class="alert alert--error">Token wygasł i nie ma czym go odświeżyć — połącz konto ponownie.</p>
        <a class="btn btn--primary" href="/admin/oauth/allegro/start">Połącz ponownie</a>
      <?php endif; ?>
    <?php endif; ?>
  </section>

  <section class="card">
    <h2>Agenci</h2>
    <?php if (!$agents): ?>
      <p class="hint">Brak zarejestrowanych agentów. <a href="/admin/agents">Dodaj agenta</a>.</p>
    <?php else: ?>
    <table class="tbl">
      <thead><tr><th>Nazwa</th><th>Ostatni kontakt</th></tr></thead>
      <tbody>
      <?php foreach ($agents as $a):
        $ts = $a['last_seen_at'] ? strtotime((string) $a['last_seen_at']) : 0;
        $stale = $ts === 0 || (time() - $ts) > 3600;
      ?>
        <tr>
          <td><?= V::e($a['name']) ?></td>
          <td class="<?= $stale ? 'bad' : '' ?>">
            <?= $a['last_seen_at'] ? V::e($a['last_seen_at']) . ' UTC' : 'nigdy' ?>
          </td>
        </tr>
      <?php endforeach; ?>
      </tbody>
    </table>
    <?php endif; ?>
  </section>

  <section class="card">
    <h2>Ostatnie zadania w tle</h2>
    <?php if (!$jobs): ?>
      <p class="hint">Brak wpisów. Sprawdź, czy cron jest skonfigurowany.</p>
    <?php else: ?>
    <table class="tbl">
      <thead><tr><th>Zadanie</th><th>Status</th><th>Start</th><th class="num">Czas</th></tr></thead>
      <tbody>
      <?php foreach ($jobs as $j): ?>
        <tr>
          <td><?= V::e($j['job']) ?></td>
          <td><span class="tag tag--<?= $j['status'] === 'ok' ? 'ok' : ($j['status'] === 'error' ? 'error' : 'warn') ?>"><?= V::e($j['status']) ?></span></td>
          <td><?= V::e($j['started_at']) ?></td>
          <td class="num"><?= $j['duration_ms'] !== null ? (int) $j['duration_ms'] . ' ms' : '—' ?></td>
        </tr>
      <?php endforeach; ?>
      </tbody>
    </table>
    <?php endif; ?>
  </section>
</div>

<?php if ($unmapped): ?>
<section class="card">
  <h2>SKU bez mapowania (<?= count($unmapped) ?>)</h2>
  <p class="hint">
    Te indeksy przyszły z Wapro, ale nie są powiązane z żadną ofertą ani produktem —
    ich stany nie trafiają na kanały sprzedaży.
  </p>
  <div class="chips">
    <?php foreach ($unmapped as $u): ?>
      <span class="chip"><?= V::e($u['sku']) ?> <em><?= (int) $u['quantity'] ?> szt.</em></span>
    <?php endforeach; ?>
  </div>
  <p><a class="btn" href="/admin/mappings">Przejdź do mapowań</a></p>
</section>
<?php endif; ?>

<?php if ($recentErrors): ?>
<section class="card">
  <h2>Ostatnie błędy</h2>
  <table class="tbl tbl--zebra">
    <thead><tr><th>Kiedy</th><th>Kanał</th><th>Klucz</th><th>Komunikat</th></tr></thead>
    <tbody>
    <?php foreach ($recentErrors as $e): ?>
      <tr>
        <td class="nowrap"><?= V::e($e['created_at']) ?></td>
        <td><?= V::e($e['channel']) ?></td>
        <td><code><?= V::e($e['entity_key']) ?></code></td>
        <td class="wrap"><?= V::e($e['message']) ?></td>
      </tr>
    <?php endforeach; ?>
    </tbody>
  </table>
</section>
<?php endif; ?>
