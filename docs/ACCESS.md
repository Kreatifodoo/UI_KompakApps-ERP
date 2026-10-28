# Hak akses per rekaman: siapa melihat dokumen siapa (Q9, D87)

Dokumen ini mencatat aturan akses yang berlaku di KompakApps: aturan record Odoo (`ir.rule`) per modul, aturan tambahan buatan `kompakapps_base`, dan cara mengaturnya per pengguna di **General Setting > Users & Access** sebagai **Cakupan data**. Isinya hasil audit pada instalasi segar (nama grup dan aturan dibaca dari database, bukan ditebak) dan diperbarui tiap irisan Q9 (irisan 1: Sales dan CRM; 2: Purchase; 3: Inventory per gudang serta audit HR dan Accounting).

## Prinsip

1. **UI selalu memakai hak pengguna yang masuk** (kunci API pengguna lewat JSON-2). Karena itu aturan record Odoo otomatis berlaku untuk daftar, form, hitungan (`search_count`, tombol statistik), pengelompokan (`formatted_read_group`: dashboard, laporan analisis, pipeline), dan akses langsung lewat alamat dokumen. Tidak ada penyaringan di sisi UI yang bisa dilewati.
2. **Cara aturan digabung**: aturan global (mis. multi-perusahaan) berlaku untuk semua pengguna dan digabung dengan AND. Aturan milik grup digabung dengan OR **hanya untuk grup yang dimiliki pengguna itu**. Akibatnya: (a) pengguna yang punya grup "sendiri" dan grup "semua" melihat semua; (b) menambah grup lain yang punya aturan lebih longgar melonggarkan cakupan (mis. peran Accounting Penagihan membuat semua faktur penjualan terlihat); (c) pengguna yang tidak punya grup yang beraturan sama sekali hanya dibatasi aturan global, jadi bisa melihat semua dokumen bila grupnya memberi hak model (ACL) pada modelnya.
3. **Akses ditolak tampil jelas**: membuka dokumen yang tidak boleh dilihat menampilkan kartu "Akses ditolak" dengan penjelasan dalam bahasa Indonesia (bukan layar kosong). Daftar yang terbatas menampilkan catatan "Cakupan data Anda: hanya dokumen milik Anda".
4. **Pengguna tanpa dokumen** (belum ada tim penjualan atau karyawan terkait) melihat daftar kosong, bukan galat; dokumen baru yang ia buat otomatis menjadi miliknya.
5. **Administrator** (centang di Users & Access) mendapat cakupan **Semua dokumen** dan **Semua gudang** secara otomatis. Administrator Odoo (`base.group_system`) mengatur sistem; akses ke dokumen modul tetap lewat peran modulnya (Manajer melihat semua dokumen Sales dan Purchase). Pembatasan gudang Inventory sengaja juga bisa dikenakan pada Manajer Inventory (kepala gudang), karena hanya Manajer yang boleh membaca nilai stok; Administrator tidak pernah dibatasi.
6. Aturan Odoo bawaan tidak dilonggarkan. Penambahan KompakApps hanya berupa grup kecil dan aturan tambahan di `kompakapps_base`.

## Cakupan data di Users & Access

Bagian **Cakupan data** muncul di form pengguna bila pengguna punya peran pada aplikasinya. Untuk Sales dan Purchase pilihan hanya bisa diubah untuk peran terendah ("Salesperson", "Pengguna"); Manajer dan Administrator otomatis Semua dokumen. Untuk Inventory pemilihnya berupa **daftar gudang** (kosong = semua) bagi peran Pengguna dan Manajer; Administrator otomatis semua gudang. Peran HR dan Accounting punya cakupan bawaan Odoo yang tidak diatur per pengguna; petunjuk di bawah pemilih peran menjelaskan apa yang terlihat tiap peran. Daftar pengguna menampilkan cakupannya, mis. "Sales dan CRM (dokumen sendiri)" atau "Inventory (gudang: Gudang Surabaya)".

| Aplikasi | Peran yang bisa dibatasi | Pilihan | Grup yang ditulis | Irisan |
| --- | --- | --- | --- | --- |
| Sales dan CRM | Salesperson | Hanya dokumen sendiri / Semua dokumen | `sales_team.group_sale_salesman_all_leads` (ada = Semua) | 1 |
| Purchase dan Purchase Request | Pengguna | Hanya dokumen sendiri / Semua dokumen | `kompakapps_base.group_purchase_own` (ada = Sendiri) | 2 |
| Inventory | Pengguna dan Manajer | Gudang yang diizinkan (kosong = semua gudang) | `res.users.kompakapps_warehouse_ids` (daftar gudang di pengguna, bukan grup) | 3 |
| Attendance, Time Off, Expenses, Accounting | semua peran | Tidak ada pemilih: cakupan mengikuti peran Odoo (lihat tabel HR dan Accounting) | grup peran | 3 (audit, petunjuk di UI) |

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

Bawaan Odoo: **tidak ada aturan "sendiri" pada Purchase Order**; semua pengguna Purchase melihat semua PO, penerimaan barang, dan tagihan vendor, dan Purchase Request Pengguna sudah dibatasi bawaan OCA. KompakApps menambah grup penanda **`kompakapps_base.group_purchase_own`** ("Purchase: hanya dokumen sendiri") yang membatasi hanya pemegangnya (Users & Access > Cakupan data > Hanya dokumen sendiri). Pengguna tanpa grup ini, Manajer Purchase, dan Administrator tetap melihat semua. Aturan ada di `security/access_scope.xml`.

| Objek | Peran | Apa yang terlihat | Sumber rule |
| --- | --- | --- | --- |
| Purchase Order, barisnya, dan analisis pembelian | Purchase Pengguna **tanpa** grup penanda | Semua PO perusahaan (bawaan) | hanya aturan perusahaan |
| idem | Purchase Pengguna **dengan** grup penanda | Hanya PO dengan `user_id` (pembeli) = dirinya; PO tanpa pembeli tersembunyi | `kompakapps_base.kompakapps_purchase_order_rule_own`, `..._order_line_rule_own`, `..._purchase_report_rule_own` |
| idem | Manajer Purchase dan Administrator (walau keliru diberi grup penanda) | Semua | `kompakapps_base.kompakapps_purchase_order_rule_all` (dan baris, analisis) |
| Penerimaan barang (`stock.picking`), gerakan stok, dan detailnya | Pemegang grup penanda | Penerimaan dari PO milik pembeli lain **tersembunyi**; transfer tanpa PO (internal, pengiriman, penerimaan manual) tetap terlihat | `kompakapps_base.kompakapps_picking_rule_purchase_own`, `..._stock_move_rule_purchase_own`, `..._stock_move_line_rule_purchase_own` |
| idem | Manajer Purchase dan Administrator | Semua | `kompakapps_base.kompakapps_picking_rule_purchase_all` (dan gerakan, detail) |
| Tagihan vendor (`account.move` in_invoice, in_refund, in_receipt) dan item jurnalnya | Purchase Pengguna tanpa grup penanda | Semua tagihan vendor (bawaan; bukan faktur pelanggan) | `purchase.purchase_user_account_move_rule` dan `..._line_rule` |
| idem | Pemegang grup penanda (bukan manajer atau administrator) | Hanya tagihan dari PO miliknya atau yang ia buat sendiri | domain aturan bawaan yang sama, **diperketat** oleh `ir.rule.kompakapps_apply_purchase_scope` (menulis ulang tiap install dan upgrade karena aturan bawaan berada di data noupdate modul purchase) |
| idem | Accounting Penagihan, Akuntan, Advisor | Semua tagihan (aturan grup digabung OR) | `account.account_move_see_all` |
| Purchase Request dan barisnya | Purchase Request Pengguna | Hanya PR dengan `requested_by` = dirinya, ditambah PR yang ia ikuti (follower) | `purchase_request.purchase_request_rule`, `purchase_request.purchase_request_followers_rule` (dan versi baris) |
| idem | Purchase Request Manajer | Semua PR | `purchase_request.purchase_request_manager_rule` |
| idem | Pengguna Purchase **tanpa** peran Purchase Request (ACL baca) | Semua PR (bawaan) | hanya aturan perusahaan |
| idem | Pemegang grup penanda | Hanya PR yang ia ajukan | `kompakapps_base.kompakapps_purchase_request_rule_own` (dan `..._line_rule_own`) |

Alur P2P untuk pembeli "sendiri" (diuji): ia mengonfirmasi PO miliknya, menerima barangnya, dan membuat tagihan dari PO itu; hanya dokumen turunan PO miliknya yang terlihat. Dua hal yang bukan akibat Cakupan data tetapi perlu peran lain (bawaan Odoo): **menerima barang** butuh peran Inventory (validasi penerimaan membaca referensi stok yang menyentuh Sales Order) dan **memposting tagihan** butuh Accounting Penagihan.

### Inventory per gudang (irisan 3), Manufacture, POS

Bawaan Odoo: semua pengguna Inventory melihat semua gudang perusahaan (hanya aturan multi-perusahaan). KompakApps menambah **field `res.users.kompakapps_warehouse_ids`** ("Gudang yang diizinkan"; Users & Access > Cakupan data Inventory) dan sekumpulan aturan **global** (tanpa grup) di `security/access_scope.xml` yang membaca field itu. Aturan global digabung AND dengan aturan lain, jadi aturan "hanya PO sendiri" milik `group_purchase_own` tidak dilonggarkan. Domain aturan kosong (tidak membatasi) bila pengguna tidak punya gudang terpilih (**kosong = semua**) atau Administrator (`base.group_system`); selain itu berlaku untuk semua peran, termasuk Manajer Inventory (kepala gudang). Pengguna membaca daftar gudangnya sendiri (`SELF_READABLE_FIELDS`) untuk catatan di UI; mengubahnya hak administrator. Perubahan field membersihkan cache aturan (`_get_invalidation_fields`), jadi berlaku seketika.

"Terkait gudang" berarti: gudang dari **tipe operasi**, **lokasi asal**, atau **lokasi tujuan** dokumen. Dokumen terlihat bila salah satunya gudang pengguna, atau bila sama sekali tidak menyentuh gudang (mis. dropship pemasok ke pelanggan). Transfer antar gudang (A ke B) terlihat oleh pengguna kedua gudang dan bisa divalidasi oleh pengguna gudang asal.

| Objek | Apa yang terlihat bagi pengguna dengan gudang terpilih | Sumber rule |
| --- | --- | --- |
| Transfer (penerimaan, pengiriman, internal) | Hanya yang terkait gudangnya; membuka, mengubah, membatalkan, memvalidasi, atau membuat transfer di gudang lain ditolak | `kompakapps_base.kompakapps_picking_rule_warehouse` |
| Gerakan stok dan detail gerakan | Hanya yang terkait gudangnya (riwayat pergerakan, laporan) | `..._stock_move_rule_warehouse`, `..._stock_move_line_rule_warehouse` |
| Stok on-hand (`stock.quant`), hitungan fisik, penyesuaian stok | Hanya quant di lokasi gudangnya (dan lokasi tanpa gudang); jumlah tersedia produk, laporan stok, dan pengelompokan ikut terbatas; mengubah hitungan atau membuat penyesuaian di gudang lain ditolak | `..._stock_quant_rule_warehouse` |
| Scrap | Hanya scrap di lokasi gudangnya; scrap di gudang lain ditolak | `..._stock_scrap_rule_warehouse` |
| Tipe operasi, gudang, lokasi | Gudang dan lokasi gudang lain disembunyikan dari pilihan (tipe operasi tanpa gudang dan lokasi tanpa gudang tetap terlihat) | `..._picking_type_rule_warehouse`, `..._stock_warehouse_rule_warehouse`, `..._stock_location_rule_warehouse` |

Penambal: mode inventaris Odoo membuat quant sebagai superuser (penghitungan fisik dan penyesuaian langsung), yang melewati aturan record; `models/stock_quant.py` memeriksa ulang quant yang dibuat dengan hak pengguna dan membatalkan seluruh transaksi bila ada di gudang yang tidak diizinkan (diuji lewat API dan Odoo, termasuk `inventory_quantity_auto_apply`).

Tidak dibatasi per gudang (data referensi atau di luar cakupan irisan ini): rute dan aturan stok (`stock.route`, `stock.rule`), aturan stok minimum (`stock.warehouse.orderpoint`), lot dan serial, kemasan, Manufacturing Order (hanya gerakan stoknya yang ikut terbatas), valuasi dan jurnal persediaan (hak Accounting).

| Objek | Peran | Apa yang terlihat | Sumber rule |
| --- | --- | --- | --- |
| Perintah produksi | Manufacture Pengguna | Semua MO perusahaan | `mrp.mrp_production_rule` |
| Pesanan POS | Kasir dan Manajer POS | Semua pesanan POS perusahaan | `point_of_sale.rule_pos_multi_company` |

### Human Resources dan Payroll (audit irisan 3)

Odoo memetakan Attendance, Time Off, dan Expenses ke peran **bertingkat**: pengguna internal tanpa peran (`base.group_user`, "Role / User") hanya mengakses data **miliknya**; peran di atasnya menambah **tim** atau **semua**. Nama grup dan aturan di bawah dibaca dari database (`ir.rule` dan `res.groups`), dan tiap baris dibuktikan oleh `TestAccessScopeHR`. Di Users & Access peran dipilih per aplikasi (label dan petunjuk di bawah pemilih peran menjelaskan cakupannya); cakupan "tim" ditentukan di data karyawan (pengelola kehadiran, penyetuju cuti, penyetuju biaya, atasan departemen), bukan di Users & Access.

| Objek | Peran di Users & Access (grup Odoo) | Apa yang terlihat | Sumber rule |
| --- | --- | --- | --- |
| Kehadiran (`hr.attendance`) | Tanpa peran (`base.group_user` membawa `hr_attendance.group_hr_attendance_own_reader`) | Hanya kehadirannya sendiri (baca) | `hr_attendance.hr_attendance_rule_attendance_simple_user` |
| idem | Petugas (`group_hr_attendance_officer`, "Officer: Manage attendances"), butuh peran ini untuk halaman Attendance di UI | Kehadiran karyawan yang **ia kelola** (field "Attendance Manager" di karyawan) ditambah miliknya; **bukan** semua karyawan | `hr_attendance.hr_attendance_rule_attendance_manager_restrict` |
| idem | Manajer (`group_hr_attendance_manager`, membawa "Manage all attendances") | Semua kehadiran | `hr_attendance.hr_attendance_rule_attendance_admin` |
| Cuti (`hr.leave`) dan alokasi | Tanpa peran | Hanya cuti dan alokasinya sendiri; mengubah selama belum disetujui | `hr_holidays.hr_leave_rule_employee` (dan `_update`, `_unlink`), `hr_leave_allocation_rule_employee` |
| idem | Penyetuju tim (`group_hr_holidays_responsible`) | Cuti karyawan yang ia setujui (field "Time Off" pada karyawan) ditambah miliknya | `hr_holidays.hr_leave_rule_responsible_read`, `..._update` |
| idem | Petugas (`group_hr_holidays_user`) | Semua cuti dan alokasi; **membawa Petugas HR** (data semua karyawan) secara tersirat | `hr_holidays.hr_leave_rule_user_read`, `..._officer_update` |
| idem | Administrator (`group_hr_holidays_manager`) | Semua, plus pengaturan jenis cuti | `hr_holidays.hr_leave_rule_manager` |
| Biaya (`hr.expense`) | Tanpa peran | Hanya biayanya sendiri (draft bisa diubah; yang diajukan hanya dibaca) | `hr_expense.ir_rule_hr_expense_employee`, `..._employee_not_draft` |
| idem | Penyetuju tim (`group_hr_expense_team_approver`) | Biaya karyawan yang atasan departemennya, atasannya, atau penyetuju biayanya adalah dirinya, ditambah miliknya | `hr_expense.ir_rule_hr_expense_approver` |
| idem | Petugas (`group_hr_expense_user`, "All Approver"), Administrator, dan **Akuntan Accounting** (`account.group_account_user`) | Semua biaya | `hr_expense.ir_rule_hr_expense_manager` |
| Karyawan (`hr.employee`) | Petugas HR (`hr.group_hr_user`) dan Administrator HR | Karyawan perusahaan yang diizinkan; pengguna tanpa peran HR tidak punya hak baca `hr.employee` penuh | `hr.hr_employee_comp_rule` (global) |
| Slip gaji dan baris slip | Petugas dan Manajer Payroll: semua; karyawan: slipnya sendiri yang selesai (Slip Saya) | Semua atau sendiri | `payroll.hr_payroll_rule_officer` (dilebarkan D86), `payroll.hr_payslip_rule_manager`, `kompakapps_base.kompakapps_payslip_rule_self` |

Hak Payroll dan Slip Saya diputuskan di D86 dan tidak diubah oleh Q9. Semua tabel HR juga dibatasi aturan multi-perusahaan.

Di UI, daftar Attendance, Time Off, dan Expenses menampilkan catatan "Cakupan data Anda: hanya ... milik Anda" (ditambah tim bila punya peran tim) bagi pengguna yang tidak punya peran "semua" (`scopeNote` jenis `attendance`, `leave`, `expense` di `ui/live/common.js`).

### Accounting (audit saja; tidak diperketat)

Cakupan Accounting **tidak dibatasi per pengguna**: peran Accounting melihat seluruh jurnal perusahaan, dan Q9 tidak menambahkan pembatasan tanpa dasar (laporan keuangan dan rekonsiliasi memerlukan data utuh). Yang perlu diketahui: (a) aturan grup digabung OR, jadi peran Accounting **melonggarkan** Cakupan data Sales dan Purchase (semua faktur penjualan dan tagihan vendor terlihat); (b) pengguna tanpa peran Accounting tidak bisa membuka jurnal, faktur, atau tagihan kecuali lewat aturan khusus yang dipetakan di bawah. Diuji oleh `TestAccessScopeHR`.

| Objek | Peran (grup Odoo) | Apa yang terlihat | Sumber rule |
| --- | --- | --- | --- |
| Jurnal, item jurnal, faktur, tagihan | Penagihan (`account.group_account_invoice`), Akuntan (`group_account_user`, "Bookkeeper"), Advisor (`group_account_manager`) | Semua jurnal dan item perusahaan (baca dan tulis) | `account.account_move_see_all`, `account.account_move_rule_group_invoice`, `account.account_move_line_see_all` |
| idem | Hanya baca (`account.group_account_readonly`) | Semua, baca saja; menulis ditolak | `account.account_move_rule_group_readonly` |
| Jurnal dan faktur | Penyetuju tim Expenses, Kasir POS, Purchase Pengguna, Salesperson | Hanya yang terkait (jurnal biaya karyawan, faktur pesanan POS, tagihan vendor, faktur penjualan); Purchase dan Sales mengikuti Cakupan data masing-masing | `hr_expense.hr_expense_team_approver_account_move_rule`, `point_of_sale.rule_invoice_pos_user`, `purchase.purchase_user_account_move_rule`, `sale.account_invoice_rule_see_personal` |
| Pembayaran, mutasi bank, analitik, aset | Peran Accounting | Semua (hanya aturan perusahaan; analitik punya aturan "semua" untuk Penagihan) | `account.account_payment_comp_rule`, `account.account_bank_statement_comp_rule`, `account.account_analytic_line_rule_billing_user` |
| Pengguna tanpa peran Accounting (termasuk Penyetuju tim Expenses) | - | Tidak ada akses ke jurnal, faktur, dan tagihan di luar aturan khusus di atas | tanpa ACL |

Laporan keuangan (neraca, laba rugi, buku besar) dibaca dengan hak Accounting; tidak ada pembatasan per pengguna di atas jurnal, dan Q9 tidak menambahkannya tanpa dasar.

## Temuan dan keterbatasan

- **Pelanggan dan pemasok tidak dibatasi per penjual atau pembeli** (lihat di atas). Bila suatu saat diperlukan, jalurnya adalah aturan pada `res.partner` berbasis penjual, tetapi harus diuji terhadap Purchase, Accounting, dan POS lebih dulu.
- **Pesanan tanpa penanggung jawab** terlihat oleh semua penjual "sendiri". Ini perilaku bawaan Odoo dan dipertahankan agar permintaan masuk tanpa penjual tetap terlihat.
- **Purchase Request**: aturan "sendiri" memakai pengaju (`requested_by`), bukan penerima tugas (`assigned_to`), mengikuti keputusan Q9 dan agar tidak melonggarkan aturan OCA; pembeli yang perlu mengubah PR orang lain menjadi RFQ harus tidak dibatasi (tanpa grup penanda) atau Manajer. PO tanpa pembeli tersembunyi dari pembeli "sendiri" (hanya terlihat oleh yang tidak dibatasi).
- **Aturan grup digabung OR**: pengguna yang diberi banyak peran melihat gabungan cakupannya. Contoh yang diuji: Salesperson "sendiri" yang juga Accounting Penagihan melihat semua faktur penjualan.
- **Peran Inventory, Manufacture, dan Accounting Penagihan melihat semua Sales Order** karena hak model Odoo tanpa aturan grup; tidak diperketat karena mereka memprosesnya.
- **Inventory per gudang**: (a) memilih gudang untuk pengguna yang bekerja di beberapa perusahaan harus mencakup gudang tiap perusahaannya, karena pengguna dengan gudang terpilih tidak melihat dokumen gudang mana pun yang tidak dipilih (termasuk di perusahaan lain); (b) transfer manual antar gudang A ke B terlihat oleh pengguna kedua gudang; (c) menghapus gudang satu-satunya yang dipilih mengosongkan daftar sehingga pengguna kembali melihat semua; (d) aturan stok minimum, rute, lot, dan Manufacturing Order tidak dibatasi (lihat bagian Inventory); (e) Laporan Stok per produk dan Physical Inventory di UI membaca nilai stok (`stock.quant.value`, hanya Manajer Inventory) dan jurnal akun Persediaan, sehingga Pengguna Inventory biasa sudah ditolak sebelum Q9 (bukan akibat pembatasan gudang); Manajer Inventory yang dibatasi per gudang melihat laporan itu hanya untuk gudangnya, dengan catatan cakupan (Laporan Stok per produk tetap butuh peran Accounting untuk membaca saldo buku besar).
- **Time Off Petugas membawa Petugas HR** (data semua karyawan) secara tersirat; **Attendance Petugas** hanya melihat karyawan yang ia kelola (bukan semua): beri peran Manajer Attendance bagi yang perlu melihat semua. Pengguna tanpa peran Attendance membaca kehadirannya sendiri lewat API, tetapi halaman Attendance di UI membaca data karyawan sehingga memerlukan peran Attendance.
- **Akuntan Accounting melihat semua biaya karyawan** (`hr_expense.ir_rule_hr_expense_manager`), walau tanpa peran Expenses.
- Pesan galat Odoo berbahasa Inggris untuk penolakan akses diganti kalimat Indonesia di UI (`ui/live/odoo.js`); rincian teknis tetap ada di respons API.

## Pembuktian

- Test Odoo `TestAccessScopeInventory` (14 test): transfer, gerakan, dan detail gerakan per gudang (termasuk transfer antar gudang dan transfer tanpa gudang), hitungan dan pengelompokan, baca/ubah/batalkan/validasi/hapus dokumen gudang lain ditolak, membuat transfer di gudang lain ditolak, gudang dan lokasi gudang lain tersembunyi dari pilihan, pengguna menjalankan penerimaan, pengiriman, dan transfer antar gudang dari gudangnya, jumlah on-hand produk dan quant per gudang, penyesuaian dan penghitungan langsung di gudang lain ditolak (termasuk jalur superuser mode inventaris) dan scrap di gudang lain ditolak, tanpa gudang terpilih dan Administrator melihat semua sedangkan Manajer Inventory dengan gudang tetap dibatasi, perubahan pilihan gudang berlaku seketika (cache aturan), pengguna membaca daftar gudangnya sendiri tetapi tidak mengubahnya, kombinasi dengan `group_purchase_own` dan Manajer Purchase tidak saling melonggarkan, dan perintah Users & Access.
- Test Odoo `TestAccessScopeHR` (4 test): kehadiran (sendiri, kelolaan, semua), cuti (sendiri, penyetuju tim, semua; Petugas Time Off membawa Petugas HR), biaya (sendiri, penyetuju tim, Petugas dan Akuntan semua), dan Accounting (peran Accounting melihat semua jurnal, Hanya baca tidak bisa menulis, pengguna tanpa peran Accounting tidak bisa membuka).
- Test Odoo `TestAccessScopePurchase` (8 test): PO, baris, hitungan, pengelompokan, analisis, baca/ubah/batalkan/hapus PO pembeli lain ditolak, tanpa grup penanda dan manajer dan administrator melihat semua, Purchase Request, penerimaan, gerakan stok, dan tagihan dari PO ikut pemilik PO, pembeli menjalankan konfirmasi sampai tagihan, tagihan manual, serta perintah grup Users & Access.
- Test Odoo `TestAccessScopeSales` (`addons/kompakapps_base/tests/test_access_scope.py`): daftar, `search_count`, `formatted_read_group`, akses langsung ke ID orang lain (baca, ubah, hapus, batalkan) ditolak, analisis penjualan, faktur, peluang, pelanggan bersama, pengguna tanpa peran, dan perintah grup yang dipakai Users & Access.
- Skrip regresi `scripts/check_p2p_api.py` (`check_access_scope`, `check_access_scope_purchase`, `check_access_scope_inventory` 22 pemeriksaan, `check_access_scope_hr` 7 pemeriksaan): pengguna uji dengan API key sementara dari `scripts/access_test_users.py`, buat dan hapus lewat `odoo shell`.
- Uji browser dengan pengguna terbatas: daftar hanya miliknya, membuka dokumen orang lain menampilkan kartu "Akses ditolak", dan Users & Access menulis grup yang benar. Irisan 3: pengguna gudang A melihat catatan "hanya gudang ..." di dashboard Inventory, penerimaan, pengiriman, riwayat gerakan, scrap, dan laporan stok, dengan daftar hanya gudang A dan pilihan lokasi tanpa gudang lain; pemilih gudang di Users & Access (disimpan, dikosongkan saat peran dicabut, tersembunyi untuk Administrator); catatan cakupan HR di daftar Attendance, Time Off, dan Expenses.
