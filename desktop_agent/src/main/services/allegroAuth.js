import http from 'node:http'
import crypto from 'node:crypto'
import { shell } from 'electron'
import {
  clearAllegroTokens,
  getIntegrations,
  saveAllegroTokens,
  setIntegrationCheck
} from '../store.js'

/**
 * AUTORYZACJA ALLEGRO W APLIKACJI DESKTOPOWEJ
 * ===========================================
 *
 * Przepływ: Authorization Code + PKCE z adresem powrotnym na pętli zwrotnej
 * (`http://localhost:PORT/callback`). To wzorzec zalecany dla aplikacji
 * natywnych przez RFC 8252.
 *
 * Dlaczego przeglądarka systemowa, a nie okno Electrona:
 * logowanie odbywa się na stronie Allegro, w przeglądarce, którą użytkownik
 * zna i której pasek adresu widzi. Gdybyśmy otworzyli formularz logowania
 * w oknie aplikacji, przyzwyczajalibyśmy klienta do wpisywania hasła do Allegro
 * w oknie, które równie dobrze mogłoby być podrobione. Aplikacja nigdy nie
 * widzi hasła — dostaje wyłącznie kod autoryzacyjny.
 *
 * PKCE stosujemy mimo posiadania `client_secret`, bo w aplikacji desktopowej
 * sekret i tak nie jest tajemnicą — leży na dysku klienta. PKCE chroni przed
 * przechwyceniem kodu przez inny proces nasłuchujący na tym samym porcie.
 */

const AUTH_TIMEOUT_MS = 5 * 60 * 1000
const ACCEPT_HEADER = 'application/vnd.allegro.public.v1+json'

/** Adresy produkcyjne i sandboxowe. */
function endpoints(sandbox) {
  return sandbox
    ? {
        auth: 'https://allegro.pl.allegrosandbox.pl/auth/oauth',
        api: 'https://api.allegro.pl.allegrosandbox.pl'
      }
    : {
        auth: 'https://allegro.pl/auth/oauth',
        api: 'https://api.allegro.pl'
      }
}

function base64Url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Rozbiera redirect_uri na port i ścieżkę; waliduje, że to pętla zwrotna. */
function parseRedirect(redirectUri) {
  let url
  try {
    url = new URL(redirectUri)
  } catch {
    throw new Error(`Nieprawidłowy adres powrotny: ${redirectUri}`)
  }

  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (!isLoopback) {
    throw new Error(
      'Adres powrotny musi wskazywać na localhost — aplikacja desktopowa nie ma ' +
        'publicznego serwera, który mógłby odebrać przekierowanie.'
    )
  }
  if (url.protocol !== 'http:') {
    throw new Error('Dla pętli zwrotnej Allegro oczekuje protokołu http://')
  }

  const port = Number(url.port)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('Adres powrotny musi zawierać port z zakresu 1024–65535, np. http://localhost:8123/callback')
  }

  return { port, path: url.pathname || '/callback', origin: url.origin }
}

// ---------------------------------------------------------------------------
// Strony zwracane użytkownikowi w przeglądarce
// ---------------------------------------------------------------------------

function resultPage(ok, title, message) {
  const accent = ok ? '#14b8a6' : '#f87171'
  return `<!doctype html>
<html lang="pl"><head><meta charset="utf-8"><title>${title}</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#0f141a;color:#e6edf3;
       font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
  .box{max-width:440px;padding:36px 40px;background:#1a222c;border:1px solid #2a3542;
       border-radius:12px;text-align:center}
  h1{margin:0 0 10px;font-size:19px;color:${accent}}
  p{margin:0;color:#9aa8b8;font-size:14px;line-height:1.6}
</style></head>
<body><div class="box"><h1>${title}</h1><p>${message}</p></div></body></html>`
}

// ---------------------------------------------------------------------------
// Krok 1–2: autoryzacja
// ---------------------------------------------------------------------------

/** Jedna autoryzacja naraz — drugi serwer nie zająłby tego samego portu. */
let activeFlow = null

/**
 * Uruchamia pełny przepływ autoryzacji.
 *
 * @param {(level:string, message:string)=>void} [log]
 * @returns {Promise<{ok:boolean, scope?:string, expiresAt?:string, error?:string}>}
 */
export async function authorizeAllegro(log = () => {}) {
  if (activeFlow) {
    return { ok: false, error: 'Autoryzacja już trwa — dokończ ją w przeglądarce albo poczekaj na wygaśnięcie.' }
  }

  const { allegro } = getIntegrations({ withSecrets: true })

  if (!allegro.clientId) {
    return { ok: false, error: 'Nie podano Client ID aplikacji Allegro.' }
  }
  if (!allegro.clientSecret) {
    return { ok: false, error: 'Nie podano Client Secret aplikacji Allegro.' }
  }

  let redirect
  try {
    redirect = parseRedirect(allegro.redirectUri)
  } catch (err) {
    return { ok: false, error: err.message }
  }

  const { auth } = endpoints(allegro.sandbox)

  const state = base64Url(crypto.randomBytes(24))
  const verifier = base64Url(crypto.randomBytes(48))
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest())

  activeFlow = { state, startedAt: Date.now() }

  try {
    const code = await waitForCode({
      redirect,
      state,
      challenge,
      authBase: auth,
      clientId: allegro.clientId,
      redirectUri: allegro.redirectUri,
      log
    })

    log('info', 'Allegro: odebrano kod autoryzacyjny, wymieniam na token…')

    const tokens = await exchangeCode({
      auth,
      clientId: allegro.clientId,
      clientSecret: allegro.clientSecret,
      redirectUri: allegro.redirectUri,
      code,
      verifier
    })

    saveAllegroTokens({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
      scope: tokens.scope
    })

    // Od razu sprawdzamy, na jakie konto weszliśmy — klient bywa zalogowany
    // w przeglądarce na prywatne, nie firmowe.
    let accountLogin = ''
    try {
      const me = await apiGet(allegro.sandbox, tokens.access_token, '/me')
      accountLogin = me?.login ?? me?.id ?? ''
      if (accountLogin) saveAllegroTokens({ accountLogin })
    } catch {
      /* brak /me nie unieważnia autoryzacji */
    }

    const expiresAt = new Date(Date.now() + Number(tokens.expires_in ?? 43200) * 1000).toISOString()

    setIntegrationCheck('allegro', true, accountLogin ? `Połączono z kontem ${accountLogin}.` : 'Połączono.')
    log('success', `Allegro: autoryzacja zakończona${accountLogin ? ` (konto ${accountLogin})` : ''}.`)

    return { ok: true, scope: tokens.scope, expiresAt, accountLogin }
  } catch (err) {
    setIntegrationCheck('allegro', false, err.message)
    log('error', `Allegro: autoryzacja nieudana — ${err.message}`)
    return { ok: false, error: err.message }
  } finally {
    activeFlow = null
  }
}

/**
 * Podnosi lokalny serwer, otwiera przeglądarkę i czeka na przekierowanie.
 * Serwer żyje tylko na czas jednej autoryzacji.
 */
function waitForCode({ redirect, state, challenge, authBase, clientId, redirectUri, log }) {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer = null

    const finish = (fn, arg) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // `unref` + close: proces nie zostanie przy życiu przez wiszący socket.
      server.close(() => {})
      fn(arg)
    }

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, redirect.origin)

      if (url.pathname !== redirect.path) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('Nie znaleziono')
        return
      }

      const error = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      const gotState = url.searchParams.get('state')

      const respond = (ok, title, message) => {
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(resultPage(ok, title, message))
      }

      if (error) {
        respond(false, 'Autoryzacja odrzucona', `Allegro zwróciło błąd: ${escapeHtml(error)}`)
        finish(reject, new Error(`Allegro odrzuciło autoryzację: ${error}`))
        return
      }

      // Ochrona przed CSRF: `state` musi wrócić dokładnie taki, jaki wysłaliśmy.
      if (!gotState || gotState !== state) {
        respond(false, 'Nieprawidłowa odpowiedź', 'Parametr bezpieczeństwa się nie zgadza. Rozpocznij autoryzację ponownie.')
        finish(reject, new Error('Niezgodny parametr state — możliwa próba podszycia. Spróbuj ponownie.'))
        return
      }

      if (!code) {
        respond(false, 'Brak kodu', 'Allegro nie przekazało kodu autoryzacyjnego.')
        finish(reject, new Error('Allegro nie przekazało kodu autoryzacyjnego.'))
        return
      }

      respond(true, 'Gotowe', 'Konto Allegro zostało połączone. Możesz zamknąć tę kartę i wrócić do aplikacji.')
      finish(resolve, code)
    })

    server.on('error', (err) => {
      const msg =
        err.code === 'EADDRINUSE'
          ? `Port ${redirect.port} jest zajęty przez inny program. Zmień port w adresie powrotnym (i w panelu Allegro).`
          : `Nie udało się uruchomić lokalnego serwera: ${err.message}`
      finish(reject, new Error(msg))
    })

    server.listen(redirect.port, '127.0.0.1', () => {
      const query = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        state,
        code_challenge_method: 'S256',
        code_challenge: challenge
      })

      const url = `${authBase}/authorize?${query.toString()}`
      log('info', 'Allegro: otwieram przeglądarkę, zaloguj się i zatwierdź dostęp…')
      shell.openExternal(url)
    })

    timer = setTimeout(() => {
      finish(reject, new Error('Upłynął limit 5 minut na dokończenie autoryzacji w przeglądarce.'))
    }, AUTH_TIMEOUT_MS)
  })
}

/** Wymiana kodu autoryzacyjnego na tokeny. */
async function exchangeCode({ auth, clientId, clientSecret, redirectUri, code, verifier }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier
  })

  const res = await fetch(`${auth}/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body,
    signal: AbortSignal.timeout(20000)
  })

  const data = await safeJson(res)

  if (!res.ok || !data?.access_token) {
    throw new Error(
      `Wymiana kodu nie powiodła się (HTTP ${res.status}). ` +
        (data?.error_description || data?.error || 'Sprawdź Client ID, Client Secret i adres powrotny.')
    )
  }

  return data
}

// ---------------------------------------------------------------------------
// Odświeżanie tokenu
// ---------------------------------------------------------------------------

/**
 * Zwraca ważny access token, odświeżając go w razie potrzeby.
 * Margines 2 minut — token nie może wygasnąć w trakcie żądania.
 */
export async function getValidAccessToken(log = () => {}) {
  const { allegro } = getIntegrations({ withSecrets: true })

  if (!allegro.accessToken) {
    throw new Error('Konto Allegro nie jest połączone. Kliknij „Autoryzuj Allegro”.')
  }

  const expiresAt = allegro.expiresAt ? new Date(allegro.expiresAt).getTime() : 0
  if (expiresAt === 0 || expiresAt - 120_000 > Date.now()) {
    return allegro.accessToken
  }

  if (!allegro.refreshToken) {
    throw new Error('Token Allegro wygasł, a brak refresh_token. Wymagana ponowna autoryzacja.')
  }

  log('info', 'Allegro: token wygasa, odświeżam…')

  const { auth } = endpoints(allegro.sandbox)
  const res = await fetch(`${auth}/token`, {
    method: 'POST',
    headers: {
      Authorization:
        'Basic ' + Buffer.from(`${allegro.clientId}:${allegro.clientSecret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: allegro.refreshToken,
      redirect_uri: allegro.redirectUri
    }),
    signal: AbortSignal.timeout(20000)
  })

  const data = await safeJson(res)

  if (!res.ok || !data?.access_token) {
    throw new Error(
      `Odświeżenie tokenu nie powiodło się (HTTP ${res.status}). ` +
        (data?.error_description || 'Wymagana ponowna autoryzacja.')
    )
  }

  saveAllegroTokens({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    scope: data.scope
  })

  log('success', 'Allegro: token odświeżony.')
  return data.access_token
}

// ---------------------------------------------------------------------------
// Wywołania API
// ---------------------------------------------------------------------------

/**
 * Uniwersalne wywołanie REST API Allegro.
 *
 * Obsługuje dowolną metodę i ciało — używane zarówno do odczytu ofert
 * (`GET /sale/offers`), jak i do zmiany stanu oferty
 * (`PATCH /sale/product-offers/{id}`). Nagłówki `Accept`/`Content-Type`
 * to wersjonowany typ Allegro (`application/vnd.allegro.public.v1+json`).
 *
 * @param {boolean} sandbox
 * @param {string} accessToken
 * @param {string} path
 * @param {{method?:string, body?:object|null, timeoutMs?:number}} [opts]
 */
/** Czy błąd Allegro jest przejściowy (timeout / sieć / 5xx / 429) — wtedy retry ma sens. */
function isRetryableAllegro(err) {
  const status = err?.status
  if (status === 429 || (typeof status === 'number' && status >= 500)) return true
  const msg = String(err?.message ?? err)
  return /aborted due to timeout|TimeoutError|AbortError|fetch failed|ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|network|terminated/i.test(msg)
}

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function allegroApi(
  sandbox,
  accessToken,
  path,
  { method = 'GET', body = null, timeoutMs = 45000, retries = 3, retryBaseMs = 800 } = {}
) {
  const { api } = endpoints(sandbox)

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: ACCEPT_HEADER
  }
  if (body != null) headers['Content-Type'] = ACCEPT_HEADER

  const attempt = async () => {
    const res = await fetch(`${api}${path}`, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    })

    const data = await safeJson(res)

    if (!res.ok) {
      const detail = data?.errors?.[0]?.userMessage || data?.error_description || data?.message || ''
      const err = new Error(`HTTP ${res.status}${detail ? ` — ${detail}` : ''}`)
      err.status = res.status
      throw err
    }
    return data
  }

  // Retry z backoffem + jitterem — timeouty/blipy sieciowe same się goją,
  // zamiast wywalać cały przebieg albo zostawać jako „błąd" pojedynczej oferty.
  let lastErr
  for (let i = 0; i <= retries; i++) {
    try {
      return await attempt()
    } catch (err) {
      lastErr = err
      if (i === retries || !isRetryableAllegro(err)) break
      const wait = retryBaseMs * 2 ** i + Math.floor(Math.random() * retryBaseMs)
      await _sleep(wait)
    }
  }
  throw lastErr
}

/** Skrót na GET — zachowany dla dotychczasowych wywołań w tym module. */
async function apiGet(sandbox, accessToken, path) {
  return allegroApi(sandbox, accessToken, path, { method: 'GET', timeoutMs: 30000 })
}

/**
 * Test połączenia z Allegro.
 *
 * Najpierw `/me` (wymaga tylko podstawowego zakresu). Gdy odpowie 403,
 * próbujemy `/sale/offers` — wtedy wiemy, że token żyje, ale aplikacja nie ma
 * zakresu do odczytu konta. Rozróżnienie jest istotne: „brak uprawnień”
 * i „zły token” naprawia się zupełnie inaczej.
 */
export async function testAllegroConnection(log = () => {}) {
  try {
    const token = await getValidAccessToken(log)
    const { allegro } = getIntegrations()

    try {
      const me = await apiGet(allegro.sandbox, token, '/me')
      const who = me?.login || me?.id || 'konto bez nazwy'
      const message = `Połączono z kontem Allegro: ${who}.`

      if (me?.login) saveAllegroTokens({ accountLogin: me.login })
      setIntegrationCheck('allegro', true, message)
      log('success', `Allegro: ${message}`)
      return { ok: true, message, account: who }
    } catch (err) {
      if (err.status === 403 || err.status === 404) {
        // /me niedostępne — sprawdzamy zakres, którego faktycznie używamy.
        await apiGet(allegro.sandbox, token, '/sale/offers?limit=1')
        const message = 'Token działa, dostęp do ofert potwierdzony (endpoint /me niedostępny dla tej aplikacji).'
        setIntegrationCheck('allegro', true, message)
        log('success', `Allegro: ${message}`)
        return { ok: true, message }
      }
      throw err
    }
  } catch (err) {
    const message = interpretAllegroError(err)
    setIntegrationCheck('allegro', false, message)
    log('error', `Allegro: ${message}`)
    return { ok: false, message }
  }
}

/** Zamiana surowego błędu HTTP na komunikat, z którego wynika, co zrobić. */
export function interpretAllegroError(err) {
  const msg = String(err?.message ?? err)

  if (err?.status === 401 || /HTTP 401/.test(msg)) {
    return 'Token odrzucony (401). Wykonaj autoryzację ponownie.'
  }
  if (err?.status === 403 || /HTTP 403/.test(msg)) {
    return 'Brak uprawnień (403). Sprawdź zakresy uprawnień aplikacji w panelu Allegro.'
  }
  if (/HTTP 429/.test(msg)) {
    return 'Przekroczono limit zapytań (429). Odczekaj chwilę i spróbuj ponownie.'
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|TimeoutError/i.test(msg)) {
    return 'Brak połączenia z serwerami Allegro. Sprawdź internet i ustawienia zapory.'
  }
  return msg
}

/** Odłączenie konta. */
export function disconnectAllegro(log = () => {}) {
  clearAllegroTokens()
  log('info', 'Allegro: konto odłączone.')
  return { ok: true }
}

/** Pobranie zamówień — szkielet dla synchronizacji bez Cloud Huba. */
export async function fetchAllegroOrders({ limit = 20, status = 'READY_FOR_PROCESSING' } = {}, log = () => {}) {
  const token = await getValidAccessToken(log)
  const { allegro } = getIntegrations()

  const query = new URLSearchParams({ limit: String(Math.min(100, limit)) })
  if (status) query.set('fulfillment.status', status)

  const data = await apiGet(allegro.sandbox, token, `/order/checkout-forms?${query.toString()}`)
  const orders = data?.checkoutForms ?? []

  log('info', `Allegro: pobrano ${orders.length} zamówień (status ${status || 'dowolny'}).`)
  return orders
}

async function safeJson(res) {
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { _raw: text.slice(0, 500) }
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  )
}
