#!/bin/sh
# Dijalankan di server oleh CD: tarik image, update modul, restart, cek kesehatan.
# Pemakaian: IMAGE_TAG=<sha-commit> ./update.sh
set -eu
cd "$(dirname "$0")"

set -a
. ./.env
set +a

: "${IMAGE_TAG:?IMAGE_TAG wajib diisi}"
: "${ODOO_DB:?ODOO_DB wajib diisi di .env}"
export IMAGE_TAG

COMPOSE="docker compose -f docker-compose.prod.yml"
PREV="$(cat .last_good 2>/dev/null || echo latest)"

$COMPOSE pull odoo
$COMPOSE up -d db

# Update modul KompakApps pada database (migrasi skema/data). Database harus sudah diinisialisasi.
$COMPOSE run --rm odoo odoo -d "$ODOO_DB" -u kompakapps_base --stop-after-init

$COMPOSE up -d

i=0
until curl -fsS http://127.0.0.1:8069/web/health >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -ge 30 ]; then
        echo "Health check gagal. Mengembalikan image ke $PREV." >&2
        IMAGE_TAG="$PREV" $COMPOSE up -d
        exit 1
    fi
    sleep 5
done

echo "$IMAGE_TAG" > .last_good
echo "Deploy OK: $IMAGE_TAG"
