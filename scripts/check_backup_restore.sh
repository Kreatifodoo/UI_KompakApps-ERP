#!/usr/bin/env bash
# Uji pulih otomatis: buat data (transaksi, lampiran, logo) -> backup -> ubah dan hapus data sumber ->
# restore ke database baru -> cocokkan angka. Keluar dengan kode non-nol bila ada yang berbeda.
#
# Skrip ini MENULIS data ke database sumber (faktur terposting, lampiran) dan mengubahnya setelah backup,
# jadi hanya jalankan pada database uji, bukan database yang dipakai pengguna.
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
  COMPOSE_PROJECT=<proyek> ODOO_DB=<database-uji> scripts/check_backup_restore.sh --yes [opsi]

Opsi:
  --yes               konfirmasi bahwa <database-uji> adalah database uji (skrip menulis dan mengubah datanya)
  -p, --project       COMPOSE_PROJECT  proyek Docker Compose (WAJIB)
  -d, --db            ODOO_DB          database uji sumber (WAJIB); hasil pemulihan memakai nama <database>_restore
      --env-file      COMPOSE_ENV_FILE berkas .env untuk Compose
      --compose-file  COMPOSE_FILE     berkas compose
      --skip-rotation lewati uji rotasi (3 backup tambahan)
      --keep          jangan hapus database hasil pemulihan dan folder kerja di akhir
  -h, --help          tampilkan bantuan ini

Prasyarat: stack berjalan, database sudah berisi nusara_base dan data contoh (scripts/seed_demo.py).
Kode keluar: 0 semua cocok, 1 ada yang berbeda atau gagal, 2 salah pemakaian.
EOF
}

ODOO_DB="${ODOO_DB:-}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-}"
COMPOSE_ENV_FILE="${COMPOSE_ENV_FILE:-}"
YES=0
KEEP_ARTIFACTS=0
SKIP_ROTATION=0

while [ $# -gt 0 ]; do
    case "$1" in
        --yes) YES=1; shift ;;
        -p | --project) [ $# -ge 2 ] || ops_usage_die "$1 butuh nilai"; COMPOSE_PROJECT="$2"; shift 2 ;;
        -d | --db) [ $# -ge 2 ] || ops_usage_die "$1 butuh nilai"; ODOO_DB="$2"; shift 2 ;;
        --env-file) [ $# -ge 2 ] || ops_usage_die "$1 butuh nilai"; COMPOSE_ENV_FILE="$2"; shift 2 ;;
        --compose-file) [ $# -ge 2 ] || ops_usage_die "$1 butuh nilai"; COMPOSE_FILE="$2"; shift 2 ;;
        --skip-rotation) SKIP_ROTATION=1; shift ;;
        --keep) KEEP_ARTIFACTS=1; shift ;;
        -h | --help) usage; exit 0 ;;
        *) ops_usage_die "argumen tidak dikenal: $1" ;;
    esac
done

[ "$YES" -eq 1 ] || ops_usage_die "tambahkan --yes: skrip ini menulis dan mengubah data database sumber, jadi hanya untuk database uji"
[ -n "$ODOO_DB" ] || ops_usage_die "ODOO_DB wajib diisi; tidak ada nilai bawaan agar tidak salah sasaran"
ops_valid_name ODOO_DB "$ODOO_DB"
ops_setup_compose
export COMPOSE_PROJECT COMPOSE_ENV_FILE # diteruskan ke backup.sh dan restore.sh
ops_require_db_service
ops_db_exists "$ODOO_DB" || ops_die "database '$ODOO_DB' tidak ada di proyek $COMPOSE_PROJECT"

RESTORE_DB="${ODOO_DB}_restore"
ops_valid_name "database hasil pemulihan" "$RESTORE_DB"
if ops_db_exists "$RESTORE_DB"; then
    ops_die "database '$RESTORE_DB' sudah ada (sisa uji sebelumnya?). Hapus dulu bila tidak dipakai: docker compose -p $COMPOSE_PROJECT exec -T $OPS_DB_SERVICE dropdb -U $OPS_DB_USER $RESTORE_DB"
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/nusara-check-backup.XXXXXX")"
BACKUPS="$WORK/backups"
TAG="$(date '+%Y%m%d%H%M%S')"
PASS=0
FAIL=0

ok() { printf '  ok      %s\n' "$*"; PASS=$((PASS + 1)); }
bad() { printf '  GAGAL   %s\n' "$*"; FAIL=$((FAIL + 1)); }
check() { # check "pesan" nilai-sebenarnya nilai-diharapkan
    if [ "$2" = "$3" ]; then ok "$1: $2"; else bad "$1: dapat '$2', seharusnya '$3'"; fi
}
check_same() { # check_same "pesan" teks-sebenarnya teks-diharapkan (untuk keluaran banyak baris)
    if [ "$2" = "$3" ]; then ok "$1: identik"; else bad "$1: berbeda"; diff <(printf '%s\n' "$3") <(printf '%s\n' "$2") | sed 's/^/    /' || true; fi
}
step() { printf '\n== %s\n' "$*"; }

drop_restore_dbs() {
    local name
    for name in $(ops_psql postgres "SELECT datname FROM pg_database WHERE datname = '$RESTORE_DB' OR datname LIKE '${RESTORE_DB}_replaced_%' OR datname = '${RESTORE_DB}_bad'"); do
        ops_psql postgres "DROP DATABASE IF EXISTS \"$name\"" >/dev/null 2>&1 || true
        ops_odoo sh -c 'rm -rf "$1/filestore/$2"' sh "$OPS_DATA_DIR" "$name" </dev/null >/dev/null 2>&1 || true
    done
}

cleanup() {
    local rc=$?
    if [ "$KEEP_ARTIFACTS" -eq 1 ]; then
        printf '\nDiberi --keep: database %s dan folder kerja %s dibiarkan.\n' "$RESTORE_DB" "$WORK"
    else
        drop_restore_dbs
        rm -rf -- "$WORK"
    fi
    return "$rc"
}
trap cleanup EXIT

# Menjalankan skrip Python di odoo shell pada database sumber (container sekali pakai, bukan exec,
# karena kredensial database disuntikkan oleh entrypoint). Hanya baris "CHECK_..." yang diteruskan.
odoo_shell() { # odoo_shell berkas-python [VAR=nilai ...]
    local script="$1" env_args=() kv
    shift
    for kv in "$@"; do env_args+=(-e "$kv"); done
    "${OPS_DC[@]}" run --rm --no-deps -T ${env_args[@]+"${env_args[@]}"} "$OPS_ODOO_SERVICE" odoo shell -d "$ODOO_DB" --no-http <"$script" 2>&1 | grep '^CHECK_' || true
}

kv_get() { sed -n "s/^$2=//p" <<<"$1" | head -n 1; }

cat >"$WORK/seed.py" <<'PY'
import base64, datetime, hashlib, io, os
from PIL import Image

tag = os.environ["CHECK_TAG"]
today = datetime.date.today()
company = env["res.company"].browse(1)
partner = env["res.partner"].create({"name": "Uji Backup " + tag, "is_company": True, "customer_rank": 1})
vendor = env["res.partner"].search([("name", "=", "PT Pemasok Nusantara")], limit=1) or env["res.partner"].create(
    {"name": "Pemasok Uji Backup " + tag, "is_company": True, "supplier_rank": 1})
product = env["product.product"].search([("name", "=", "Bahan Baku Nusara")], limit=1)
if not product:
    raise SystemExit("CHECK_ERROR=produk contoh tidak ada; jalankan scripts/seed_demo.py dulu")

# Transaksi: dua faktur pelanggan dan satu tagihan vendor, semuanya terposting.
for qty in (3, 5):
    invoice = env["account.move"].create({
        "move_type": "out_invoice", "partner_id": partner.id, "invoice_date": today,
        "invoice_line_ids": [(0, 0, {"product_id": product.id, "quantity": qty, "price_unit": 150000.0})],
    })
    invoice.action_post()
bill = env["account.move"].create({
    "move_type": "in_invoice", "partner_id": vendor.id, "invoice_date": today,
    "invoice_line_ids": [(0, 0, {"product_id": product.id, "quantity": 7, "price_unit": 100000.0})],
})
bill.action_post()

# Lampiran: berkas acak 64 KB, dan logo (gambar PNG pada mitra, tersimpan sebagai lampiran gambar di filestore).
payload = os.urandom(65536)
attachment = env["ir.attachment"].create({
    "name": "backup-check-%s.bin" % tag, "datas": base64.b64encode(payload),
    "res_model": "res.partner", "res_id": partner.id,
})
buf = io.BytesIO()
Image.frombytes("RGB", (96, 96), os.urandom(96 * 96 * 3)).save(buf, "PNG")
partner.image_1920 = base64.b64encode(buf.getvalue())
env.cr.commit()
print("CHECK_PARTNER_ID=%s" % partner.id)
print("CHECK_ATT_ID=%s" % attachment.id)
print("CHECK_ATT_SHA256=%s" % hashlib.sha256(payload).hexdigest())
print("CHECK_ATT_FNAME=%s" % attachment.store_fname)
print("CHECK_SEED_OK=1")
PY

cat >"$WORK/mutate.py" <<'PY'
import datetime, os

partner = env["res.partner"].browse(int(os.environ["CHECK_PARTNER_ID"]))
product = env["product.product"].search([("name", "=", "Bahan Baku Nusara")], limit=1)
# Hapus lampiran uji, ubah mitra, dan tambah satu faktur terposting setelah backup.
env["ir.attachment"].browse(int(os.environ["CHECK_ATT_ID"])).unlink()
partner.name = partner.name + " (DIUBAH)"
invoice = env["account.move"].create({
    "move_type": "out_invoice", "partner_id": partner.id, "invoice_date": datetime.date.today(),
    "invoice_line_ids": [(0, 0, {"product_id": product.id, "quantity": 11, "price_unit": 150000.0})],
})
invoice.action_post()
env.cr.commit()
print("CHECK_MUTATE_OK=1")
PY

step "Persiapan: data uji di '$ODOO_DB' (transaksi, lampiran, logo)"
OUT="$(odoo_shell "$WORK/seed.py" "CHECK_TAG=$TAG")"
[ "$(kv_get "$OUT" CHECK_SEED_OK)" = "1" ] || { printf '%s\n' "$OUT" >&2; ops_die "pembuatan data uji gagal"; }
PARTNER_ID="$(kv_get "$OUT" CHECK_PARTNER_ID)"
ATT_ID="$(kv_get "$OUT" CHECK_ATT_ID)"
ATT_SHA="$(kv_get "$OUT" CHECK_ATT_SHA256)"
ATT_FNAME="$(kv_get "$OUT" CHECK_ATT_FNAME)"
[ -n "$ATT_FNAME" ] && [ "$ATT_FNAME" != "False" ] || ops_die "lampiran uji tidak tersimpan di filestore (store_fname kosong)"
ok "data uji dibuat (mitra $PARTNER_ID, lampiran $ATT_ID di filestore: $ATT_FNAME)"

BEFORE="$(ops_stats "$ODOO_DB")"
BEFORE_FS="$(ops_fs_count "$ODOO_DB")"
printf '%s\n' "$BEFORE" | sed 's/^/    /'
printf '    berkas filestore=%s\n' "$BEFORE_FS"

step "Backup"
backup_run() { # backup_run folder [KEEP]
    COMPOSE_PROJECT="$COMPOSE_PROJECT" ODOO_DB="$ODOO_DB" BACKUP_DIR="$1" KEEP="${2:-0}" "$HERE/backup.sh"
}
backup_run "$BACKUPS"
BK="$(find "$BACKUPS" -mindepth 1 -maxdepth 1 -type d -name "${ODOO_DB}_*" | head -n 1)"
[ -n "$BK" ] || ops_die "folder backup tidak ditemukan"
check "manifest: database" "$(ops_manifest_get "$BK/manifest.json" database)" "$ODOO_DB"
check "manifest: checksum dump" "$(ops_manifest_get "$BK/manifest.json" dump_sha256)" "$(ops_sha256 "$BK/db.dump")"
check "manifest: berkas filestore" "$(ops_manifest_get "$BK/manifest.json" filestore_files)" "$BEFORE_FS"
MISMATCH=0
while IFS='=' read -r key value; do
    [ -n "$key" ] || continue
    [ "$(ops_manifest_get "$BK/manifest.json" "$key")" = "$value" ] || { bad "manifest $key tidak sama dengan database"; MISMATCH=1; }
done <<<"$BEFORE"
[ "$MISMATCH" -eq 1 ] || ok "semua angka kunci di manifest sama dengan database saat backup"

step "Ubah dan hapus data sumber setelah backup"
OUT="$(odoo_shell "$WORK/mutate.py" "CHECK_PARTNER_ID=$PARTNER_ID" "CHECK_ATT_ID=$ATT_ID")"
[ "$(kv_get "$OUT" CHECK_MUTATE_OK)" = "1" ] || { printf '%s\n' "$OUT" >&2; ops_die "pengubahan data sumber gagal"; }
ops_odoo sh -c 'rm -f "$1/filestore/$2/$3"' sh "$OPS_DATA_DIR" "$ODOO_DB" "$ATT_FNAME" </dev/null
AFTER_MUTATE="$(ops_stats "$ODOO_DB")"
if [ "$AFTER_MUTATE" != "$BEFORE" ]; then ok "database sumber kini berbeda dari saat backup (faktur bertambah, lampiran terhapus)"; else bad "database sumber tidak berubah; uji tidak bermakna"; fi
check "lampiran uji di database sumber setelah dihapus" "$(ops_psql "$ODOO_DB" "SELECT count(*) FROM ir_attachment WHERE id = $ATT_ID")" "0"
check "berkas lampiran uji di filestore sumber setelah dihapus" "$(ops_odoo sh -c '[ -f "$1/filestore/$2/$3" ] && echo ada || echo tidak-ada' sh "$OPS_DATA_DIR" "$ODOO_DB" "$ATT_FNAME" </dev/null | tr -d '\r')" "tidak-ada"

step "Restore ke database baru '$RESTORE_DB'"
RESTORE_OUT="$WORK/restore.log"
if COMPOSE_PROJECT="$COMPOSE_PROJECT" "$HERE/restore.sh" "$BK" "$RESTORE_DB" >"$RESTORE_OUT" 2>&1; then
    ok "restore.sh selesai dan lolos verifikasinya sendiri"
else
    bad "restore.sh gagal; keluaran:"
    sed 's/^/    /' "$RESTORE_OUT"
fi
grep -E '^  (ok|GAGAL|CATATAN)' "$RESTORE_OUT" | sed 's/^/    /' || true

step "Cocokkan hasil pemulihan dengan keadaan saat backup"
RESTORED="$(ops_stats "$RESTORE_DB")"
while IFS='=' read -r key value; do
    [ -n "$key" ] || continue
    check "$key" "$(kv_get "$RESTORED" "$key")" "$value"
done <<<"$BEFORE"
check "berkas filestore" "$(ops_fs_count "$RESTORE_DB")" "$BEFORE_FS"
check "lampiran uji kembali di database hasil pemulihan" "$(ops_psql "$RESTORE_DB" "SELECT count(*) FROM ir_attachment WHERE id = $ATT_ID AND store_fname = '$ATT_FNAME'")" "1"
RESTORED_SHA="$(ops_odoo sh -c 'sha256sum "$1/filestore/$2/$3" | cut -d" " -f1' sh "$OPS_DATA_DIR" "$RESTORE_DB" "$ATT_FNAME" </dev/null | tr -d '\r')"
check "isi lampiran uji (sha256 dari filestore hasil pemulihan)" "$RESTORED_SHA" "$ATT_SHA"
check "nama mitra kembali ke keadaan sebelum diubah" "$(ops_psql "$RESTORE_DB" "SELECT name FROM res_partner WHERE id = $PARTNER_ID")" "Uji Backup $TAG"

step "Perlindungan: restore menolak menimpa dan menolak backup rusak"
if COMPOSE_PROJECT="$COMPOSE_PROJECT" "$HERE/restore.sh" "$BK" "$RESTORE_DB" >"$WORK/refuse.log" 2>&1; then
    bad "restore ke database yang sudah ada seharusnya ditolak"
else
    ok "restore ke database yang sudah ada ditolak tanpa --overwrite"
fi
check_same "database hasil pemulihan tidak berubah setelah penolakan" "$(ops_stats "$RESTORE_DB")" "$RESTORED"
cp -R "$BK" "$WORK/rusak"
printf 'x' >>"$WORK/rusak/db.dump"
if COMPOSE_PROJECT="$COMPOSE_PROJECT" "$HERE/restore.sh" "$WORK/rusak" "${RESTORE_DB}_bad" >"$WORK/corrupt.log" 2>&1; then
    bad "backup yang rusak seharusnya ditolak"
else
    ok "backup yang rusak (checksum tidak cocok) ditolak"
fi
check "database dari backup rusak tidak terbentuk" "$(ops_db_exists "${RESTORE_DB}_bad" && echo ada || echo tidak-ada)" "tidak-ada"

step "Verifikasi mendeteksi kerusakan: berkas lampiran hilang dari filestore hasil pemulihan"
ops_odoo sh -c 'rm -f "$1/filestore/$2/$3"' sh "$OPS_DATA_DIR" "$RESTORE_DB" "$ATT_FNAME" </dev/null
if COMPOSE_PROJECT="$COMPOSE_PROJECT" "$HERE/restore.sh" "$BK" "$RESTORE_DB" --verify-only >"$WORK/verify1.log" 2>&1; then
    bad "verifikasi seharusnya gagal karena berkas lampiran hilang"
else
    ok "verifikasi gagal sesuai harapan"
fi
grep -E 'GAGAL +(lampiran|berkas filestore)' "$WORK/verify1.log" | sed 's/^/    /' || true

step "Restore dengan --overwrite mengganti nama database lama, bukan menghapusnya"
if COMPOSE_PROJECT="$COMPOSE_PROJECT" "$HERE/restore.sh" "$BK" "$RESTORE_DB" --overwrite >"$WORK/overwrite.log" 2>&1; then ok "restore --overwrite berhasil"; else bad "restore --overwrite gagal"; sed 's/^/    /' "$WORK/overwrite.log"; fi
check "database lama masih ada dengan nama cadangan" "$(ops_psql postgres "SELECT count(*) FROM pg_database WHERE datname LIKE '${RESTORE_DB}_replaced_%'")" "1"
check_same "isi hasil --overwrite sama dengan backup" "$(ops_stats "$RESTORE_DB")" "$BEFORE"
if COMPOSE_PROJECT="$COMPOSE_PROJECT" "$HERE/restore.sh" "$BK" "$RESTORE_DB" --verify-only >"$WORK/verify2.log" 2>&1; then ok "verifikasi ulang (--verify-only) lulus setelah --overwrite"; else bad "verifikasi ulang gagal setelah --overwrite"; fi

if [ "$SKIP_ROTATION" -eq 0 ]; then
    step "Rotasi: KEEP=2 menyisakan dua backup terbaru"
    for _ in 1 2 3; do
        sleep 1
        backup_run "$WORK/rotasi" 2 >/dev/null
    done
    check "jumlah folder backup tersisa" "$(find "$WORK/rotasi" -mindepth 1 -maxdepth 1 -type d -name "${ODOO_DB}_*" | wc -l | tr -d ' ')" "2"
    NEWEST="$(find "$WORK/rotasi" -mindepth 1 -maxdepth 1 -type d -name "${ODOO_DB}_*" | sort | tail -n 1)"
    if [ -f "$NEWEST/manifest.json" ]; then ok "backup terbaru utuh setelah rotasi"; else bad "backup terbaru hilang setelah rotasi"; fi
fi

printf '\nRingkasan: %s cocok, %s berbeda.\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
    ops_warn "uji pulih GAGAL ($FAIL pemeriksaan berbeda)"
    exit 1
fi
ops_log "Uji pulih LULUS: backup dan restore '$ODOO_DB' -> '$RESTORE_DB' menghasilkan angka yang sama"
