"""Template laporan keuangan MIS Builder untuk COA Indonesia (l10n_id).

Rumus memakai kode akun l10n_id dan jenis akun. Setiap laporan punya baris pemeriksaan ("harus 0") yang
menyala bila ada akun baru di luar pemetaan, misalnya akun yang ditambahkan pengguna dengan kode berbeda.

Sintaks MIS: balp = saldo mutasi periode, bale = saldo akhir, bali = saldo awal, debp/crdp = debit/kredit periode.
Aset dan beban bertanda positif pada saldo debit; kewajiban, ekuitas, dan pendapatan dikalikan -1.
"""

PNL_TYPES = "'income','income_other','expense','expense_direct_cost','expense_depreciation','expense_other'"
# Catatan sintaks: kurung siku di dalam balp[...] memotong rumus, jadi daftar jenis akun ditulis sebagai tuple.

# Baris: (nama teknis, label, rumus, gaya, jenis). Gaya: None, "header", "sub", "total", "check".
LABA_RUGI = [
    ("h_pendapatan", "PENDAPATAN USAHA", "", "header"),
    ("penjualan", "Penjualan", "-balp[41%]", None),
    ("retur_diskon", "Retur dan Potongan Penjualan", "-balp[42000060,42000070]", None),
    ("pendapatan_bersih", "Pendapatan Bersih", "penjualan + retur_diskon", "sub"),
    ("h_hpp", "HARGA POKOK", "", "header"),
    ("hpp_barang", "Harga Pokok Penjualan", "balp[51000010]", None),
    ("pembelian_bahan", "Pembelian Bahan Baku", "balp[51000020]", None),
    ("perubahan_persediaan", "Perubahan Persediaan", "balp[42500010]", None),
    ("hpp_total", "Total Harga Pokok", "hpp_barang + pembelian_bahan + perubahan_persediaan", "sub"),
    ("laba_kotor", "LABA KOTOR", "pendapatan_bersih - hpp_total", "total"),
    ("h_operasional", "BEBAN OPERASIONAL", "", "header"),
    ("beban_gaji", "Gaji dan Tunjangan", "balp[611%]", None),
    ("beban_umum", "Beban Umum dan Kantor", "balp[631%,641%]", None),
    ("beban_jasa", "Jasa, Sewa, dan Pemeliharaan", "balp[651%] - balp[65110070]", None),
    ("beban_kendaraan", "Kendaraan", "balp[661%]", None),
    ("beban_penyusutan", "Penyusutan", "balp[('account_type','=','expense_depreciation')]", None),
    ("beban_lain_operasional", "Beban Operasional Lain", "balp[69000000]", None),
    (
        "beban_operasional",
        "Total Beban Operasional",
        "beban_gaji + beban_umum + beban_jasa + beban_kendaraan + beban_penyusutan + beban_lain_operasional",
        "sub",
    ),
    ("laba_usaha", "LABA USAHA", "laba_kotor - beban_operasional", "total"),
    ("h_lain", "PENDAPATAN DAN BEBAN LAIN", "", "header"),
    ("pendapatan_lain", "Pendapatan Lain", "-balp[('account_type','=','income_other')] - balp[99900002]", None),
    ("beban_lain", "Beban Lain", "balp[911%] + balp[99900001,99900003]", None),
    ("laba_sebelum_pajak", "LABA SEBELUM PAJAK", "laba_usaha + pendapatan_lain - beban_lain", "total"),
    ("beban_pajak", "Beban Pajak Penghasilan", "balp[65110070]", None),
    ("laba_bersih", "LABA BERSIH", "laba_sebelum_pajak - beban_pajak", "total"),
    (
        "cek",
        "Akun laba rugi belum terpetakan (harus 0)",
        f"-balp[('account_type','in',({PNL_TYPES}))] - laba_bersih",
        "check",
    ),
]

NERACA = [
    ("h_aset", "ASET", "", "header"),
    ("kas_bank", "Kas dan Bank", "bale[('account_type','=','asset_cash')]", None),
    ("pembayaran_tertunda", "Penerimaan dan Pembayaran Tertunda", "bale[11120002,11120003,11120004,19999991]", None),
    ("piutang_usaha", "Piutang Usaha", "bale[11210010,11210011]", None),
    ("persediaan", "Persediaan", "bale[113%]", None),
    ("pajak_dimuka", "Pajak Dibayar di Muka", "bale[11210030,11210012,11210013,11210014] + bale[115%]", None),
    ("biaya_dimuka", "Biaya Dibayar di Muka", "bale[114%,11210040]", None),
    (
        "aset_lancar",
        "Total Aset Lancar",
        "kas_bank + pembayaran_tertunda + piutang_usaha + persediaan + pajak_dimuka + biaya_dimuka",
        "sub",
    ),
    ("aset_tetap_bruto", "Aset Tetap (Harga Perolehan)", "bale[1221%]", None),
    ("akumulasi_penyusutan", "Akumulasi Penyusutan", "bale[1228%]", None),
    ("aset_tetap_neto", "Aset Tetap Neto", "aset_tetap_bruto + akumulasi_penyusutan", "sub"),
    ("aset_lain", "Aset Tidak Lancar Lain", "bale[('account_type','=','asset_non_current')]", None),
    ("total_aset", "TOTAL ASET", "aset_lancar + aset_tetap_neto + aset_lain", "total"),
    ("h_liabilitas", "LIABILITAS", "", "header"),
    ("hutang_usaha", "Hutang Usaha", "-bale[21100010]", None),
    ("hutang_pajak", "Hutang Pajak", "-bale[2122%,2121%,21100011,21100012,21100014]", None),
    ("uang_muka_pelanggan", "Uang Muka Pelanggan dan Pendapatan Diterima di Muka", "-bale[28%]", None),
    ("biaya_akrual", "Biaya yang Masih Harus Dibayar", "-bale[25%]", None),
    ("hutang_bank", "Pinjaman Bank dan Leasing", "-bale[221%]", None),
    ("hutang_lain", "Hutang Lain-lain", "-bale[21100013,21100020,21100030,21100040,29000000]", None),
    (
        "total_liabilitas",
        "TOTAL LIABILITAS",
        "hutang_usaha + hutang_pajak + uang_muka_pelanggan + biaya_akrual + hutang_bank + hutang_lain",
        "total",
    ),
    ("h_ekuitas", "EKUITAS", "", "header"),
    ("modal", "Modal Disetor dan Prive", "-bale[311%]", None),
    ("cadangan", "Cadangan Modal", "-bale[312%]", None),
    ("saldo_laba", "Saldo Laba Ditahan", "-bale[31510010,31510020,39000000] - bale[('account_type','=','equity_unaffected')]", None),
    ("laba_berjalan", "Laba (Rugi) Tahun Berjalan", f"-bale[('account_type','in',({PNL_TYPES}))]", None),
    ("total_ekuitas", "TOTAL EKUITAS", "modal + cadangan + saldo_laba + laba_berjalan", "total"),
    ("total_liabilitas_ekuitas", "TOTAL LIABILITAS DAN EKUITAS", "total_liabilitas + total_ekuitas", "total"),
    ("cek", "Selisih aset dan liabilitas + ekuitas (harus 0)", "total_aset - total_liabilitas_ekuitas", "check"),
]

ARUS_KAS = [
    ("h_operasi", "ARUS KAS DARI AKTIVITAS OPERASI", "", "header"),
    ("laba_bersih", "Laba (Rugi) Bersih", f"-balp[('account_type','in',({PNL_TYPES}))]", None),
    ("penyusutan", "Penyusutan (beban nontunai)", "balp[('account_type','=','expense_depreciation')]", None),
    ("d_piutang", "Perubahan Piutang Usaha", "-balp[11210010,11210011]", None),
    ("d_persediaan", "Perubahan Persediaan", "-balp[113%]", None),
    ("d_dimuka", "Perubahan Pajak dan Biaya Dibayar di Muka", "-balp[11210030,11210012,11210013,11210014,11210040,114%,115%]", None),
    ("d_tertunda", "Perubahan Penerimaan dan Pembayaran Tertunda", "-balp[11120002,11120003,11120004,19999991]", None),
    ("d_hutang_usaha", "Perubahan Hutang Usaha", "-balp[21100010]", None),
    ("d_hutang_pajak", "Perubahan Hutang Pajak", "-balp[2122%,2121%,21100011,21100012,21100014]", None),
    ("d_kewajiban_lain", "Perubahan Kewajiban Lain", "-balp[28%,25%,21100013,21100020,21100030,21100040,29000000]", None),
    (
        "kas_operasi",
        "Kas Bersih dari Aktivitas Operasi",
        "laba_bersih + penyusutan + d_piutang + d_persediaan + d_dimuka + d_tertunda + d_hutang_usaha + d_hutang_pajak + d_kewajiban_lain",
        "total",
    ),
    ("h_investasi", "ARUS KAS DARI AKTIVITAS INVESTASI", "", "header"),
    ("aset_tetap", "Perolehan Aset Tetap", "-(balp[1221%] + balp[1228%]) - penyusutan", None),
    ("aset_lain", "Perubahan Aset Tidak Lancar Lain", "-balp[('account_type','=','asset_non_current')]", None),
    ("kas_investasi", "Kas Bersih dari Aktivitas Investasi", "aset_tetap + aset_lain", "total"),
    ("h_pendanaan", "ARUS KAS DARI AKTIVITAS PENDANAAN", "", "header"),
    ("pinjaman", "Perubahan Pinjaman Bank dan Leasing", "-balp[221%]", None),
    ("modal", "Perubahan Modal dan Cadangan", "-balp[311%,312%]", None),
    ("laba_ditahan", "Perubahan Saldo Laba Ditahan", "-balp[31510010,31510020,39000000] - balp[('account_type','=','equity_unaffected')]", None),
    ("kas_pendanaan", "Kas Bersih dari Aktivitas Pendanaan", "pinjaman + modal + laba_ditahan", "total"),
    ("kenaikan_kas", "KENAIKAN (PENURUNAN) KAS BERSIH", "kas_operasi + kas_investasi + kas_pendanaan", "total"),
    ("kas_awal", "Kas dan Bank Awal Periode", "bali[('account_type','=','asset_cash')]", None),
    ("kas_akhir_hitung", "Kas dan Bank Akhir Periode (hasil hitung)", "kas_awal + kenaikan_kas", "sub"),
    ("kas_akhir", "Kas dan Bank Akhir Periode (saldo buku)", "bale[('account_type','=','asset_cash')]", "sub"),
    ("cek", "Selisih saldo kas (harus 0)", "kas_akhir - kas_akhir_hitung", "check"),
]

RINGKASAN = [
    ("h_kinerja", "KINERJA PERIODE", "", "header"),
    ("pendapatan", "Pendapatan Bersih", "-balp[41%] - balp[42000060,42000070]", None),
    ("laba_kotor", "Laba Kotor", "pendapatan - balp[51000010,51000020,42500010]", None),
    ("margin_kotor", "Margin Laba Kotor", "laba_kotor / pendapatan", None, "pct"),
    ("laba_bersih", "Laba Bersih", f"-balp[('account_type','in',({PNL_TYPES}))]", "total"),
    ("margin_bersih", "Margin Laba Bersih", "laba_bersih / pendapatan", None, "pct"),
    ("h_posisi", "POSISI KEUANGAN (akhir periode)", "", "header"),
    ("kas_bank", "Kas dan Bank", "bale[('account_type','=','asset_cash')]", None),
    ("piutang_usaha", "Piutang Usaha", "bale[11210010,11210011]", None),
    ("persediaan", "Persediaan", "bale[113%]", None),
    ("hutang_usaha", "Hutang Usaha", "-bale[21100010]", None),
    ("hutang_pajak", "Hutang Pajak", "-bale[2122%,2121%,21100011,21100012,21100014]", None),
    ("modal_kerja", "Modal Kerja Bersih (piutang + persediaan + kas - hutang usaha - hutang pajak)", "kas_bank + piutang_usaha + persediaan - hutang_usaha - hutang_pajak", "sub"),
    ("rasio_kas", "Kas terhadap Hutang Usaha (kali)", "kas_bank / hutang_usaha", None, "num"),
]

# Neraca saldo: satu KPI ber-subkolom yang diperluas per akun.
NERACA_SALDO_COLUMNS = [
    ("saldo_awal", "Saldo Awal", "bali[]"),
    ("debit", "Debit", "debp[]"),
    ("kredit", "Kredit", "crdp[]"),
    ("saldo_akhir", "Saldo Akhir", "bale[]"),
]

REPORTS = [
    {"key": "mis_laba_rugi", "name": "Laba Rugi", "description": "Laporan laba rugi menurut COA Indonesia (l10n_id).", "kpis": LABA_RUGI},
    {"key": "mis_neraca", "name": "Neraca", "description": "Laporan posisi keuangan menurut COA Indonesia (l10n_id).", "kpis": NERACA},
    {"key": "mis_arus_kas", "name": "Arus Kas", "description": "Laporan arus kas metode tidak langsung, diuji terhadap saldo kas dan bank.", "kpis": ARUS_KAS},
    {"key": "mis_ringkasan", "name": "Ringkasan Eksekutif", "description": "Kinerja dan posisi keuangan dalam satu halaman.", "kpis": RINGKASAN},
    {
        "key": "mis_neraca_saldo",
        "name": "Neraca Saldo",
        "description": "Saldo awal, mutasi, dan saldo akhir per akun.",
        "columns": NERACA_SALDO_COLUMNS,
        "expand": "Neraca Saldo",
    },
]

# Instance bawaan untuk klien web Odoo (Akuntansi > Laporan MIS); UI Nusara membuat instance sementara sendiri.
INSTANCES = [
    {"key": "mis_laba_rugi_ytd", "name": "Laba Rugi - tahun berjalan dan tahun lalu", "report": "mis_laba_rugi", "periods": [("Tahun berjalan", 0), ("Tahun lalu", -1)]},
    {"key": "mis_neraca_ytd", "name": "Neraca - tahun berjalan dan tahun lalu", "report": "mis_neraca", "periods": [("Tahun berjalan", 0), ("Tahun lalu", -1)]},
    {"key": "mis_arus_kas_ytd", "name": "Arus Kas - tahun berjalan", "report": "mis_arus_kas", "periods": [("Tahun berjalan", 0)]},
    {"key": "mis_ringkasan_ytd", "name": "Ringkasan Eksekutif - tahun berjalan", "report": "mis_ringkasan", "periods": [("Tahun berjalan", 0)]},
    {"key": "mis_neraca_saldo_ytd", "name": "Neraca Saldo - tahun berjalan", "report": "mis_neraca_saldo", "periods": [("Tahun berjalan", 0)]},
]
