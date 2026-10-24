# Hak akses per rekaman: siapa melihat dokumen siapa (Q9, D87)

Dokumen ini mencatat aturan akses yang berlaku di KompakApps: aturan record Odoo (`ir.rule`) per modul, aturan tambahan buatan `kompakapps_base`, dan cara mengaturnya per pengguna di **General Setting > Users & Access** sebagai **Cakupan data**. Isinya hasil audit pada instalasi segar (nama grup dan aturan dibaca dari database, bukan ditebak) dan diperbarui tiap irisan Q9.

## Prinsip

1. **UI selalu memakai hak pengguna yang masuk** (kunci API pengguna lewat JSON-2). Karena itu aturan record Odoo otomatis berlaku untuk daftar, form, hitungan (`search_count`, tombol statistik), pengelompokan (`formatted_read_group`: dashboard, laporan analisis, pipeline), dan akses langsung lewat alamat dokumen. Tidak ada penyaringan di sisi UI yang bisa dilewati.
2. **Cara aturan digabung**: aturan global (mis. multi-perusahaan) berlaku untuk semua pengguna dan digabung dengan AND. Aturan milik grup digabung dengan OR **hanya untuk grup yang dimiliki pengguna itu**. Akibatnya: (a) pengguna yang punya grup "sendiri" dan grup "semua" melihat semua; (b) menambah grup lain yang punya aturan lebih longgar melonggarkan cakupan (mis. peran Accounting Penagihan membuat semua faktur penjualan terlihat); (c) pengguna yang tidak punya grup yang beraturan sama sekali hanya dibatasi aturan global, jadi bisa melihat semua dokumen bila grupnya memberi hak model (ACL) pada modelnya.
3. **Akses ditolak tampil jelas**: membuka dokumen yang tidak boleh dilihat menampilkan kartu "Akses ditolak" dengan penjelasan dalam bahasa Indonesia (bukan layar kosong). Daftar yang terbatas menampilkan catatan "Cakupan data Anda: hanya dokumen milik Anda".
4. **Pengguna tanpa dokumen** (belum ada tim penjualan atau karyawan terkait) melihat daftar kosong, bukan galat; dokumen baru yang ia buat otomatis menjadi miliknya.
5. **Administrator** (centang di Users & Access) mendapat cakupan **Semua dokumen** secara otomatis. Administrator Odoo (`base.group_system`) mengatur sistem; akses ke dokumen modul tetap lewat peran modulnya (Manajer melihat semua).
6. Aturan Odoo bawaan tidak dilonggarkan. Penambahan KompakApps hanya berupa grup kecil dan aturan tambahan di `kompakapps_base`.

## Cakupan data di Users & Access

Bagian **Cakupan data** muncul di form pengguna bila pengguna punya peran pada aplikasinya. Pilihan hanya bisa diubah untuk peran terendah ("Salesperson"); Manajer dan Administrator otomatis Semua dokumen. Daftar pengguna menampilkan cakupannya, mis. "Sales dan CRM (dokumen sendiri)".

| Aplikasi | Peran yang bisa dibatasi | Pilihan | Grup yang ditulis | Irisan |
| --- | --- | --- | --- | --- |
| Sales dan CRM | Salesperson | Hanya dokumen sendiri / Semua dokumen | `sales_team.group_sale_salesman_all_leads` (ada = Semua) | 1 |
| Purchase dan Purchase Request | Pengguna | Hanya dokumen sendiri / Semua dokumen | `kompakapps_base.group_purchase_own` (ada = Sendiri) | 2 (menyusul) |
| Inventory | Pengguna | Gudang yang diizinkan | `res.users.kompakapps_warehouse_ids` | 3 (menyusul) |

Peran per aplikasi dipetakan ke grup bertingkat Odoo: peran lebih tinggi membawa peran di bawahnya secara tersirat (Manajer Sales membawa "Semua dokumen", yang membawa "Dokumen sendiri"). Pencabutan manajer mencabut grup manajernya saja; grup "semua dokumen" yang ditulis eksplisit ikut dicabut atau dipasang sesuai pilihan Cakupan data, jadi turun dari Manajer ke Salesperson "Sendiri" benar-benar membatasi (diuji).

## Audit aturan bawaan per modul

Kolom "Sumber rule" memakai ID eksternal Odoo. Semua tabel di bawah juga dibatasi aturan **multi-perusahaan** (global) dan, bila relevan, aturan portal untuk pengguna eksternal (tidak dibahas).

### Sales (Quotation, Sales Order, analisis penjualan)

| Peran (grup Odoo) | Apa yang terlihat | Sumber rule |
| --- | --- | --- |
| Salesperson: dokumen sendiri (`sales_team.group_sale_salesman`, ACL baca/tulis/buat) | Pesanan dan barisnya dengan `user_id` = dirinya **atau kosong** (belum punya penanggung jawab); sama untuk analisis penjualan `sale.report` | `sale.sale_order_personal_rule`, `sale.sale_order_line_personal_rule`, `sale.sale_order_report_personal_rule` |
| Salesperson: semua dokumen (`sales_team.group_sale_salesman_all_leads`) | Semua pesanan | `sale.sale_order_see_all`, `sale.sale_order_line_see_all`, `sale.sale_order_report_see_all` |
| Manajer Sales (`sales_team.group_sale_manager`; ACL penuh) | Semua (membawa "semua dokumen") | idem |
| Inventory Pengguna, Manufacture Pengguna, Accounting Penagihan (ACL baca/tulis pada `sale.order`, tanpa grup Sales) | **Semua pesanan**: tidak ada aturan grup untuk mereka, jadi hanya aturan global yang berlaku. Perilaku bawaan Odoo (mereka memproses pengiriman dan penagihan atas pesanan siapa pun); tidak diperketat | `sale_stock.sale_order_line_rule_stock_user` (baris, baca) |
| Pengguna internal tanpa peran di atas | Tidak ada akses ke Sales Order | tanpa ACL |

Catatan: pesanan tanpa penanggung jawab terlihat dan bisa diubah oleh semua penjual "sendiri". Penjual yang juga punya peran Inventory/Accounting tetap dibatasi aturan grup Sales miliknya pada Sales Order.

### CRM (lead dan peluang)

CRM Odoo memakai grup Sales yang sama; tidak ada grup CRM terpisah. Lihat juga tim penjualan (`crm.team`).

| Peran | Apa yang terlihat | Sumber rule |
| --- | --- | --- |
| Salesperson: dokumen sendiri | Lead dan peluang dengan `user_id` = dirinya atau kosong; pipeline, dashboard CRM, dan laporan CRM menghitung hanya itu | `crm.crm_rule_personal_lead` |
| Salesperson: semua dokumen dan Manajer | Semua lead dan peluang | `crm.crm_rule_all_lead` |
| Tim penjualan (`crm.team`) | Penjual "sendiri" melihat semua tim (hanya aturan global); "semua dokumen" punya aturan eksplisit semua tim | `sales_team.crm_rule_all_salesteam` |

Lead multi-perusahaan tanpa perusahaan (`company_id` kosong) tetap terlihat (`crm.crm_lead_company_rule`).

### Faktur penjualan dan pelanggan

| Objek | Peran | Apa yang terlihat | Sumber rule |
| --- | --- | --- | --- |
| Faktur dan nota kredit pelanggan (`account.move` out_invoice, out_refund) dan barisnya | Salesperson: dokumen sendiri (ACL baca) | Hanya faktur penjualan dengan `invoice_user_id` = dirinya atau kosong; **bukan** tagihan vendor atau jurnal lain | `sale.account_invoice_rule_see_personal`, `sale.account_invoice_line_rule_see_personal` |
| idem | Salesperson: semua dokumen dan Manajer | Semua faktur dan nota kredit pelanggan (bukan tagihan vendor) | `sale.account_invoice_rule_see_all`, `sale.account_invoice_line_rule_see_all` |
| idem | Accounting Penagihan, Akuntan, Advisor | Semua jurnal, faktur, tagihan (aturan grup digabung OR, jadi melonggarkan cakupan Sales) | `account.account_move_see_all`, `account.account_move_rule_group_invoice` |
| Pelanggan (`res.partner`) | Semua pengguna internal | **Semua pelanggan dan pemasok** (master bersama lintas modul: Sales, Purchase, Accounting, POS). Odoo tidak membatasi kontak per penjual dan KompakApps sengaja tidak menambahkannya: pembatasan akan merusak pembelian dan akuntansi. Aturan perusahaan (`base.res_partner_rule`) tetap berlaku | `base.res_partner_rule` |

Faktur yang dibuat dari Sales Order mewarisi penjualnya (`invoice_user_id`); faktur manual mewarisi pembuatnya.

### Purchase dan Purchase Request

Keadaan bawaan, sebelum irisan 2: **tidak ada aturan "sendiri" pada Purchase Order**; semua pengguna Purchase melihat semua PO, penerimaan barang, dan tagihan vendor. Purchase Request sudah dibatasi bawaan OCA.

| Objek | Peran | Apa yang terlihat | Sumber rule |
| --- | --- | --- | --- |
| Purchase Order dan barisnya | Purchase Pengguna dan Manajer (ACL penuh) | Semua PO perusahaan | hanya aturan perusahaan (`purchase.purchase_order_comp_rule`) |
| Tagihan vendor (`account.move` in_invoice, in_refund, in_receipt) | Purchase Pengguna | Semua tagihan vendor (bukan faktur pelanggan) | `purchase.purchase_user_account_move_rule` |
| Purchase Request dan barisnya | Purchase Request Pengguna | Hanya PR dengan `requested_by` = dirinya, ditambah PR yang ia ikuti (follower) | `purchase_request.purchase_request_rule`, `purchase_request.purchase_request_followers_rule` (dan versi baris) |
| idem | Purchase Request Manajer | Semua PR | `purchase_request.purchase_request_manager_rule` |

### Inventory, Manufacture, POS

| Objek | Peran | Apa yang terlihat | Sumber rule |
| --- | --- | --- | --- |
| Transfer (penerimaan, pengiriman), gerakan, stok on-hand, lokasi, gudang | Inventory Pengguna dan Manajer | Semua gudang perusahaan (belum ada pembatasan per gudang; irisan 3) | hanya aturan perusahaan (`stock.stock_picking_rule`, `stock.stock_move_rule`, `stock.stock_quant_rule`, `stock.stock_location_comp_rule`, `stock.stock_warehouse_comp_rule`) |
| Perintah produksi | Manufacture Pengguna | Semua MO perusahaan | `mrp.mrp_production_rule` |
| Pesanan POS | Kasir dan Manajer POS | Semua pesanan POS perusahaan | `point_of_sale.rule_pos_multi_company` |

### Human Resources dan Payroll (audit awal; dirinci dan diuji pada irisan 3)

| Objek | Peran | Apa yang terlihat | Sumber rule |
| --- | --- | --- | --- |
| Karyawan | Petugas HR (ACL penuh) | Karyawan perusahaan yang diizinkan (aturan perusahaan tetap menampilkan dirinya, atasan, dan bawahannya lintas perusahaan). Pengguna tanpa peran HR tidak punya hak baca pada data karyawan lengkap | `hr.hr_employee_comp_rule` |
| Kehadiran | Peran Attendance Odoo bertingkat: baca milik sendiri, kelola karyawan yang ia atur, atau semua | Sendiri, kelolaan, atau semua | `hr_attendance.hr_attendance_rule_attendance_simple_user`, `..._manager_restrict`, `..._attendance_admin` |
| Cuti dan alokasi | Karyawan: milik sendiri; Penyetuju tim: karyawan yang ia setujui; Petugas dan Administrator: semua | Sendiri, tim, atau semua | `hr_holidays.hr_leave_rule_employee`, `..._responsible_read`, `..._user_read`, `..._manager` (dan aturan alokasi) |
| Biaya karyawan | Karyawan: milik sendiri; Penyetuju tim: tim; Petugas dan Administrator: semua | Sendiri, tim, atau semua | `hr_expense.ir_rule_hr_expense_employee`, `..._approver`, `..._manager` |
| Slip gaji dan baris slip | Petugas dan Manajer Payroll: semua; karyawan: slipnya sendiri yang selesai (Slip Saya) | Semua atau sendiri | `payroll.hr_payroll_rule_officer` (dilebarkan D86), `payroll.hr_payslip_rule_manager`, `kompakapps_base.kompakapps_payslip_rule_self` |

Hak Payroll dan Slip Saya diputuskan di D86 dan tidak diubah oleh Q9.

### Accounting (audit saja; tidak diperketat)

| Objek | Peran | Apa yang terlihat | Sumber rule |
| --- | --- | --- | --- |
| Jurnal, item jurnal, faktur, tagihan | Accounting Penagihan, Akuntan, Advisor | Semua jurnal dan item perusahaan | `account.account_move_see_all`, `account.account_move_line_see_all` |
| idem | Accounting Hanya baca | Semua, baca saja | `account.account_move_rule_group_readonly` |
| Jurnal dan faktur | Penyetuju tim Expenses, Kasir POS, Purchase Pengguna | Hanya yang terkait (biaya karyawan, faktur pesanan POS, tagihan vendor) | `hr_expense.hr_expense_team_approver_account_move_rule`, `point_of_sale.rule_invoice_pos_user`, `purchase.purchase_user_account_move_rule` |
| Pembayaran, mutasi bank | Accounting Penagihan | Semua pembayaran dan mutasi perusahaan | hanya aturan perusahaan |

Laporan keuangan (neraca, laba rugi, buku besar) dibaca dengan hak Accounting; tidak ada pembatasan per pengguna di atas jurnal, dan Q9 tidak menambahkannya tanpa dasar.

## Temuan dan keterbatasan

- **Pelanggan dan pemasok tidak dibatasi per penjual atau pembeli** (lihat di atas). Bila suatu saat diperlukan, jalurnya adalah aturan pada `res.partner` berbasis penjual, tetapi harus diuji terhadap Purchase, Accounting, dan POS lebih dulu.
- **Pesanan tanpa penanggung jawab** terlihat oleh semua penjual "sendiri". Ini perilaku bawaan Odoo dan dipertahankan agar permintaan masuk tanpa penjual tetap terlihat.
- **Aturan grup digabung OR**: pengguna yang diberi banyak peran melihat gabungan cakupannya. Contoh yang diuji: Salesperson "sendiri" yang juga Accounting Penagihan melihat semua faktur penjualan.
- **Peran Inventory, Manufacture, dan Accounting Penagihan melihat semua Sales Order** karena hak model Odoo tanpa aturan grup; tidak diperketat karena mereka memprosesnya.
- Pesan galat Odoo berbahasa Inggris untuk penolakan akses diganti kalimat Indonesia di UI (`ui/live/odoo.js`); rincian teknis tetap ada di respons API.

## Pembuktian

- Test Odoo `TestAccessScopeSales` (`addons/kompakapps_base/tests/test_access_scope.py`): daftar, `search_count`, `formatted_read_group`, akses langsung ke ID orang lain (baca, ubah, hapus, batalkan) ditolak, analisis penjualan, faktur, peluang, pelanggan bersama, pengguna tanpa peran, dan perintah grup yang dipakai Users & Access.
- Skrip regresi `scripts/check_p2p_api.py` (`check_access_scope`): dua penjual "sendiri" dan satu "semua" dengan API key sementara dari `scripts/access_test_users.py`, buat dan hapus lewat `odoo shell`.
- Uji browser dengan pengguna terbatas: daftar hanya miliknya, membuka dokumen orang lain menampilkan kartu "Akses ditolak", dan Users & Access menulis grup yang benar.
