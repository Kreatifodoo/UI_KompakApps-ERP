# Nusara ERP

ERP modular untuk bisnis Indonesia: pembelian, persediaan, manufaktur, CRM, POS, penjualan, dan akuntansi.

> **Status: prototipe desain.** Repo ini baru berisi prototipe UI statis. Belum ada backend, autentikasi, atau data nyata. Semua angka di dashboard dan isi form adalah data contoh.

## Arah teknis

| Lapisan | Keputusan | Catatan |
|---|---|---|
| Backend | **Odoo** dengan modul custom `nusara_*` + modul OCA | Versi dan edisi (Community/Enterprise) diputuskan di [docs/DECISIONS.md](docs/DECISIONS.md) |
| UI sekarang | HTML statis (React + Babel dari CDN) | Berfungsi sebagai spesifikasi UX, bukan kode produksi |
| UI produksi | Web client Odoo dengan tema `nusara_theme` (jalur A), frontend headless via JSON-2 hanya untuk kasus khusus (jalur B) | Diputuskan di akhir Fase 2 |

Peta lengkap menu Nusara ke modul Odoo ada di [docs/MODULE_MAP.md](docs/MODULE_MAP.md).

## Menjalankan prototipe

Butuh koneksi internet (Tailwind, React, Babel, dan Font Awesome dimuat dari CDN).

```bash
python3 -m http.server 8080
```

Lalu buka http://localhost:8080. Menjalankan lewat server HTTP lebih aman daripada membuka `index.html` langsung (`file://`), karena form dimuat lewat `<iframe>` dan sebagian browser membatasi akses file lokal.

Demo online: https://kreatifodoo.github.io/UI_Nusara-ERP/

## Struktur

```
index.html                    # shell SPA: sidebar, menuData, formMapping
Business_Form_Template.html   # template tunggal untuk semua form
generate_forms.py             # membuat 23 form di forms/ dari template + data
forms/master/                 # 13 form master data
forms/transaction/            # 10 form transaksi
nusara_erp_system.html        # versi lama index.html (duplikat, akan dihapus)
addons/nusara_base/           # modul Odoo pertama (fondasi + test)
oca.lock                      # repo OCA 19.0 yang dipakai, dikunci ke commit
docker/, docker-compose.yml   # image Odoo 19 + OCA dan lingkungan lokal
config/odoo.conf              # konfigurasi Odoo
deploy/                       # compose dan skrip update untuk server
ui/                           # UI Nusara terhubung ke Odoo (nginx, sidebar, halaman P2P)
scripts/                      # fetch-oca.sh, seed_demo.py, check_p2p_api.py (uji regresi)
                              # operasional: backup.sh, restore.sh, check_backup_restore.sh, healthcheck.py, loadtest.py (docs/OPERATIONS.md)
.github/workflows/            # CI (lint + test) dan CD (image + deploy)
docs/                         # peta modul, keputusan, dan CI/CD
```

## Menjalankan Odoo secara lokal

Butuh Docker Desktop (di Settings → Resources, alokasikan minimal 4 GB RAM).

1. Siapkan konfigurasi, lalu isi `DB_PASSWORD` dan `ADMIN_PASSWD` di `.env`:

```bash
cp .env.example .env
```

2. Inisialisasi pertama: membuat database dan memasang modul Nusara Base (beberapa menit, sekali saja). Database manager di browser sengaja dimatikan, jadi database dibuat lewat perintah ini:

```bash
docker compose run --rm odoo odoo -d nusara -i nusara_base --without-demo=true --stop-after-init
```

3. Terapkan setup Indonesia pada perusahaan utama: negara Indonesia, mata uang IDR, COA `l10n_id` (termasuk PPN), dan price list bawaan ke IDR. **Hanya untuk database yang belum punya transaksi akuntansi**, karena memuat COA baru menghapus COA lama; metodenya menolak berjalan bila sudah ada transaksi. Aman dijalankan ulang.

```bash
echo "env['res.company'].browse(1).nusara_setup_indonesia(); env.cr.commit()" | docker compose run --rm -T odoo odoo shell -d nusara --no-http
```

4. Jalankan aplikasinya:

```bash
docker compose up
```

5. Buka http://localhost:8069 dan login dengan `admin` / `admin`, lalu **segera ganti password** di menu profil. Nama database di langkah 2 dan 3 harus sama dengan `ODOO_DB` di `.env` (default `nusara`).

Menjalankan test modul `nusara_base` (di database terpisah, tidak menyentuh data Anda):

```bash
docker compose run --rm --no-deps odoo odoo -d nusara_test -i nusara_base --test-enable --test-tags /nusara_base --without-demo=true --stop-after-init
```

## UI Nusara yang terhubung ke Odoo

Kerangka di `ui/live/` memakai **desain sidebar prototipe** (9 modul, menu bertingkat, pencarian menu) dan bertransaksi langsung ke Odoo lewat API JSON-2. Menu yang bertitik hijau sudah terhubung; sisanya membuka halaman "belum terhubung ke Odoo" yang menyebut model Odoo tujuannya (bukan data palsu).

| Menu | Halaman | Model Odoo |
|---|---|---|
| Purchase › Master › Vendor Master, Accounting › Master › Vendor Master | Daftar dan form pemasok (alamat, NPWP/PKP, syarat bayar), arsip | `res.partner` |
| Purchase › Master › Vendor Price list | Harga vendor per produk (tingkat jumlah, diskon, masa berlaku) | `product.supplierinfo` |
| Purchase, Purchase Request, Inventory, Sales, Accounting › Master › Product Master | Daftar dan form produk, pajak, vendor, arsip | `product.template` |
| Inventory › Master › Product Category, Accounting › Master › Product Category | Metode biaya, valuasi persediaan, akun persediaan/beban/pendapatan | `product.category` |
| Accounting › Jurnal Entry | Daftar jurnal (baca-saja) dengan item jurnal dan dokumen sumber | `account.move` |
| Inventory › Report › Stock, Location, Move History; Operation › Inventory Loss | Laporan stok dengan nilai terhadap buku besar, riwayat pergerakan | `stock.quant`, `stock.move.line` |
| Inventory › Operation › Physical Inventory, Scrap; Master › Reorder Level; Operation › Replenishment | Hitung fisik, scrap, aturan stok minimum, dan pengisian ulang ke RFQ | `stock.quant`, `stock.scrap`, `stock.warehouse.orderpoint` |
| Inventory › Master › Lot & Serial Number Master; Product Master (pelacakan); Penerimaan, Pengiriman, Scrap, Physical Inventory | Lot dan nomor seri, tanggal kedaluwarsa, penelusuran lot dari penerimaan sampai pengiriman | `stock.lot`, `stock.move.line`, `product_expiry` |
| Inventory › Master › Warehouse & Location Master, Unit of Measurement Master, Put away Rules; Operation › Internal Transfer, Material Request | Gudang dan fitur (Storage Locations, Lots & Serial), lokasi, satuan, aturan penyimpanan, transfer antar lokasi | `stock.warehouse`, `stock.location`, `uom.uom`, `stock.putaway.rule`, `stock.picking` |
| Manufacture › Master › Bill of Material, WorkCenter; Schedule Production; Manufacturing Order; Reporting › Production Analisis | BoM dengan komponen, produk sampingan, operasi, dan biaya; work center dan fitur; MO dari draft sampai selesai (backorder, konsumsi berlebih, work order, scrap, unbuild); jadwal dan analisis produksi | `mrp.bom`, `mrp.workcenter`, `mrp.production`, `mrp.workorder`, `mrp.unbuild` |
| CRM › Leads, Opportunity, Setting | Lead dan konversinya, papan pipeline dengan seret-lepas, menang dan kalah, quotation dari opportunity, aktivitas terjadwal, tahap, alasan kalah, tag | `crm.lead`, `crm.stage`, `crm.lost.reason`, `crm.tag`, `mail.activity` |
| CRM › Reporting › Forecast, Pipeline, Leads, Activities | Pendapatan per bulan tenggat dan tahap, pipeline per tahap dan sales, menang dan kalah, konversi lead per sumber, aktivitas terjadwal | `crm.lead`, `mail.activity` |
| POS › POS Station, Kasir, POS Order, POS Session | Stasiun dan metode pembayaran, layar kasir dengan keranjang dan pembayaran campuran, struk, sesi dengan hitung kas, dan jurnal penutupan sesi | `pos.config`, `pos.payment.method`, `pos.session`, `pos.order` |
| Sales › Master › Pricelis Master | Daftar harga penjualan dengan aturan per produk, kategori, jumlah minimum, periode, dan cara hitung | `product.pricelist`, `product.pricelist.item` |
| Sales › Master › Promotion & Loyalty, POS › Promotion & Loyalty; Sales Order (Kode Kupon, Hadiah); Kasir | Program promosi dan loyalti (promosi otomatis, kode promo, beli X gratis Y, kupon, kartu loyalti, kartu hadiah, e-wallet) dengan aturan, hadiah, masa berlaku, batas pemakaian, dan kupon atau kartu (buat massal, ubah saldo, riwayat); kode kupon dan hadiah di Sales Order; promosi otomatis, kode promo, dan beli X gratis Y di kasir | `loyalty.program`, `loyalty.rule`, `loyalty.reward`, `loyalty.card`, `sale.order`, `pos.order` |
| Accounting › Report › Tax Report, Invoice Analysis, Analytic Report | PPN keluaran dan masukan, analisis penjualan dan pembelian per dimensi, pendapatan dan biaya per akun analitik, unduh CSV | `account.move.line`, `account.invoice.report`, `account.analytic.line` |
| Dashboard di semua modul | Angka kunci yang bisa diklik, grafik 6 bulan, dan tabel ringkas per modul | `search_count`, `formatted_read_group` pada model tiap modul |
| Accounting › Master › Chart of Account, Tax Master, Currencies, Jurnal, Asset Model, Analitic Account; Asset | Akun, pajak dengan akun pajak, mata uang dan kurs, jurnal, model aset, aset dengan jadwal dan posting penyusutan, akun dan plan analitik | `account.account`, `account.tax`, `res.currency`, `account.journal`, `account.asset(.profile)`, `account.analytic.account` |
| Report › Purchase Request Line dan Analisis, Purchase Order Line dan Analisis, Move Analisis, Sales Order Line dan Analisis, Sales Person, Product; POS › Order Report, Sales Details | Ringkasan per dimensi dengan ukuran dan batang, klik nama kelompok untuk baris rinciannya dan klik dokumen untuk membukanya (PR, PO, SO, pesanan POS, penerimaan, pengiriman, transfer, MO), perbandingan dengan periode sebelumnya atau tahun lalu (nilai pembanding, selisih, persen), daftar baris dengan filter, unduh CSV | `purchase.request.line`, `purchase.report`, `stock.move.line`, `sale.report`, `report.pos.order` |
| Setting di tiap modul; General Setting › Company Setting, Users & Access | Pengaturan fitur dan kebijakan per modul, kunci periode akuntansi, data dan logo perusahaan, pengguna dengan peran per aplikasi | `res.config.settings`, `res.company`, `res.users`, `res.groups` |
| General Setting › Import Data | Impor CSV atau Excel (.xlsx, pilih lembar) untuk produk, pelanggan dan pemasok, kategori, harga vendor, akun, stok awal, jurnal saldo awal, dan BoM: pemetaan kolom otomatis, uji tanpa simpan, lalu impor | `base_import.import` (mesin impor Odoo; Excel lewat `nusara_create_from_file`, D36) |
| Tombol Cetak di PR, PO, Sales Order, faktur dan tagihan, surat jalan dan penerimaan, pembayaran, POS Order (struk), Manufacturing Order (Perintah Produksi) | Pratinjau berkop surat (logo, alamat, NPWP, footer dari Company Setting) lalu cetak atau simpan sebagai PDF lewat browser; A4, dan struk POS juga lebar 80 mm | `purchase.order`, `sale.order`, `account.move`, `stock.picking`, `account.payment`, `purchase.request`, `pos.order`, `mrp.production` |
| General Setting › Audit Log | Jejak siapa mengubah apa dan kapan dengan nilai lama dan baru; aturan audit per model (standar: kontak, produk, daftar harga, akun, pajak, jurnal master, PO, SO, transfer stok, PR, pengguna, perusahaan) dan retensi log | `auditlog.rule`, `auditlog.log`, `auditlog.log.line` (OCA `auditlog`) |
| Accounting › Master › Budget Plan Master; Accounting › Budget; Accounting › Reporting › Budget Report | Rencana anggaran (periode, status), baris anggaran per akun, analitik, dan periode (bagi rata per bulan), konfirmasi, dan laporan anggaran vs realisasi dengan selisih, persentase, filter analitik, drilldown, dan CSV | `mis.budget.by.account(.item)`, `mis.report.instance` (OCA `mis_builder_budget`) |
| Kolom Analitik pada baris Purchase Request, RFQ dan Purchase Order, Quotation dan Sales Order, tagihan vendor, faktur, nota kredit dan debit; Jurnal Entry (Distribusi Analitik) | Pemilih akun analitik per baris: satu akun per rencana, beberapa baris persen (total di bawah 100% diberi peringatan, di atas 100% ditolak), dibaca dan ditulis ulang tanpa merusak distribusi Odoo; terbawa dari PO ke tagihan dan dari SO ke faktur, lalu menjadi baris analitik saat diposting; dialog menampilkan anggaran terkonfirmasi, realisasi, dan sisa untuk akun terpilih dengan tautan ke Budget Report | `analytic_distribution` pada `purchase.request.line`, `purchase.order.line`, `sale.order.line`, `account.move.line`; `account.analytic.plan`, `account.analytic.account`, `account.analytic.line`; `mis.budget.by.account(.item)`; `ui/live/analyticpick.js` |
| Accounting › Bank Transaction | Mutasi bank manual atau CSV, rekonsiliasi dengan pembayaran tertunda, faktur, atau tagihan, biaya bank ke akun beban | `account.bank.statement(.line)`, `account_reconcile_oca` |
| Accounting › Reporting › Profit and Loss, Balance Sheet, Cash Flow Statement, Trial Balance, Executive Summary | Laporan keuangan dari template MIS Builder (pembanding periode, drilldown ke item jurnal, CSV) | `mis.report`, `mis.report.instance` |
| Accounting › Reporting › Aged Receivable, Aged Payable, General Ledger, Partner Ledger | Umur piutang/hutang per mitra, buku besar dan buku besar pembantu dengan saldo berjalan | `account.move.line` |
| Sales › Master › Customers Master, Accounting › Master › Customer Master | Pelanggan: alamat, NPWP/PKP, identitas pembeli Coretax, batas kredit, akun piutang | `res.partner` |
| Sales › Quotations, Sales Orders | Quotation ke Sales Order, dialog Buat Faktur (reguler dan uang muka) | `sale.order`, `sale.advance.payment.inv` |
| Inventory › Operation › Delivery Order, Return GR, Return DO | Pengiriman barang, backorder, retur | `stock.picking`, `stock.return.picking` |
| Sales › Create Customer Invoice, Accounting › Customers › Customer Invoice, Credit Note, Customer Payment | Faktur pelanggan (kode transaksi faktur pajak), nota kredit, pembayaran masuk | `account.move`, `account.move.reversal`, `account.payment` |
| Accounting › Vendors › Debit Note | Nota debit vendor dari tagihan terposting | `account.move` |
| Purchase Request › Purchase Request | Daftar dan form PR | `purchase.request` (OCA) |
| Purchase › Request for Quotation, Purchase Order | RFQ dan PO | `purchase.order` |
| Purchase › Create Vendor Bill, Accounting › Vendors › Vendor Bills | Tagihan vendor, dialog Bayar | `account.move`, `account.payment.register` |
| Inventory › Operation › Good Receive | Penerimaan barang, backorder | `stock.picking` |
| Accounting › Vendors › Vendor Payment | Pembayaran | `account.payment` |

Data master Purchase (vendor, produk, harga vendor) bisa dibuat, diubah, dan diarsipkan dari UI; harga vendor langsung menggerakkan harga baris RFQ.

Tagihan dan pembayaran menampilkan item jurnal yang tercipta; Jurnal Entry memperlihatkan semuanya. Barang stok dicatat dengan valuasi perpetual dan biaya rata-rata (D13).

Laporan keuangan (D15) dihitung dari transaksi di atas dan bisa dibuka di Accounting › Reporting. Pembayaran dicocokkan dengan mutasi bank di Accounting › Bank Transaction (D16), sehingga Kas dan Bank di laporan terisi.

Order-to-Cash juga bisa dijalankan penuh: **Quotation → Sales Order → pengiriman → faktur pelanggan → pembayaran → nota kredit/retur** (D14).

Alur yang bisa dijalankan penuh dari UI: **Purchase Request → RFQ → PO → penerimaan (termasuk sebagian dengan backorder) → tagihan vendor → pembayaran (termasuk bayar sebagian)**. Form mengikuti view Odoo: tombol header menurut status dan hak, bilah status, tombol statistik, field yang hanya bisa diedit saat draft, tabel barang, total, dan chatter. Hanya untuk pengembangan lokal (HTTP, hanya `127.0.0.1`).

1. Jalankan tumpukan (layanan `ui` ikut menyala di http://localhost:8080):

```bash
docker compose up -d
```

2. Opsional, bila database belum punya vendor dan produk: isi data contoh (vendor, produk, harga vendor, setup Indonesia). Menolak berjalan bila sudah ada transaksi akuntansi.

```bash
docker compose run --rm -T odoo odoo shell -d nusara --no-http < scripts/seed_demo.py
```

3. Buat API key milik Anda di Odoo (http://localhost:8069): klik nama Anda → **Preferences** → **Account Security** → **New API Key**. Salin key-nya (hanya tampil sekali).
4. Buka http://localhost:8080, tempel API key, lalu **Hubungkan**. Key disimpan di `sessionStorage` tab itu saja dan hilang saat tab ditutup.

Nginx pada layanan `ui` hanya meneruskan `/json/2/` ke Odoo, sehingga antarmuka admin Odoo tidak terbuka lewat port itu dan CORS tidak diperlukan.

### Uji regresi alur Procure-to-Pay

`scripts/check_p2p_api.py` menjalankan seluruh alur di atas lewat API (panggilan yang sama dengan UI) dan memeriksa 421 hal, termasuk jurnal tagihan dan pembayaran, Sales Order sampai nota kredit, laporan keuangan (neraca seimbang, arus kas cocok dengan kas), penerimaan sebagian dengan backorder, pembayaran bertahap, lot dan nomor seri dengan kedaluwarsa, manufaktur (BoM sampai unbuild), CRM (lead sampai menang atau kalah), POS (penjualan kasir sampai jurnal penutupan sesi), Promotion & Loyalty (kode promo, promosi otomatis, kupon, kartu loyalti, dan pesanan kasir berhadiah), drill-down dan perbandingan periode laporan analisis (angka kelompok, pembanding, dan baris rincian dihitung ulang dari dokumen), akun analitik pada baris (PO ke tagihan ke baris analitik, SO ke faktur, PR, jurnal manual, dan anggaran terkonfirmasi), dan data master (vendor, produk, harga vendor bertingkat, arsip). Skrip ini **menulis data**, jadi pakai database uji dan API key pengguna uji:

```bash
NUSARA_API_KEY=<api-key-uji> python3 scripts/check_p2p_api.py --yes --url http://127.0.0.1:8080
```

Detail CI/CD dan penyiapan server ada di [docs/CICD.md](docs/CICD.md).

Untuk mengubah form: edit data di `generate_forms.py`, lalu jalankan `python3 generate_forms.py`. Jangan edit file di `forms/` langsung, karena akan tertimpa.

## Operasional: backup, pemulihan, pemantauan, uji beban

Skrip di `scripts/` dan prosedur lengkapnya ada di [docs/OPERATIONS.md](docs/OPERATIONS.md). Semuanya wajib diberi nama proyek Compose dan database secara eksplisit (tidak ada nilai bawaan).

```bash
# backup database + filestore + manifest (rotasi simpan 14 terbaru), cocok untuk cron
COMPOSE_PROJECT=<proyek> ODOO_DB=<database> BACKUP_DIR=/var/backups/nusara KEEP=14 scripts/backup.sh
# pulihkan ke database BARU lalu verifikasi (tidak menimpa database yang ada)
COMPOSE_PROJECT=<proyek> scripts/restore.sh /var/backups/nusara/<database>_<tanggal-jam> <database-baru>
# uji siklus backup -> ubah data -> restore -> cocokkan angka (hanya database uji)
COMPOSE_PROJECT=<proyek> ODOO_DB=<database-uji> scripts/check_backup_restore.sh --yes
# kesehatan (kode keluar 0/1/2 untuk cron) dan uji beban (hanya loopback tanpa --yes-remote)
python3 -I scripts/healthcheck.py --odoo-url http://127.0.0.1:8069 --backup-dir /var/backups/nusara
NUSARA_API_KEY=<api-key-uji> python3 -I scripts/loadtest.py --url http://127.0.0.1:8080 --users 10 --duration 30
```

## Peta jalan

0. Fondasi dan keputusan (repo, edisi/versi Odoo, kebutuhan Indonesia)
1. Lingkungan Odoo (Docker) dan CI
2. Konsolidasi prototipe UI, lalu pilih jalur A atau B
3. Irisan vertikal pertama: Purchase Request → RFQ → PO → Goods Receipt → Vendor Bill → Payment
4. Order-to-Cash, Inventory lanjutan, Manufaktur, Laporan akuntansi, CRM, POS
5. Pengerasan enterprise: keamanan, approval, audit trail, backup, uji beban
