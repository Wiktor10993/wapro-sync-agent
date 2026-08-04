<?php
use Hub\Admin\View as V;
$v = static fn(string $k, string $d = '') => V::e($values[$k] ?? $d);
?>
<h1>Ustawienia</h1>

<?php if (!empty($saved)): ?>
  <div class="alert alert--ok">Zapisano.</div>
<?php endif; ?>

<?php if ($globals['pepper_default']): ?>
  <div class="alert alert--error">
    <strong>HUB_API_KEY_PEPPER ma wartość domyślną.</strong>
    Ustaw własny sekret (<code>openssl rand -hex 32</code>) i zarejestruj agentów ponownie —
    inaczej klucze API są przewidywalne.
  </div>
<?php endif; ?>

<div class="cols">
  <section class="card">
    <h2>Allegro</h2>
    <?php if (!$allegro['authorized']): ?>
      <p class="alert alert--warn">Konto nie jest połączone.</p>
    <?php else: ?>
      <table class="tbl">
        <tr><td>Token ważny do</td><td><?= V::e($allegro['expires_at']) ?> UTC</td></tr>
        <tr><td>Zakres</td><td class="small wrap"><?= V::e($allegro['scope']) ?></td></tr>
      </table>
    <?php endif; ?>

    <p class="hint">
      W panelu Allegro (Moje aplikacje) ustaw <b>dokładnie</b> ten adres powrotny:
    </p>
    <pre class="keybox"><?= V::e($redirectUri) ?></pre>

    <div class="button-row">
      <a class="btn btn--primary" href="/admin/oauth/allegro/start">
        <?= $allegro['authorized'] ? 'Połącz ponownie' : 'Połącz konto Allegro' ?>
      </a>
      <?php if ($allegro['authorized']): ?>
      <form method="post" action="/admin/oauth/allegro/revoke" class="inline"
            onsubmit="return confirm('Odłączyć konto Allegro? Pobieranie zamówień przestanie działać.')">
        <input type="hidden" name="_csrf" value="<?= V::e($csrf) ?>">
        <button class="btn btn--danger">Odłącz</button>
      </form>
      <?php endif; ?>
    </div>

    <p class="hint">
      Dane aplikacji (<code>ALLEGRO_CLIENT_ID</code>, <code>ALLEGRO_CLIENT_SECRET</code>)
      ustawia się w zmiennych środowiskowych serwera:
      <?= $globals['allegro_client_id'] ? '<span class="tag tag--ok">skonfigurowane</span>' : '<span class="tag tag--error">brak</span>' ?>
    </p>
  </section>

  <section class="card">
    <h2>Stan konfiguracji globalnej</h2>
    <table class="tbl">
      <tr><td>ALLEGRO_CLIENT_ID</td><td><?= $globals['allegro_client_id'] ? '<span class="tag tag--ok">ustawione</span>' : '<span class="tag tag--error">brak</span>' ?></td></tr>
      <tr><td>BASELINKER_TOKEN (globalny)</td><td><?= $globals['baselinker_token'] ? '<span class="tag tag--ok">ustawione</span>' : '<span class="tag tag--muted">brak</span>' ?></td></tr>
      <tr><td>Sekret webhooka BaseLinkera</td><td><?= $globals['webhook_secret'] ? '<span class="tag tag--ok">ustawione</span>' : '<span class="tag tag--warn">brak — webhook bez weryfikacji podpisu</span>' ?></td></tr>
    </table>
  </section>
</div>

<section class="card">
  <h2>Ustawienia tego klienta</h2>
  <p class="hint">Wartości puste oznaczają „użyj konfiguracji globalnej serwera”.</p>

  <form method="post" action="/admin/settings/save">
    <input type="hidden" name="_csrf" value="<?= V::e($csrf) ?>">

    <div class="formgrid">
      <label>Token BaseLinkera
        <input name="baselinker_token" value="<?= $v('baselinker.token') ?>" placeholder="nadpisuje wartość globalną">
      </label>
      <label>ID katalogu (inventory_id)
        <input name="baselinker_inventory_id" value="<?= $v('baselinker.inventory_id') ?>" inputmode="numeric">
      </label>
      <label>ID magazynu w BaseLinkerze
        <input name="baselinker_warehouse_id" value="<?= $v('baselinker.warehouse_id') ?>" placeholder="np. bl_1">
      </label>
      <label>Okno echa Anti-Loop (sekundy)
        <input name="anti_loop_echo_window" value="<?= $v('anti_loop.echo_window') ?>" inputmode="numeric" placeholder="180">
      </label>
      <label class="span2">Status realizacji ustawiany w Allegro po zapisie w Wapro
        <select name="orders_auto_fulfillment_status">
          <?php
          $current = $values['orders.auto_fulfillment_status'] ?? '';
          $opts = ['' => '— nie zmieniaj —', 'PROCESSING' => 'PROCESSING (w realizacji)', 'READY_FOR_SHIPMENT' => 'READY_FOR_SHIPMENT (gotowe do wysyłki)'];
          foreach ($opts as $k => $label): ?>
            <option value="<?= V::e($k) ?>" <?= $current === $k ? 'selected' : '' ?>><?= V::e($label) ?></option>
          <?php endforeach; ?>
        </select>
      </label>
    </div>

    <button class="btn btn--primary">Zapisz</button>
  </form>
</section>

<section class="card">
  <h2>Zadania cron</h2>
  <p class="hint">Wklej do crontab użytkownika serwera WWW:</p>
  <pre class="keybox">* * * * *   php /sciezka/cloud_hub/bin/poll_allegro_events.php <?= V::e($user['tenant_id']) ?>

*/5 * * * * php /sciezka/cloud_hub/bin/poll_baselinker_orders.php <?= V::e($user['tenant_id']) ?>

0 3 * * *   php /sciezka/cloud_hub/bin/sync_sku_map.php <?= V::e($user['tenant_id']) ?> both
15 3 * * *  php /sciezka/cloud_hub/bin/prune_logs.php <?= V::e($user['tenant_id']) ?> 30</pre>
</section>
