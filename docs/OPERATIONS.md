# Operasional KompakApps

Panduan menjalankan KompakApps dengan aman: backup terjadwal, pemulihan, pemantauan, upgrade modul, pemecahan masalah, rahasia yang harus dijaga, dan perkiraan kapasitas. Keputusan di baliknya ada di [DECISIONS.md](DECISIONS.md) (D32); cara pengembangan ada di [DEV_GUIDE.md](DEV_GUIDE.md); alur CI/CD dan penyiapan server ada di [CICD.md](CICD.md).

Semua angka di dokumen ini hasil pengukuran nyata pada stack uji (lihat bagian "Kapasitas" untuk spesifikasi mesin dan data). Angka itu bukan janji untuk server Anda; ulangi pengukuran di mesin tujuan dengan skrip yang sama.

## 1. Peta alat

| Berkas | Fungsi |
|---|---|
| `scripts/backup.sh` | Dump database (`pg_dump -Fc`) + arsip filestore + manifest (tanggal, versi modul, angka kunci, checksum SHA-256); rotasi; aman dijalankan terjadwal |
| `scripts/restore.sh` | Memulihkan backup ke database **baru**, lalu memverifikasi (tabel, modul, `kompakapps_base`, jurnal seimbang, lampiran terbaca); menolak menimpa database yang ada kecuali `--overwrite` |
| `scripts/check_backup_restore.sh` | Uji pulih otomatis: buat data, backup, ubah dan hapus, restore, cocokkan angka; keluar non-nol bila ada beda |
| `scripts/healthcheck.py` | Pemeriksaan Odoo, UI, JSON-2, ruang disk, umur backup; kode keluar 0/1/2 untuk cron atau monitor; opsi `--json` |
| `scripts/loadtest.py` | Uji beban baca dan tulis ringan dengan N pengguna paralel; throughput, p50/p95/p99, galat |
| `scripts/seed_loadtest.py` | Data besar (ribuan produk, ratusan faktur dan pesanan) untuk uji beban dan uji backup yang bermakna |
| `scripts/ops-lib.sh` | Fungsi bersama ketiga skrip shell (di-source, bukan dijalankan) |

Prinsip yang sama di semua skrip:

- **Tanpa nilai bawaan yang menunjuk database nyata.** `COMPOSE_PROJECT` dan `ODOO_DB` (atau nama database tujuan restore) wajib diisi; skrip berhenti dengan kode 2 bila kosong.
- **Tidak mencetak rahasia.** Perintah database dijalankan di dalam container `db` lewat socket lokal, jadi kata sandi database tidak pernah dipakai di skrip. API key dibaca dari variabel lingkungan `KOMPAKAPPS_API_KEY`, bukan dari argumen (argumen terlihat di daftar proses).
- **Kode keluar bermakna.** 0 berhasil; 1 gagal; 2 salah pemakaian. `healthcheck.py` memakai 0 sehat, 1 peringatan, 2 kritis, 3 galat internal.
- **Tidak ada penghapusan diam-diam.** Backup yang gagal tidak meninggalkan folder setengah jadi; rotasi hanya menghapus folder backup milik database itu sendiri; `restore.sh --overwrite` mengganti nama database lama (tidak menghapusnya).

## 2. Prasyarat dan parameter

- Docker dengan Compose v2, `bash` 3.2 atau lebih baru (macOS bawaan cukup), dan `python3` 3.8 atau lebih baru untuk `healthcheck.py` dan `loadtest.py`. Tanpa paket tambahan.
- Jalankan dari **folder berkas compose** (atau isi `COMPOSE_FILE`), karena skrip memanggil `docker compose -p <proyek> ...`.
- Di server, `scripts/` tidak ikut disalin oleh CD (CD hanya menyalin `docker-compose.prod.yml` dan `update.sh`). Salin sekali: `scp -r scripts kompakapps-deploy@<host>:/opt/kompakapps/`, atau clone repo ke server.

| Parameter | Argumen | Arti |
|---|---|---|
| `COMPOSE_PROJECT` | `-p` | Nama proyek Compose. Lihat `docker compose ls`; di server dengan folder `/opt/kompakapps` namanya `kompakapps` |
| `ODOO_DB` | `-d` | Nama database yang dibackup (harus sama dengan `ODOO_DB` di `.env`) |
| `BACKUP_DIR` | `-o` | Folder tujuan backup (bawaan `./backups`); beri alamat mutlak untuk cron |
| `KEEP` | `-k` | Simpan N backup terbaru milik database itu, hapus sisanya. Bawaan 0 = jangan hapus |
| `COMPOSE_ENV_FILE` | `--env-file` | Berkas `.env` untuk Compose bila bukan yang ada di folder saat ini |
| `COMPOSE_FILE` | `--compose-file` | Berkas compose (variabel standar Compose), mis. `docker-compose.prod.yml` |

Hal lain yang jarang diubah: `OPS_DB_USER` (bawaan `odoo`), `OPS_DB_SERVICE` (`db`), `OPS_ODOO_SERVICE` (`odoo`), `OPS_DATA_DIR` (`/var/lib/odoo`).

## 3. Backup

### 3.1 Yang dibackup dan yang tidak

Dibackup: database PostgreSQL (seluruh isi, termasuk pengguna, hak akses, dan pengaturan), dan **filestore** database itu (`/var/lib/odoo/filestore/<database>`: lampiran, logo, gambar produk). Keduanya harus diambil bersama, karena baris lampiran di database menunjuk ke berkas di filestore.

Tidak dibackup oleh skrip ini, dan harus dijaga terpisah: berkas `.env` (rahasia; simpan di pengelola kata sandi), kode (ada di git dan GHCR), sesi login (`/var/lib/odoo/sessions`, hilang saat pemulihan: pengguna login ulang), dan konfigurasi nginx/HTTPS di server.

### 3.2 Menjalankan

```bash
cd /opt/kompakapps
COMPOSE_PROJECT=kompakapps COMPOSE_FILE=docker-compose.prod.yml \
ODOO_DB=kompakapps BACKUP_DIR=/var/backups/kompakapps KEEP=14 ./scripts/backup.sh
```

Keluarannya (contoh nyata, database uji kecil):

```
2026-10-11 12:23:04 Backup 'kompakapps_ops' (proyek kompakapps-ops) -> .../backups/kompakapps_ops_20261011-122304
2026-10-11 12:23:04 Dump database (pg_dump -Fc)
2026-10-11 12:23:05 Arsip filestore
2026-10-11 12:23:06 Memeriksa keterbacaan dump dan arsip
2026-10-11 12:23:06 Backup selesai dalam 2 detik: ... (database 6.7 MB, filestore 953.6 KB berisi 451 berkas)
```

Hasilnya satu folder `<database>_<tanggal>-<jam>` (waktu lokal server) berisi:

| Berkas | Isi |
|---|---|
| `db.dump` | Dump format custom `pg_dump -Fc` |
| `filestore.tar.gz` | Arsip filestore, berakar pada nama database sumber |
| `manifest.json` | `created_at`, `created_epoch`, `compose_project`, `database`, locale dan versi PostgreSQL, `odoo_base_version`, `kompakapps_base_version`, ukuran dan SHA-256 tiap berkas, jumlah berkas filestore, **angka kunci** (`stat_*`: tabel, modul terpasang, jurnal, saldo aset/kewajiban/ekuitas/laba rugi, checksum neraca saldo, lampiran, mitra, produk, pesanan), dan daftar semua modul terpasang beserta versinya |
| `SHA256SUMS` | Checksum dalam format `sha256sum -c` (`cd <folder> && sha256sum -c SHA256SUMS`; di macOS `shasum -a 256 -c SHA256SUMS`) |

Semua berkas berizin 600 (backup memuat data sensitif). Urutan kerjanya: baca angka kunci, dump database, arsipkan filestore, uji baca dump (`pg_restore -l`) dan arsip (`tar -t`), hitung checksum, tulis manifest, baru pindahkan dari folder `.partial` ke nama akhir. Bila ada langkah yang gagal, skrip keluar non-nol dan folder setengah jadi dihapus; backup lama tidak tersentuh. Backup boleh diambil saat Odoo menyala: `pg_dump` memakai snapshot yang konsisten, dan database diambil **sebelum** filestore, sehingga berkas yang muncul di antaranya hanya menjadi yatim (dibersihkan Odoo), bukan lampiran tanpa berkas.

Satu backup per database pada satu waktu (kunci `.<database>.lock` di `BACKUP_DIR`; kunci basi dari proses yang sudah mati dibersihkan otomatis).

### 3.3 Terjadwal

**Cron di server Linux** (`/etc/cron.d/kompakapps-backup`, setiap hari pukul 02:00; stdout masuk log, stderr dikirim cron lewat email bila `MAILTO` diisi, jadi email hanya datang saat ada masalah):

```cron
MAILTO=admin@contoh.co.id
0 2 * * * kompakapps-deploy cd /opt/kompakapps && COMPOSE_PROJECT=kompakapps COMPOSE_FILE=docker-compose.prod.yml ODOO_DB=kompakapps BACKUP_DIR=/var/backups/kompakapps KEEP=14 ./scripts/backup.sh >> /var/log/kompakapps-backup.log 2>&1
```

Cron memakai PATH minimal; bila `docker` tidak ditemukan, tambahkan baris `PATH=/usr/local/bin:/usr/bin:/bin` di atasnya. Pantau hasilnya dengan `healthcheck.py --backup-dir` (bagian 5), karena cron yang tidak jalan sama sekali tidak mengirim email apa pun.

**launchd di macOS** (`~/Library/LaunchAgents/id.kompakapps.backup.plist`, setiap hari pukul 02:00; muat dengan `launchctl load ~/Library/LaunchAgents/id.kompakapps.backup.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>id.kompakapps.backup</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-c</string>
    <string>cd /Users/admin/kompakapps &amp;&amp; ./scripts/backup.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:/usr/bin:/bin</string>
    <key>COMPOSE_PROJECT</key><string>kompakapps</string>
    <key>ODOO_DB</key><string>kompakapps</string>
    <key>BACKUP_DIR</key><string>/Users/admin/kompakapps-backups</string>
    <key>KEEP</key><string>14</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>2</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>/Users/admin/kompakapps-backups/backup.log</string>
  <key>StandardErrorPath</key><string>/Users/admin/kompakapps-backups/backup.err</string>
</dict>
</plist>
```

Periksa sintaksnya dengan `plutil -lint`. Mac yang tidur tidak menjalankan jadwal; di mesin yang tidak selalu menyala, andalkan `healthcheck.py` untuk mendeteksi backup yang terlewat.

### 3.4 Retensi dan salinan di luar server

`KEEP=14` menyimpan 14 backup terbaru (dua pekan bila harian). Untuk retensi bertingkat (harian 14, bulanan 12) pakai dua jadwal dengan `BACKUP_DIR` berbeda:

```cron
0 2 * * *  kompakapps-deploy cd /opt/kompakapps && ... BACKUP_DIR=/var/backups/kompakapps/harian  KEEP=14 ./scripts/backup.sh >> /var/log/kompakapps-backup.log 2>&1
30 2 1 * * kompakapps-deploy cd /opt/kompakapps && ... BACKUP_DIR=/var/backups/kompakapps/bulanan KEEP=12 ./scripts/backup.sh >> /var/log/kompakapps-backup.log 2>&1
```

Backup di disk yang sama dengan database **bukan** backup: disk rusak menghilangkan keduanya. Salin ke tempat lain secara rutin, terenkripsi. Contoh (sesuaikan; tidak diuji di repo ini):

```bash
# enkripsi dengan age (kunci publik penerima), lalu kirim
tar -C /var/backups/kompakapps/harian -cf - "$(ls -1 /var/backups/kompakapps/harian | grep '^kompakapps_' | tail -1)" \
  | age -r <kunci-publik-age> > /tmp/kompakapps-latest.tar.age
rclone copy /tmp/kompakapps-latest.tar.age remote:kompakapps-backup/ && rm -f /tmp/kompakapps-latest.tar.age
```

Simpan kunci dekripsi terpisah dari backupnya, dan **uji pulih dari salinan luar** secara berkala (bagian 4.4), karena backup yang tidak pernah dipulihkan belum terbukti.

## 4. Pemulihan

### 4.1 Prinsip

`restore.sh` memulihkan ke database **baru**. Ia memeriksa checksum backup lebih dulu (backup rusak ditolak sebelum menyentuh apa pun), membuat database dengan encoding dan locale yang sama dengan sumber, menjalankan `pg_restore --single-transaction --exit-on-error` (semua atau tidak sama sekali), memulihkan filestore ke `/var/lib/odoo/filestore/<database-baru>`, lalu memverifikasi:

| Pemeriksaan | Keputusan |
|---|---|
| Jumlah tabel dan modul terpasang sama dengan manifest | gagal bila beda |
| `kompakapps_base` berstatus `installed` dengan versi yang sama; versi `base` sama | gagal bila beda |
| Jurnal terposting seimbang (jumlah debit dikurangi kredit nol) | gagal bila tidak |
| Jumlah berkas filestore sama dengan manifest | gagal bila beda |
| Sampel lampiran terbaru (`VERIFY_SAMPLE`, bawaan 500): berkas ada **dan** sha1 isinya sama dengan kolom `checksum` | gagal bila ada yang hilang atau berbeda |
| Angka kunci data (jurnal, saldo, lampiran, mitra, produk, pesanan) sama dengan manifest | catatan bila beda; gagal dengan `--strict` |

Angka kunci di manifest dibaca sesaat sebelum dump. Pada database yang sedang dipakai, selisih kecil wajar, itu sebabnya hanya catatan. Pada database yang tenang (mis. uji pulih), semuanya harus identik.

Database yang sudah ada **tidak ditimpa**. Dengan `--overwrite`, database lama diganti nama menjadi `<nama>_replaced_<waktu>` (filestore-nya juga), bukan dihapus, dan skrip menolak jalan bila masih ada koneksi aktif ke database itu (hentikan Odoo dulu). Bila pemulihan gagal di tengah, database baru yang setengah jadi dibersihkan; database lama (jika diganti nama) tetap utuh dan lokasinya dilaporkan. `--verify-only` hanya memverifikasi database yang sudah ada terhadap sebuah backup.

### 4.2 Memulihkan ke database baru (melihat data lama, atau uji)

```bash
cd /opt/kompakapps
COMPOSE_PROJECT=kompakapps COMPOSE_FILE=docker-compose.prod.yml \
  ./scripts/restore.sh /var/backups/kompakapps/harian/kompakapps_20261011-020000 kompakapps_pulih
```

Keluaran verifikasi (nyata, dari uji pulih):

```
  ok      jumlah tabel 689
  ok      modul terpasang 109
  ok      kompakapps_base: installed 19.0.1.0.0
  ok      versi base 19.0.1.3
  ok      jurnal terposting seimbang (selisih debit-kredit 0.00)
  ok      berkas filestore 455
  ok      lampiran terbaca: 500 diperiksa (berkas ada dan sha1 cocok)
  ok      angka kunci data (jurnal, saldo, lampiran, dan lain-lain) sama dengan manifest
```

Database ini tidak dilayani Odoo produksi (filter database `^kompakapps$` mengabaikannya), jadi aman dari pengguna. Untuk memeriksa isinya pakai `psql` (`docker compose exec db psql -U odoo -d kompakapps_pulih`) atau `odoo shell`. Bila perlu menjalankan Odoo di atas salinan itu (bukan produksi), **netralkan dulu** supaya tidak mengirim email atau menjalankan cron yang menyentuh dunia luar: `docker compose run --rm -T --no-deps odoo odoo neutralize -d kompakapps_pulih`. Hapus bila sudah tidak dipakai:

```bash
docker compose exec -T db dropdb -U odoo kompakapps_pulih
docker compose exec -T odoo rm -rf /var/lib/odoo/filestore/kompakapps_pulih
```

### 4.3 Pemulihan bencana: mengganti database produksi dengan backup

Pakai ini bila database produksi rusak atau salah diubah dan harus kembali ke keadaan backup. Data setelah backup **hilang**, jadi putuskan titik pemulihan dengan sadar.

1. Umumkan henti layanan, lalu hentikan Odoo: `docker compose -p kompakapps stop odoo` (nginx boleh tetap hidup).
2. Amankan keadaan sekarang, bagaimanapun rusaknya: `./scripts/backup.sh` (bila `db` masih hidup). Ini bisa membantu forensik atau mengambil data yang masih utuh.
3. Pulihkan dengan nama yang sama: `COMPOSE_PROJECT=kompakapps COMPOSE_FILE=docker-compose.prod.yml ./scripts/restore.sh <folder-backup> kompakapps --overwrite`. Database lama menjadi `kompakapps_replaced_<waktu>`.
4. Nyalakan: `docker compose -p kompakapps up -d odoo`, lalu `python3 -I scripts/healthcheck.py --odoo-url http://127.0.0.1:8069 --ui-url ...`, dan cek login serta satu dokumen di UI.
5. Bila image sekarang lebih baru daripada yang membuat backup (bandingkan `kompakapps_base_version` di `manifest.json` dengan versi kode), jalankan `-u kompakapps_base` sesuai bagian 6 **sebelum** membuka layanan ke pengguna.
6. Setelah yakin (mis. seminggu), hapus database dan filestore `_replaced_` dengan perintah `dropdb` dan `rm -rf` seperti di atas.

**Server baru yang kosong:** pasang Docker, siapkan `.env` (dari pengelola kata sandi) dan `docker-compose.prod.yml`, `docker compose up -d db`, tunggu sehat, jalankan `restore.sh <folder-backup> <ODOO_DB>` (nama sama dengan `.env`; belum ada, jadi tanpa `--overwrite`), lalu `docker compose up -d`. Tidak perlu `-i kompakapps_base`: modul sudah terpasang di dalam dump. Versi PostgreSQL di server baru harus **sama atau lebih baru** daripada yang membuat dump (tertulis di `manifest.json`).

**Hasil latihan nyata** (stack uji, database 105 MB berisi 1.227 jurnal terposting, 606 Sales Order, 610 Purchase Order, 2.012 produk, 535 lampiran): 300 mitra sengaja diganti namanya dan 5 lampiran dihapus lewat SQL, lalu `stop odoo`, `restore.sh --overwrite` dari backup, `up -d odoo`. Verifikasi lulus semua; mitra kembali 300 utuh, database rusak tersimpan sebagai `..._replaced_...`. Waktu: backup 3 detik, restore 9 sampai 12 detik, **henti layanan total 17 detik** (stop 2, restore 12, start sampai sehat 3). Database yang jauh lebih besar akan lebih lama; ukur di data Anda.

### 4.4 Uji pulih otomatis dan berkala

`scripts/check_backup_restore.sh` menjalankan seluruh siklus pada database **uji** (ia menulis dan mengubah data):

```bash
COMPOSE_PROJECT=kompakapps-ops COMPOSE_ENV_FILE=<stack.env> ODOO_DB=kompakapps_ops scripts/check_backup_restore.sh --yes
```

Langkahnya: buat data uji lewat `odoo shell` (dua faktur pelanggan dan satu tagihan vendor terposting, lampiran acak 64 KB, logo gambar acak pada mitra uji); baca angka kunci; backup; **ubah dan hapus** (hapus lampiran dan berkasnya dari filestore sumber, ganti nama mitra, posting faktur baru); restore ke `<database>_restore`; cocokkan tiap angka kunci dengan keadaan saat backup (jurnal, saldo aset/kewajiban/ekuitas/laba rugi, checksum neraca saldo, lampiran, berkas filestore); cocokkan isi lampiran uji (sha256 dari filestore hasil pemulihan sama dengan aslinya); uji perlindungan (menolak menimpa, menolak backup rusak, verifikasi mendeteksi berkas lampiran yang hilang, `--overwrite` mengganti nama dan tidak menghapus); uji rotasi `KEEP=2`. Keluar 0 hanya bila semua cocok. Database hasil pemulihan dan folder kerja dibersihkan di akhir (`--keep` untuk menyimpannya).

Hasil nyata terakhir: 43 pemeriksaan cocok, 0 berbeda, kode keluar 0, siklus penuh sekitar satu menit pada database uji yang sama (dijalankan ulang setelah tiap perubahan skrip). Dua baris `GAGAL` yang tampil di tengah keluarannya adalah uji negatif (verifikasi memang harus gagal saat berkas lampiran dihapus) dan dihitung sebagai `ok`.

Untuk database nyata, uji pulih berkala dilakukan dengan `restore.sh` ke nama sementara dari **backup terbaru yang disalin di luar server**, lalu hapus. Jadwal yang disarankan: sebulan sekali, dan setiap sebelum upgrade besar.

## 5. Pemantauan

```bash
python3 -I scripts/healthcheck.py \
  --odoo-url http://127.0.0.1:8069 --ui-url http://127.0.0.1:8080 \
  --db kompakapps --backup-dir /var/backups/kompakapps/harian
```

Keluaran (nyata, pada stack uji):

```
KompakApps health check 2026-10-11T16:56:47+07:00 (host)
  OK         odoo    sehat, versi 19.0-20260926, koneksi database baik, 464 ms
  OK         ui      nginx hidup (99 ms); proxy JSON-2 sampai ke Odoo (122 ms)
  OK         json2   JSON-2 menjawab dengan API key, kompakapps_base 19.0.1.0.0 terpasang, 212 ms
  PERINGATAN disk    /: 17% kosong (41.5 dari 245.1 GB) (batas 10% kritis, 20% peringatan)
  OK         backup  terakhir 5 jam lalu (kompakapps_ops_20261011-122304, 8.0 MB), 1 backup tersimpan
Ringkasan: PERINGATAN (4 sehat, 1 peringatan, 0 kritis, 0 dilewati); kode keluar 1
```

| Pemeriksaan | Sehat | Peringatan | Kritis |
|---|---|---|---|
| Odoo | `/web/health?db_server_status=1` HTTP 200 `pass`, respons di bawah 1000 ms | respons 1000 ms atau lebih | tidak terjangkau, `fail`, atau respons 5000 ms atau lebih |
| UI | `/` HTTP 200, dan `POST /json/2/...` tanpa kunci dijawab 401 (bukti nginx sampai ke Odoo) | proxy menjawab selain 401/403/5xx | nginx mati, atau 502/503/504 (Odoo tidak terjangkau lewat proxy) |
| JSON-2 | API key diterima dan `kompakapps_base` berstatus `installed` | API key dikirim lewat HTTP polos ke host non-loopback | kunci ditolak (401), `kompakapps_base` tidak terpasang, atau tidak terjangkau |
| Disk | ruang kosong 20% atau lebih | di bawah 20% | di bawah 10% |
| Backup | backup valid terakhir berumur kurang dari 26 jam, ukuran berkas cocok manifest | 26 jam atau lebih | 50 jam atau lebih, tidak ada backup valid, atau berkas rusak |

Semua ambang bisa diubah dengan argumen (`--warn-ms`, `--disk-warn-pct`, `--backup-warn-hours`, dan lain-lain; lihat `--help`). Pemeriksaan JSON-2 aktif bila `KOMPAKAPPS_API_KEY` diisi; pakai **API key khusus** milik pengguna dengan hak baca saja dan masa berlaku yang jelas. Pemeriksaan yang tidak dikonfigurasi dilewati, bukan gagal.

Kode keluar: 0 semua sehat, 1 ada peringatan, 2 ada yang kritis, 3 galat internal skrip. `--json` mencetak objek tunggal (`status`, `exit_code`, `summary`, dan daftar `checks`) untuk dikirim ke monitor; `--quiet` tidak mencetak apa pun bila semuanya sehat.

**Cron setiap 5 menit, email hanya saat tidak sehat** (cron mengirim email dari keluaran; `--quiet` membuat keluaran hanya muncul saat ada masalah):

```cron
MAILTO=admin@contoh.co.id
*/5 * * * * kompakapps-deploy KOMPAKAPPS_API_KEY=$(cat /etc/kompakapps/monitor.key) /usr/bin/python3 -I /opt/kompakapps/scripts/healthcheck.py --quiet --ui-url http://127.0.0.1:8080 --db kompakapps --backup-dir /var/backups/kompakapps/harian
```

Berkas `/etc/kompakapps/monitor.key` berizin 600 milik `kompakapps-deploy`. Untuk Nagios atau Icinga, `healthcheck.py` bisa dipakai langsung sebagai perintah cek (kode keluar sesuai konvensi). Untuk Uptime Kuma atau sejenisnya, pantau juga `https://<domain>/web/health` dari **luar** server agar masalah DNS, sertifikat, atau firewall terlihat; skrip ini hanya melihat dari dalam.

Pemeriksaan manual yang berguna:

```bash
docker compose -p kompakapps ps                                   # semua layanan Up/healthy?
docker compose -p kompakapps logs --since 1h odoo | grep -E " (ERROR|CRITICAL) "
docker stats --no-stream                                      # memori dan CPU per container
docker compose -p kompakapps exec -T db psql -U odoo -d kompakapps -c "SELECT pg_size_pretty(pg_database_size('kompakapps'))"
docker compose -p kompakapps exec -T db psql -U odoo -d postgres -c "SELECT datname, count(*) FROM pg_stat_activity GROUP BY 1"
```

## 6. Upgrade modul dengan aman

Kode dan skema berjalan beriringan: `-u kompakapps_base` mengubah skema database, sehingga **mengembalikan image saja tidak cukup** bila upgrade sudah jalan. Karena itu urutannya selalu backup dulu.

1. Pastikan CI hijau untuk commit yang akan dipasang, dan baca ringkasan PR (apa yang berubah di model atau data).
2. **Backup**: `./scripts/backup.sh` (catat nama folder hasilnya). Untuk upgrade besar, lakukan juga `restore.sh` ke nama sementara dari backup itu untuk membuktikan backup-nya bisa dipulihkan, lalu hapus.
3. **Hentikan Odoo**: `docker compose -p kompakapps stop odoo`. Odoo yang masih menyala memuat registri bersamaan dengan proses upgrade; dua proses itu bisa saling bentrok (`could not serialize access due to concurrent update`) dan meninggalkan database setengah ter-upgrade. `deploy/update.sh` belum melakukan langkah 2 dan 3 (lihat "Batasan").
4. **Upgrade**: ganti `IMAGE_TAG` ke versi baru (`docker compose pull odoo`), lalu `docker compose -p kompakapps run --rm -T odoo odoo -d kompakapps -u kompakapps_base --stop-after-init > upgrade.log 2>&1`. Periksa `grep -E " (ERROR|CRITICAL) " upgrade.log` (harus kosong) dan kode keluar 0. Pada uji di repo ini, `-u kompakapps_base` pada database uji berjalan 6 detik tanpa galat.
5. **Nyalakan dan periksa**: `docker compose -p kompakapps up -d`, lalu `healthcheck.py`, login ke UI, buka satu daftar dan satu dokumen. Pada staging, jalankan juga `scripts/check_p2p_api.py --yes` (skrip itu menulis data, jangan di produksi).
6. **Rollback** bila langkah 4 atau 5 gagal: hentikan Odoo; kembalikan `IMAGE_TAG` ke `.last_good`; pulihkan database dari backup langkah 2 dengan `restore.sh <folder> kompakapps --overwrite`; nyalakan Odoo; periksa. Data yang masuk setelah backup hilang, jadi lakukan upgrade di jam sepi dan, bila pengguna sudah sempat bekerja di versi baru, pertimbangkan memperbaiki-ke-depan alih-alih rollback.

Pindah versi mayor Odoo (mis. 19 ke 20) bukan prosedur ini: butuh migrasi data (lihat D4) dan harus dilatih di salinan hasil restore lebih dulu.

## 7. Pemecahan masalah

| Gejala | Penyebab biasa | Tindakan |
|---|---|---|
| `backup.sh`: "layanan db ... tidak berjalan" atau gagal menjalankan `docker compose` | `COMPOSE_PROJECT` salah, atau dijalankan dari folder tanpa berkas compose | `docker compose ls` untuk nama proyek; `cd` ke folder compose atau isi `COMPOSE_FILE` |
| "bukan database KompakApps (kompakapps_base tidak terpasang)" | `ODOO_DB` salah, atau database belum diinisialisasi | `docker compose exec db psql -U odoo -l`; cocokkan dengan `.env` |
| "backup lain ... sedang berjalan (pid N)" | Backup sebelumnya belum selesai (database besar) | Tunggu; bila prosesnya sudah mati kunci basi dibersihkan otomatis |
| Cron tidak menjalankan apa-apa, atau "docker: command not found" | PATH cron minimal | Isi `PATH=` di crontab; cek `/var/log/kompakapps-backup.log`; `healthcheck.py` akan melaporkan umur backup |
| Disk penuh saat backup | `BACKUP_DIR` di disk yang sama dengan Docker | Backup gagal dan dibersihkan sendiri; kecilkan `KEEP`, pindahkan ke disk lain, `docker system df` lalu `docker builder prune` |
| `restore.sh`: "checksum ... TIDAK cocok" | Salinan rusak atau terpotong (transfer terputus) | Salin ulang dari sumber; verifikasi `sha256sum -c SHA256SUMS`; pakai backup sebelumnya |
| `restore.sh`: "database ... sudah ada" | Nama tujuan terpakai | Pilih nama lain; atau `--overwrite` (yang lama diganti nama) |
| `restore.sh`: "masih dipakai N koneksi" | Odoo atau klien lain tersambung | `docker compose stop odoo`, periksa `pg_stat_activity`, ulangi |
| `pg_restore` galat soal versi arsip | PostgreSQL tujuan lebih lama daripada yang membuat dump | Pakai PostgreSQL yang sama atau lebih baru (lihat `postgres_version` di manifest) |
| Verifikasi: "lampiran bermasalah: berkas hilang" | Filestore tidak selaras dengan database (mis. salinan filestore lama dicampur dengan dump baru) | Pakai pasangan `db.dump` dan `filestore.tar.gz` dari folder backup yang sama; bila backup sumber memang sudah punya lampiran tanpa berkas, itu masalah di sumber |
| Odoo tidak mau start setelah pemulihan | `ODOO_DB` di `.env` atau `--db-filter` tidak cocok dengan nama database | Samakan nama; lihat `docker compose logs odoo` |
| Inisialisasi database gagal dengan `could not serialize access due to concurrent update` | Layanan `odoo` menyala saat `-i` atau `-u` dijalankan | `stop odoo`, hapus database setengah jadi (`dropdb`), ulangi: `up -d db`, `-i kompakapps_base`, baru `up -d odoo ui` |
| `healthcheck.py`: Odoo KRITIS "tidak terjangkau" | Container mati, port salah | `docker compose ps`, `logs odoo`; cocokkan `--odoo-url` dengan port yang dipublikasikan |
| `healthcheck.py`: UI KRITIS "502" | nginx hidup tetapi Odoo mati atau masih start | Tunggu start (puluhan detik) atau lihat log Odoo |
| JSON-2 401 | API key kedaluwarsa, dicabut, atau salah ketik | Buat key baru (Preferences, Account Security, New API Key); simpan di berkas 600 |
| `loadtest.py`: banyak `HTTP 500` atau `timeout` | Beban melebihi kapasitas, memori habis, atau worker kurang | Turunkan `--users`; lihat `docker stats` dan log Odoo; naikkan `ODOO_WORKERS` dan memori (bagian 9) |

## 8. Rahasia yang harus dijaga

Aturan umum: jangan di-commit, jangan dicetak ke log atau obrolan, berizin berkas 600, dan batasi siapa yang bisa membacanya. Skrip di repo ini sengaja tidak menerima rahasia lewat argumen.

| Rahasia | Di mana | Catatan penanganan |
|---|---|---|
| `DB_PASSWORD` (kata sandi PostgreSQL) | `.env` di server (`/opt/kompakapps/.env`) | Variabel `POSTGRES_PASSWORD` hanya berlaku saat volume database pertama dibuat. Mengganti kemudian butuh `ALTER USER odoo PASSWORD '...'` di PostgreSQL **dan** mengubah `.env`, lalu restart `odoo` |
| `ADMIN_PASSWD` (kata sandi master Odoo) | `.env`; disuntikkan ke `odoo.conf` sementara di dalam container saat start | Melindungi operasi database manager lewat XML-RPC; ganti lewat `.env` dan restart |
| Kata sandi login pengguna, **terutama `admin`/`admin` bawaan** | Database | Ganti sebelum server bisa diakses dari internet (lihat CICD.md) |
| API key pengguna | Dibuat per pengguna di Odoo; UI menyimpannya di `sessionStorage` tab; skrip membacanya dari `KOMPAKAPPS_API_KEY` | Pakai key terpisah dan berumur pendek untuk uji, key hak-baca untuk pemantauan, dan jangan pernah menempelkannya di berkas JavaScript atau URL. Cabut di Odoo bila bocor |
| `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`, `DEPLOY_HOST`, `DEPLOY_USER` | Secrets environment `staging` di GitHub | Kunci SSH khusus CI; anggota grup `docker` setara root di server |
| Token GHCR (`read:packages`) | `docker login ghcr.io` di server | Token lama GitHub yang belum dicabut masih menunggu pemilik (lihat ROADMAP) |
| **Berkas backup** | `BACKUP_DIR` dan salinan luar | Berisi seluruh data bisnis, hash kata sandi pengguna, dan kredensial yang tersimpan di database (mis. SMTP di `ir_mail_server`). Perlakukan sebagai rahasia: izin 600, disk terenkripsi atau enkripsi sebelum keluar server, akses dibatasi |
| Kunci enkripsi backup (bila dipakai) | Pengelola kata sandi | Simpan terpisah dari backupnya; tanpa kunci ini backup luar tidak bisa dipulihkan |
| Berkas `.env` itu sendiri | Server, dan satu salinan di pengelola kata sandi | Tidak ikut di backup; tanpa salinan ini server baru tidak bisa dinyalakan dengan kata sandi yang sama |

## 9. Kapasitas (hasil uji beban)

**Cara mengukur.** `scripts/seed_loadtest.py` mengisi database uji; `scripts/loadtest.py` dijalankan dari mesin yang sama lewat UI nginx (`http://127.0.0.1:8480`, jalur yang dipakai UI), satu akun admin, 20 detik per titik (+3 detik pemanasan), `--think 0` (pengguna menembak terus tanpa jeda) kecuali baris terakhir. Skenario baca: daftar produk (80 baris), daftar Sales Order dan Purchase Order (50 baris), laporan grup Purchase Report per bulan, dan buku besar per akun. Skenario campuran: 10% putaran adalah membuat lalu membatalkan draf PO atau SO.

**Mesin dan data.** MacBook Air Apple M2, 8 inti, RAM 8 GB, macOS 15.1; Docker Desktop dengan VM 8 CPU dan 3,8 GiB; Odoo 19.0-20260926, PostgreSQL 16 tanpa penyetelan; tiga stack Docker lain menyala tetapi menganggur. **Generator beban berbagi CPU dengan server**, jadi angkanya bersifat konservatif dibanding server khusus. Data: database 105 MB, 8.515 baris jurnal, 1.227 jurnal terposting, 606 Sales Order, 610 Purchase Order, 2.012 produk, 890 pergerakan stok. Ini ukuran usaha kecil sampai menengah; laporan MIS Builder, ekspor besar, dan render halaman di browser **tidak** diukur.

**Hasil, permintaan per detik (req/s) dan latensi total dalam ms. Galat 0 di semua titik.**

| Beban | Threaded (compose dev, `workers=0`) req/s, p95, p99 | `--workers=2` (bawaan `deploy/docker-compose.prod.yml`) | `--workers=4` |
|---|---|---|---|
| 1 pengguna | 70,8; 24; 43 | 83,9; 18; 40 | 25,6; 113; 159 (setelah restart, cache dingin) |
| 5 pengguna | 94,4; 121; 258 | 117,0; 99; 176 | 66,0; 183; 705 |
| 10 pengguna | 87,0; 226; 361 | 76,8; 360; 527 (ulang: 102,5; 180; 283) | 101,3; 198; 328 |
| 20 pengguna | 106,4; 365; 484 | 78,0; 484; 2.372 (ulang: 89,2; 386; 651) | 116,7; 338; 457 |
| 40 pengguna | 104,3; 873; 1.026 | 72,8; 1.146; 4.408 (maks 19,7 detik pada satu lonjakan) | 155,2; 386; 1.256 |
| Campuran 10 pengguna | 100,6; 257; 405 | 55,1; 475; 1.390 | 125,8; 165; 255 |
| Campuran 20 pengguna | 95,3; 435; 676 | 68,5; 637; 1.227 | 130,0; 253; 429 |
| 40 pengguna, jeda 1 detik | 39,4; 59; 133 | 38,7; 144; 259 | 39,1; 54; 103 |

Latensi per operasi (threaded, 1 pengguna, p50): daftar PO 8 ms, daftar SO 8 ms, daftar produk 13 ms, laporan buku besar 15 ms, laporan PO bulanan 14 ms. Operasi tulis (threaded, 10 pengguna, campuran, p50): buat PO 219 ms, batal PO 122 ms, buat SO 254 ms, batal SO 108 ms.

**Bacaan hasil.**

- Satu proses Odoo threaded dan dua worker sama-sama jenuh di sekitar **100 req/s** pada mesin ini; dua worker tidak lebih baik dan menunjukkan lonjakan latensi sesekali (tail p99 sampai beberapa detik, satu lonjakan 19,7 detik yang tidak terulang pada pengukuran ulang). Empat worker mencapai **sekitar 155 req/s** dengan p95 di bawah 400 ms pada 40 pengguna tanpa jeda dan tulis campuran. Titik pertama pada 4 worker (25,6 req/s) adalah pengukuran pertama setelah restart (cache dingin); jangan dibaca sebagai kapasitas.
- Biaya tetap tiap permintaan JSON-2 mencakup verifikasi API key (PBKDF2): **3,9 ms CPU** per permintaan, diukur langsung (rata-rata 200 pemanggilan di `odoo shell`), sekitar sepertiga dari waktu permintaan ringan. UI yang memanggil banyak permintaan kecil per halaman dengan satu key akan terkena biaya ini setiap kali.
- Beban yang menyerupai pengguna nyata (40 pengguna, tiap orang satu permintaan per detik) menghasilkan 39 req/s dengan p95 54 sampai 144 ms di semua konfigurasi: jauh di bawah titik jenuh.
- Penulisan (buat atau batalkan dokumen) puluhan kali lebih lambat daripada membaca daftar (p50 100 sampai 250 ms lawan 8 sampai 15 ms), karena pelacakan pesan, urutan nomor, dan hitung ulang total.

**Perkiraan kapasitas (kasar, hanya dari data di atas).** Anggaplah satu pengguna aktif menghasilkan kira-kira satu permintaan per detik saat bekerja. Satu instansi Odoo dengan 4 worker pada mesin 8 inti menahan 40 pengguna seperti itu dengan p95 di bawah 150 ms, dan titik jenuhnya di kisaran 100 sampai 150 pengguna aktif serentak. Karena laporan berat, dokumen besar, dan proses latar tidak diukur, rencanakan **sekitar separuhnya (50 sampai 70 pengguna aktif serentak per instansi 4 worker)** dan ukur ulang di server tujuan sebelum menjanjikan angka.

**Sizing yang disarankan** (aturan praktis dari panduan Odoo, yang cocok dengan hasil di atas): `ODOO_WORKERS` sekitar jumlah inti dikali 2 ditambah 1 pada mesin khusus, tetapi jangan melebihi memori (tiap worker memakai 130 sampai 200 MB saat menganggur pada ukuran data ini; pada uji dengan 2 worker di bawah beban, container odoo memakai sekitar 440 MB), sisakan RAM untuk PostgreSQL (naikkan `shared_buffers` dari bawaan 128 MB, sekitar 25% RAM), dan simpan database di SSD. Server staging minimum di CICD.md (2 vCPU, 4 GB) cocok untuk belasan pengguna; untuk puluhan pengguna mulailah dari 4 vCPU, 8 GB dengan `ODOO_WORKERS=4`. `ODOO_WORKERS` di `.env` server dibaca oleh `deploy/docker-compose.prod.yml` (bawaan 2).

**Pertumbuhan disk.** Dump database 7,7 MB dan filestore 1 MB untuk database 105 MB (kebanyakan berisi data dasar Odoo dan indeks); penambahan 1.227 jurnal, 1.216 pesanan, dan 2.000 produk menambah dump kurang dari 1 MB terkompresi. Rencanakan ruang backup sebesar `KEEP` kali ukuran backup terbaru ditambah salinan di luar server, dan pantau dengan `healthcheck.py`.

**Keterbatasan pengukuran.** Satu akun, satu mesin yang dibagi dengan generator beban, data yang masih kecil, tanpa render browser, dan hanya dua sampai tiga pengulangan per titik: variasi antar-ulangan terlihat jelas pada konfigurasi 2 worker. Ulangi `loadtest.py` di server tujuan (mis. `--users 10 --duration 30`, lalu 20 dan 40) dan jadikan hasilnya pegangan.

## 10. Daftar periksa rutin

| Kapan | Apa |
|---|---|
| Harian (otomatis) | Backup 02:00; `healthcheck.py --quiet` tiap 5 menit; email/alarm hanya bila tidak sehat |
| Mingguan | Lihat `/var/log/kompakapps-backup.log`, ukuran backup yang wajar, ruang disk; periksa salinan luar benar-benar terbaru |
| Bulanan | Pulihkan backup **dari salinan luar** ke nama sementara dengan `restore.sh` dan baca hasil verifikasi; hapus database sementara |
| Kuartalan | Jalankan `check_backup_restore.sh` di stack uji dan `loadtest.py` ulang; cek kenaikan p95; tinjau `KEEP` dan kapasitas disk; putar API key pemantauan |
| Sebelum setiap upgrade | Backup, uji pulih cepat, baru bagian 6 |

## 11. Batasan dan sisa pekerjaan

- Backup berbasis dump penuh: titik pemulihan (RPO) sama dengan selang backup (hingga 24 jam bila harian). Pemulihan ke titik waktu tertentu (arsip WAL, pgBackRest, atau wal-g) belum ada.
- Skrip tidak mengenkripsi dan tidak mengirim backup ke luar server; contoh di bagian 3.4 harus disesuaikan dan diuji oleh operator.
- `deploy/update.sh` belum memanggil `backup.sh` dan tidak menghentikan Odoo sebelum `-u`. Sampai itu dilakukan (butuh menyalin `scripts/` ke server lewat CD), jalankan bagian 6 secara manual.
- `healthcheck.py` tidak mengirim notifikasi sendiri; ia mengandalkan cron/monitor yang memanggilnya. Ia tidak melihat dari luar server dan tidak memeriksa sertifikat HTTPS.
- Satu database per eksekusi skrip. Untuk banyak tenant (D7), panggil per database.
- Backup memuat satu perusahaan/database; sesi login dan konfigurasi nginx tidak termasuk.

## Migrasi dari nama lama (nusara) ke kompakapps

Instalasi yang dibuat sebelum 18 Okt 2026 memakai project compose `nusaraerp`, database `nusara`, dan modul `nusara_base`. Sejak D66 semuanya bernama `kompakapps`. Untuk memindahkan instalasi lokal yang ada tanpa kehilangan data:

```bash
git pull
bash scripts/migrate_to_kompakapps.sh
```

Skrip membuat backup di `./backups`, menghentikan stack lama, menyalin volume ke project `kompakapps`, mengganti nama database dan folder filestore, mengganti nama modul di database, meng-upgrade modul, lalu menyalakan stack baru. Kontainer dan volume `nusaraerp_*` tidak dihapus: bila ada masalah, kembalikan `.env` dari `.env.sebelum-kompakapps-*`, checkout komit sebelum D66, dan `docker start nusaraerp-db-1 nusaraerp-odoo-1 nusaraerp-ui-1`. Hapus volume lama (`docker volume rm nusaraerp_db-data nusaraerp_odoo-data`) hanya setelah yakin.
