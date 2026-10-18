# Panduan Pengembangan KompakApps

## Bentuk proyek

- Backend Odoo 19 Community ditambah modul OCA yang dikunci di `oca.lock`; modul sendiri di `addons/kompakapps_base`.
- UI statis di `ui/live` (JavaScript modul tanpa build). Satu halaman satu berkas di `ui/live/pages`, dipasang di `main.js` (`PAGES`) dan `menu.js` (rute).
- UI berbicara ke Odoo lewat JSON-2 (`POST /json/2/<model>/<metode>`) dengan API key; nginx meneruskan permintaan pada alamat yang sama.

## Kontrak halaman

Setiap halaman mengekspor `render(sub, query)`, `onClick(event, el)`, `onInput`, `onChange`, `onSubmit`, dan `leave` (semuanya opsional kecuali `render`). Rute `#/<halaman>/<sub>?<query>`. Untuk master sederhana pakai kerangka `pages/masters.js` (lihat `account.js` atau `tax.js` sebagai contoh), untuk laporan dengan dimensi dan ukuran pakai `pages/analysis.js`.

## Lingkungan uji terpisah (wajib untuk uji)

Jangan menguji di database `kompakapps` milik pemilik. Buat stack uji sendiri dengan nama proyek, port, dan database yang berbeda:

```bash
export PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin"
mkdir -p "$SCRATCH"                      # folder sementara di luar repo
# berkas lingkungan dengan rahasia acak (jangan dicetak atau di-commit)
printf 'DB_PASSWORD=%s\nADMIN_PASSWD=%s\nODOO_VERSION=19.0\nODOO_DB=kompakapps_<nama>\nODOO_PORT=<port odoo>\nUI_PORT=<port ui>\n' "$(openssl rand -hex 12)" "$(openssl rand -hex 12)" > "$SCRATCH/stack.env"
docker compose -p kompakapps-<nama> --env-file "$SCRATCH/stack.env" up -d db odoo ui
docker compose -p kompakapps-<nama> --env-file "$SCRATCH/stack.env" run --rm -T --no-deps odoo \
  odoo -d kompakapps_<nama> -i kompakapps_base --without-demo=all --stop-after-init
```

Jalankan perintah `docker compose` dari folder worktree Anda: folder `addons` dan `ui/live` di-mount relatif terhadap berkas compose. Data contoh dan API key uji dibuat dengan `odoo shell` memakai skrip di `scripts/seed_demo.py` (lihat README) ditambah pembuatan API key lewat `env['res.users.apikeys'].with_user(admin)._generate('rpc', 'uji', kedaluwarsa)`; simpan key ke berkas berizin 600 dan jangan mencetaknya.

## Pengujian

1. Test Odoo (modul sendiri): `docker compose ... run --rm -T --no-deps odoo odoo -d <db-baru> -i kompakapps_base --test-enable --test-tags /kompakapps_base --without-demo=all --stop-after-init --log-level=test`; ringkasan ada pada baris "post-tests ... 0 failed".
2. Skrip regresi API: `KOMPAKAPPS_API_KEY=$(cat key) python3 -I scripts/check_p2p_api.py --yes --url http://127.0.0.1:<port ui>`. Skrip menulis data; pakai database uji. Tambahkan fungsi `check_*` baru untuk setiap irisan dan panggil dari `main()`.
3. Uji UI di browser: buka tab milik sendiri (`tabs_create`), serahkan API key lewat server loopback satu kali pakai, dan gerakkan halaman lewat DOM (isi input, klik, baca teks). Jangan memakai atau menutup tab milik pengguna lain.
4. `node --check` untuk setiap berkas JavaScript dan pre-commit sebelum commit.

## Jebakan yang sudah ditemukan

- JSON-2 hanya memanggil metode publik; argumen recordset (`currency`, `product`, `partner`) tidak diubah dari id sehingga perlu dihindari atau dibungkus.
- `create` tanpa harga eksplisit menghitung harga dari daftar harga; menulis harga manual dilakukan sebagai langkah kedua.
- Kolom yang tidak tersimpan (mis. `mail.activity.state`, `purchased_qty`, `product_expiry_alert`) tidak bisa dicari, dikelompokkan, atau dijumlahkan.
- Nilai kosong dikirim Odoo sebagai `false`; di JavaScript pakai `||` (bukan `??`) untuk nilai teks atau relasi kosong.
- Mengubah `qty_producing` lewat API tidak menyesuaikan komponen atau produk sampingan (onchange hanya jalan di klien web).
- Memasang modul lewat API menyetel ulang registri; pasang lewat manifest `kompakapps_base` dan `-u kompakapps_base`.
- Pesan galat Odoo ditampilkan apa adanya di toast; pastikan validasi sisi klien memberi pesan Indonesia yang jelas lebih dulu.
- Inisialisasi (`-i kompakapps_base`) dan upgrade (`-u`) jangan dijalankan sementara layanan `odoo` yang menunjuk database yang sama masih menyala: dua proses memuat registri bersamaan dan salah satunya gagal dengan `could not serialize access due to concurrent update`, meninggalkan database setengah terpasang. Urutan aman: `up -d db`, jalankan `-i` atau `-u`, baru `up -d odoo ui` (atau `stop odoo` dulu). Ditemukan saat menyiapkan uji backup (D32).

## Alur kerja

1. Branch dari `main` terbaru, nama `feat/<topik>`.
2. Kerjakan, uji (test Odoo, skrip API, uji browser), tulis keputusan baru di `docs/DECISIONS.md`, dan perbarui tabel README.
3. Jalankan pre-commit dan hanya lanjut commit bila lulus (rantai dengan `&&`).
4. Commit, push, buka PR; tunggu CI hijau; squash-merge dengan `--match-head-commit` lalu hapus branch.
5. Upgrade database `kompakapps` pemilik hanya setelah merge, dengan backup lebih dulu: `docker compose run --rm -T --no-deps odoo odoo -d kompakapps -u kompakapps_base --stop-after-init`, lalu restart Odoo.

## Operasional (backup, pemulihan, pemantauan, uji beban)

Skrip dan prosedurnya ada di [OPERATIONS.md](OPERATIONS.md): `scripts/backup.sh`, `scripts/restore.sh`, `scripts/check_backup_restore.sh` (uji pulih otomatis), `scripts/healthcheck.py`, dan `scripts/loadtest.py`. Semuanya mewajibkan nama proyek Compose dan database secara eksplisit (tanpa nilai bawaan), jadi tidak mungkin tanpa sengaja mengarah ke database `kompakapps` milik pemilik. Sebelum meng-upgrade database `kompakapps` setelah merge, jalankan backup lebih dulu.
