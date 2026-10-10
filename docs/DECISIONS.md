# Catatan Keputusan

Format: satu entri per keputusan. Status: **Diputuskan**, **Terbuka**, atau **Perlu verifikasi**.

## D1. Backend dibangun di atas Odoo
- **Status**: Diputuskan (2026-10-09)
- **Konteks**: Alternatifnya adalah memakai ulang backend Kompak (FastAPI) atau membangun dari nol. Prototipe Nusara sangat mirip Odoo (stage bar, RFQ, put-away rules, POS session).
- **Konsekuensi**: Logika bisnis ada di modul Odoo (Python). Satu database per tenant. Terikat pada siklus rilis dan lisensi Odoo.

## D2. Prototipe UI tetap HTML statis untuk sekarang
- **Status**: Diputuskan (2026-10-09)
- **Konteks**: Prototipe dipakai untuk menyepakati alur dan tampilan sebelum konfigurasi Odoo mahal dikerjakan.
- **Konsekuensi**: Prototipe adalah spesifikasi, bukan produk. Dibatasi waktu (lihat Fase 2). Tidak ada migrasi ke framework SPA sampai jalur UI diputuskan (D5).

## D3. Edisi Odoo: Community + OCA
- **Status**: Diputuskan (2026-10-09)
- **Konteks**: Community berlisensi LGPLv3 tanpa biaya per user. Fitur kelas Enterprise (asset, budget, laporan keuangan lengkap, approval, audit) dipenuhi dari modul OCA.
- **Konsekuensi**: Kualitas "enterprise" bergantung pada modul OCA, jadi ketersediaan modul di cabang versi yang dipakai harus dicek sebelum menjanjikan fitur.

## D4. Versi Odoo: 19.0
- **Status**: Diputuskan (2026-10-09)
- **Konteks**: Odoo 20 sudah ada (cabang `odoo/odoo` 20.0 dan image `odoo:20.0` tersedia, rilis sekitar 26 September 2026). Namun saat dicek 2026-10-09, cabang `20.0` hampir semua repo OCA masih **kosong** (tanpa modul): `purchase-workflow`, `server-tools`, `server-ux`, `account-financial-tools`, `account-financial-reporting`, dan lainnya. Hanya `mis-builder` (3 modul) dan `web` (1 modul) yang sudah ada. Cabang `19.0` terisi penuh.
- **Konsekuensi**: Mulai di 19.0. Versi Odoo dan cabang OCA dibuat sebagai satu variabel (`ODOO_VERSION`) di Docker dan CI, supaya pindah ke 20.0 nanti cukup mengganti satu nilai setelah OCA selesai migrasi. Cek ulang kesiapan 20.0 setiap kuartal.
- **Catatan**: XML-RPC/JSON-RPC deprecated sejak 19; gunakan JSON-2 untuk integrasi baru.

## D5. Jalur UI produksi
- **Status**: Terbuka (diputuskan di akhir Fase 2)
- **A (rekomendasi MVP)**: web client Odoo + modul `nusara_theme`.
- **B (selektif)**: frontend headless via JSON-2, hanya untuk portal atau layar kasir.

## D6. Kebutuhan Indonesia
- **Status**: Sebagian terverifikasi (2026-10-09)
- **Daftar**: PPN, e-Faktur/Coretax, COA mengikuti PSAK, multi-currency, bahasa id_ID, format NPWP/NIK.
- **Terverifikasi** pada image `odoo:19.0` (Community): modul `l10n_id` (LGPL-3), `l10n_id_efaktur_coretax` (LGPL-3, ekspor XML untuk Coretax, bergantung pada `l10n_id`), dan `l10n_id_pos` tersedia. Modul `l10n_id_efaktur` (e-Faktur lama) **tidak ada** di Community. `l10n_id` sudah terpasang di database lokal.
- **Belum**: data awal Indonesia belum diterapkan (perusahaan bawaan masih USD/US). Kesesuaian ekspor Coretax dengan ketentuan DJP terbaru perlu diuji dengan data nyata sebelum produksi.

## D7. Model hosting dan tenant
- **Status**: Terbuka
- **Opsi hosting**: self-host Docker (VPS) atau Odoo.sh.
- **Tenant**: Odoo memakai satu database per tenant lewat `dbfilter`/subdomain. Tentukan apakah Nusara dijual sebagai SaaS atau diinstal per klien.

## D8. Penyesuaian atas modul OCA dan setup Indonesia di `nusara_base`
- **Status**: Diputuskan (2026-10-09), ditemukan lewat test alur Procure-to-Pay
- **Wizard PR ke RFQ**: wizard OCA `purchase.request.line.make.purchase.order` (cabang 19.0) memaksa `price_unit = 0.0` pada baris PO, sehingga harga dari daftar harga vendor tidak terbawa. `nusara_base` membuang kunci itu agar Odoo menghitungnya dari `product.supplierinfo`. Dicakup oleh test `test_procure_to_pay`. Tinjau lagi bila OCA memperbaikinya di hulu.
- **Setup Indonesia**: `res.company.nusara_setup_indonesia()` (negara ID, IDR, COA `l10n_id`, price list bawaan ke IDR) sengaja eksplisit, bukan hook instalasi, karena memuat COA baru menghapus COA lama. Menolak berjalan bila perusahaan sudah punya transaksi akuntansi. Price list yang sudah punya aturan harga tidak diubah.
- **`--without-demo`**: di Odoo 19 opsi ini boolean; gunakan `true`, bukan `all`.

## D9. UI Nusara terhubung ke Odoo lewat JSON-2 (uji kelayakan Purchase Request)
- **Status**: Terbukti layak untuk alur Procure-to-Pay penuh (2026-10-10). Keputusan jalur A atau B tetap di akhir Fase 2.
- **Cara kerja**: halaman statis di `ui/live/` memanggil `POST /json/2/<model>/<metode>` pada alamat yang sama; nginx (`ui/nginx.conf.template`) hanya meneruskan `/json/2/`. Autentikasi bearer memakai API key pengguna sendiri. Rute JSON-2 Odoo 19 memakai `auth='bearer'` dan `save_session=False`, jadi tidak ada sesi cookie, dan CORS tidak aktif, sehingga proxy satu alamat diperlukan.
- **Form mengikuti Odoo**: tombol header, status yang menampilkannya, hak manager (`res.users.has_group`), `is_editable` (field hanya bisa diedit saat draft), tombol statistik, kolom barang, default tanggal baris, dan chatter diambil dari definisi view Odoo/OCA, bukan dari tebakan. Untuk form lain, urutkan kerja: baca view XML dan `fields_get` modelnya, lalu petakan.
- **Temuan saat uji**: tanggal baris wajib diisi (Odoo mengisinya otomatis di UI); label dan perilaku diselaraskan. API key tidak boleh ditaruh di berkas JavaScript; versi produksi perlu layar login dan penyimpanan kunci yang aman, atau BFF.
- **Cakupan**: Purchase Request, RFQ/PO, penerimaan barang (backorder), tagihan vendor (dialog pembayaran), dan pembayaran, di dalam kerangka sidebar prototipe (`ui/live/menu.js` menyalin struktur `menuData`; menu yang belum punya halaman menampilkan model Odoo tujuannya, bukan data palsu).
- **Belum**: edit di status selain draft, Return penerimaan, Send RFQ lewat email, pembagian hak per peran, tampilan ponsel yang teruji, dan menu lainnya. Memakai Tailwind dari CDN hanya untuk uji kelayakan. Header prototipe memuat lonceng notifikasi dan avatar dari layanan luar; keduanya tidak dibawa karena datanya palsu dan avatar luar mengirim nama pengguna ke pihak ketiga.

## D10. Harga manual baris PO dan teknik "kirim yang berubah saja"
- **Status**: Diputuskan (2026-10-10), ditemukan lewat uji UI
- **Temuan**: di Odoo 19, baris PO yang dibuat dengan `price_unit` eksplisit punya `technical_price_unit` yang sama dengan `price_unit`. Odoo menganggapnya "bukan manual" dan **menghitung ulang harganya dari daftar harga pemasok setiap kali header ditulis** (bahkan `partner_id` yang sama), sehingga harga manual hilang. Harga manual hanya bertahan bila baris dibuat tanpa harga (otomatis) lalu harganya ditulis **terpisah** pada baris itu.
- **Konsekuensi**: `ui/live/pages/po.js` hanya mengirim field header dan baris yang berubah, dan menulis harga manual sebagai langkah kedua. Prinsip "kirim yang berubah saja" juga dipakai di form tagihan (menulis ulang `invoice_date` dapat menghitung ulang jatuh tempo). Dijaga oleh `scripts/check_p2p_api.py`.

## D11. Data master Purchase di UI dan harga vendor bertingkat
- **Status**: Diputuskan (2026-10-10)
- **Cakupan**: Vendor Master (`res.partner`, `supplier_rank = 1` saat dibuat), Vendor Price list (`product.supplierinfo`), dan Product Master (`product.template`) dapat dibuat, diubah, dan diarsipkan dari UI. Form mengikuti form Odoo 19 (jenis, alamat, NPWP dan PKP lokalisasi Indonesia, pajak, kebijakan kontrol tagihan, tabel vendor di form produk, tombol statistik ke PO dan tagihan). Satu halaman dipakai oleh beberapa menu lewat parameter `state` (Purchase › Product Master memfilter produk yang dapat dibeli, Sales › Product Master yang dapat dijual).
- **Aturan penulisan**: hanya field yang berubah yang dikirim (lihat D10). Pajak produk dikirim sebagai perintah `[[6, 0, ids]]` dan hanya bila pengguna menyentuhnya, sehingga produk baru mendapat pajak bawaan perusahaan. Mengosongkan field memakai `false`. Arsip memakai `action_archive` dan `action_unarchive`, bukan menghapus.
- **Temuan (harga bertingkat)**: baris PO yang dibuat tanpa `price_unit` lewat API atau wizard mendapat harga dari tingkat kuantitas 1, bukan dari kuantitas barisnya (daftar harga 1 → Rp250.000, 10 → Rp200.000 memberi Rp250.000 untuk 12 unit); harga benar baru muncul bila kuantitas diubah. Klien web Odoo tidak terkena karena onchange mengirim `price_unit`. `nusara_base` menghitung ulang harga baris draft yang dibuat tanpa `price_unit`; harga eksplisit tidak ditimpa. Dicakup oleh `test_tiered_vendor_price_follows_line_quantity` dan `scripts/check_p2p_api.py`. Tinjau lagi bila Odoo memperbaikinya di hulu.
- **Belum**: Product Category, Unit of Measurement, varian produk, gambar produk, impor CSV, dan hak akses per peran untuk data master.

## D12. Modul akuntansi OCA yang dipasang di `nusara_base`
- **Status**: Diputuskan (2026-10-10)
- **Kondisi awal**: Community sudah membawa `account` (Invoicing: jurnal, tagihan, pembayaran, pajak, COA), `l10n_id` dan `l10n_id_efaktur_coretax`. Yang tidak dibawa: laporan keuangan (neraca, laba rugi, arus kas, buku besar, umur hutang/piutang), aset tetap, rekonsiliasi bank, dan anggaran.
- **Cara memilih**: apps.odoo-community.org tidak menampilkan jumlah unduhan, jadi peringkat memakai unduhan 30 hari terakhir paket PyPI `odoo-addon-<modul>` (pypistats.org, 2026-10-10) ditambah status pemeliharaan di manifest (Mature atau Production/Stable) dan ketersediaan cabang 19.0. Angka PyPI ikut menghitung CI dan mirror, jadi ini penunjuk kepopuleran, bukan jumlah pemakai produksi.
- **Dipasang** (unduhan/bulan): `mis_builder` 6.239 (laporan P&L, neraca, arus kas dari template KPI), `account_financial_report` 3.740 (buku besar, neraca saldo, open items, umur hutang/piutang, laporan PPN), `account_reconcile_oca` 2.564 (rekonsiliasi bank; membawa `account_statement_base`), `account_asset_management` 2.389 (aset dan penyusutan, status Mature), `account_usability` 2.193 (menu akuntansi yang disembunyikan di Community, berlabel Must-have di situs OCA).
- **Ditunda**: `account_budget_oca` (443/bulan; alternatif `mis_builder_budget` yang berstatus Production/Stable, putuskan saat modul Budget dikerjakan), `account_move_template` (314), `account_chart_update` (628), `account_fiscal_year` (1.813) dan `account_lock_date_update` (1.275; dipasang saat kunci periode dikerjakan di Fase 4).
- **Dependensi baru**: repo OCA `server-ux` (`date_range`) dan `reporting-engine` (`report_xlsx`, `report_xlsx_helper`) ditambahkan ke `oca.lock` dan `addons_path`. Paket Python `xlsxwriter` dan `xlrd` sudah ada di image Odoo.
- **Menu Nusara**: Accounting › Reporting (Trial Balance, General Ledger, Partner Ledger, Aged Receivable/Payable, Tax Report) → `account_financial_report`; Balance Sheet, Profit and Loss, Cash Flow Statement, Executive Summary → template `mis_builder` yang masih harus disusun sesuai COA `l10n_id`; Asset → `account_asset_management`; Bank Transaction → `account_reconcile_oca`. Halaman UI-nya belum dibangun.
- **Database yang sudah ada**: modul baru ikut terpasang lewat `odoo -d <db> -u nusara_base --stop-after-init` setelah image dibangun ulang.

## D13. Selaras dengan modul akuntansi: jurnal per tahap transaksi dan valuasi persediaan
- **Status**: Diputuskan (2026-10-10), hasil audit setelah modul OCA D12 terpasang
- **Jurnal yang tercipta** (dicatat dari alur nyata, `scripts/check_p2p_api.py` dan `test_p2p_flow.py`):

| Tahap | Jurnal |
|---|---|
| Purchase Request, RFQ, konfirmasi PO | tidak ada |
| Penerimaan barang | tidak ada. Odoo 19 hanya mencatat nilai pada `stock.move.value`; valuasi persediaan dijurnal saat tagihan |
| Tagihan vendor diposting | Perpetual: Dr Persediaan, Dr PPN Masukan, Cr Hutang Usaha. Periodik (bawaan Odoo): Dr COGS/Beban, bukan Persediaan |
| Pembayaran | Dr Hutang Usaha, Cr Akun Pembayaran Tertunda (bukan Bank) sampai dicocokkan dengan mutasi bank |
| Tagihan dengan profil aset | aset terbentuk saat posting; jurnal penyusutan menyusul sesuai jadwal |

- **Temuan utama**: bawaan Odoo 19 adalah valuasi periodik dengan harga standar. Barang stok yang ditagih langsung masuk beban (COGS) dan produk tanpa kategori tidak pernah masuk Persediaan. Untuk Indonesia (PSAK 14) dipakai **perpetual dengan biaya rata-rata** untuk kategori Goods: `res.company.nusara_setup_inventory_valuation()` (dipanggil juga oleh `nusara_setup_indonesia`). Jurnal lama tidak diubah. Services dan Expenses tidak diubah.
- **Pembayaran tertunda**: tanpa rekonsiliasi bank, saldo pembayaran tetap di akun Pembayaran Tertunda. UI menampilkan peringatan; halaman Bank Transaction (`account_reconcile_oca`) belum dibangun.
- **Field baru dari modul OCA yang kini dipakai UI**: `account.move.line.asset_profile_id` dan `asset_count` (aset dari tagihan), `account.account.asset_profile_id`, pengaturan `anglo_saxon_accounting`. Modul lain (`account_financial_report`, `mis_builder`, `account_reconcile_oca`) tidak mengubah alur Procure-to-Pay.
- **Penyelarasan UI**: item jurnal pada tagihan dan pembayaran (draft tampil sebagai pratinjau), akun dan profil aset per baris tagihan (edit saat draft), akun hutang dan posisi fiskal di Vendor Master, akun beban/pendapatan dan kategori di Product Master (kategori bawaan Goods atau Services, barang baru dilacak stoknya, ringkasan akun yang didebit), halaman Product Category (metode biaya, valuasi, akun persediaan), halaman Jurnal Entry baca-saja yang menunjuk ke dokumen sumber, dan nilai persediaan pada penerimaan.
- **Kebijakan kontrol tagihan**: produk jasa memakai "kuantitas yang dipesan" (bawaan Odoo). Dengan "diterima", tagihan jasa bernilai nol karena jasa tidak punya penerimaan; UI kini mengisi kebijakan menurut tipe produk.
- **Belum**: laporan keuangan di UI dan template MIS Builder sesuai COA, halaman Bank Transaction dan rekonsiliasi, pajak pemotongan (PPh 23/4(2)) yang tidak dibawa `l10n_id`, anggaran, halaman Chart of Account, Tax, dan Journal master.

## D14. Fase 4 dimulai dari Order-to-Cash: kerangka bersama dan temuan Odoo 19
- **Status**: Diputuskan (2026-10-10)
- **Cakupan**: Customer Master, Quotation dan Sales Order (dialog Buat Faktur: reguler dan uang muka), Delivery Order dan Return (GR dan DO), Faktur Pelanggan, Nota Kredit Pelanggan, Nota Debit Vendor, dan Customer Payment, dengan pola yang sama seperti Procure-to-Pay (form mengikuti Odoo, hanya field yang berubah dikirim, jurnal dan pratinjau jurnal di setiap dokumen).
- **Kerangka bersama** (agar sisi pembelian dan penjualan tidak menyimpang): `invoices.js` (tagihan, faktur, nota kredit, nota debit), `pickings.js` (penerimaan, pengiriman, retur), `partners.js` (vendor, customer). Halaman lama (`bill.js`, `receipt.js`, `vendor.js`) kini hanya konfigurasi.
- **Jurnal per tahap**:

| Tahap | Jurnal |
|---|---|
| Konfirmasi SO, pengiriman barang | tidak ada |
| Faktur pelanggan diposting | Dr Piutang Usaha, Cr Penjualan, Cr PPN Keluaran; perpetual: Dr HPP, Cr Persediaan sebesar biaya rata-rata |
| Pembayaran pelanggan | Dr Pembayaran Tertunda (Outstanding Receipts), Cr Piutang Usaha |
| Nota kredit | kebalikan faktur, termasuk HPP dan Persediaan |

- **Temuan**: (1) baris SO yang dibuat dengan harga eksplisit dikembalikan ke harga daftar saat jumlahnya diubah; harga dan diskon manual harus ditulis sebagai langkah kedua (sama seperti D10), dan penulisan header tidak menghitung ulang harga. (2) `invoice_status` sudah "to invoice" saat SO dikonfirmasi (faktur atas kuantitas pesanan), jadi Buat Faktur tersedia sebelum pengiriman. (3) Wizard nota kredit (`account.move.reversal`) lewat JSON-2 butuh `journal_id` dan `move_ids` eksplisit. (4) Jumlah retur bawaan wizard adalah 0. (5) Kode transaksi faktur pajak (lokalisasi Indonesia) terisi otomatis pada faktur pelanggan ("04", DPP nilai lain) dan bisa diubah saat draft. (6) Pengguna butuh grup Sales untuk membuat SO; test memberi `sales_team.group_sale_manager`.
- **Belum**: kirim quotation lewat email/PDF/portal, mengurangkan uang muka pada faktur akhir, master daftar harga dan promosi, penerapan nota kredit ke faktur terbuka (rekonsiliasi), pemeriksaan batas kredit saat konfirmasi, ekspor e-Faktur Coretax, laporan penjualan, kunci SO.

## D15. Laporan keuangan dari template MIS Builder dan laporan buku besar di UI
- **Status**: Diputuskan (2026-10-10), lanjutan Fase 4
- **Cakupan**: Laba Rugi, Neraca, Arus Kas (metode tidak langsung), Neraca Saldo, dan Ringkasan Eksekutif memakai template `mis_builder` untuk COA l10n_id; Umur Piutang dan Umur Hutang, Buku Besar, dan Buku Besar Pembantu (Partner Ledger) dihitung langsung dari item jurnal. Semua bisa dibandingkan dengan periode lain (laporan MIS), diunduh sebagai CSV, dan angka MIS bisa diklik sampai item jurnal pembentuknya.
- **Cara kerja**: definisi laporan ada di kode (`models/mis_templates.py`) dan dimuat oleh `nusara.mis.loader` setiap `nusara_base` dipasang atau diperbarui; instance bawaan untuk klien web Odoo ikut dibuat. UI membuat instance MIS sementara, memanggil `compute()`, lalu menghapusnya; drilldown memakai `drilldown(arg)`. Laporan yang diubah langsung di Odoo ditimpa saat pembaruan, jadi salin laporan lebih dulu bila ingin mengubahnya.
- **Pemeriksaan bawaan**: tiap template punya baris "harus 0" (akun laba rugi atau neraca yang belum terpetakan, selisih saldo kas) sehingga akun baru dengan kode di luar pemetaan langsung terlihat. Dijaga oleh `test_mis_reports.py` dan `scripts/check_p2p_api.py` (neraca seimbang, arus kas cocok dengan kas, neraca saldo seimbang dan sama dengan buku besar).
- **Temuan**: (1) rumus `balp[...]` tidak boleh memuat kurung siku bersarang, jadi daftar jenis akun ditulis sebagai tuple. (2) xmlid yang dibuat lewat kode dihapus Odoo di akhir pembaruan modul kecuali ditandai `noupdate`. (3) `l10n_id` menaruh pajak di jenis akun yang tidak terduga (PPN Masukan sebagai aset lancar, PPN Lebih Bayar bertipe piutang, PPN Terutang bertipe hutang), sehingga pemetaan memakai kode akun, bukan jenis akun. (4) Kas dan Bank tetap 0 selama pembayaran belum dicocokkan dengan mutasi bank; nilainya terlihat sebagai "Penerimaan dan Pembayaran Tertunda" di neraca dan arus kas. (5) Hari jatuh tempo pada umur piutang memakai `date_maturity` terhadap tanggal laporan, dan sisa tagihan sudah memperhitungkan pembayaran sebagian.
- **Belum**: Tax Report (PPN dan e-Faktur), Invoice Analysis, Analytic Report, Budget Report (`mis_builder_budget`), ekspor XLSX/PDF, filter analitik dan multi-perusahaan, jurnal penutup tahun, dan halaman Bank Transaction yang membuat kas tampil di neraca.
