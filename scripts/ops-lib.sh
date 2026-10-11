# shellcheck shell=bash disable=SC2016
# Fungsi bersama untuk backup.sh, restore.sh, dan check_backup_restore.sh (di-source, bukan dijalankan).
# Kompatibel dengan bash 3.2 (bawaan macOS). Tidak mencetak rahasia: kata sandi database tidak pernah
# dipakai karena perintah dijalankan di dalam container db lewat socket lokal (autentikasi trust).

OPS_DB_USER="${OPS_DB_USER:-odoo}"
OPS_DB_SERVICE="${OPS_DB_SERVICE:-db}"
OPS_ODOO_SERVICE="${OPS_ODOO_SERVICE:-odoo}"
OPS_DATA_DIR="${OPS_DATA_DIR:-/var/lib/odoo}"
OPS_DC=()

ops_now() { date '+%Y-%m-%d %H:%M:%S'; }
ops_log() { printf '%s %s\n' "$(ops_now)" "$*"; }
ops_warn() { printf '%s PERINGATAN: %s\n' "$(ops_now)" "$*" >&2; }
ops_die() {
    printf '%s GALAT: %s\n' "$(ops_now)" "$*" >&2
    exit 1
}
# usage() didefinisikan oleh skrip pemanggil.
ops_usage_die() {
    printf 'GALAT: %s\n\n' "$*" >&2
    usage >&2
    exit 2
}

# Nama proyek, database, dan folder dipakai di perintah dan nama berkas; batasi karakternya.
ops_valid_name() {
    local label="$1" value="$2" re='^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$'
    [[ "$value" =~ $re ]] || ops_usage_die "$label tidak valid: hanya huruf, angka, titik, garis bawah, dan strip (maks 63 karakter)"
}

ops_sha256() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d' ' -f1
    else
        shasum -a 256 "$1" | cut -d' ' -f1
    fi
}

ops_filesize() { wc -c <"$1" | tr -d ' '; }

ops_human() {
    awk -v b="$1" 'BEGIN { s = "B KB MB GB TB"; split(s, u, " "); i = 1; while (b >= 1024 && i < 5) { b /= 1024; i++ } printf (i == 1 ? "%d %s" : "%.1f %s"), b, u[i] }'
}

# Menyiapkan perintah compose dari COMPOSE_PROJECT, COMPOSE_ENV_FILE, dan COMPOSE_FILE (variabel standar Compose).
ops_setup_compose() {
    [ -n "${COMPOSE_PROJECT:-}" ] || ops_usage_die "COMPOSE_PROJECT wajib diisi (--project atau variabel lingkungan); tidak ada nilai bawaan agar tidak salah sasaran"
    ops_valid_name COMPOSE_PROJECT "$COMPOSE_PROJECT"
    command -v docker >/dev/null 2>&1 || ops_die "perintah docker tidak ditemukan di PATH"
    OPS_DC=(docker compose -p "$COMPOSE_PROJECT")
    if [ -n "${COMPOSE_ENV_FILE:-}" ]; then
        [ -r "$COMPOSE_ENV_FILE" ] || ops_die "berkas lingkungan tidak terbaca: $COMPOSE_ENV_FILE"
        OPS_DC+=(--env-file "$COMPOSE_ENV_FILE")
    fi
    if [ -n "${COMPOSE_FILE:-}" ]; then
        export COMPOSE_FILE
    fi
    # Tanpa baris "Container ... Creating/Created" dari 'docker compose run' (galat tetap tampil).
    export COMPOSE_PROGRESS="${COMPOSE_PROGRESS:-quiet}"
}

# Memastikan layanan db berjalan dan database yang diminta ada (atau tidak, lihat ops_db_exists).
ops_require_db_service() {
    local ids
    ids="$("${OPS_DC[@]}" ps --status running -q "$OPS_DB_SERVICE" 2>/dev/null </dev/null)" ||
        ops_die "gagal menjalankan 'docker compose' untuk proyek $COMPOSE_PROJECT (jalankan dari folder berkas compose atau isi COMPOSE_FILE)"
    [ -n "$ids" ] || ops_die "layanan $OPS_DB_SERVICE pada proyek $COMPOSE_PROJECT tidak berjalan"
}

# psql di container db. Argumen: nama-database, SQL. Keluaran tanpa header dan tanpa pemisah (-At).
ops_psql() {
    "${OPS_DC[@]}" exec -T "$OPS_DB_SERVICE" psql -U "$OPS_DB_USER" -d "$1" -X -q -At -v ON_ERROR_STOP=1 -c "$2" </dev/null
}

ops_db_exists() {
    [ "$(ops_psql postgres "SELECT 1 FROM pg_database WHERE datname = '$1'")" = "1" ]
}

# Menjalankan perintah di layanan odoo: exec bila berjalan, kalau tidak container sekali pakai
# (volume filestore yang sama, tanpa menyalakan Odoo). Stdin diteruskan.
ops_odoo() {
    local ids
    ids="$("${OPS_DC[@]}" ps --status running -q "$OPS_ODOO_SERVICE" 2>/dev/null </dev/null || true)"
    if [ -n "$ids" ]; then
        "${OPS_DC[@]}" exec -T "$OPS_ODOO_SERVICE" "$@"
    else
        "${OPS_DC[@]}" run --rm --no-deps -T --entrypoint "$1" "$OPS_ODOO_SERVICE" "${@:2}"
    fi
}

# Jumlah berkas di filestore sebuah database.
ops_fs_count() {
    ops_odoo sh -c 'd="$1/filestore/$2"; if [ -d "$d" ]; then find "$d" -type f | wc -l; else echo 0; fi' sh "$OPS_DATA_DIR" "$1" </dev/null | tr -d ' \r'
}

# Memeriksa sampel lampiran berkas (terbaru dulu): berkasnya ada dan sha1 isinya sama dengan kolom checksum.
# Argumen: database, jumlah sampel. Keluaran: "checked=N missing=N mismatch=N".
ops_fs_verify() {
    ops_psql "$1" "SELECT store_fname || '|' || COALESCE(checksum, '') FROM ir_attachment WHERE store_fname IS NOT NULL ORDER BY id DESC LIMIT $2" |
        ops_odoo sh -c '
            base="$1/filestore/$2"; checked=0; missing=0; bad=0
            while IFS="|" read -r f c; do
                [ -n "$f" ] || continue
                checked=$((checked + 1))
                if [ ! -f "$base/$f" ]; then missing=$((missing + 1)); continue; fi
                if [ -n "$c" ]; then
                    s=$(sha1sum "$base/$f" | cut -d" " -f1)
                    [ "$s" = "$c" ] || bad=$((bad + 1))
                fi
            done
            echo "checked=$checked missing=$missing mismatch=$bad"
        ' sh "$OPS_DATA_DIR" "$1" | tr -d '\r'
}

# Angka kunci database, satu "kunci=nilai" per baris. Dipakai sebagai sidik jari: manifest backup,
# verifikasi restore, dan pencocokan sebelum/sesudah di check_backup_restore.sh.
OPS_STATS_SQL="
SELECT 'stat_tables=' || count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
UNION ALL SELECT 'stat_installed_modules=' || count(*) FROM ir_module_module WHERE state = 'installed'
UNION ALL SELECT 'stat_moves=' || count(*) FROM account_move
UNION ALL SELECT 'stat_moves_posted=' || count(*) FROM account_move WHERE state = 'posted'
UNION ALL SELECT 'stat_move_lines_posted=' || count(*) FROM account_move_line WHERE parent_state = 'posted'
UNION ALL SELECT 'stat_posted_balance=' || COALESCE(sum(balance), 0) FROM account_move_line WHERE parent_state = 'posted'
UNION ALL SELECT 'stat_balance_assets=' || COALESCE(sum(l.balance), 0) FROM account_move_line l JOIN account_account a ON a.id = l.account_id WHERE l.parent_state = 'posted' AND a.account_type LIKE 'asset%'
UNION ALL SELECT 'stat_balance_liabilities=' || COALESCE(sum(l.balance), 0) FROM account_move_line l JOIN account_account a ON a.id = l.account_id WHERE l.parent_state = 'posted' AND a.account_type LIKE 'liability%'
UNION ALL SELECT 'stat_balance_equity=' || COALESCE(sum(l.balance), 0) FROM account_move_line l JOIN account_account a ON a.id = l.account_id WHERE l.parent_state = 'posted' AND a.account_type LIKE 'equity%'
UNION ALL SELECT 'stat_balance_pnl=' || COALESCE(sum(l.balance), 0) FROM account_move_line l JOIN account_account a ON a.id = l.account_id WHERE l.parent_state = 'posted' AND (a.account_type LIKE 'income%' OR a.account_type LIKE 'expense%')
UNION ALL SELECT 'stat_trial_balance_md5=' || COALESCE(md5(string_agg(account_id || ':' || d || ':' || c, ',' ORDER BY account_id)), '-') FROM (SELECT account_id, sum(debit) AS d, sum(credit) AS c FROM account_move_line WHERE parent_state = 'posted' GROUP BY account_id) t
UNION ALL SELECT 'stat_attachments=' || count(*) FROM ir_attachment
UNION ALL SELECT 'stat_attachments_file=' || count(*) FROM ir_attachment WHERE store_fname IS NOT NULL
UNION ALL SELECT 'stat_attachments_md5=' || COALESCE(md5(string_agg(store_fname || ':' || COALESCE(checksum, ''), ',' ORDER BY store_fname)), '-') FROM ir_attachment WHERE store_fname IS NOT NULL
UNION ALL SELECT 'stat_partners=' || count(*) FROM res_partner
UNION ALL SELECT 'stat_products=' || count(*) FROM product_template
UNION ALL SELECT 'stat_sale_orders=' || count(*) FROM sale_order
UNION ALL SELECT 'stat_purchase_orders=' || count(*) FROM purchase_order
UNION ALL SELECT 'stat_stock_moves=' || count(*) FROM stock_move
"

ops_stats() { ops_psql "$1" "$OPS_STATS_SQL" | sort; }

# Nilai kunci dari manifest.json buatan backup.sh (satu kunci per baris).
ops_manifest_get() {
    sed -n "s/^[[:space:]]*\"$2\":[[:space:]]*\"\{0,1\}\([^\",]*\)\"\{0,1\},\{0,1\}[[:space:]]*$/\1/p" "$1" | head -n 1
}
