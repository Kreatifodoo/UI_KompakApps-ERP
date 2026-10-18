#!/usr/bin/env bash
# Migrasi instalasi lokal lama (project compose nusaraerp, database nusara, modul nusara_base) ke nama baru kompakapps (D66).
# Langkah: backup, hentikan stack lama, salin volume ke project baru, ganti nama database dan folder filestore, ganti nama modul di
# database, upgrade modul, nyalakan stack baru. Volume dan kontainer lama TIDAK dihapus sehingga bisa dipakai untuk kembali.
#
#   bash scripts/migrate_to_kompakapps.sh            # jalankan (menanyakan konfirmasi)
#   bash scripts/migrate_to_kompakapps.sh --yes      # tanpa konfirmasi
#
# Variabel (bawaan): OLD_PROJECT=nusaraerp OLD_DB=nusara NEW_DB=kompakapps BACKUP_DIR=./backups
set -euo pipefail
cd "$(dirname "$0")/.."

OLD_PROJECT="${OLD_PROJECT:-nusaraerp}"
OLD_DB="${OLD_DB:-nusara}"
NEW_PROJECT="kompakapps"
NEW_DB="${NEW_DB:-kompakapps}"
OLD_MODULE="nusara_base"
NEW_MODULE="kompakapps_base"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"

log() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() { printf 'GALAT: %s\n' "$*" >&2; exit 1; }

[ "${1:-}" = "--yes" ] || {
    printf 'Migrasi %s/%s menjadi %s/%s. Stack lama dihentikan sementara. Lanjut? [y/N] ' "$OLD_PROJECT" "$OLD_DB" "$NEW_PROJECT" "$NEW_DB"
    read -r answer
    [ "$answer" = "y" ] || die "dibatalkan"
}

docker info >/dev/null 2>&1 || die "Docker belum berjalan"
docker inspect "${OLD_PROJECT}-db-1" >/dev/null 2>&1 || die "kontainer ${OLD_PROJECT}-db-1 tidak ada; tidak ada yang perlu dimigrasi"
[ -f .env ] || die "file .env tidak ada"
if docker volume inspect "${NEW_PROJECT}_db-data" >/dev/null 2>&1; then
    die "volume ${NEW_PROJECT}_db-data sudah ada; hapus lebih dulu bila yakin itu salinan yang gagal (docker volume rm)"
fi

# 1. Backup logis (bisa dipulihkan ke instalasi mana pun)
mkdir -p "$BACKUP_DIR"
docker start "${OLD_PROJECT}-db-1" >/dev/null 2>&1 || true
BACKUP="$BACKUP_DIR/${OLD_DB}-sebelum-kompakapps-$STAMP.dump"
log "backup database $OLD_DB ke $BACKUP"
docker exec "${OLD_PROJECT}-db-1" pg_dump -U odoo -Fc "$OLD_DB" >"$BACKUP"
[ -s "$BACKUP" ] || die "backup kosong"

# 2. Hentikan stack lama (kontainer dan volume tetap ada)
log "menghentikan stack lama $OLD_PROJECT"
docker stop "${OLD_PROJECT}-ui-1" "${OLD_PROJECT}-odoo-1" "${OLD_PROJECT}-db-1" >/dev/null 2>&1 || true

# 3. Buat project baru (volume dan jaringan berlabel compose), lalu salin isi volume lama
if ! docker image inspect kompakapps:dev >/dev/null 2>&1; then
    if docker image inspect nusara-erp:dev >/dev/null 2>&1; then docker tag nusara-erp:dev kompakapps:dev; else docker compose build odoo; fi
fi
cp .env ".env.sebelum-kompakapps-$STAMP"
sed -i.bak "s/^ODOO_DB=.*/ODOO_DB=$NEW_DB/" .env && rm -f .env.bak
docker compose up --no-start db odoo ui >/dev/null
for vol in db-data odoo-data; do
    log "menyalin volume ${OLD_PROJECT}_$vol ke ${NEW_PROJECT}_$vol"
    docker run --rm -v "${OLD_PROJECT}_$vol:/from:ro" -v "${NEW_PROJECT}_$vol:/to" alpine sh -c 'cp -a /from/. /to/'
done

# 4. Ganti nama database dan folder filestore
log "menyalakan database baru"
docker compose up -d db >/dev/null
for _ in $(seq 1 30); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "${NEW_PROJECT}-db-1" 2>/dev/null)" = healthy ] && break
    sleep 2
done
if [ "$OLD_DB" != "$NEW_DB" ]; then
    docker exec "${NEW_PROJECT}-db-1" psql -U odoo -d postgres -v ON_ERROR_STOP=1 -c "ALTER DATABASE \"$OLD_DB\" RENAME TO \"$NEW_DB\""
    docker run --rm -v "${NEW_PROJECT}_odoo-data:/data" alpine sh -c \
        "if [ -d /data/filestore/$OLD_DB ] && [ ! -e /data/filestore/$NEW_DB ]; then mv /data/filestore/$OLD_DB /data/filestore/$NEW_DB; fi"
fi

# 5. Ganti nama modul dan model pada data database (Odoo mengenali modul dari nama ini)
log "mengganti nama modul $OLD_MODULE menjadi $NEW_MODULE di database"
docker exec -i "${NEW_PROJECT}-db-1" psql -U odoo -d "$NEW_DB" -v ON_ERROR_STOP=1 <<SQL
BEGIN;
UPDATE ir_module_module SET name = '$NEW_MODULE' WHERE name = '$OLD_MODULE';
UPDATE ir_module_module_dependency SET name = '$NEW_MODULE' WHERE name = '$OLD_MODULE';
UPDATE ir_model_data SET module = '$NEW_MODULE' WHERE module = '$OLD_MODULE';
UPDATE ir_model_data SET name = replace(name, 'nusara_mis_loader', 'kompakapps_mis_loader') WHERE name LIKE '%nusara_mis_loader%';
UPDATE ir_model_fields SET model = 'kompakapps.mis.loader' WHERE model = 'nusara.mis.loader';
UPDATE ir_model SET model = 'kompakapps.mis.loader' WHERE model = 'nusara.mis.loader';
COMMIT;
SQL

# 6. Upgrade modul dan nyalakan
log "upgrade modul $NEW_MODULE"
docker compose run --rm -T --no-deps odoo odoo -d "$NEW_DB" -u "$NEW_MODULE" --stop-after-init
log "menyalakan stack baru"
docker compose up -d >/dev/null
log "selesai. Backup: $BACKUP. Stack lama ($OLD_PROJECT) hanya dihentikan; hapus kontainer dan volumenya setelah yakin."
