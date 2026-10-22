"""Data bawaan payroll Indonesia (D86, Q59): parameter bertanggal, akun, kategori, dan aturan gaji.

Semua angka hukum di sini hanya NILAI AWAL yang dimasukkan ke tabel parameter oleh tombol Pasang Aturan Indonesia; sesudah itu petugas payroll
memperbaruinya di UI (Payroll > Setting) tanpa menyentuh kode. Sumber tiap angka dicatat di kolom Sumber Hukum dan di docs/DECISIONS.md (D86).
Tanggal awal data 2024-01-01 dipilih karena tarif TER berlaku sejak 1 Januari 2024; slip sebelum tanggal itu tidak didukung kecuali petugas mengisi
parameter dengan tanggal berlaku lebih awal.
"""

from .payroll_id_ter import TER_A, TER_B, TER_C

START = "2024-01-01"

SRC_KES = "Perpres 82/2018 jo. Perpres 64/2020 Pasal 30 dan 32 (salinan JDIH Kemenkeu, diakses 22 Okt 2026)"
SRC_TK = "bpjsketenagakerjaan.go.id, artikel Berapa Besaran Iuran JHT, JKK, JKM, JP dan JKP (diakses 22 Okt 2026); PP 46/2015 (JHT), PP 45/2015 (JP), PP 44/2015 (JKK, JKM)"
SRC_JP_CAP = "Surat BPJS Ketenagakerjaan No. B/1226/022026 tanggal 25 Feb 2026 dan akun resmi BPJS Ketenagakerjaan di X (diakses 22 Okt 2026); PP 45/2015"
SRC_PTKP = "PMK 101/PMK.010/2016; contoh PP 58/2023 dan PMK 168/2023 (K/0 = Rp58.500.000)"
SRC_JABATAN = "PMK 168/2023 Pasal 10 ayat (2) (salinan peraturan.go.id, diakses 22 Okt 2026)"
SRC_TER = "PP 58/2023 Lampiran A, B, C; kategori menurut Pasal 2 ayat (4) (peraturan.go.id dan salinan IAI, diakses 22 Okt 2026)"
SRC_P17 = "UU 7/2021 (HPP) Pasal 17 ayat (1) huruf a, sebagaimana dikutip PP 58/2023 dan contoh PMK 168/2023"

# (kode, nama, nilai, satuan, berlaku mulai, sumber, catatan)
PARAMS_BPJS = [
    ("bpjs_kes_perusahaan", "BPJS Kesehatan - iuran perusahaan", 4.0, "persen", START, SRC_KES, "Persen dari upah (gaji pokok + tunjangan tetap) sampai batas atas."),
    ("bpjs_kes_karyawan", "BPJS Kesehatan - iuran karyawan", 1.0, "persen", START, SRC_KES, "Dipotong dari gaji karyawan."),
    ("bpjs_kes_batas_atas", "BPJS Kesehatan - batas atas upah", 12_000_000.0, "rupiah", START, SRC_KES, "Upah di atas batas ini tidak menambah iuran."),
    (
        "bpjs_kes_batas_bawah",
        "BPJS Kesehatan - batas bawah upah (UMP/UMK)",
        0.0,
        "rupiah",
        START,
        SRC_KES + "; Pasal 32 ayat (2)-(4)",
        "PERLU DIISI bila gaji ada di bawah upah minimum: isi dengan UMP/UMK tempat perusahaan berada (berbeda per daerah, tidak diisi otomatis). 0 = tidak dipakai.",
    ),
    ("bpjs_jht_perusahaan", "BPJS JHT - iuran perusahaan", 3.7, "persen", START, SRC_TK, "Tanpa batas upah."),
    ("bpjs_jht_karyawan", "BPJS JHT - iuran karyawan", 2.0, "persen", START, SRC_TK, "Dipotong dari gaji; tanpa batas upah."),
    ("bpjs_jp_perusahaan", "BPJS JP - iuran perusahaan", 2.0, "persen", START, SRC_TK, "Sampai batas upah JP."),
    ("bpjs_jp_karyawan", "BPJS JP - iuran karyawan", 1.0, "persen", START, SRC_TK, "Dipotong dari gaji; sampai batas upah JP."),
    (
        "bpjs_jp_batas_upah",
        "BPJS JP - batas atas upah",
        11_086_300.0,
        "rupiah",
        "2026-03-01",
        SRC_JP_CAP,
        "Disesuaikan tiap Maret menurut pertumbuhan PDB (PP 45/2015). Nilai sebelum Maret 2026 sengaja belum diisi karena belum terverifikasi: slip periode sebelum 1 Maret 2026 meminta parameter ini diisi.",
    ),
    (
        "bpjs_jkk_perusahaan",
        "BPJS JKK - iuran perusahaan",
        0.24,
        "persen",
        START,
        SRC_TK,
        "Ditanggung perusahaan. Tarif menurut tingkat risiko: 0,24 / 0,54 / 0,89 / 1,27 / 1,74. Bawaan 0,24 (risiko sangat rendah): UBAH sesuai tarif perusahaan.",
    ),
    ("bpjs_jkm_perusahaan", "BPJS JKM - iuran perusahaan", 0.3, "persen", START, SRC_TK, "Ditanggung perusahaan."),
]

PARAMS_PPH = [
    ("ptkp_dasar", "PTKP - wajib pajak sendiri (TK/0)", 54_000_000.0, "rupiah", START, SRC_PTKP, "Setahun."),
    ("ptkp_kawin", "PTKP - tambahan status kawin", 4_500_000.0, "rupiah", START, SRC_PTKP, "Setahun."),
    ("ptkp_tanggungan", "PTKP - tambahan per tanggungan", 4_500_000.0, "rupiah", START, SRC_PTKP, "Setahun, paling banyak 3 tanggungan (status 0 sampai 3)."),
    ("pph21_biaya_jabatan_persen", "Biaya jabatan - persen dari penghasilan bruto", 5.0, "persen", START, SRC_JABATAN, ""),
    ("pph21_biaya_jabatan_maks_bulan", "Biaya jabatan - batas sebulan", 500_000.0, "rupiah", START, SRC_JABATAN, "Dipakai juga untuk membatasi biaya jabatan Desember: batas sebulan x jumlah bulan bekerja."),
    ("pph21_biaya_jabatan_maks_tahun", "Biaya jabatan - batas setahun", 6_000_000.0, "rupiah", START, SRC_JABATAN, ""),
    ("pph21_pembulatan_pkp", "Pembulatan ke bawah penghasilan kena pajak", 1000.0, "rupiah", START, "PMK 168/2023 Pasal 8 ayat (4)", "PKP dibulatkan ke bawah hingga ribuan rupiah penuh."),
    (
        "pph21_tanpa_npwp_tambahan",
        "PPh 21 tanpa NPWP/NIK - tambahan tarif",
        20.0,
        "persen",
        START,
        "UU PPh Pasal 21 ayat (5a); sumber resmi DJP tidak dapat dibuka saat riset, diverifikasi lewat sumber sekunder",
        "Pajak dipotong 120% dari yang semestinya bila karyawan tidak punya NPWP maupun NIK. PERLU DIPERIKSA akuntan.",
    ),
]

# (tabel, batas atas, tarif) disusun di payroll_id_ter.py; Pasal 17 ditulis di sini
PASAL17 = [(60_000_000, 5.0), (250_000_000, 15.0), (500_000_000, 25.0), (5_000_000_000, 30.0), (0, 35.0)]
BRACKETS = [
    ("ter_a", START, TER_A, SRC_TER),
    ("ter_b", START, TER_B, SRC_TER),
    ("ter_c", START, TER_C, SRC_TER),
    ("pasal17", START, PASAL17, SRC_P17),
]

# (kunci, kode, nama bila akun baru, jenis akun). Akun l10n_id yang sudah ada dipakai apa adanya (nama aslinya tidak diubah).
ACCOUNTS = [
    ("expense_salary", "61100010", "Beban Gaji", "expense"),
    ("expense_benefit", "61100020", "Beban Bonus dan Tunjangan", "expense"),
    ("expense_overtime", "61100030", "Beban Lembur", "expense"),
    ("expense_bpjs", "61100040", "Beban BPJS Perusahaan", "expense"),
    ("expense_taxalw", "61100100", "Beban Tunjangan PPh 21", "expense"),
    ("payable_salary", "21100050", "Hutang Gaji", "liability_payable"),
    ("payable_bpjs_kes", "25110110", "Hutang BPJS Kesehatan", "liability_current"),
    ("payable_bpjs_tk", "25110020", "Hutang BPJS Ketenagakerjaan", "liability_current"),
    ("payable_pph21", "21210010", "Hutang PPh 21", "liability_current"),
]

REGISTERS = [("bpjs_kes", "BPJS Kesehatan"), ("bpjs_tk", "BPJS Ketenagakerjaan"), ("pph21", "Kantor Pajak (PPh 21)")]

CATEGORIES = [
    ("BASIC", "Gaji Pokok"),
    ("ALW", "Tunjangan Tetap"),
    ("VAR", "Penghasilan Tidak Tetap"),
    ("DED", "Potongan Kehadiran"),
    ("POT", "Potongan Lain"),
    ("BPJSK", "Iuran BPJS Karyawan"),
    ("PAJAK", "PPh 21"),
    ("BPJSPT", "Iuran BPJS Perusahaan (Kena Pajak)"),
    ("BPJSPN", "Iuran BPJS Perusahaan (Bukan Objek Pajak)"),
    ("INFO", "Informasi Pajak"),
    ("NET", "Gaji Bersih"),
]

_BASE = "categories.BASIC + categories.ALW"
_NAME = "'{:,.0f}'.format(base).replace(',', '.')"


def _bpjs_code(program, who, cap_expr=None):
    """Ekspresi iuran persentase dari upah (gaji pokok + tunjangan tetap), dibulatkan ke rupiah. `who` = karyawan (potongan, negatif) atau perusahaan."""
    sign = "-" if who == "karyawan" else ""
    base = f"base = {_BASE}" if not cap_expr else f"base = {cap_expr}"
    label = {"kes": "BPJS Kesehatan", "jht": "BPJS JHT", "jp": "BPJS JP", "jkk": "BPJS JKK", "jkm": "BPJS JKM"}[program]
    return (
        f"{base}\n"
        f"rate = tools.param('bpjs_{program}_{who}')\n"
        f"result = {sign}tools.rp(base * rate / 100.0)\n"
        f"result_name = '{label} ({who}) ' + ('%g' % rate).replace('.', ',') + '% dari Rp' + {_NAME}\n"
    )


# Aturan gaji. Tiap aturan: kunci (xml id), kode, nama, urutan, kategori, python (jumlah), kondisi python (opsional), input (opsional), akun debit/kredit, register.
RULES_BASE = [
    {
        "key": "gapok", "code": "GAPOK", "name": "Gaji Pokok", "sequence": 10, "category": "BASIC",
        "amount_select": "percentage", "amount_percentage": 100.0, "amount_percentage_base": "contract.wage",
        "debit": "expense_salary", "note": "Gaji pokok dari versi kontrak karyawan (kolom Gaji).",
    },
    {
        "key": "tunj", "code": "TUNJ", "name": "Tunjangan Tetap Lain", "sequence": 20, "category": "ALW",
        "python": "result = inputs.TUNJ.amount if inputs.TUNJ else 0.0", "inputs": [("TUNJ", "Tunjangan Tetap Lain")],
        "debit": "expense_salary", "note": "Tunjangan tetap tambahan, diisi di input slip. Ikut dasar iuran BPJS.",
    },
]

RULES_BPJS = [
    {
        "key": "bpjs_kes_k", "code": "BPJS_KES_K", "name": "BPJS Kesehatan (karyawan)", "sequence": 110, "category": "BPJSK",
        "condition": "result = bool(employee.kompakapps_bpjs_kes)",
        "python": _bpjs_code("kes", "karyawan", f"max(min({_BASE}, tools.param('bpjs_kes_batas_atas')), tools.param('bpjs_kes_batas_bawah'))"),
        "debit": "payable_bpjs_kes", "register": "bpjs_kes", "note": "Dipotong dari gaji. Dasar: gaji pokok + tunjangan tetap, dibatasi batas atas (dan batas bawah bila diisi).",
    },
    {
        "key": "bpjs_jht_k", "code": "BPJS_JHT_K", "name": "BPJS JHT (karyawan)", "sequence": 120, "category": "BPJSK",
        "condition": "result = bool(employee.kompakapps_bpjs_jht)", "python": _bpjs_code("jht", "karyawan"),
        "debit": "payable_bpjs_tk", "register": "bpjs_tk", "note": "Dipotong dari gaji. Tanpa batas upah.",
    },
    {
        "key": "bpjs_jp_k", "code": "BPJS_JP_K", "name": "BPJS JP (karyawan)", "sequence": 130, "category": "BPJSK",
        "condition": "result = bool(employee.kompakapps_bpjs_jp)", "python": _bpjs_code("jp", "karyawan", f"min({_BASE}, tools.param('bpjs_jp_batas_upah'))"),
        "debit": "payable_bpjs_tk", "register": "bpjs_tk", "note": "Dipotong dari gaji. Dibatasi batas upah JP.",
    },
    {
        "key": "bpjs_kes_p", "code": "BPJS_KES_P", "name": "BPJS Kesehatan (perusahaan)", "sequence": 140, "category": "BPJSPT",
        "condition": "result = bool(employee.kompakapps_bpjs_kes)",
        "python": _bpjs_code("kes", "perusahaan", f"max(min({_BASE}, tools.param('bpjs_kes_batas_atas')), tools.param('bpjs_kes_batas_bawah'))"),
        "debit": "expense_bpjs", "credit": "payable_bpjs_kes", "register": "bpjs_kes",
        "note": "Beban perusahaan, tidak mengurangi gaji bersih. Merupakan penghasilan kena pajak karyawan (PMK 168/2023 Pasal 5 ayat (3)).",
    },
    {
        "key": "bpjs_jht_p", "code": "BPJS_JHT_P", "name": "BPJS JHT (perusahaan)", "sequence": 150, "category": "BPJSPN",
        "condition": "result = bool(employee.kompakapps_bpjs_jht)", "python": _bpjs_code("jht", "perusahaan"),
        "debit": "expense_bpjs", "credit": "payable_bpjs_tk", "register": "bpjs_tk",
        "note": "Beban perusahaan, tidak mengurangi gaji bersih. Bukan penghasilan kena pajak karyawan (PMK 168/2023 Pasal 7 huruf c).",
    },
    {
        "key": "bpjs_jp_p", "code": "BPJS_JP_P", "name": "BPJS JP (perusahaan)", "sequence": 160, "category": "BPJSPN",
        "condition": "result = bool(employee.kompakapps_bpjs_jp)", "python": _bpjs_code("jp", "perusahaan", f"min({_BASE}, tools.param('bpjs_jp_batas_upah'))"),
        "debit": "expense_bpjs", "credit": "payable_bpjs_tk", "register": "bpjs_tk",
        "note": "Beban perusahaan, tidak mengurangi gaji bersih. Bukan penghasilan kena pajak karyawan.",
    },
    {
        "key": "bpjs_jkk_p", "code": "BPJS_JKK_P", "name": "BPJS JKK (perusahaan)", "sequence": 170, "category": "BPJSPT",
        "condition": "result = bool(employee.kompakapps_bpjs_jkk)", "python": _bpjs_code("jkk", "perusahaan"),
        "debit": "expense_bpjs", "credit": "payable_bpjs_tk", "register": "bpjs_tk",
        "note": "Ditanggung perusahaan sesuai tingkat risiko. Merupakan penghasilan kena pajak karyawan (PMK 168/2023 Pasal 5 ayat (3)).",
    },
    {
        "key": "bpjs_jkm_p", "code": "BPJS_JKM_P", "name": "BPJS JKM (perusahaan)", "sequence": 180, "category": "BPJSPT",
        "condition": "result = bool(employee.kompakapps_bpjs_jkm)", "python": _bpjs_code("jkm", "perusahaan"),
        "debit": "expense_bpjs", "credit": "payable_bpjs_tk", "register": "bpjs_tk",
        "note": "Ditanggung perusahaan. Merupakan penghasilan kena pajak karyawan (PMK 168/2023 Pasal 5 ayat (3)).",
    },
]

RULE_NET = {
    "key": "net", "code": "NET", "name": "Gaji Bersih", "sequence": 900, "category": "NET",
    "python": "result = categories.BASIC + categories.ALW + categories.VAR + categories.DED + categories.POT + categories.BPJSK + categories.PAJAK",
    "credit": "payable_salary",
    "note": "Penghasilan + potongan (potongan, iuran karyawan, dan PPh 21 bernilai negatif). Iuran BPJS perusahaan tidak ikut.",
}

RULES = RULES_BASE + RULES_BPJS + [RULE_NET]
PARAMS = PARAMS_BPJS + PARAMS_PPH
