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

Laporan keuangan (D15) dihitung dari transaksi di atas dan bisa dibuka di Accounting › Reporting.

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

`scripts/check_p2p_api.py` menjalankan seluruh alur di atas lewat API (panggilan yang sama dengan UI) dan memeriksa 70 hal, termasuk jurnal tagihan dan pembayaran, Sales Order sampai nota kredit, laporan keuangan (neraca seimbang, arus kas cocok dengan kas), penerimaan sebagian dengan backorder, pembayaran bertahap, dan data master (vendor, produk, harga vendor bertingkat, arsip). Skrip ini **menulis data**, jadi pakai database uji dan API key pengguna uji:

```bash
NUSARA_API_KEY=<api-key-uji> python3 scripts/check_p2p_api.py --yes --url http://127.0.0.1:8080
```

Detail CI/CD dan penyiapan server ada di [docs/CICD.md](docs/CICD.md).

Untuk mengubah form: edit data di `generate_forms.py`, lalu jalankan `python3 generate_forms.py`. Jangan edit file di `forms/` langsung, karena akan tertimpa.

## Peta jalan

0. Fondasi dan keputusan (repo, edisi/versi Odoo, kebutuhan Indonesia)
1. Lingkungan Odoo (Docker) dan CI
2. Konsolidasi prototipe UI, lalu pilih jalur A atau B
3. Irisan vertikal pertama: Purchase Request → RFQ → PO → Goods Receipt → Vendor Bill → Payment
4. Order-to-Cash, Inventory lanjutan, Manufaktur, Laporan akuntansi, CRM, POS
5. Pengerasan enterprise: keamanan, approval, audit trail, backup, uji beban
