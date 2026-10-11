#!/usr/bin/env bash
# Memulihkan backup buatan backup.sh ke database BARU (dump + filestore), lalu memverifikasinya.
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
  COMPOSE_PROJECT=<proyek> scripts/restore.sh <folder-backup> <database-baru> [opsi]
  scripts/restore.sh -p <proyek> -b <folder-backup> -t <database-baru> [opsi]

Memulihkan <folder-backup> (berisi db.dump, filestore.tar.gz, manifest.json) ke database <database-baru>
pada proyek Compose yang sama, lalu memverifikasi hasilnya. Database yang sudah ada TIDAK ditimpa kecuali
memakai --overwrite; itu pun database lama tidak dihapus, hanya diganti namanya menjadi <nama>_replaced_<waktu>
(filestore-nya juga), sehingga bisa dikembalikan.

Parameter:
  -p, --project   COMPOSE_PROJECT  nama proyek Docker Compose (WAJIB, tanpa nilai bawaan)
  -b, --backup    BACKUP_PATH      folder backup yang dipulihkan (WAJIB)
  -t, --target    RESTORE_DB       nama database tujuan (WAJIB)
      --overwrite                  izinkan memakai nama database yang sudah ada (yang lama diganti nama, bukan dihapus);
                                   Odoo dan semua klien harus sudah berhenti memakai database itu
      --strict                     selisih angka kunci terhadap manifest menjadi kegagalan (bawaan: peringatan, karena
                                   angka manifest dibaca sebelum dump dan bisa bergeser bila database sedang dipakai)
      --skip-verify                lewati verifikasi sesudah pemulihan (tidak disarankan)
      --verify-only                hanya verifikasi database <database-baru> yang sudah ada terhadap manifest backup
                                   (tidak membuat atau mengubah apa pun)
      --env-file  COMPOSE_ENV_FILE berkas .env untuk Compose
      --compose-file COMPOSE_FILE  berkas compose
  -h, --help                       tampilkan bantuan ini

Variabel VERIFY_SAMPLE (bawaan 500) menentukan jumlah lampiran terbaru yang diperiksa isinya (sha1) di filestore.
Kode keluar: 0 berhasil dan lulus verifikasi, 1 gagal, 2 salah pemakaian.
EOF
}

BACKUP_PATH="${BACKUP_PATH:-}"
RESTORE_DB="${RESTORE_DB:-}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-}"
COMPOSE_ENV_FILE="${COMPOSE_ENV_FILE:-}"
VERIFY_SAMPLE="${VERIFY_SAMPLE:-500}"
OVERWRITE=0
STRICT=0
VERIFY=1
VERIFY_ONLY=0
POSITIONAL=()

while [ $# -gt 0 ]; do
    case "$1" in
        -p | --project) [ $# -ge 2 ] || ops_usage_die "$1 butuh nilai"; COMPOSE_PROJECT="$2"; shift 2 ;;
        -b | --backup) [ $# -ge 2 ] || ops_usage_die "$1 butuh nilai"; BACKUP_PATH="$2"; shift 2 ;;
        -t | --target) [ $# -ge 2 ] || ops_usage_die "$1 butuh nilai"; RESTORE_DB="$2"; shift 2 ;;
        --overwrite) OVERWRITE=1; shift ;;
        --strict) STRICT=1; shift ;;
        --skip-verify) VERIFY=0; shift ;;
        --verify-only) VERIFY_ONLY=1; shift ;;
        --env-file) [ $# -ge 2 ] || ops_usage_die "$1 butuh nilai"; COMPOSE_ENV_FILE="$2"; shift 2 ;;
        --compose-file) [ $# -ge 2 ] || ops_usage_die "$1 butuh nilai"; COMPOSE_FILE="$2"; shift 2 ;;
        -h | --help) usage; exit 0 ;;
        -*) ops_usage_die "argumen tidak dikenal: $1" ;;
        *) POSITIONAL+=("$1"); shift ;;
    esac
done
if [ "${#POSITIONAL[@]}" -ge 1 ]; then BACKUP_PATH="${POSITIONAL[0]}"; fi
if [ "${#POSITIONAL[@]}" -ge 2 ]; then RESTORE_DB="${POSITIONAL[1]}"; fi
[ "${#POSITIONAL[@]}" -le 2 ] || ops_usage_die "terlalu banyak argumen"

[ -n "$BACKUP_PATH" ] || ops_usage_die "folder backup wajib diisi"
[ -n "$RESTORE_DB" ] || ops_usage_die "nama database tujuan wajib diisi (tidak ada nilai bawaan agar tidak menimpa database yang sedang dipakai)"
ops_valid_name "database tujuan" "$RESTORE_DB"
case "$VERIFY_SAMPLE" in '' | *[!0-9]*) ops_usage_die "VERIFY_SAMPLE harus bilangan bulat" ;; esac

MANIFEST="$BACKUP_PATH/manifest.json"
DUMP="$BACKUP_PATH/db.dump"
FILESTORE="$BACKUP_PATH/filestore.tar.gz"
for f in "$MANIFEST" "$DUMP" "$FILESTORE"; do
    [ -r "$f" ] || ops_die "berkas backup tidak ditemukan atau tidak terbaca: $f"
done

SRC_DB="$(ops_manifest_get "$MANIFEST" database)"
[ -n "$SRC_DB" ] || ops_die "manifest tidak valid: tidak ada nama database"
FORMAT="$(ops_manifest_get "$MANIFEST" format)"
[ "$FORMAT" = "1" ] || ops_die "format manifest '$FORMAT' tidak dikenal (skrip ini mengerti format 1)"

ops_setup_compose
ops_require_db_service

ops_log "Memeriksa checksum backup $BACKUP_PATH"
[ "$(ops_sha256 "$DUMP")" = "$(ops_manifest_get "$MANIFEST" dump_sha256)" ] || ops_die "checksum db.dump TIDAK cocok dengan manifest: backup rusak atau diubah; pemulihan dibatalkan"
[ "$(ops_sha256 "$FILESTORE")" = "$(ops_manifest_get "$MANIFEST" filestore_sha256)" ] || ops_die "checksum filestore.tar.gz TIDAK cocok dengan manifest: backup rusak atau diubah; pemulihan dibatalkan"

STAMP="$(date '+%Y%m%d-%H%M%S')"
FS_ROOT="$OPS_DATA_DIR/filestore"
CREATED_DB=0
CREATED_FS=0
RESTORED=0
REPLACED_NOTE=""
DONE=0

fs_nonempty() { # apakah folder filestore database ini ada dan berisi
    ops_odoo sh -c 'd="$1/filestore/$2"; [ -d "$d" ] && [ -n "$(ls -A "$d")" ]' sh "$OPS_DATA_DIR" "$1" </dev/null
}

cleanup() {
    local rc=$?
    if [ "$DONE" -ne 1 ] && [ "$RESTORED" -eq 1 ]; then
        # Pemulihan sudah selesai; yang terhenti hanya verifikasi. Jangan buang hasilnya.
        ops_warn "verifikasi terhenti karena galat (kode $rc); database '$RESTORE_DB' hasil pemulihan dibiarkan. Ulangi dengan --verify-only"
    elif [ "$DONE" -ne 1 ]; then
        # Hanya membersihkan yang dibuat oleh proses ini.
        if [ "$CREATED_DB" -eq 1 ]; then
            ops_psql postgres "DROP DATABASE IF EXISTS \"$RESTORE_DB\"" >/dev/null 2>&1 || true
        fi
        if [ "$CREATED_FS" -eq 1 ]; then
            ops_odoo sh -c 'rm -rf "$1/filestore/$2"' sh "$OPS_DATA_DIR" "$RESTORE_DB" </dev/null >/dev/null 2>&1 || true
        fi
        ops_warn "pemulihan ke '$RESTORE_DB' GAGAL (kode $rc); yang sempat dibuat sudah dibersihkan${REPLACED_NOTE}"
    fi
    return "$rc"
}
trap cleanup EXIT

if [ "$VERIFY_ONLY" -eq 1 ]; then
    ops_db_exists "$RESTORE_DB" || ops_die "database '$RESTORE_DB' tidak ada; tidak ada yang bisa diverifikasi"
    [ "$VERIFY" -eq 1 ] || ops_usage_die "--verify-only tidak bisa digabung dengan --skip-verify"
else
    if ops_db_exists "$RESTORE_DB"; then
        [ "$OVERWRITE" -eq 1 ] || ops_die "database '$RESTORE_DB' sudah ada; pemulihan tidak akan menimpanya. Pilih nama lain, atau tambahkan --overwrite (yang lama hanya diganti nama)"
        ACTIVE="$(ops_psql postgres "SELECT count(*) FROM pg_stat_activity WHERE datname = '$RESTORE_DB'")"
        [ "$ACTIVE" = "0" ] || ops_die "'$RESTORE_DB' masih dipakai $ACTIVE koneksi; hentikan Odoo dulu (docker compose -p $COMPOSE_PROJECT stop odoo)"
        OLD="${RESTORE_DB}_replaced_${STAMP}"
        ops_db_exists "$OLD" && ops_die "nama cadangan '$OLD' sudah dipakai; ulangi sebentar lagi"
        ops_psql postgres "ALTER DATABASE \"$RESTORE_DB\" RENAME TO \"$OLD\"" >/dev/null
        REPLACED_NOTE="; database lama ada di '$OLD'"
        ops_log "Database lama diganti nama menjadi '$OLD' (tidak dihapus)"
        if fs_nonempty "$RESTORE_DB"; then
            ops_odoo sh -c 'mv "$1/filestore/$2" "$1/filestore/$3"' sh "$OPS_DATA_DIR" "$RESTORE_DB" "$OLD" </dev/null
        fi
    elif fs_nonempty "$RESTORE_DB"; then
        ops_die "folder filestore '$FS_ROOT/$RESTORE_DB' sudah berisi berkas padahal database belum ada (sisa lama); periksa lalu hapus manual atau pakai --overwrite"
    fi

    ENC="$(ops_manifest_get "$MANIFEST" pg_encoding)"
    COL="$(ops_manifest_get "$MANIFEST" pg_lc_collate)"
    CTY="$(ops_manifest_get "$MANIFEST" pg_lc_ctype)"
    for v in "$ENC" "$COL" "$CTY"; do
        [[ "$v" =~ ^[A-Za-z0-9_.@-]+$ ]] || ops_die "manifest memuat pengaturan locale yang tidak valid"
    done

    ops_log "Membuat database '$RESTORE_DB' (encoding $ENC, collate $COL, ctype $CTY)"
    ops_psql postgres "CREATE DATABASE \"$RESTORE_DB\" ENCODING '$ENC' LC_COLLATE '$COL' LC_CTYPE '$CTY' TEMPLATE template0" >/dev/null
    CREATED_DB=1

    ops_log "pg_restore dump ke '$RESTORE_DB' (satu transaksi, berhenti pada galat pertama)"
    "${OPS_DC[@]}" exec -T "$OPS_DB_SERVICE" pg_restore -U "$OPS_DB_USER" -d "$RESTORE_DB" --no-owner --exit-on-error --single-transaction <"$DUMP"

    ops_log "Memulihkan filestore ke $FS_ROOT/$RESTORE_DB"
    CREATED_FS=1
    # Isi arsip berakar pada nama database sumber; --strip-components=1 memindahkannya ke nama tujuan.
    ops_odoo sh -c 'set -e; d="$1/filestore/$2"; mkdir -p "$d"; tar -xzf - -C "$d" --strip-components=1' sh "$OPS_DATA_DIR" "$RESTORE_DB" <"$FILESTORE"
    RESTORED=1
fi

FAILS=0
WARNS=0
pass() { printf '  ok      %s\n' "$*"; }
fail() { printf '  GAGAL   %s\n' "$*"; FAILS=$((FAILS + 1)); }
warn() { printf '  CATATAN %s\n' "$*"; WARNS=$((WARNS + 1)); }

if [ "$VERIFY" -eq 1 ]; then
    ops_log "Verifikasi hasil pemulihan"

    # 1) Struktur: wajib sama persis dengan manifest.
    cur_tables="$(ops_psql "$RESTORE_DB" "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")"
    want="$(ops_manifest_get "$MANIFEST" stat_tables)"
    if [ "$cur_tables" = "$want" ] && [ "$cur_tables" -gt 0 ]; then pass "jumlah tabel $cur_tables"; else fail "jumlah tabel $cur_tables, manifest $want"; fi

    cur_mods="$(ops_psql "$RESTORE_DB" "SELECT count(*) FROM ir_module_module WHERE state = 'installed'")"
    want="$(ops_manifest_get "$MANIFEST" stat_installed_modules)"
    if [ "$cur_mods" = "$want" ] && [ "$cur_mods" -gt 0 ]; then pass "modul terpasang $cur_mods"; else fail "modul terpasang $cur_mods, manifest $want"; fi

    nb="$(ops_psql "$RESTORE_DB" "SELECT state || ' ' || COALESCE(latest_version, '') FROM ir_module_module WHERE name = 'nusara_base'")"
    want="installed $(ops_manifest_get "$MANIFEST" nusara_base_version)"
    if [ "$nb" = "$want" ]; then pass "nusara_base: $nb"; else fail "nusara_base: '$nb', diharapkan '$want'"; fi

    base_v="$(ops_psql "$RESTORE_DB" "SELECT latest_version FROM ir_module_module WHERE name = 'base'")"
    want="$(ops_manifest_get "$MANIFEST" odoo_base_version)"
    if [ "$base_v" = "$want" ]; then pass "versi base $base_v"; else fail "versi base $base_v, manifest $want"; fi

    # 2) Integritas pembukuan: jurnal terposting harus seimbang.
    bal="$(ops_psql "$RESTORE_DB" "SELECT COALESCE(sum(balance), 0) FROM account_move_line WHERE parent_state = 'posted'")"
    if [[ "$bal" =~ ^-?0+(\.0+)?$ ]]; then pass "jurnal terposting seimbang (selisih debit-kredit $bal)"; else fail "jurnal terposting TIDAK seimbang (selisih $bal)"; fi

    # 3) Lampiran: berkas ada di filestore dan isinya cocok dengan checksum di database.
    fs_files="$(ops_fs_count "$RESTORE_DB")"
    want="$(ops_manifest_get "$MANIFEST" filestore_files)"
    if [ "$fs_files" = "$want" ]; then pass "berkas filestore $fs_files"; else fail "berkas filestore $fs_files, manifest $want"; fi
    res="$(ops_fs_verify "$RESTORE_DB" "$VERIFY_SAMPLE")"
    chk="${res#checked=}"; chk="${chk%% *}"
    mis="${res#*missing=}"; mis="${mis%% *}"
    bad="${res#*mismatch=}"
    if [ "$mis" = "0" ] && [ "$bad" = "0" ]; then
        pass "lampiran terbaca: $chk diperiksa (berkas ada dan sha1 cocok)"
    else
        fail "lampiran bermasalah dari $chk yang diperiksa: berkas hilang $mis, isi tidak cocok $bad"
    fi

    # 4) Angka kunci data terhadap manifest (bisa bergeser bila database sumber dipakai saat dump).
    drift=0
    while IFS='=' read -r key value; do
        [ -n "$key" ] || continue
        case "$key" in stat_tables | stat_installed_modules) continue ;; esac
        want="$(ops_manifest_get "$MANIFEST" "$key")"
        if [ "$value" != "$want" ]; then
            drift=$((drift + 1))
            if [ "$STRICT" -eq 1 ]; then fail "$key = $value, manifest $want"; else warn "$key = $value, manifest $want (database sumber mungkin berubah antara pembacaan angka dan dump)"; fi
        fi
    done <<<"$(ops_stats "$RESTORE_DB")"
    [ "$drift" -gt 0 ] || pass "angka kunci data (jurnal, saldo, lampiran, dan lain-lain) sama dengan manifest"

    printf '\nHasil verifikasi: %s kegagalan, %s catatan.\n' "$FAILS" "$WARNS"
fi

DONE=1
if [ "$FAILS" -gt 0 ]; then
    ops_warn "verifikasi GAGAL; database '$RESTORE_DB' dibiarkan untuk diperiksa. Hapus bila tidak dipakai: docker compose -p $COMPOSE_PROJECT exec -T $OPS_DB_SERVICE dropdb -U $OPS_DB_USER $RESTORE_DB"
    exit 1
fi
if [ "$VERIFY_ONLY" -eq 1 ]; then
    ops_log "Verifikasi '$RESTORE_DB' terhadap backup '$SRC_DB' lulus"
else
    ops_log "Pemulihan '$SRC_DB' -> '$RESTORE_DB' selesai$REPLACED_NOTE"
fi
