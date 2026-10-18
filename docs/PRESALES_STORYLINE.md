# Storyline presales PROLINE: satu pesanan dari peluang sampai uang masuk

Dokumen ini adalah naskah presentasi untuk demo Nusara ERP kepada PROLINE (diagnostik laboratorium, proline.co.id). Urutan babnya mengikuti permintaan: **CRM, Sales, Inventory, Manufacturing, Purchase, Accounting**. Satu cerita dipakai dari awal sampai akhir: *RSUD Kabupaten Karawang membeli satu paket kimia klinik lewat e-Katalog*. Cerita itu menyentuh keenam modul, jadi penonton melihat satu data yang mengalir, bukan enam demo terpisah.

Data demo dibuat oleh skrip di `scripts/` (lihat "Persiapan"). Nama pelanggan, pemasok, harga, dan jumlah adalah **rekaan**; nama produk mengikuti katalog di proline.co.id. Nomor dokumen mengikuti urutan sistem pada basis data Anda, jadi naskah ini menyebut dokumen lewat nama pelanggannya.

## 1. Tentang PROLINE dan apa yang perlu dikonfirmasi

Dari situs proline.co.id (per Oktober 2026):

- Kantor di Kawasan Industri Jababeka III, Cikarang Utara, Bekasi.
- Enam lini: **Kimia Klinik** (reagen, kontrol, kalibrator, instrumen seperti BC240 Plus, CHEM200, Riele Photometer 5010 V5), **Hematologi** (DH33, DF55, hemoglobin strip), **Imunologi** (Snibe Maglumi X3i, PROLINE Xi800), **Urinalisis** (UA120, UA240, urine strip), **Tes Cepat** (FOBt, HIV-Syphilis, BPRO COVID-19 Ag), **Biomolekuler** (kit PCR UPRO untuk deteksi porcine).
- Reagen dijual dalam format siap pakai dengan masa simpan 12 sampai 24 bulan.
- Produk tersedia di **e-Katalog INAPROC** (pengadaan pemerintah); BPRO COVID-19 Ag mencantumkan **TKDN 41,27%**.

Situs tidak menjelaskan sistem internal, jadi bagian di bawah adalah **hipotesis** yang dikonfirmasi saat pembukaan demo (tanyakan, jangan menyatakan):

| Hipotesis masalah | Bukti dari situs | Pertanyaan pembuka |
|---|---|---|
| Reagen punya masa kedaluwarsa pendek; stok lama harus keluar lebih dulu | Masa simpan 12 sampai 24 bulan | "Bagaimana tim gudang menjaga agar lot yang hampir kedaluwarsa keluar duluan?" |
| Instrumen harus ditelusuri per nomor seri (garansi, servis, kalibrasi) | Banyak model instrumen | "Kalau satu analyzer bermasalah, berapa lama menemukan siapa pembelinya?" |
| Penjualan pemerintah punya harga, tenggat bayar, dan pemotongan pajak sendiri | e-Katalog INAPROC, TKDN | "Bagaimana harga e-Katalog dan PPh 23 yang dipotong pelanggan dicatat sekarang?" |
| Satu kit reagen dirakit dari bahan curah, vial, dan kotak | Reagen format kit dan MPK | "Bagaimana menghitung biaya per kit dan tahu kapan vial habis?" |
| Pembelian instrumen dan reagen perlu persetujuan dan jadwal tiba | Instrumen dan reagen beragam sumber | "Siapa yang menyetujui pembelian dan bagaimana memantau barang yang belum datang?" |
| Piutang pemerintah sering terlambat | Penjualan lewat pengadaan | "Berapa piutang yang lewat jatuh tempo hari ini dan siapa yang menagih?" |

## 2. Persiapan demo

Jalankan berurutan pada basis data demo (aman diulang; setiap skrip berhenti sendiri bila datanya sudah ada). Detail perintah ada di `docs/PRESALES_DEMO.md`.

```bash
docker compose run --rm -T --no-deps odoo odoo shell -d nusara --no-http < scripts/setup_tax_id.py
docker compose run --rm -T --no-deps odoo odoo shell -d nusara --no-http < scripts/seed_presales.py
docker compose run --rm -T --no-deps odoo odoo shell -d nusara --no-http < scripts/seed_presales_extra.py
docker compose run --rm -T --no-deps odoo odoo shell -d nusara --no-http < scripts/seed_presales_assets.py
docker compose run --rm -T --no-deps odoo odoo shell -d nusara --no-http < scripts/seed_presales_proline.py
```

`seed_presales_proline.py` adalah lapisan khusus PROLINE: perusahaan demo **PROLINE (Demo)** dengan gudang di Jababeka, 7 kategori produk per lini (penarikan stok FEFO), 24 produk (instrumen ber-nomor seri; reagen, kalibrator, dan tes cepat ber-lot dengan tanggal kedaluwarsa), daftar harga **e-Katalog INAPROC** dan **Harga Distributor**, dua tim penjualan, tag CRM, rak dingin 2-8C, enam pelanggan dan lima pemasok rekaan, lalu transaksi yang dibahas di bawah.

Daftar periksa sehari sebelumnya:

1. Buka http://127.0.0.1:8080, masuk dengan API key, dan pastikan header menampilkan **PROLINE (Demo)**.
2. Buka sekali setiap halaman yang akan dipakai agar data termuat dan tidak ada galat.
3. Jangan memvalidasi dokumen yang disiapkan untuk demo langsung: pengiriman **Distributor (PT Mitra Alkes Nusantara)** berstatus Siap dan MO kolesterol 120 kit berstatus Dikonfirmasi.
4. Siapkan satu perangkat untuk layar penuh dan kolom tabel yang sudah dilebarkan (lebar kolom tersimpan di peramban).

## 3. Cerita: satu pesanan, enam modul

Prolog yang dibacakan: *"RSUD Kabupaten Karawang membutuhkan analyzer kimia klinik otomatis dan reagen setahun. Mereka membeli lewat e-Katalog. Kita ikuti pesanan itu dari pertama kali masuk sebagai peluang sampai uang masuk ke bank, dan kita lihat apa yang terjadi di setiap bagian perusahaan."*

### Bab 1. CRM: dari peluang ke penawaran (4 menit)

**Masalah**: peluang tersebar di chat dan spreadsheet; tidak jelas mana yang dari e-Katalog, mana yang tender, dan siapa yang harus menelepon hari ini.

| Langkah | Menu | Yang ditunjukkan |
|---|---|---|
| 1 | CRM > Opportunity | Papan pipeline per tahap. Dua tim: **e-Katalog INAPROC dan Pemerintah** dan **Laboratorium Swasta dan Distributor**. Tag **e-Katalog**, **Tender**, **TKDN**, **Halal** memisahkan jenis peluang |
| 2 | Buka "RSUD Karawang: paket kimia klinik BC240 Plus lewat e-Katalog" | Pendapatan diharapkan Rp330 juta, probabilitas 60%, tenggat, catatan, tombol **Quotation** dan **Menang** |
| 3 | Bagian **Aktivitas Terjadwal** di formulir yang sama | Jadwal "Demo BC240 Plus di lab RSUD Karawang" (tiga hari lagi). Klik **Jadwalkan**: pilih jenis (Call, Meeting, To-Do), tenggat, penanggung jawab. Tenggat yang lewat berlabel **Terlambat** (peluang "UPTD Labkesda Jabar" punya tugas yang sembilan hari terlambat) |
| 4 | CRM > Reporting > Forecast dan Activities | Pendapatan diharapkan per bulan dan daftar aktivitas hari ini dan terlambat untuk satu tim |
| 5 | CRM > Leads | Lead baru dari situs ("Permintaan demo DF55") belum dikualifikasi |

**Kalimat kunci**: "Aktivitas terjadwal ada di *setiap* formulir, bukan hanya CRM. Kita akan melihatnya lagi di faktur dan produksi."

**Jika ditanya**: integrasi formulir situs ke lead (bisa lewat API; tidak ada di demo); skor lead otomatis (tersedia di Odoo, belum diatur).

### Bab 2. Sales: penawaran, harga e-Katalog, dan pesanan (5 menit)

**Masalah**: harga pemerintah berbeda dari harga laboratorium swasta dan harga distributor; salesperson salah memakai harga atau lupa pajak.

| Langkah | Menu | Yang ditunjukkan |
|---|---|---|
| 1 | Sales > Pricelis Master | Tiga daftar harga: Default, **Harga e-Katalog INAPROC** (potongan 3%), **Harga Distributor** (potongan 12%). Pelanggan membawa daftar harganya sendiri |
| 2 | Sales > Quotations | Penawaran **UPTD Laboratorium Kesehatan Daerah Jawa Barat** (DH33, strip hemoglobin, diluent, lyse, jasa instalasi) berstatus Terkirim senilai Rp156,8 juta; **Laboratorium Klinik Cikarang Medika** draf Rp547,1 juta (Maglumi X3i dan reagen tiroid) |
| 3 | Buka SO baru, pilih produk di baris | Produk menampilkan **stok tersedia di gudang yang dipilih** ("Tersedia 55 · on hand 60 di Gudang Utama Jababeka"); jumlah melebihi stok memerah. Ganti gudang, angka ikut berubah |
| 4 | Sales > Sales Orders > RSUD Kabupaten Karawang | SO terkonfirmasi Rp367,2 juta: analyzer BC240 Plus, kalibrator, kontrol, reagen ureum, SGOT, SGPT, jasa instalasi, dan jasa rantai dingin. Kolom **Pajak** per baris: VAT Out 11% untuk barang, **VAT Out 11% dan PPh 23 -2% (dipotong pelanggan)** untuk jasa. Kolom **Analitik** per baris menempelkan departemen, lini produk, dan segmen produk |
| 5 | Tombol **Cetak** pada SO | Dokumen siap kirim ke pelanggan |

**Kalimat kunci**: "Sales tidak memilih harga. Pelanggan membawa daftar harganya, pajak mengikuti jenis baris, dan stok terlihat sebelum janji ke pelanggan."

**Jika ditanya**: komisi penjualan (belum, ada di antrean keputusan); persetujuan diskon bertingkat (belum tersedia di OCA 19; bisa dibahas sebagai pengembangan).

### Bab 3. Inventory: nomor seri, lot, FEFO, dan rak dingin (7 menit)

**Masalah**: lot reagen yang hampir kedaluwarsa menumpuk; instrumen tidak bisa ditelusuri; stok dingin dan stok biasa tercampur.

| Langkah | Menu | Yang ditunjukkan |
|---|---|---|
| 1 | Inventory > Delivery Order > pengiriman RSUD Karawang (selesai) | Instrumen BC240 Plus terkirim dengan **nomor seri**; reagen ureum, SGOT, SGPT diambil dari **lot A (kedaluwarsa 45 hari sejak data dibuat, mis. 29 Nov 2026)** karena aturan **FEFO**: lot yang paling dekat kedaluwarsa keluar lebih dulu |
| 2 | Inventory > Master > Lot & Serial Number Master | Daftar lot dengan tanggal kedaluwarsa dan filter **Perlu perhatian**; buka satu lot untuk **jejak**: dari penerimaan pemasok sampai pengiriman pelanggan |
| 3 | Delivery Order > pengiriman **Dinkes Kota Bekasi** | Pengiriman sebagian: tes COVID-19 Ag terkirim 40 dari 60, sisa 20 menjadi **backorder** yang menunggu stok |
| 4 | Delivery Order > pengiriman **PT Mitra Alkes Nusantara** (status Siap) | Stok dipesan otomatis dari lot yang benar, termasuk reagen TSH dari **Rak Dingin 2-8C**. Klik **Validasi** di depan penonton |
| 5 | Inventory > Operation > Internal Transfer | Transfer reagen ke Rak Dingin 2-8C. Buat transfer baru: pilih produk, lihat stok tersedia di lokasi asal |
| 6 | Inventory > Master > Reorder Level dan Operation > Replenishment | Aturan min dan maks per produk; **Ureum** muncul perlu dipesan (stok 60, sudah dipesan 70), **FOBt** dan **HIV-Syphilis** di bawah minimum. Pilih rute Beli atau Produksi |
| 7 | Inventory > Report > Inventory Valuation | Nilai persediaan per tanggal dengan filter kategori (Kimia Klinik, Hematologi, Imunologi, Tes Cepat, Biomolekuler); rincian bisa dibuka sampai pergerakan stok |

**Kalimat kunci**: "Sistem yang menjaga FEFO, bukan ingatan petugas gudang. Dan dari satu nomor seri atau satu lot, kita bisa tahu siapa yang menerimanya."

**Jika ditanya**: pemindai barcode (bisa dibahas; belum ada layar khusus); suhu rantai dingin terekam otomatis (tidak; yang tercatat adalah lokasi rak dingin).

### Bab 4. Manufacturing: kit reagen dari bahan curah (4 menit)

**Masalah**: kit reagen dirakit dari reagen curah, vial, dan kotak; biaya per kit dan kekurangan komponen baru ketahuan saat produksi berhenti.

| Langkah | Menu | Yang ditunjukkan |
|---|---|---|
| 1 | Manufacture > Bill of Material | BoM kit Kolesterol Total: 0,2 liter reagen curah, 4 vial, 1 kotak per kit. BoM strip urin punya dua versi (standar dan ekonomis) |
| 2 | Manufacture > Manufacturing Order > MO Baru | Pilih produk **PROLINE Reagen Kolesterol Total**, isi jumlah 120. Panel **Stok di Gudang Utama Jababeka** memperlihatkan kebutuhan tiap komponen terhadap stok tersedia: **vial kurang** (butuh 480, tersedia 0) berwarna merah dengan tulisan "Kurang" |
| 3 | MO selesai 80 kit | Komponen terpotong otomatis, kit masuk sebagai **lot KOL-2609-A** dengan tanggal kedaluwarsa; panel **Jurnal terkait** menunjukkan nilai komponen keluar dan barang jadi masuk |
| 4 | MO kolesterol 120 kit (Dikonfirmasi) | Aktivitas terjadwal "Cek ketersediaan vial" menandai tindak lanjut; tombol **Cek Ketersediaan** dan **Batalkan Reservasi** |
| 5 | Manufacture > Reporting > Production Analisis | Jumlah dan nilai produksi per produk dan periode |

**Kalimat kunci**: "Kekurangan vial terlihat sebelum MO dikonfirmasi, bukan setelah lini berhenti."

**Jika ditanya**: perencanaan kapasitas dan jadwal mesin (Schedule Production tersedia; penjadwalan kapasitas tingkat lanjut adalah fitur Enterprise); biaya tenaga kerja dan overhead di MO (bisa lewat operasi work center; belum diatur di demo).

### Bab 5. Purchase: dari permintaan sampai penerimaan ber-lot (4 menit)

**Masalah**: permintaan pembelian lewat chat; barang impor sulit dipantau; lot dan kedaluwarsa dicatat manual saat barang tiba.

| Langkah | Menu | Yang ditunjukkan |
|---|---|---|
| 1 | Purchase Request > Purchase Request | PR "Rencana stok imunologi Q4 2026" (Maglumi X3i, TSH, Vitamin D) dan "Rencana stok hematologi Q4 2026" berstatus In Progress setelah dibuatkan PO |
| 2 | Purchase > Purchase Order | PO ke **PT Agen Instrumen Imunologi Indonesia**, **PT Importir Hematologi Medika**, **PT Distributor Instrumen Kimia Klinik**, pemasok tes cepat, biomolekuler, dan bahan curah. Satu **RFQ draf** (Maglumi X3i tambahan) dengan aktivitas "Minta ETD" |
| 3 | Baris PO | Pilih produk: stok yang sudah ada di gudang penerima tampil, supaya pembelian tidak berlebihan |
| 4 | Inventory > Good Receive | Penerimaan memasukkan **nomor seri per unit** untuk instrumen dan **dua lot per reagen** (lot A hampir kedaluwarsa dan lot B baru) lengkap dengan tanggal kedaluwarsa |
| 5 | Purchase > Report > Purchase Order Analisis | Pembelian per pemasok dan produk |

**Kalimat kunci**: "Petugas gudang memasukkan lot dan kedaluwarsa saat barang tiba. Sesudah itu FEFO, jejak, dan peringatan kedaluwarsa bekerja sendiri."

**Jika ditanya**: pembelian impor dalam USD dan selisih kurs (mata uang USD aktif; belum dibuatkan contoh); persetujuan PR berjenjang (belum tersedia di OCA 19).

### Bab 6. Accounting: faktur, pajak, piutang, dan laporan (6 menit)

**Masalah**: faktur dan pajak diketik ulang; piutang pemerintah terlambat tanpa ada yang tahu; laba per lini produk dihitung manual di spreadsheet.

| Langkah | Menu | Yang ditunjukkan |
|---|---|---|
| 1 | Accounting > Customers > Customer Invoice | Faktur RSUD Karawang dari SO dalam satu klik: **VAT Out 11%**, **PPh 23 -2% (dipotong pelanggan)** pada baris jasa. Status **Dibayar Sebagian** (50%), jatuh tempo 30 hari sudah lewat. Aktivitas "Telepon bendahara RSUD Karawang" terjadwal |
| 2 | Customer Payment | Pembayaran sebagian; tombol **Buat** untuk pembayaran dari beberapa faktur satu mitra |
| 3 | Reporting > **Aged Receivable** | Piutang Karawang masuk kelompok terlambat; faktur Dinas Kesehatan Kota Bekasi lunas |
| 4 | Vendors > Vendor Bills | Tagihan pemasok dari PO dengan **VAT In 11%**; tagihan jasa rantai dingin dengan **PPh 23 -2%** (dipotong dari pemasok). Sebagian belum dibayar |
| 5 | Reporting > Aged Payable | Utang yang jatuh tempo per pemasok |
| 6 | Delivery atau Good Receive selesai, panel **Jurnal terkait** | Penjelasan: jurnal persediaan tercipta saat tagihan dan faktur diposting, bukan saat barang bergerak; panel menunjukkan jurnal sungguhan atau menjelaskan bila belum ada |
| 7 | Reporting > **Profit and Loss** dengan pilihan **Akun analitik** | Laba rugi per **Segmen Produk** (Kimia Klinik, Hematologi, dan seterusnya), per Lini Produk, dan per Departemen; **Analytic Report** membandingkan semua |
| 8 | Reporting > Balance Sheet, Cash Flow, Tax Report | Neraca seimbang, arus kas, laporan PPN dan PPh |
| 9 | Accounting > Asset dan Asset Model | Empat model aset dan jadwal penyusutan peralatan laboratorium, kendaraan, kantor, dan renovasi gudang |
| 10 | Bank Transaction | Mutasi bank dicocokkan dengan pembayaran tertunda |

**Kalimat kunci**: "Kita mulai dari satu peluang dan berakhir di laba rugi per lini produk. Tidak ada satu pun angka yang diketik dua kali."

**Jika ditanya**: e-Faktur dan Coretax (modul lokalisasi ada di Odoo, belum diaktifkan di demo; dibahas pada fase implementasi); multi-company (tersedia: General Setting > Perusahaan; transaksi antar perusahaan belum); pencocokan bank dengan faktur dan jurnal (sebagian; lanjutan sedang diantrekan).

### Penutup (2 menit)

Kembali ke peta: peluang di CRM, harga dan pajak di Sales, nomor seri dan lot di Inventory, kit di Manufacturing, penerimaan di Purchase, jurnal dan laporan di Accounting. Tutup dengan tiga hal yang diperoleh PROLINE: **ketertelusuran** (nomor seri dan lot), **kepatuhan** (FEFO, PPN dan PPh, e-Katalog), **kendali** (aktivitas terjadwal, piutang, dan laba per lini).

## 4. Versi ringkas (20 menit)

| Menit | Bab | Hanya tunjukkan |
|---|---|---|
| 0 sampai 3 | Pembuka | Peta enam modul dan tiga pertanyaan discovery |
| 3 sampai 7 | CRM | Pipeline, peluang Karawang, jadwalkan aktivitas |
| 7 sampai 11 | Sales | Daftar harga e-Katalog, stok di baris SO, SO Karawang dengan pajak |
| 11 sampai 15 | Inventory dan Manufacturing | Pengiriman FEFO dan nomor seri, validasi pengiriman distributor, panel stok MO |
| 15 sampai 17 | Purchase | Penerimaan ber-lot |
| 17 sampai 20 | Accounting | Faktur dengan PPh 23, Aged Receivable, laba rugi per segmen produk |

## 5. Jawaban jujur untuk pertanyaan sulit

| Pertanyaan | Jawaban |
|---|---|
| Apakah ini Odoo? | Nusara memakai mesin Odoo Community dengan modul OCA dan tampilan sendiri. Lisensinya LGPL, tanpa biaya per pengguna |
| Bagaimana dengan e-Faktur dan Coretax? | Modul lokalisasi tersedia; diaktifkan pada fase implementasi |
| Persetujuan bertingkat? | Belum tersedia untuk versi 19 di OCA; tersedia sebagai pengembangan khusus |
| Hak akses per peran? | Ada pengguna dan grup; aturan akses per catatan masih dalam antrean keputusan |
| Login SSO atau 2FA? | Belum; dalam antrean keputusan |
| Banyak perusahaan? | Bisa: perusahaan kedua dan seterusnya dengan COA Indonesia, pajak, gudang, dan nomor dokumen sendiri; mitra dan produk dibagi; pindah lewat pemilih di header (General Setting > Perusahaan). Transaksi antar perusahaan dan laporan konsolidasi belum ada |
| Ponsel? | Tampilan menyesuaikan lebar layar, tetapi pemeriksaan menyeluruh di ponsel belum selesai |
| Impor data awal? | Ada Import Data (CSV atau xlsx) untuk produk, mitra, kategori, harga pemasok, akun, stok, jurnal, dan BoM |
| Jejak perubahan? | Audit Log mencatat siapa mengubah apa dan kapan |
| Berapa lama implementasi? | Bergantung pada cakupan; usulkan fase: master data dan stok, penjualan dan pembelian, produksi, lalu akuntansi dan laporan |

## 6. Peta data demo

| Jenis | Isi |
|---|---|
| Pelanggan | RSUD Kabupaten Karawang, Dinas Kesehatan Kota Bekasi, UPTD Laboratorium Kesehatan Daerah Jawa Barat (semua daftar harga e-Katalog, jatuh tempo 30 hari); Laboratorium Klinik Cikarang Medika; PT Mitra Alkes Nusantara (Harga Distributor); Laboratorium Uji Halal Pangan Nusantara |
| Pemasok | PT Agen Instrumen Imunologi Indonesia, PT Importir Hematologi Medika, PT Distributor Instrumen Kimia Klinik, PT Biomolekuler Reagen Indonesia, PT Logistik Rantai Dingin Nusantara, serta pemasok dari data presales awal |
| Produk berserial | BC240 Plus, CHEM200, Riele Photometer 5010 V5, DH33, DF55, Snibe Maglumi X3i |
| Produk ber-lot dan kedaluwarsa | Reagen ureum, SGOT, SGPT, kolesterol, kalibrator, strip hemoglobin, diluent dan lyse, reagen TSH dan Vitamin D CLIA, tes cepat FOBt, HIV-Syphilis, BPRO COVID-19 Ag, kit PCR UPRO |
| Dokumen kunci | SO dan faktur RSUD Karawang (dibayar 50%, terlambat); SO Dinkes Bekasi (kirim sebagian, lunas); quotation UPTD Jabar (terkirim); SO Mitra Alkes (pengiriman Siap); quotation Lab Cikarang (draf); MO kolesterol 80 (selesai) dan 120 (menunggu vial); PO dan penerimaan ber-lot dan ber-seri; RFQ draf Maglumi |
| Analitik | Tiga rencana: Departemen, Lini Produk, Segmen Produk; menempel pada baris SO, PO, tagihan, faktur |
| Aktivitas terjadwal | Demo BC240, tugas tender terlambat, telepon lab Cikarang hari ini, kirim brosur UPRO, ETD Maglumi, cek vial MO, telepon bendahara Karawang, kurir rantai dingin |
