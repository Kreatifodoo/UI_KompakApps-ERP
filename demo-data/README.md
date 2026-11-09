# Database demo KompakApps (sudah terisi)

Salinan database `kompakapps` lengkap dengan data contoh, supaya Odoo di Mac lain langsung memakai database yang sudah di-setup tanpa mengulang seed satu per satu.

| | |
|---|---|
| Dibuat | 2026-11-09 |
| Odoo / modul | Odoo 19.0 (base 19.0.1.3), `kompakapps_base` 19.0.1.17.0, 158 modul terpasang |
| Data | 9 perusahaan demo (PROLINE dan studi kasus COGM), 1.173 jurnal (1.169 terposting dan seimbang), 147 sales order, 62 purchase order, 109 produk, 161 mitra |
| Isi folder | `db.dump` (pg_dump format custom), `filestore.tar.gz` (468 lampiran: logo dan gambar), `manifest.json`, `SHA256SUMS`, `bersihkan.sql` |

Semua nama perusahaan berlabel "(Demo)" dan semua email memakai domain `*.example`. Ini bukan data nyata.

## Memakai di Mac lain

Butuh Docker Desktop (Settings → Resources, minimal 4 GB RAM) dan koneksi internet untuk build pertama.

```bash
git clone https://github.com/Kreatifodoo/UI_KompakApps-ERP.git
cd UI_KompakApps-ERP
cp .env.example .env
```

Isi `DB_PASSWORD` dan `ADMIN_PASSWD` di `.env` (nilai bebas, hanya berlaku di Mac itu). Lalu:

```bash
docker compose build
docker compose up -d db
COMPOSE_PROJECT=kompakapps scripts/restore.sh -b demo-data -t kompakapps --env-file .env
docker compose up -d
```

`restore.sh` memulihkan database dan filestore, lalu memverifikasinya terhadap `manifest.json` (jumlah tabel, modul, jurnal seimbang, checksum lampiran). Hasil yang benar berakhir dengan `0 kegagalan`. Nama database tujuan (`-t`) harus sama dengan `ODOO_DB` di `.env` (bawaan `kompakapps`). Bila database itu sudah ada, `restore.sh` menolak; pakai `--overwrite` untuk mengganti nama yang lama (tidak dihapus).

Buka http://localhost:8069 dan login `admin` / `admin`, lalu **segera ganti password** di menu profil. UI di http://localhost:8080 butuh API key milik Anda sendiri (Preferences → Account Security → New API Key).

Bila kode di repo lebih baru daripada salinan ini (lihat versi `kompakapps_base` di tabel atas), naikkan modulnya setelah pemulihan:

```bash
docker compose run --rm -T --no-deps odoo odoo -d kompakapps -u kompakapps_base --stop-after-init
docker compose restart odoo
```

Cek integritas berkas sebelum memulihkan: `cd demo-data && shasum -a 256 -c SHA256SUMS`.

## Yang sengaja tidak ada di salinan ini

Repo ini publik, jadi salinan ini dibersihkan dari rahasia sebelum diunggah:

- Kata sandi: hanya `admin` yang punya, dengan nilai `admin` (bawaan, sama seperti README utama). Pengguna lain tanpa kata sandi.
- Semua API key.
- `database.secret`, `database.uuid`, token IAP, dan token akses portal (sale order, purchase order, jurnal, POS).
- Riwayat perangkat, log masuk, antrean bus, dan pengenal sesi HTTP.
- Riwayat audit (`auditlog`) untuk field kata sandi, token, dan kunci.
- Bundel aset web (JS/CSS); Odoo membuatnya ulang otomatis saat pertama kali halaman dibuka.

## Memperbarui salinan ini

**Jangan** menyalin backup biasa (`scripts/backup.sh`) ke folder ini: backup biasa memuat hash kata sandi, API key, dan secret database, dan repo ini publik. Setelah terunggah, riwayat git tidak bisa ditarik kembali. Urutan yang dipakai untuk salinan ini:

1. Backup database sumber dengan `scripts/backup.sh`, lalu pulihkan ke database sementara dengan `scripts/restore.sh` (nama bebas, mis. `kompakapps_bersih`).
2. Setel kata sandi `admin` lewat Odoo shell pada database sementara itu: `env.cr.execute("update res_users set password=%s where id=2", (env['res.users']._crypt_context().hash('admin'),)); env.cr.commit()`.
3. Jalankan [bersihkan.sql](bersihkan.sql) pada database sementara itu.
4. Buat folder filestore yang hanya berisi berkas yang masih dirujuk `ir_attachment`, lalu `scripts/backup.sh` pada database sementara (ini menghasilkan `db.dump`, `filestore.tar.gz`, `manifest.json`, `SHA256SUMS`).
5. Sebelum commit, cari nilai rahasia asli (hash kata sandi, API key, secret, token) di teks dump bersih (`pg_restore -f -`), harus 0 kecocokan. Lalu uji pulihkan ke database baru, login, dan baca data.
6. Hapus database sementara beserta filestore-nya.

Setiap penggantian `db.dump` menambah sekitar 10 MB ke riwayat git, jadi perbarui seperlunya.
