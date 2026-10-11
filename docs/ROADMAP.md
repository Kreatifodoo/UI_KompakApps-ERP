# Peta Jalan dan Antrian Kerja Nusara ERP

Dokumen ini mencatat posisi proyek dan antrian pekerjaan. Keputusan teknis rinci ada di [DECISIONS.md](DECISIONS.md) (D1 sampai D29 dan seterusnya), cara bekerja di [DEV_GUIDE.md](DEV_GUIDE.md).

## Posisi (2026-10-11)

| Fase | Isi | Status |
|---|---|---|
| 0 sampai 3 | Fondasi, lingkungan Odoo, UI langsung ke Odoo, alur Procure-to-Pay | Selesai |
| 4 | Order-to-Cash, laporan keuangan, bank, Inventory, lot, Manufacture, CRM, POS, master akuntansi, aset, laporan analisis, dashboard, setting | Hampir selesai (lihat antrian) |
| 5 | Pengerasan enterprise | Berjalan sebagian (Users & Access, kunci periode, Company Setting sudah ada) |

Setiap menu pada sidebar prototipe sudah punya halaman kecuali tiga kelompok pada antrian Fase 4.

## Antrian Fase 4 (sisa)

| # | Pekerjaan | Pemilik | Catatan |
|---|---|---|---|
| 4.1 | Promotion & Loyalty (Sales dan POS) | Agen A | Memasang modul `loyalty`, `sale_loyalty`, `pos_loyalty` |
| 4.2 | Budget Plan Master, Budget, Budget Report | Agen B | OCA `mis_builder_budget` |
| 4.3 | Sales › Report › Commissions | Ditunda | Tidak ada di Odoo Community; butuh OCA `sale_commission` dan keputusan aturan komisi |

## Antrian Fase 5 (pengerasan)

| # | Pekerjaan | Pemilik | Catatan |
|---|---|---|---|
| 5.1 | Backup dan restore terjadwal, pemantauan, uji beban | Agen C | Skrip dan dokumen operasional; tidak mengubah kode aplikasi |
| 5.2 | Cetak dokumen berlogo (QWeb): faktur, PO, SO, pengiriman, struk | Menunggu | Memakai logo dan footer dari Company Setting |
| 5.3 | Impor data master dari CSV (produk, mitra, saldo awal) | Selesai (D33) | Halaman Import Data memakai mesin impor Odoo |
| 5.4 | Persetujuan bertingkat (OCA `base_tier_validation`) | Menunggu | Perlu menambah repo OCA ke `oca.lock` |
| 5.5 | Audit log (OCA `auditlog`) dan aturan akses per rekaman | Menunggu | Perlu menambah repo OCA ke `oca.lock` |
| 5.6 | Autentikasi dua langkah, SSO, kebijakan kata sandi | Menunggu | |
| 5.7 | Multi-perusahaan dan multi-gudang lanjutan | Menunggu | |

## Aturan antrian

- Satu pekerjaan satu branch dan satu PR; branch dari `main` terbaru dan di-squash saat digabung.
- Pekerjaan yang berjalan bersamaan memakai worktree dan stack Docker sendiri (lihat DEV_GUIDE), agar tidak saling menimpa data uji.
- Berkas yang sering disentuh bersamaan (`main.js`, `menu.js`, `README.md`, `DECISIONS.md`, `check_p2p_api.py`) hanya ditambah di akhir; konflik saat rebase diselesaikan dengan mempertahankan kedua sisi. Nomor keputusan baru dicadangkan di tabel di atas: Agen A memakai D30, Agen B memakai D31, Agen C memakai D32.
- Setelah sebuah PR digabung, database `nusara` milik pemilik di-upgrade (dengan backup) oleh orang yang menggabungkannya, bukan oleh pekerja paralel.
- Bukan bagian antrian pekerjaan teknis, tetapi menunggu pemilik: proteksi branch `main` (ruleset) dan pencabutan token GitHub lama.
