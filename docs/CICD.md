# CI/CD KompakApps

## Alur

```
PR / push ke main ──► CI  (lint pre-commit + build image + test Odoo)
                       │ hijau, hanya untuk push ke main
                       ▼
                      CD  (build image ► push ke GHCR ► deploy staging bila diaktifkan)
```

- `.github/workflows/ci.yml`: berjalan di setiap pull request dan push ke `main`.
- `.github/workflows/cd.yml`: berjalan setelah CI hijau di `main`. Image dipush ke `ghcr.io/kreatifodoo/kompakapps` dengan tag SHA commit dan `latest`. Tahap deploy **nonaktif** sampai variabel `DEPLOY_STAGING` diisi `true`.
- Versi Odoo ada di dua tempat yang harus sama: `ODOO_VERSION` di kedua workflow dan `.env.example`. Saat pindah versi, ubah ketiganya dan `oca.lock` (SHA cabang yang baru).

## Modul OCA

Daftar repo OCA dan commit-nya ada di `oca.lock`. Memperbarui satu repo: ambil SHA terbaru cabang 19.0, ganti di `oca.lock`, buka pull request. CI akan membangun ulang dan menguji. Jika repo baru ditambahkan, tambahkan juga path-nya di `addons_path` pada `config/odoo.conf`. Repo yang dipakai saat ini: purchase-workflow, account-financial-tools, account-financial-reporting, mis-builder, account-budgeting, server-tools, account-reconcile, server-ux, reporting-engine, web, payroll.

Dependensi Python OCA **tidak** dipasang otomatis. Beberapa repo OCA mencantumkan paket berat atau terkunci versinya untuk modul yang tidak kita pakai (mis. `bokeh`, `sentry_sdk`). Jika sebuah modul yang kita pasang butuh paket tambahan, tambahkan hanya paket itu ke `docker/requirements.txt`.

## Pengaturan GitHub (sekali saja)

1. **Branch protection** untuk `main` (Settings → Branches): wajib pull request, wajib status check `lint` dan `test`.
2. **Package GHCR**: setelah push pertama, paket `kompakapps` bersifat privat. Server perlu login: `docker login ghcr.io` dengan token yang punya scope `read:packages`.

## Menyiapkan server staging

Pakai server khusus KompakApps (bukan server bersama yang menjalankan sistem lain). Odoo + PostgreSQL butuh minimal 2 vCPU / 4 GB RAM untuk staging.

1. Pasang Docker dan Docker Compose plugin, nginx, curl.
2. Buat user `kompakapps-deploy` dan masukkan ke grup `docker`. Catatan: anggota grup `docker` setara root di server itu, jadi jangan gunakan server bersama.
3. Buat folder `/opt/kompakapps` milik user tersebut, lalu salin `deploy/.env.example` menjadi `/opt/kompakapps/.env` dan isi nilainya.
4. Buat pasangan kunci SSH khusus CI (`ssh-keygen -t ed25519`), pasang kunci publiknya di `~kompakapps-deploy/.ssh/authorized_keys`.
5. Inisialisasi database sekali (belum bisa otomatis karena `update.sh` memakai `-u`):
   `docker compose -f docker-compose.prod.yml run --rm odoo odoo -d <ODOO_DB> -i kompakapps_base --without-demo=true --stop-after-init`
   Lalu terapkan setup Indonesia (negara, IDR, COA `l10n_id`, PPN). Hanya berjalan bila belum ada transaksi akuntansi:
   `echo "env['res.company'].browse(1).kompakapps_setup_indonesia(); env.cr.commit()" | docker compose -f docker-compose.prod.yml run --rm -T odoo odoo shell -d <ODOO_DB> --no-http`
   Database yang dibuat lewat perintah ini punya login bawaan `admin` / `admin`. **Ganti password itu sebelum server dapat diakses dari internet.** Selama belum ada nginx, port Odoo hanya terbuka ke `127.0.0.1`, jadi ganti password lewat SSH tunnel (`ssh -L 8069:127.0.0.1:8069 <user>@<host>`, lalu buka `http://localhost:8069`).
6. Pasang nginx sebagai reverse proxy dengan HTTPS: lalu lintas ke `127.0.0.1:8069`, dan path `/websocket` ke `127.0.0.1:8072`.

## Rahasia dan variabel di GitHub

Buat environment `staging` (Settings → Environments), lalu isi **secrets**:

| Nama | Isi |
|---|---|
| `DEPLOY_HOST` | alamat server staging |
| `DEPLOY_USER` | `kompakapps-deploy` |
| `DEPLOY_SSH_KEY` | kunci privat SSH khusus CI |
| `DEPLOY_KNOWN_HOSTS` | keluaran `ssh-keyscan <host>` (agar host terverifikasi) |

Lalu isi **variable** repo `DEPLOY_STAGING` = `true` untuk mengaktifkan deploy.

Untuk produksi nanti: environment `production` dengan "Required reviewers", agar rilis butuh persetujuan manual.

## Rollback

`update.sh` menyimpan tag terakhir yang sehat di `.last_good`. Jika health check (`/web/health`) gagal setelah update, image dikembalikan ke tag itu secara otomatis. Perhatian: yang dikembalikan hanya image aplikasi. Jika update modul sudah mengubah skema database, pemulihan database harus dari backup.

## Yang belum teruji

Kerangka ini ditulis tanpa Docker di mesin pengembangan, jadi belum pernah dijalankan end-to-end. Pengujian pertamanya adalah CI di pull request pertama. Yang sudah diuji secara lokal: `scripts/fetch-oca.sh` mengambil semua repo OCA pada commit terkunci dan aman dijalankan ulang; sintaks shell, Python, dan YAML valid. Yang belum teruji: build image, instalasi modul di Odoo 19 (termasuk `l10n_id`), dan test. Hal yang paling mungkin perlu penyesuaian: nama modul di `depends` pada `addons/kompakapps_base/__manifest__.py`, dan format log test Odoo yang diperiksa pada langkah "Jalankan test Odoo".
