# Lampiran (attachment) di KompakApps (Q58, D84)

Permintaan pemilik 20 Okt 2026: setiap form input punya fitur lampiran, mengikuti form Odoo yang memilikinya. Dokumen ini memuat hasil audit di Odoo (bukti dari instalasi dan data, bukan tebakan) dan hasil pekerjaannya di KompakApps.

## Bagian 1: audit di Odoo

**Mekanisme dasar**: semua lampiran adalah baris `ir.attachment` dengan `res_model` dan `res_id` (dan `res_field` kosong untuk lampiran biasa; `res_field` terisi untuk field biner seperti gambar). Mekanisme ini bekerja untuk model apa pun, termasuk yang tanpa `mail.thread`. Hak akses mengikuti hak pada record induknya.

| Mekanisme di Odoo | Bukti dari instalasi (`ir.model`, `ir.model.fields`) |
| --- | --- |
| **Chatter** (ikon klip pada pesan dan tombol lampiran): `message_post(attachment_ids=...)` memindahkan lampiran sementara (`res_model = mail.compose.message`, `res_id = 0`) ke record | 58 model punya `is_mail_thread` (termasuk mixin). Model dokumen bisnis: `account.move`, `account.payment`, `account.asset`, `account.journal`, `account.account`, `account.tax`, `account.analytic.account`, `sale.order`, `purchase.order`, `purchase.request`, `stock.picking`, `stock.scrap`, `stock.lot`, `mrp.production`, `mrp.bom`, `mrp.workcenter`, `mrp.unbuild`, `product.template`, `product.product`, `product.category`, `product.pricelist`, `res.partner`, `res.company`, `crm.lead`, `crm.team`, `pos.order`, `pos.session`, `loyalty.card`, `mis.budget`, `hr.employee`, `hr.department`, `hr.job`, `hr.version`, `hr.leave`, `hr.leave.allocation`, `hr.expense`, `hr.attendance` |
| **Lampiran utama** (`message_main_attachment_id`, untuk pratinjau dokumen di sisi kanan) | `account.move`, `account.payment`, `account.bank.statement.line`, `hr.employee`, `hr.expense`, `hr.leave` |
| **Field One2many/Many2many ke `ir.attachment`** | One2many: `account.move.attachment_ids`, `account.payment.attachment_ids`, `hr.expense.attachment_ids`, `hr.leave.attachment_ids`. Many2many: `account.bank.statement`, `mail.message`, `mail.activity`, `mail.template`, `mail.compose.message` |
| **Field biner gambar** (bukan lampiran) | `image_1920` dan turunannya pada `product.template`, `product.product` (`image_variant_*`), `res.partner`, `hr.employee`, `res.company` (logo) |
| **Dokumen terkait produk dan penawaran** | `product.document` dan `quotation.document` (lampiran yang ikut penawaran Sales; Odoo menaruhnya di tab Documents produk) |

**Data nyata** (DB pemilik, dibaca saja per 20 Okt 2026, `res_model` bukan `ir.*`): `payment.method` 458, `product.template` 35, `payment.provider` 24, `res.partner` 15, `hr.leave.type` 8, `spreadsheet.dashboard` 6, `onboarding.onboarding.step` 5, `hr.employee` 5, `res.lang` 3. Sebagian besar adalah gambar bawaan modul (metode pembayaran, penyedia, bahasa); yang dipakai pengguna adalah gambar `product.template` dan `res.partner` serta foto `hr.employee`. Belum ada lampiran dokumen bisnis; pemakaian dimulai dengan fitur ini.

## Bagian 2: tabel Form Odoo, mekanisme, halaman KompakApps, keadaan

Sebelum: hanya Expenses yang punya lampiran (D83). Setelah: bagian **Lampiran** ada di setiap halaman yang memanggil `chatterHtml` (semua dokumen dan master berikut), di halaman Mutasi Bank, dan sebagai catatan "simpan dahulu" pada formulir baru.

| Form Odoo (model) | Mekanisme di Odoo | Halaman KompakApps | Sesudah |
| --- | --- | --- | --- |
| Sales Order (`sale.order`), Quotation | chatter | Sales Orders | Lampiran + catatan berlampiran |
| Purchase Order (`purchase.order`), RFQ | chatter | Purchase Orders | sama |
| Purchase Request (`purchase.request`) | chatter | Purchase Request | sama |
| Faktur, Tagihan, Nota Kredit/Debit (`account.move`) | chatter + One2many + lampiran utama | Invoices, Bills, Credit/Debit Notes, Journal Entries | sama |
| Pembayaran (`account.payment`) | chatter + One2many | Payments | sama |
| Penerimaan, Pengiriman, Transfer (`stock.picking`) | chatter | Receipts, Deliveries, Transfers | sama |
| Scrap, Lot/Serial | chatter | Scrap, Lots | sama |
| Manufacturing Order, BoM, Work Center | chatter | Manufacturing Orders, Bill of Material, Work Centers | sama |
| Produk, Kategori, Daftar harga | chatter (gambar produk = field biner) | Product Master, Category, Pricelist | Lampiran dokumen; gambar produk belum |
| Mitra (`res.partner`) | chatter (gambar = field biner) | Customer, Vendor | Lampiran dokumen |
| Aset, Anggaran, Akun, Pajak, Jurnal, Analitik | chatter | halaman master (`createMasterPage`) | sama |
| CRM Lead dan Opportunity | chatter | Leads, Opportunities | sama |
| POS Order dan Sesi | chatter | POS Orders, POS Sessions | sama |
| Karyawan, Departemen, Posisi, Kontrak (`hr.version`) | chatter | Employees, Departments, Jobs, Contracts | sama |
| Cuti (`hr.leave`, `hr.leave.allocation`) | chatter + One2many | Time Off | sama |
| Biaya (`hr.expense`) | chatter + One2many (struk) | Expenses | Lampiran umum menggantikan unggah tunggal D83 |
| Mutasi Bank (`account.bank.statement.line`) | lampiran utama | Bank Transaction (detail mutasi) | Lampiran |
| Perusahaan, Pengguna | chatter pada perusahaan, tidak pada pengguna | Companies, Users | dilewati (pengaturan) |

**Dilewati dengan alasan**: Kasir/POS Station (terminal dan pengaturan), Physical Inventory (hitung stok), Attendance (catatan jam), Loyalty (pengaturan program), Settings, impor data, dan semua laporan; bukan formulir dokumen. Gambar produk, mitra, dan karyawan adalah field biner `image_*`, bukan lampiran; tidak diubah di sini.

## Rancangan

- `ui/live/attachments.js` (modul pembantu) dan kerangka HTML `attachmentsSectionHtml` di `common.js`; `chatterHtml` memasangnya di atas Aktivitas Terjadwal sehingga semua halaman berchatter mendapatkannya sekaligus. `loadMessages` mengisinya lewat pengait `setAttachmentHook` (pola sama dengan `activity.js`).
- Daftar: `ir.attachment` menurut `res_model`, `res_id`, `res_field = False` (nama, jenis lewat ikon, ukuran, pengunggah, waktu).
- Unggah banyak berkas (tombol atau seret-lepas) lewat `ir.attachment.create` JSON-2 dengan `datas` base64; pratinjau gambar dan PDF di tab baru lewat Blob; unduh lewat Blob; hapus dengan konfirmasi.
- Catatan chatter dengan lampiran: berkas diunggah sebagai lampiran sementara (`mail.compose.message`, `res_id` 0), lalu `message_post(attachment_ids=...)` memindahkannya ke record; lampiran juga tampil pada pesan.
- Batas: 25 MB per berkas di klien; berkas yang dapat dijalankan (exe, bat, cmd, com, scr, msi, vbs, jar, apk, sh, dll) ditolak dengan pesan. Nginx `/json/2/` naik dari 5m ke **40m** (base64 menambah sepertiga; 25 MB menjadi sekitar 33 MB). Kontainer `ui` perlu dibuat ulang dari folder repo agar batas baru berlaku (`docker compose up -d --force-recreate ui`).
- Formulir baru yang belum tersimpan menampilkan keterangan "simpan dahulu" (lampiran memerlukan `res_id`).
- Galat izin (403 atau AccessError) diterjemahkan menjadi pesan Indonesia; galat 413 menjadi pesan ukuran.
