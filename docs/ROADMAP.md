# Peta Jalan dan Antrian Kerja KompakApps

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
| 4.2 | Budget Plan Master, Budget, Budget Report | Agen B | Selesai (D31): OCA `mis_builder_budget` per akun |
| 4.3 | Sales › Report › Commissions | Ditunda | Tidak ada di Odoo Community; butuh OCA `sale_commission` dan keputusan aturan komisi |
| 4.4 | Drill-down dan perbandingan periode di laporan analisis | Selesai (D37) | Hanya UI (`analysis.js`): baris rincian per kelompok dengan tautan dokumen, pembanding periode sebelumnya atau tahun lalu, CSV mengikuti; sisa: grafik dan komisi |
| 4.5 | Akun analitik (dan anggaran) bisa dipilih pada baris transaksi | Selesai (D39) | Pemilih distribusi bersama `analyticpick.js` di PR, RFQ/PO, Quotation/SO, tagihan, faktur, dan nota; dialog menampilkan sisa anggaran terkonfirmasi; sisa: ubah analitik pada dokumen terkonfirmasi, form jurnal manual, kolom analitik pada cetakan |
| 4.6 | Pajak pada baris transaksi bisa dipilih manual dan multi tag | Selesai (D40) | Pemilih pajak bersama `taxpick.js` di RFQ/PO, Quotation/SO, tagihan, faktur, dan nota; filter jenis pajak per dokumen; sisa: perkiraan subtotal di klien, pemetaan posisi fiskal pada pratinjau baris baru |
| 4.7 | Inventory Valuation lengkap (per tanggal, mutasi periode, rincian pergerakan, per akun persediaan) | Selesai (D46) | Hanya UI (`valuation.js`) dan skrip uji; nilai historis dari hitungan Odoo (`to_date`); sisa: valuasi per lot, filter gudang pada mutasi dan rincian, jurnal penyesuaian dan scrap |
| 4.8 | Replenishment digerakkan permintaan dengan rute Beli, Produksi, dan suplai antar gudang per baris | Selesai (D47) | Hanya UI (`replenish.js`, `orderpoint.js`, `routes.js`) dan skrip uji; aturan manual otomatis dari Sales Order dan MO, rute dan pemicu per baris, peringatan BoM dan pemasok, panel hasil; sisa: kelipatan pesan, snooze, rute per produk dari halaman ini |
| 4.9 | Vendor Bill dan Customer Invoice: berdiri sendiri atau dari beberapa PO/SO satu mitra, tambah dokumen ke draf | Selesai (D48) | Hanya UI (`invoices.js`, `docbill.js`) dan skrip uji; Q27 (payment/receipt), Q28 (jurnal entry), Q29 (bank recon) menyusul; sisa: Buat berdiri sendiri untuk nota kredit/debit, uang muka dan seksi pada penambahan ke draf |
| 4.10 | Payment vendor dan Receipt pelanggan: berdiri sendiri atau dari beberapa tagihan/faktur satu mitra (boleh sebagian), alokasi pembayaran berdiri sendiri | Selesai (D49) | Hanya UI (`payment.js`, `paydocs.js`) dan skrip uji; Q28 (jurnal entry) dan Q29 (bank recon) menyusul; sisa: kompensasi nota kredit/debit, diskon pembayaran dini dan cicilan syarat pembayaran, ubah draf pembayaran |
| 4.11 | Jurnal Entry manual: buat, edit draf, posting, batalkan ke draf, duplikat, balik jurnal, cetak | Selesai (D50) | Hanya UI (`journal.js`, `jentry.js`, `print.js`, `taxpick.js`) dan skrip uji; Q29 (bank recon) menyusul; sisa: mata uang asing per baris, jurnal berulang (`auto_post`), baris seksi dan catatan, hapus draf permanen |
| 4.12 | Rekonsiliasi bank dengan faktur, tagihan, nota, pembayaran, dan baris jurnal entry: saran, filter, banyak dokumen, sebagian, selisih ke akun | Selesai (D64) | Hanya UI (`bank.js`) dan skrip uji; sisa: aturan rekonsiliasi otomatis (`account.reconcile.model`), impor OFX/MT940, mutasi non-IDR |

## Antrian Fase 5 (pengerasan)

| # | Pekerjaan | Pemilik | Catatan |
|---|---|---|---|
| 5.1 | Backup dan restore terjadwal, pemantauan, uji beban | Selesai (D32) | Skrip di `scripts/` dan panduan [OPERATIONS.md](OPERATIONS.md); sisa: backup dari `deploy/update.sh`, arsip WAL (PITR), enkripsi dan salinan luar otomatis |
| 5.2 | Cetak dokumen berlogo: faktur, PO, SO, pengiriman, pembayaran, PR, struk POS, Perintah Produksi | Selesai (D34, D36) | Dibangun di klien dari data JSON-2; struk POS A4 atau 80 mm, MO dengan komponen dan work order |
| 5.3 | Impor data master dari CSV atau Excel (produk, mitra, saldo awal) | Selesai (D33, D36) | Halaman Import Data memakai mesin impor Odoo; Excel (.xlsx) lewat metode `nusara_create_from_file` (butuh restart Odoo) |
| 5.4 | Persetujuan bertingkat | Tertahan | OCA `base_tier_validation` belum ada di cabang 19.0 (dicek 2026-10-11); pilihan: tunggu port OCA atau bangun persetujuan ringan sendiri (aturan per model, ambang, grup penyetuju). Persetujuan PO per nominal sudah ada di Purchase Setting |
| 5.5 | Audit log (OCA `auditlog`) dan aturan akses per rekaman | Audit log selesai (D35); aturan akses per rekaman menunggu | Jurnal, faktur, dan pembayaran tidak bisa diaudit (merusak rekonsiliasi) |
| 5.6 | Autentikasi dua langkah, SSO, kebijakan kata sandi | Menunggu | |
| 5.7 | Multi-perusahaan dan multi-gudang lanjutan | Multi-gudang selesai (D42); multi-perusahaan menunggu (Q12b) | Gudang kedua dan seterusnya, rute suplai antar gudang, stok per gudang, pemilih gudang di PO, SO, dan MO; sisa: multi-perusahaan, MO multi-langkah, dropship, pemilih gudang di POS |

## Aturan antrian

- Satu pekerjaan satu branch dan satu PR; branch dari `main` terbaru dan di-squash saat digabung.
- Pekerjaan yang berjalan bersamaan memakai worktree dan stack Docker sendiri (lihat DEV_GUIDE), agar tidak saling menimpa data uji.
- Berkas yang sering disentuh bersamaan (`main.js`, `menu.js`, `README.md`, `DECISIONS.md`, `check_p2p_api.py`) hanya ditambah di akhir; konflik saat rebase diselesaikan dengan mempertahankan kedua sisi. Nomor keputusan baru dicadangkan di tabel di atas: Agen A memakai D30, Agen B memakai D31, Agen C memakai D32, Agen E memakai D37, Agen I memakai D42, Q21 memakai D43, Q23 memakai D47, Q26 memakai D48, Q27 memakai D49, Q28 memakai D50.
- Setelah sebuah PR digabung, database `nusara` milik pemilik di-upgrade (dengan backup) oleh orang yang menggabungkannya, bukan oleh pekerja paralel.
- Bukan bagian antrian pekerjaan teknis, tetapi menunggu pemilik: proteksi branch `main` (ruleset) dan pencabutan token GitHub lama.
