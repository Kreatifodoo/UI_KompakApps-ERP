#!/usr/bin/env bash
# Backup database Nusara: dump PostgreSQL (format custom) + arsip filestore + manifest.
# Panduan lengkap: docs/OPERATIONS.md
# shellcheck disable=SC2016 # skrip sh untuk container sengaja ditaruh dalam kutip tunggal
set -Eeuo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ops-lib.sh
. "$HERE/ops-lib.sh"

usage() {
    cat <<'EOF'
Pemakaian:
  COMPOSE_PROJECT=<proyek> ODOO_DB=<database> BACKUP_DIR=<folder> [KEEP=<n>] scripts/backup.sh
  scripts/backup.sh -p <proyek> -d <database> [-o <folder>] [-k <n>] [--env-file <berkas>] [--compose-file <berkas>]

Membuat folder <BACKUP_DIR>/<database>_<tanggal>-<jam>/ berisi:
  db.dump             dump PostgreSQL (pg_dump -Fc)
  filestore.tar.gz    arsip filestore database itu (lampiran, logo)
  manifest.json       tanggal, versi modul, angka kunci, ukuran, dan checksum SHA-256
  SHA256SUMS          checksum dalam format 'sha256sum -c'

Parameter (argumen mengalahkan variabel lingkungan):
  -p, --project   COMPOSE_PROJECT  nama proyek Docker Compose (WAJIB, tanpa nilai bawaan)
  -d, --db        ODOO_DB          nama database yang dibackup (WAJIB, tanpa nilai bawaan)
  -o, --dir       BACKUP_DIR       folder tujuan (bawaan: ./backups)
  -k, --keep      KEEP             simpan N backup terbaru milik database ini, hapus sisanya (bawaan: 0 = jangan hapus)
      --env-file  COMPOSE_ENV_FILE berkas .env untuk Compose (mis. DB_PASSWORD yang dibutuhkan berkas compose)
      --compose-file COMPOSE_FILE  berkas compose (bawaan: yang ada di folder saat ini)
  -h, --help                       tampilkan bantuan ini

Jalankan dari folder berkas compose (atau isi COMPOSE_FILE). Kode keluar: 0 berhasil, 1 gagal, 2 salah pemakaian.
Backup memuat data sensitif: berkasnya dibuat dengan izin 600; simpan dan salin ke luar server dengan aman.
EOF
}

ODOO_DB="${ODOO_DB:-}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP="${KEEP:-0}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-}"
COMPOSE_ENV_FILE="${COMPOSE_ENV_FILE:-}"

while [ $# -gt 0 ]; do
    case "$1" in
        -p | --project) [ $# -ge 2 ] || ops_usage_die "$1 butuh nilai"; COMPOSE_PROJECT="$2"; shift 2 ;;
        -d | --db) [ $# -ge 2 ] || ops_usage_die "$1 butuh nilai"; ODOO_DB="$2"; shift 2 ;;
        -o | --dir) [ $# -ge 2 ] || ops_usage_die "$1 butuh nilai"; BACKUP_DIR="$2"; shift 2 ;;
        -k | --keep) [ $# -ge 2 ] || ops_usage_die "$1 butuh nilai"; KEEP="$2"; shift 2 ;;
        --env-file) [ $# -ge 2 ] || ops_usage_die "$1 butuh nilai"; COMPOSE_ENV_FILE="$2"; shift 2 ;;
        --compose-file) [ $# -ge 2 ] || ops_usage_die "$1 butuh nilai"; COMPOSE_FILE="$2"; shift 2 ;;
        -h | --help) usage; exit 0 ;;
        *) ops_usage_die "argumen tidak dikenal: $1" ;;
    esac
done

[ -n "$ODOO_DB" ] || ops_usage_die "ODOO_DB wajib diisi (--db atau variabel lingkungan); tidak ada nilai bawaan agar tidak salah sasaran"
ops_valid_name ODOO_DB "$ODOO_DB"
case "$KEEP" in '' | *[!0-9]*) ops_usage_die "KEEP harus bilangan bulat >= 0" ;; esac
ops_setup_compose
ops_require_db_service
ops_db_exists "$ODOO_DB" || ops_die "database '$ODOO_DB' tidak ada di proyek $COMPOSE_PROJECT"
[ "$(ops_psql "$ODOO_DB" "SELECT 1 FROM ir_module_module WHERE name = 'nusara_base' AND state = 'installed'")" = "1" ] ||
    ops_die "'$ODOO_DB' bukan database Nusara (nusara_base tidak terpasang); backup dibatalkan"

mkdir -p "$BACKUP_DIR" || ops_die "tidak bisa membuat folder $BACKUP_DIR"
BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd)"
[ -w "$BACKUP_DIR" ] || ops_die "folder $BACKUP_DIR tidak bisa ditulis"

# Satu backup per database pada satu waktu.
LOCK="$BACKUP_DIR/.$ODOO_DB.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
    old_pid="$(cat "$LOCK/pid" 2>/dev/null || true)"
    if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
        ops_die "backup lain untuk '$ODOO_DB' sedang berjalan (pid $old_pid)"
    fi
    ops_warn "mengabaikan kunci basi dari proses $old_pid yang sudah berhenti"
    rm -rf -- "$LOCK"
    mkdir "$LOCK" || ops_die "tidak bisa membuat kunci $LOCK"
fi
echo "$$" >"$LOCK/pid"

STAMP="$(date '+%Y%m%d-%H%M%S')"
NAME="${ODOO_DB}_${STAMP}"
FINAL="$BACKUP_DIR/$NAME"
WORK="$BACKUP_DIR/.$NAME.partial"
STARTED="$(date +%s)"
DONE=0

cleanup() {
    local rc=$?
    rm -rf -- "$LOCK"
    if [ "$DONE" -ne 1 ]; then
        rm -rf -- "$WORK"
        ops_warn "backup '$ODOO_DB' GAGAL (kode $rc); tidak ada backup baru yang disimpan"
    fi
    return "$rc"
}
trap cleanup EXIT

[ ! -e "$FINAL" ] || ops_die "folder $FINAL sudah ada; tunggu satu detik lalu ulangi"
mkdir "$WORK"

ops_log "Backup '$ODOO_DB' (proyek $COMPOSE_PROJECT) -> $FINAL"

# Angka kunci dibaca sebelum dump (dipakai restore.sh untuk mencocokkan hasil pemulihan).
STATS="$(ops_stats "$ODOO_DB")"
[ -n "$STATS" ] || ops_die "gagal membaca angka kunci database"
DBINFO="$(ops_psql "$ODOO_DB" "SELECT pg_encoding_to_char(encoding) || '|' || datcollate || '|' || datctype || '|' || current_setting('server_version') FROM pg_database WHERE datname = current_database()")"
ODOO_VERSION_DB="$(ops_psql "$ODOO_DB" "SELECT COALESCE(latest_version, '') FROM ir_module_module WHERE name = 'base'")"
NUSARA_VERSION="$(ops_psql "$ODOO_DB" "SELECT COALESCE(latest_version, '') FROM ir_module_module WHERE name = 'nusara_base'")"
MODULES="$(ops_psql "$ODOO_DB" "SELECT name || '=' || COALESCE(latest_version, '') FROM ir_module_module WHERE state = 'installed' ORDER BY name")"
IFS='|' read -r PG_ENCODING PG_COLLATE PG_CTYPE PG_VERSION <<<"$DBINFO"

# 1) Database dulu, 2) filestore sesudahnya: berkas yang muncul di antaranya hanya menjadi yatim
# (dibersihkan Odoo), sedangkan urutan terbalik bisa meninggalkan lampiran tanpa berkas.
ops_log "Dump database (pg_dump -Fc)"
"${OPS_DC[@]}" exec -T "$OPS_DB_SERVICE" pg_dump -U "$OPS_DB_USER" -Fc "$ODOO_DB" </dev/null >"$WORK/db.dump"
[ -s "$WORK/db.dump" ] || ops_die "dump database kosong"

ops_log "Arsip filestore"
FS_FILES="$(ops_fs_count "$ODOO_DB")"
ops_odoo sh -c '
    d="$1/filestore/$2"
    if [ -d "$d" ]; then tar -C "$1/filestore" -czf - "$2"; else tar -czf - -T /dev/null; fi
' sh "$OPS_DATA_DIR" "$ODOO_DB" </dev/null >"$WORK/filestore.tar.gz"

# Uji baca: daftar isi dump dan arsip harus terbaca.
ops_log "Memeriksa keterbacaan dump dan arsip"
TOC_LINES="$("${OPS_DC[@]}" exec -T "$OPS_DB_SERVICE" pg_restore -l <"$WORK/db.dump" | wc -l | tr -d ' ')"
[ "$TOC_LINES" -gt 0 ] || ops_die "daftar isi dump tidak terbaca"
tar -tzf "$WORK/filestore.tar.gz" >/dev/null || ops_die "arsip filestore rusak"

DUMP_SHA="$(ops_sha256 "$WORK/db.dump")"
FS_SHA="$(ops_sha256 "$WORK/filestore.tar.gz")"
DUMP_BYTES="$(ops_filesize "$WORK/db.dump")"
FS_BYTES="$(ops_filesize "$WORK/filestore.tar.gz")"

{
    printf '{\n'
    printf '  "format": 1,\n'
    printf '  "created_at": "%s",\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')"
    printf '  "created_epoch": %s,\n' "$(date +%s)"
    printf '  "compose_project": "%s",\n' "$COMPOSE_PROJECT"
    printf '  "database": "%s",\n' "$ODOO_DB"
    printf '  "pg_encoding": "%s",\n' "$PG_ENCODING"
    printf '  "pg_lc_collate": "%s",\n' "$PG_COLLATE"
    printf '  "pg_lc_ctype": "%s",\n' "$PG_CTYPE"
    printf '  "postgres_version": "%s",\n' "$PG_VERSION"
    printf '  "odoo_base_version": "%s",\n' "$ODOO_VERSION_DB"
    printf '  "nusara_base_version": "%s",\n' "$NUSARA_VERSION"
    printf '  "dump_file": "db.dump",\n'
    printf '  "dump_bytes": %s,\n' "$DUMP_BYTES"
    printf '  "dump_sha256": "%s",\n' "$DUMP_SHA"
    printf '  "filestore_file": "filestore.tar.gz",\n'
    printf '  "filestore_bytes": %s,\n' "$FS_BYTES"
    printf '  "filestore_sha256": "%s",\n' "$FS_SHA"
    printf '  "filestore_files": %s,\n' "$FS_FILES"
    while IFS='=' read -r key value; do
        [ -n "$key" ] || continue
        if [[ "$value" =~ ^-?[0-9]+(\.[0-9]+)?$ ]]; then
            printf '  "%s": %s,\n' "$key" "$value"
        else
            printf '  "%s": "%s",\n' "$key" "$value"
        fi
    done <<<"$STATS"
    printf '  "modules": {\n'
    sep=''
    while IFS='=' read -r mod ver; do
        [ -n "$mod" ] || continue
        printf '%s    "%s": "%s"' "$sep" "$mod" "$ver"
        sep=$',\n'
    done <<<"$MODULES"
    printf '\n  }\n}\n'
} >"$WORK/manifest.json"
printf '%s  db.dump\n%s  filestore.tar.gz\n' "$DUMP_SHA" "$FS_SHA" >"$WORK/SHA256SUMS"

mv "$WORK" "$FINAL"
DONE=1

# Rotasi: hanya folder bernama <database>_<tanggal>-<jam> yang manifest-nya menyebut database ini.
if [ "$KEEP" -gt 0 ]; then
    i=0
    while IFS= read -r dir; do
        [ -n "$dir" ] || continue
        i=$((i + 1))
        [ "$i" -gt "$KEEP" ] || continue
        if [ -f "$dir/manifest.json" ] && grep -q "^  \"database\": \"$ODOO_DB\"," "$dir/manifest.json"; then
            rm -rf -- "$dir"
            ops_log "Rotasi: menghapus backup lama $(basename "$dir")"
        fi
    done < <(find "$BACKUP_DIR" -maxdepth 1 -type d -name "${ODOO_DB}_[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]" | sort -r)
fi
# Sisa backup yang terputus (lebih dari sehari) dibersihkan.
find "$BACKUP_DIR" -maxdepth 1 -type d -name ".${ODOO_DB}_*.partial" -mtime +0 -exec rm -rf {} + 2>/dev/null || true

ELAPSED=$(($(date +%s) - STARTED))
ops_log "Backup selesai dalam ${ELAPSED} detik: $FINAL (database $(ops_human "$DUMP_BYTES"), filestore $(ops_human "$FS_BYTES") berisi $FS_FILES berkas)"
