#!/usr/bin/env bash
#
# Uruchomienie Cloud Huba w trybie deweloperskim.
#
#   ./start-dev.sh            — migracja + serwer na :8000
#   ./start-dev.sh --seed     — dodatkowo dane demonstracyjne
#   ./start-dev.sh --reset    — czyści dane demo przed zasianiem
#
# Skrypt jest idempotentny: kolejne uruchomienia nie psują istniejącej bazy.

set -euo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-8000}"
TENANT="${HUB_TENANT_ID:-dev}"

# --- 1. Zmienne środowiskowe ------------------------------------------------
if [ ! -f dev.env ]; then
    echo "Tworzę dev.env z szablonu…"
    cp dev.env.example dev.env
fi

# shellcheck source=/dev/null
source ./dev.env

# --- 2. Wymagania -----------------------------------------------------------
if ! command -v php >/dev/null 2>&1; then
    echo "BŁĄD: nie znaleziono php. Zainstaluj: brew install php" >&2
    exit 1
fi

for ext in pdo_sqlite curl; do
    if ! php -m | grep -qx "$ext"; then
        echo "BŁĄD: brakuje rozszerzenia PHP \"$ext\". Spróbuj: brew reinstall php" >&2
        exit 1
    fi
done

# --- 3. Katalog na bazę -----------------------------------------------------
mkdir -p storage
chmod 700 storage

# --- 4. Schemat bazy --------------------------------------------------------
echo "── Migracja bazy ──"
php bin/migrate.php

# --- 5. Dane demonstracyjne (opcjonalnie) -----------------------------------
if [[ " $* " == *" --seed "* ]] || [[ " $* " == *" --reset "* ]]; then
    RESET=""
    [[ " $* " == *" --reset "* ]] && RESET="--reset"

    echo ""
    echo "── Dane demonstracyjne ──"
    php bin/seed_demo.php "$TENANT" $RESET --orders=2
fi

# --- 6. Przypomnienie o koncie i kluczu -------------------------------------
ADMIN_COUNT=$(sqlite3 "$HUB_DB_PATH" "SELECT COUNT(*) FROM admin_users" 2>/dev/null || echo 0)
AGENT_COUNT=$(sqlite3 "$HUB_DB_PATH" "SELECT COUNT(*) FROM agents"      2>/dev/null || echo 0)

if [ "$ADMIN_COUNT" = "0" ]; then
    echo ""
    echo "UWAGA: brak konta do panelu. Utwórz je w drugim oknie:"
    echo "  php bin/create_admin.php $TENANT admin"
fi

if [ "$AGENT_COUNT" = "0" ]; then
    echo ""
    echo "UWAGA: brak zarejestrowanego agenta. Wygeneruj klucz API:"
    echo "  php bin/register_agent.php $TENANT \"Mac dev\""
fi

# --- 7. Serwer --------------------------------------------------------------
echo ""
echo "───────────────────────────────────────────────"
echo "  Panel:  http://localhost:${PORT}/admin"
echo "  Health: http://localhost:${PORT}/api/health"
echo "  Baza:   ${HUB_DB_PATH}"
echo "  Zatrzymanie: Ctrl+C"
echo "───────────────────────────────────────────────"
echo ""

exec php -S "localhost:${PORT}" -t public
