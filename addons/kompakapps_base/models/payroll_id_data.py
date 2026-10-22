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

SRC_LEMBUR = "PP 35/2021 Pasal 31 dan 32 (peraturan.go.id, diakses 22 Okt 2026); menggantikan Kepmenakertrans 102/2004 yang disebut di brief"
SRC_THR = "Permenaker 6/2016 Pasal 2-3 dan PP 36/2021 (PDF resmi berupa pindaian tanpa teks; diverifikasi lewat Hukumonline dan Bisnis.com, 22 Okt 2026)"

PARAMS_COMP = [
    ("lembur_pembagi", "Lembur - pembagi upah sejam", 173.0, "angka", START, SRC_LEMBUR, "Upah sejam = upah sebulan / 173 (Pasal 32 ayat 2)."),
    ("lembur_dasar_minimum_persen", "Lembur - dasar upah minimum dari seluruh upah", 75.0, "persen", START, SRC_LEMBUR, "Bila gaji pokok + tunjangan tetap kurang dari 75% seluruh upah (ada tunjangan tidak tetap), dasar lembur 75% seluruh upah (Pasal 32 ayat 4)."),
    ("lembur_hk_jam_pertama", "Lembur hari kerja - pengali jam pertama", 1.5, "kali", START, SRC_LEMBUR, "Pasal 31 ayat 1 huruf a."),
    ("lembur_hk_jam_berikutnya", "Lembur hari kerja - pengali jam berikutnya", 2.0, "kali", START, SRC_LEMBUR, "Pasal 31 ayat 1 huruf b."),
    ("lembur_libur_x1", "Lembur hari istirahat atau libur resmi - pengali jam awal", 2.0, "kali", START, SRC_LEMBUR, "Pasal 31 ayat 2 dan 3."),
    ("lembur_libur_x2", "Lembur hari istirahat atau libur resmi - pengali jam sesudahnya", 3.0, "kali", START, SRC_LEMBUR, "Satu jam sesudah jam awal."),
    ("lembur_libur_x3", "Lembur hari istirahat atau libur resmi - pengali jam berikutnya", 4.0, "kali", START, SRC_LEMBUR, "Jam sesudah itu."),
    ("lembur_libur_jam_x1_5hari", "Lembur hari libur - jumlah jam pengali awal (5 hari kerja)", 8.0, "angka", START, SRC_LEMBUR, "Pasal 31 ayat 3: jam pertama sampai kedelapan 2x, jam kesembilan 3x, kesepuluh dst 4x."),
    ("lembur_libur_jam_x1_6hari", "Lembur hari libur - jumlah jam pengali awal (6 hari kerja)", 7.0, "angka", START, SRC_LEMBUR, "Pasal 31 ayat 2: jam pertama sampai ketujuh 2x, jam kedelapan 3x, kesembilan dst 4x. Hari libur resmi pada hari kerja terpendek tidak dibedakan."),
    ("thr_masa_kerja_penuh_bulan", "THR - masa kerja untuk satu bulan upah penuh", 12.0, "angka", START, SRC_THR, "Masa kerja 12 bulan terus-menerus atau lebih = satu bulan upah."),
    ("thr_masa_kerja_minimum_bulan", "THR - masa kerja minimum", 1.0, "angka", START, SRC_THR, "Masa kerja 1 bulan atau lebih berhak THR proporsional (masa kerja/12)."),
    ("thr_bulan_upah", "THR - jumlah bulan upah untuk masa kerja penuh", 1.0, "kali", START, SRC_THR, "Naikkan bila perjanjian kerja atau kebiasaan perusahaan memberi lebih dari satu bulan."),
    ("terlambat_per_kejadian", "Potongan terlambat - per kejadian", 0.0, "rupiah", START, "Kebijakan perusahaan", "NONAKTIF (0). Isi bila perusahaan memotong gaji per hari terlambat."),
    ("terlambat_per_menit", "Potongan terlambat - per menit", 0.0, "rupiah", START, "Kebijakan perusahaan", "NONAKTIF (0). Isi bila perusahaan memotong gaji per menit terlambat."),
    ("terlambat_toleransi_menit", "Potongan terlambat - toleransi menit", 0.0, "angka", START, "Kebijakan perusahaan", "Menit pertama yang tidak dihitung terlambat."),
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
    ("payable_deduction", "21100060", "Hutang Potongan Karyawan", "liability_current"),
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

RULES_COMP = [
    {
        "key": "tunj_transport", "code": "TUNJ_TRANSPORT", "name": "Tunjangan Transport", "sequence": 30, "category": "ALW",
        "condition": "result = bool(contract.kompakapps_allow_transport)", "python": "result = contract.kompakapps_allow_transport\n",
        "debit": "expense_salary", "note": "Tunjangan tetap bulanan dari kontrak (kolom Tunjangan Transport Tetap). Ikut dasar BPJS, lembur, dan THR.",
    },
    {
        "key": "tunj_makan", "code": "TUNJ_MAKAN", "name": "Tunjangan Makan", "sequence": 31, "category": "ALW",
        "condition": "result = bool(contract.kompakapps_allow_meal)", "python": "result = contract.kompakapps_allow_meal\n",
        "debit": "expense_salary", "note": "Tunjangan tetap bulanan dari kontrak (kolom Tunjangan Makan Tetap). Ikut dasar BPJS, lembur, dan THR.",
    },
    {
        "key": "tunj_harian", "code": "TUNJ_HARIAN", "name": "Tunjangan Harian", "sequence": 40, "category": "VAR",
        "condition": "result = bool(contract.kompakapps_allow_daily and worked_days.HADIR)",
        "python": "result = contract.kompakapps_allow_daily * worked_days.HADIR.number_of_days\nresult_name = 'Tunjangan harian x ' + ('%g' % worked_days.HADIR.number_of_days) + ' hari hadir'\n",
        "debit": "expense_benefit", "note": "Tunjangan harian dari kontrak dikali hari hadir menurut Attendance. Tunjangan tidak tetap: tidak ikut dasar BPJS dan THR.",
    },
    {
        "key": "lembur", "code": "LEMBUR", "name": "Upah Lembur", "sequence": 50, "category": "VAR",
        "condition": "result = bool(worked_days.LEMBUR_SETARA and worked_days.LEMBUR_SETARA.number_of_hours) or bool(inputs.LEMBUR_KOREKSI and inputs.LEMBUR_KOREKSI.amount)",
        "python": (
            "fixed = categories.BASIC + categories.ALW\n"
            "daily = contract.kompakapps_allow_daily * (worked_days.HADIR.number_of_days if worked_days.HADIR else 0.0)\n"
            "base = max(fixed, tools.param('lembur_dasar_minimum_persen') / 100.0 * (fixed + daily))\n"
            "hourly = base / tools.param('lembur_pembagi')\n"
            "hours = (worked_days.LEMBUR_SETARA.number_of_hours if worked_days.LEMBUR_SETARA else 0.0) + (inputs.LEMBUR_KOREKSI.amount if inputs.LEMBUR_KOREKSI else 0.0)\n"
            "result = tools.rp(hourly * hours)\n"
            "result_name = 'Lembur ' + ('%.2f' % hours).replace('.', ',') + ' jam setara x upah sejam Rp' + '{:,.0f}'.format(hourly).replace(',', '.')\n"
        ),
        "inputs": [("LEMBUR_KOREKSI", "Koreksi jam lembur setara (boleh negatif)")],
        "debit": "expense_overtime",
        "note": "Upah sejam = dasar / 173; dasar = gaji pokok + tunjangan tetap (paling sedikit 75% seluruh upah bila ada tunjangan harian). Jam setara memuat pengali PP 35/2021 Pasal 31 dari Attendance (jam lembur divalidasi).",
    },
    {
        "key": "bonus", "code": "BONUS", "name": "Bonus", "sequence": 60, "category": "VAR",
        "condition": "result = bool(inputs.BONUS and inputs.BONUS.amount)", "python": "result = inputs.BONUS.amount\n", "inputs": [("BONUS", "Bonus")],
        "debit": "expense_benefit", "note": "Bonus diisi di input slip; digabung dengan penghasilan bulan itu pada PPh 21.",
    },
    {
        "key": "pot_absen", "code": "POT_ABSEN", "name": "Potongan Absen", "sequence": 70, "category": "DED",
        "condition": "result = bool((worked_days.ABSEN and worked_days.ABSEN.number_of_days) or (inputs.ABSEN_KOREKSI and inputs.ABSEN_KOREKSI.amount))",
        "python": (
            "days = (worked_days.ABSEN.number_of_days if worked_days.ABSEN else 0.0) + (inputs.ABSEN_KOREKSI.amount if inputs.ABSEN_KOREKSI else 0.0)\n"
            "scheduled = worked_days.JADWAL.number_of_days if worked_days.JADWAL else 0.0\n"
            "result = -tools.rp(contract.wage * days / scheduled) if scheduled else 0.0\n"
            "result_name = 'Potongan absen ' + ('%g' % days) + ' dari ' + ('%g' % scheduled) + ' hari kerja'\n"
        ),
        "inputs": [("ABSEN_KOREKSI", "Koreksi hari absen (boleh negatif)")],
        "debit": "expense_salary", "note": "Gaji pokok x hari absen tanpa keterangan / hari kerja terjadwal bulan itu menurut kalender kerja. Hari tanpa kehadiran dan tanpa cuti disetujui.",
    },
    {
        "key": "pot_cuti", "code": "POT_CUTI", "name": "Potongan Cuti Tidak Dibayar", "sequence": 71, "category": "DED",
        "condition": "result = bool(worked_days.CUTI_TDK_DIBAYAR and worked_days.CUTI_TDK_DIBAYAR.number_of_days)",
        "python": (
            "days = worked_days.CUTI_TDK_DIBAYAR.number_of_days\n"
            "scheduled = worked_days.JADWAL.number_of_days if worked_days.JADWAL else 0.0\n"
            "result = -tools.rp(contract.wage * days / scheduled) if scheduled else 0.0\n"
            "result_name = 'Potongan cuti tidak dibayar ' + ('%g' % days) + ' dari ' + ('%g' % scheduled) + ' hari kerja'\n"
        ),
        "debit": "expense_salary", "note": "Cuti disetujui dengan jenis bertanda Unpaid mengurangi gaji pokok dengan cara yang sama seperti absen.",
    },
    {
        "key": "pot_terlambat", "code": "POT_TERLAMBAT", "name": "Potongan Terlambat", "sequence": 72, "category": "DED",
        "condition": "result = bool(worked_days.TERLAMBAT and worked_days.TERLAMBAT.number_of_days and (tools.param('terlambat_per_kejadian') or tools.param('terlambat_per_menit')))",
        "python": (
            "result = -tools.rp(worked_days.TERLAMBAT.number_of_days * tools.param('terlambat_per_kejadian') + worked_days.TERLAMBAT.number_of_hours * 60.0 * tools.param('terlambat_per_menit'))\n"
            "result_name = 'Potongan terlambat ' + ('%g' % worked_days.TERLAMBAT.number_of_days) + ' kali'\n"
        ),
        "debit": "expense_salary", "note": "Nonaktif secara bawaan (parameter terlambat bernilai 0). Isi nominal per kejadian atau per menit di Parameter Payroll untuk mengaktifkan.",
    },
    {
        "key": "pot_lain", "code": "POT_LAIN", "name": "Potongan Lain", "sequence": 80, "category": "POT",
        "condition": "result = bool(inputs.POT_LAIN and inputs.POT_LAIN.amount)", "python": "result = -inputs.POT_LAIN.amount\n", "inputs": [("POT_LAIN", "Potongan Lain")],
        "debit": "payable_deduction", "note": "Potongan lain (mis. koperasi, kasbon) diisi positif di input slip; menjadi pengurang gaji. Tidak mengurangi dasar pajak.",
    },
]

RULE_THR = {
    "key": "thr", "code": "THR", "name": "Tunjangan Hari Raya", "sequence": 20, "category": "VAR", "in": ("thr",),
    "python": "calc = payslip.kompakapps_thr()\nresult = calc['amount']\nresult_name = calc['label']\n",
    "debit": "expense_benefit",
    "note": "Hanya di struktur THR Indonesia. Tanggal akhir slip = tanggal hari raya yang diisi petugas. Masa kerja 12 bulan atau lebih: satu bulan upah (gaji pokok + tunjangan tetap); 1 sampai kurang dari 12 bulan: proporsional.",
}

_IURAN = (
    "iuran = 0.0\n"
    "for code in ('BPJS_JHT_K', 'BPJS_JP_K'):\n"
    "    line = result_rules.dict.get(code)\n"
    "    if line:\n"
    "        iuran = iuran - line.total\n"
)
_BRUTO_PAJAK = "categories.BASIC + categories.ALW + categories.VAR + categories.DED + categories.BPJSPT"

RULES_PPH = [
    {
        "key": "tunj_pajak", "in": ("gaji", "thr"), "code": "TUNJ_PAJAK", "name": "Tunjangan PPh 21", "sequence": 185, "category": "VAR",
        "condition": "result = bool(employee.kompakapps_pph21_company)",
        "python": _IURAN + f"result = payslip.kompakapps_pph21_grossup({_BRUTO_PAJAK}, iuran)\nresult_name = 'Tunjangan PPh 21 (pajak ditanggung perusahaan)'\n",
        "debit": "expense_taxalw",
        "note": "Hanya untuk karyawan yang pajaknya ditanggung perusahaan: sebesar PPh 21 yang dihitung atas penghasilan termasuk tunjangan ini (iterasi sampai sama). Pajak dan tunjangan saling meniadakan pada gaji bersih.",
    },
    {
        "key": "pph_bruto", "in": ("gaji", "thr"), "code": "PPH_BRUTO", "name": "Penghasilan bruto kena pajak", "sequence": 190, "category": "INFO",
        "python": f"result = {_BRUTO_PAJAK}\n",
        "note": "Informasi: gaji pokok, tunjangan, penghasilan tidak tetap, potongan kehadiran, dan iuran Kesehatan, JKK, JKM perusahaan (PMK 168/2023 Pasal 5 ayat 3). Dasar TER dan penjumlahan setahun.",
    },
    {
        "key": "pph_iuran", "in": ("gaji", "thr"), "code": "PPH_IURAN", "name": "Iuran JHT dan JP karyawan (pengurang pajak)", "sequence": 191, "category": "INFO",
        "python": _IURAN + "result = iuran\n",
        "note": "Informasi: iuran JHT dan JP yang dibayar karyawan, pengurang penghasilan pada penghitungan masa pajak terakhir (PMK 168/2023 Pasal 10 ayat 1 huruf b).",
    },
    {
        "key": "pph21", "in": ("gaji", "thr"), "code": "PPH21", "name": "PPh 21", "sequence": 200, "category": "PAJAK",
        "python": "calc = payslip.kompakapps_pph21(PPH_BRUTO, PPH_IURAN)\nresult = -calc['amount']\nresult_name = calc['label']\n",
        "inputs": [
            ("PPH_AKHIR", "Masa pajak terakhir (isi 1 bila karyawan berhenti bulan ini)"),
            ("PPH_AWAL_BRUTO", "Saldo awal: penghasilan bruto sebelum slip pertama di sistem"),
            ("PPH_AWAL_IURAN", "Saldo awal: iuran JHT dan JP karyawan"),
            ("PPH_AWAL_PAJAK", "Saldo awal: PPh 21 yang sudah dipotong"),
            ("PPH_AWAL_BULAN", "Saldo awal: jumlah bulan bekerja"),
        ],
        "debit": "payable_pph21", "register": "pph21",
        "note": "Januari sampai November (dan bulan selain masa pajak terakhir): tarif efektif bulanan (TER) kategori A, B, C dari status PTKP. Desember atau bulan berhenti: pajak setahun tarif Pasal 17 dikurangi yang sudah dipotong (bisa negatif = dikembalikan). Tanpa NPWP dan NIK: 120%. Saldo awal diisi hanya bila sistem dipakai di tengah tahun.",
    },
]

RULE_NET = {
    "key": "net", "in": ("gaji", "thr"), "code": "NET", "name": "Gaji Bersih", "sequence": 900, "category": "NET",
    "python": "result = categories.BASIC + categories.ALW + categories.VAR + categories.DED + categories.POT + categories.BPJSK + categories.PAJAK",
    "credit": "payable_salary",
    "note": "Penghasilan + potongan (potongan, iuran karyawan, dan PPh 21 bernilai negatif). Iuran BPJS perusahaan tidak ikut.",
}

RULES = RULES_BASE + RULES_COMP + RULES_BPJS + RULES_PPH + [RULE_THR, RULE_NET]

STRUCTURES = [
    ("structure", "Gaji Indonesia", "GAJI-ID", "gaji", "Struktur gaji Indonesia: gaji pokok, tunjangan, lembur, potongan, iuran BPJS, dan PPh 21. Angka hukum ada di Payroll > Setting dan perlu diperiksa akuntan."),
    ("structure_thr", "THR Indonesia", "THR-ID", "thr", "Slip khusus THR: buat slip dengan struktur ini, periode berakhir pada tanggal hari raya. PPh 21 digabung dengan penghasilan bulan itu (konfirmasi slip bulanan lebih dulu)."),
]
PARAMS = PARAMS_BPJS + PARAMS_PPH + PARAMS_COMP
