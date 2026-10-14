# Skenario demo presales: PROLINE (diagnostik)

Data contoh bertema PROLINE (produk diagnostik: instrumen, reagen, strip urin, tes cepat) dibuat oleh `scripts/seed_presales.py`. Nama perusahaan, harga, dan jumlah adalah rekaan untuk demo. Skrip aman dijalankan ulang (berhenti bila produk `PRL-XI800` sudah ada) dan tidak menghapus data lain.

```bash
docker compose run --rm -T --no-deps odoo odoo shell -d nusara --no-http < scripts/seed_presales.py
```

Jalankan lebih dulu `scripts/setup_tax_id.py` (pajak Indonesia: VAT Out 11%, VAT In 11%, PPh 23 -2%; lihat bagian Pajak). Skrip seed juga mengaktifkan fitur Storage Locations (transfer antar rak) dan Leads di CRM bila belum aktif. Buka UI di http://127.0.0.1:8080 dan masuk dengan API key.

## Cerita demo (sekitar 15 menit)

Prolog: "Kami distributor dan produsen alat diagnostik. Instrumen kami beli dari pemasok, sedangkan strip urin dan kit reagen kami rakit sendiri."

| # | Tahap | Menu | Yang ditunjukkan |
|---|---|---|---|
| 1 | CRM | CRM > Pipeline | Empat peluang di tahap berbeda (Xi800 RS Harapan Sehat Rp485 juta, tender RSUD Semarang, tes cepat Dengue, Lab Sentosa yang sudah Won), dua lead baru, aktivitas besok: presentasi Xi800 |
| 2 | Quotation | Sales > Quotation | Penawaran S00010 (Xi800) terhubung ke peluang RS Harapan Sehat |
| 3 | Sales Order | Sales > Sales Order | S00007 Lab Sentosa (UA240, strip, kontrol) dan S00008 RS Harapan Sehat, keduanya terkirim dan tertagih; S00009 Klinik Bunda menunggu pengiriman |
| 4 | Delivery Order | Inventory > Delivery | WH/OUT/00006 dan 00007 selesai, WH/OUT/00008 berstatus Siap (klik Validasi saat demo) |
| 5 | Customer Invoice | Accounting > Customer Invoice | INV/2026/00004 Lunas, INV/2026/00005 Dibayar Sebagian; tombol Buat untuk faktur dari beberapa SO |
| 6 | Receipt | Accounting > Customer Payment | Dua receipt, satu masih In Process menunggu bank reconciliation |
| 7 | Purchase Request | Purchase Request | PR00008 (instrumen) dan PR00009 (bahan kemasan) berstatus In Progress setelah dibuatkan PO |
| 8 | Purchase Order | Purchase > RFQ and Purchase Order | P00007 sampai P00009 terkonfirmasi dan diterima, P00010 RFQ draf (Xi800 tambahan) |
| 9 | Good Receive | Inventory > Receipt | WH/IN/00008 sampai 00010 selesai |
| 10 | Vendor Bill | Accounting > Vendor Bills | Tiga tagihan: dua lunas, BILL/2026/10/0008 (CV Bahan Reagen Prima) belum dibayar sehingga muncul di Aged Payable |
| 11 | Payment | Accounting > Vendor Payment | PBNK1/2026/00002 dan 00003 |
| 12 | Inventory Transfer | Inventory > Transfer Internal | Pindah barang ke Rak Instrumen dan Rak Bahan Baku (selesai), WH/INT/00004 ke Rak Reagen dan Kit berstatus Siap; buat transfer baru untuk melihat stok tersedia di lokasi asal |
| 13 | Manufacturing | Manufacture > Manufacturing Order | MO strip urin 200 botol selesai, MO kit reagen glukosa 60 selesai (komponen terpotong otomatis, biaya masuk ke nilai persediaan), MO strip 300 botol berjalan |
| 14 | Laporan | Inventory > Report > Inventory Valuation, Accounting > Reporting | Nilai persediaan per tanggal, laba rugi, neraca, aged receivable dan payable |

## Pajak (lokalisasi Indonesia)

`scripts/setup_tax_id.py` menyiapkan **VAT Out 11%** (PPN keluaran, penjualan), **VAT In 11%** (PPN masukan, pembelian), dan **PPh 23 -2%** (pemotongan; versi pembelian memakai akun Tax Payable PPh 23, versi penjualan "dipotong pelanggan" memakai Prepaid Tax PPh 23). VAT Out dan VAT In menjadi pajak bawaan perusahaan dan produk; dua pajak "12% (Non-Luxury Good)" lama diarsipkan. Pada demo ada contoh nyata: tagihan jasa kalibrasi dari CV Teknisi Kalibrasi Mandiri (BILL/2026/10/0009) dengan dua pajak pada satu baris, VAT In 11% dan PPh 23 -2%, sehingga yang dibayar Rp4.905.000 dari dasar Rp4.500.000. Sales Order S00007 juga memuat jasa instalasi dan pelatihan instrumen (kebijakan faktur: jumlah dipesan), sehingga fakturnya INV/2026/00004 bernilai Rp87.412.500.

Tips: lakukan satu aksi langsung saat demo (validasi WH/OUT/00008, atau Buat faktur dari S00009 setelah pengiriman) agar terlihat alurnya hidup. Nomor dokumen di atas berasal dari data yang dibuat pada 13 Okt 2026; pada basis data lain nomornya mengikuti urutan Odoo.
