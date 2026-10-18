"""Template laporan keuangan MIS Builder untuk COA Indonesia (l10n_id).

Sejak D67 baris Laba Rugi, Neraca, Arus Kas, dan Ringkasan tidak lagi memuat daftar kode akun tetap: tiap akun punya "Pos Laporan"
(field kompakapps_report_group pada master akun, lihat account_report_group.py) dan baris laporan menjumlah akun menurut pos itu, dengan
uraian per akun di bawahnya. Akun baru terisi otomatis dari kode dan jenisnya dan langsung muncul di laporan. Setiap laporan punya baris
pemeriksaan ("harus 0") yang menyala bila ada akun yang dipilih "Tidak dilaporkan" tetapi bersaldo.

Sintaks MIS: balp = saldo mutasi periode, bale = saldo akhir, bali = saldo awal, debp/crdp = debit/kredit periode.
Aset dan beban bertanda positif pada saldo debit; kewajiban, ekuitas, dan pendapatan dikalikan -1.
"""

PNL_TYPES = "'income','income_other','expense','expense_direct_cost','expense_depreciation','expense_other'"
# Catatan sintaks: kurung siku di dalam balp[...] memotong rumus, jadi domain akun ditulis sebagai tuple.
EXPAND = {"expand": True}  # baris diperluas per akun (satu baris rincian per akun yang punya nilai)


def grp(*groups):
    """Domain akun untuk satu atau beberapa pos laporan, mis. ('kompakapps_report_group','=','penjualan')."""
    if len(groups) == 1:
        return f"('kompakapps_report_group','=','{groups[0]}')"
    return f"('kompakapps_report_group','in',({','.join(repr(g) for g in groups)}))"


def mut(*groups):
    """Mutasi periode untuk pos laporan: balp[...]."""
    return f"balp[{grp(*groups)}]"


def akhir(*groups):
    """Saldo akhir untuk pos laporan: bale[...]."""
    return f"bale[{grp(*groups)}]"


# Baris: (nama teknis, label, rumus, gaya, jenis, opsi). Gaya: None, "header", "sub", "total", "check". Jenis dan opsi boleh dihilangkan.
LABA_RUGI = [
    ("h_pendapatan", "PENDAPATAN USAHA", "", "header"),
    ("penjualan", "Penjualan", f"-{mut('penjualan')}", None, "num", EXPAND),
    ("retur_diskon", "Retur dan Potongan Penjualan", f"-{mut('retur_diskon')}", None, "num", EXPAND),
    ("pendapatan_bersih", "Pendapatan Bersih", "penjualan + retur_diskon", "sub"),
    ("h_hpp", "HARGA POKOK", "", "header"),
    ("hpp_barang", "Harga Pokok Penjualan", mut("hpp_barang"), None, "num", EXPAND),
    ("pembelian_bahan", "Pembelian Bahan Baku", mut("pembelian_bahan"), None, "num", EXPAND),
    ("perubahan_persediaan", "Perubahan Persediaan", mut("perubahan_persediaan"), None, "num", EXPAND),
    ("hpp_total", "Total Harga Pokok", "hpp_barang + pembelian_bahan + perubahan_persediaan", "sub"),
    ("laba_kotor", "LABA KOTOR", "pendapatan_bersih - hpp_total", "total"),
    ("h_operasional", "BEBAN OPERASIONAL", "", "header"),
    ("beban_gaji", "Gaji dan Tunjangan", mut("beban_gaji"), None, "num", EXPAND),
    ("beban_umum", "Beban Umum dan Kantor", mut("beban_umum"), None, "num", EXPAND),
    ("beban_jasa", "Jasa, Sewa, dan Pemeliharaan", mut("beban_jasa"), None, "num", EXPAND),
    ("beban_kendaraan", "Kendaraan", mut("beban_kendaraan"), None, "num", EXPAND),
    ("beban_penyusutan", "Penyusutan", mut("beban_penyusutan"), None, "num", EXPAND),
    ("beban_lain_operasional", "Beban Operasional Lain", mut("beban_lain_operasional"), None, "num", EXPAND),
    (
        "beban_operasional",
        "Total Beban Operasional",
        "beban_gaji + beban_umum + beban_jasa + beban_kendaraan + beban_penyusutan + beban_lain_operasional",
        "sub",
    ),
    ("laba_usaha", "LABA USAHA", "laba_kotor - beban_operasional", "total"),
    ("h_lain", "PENDAPATAN DAN BEBAN LAIN", "", "header"),
    ("pendapatan_lain", "Pendapatan Lain", f"-{mut('pendapatan_lain')}", None, "num", EXPAND),
    ("beban_lain", "Beban Lain", mut("beban_lain"), None, "num", EXPAND),
    ("laba_sebelum_pajak", "LABA SEBELUM PAJAK", "laba_usaha + pendapatan_lain - beban_lain", "total"),
    ("beban_pajak", "Beban Pajak Penghasilan", mut("beban_pajak"), None, "num", EXPAND),
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
    ("kas_bank", "Kas dan Bank", akhir("kas_bank"), None, "num", EXPAND),
    ("pembayaran_tertunda", "Penerimaan dan Pembayaran Tertunda", akhir("pembayaran_tertunda"), None, "num", EXPAND),
    ("piutang_usaha", "Piutang Usaha", akhir("piutang_usaha"), None, "num", EXPAND),
    ("persediaan", "Persediaan", akhir("persediaan"), None, "num", EXPAND),
    ("pajak_dimuka", "Pajak Dibayar di Muka", akhir("pajak_dimuka"), None, "num", EXPAND),
    ("biaya_dimuka", "Biaya Dibayar di Muka", akhir("biaya_dimuka"), None, "num", EXPAND),
    ("aset_lancar_lain", "Aset Lancar Lain", akhir("aset_lancar_lain"), None, "num", EXPAND),
    (
        "aset_lancar",
        "Total Aset Lancar",
        "kas_bank + pembayaran_tertunda + piutang_usaha + persediaan + pajak_dimuka + biaya_dimuka + aset_lancar_lain",
        "sub",
    ),
    ("aset_tetap_bruto", "Aset Tetap (Harga Perolehan)", akhir("aset_tetap_bruto"), None, "num", EXPAND),
    ("akumulasi_penyusutan", "Akumulasi Penyusutan", akhir("akumulasi_penyusutan"), None, "num", EXPAND),
    ("aset_tetap_neto", "Aset Tetap Neto", "aset_tetap_bruto + akumulasi_penyusutan", "sub"),
    ("aset_lain", "Aset Tidak Lancar Lain", akhir("aset_lain"), None, "num", EXPAND),
    ("total_aset", "TOTAL ASET", "aset_lancar + aset_tetap_neto + aset_lain", "total"),
    ("h_liabilitas", "LIABILITAS", "", "header"),
    ("hutang_usaha", "Hutang Usaha", f"-{akhir('hutang_usaha')}", None, "num", EXPAND),
    ("hutang_pajak", "Hutang Pajak", f"-{akhir('hutang_pajak')}", None, "num", EXPAND),
    ("uang_muka_pelanggan", "Uang Muka Pelanggan dan Pendapatan Diterima di Muka", f"-{akhir('uang_muka_pelanggan')}", None, "num", EXPAND),
    ("biaya_akrual", "Biaya yang Masih Harus Dibayar", f"-{akhir('biaya_akrual')}", None, "num", EXPAND),
    ("hutang_bank", "Pinjaman Bank dan Leasing", f"-{akhir('hutang_bank')}", None, "num", EXPAND),
    ("hutang_lain", "Hutang Lain-lain", f"-{akhir('hutang_lain')}", None, "num", EXPAND),
    (
        "total_liabilitas",
        "TOTAL LIABILITAS",
        "hutang_usaha + hutang_pajak + uang_muka_pelanggan + biaya_akrual + hutang_bank + hutang_lain",
        "total",
    ),
    ("h_ekuitas", "EKUITAS", "", "header"),
    ("modal", "Modal Disetor dan Prive", f"-{akhir('modal')}", None, "num", EXPAND),
    ("cadangan", "Cadangan Modal", f"-{akhir('cadangan')}", None, "num", EXPAND),
    ("saldo_laba", "Saldo Laba Ditahan", f"-{akhir('saldo_laba')}", None, "num", EXPAND),
    ("laba_berjalan", "Laba (Rugi) Tahun Berjalan", f"-bale[('account_type','in',({PNL_TYPES}))]", None),
    ("total_ekuitas", "TOTAL EKUITAS", "modal + cadangan + saldo_laba + laba_berjalan", "total"),
    ("total_liabilitas_ekuitas", "TOTAL LIABILITAS DAN EKUITAS", "total_liabilitas + total_ekuitas", "total"),
    ("cek", "Selisih aset dan liabilitas + ekuitas (harus 0)", "total_aset - total_liabilitas_ekuitas", "check"),
]

ARUS_KAS = [
    ("h_operasi", "ARUS KAS DARI AKTIVITAS OPERASI", "", "header"),
    ("laba_bersih", "Laba (Rugi) Bersih", f"-balp[('account_type','in',({PNL_TYPES}))]", None),
    ("penyusutan", "Penyusutan (beban nontunai)", mut("beban_penyusutan"), None),
    ("d_piutang", "Perubahan Piutang Usaha", f"-{mut('piutang_usaha')}", None),
    ("d_persediaan", "Perubahan Persediaan", f"-{mut('persediaan')}", None),
    ("d_dimuka", "Perubahan Pajak dan Biaya Dibayar di Muka", f"-{mut('pajak_dimuka', 'biaya_dimuka', 'aset_lancar_lain')}", None),
    ("d_tertunda", "Perubahan Penerimaan dan Pembayaran Tertunda", f"-{mut('pembayaran_tertunda')}", None),
    ("d_hutang_usaha", "Perubahan Hutang Usaha", f"-{mut('hutang_usaha')}", None),
    ("d_hutang_pajak", "Perubahan Hutang Pajak", f"-{mut('hutang_pajak')}", None),
    ("d_kewajiban_lain", "Perubahan Kewajiban Lain", f"-{mut('uang_muka_pelanggan', 'biaya_akrual', 'hutang_lain')}", None),
    (
        "kas_operasi",
        "Kas Bersih dari Aktivitas Operasi",
        "laba_bersih + penyusutan + d_piutang + d_persediaan + d_dimuka + d_tertunda + d_hutang_usaha + d_hutang_pajak + d_kewajiban_lain",
        "total",
    ),
    ("h_investasi", "ARUS KAS DARI AKTIVITAS INVESTASI", "", "header"),
    ("aset_tetap", "Perolehan Aset Tetap", f"-{mut('aset_tetap_bruto', 'akumulasi_penyusutan')} - penyusutan", None),
    ("aset_lain", "Perubahan Aset Tidak Lancar Lain", f"-{mut('aset_lain')}", None),
    ("kas_investasi", "Kas Bersih dari Aktivitas Investasi", "aset_tetap + aset_lain", "total"),
    ("h_pendanaan", "ARUS KAS DARI AKTIVITAS PENDANAAN", "", "header"),
    ("pinjaman", "Perubahan Pinjaman Bank dan Leasing", f"-{mut('hutang_bank')}", None),
    ("modal", "Perubahan Modal dan Cadangan", f"-{mut('modal', 'cadangan')}", None),
    ("laba_ditahan", "Perubahan Saldo Laba Ditahan", f"-{mut('saldo_laba')}", None),
    ("kas_pendanaan", "Kas Bersih dari Aktivitas Pendanaan", "pinjaman + modal + laba_ditahan", "total"),
    ("kenaikan_kas", "KENAIKAN (PENURUNAN) KAS BERSIH", "kas_operasi + kas_investasi + kas_pendanaan", "total"),
    ("kas_awal", "Kas dan Bank Awal Periode", f"bali[{grp('kas_bank')}]", None),
    ("kas_akhir_hitung", "Kas dan Bank Akhir Periode (hasil hitung)", "kas_awal + kenaikan_kas", "sub"),
    ("kas_akhir", "Kas dan Bank Akhir Periode (saldo buku)", akhir("kas_bank"), "sub"),
    ("cek", "Selisih saldo kas (harus 0)", "kas_akhir - kas_akhir_hitung", "check"),
]

RINGKASAN = [
    ("h_kinerja", "KINERJA PERIODE", "", "header"),
    ("pendapatan", "Pendapatan Bersih", f"-{mut('penjualan', 'retur_diskon')}", None),
    ("laba_kotor", "Laba Kotor", f"pendapatan - {mut('hpp_barang', 'pembelian_bahan', 'perubahan_persediaan')}", None),
    ("margin_kotor", "Margin Laba Kotor", "laba_kotor / pendapatan", None, "pct"),
    ("laba_bersih", "Laba Bersih", f"-balp[('account_type','in',({PNL_TYPES}))]", "total"),
    ("margin_bersih", "Margin Laba Bersih", "laba_bersih / pendapatan", None, "pct"),
    ("h_posisi", "POSISI KEUANGAN (akhir periode)", "", "header"),
    ("kas_bank", "Kas dan Bank", akhir("kas_bank"), None),
    ("piutang_usaha", "Piutang Usaha", akhir("piutang_usaha"), None),
    ("persediaan", "Persediaan", akhir("persediaan"), None),
    ("hutang_usaha", "Hutang Usaha", f"-{akhir('hutang_usaha')}", None),
    ("hutang_pajak", "Hutang Pajak", f"-{akhir('hutang_pajak')}", None),
    ("modal_kerja", "Modal Kerja Bersih (piutang + persediaan + kas - hutang usaha - hutang pajak)", "kas_bank + piutang_usaha + persediaan - hutang_usaha - hutang_pajak", "sub"),
    ("rasio_kas", "Kas terhadap Hutang Usaha (kali)", "kas_bank / hutang_usaha", None, "num"),
]

# Anggaran vs realisasi per akun (D31). Pendapatan, harga pokok, dan beban diperluas per akun menurut jenis akun, jadi tidak ada
# akun laba rugi yang terlewat. Kolom anggaran memakai sumber "mis_budget_by_account" (mis_builder_budget). Label baris dipakai UI
# (pages/budgetreport.js) untuk memberi warna selisih; ubah keduanya bersama. Baris: (nama, label, rumus, gaya, jenis, opsi).
ANGGARAN = [
    ("pendapatan", "Pendapatan", "-balp[('account_type','in',('income','income_other'))]", "sub", "num", {"expand": True}),
    ("harga_pokok", "Harga Pokok", "balp[('account_type','=','expense_direct_cost')]", "sub", "num", {"expand": True}),
    (
        "beban",
        "Beban",
        "balp[('account_type','in',('expense','expense_depreciation','expense_other'))]",
        "sub",
        "num",
        {"expand": True},
    ),
    ("laba_bersih", "LABA (RUGI) BERSIH", "pendapatan - harga_pokok - beban", "total"),
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
        "key": "mis_anggaran",
        "name": "Anggaran per Akun",
        "description": "Pendapatan, harga pokok, dan beban per akun; dipakai untuk membandingkan anggaran dengan realisasi.",
        "kpis": ANGGARAN,
    },
    {
        "key": "mis_neraca_saldo",
        "name": "Neraca Saldo",
        "description": "Saldo awal, mutasi, dan saldo akhir per akun.",
        "columns": NERACA_SALDO_COLUMNS,
        "expand": "Neraca Saldo",
    },
]

# Instance bawaan untuk klien web Odoo (Akuntansi > Laporan MIS); UI KompakApps membuat instance sementara sendiri.
INSTANCES = [
    {"key": "mis_laba_rugi_ytd", "name": "Laba Rugi - tahun berjalan dan tahun lalu", "report": "mis_laba_rugi", "periods": [("Tahun berjalan", 0), ("Tahun lalu", -1)]},
    {"key": "mis_neraca_ytd", "name": "Neraca - tahun berjalan dan tahun lalu", "report": "mis_neraca", "periods": [("Tahun berjalan", 0), ("Tahun lalu", -1)]},
    {"key": "mis_arus_kas_ytd", "name": "Arus Kas - tahun berjalan", "report": "mis_arus_kas", "periods": [("Tahun berjalan", 0)]},
    {"key": "mis_ringkasan_ytd", "name": "Ringkasan Eksekutif - tahun berjalan", "report": "mis_ringkasan", "periods": [("Tahun berjalan", 0)]},
    {"key": "mis_neraca_saldo_ytd", "name": "Neraca Saldo - tahun berjalan", "report": "mis_neraca_saldo", "periods": [("Tahun berjalan", 0)]},
]
