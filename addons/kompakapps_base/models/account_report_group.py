"""Pos laporan pada master akun (Q20, D67): Laba Rugi, Neraca, Arus Kas, dan Ringkasan Eksekutif memetakan akun ke baris laporan lewat field ini.

Sebelumnya tiap baris laporan memuat daftar kode akun tetap, sehingga akun baru dengan kode di luar daftar tidak masuk laporan. Sekarang setiap akun
punya satu "Pos Laporan" (bisa diubah pengguna). Nilai awal dihitung dari kode akun (pemetaan lama, supaya angka laporan tidak berubah) lalu dari jenis
akun, jadi akun baru langsung muncul di baris yang masuk akal beserta uraian per akunnya. Akun yang dipilih "Tidak dilaporkan" membuat baris
pemeriksaan ("harus 0") menyala, karena saldonya jatuh di luar laporan.
"""

from odoo import _, api, fields, models
from odoo.exceptions import ValidationError

# (kunci, label, bagian). Bagian: "pl" = Laba Rugi, "bs" = Neraca. Urutan mengikuti urutan baris pada laporan.
REPORT_GROUPS = [
    ("penjualan", "Penjualan", "pl"),
    ("retur_diskon", "Retur dan Potongan Penjualan", "pl"),
    ("hpp_barang", "Harga Pokok Penjualan", "pl"),
    ("pembelian_bahan", "Pembelian Bahan Baku", "pl"),
    ("perubahan_persediaan", "Perubahan Persediaan", "pl"),
    ("beban_gaji", "Gaji dan Tunjangan", "pl"),
    ("beban_umum", "Beban Umum dan Kantor", "pl"),
    ("beban_jasa", "Jasa, Sewa, dan Pemeliharaan", "pl"),
    ("beban_kendaraan", "Kendaraan", "pl"),
    ("beban_penyusutan", "Penyusutan", "pl"),
    ("beban_lain_operasional", "Beban Operasional Lain", "pl"),
    ("pendapatan_lain", "Pendapatan Lain", "pl"),
    ("beban_lain", "Beban Lain", "pl"),
    ("beban_pajak", "Beban Pajak Penghasilan", "pl"),
    ("kas_bank", "Kas dan Bank", "bs"),
    ("pembayaran_tertunda", "Penerimaan dan Pembayaran Tertunda", "bs"),
    ("piutang_usaha", "Piutang Usaha", "bs"),
    ("persediaan", "Persediaan", "bs"),
    ("pajak_dimuka", "Pajak Dibayar di Muka", "bs"),
    ("biaya_dimuka", "Biaya Dibayar di Muka", "bs"),
    ("aset_lancar_lain", "Aset Lancar Lain", "bs"),
    ("aset_tetap_bruto", "Aset Tetap (Harga Perolehan)", "bs"),
    ("akumulasi_penyusutan", "Akumulasi Penyusutan", "bs"),
    ("aset_lain", "Aset Tidak Lancar Lain", "bs"),
    ("hutang_usaha", "Hutang Usaha", "bs"),
    ("hutang_pajak", "Hutang Pajak", "bs"),
    ("uang_muka_pelanggan", "Uang Muka Pelanggan dan Pendapatan Diterima di Muka", "bs"),
    ("biaya_akrual", "Biaya yang Masih Harus Dibayar", "bs"),
    ("hutang_bank", "Pinjaman Bank dan Leasing", "bs"),
    ("hutang_lain", "Hutang Lain-lain", "bs"),
    ("modal", "Modal Disetor dan Prive", "bs"),
    ("cadangan", "Cadangan Modal", "bs"),
    ("saldo_laba", "Saldo Laba Ditahan", "bs"),
]
NONE = "none"
SECTION_LABEL = {"pl": "Laba Rugi", "bs": "Neraca"}
GROUP_SECTION = {key: section for key, _label, section in REPORT_GROUPS}
SELECTION = [(key, f"{SECTION_LABEL[section]}: {label}") for key, label, section in REPORT_GROUPS] + [(NONE, "Tidak dilaporkan")]

# Jenis akun Odoo yang menentukan bagian laporan; off_balance tidak masuk laporan mana pun.
PNL_TYPES = ("income", "income_other", "expense", "expense_direct_cost", "expense_depreciation", "expense_other")
BS_TYPES = (
    "asset_receivable", "asset_cash", "asset_current", "asset_non_current", "asset_prepayments", "asset_fixed",
    "liability_payable", "liability_credit_card", "liability_current", "liability_non_current", "equity", "equity_unaffected",
)

# Pemetaan lama (kode atau awalan kode l10n_id), dari rumus template sebelum D67. Yang lebih spesifik harus di atas yang lebih umum.
CODE_RULES = [
    ("42000060", "retur_diskon"), ("42000070", "retur_diskon"), ("41", "penjualan"),
    ("51000010", "hpp_barang"), ("51000020", "pembelian_bahan"), ("42500010", "perubahan_persediaan"),
    ("65110070", "beban_pajak"), ("611", "beban_gaji"), ("631", "beban_umum"), ("641", "beban_umum"), ("651", "beban_jasa"),
    ("661", "beban_kendaraan"), ("69000000", "beban_lain_operasional"), ("99900002", "pendapatan_lain"),
    ("911", "beban_lain"), ("99900001", "beban_lain"), ("99900003", "beban_lain"),
    ("11120002", "pembayaran_tertunda"), ("11120003", "pembayaran_tertunda"), ("11120004", "pembayaran_tertunda"), ("19999991", "pembayaran_tertunda"),
    ("11210010", "piutang_usaha"), ("11210011", "piutang_usaha"), ("113", "persediaan"),
    ("11210030", "pajak_dimuka"), ("11210012", "pajak_dimuka"), ("11210013", "pajak_dimuka"), ("11210014", "pajak_dimuka"), ("115", "pajak_dimuka"),
    ("114", "biaya_dimuka"), ("11210040", "biaya_dimuka"), ("1221", "aset_tetap_bruto"), ("1228", "akumulasi_penyusutan"),
    ("21100010", "hutang_usaha"), ("2122", "hutang_pajak"), ("2121", "hutang_pajak"), ("21100011", "hutang_pajak"), ("21100012", "hutang_pajak"),
    ("21100014", "hutang_pajak"), ("28", "uang_muka_pelanggan"), ("25", "biaya_akrual"), ("221", "hutang_bank"),
    ("21100013", "hutang_lain"), ("21100020", "hutang_lain"), ("21100030", "hutang_lain"), ("21100040", "hutang_lain"), ("29000000", "hutang_lain"),
    ("311", "modal"), ("312", "cadangan"), ("31510010", "saldo_laba"), ("31510020", "saldo_laba"), ("39000000", "saldo_laba"),
]
# Jenis akun yang menentukan pos tanpa melihat kode (sama seperti rumus lama yang memakai account_type).
TYPE_FIRST = {
    "expense_depreciation": "beban_penyusutan", "asset_cash": "kas_bank", "income_other": "pendapatan_lain",
    "asset_non_current": "aset_lain", "equity_unaffected": "saldo_laba",
}
# Cadangan bila kode tidak dikenal: pos yang paling masuk akal menurut jenis akun.
TYPE_DEFAULT = {
    "asset_receivable": "piutang_usaha", "asset_current": "aset_lancar_lain", "asset_prepayments": "biaya_dimuka", "asset_fixed": "aset_tetap_bruto",
    "liability_payable": "hutang_usaha", "liability_credit_card": "hutang_lain", "liability_current": "hutang_lain", "liability_non_current": "hutang_bank",
    "equity": "modal", "income": "penjualan", "expense": "beban_lain_operasional", "expense_other": "beban_lain", "expense_direct_cost": "hpp_barang",
    "off_balance": NONE,
}


def type_section(account_type):
    """Bagian laporan untuk jenis akun: "pl", "bs", atau None (di luar neraca)."""
    return "pl" if account_type in PNL_TYPES else "bs" if account_type in BS_TYPES else None


def default_group(code, account_type):
    """Pos laporan awal sebuah akun: jenis akun penentu, lalu pemetaan kode lama, lalu cadangan menurut jenis akun."""
    section = type_section(account_type)
    if section is None:
        return NONE
    if account_type in TYPE_FIRST:
        return TYPE_FIRST[account_type]
    code = code or ""
    for prefix, group in CODE_RULES:
        if code.startswith(prefix) and GROUP_SECTION[group] == section:
            return group
    return TYPE_DEFAULT.get(account_type, NONE)


class AccountAccount(models.Model):
    _inherit = "account.account"

    kompakapps_report_group = fields.Selection(
        SELECTION,
        string="Pos Laporan",
        compute="_compute_kompakapps_report_group",
        store=True,
        readonly=False,
        index=True,
        help="Baris tempat akun ini muncul di Laba Rugi, Neraca, Arus Kas, dan Ringkasan Eksekutif. Terisi otomatis dari kode dan jenis akun; "
        "ubah bila perlu. Mengubah kode atau jenis akun mengisi ulang pos ini.",
    )

    @api.depends("code", "account_type")
    def _compute_kompakapps_report_group(self):
        for account in self:
            code = ""
            for company in account.company_ids[:1]:
                code = account.with_company(company).code or ""
            account.kompakapps_report_group = default_group(code or account.code, account.account_type)

    @api.model_create_multi
    def create(self, vals_list):
        # nilai kosong (mis. kolom kosong pada impor) berarti "otomatis": biarkan perhitungan dari kode dan jenis akun mengisinya
        for vals in vals_list:
            if "kompakapps_report_group" in vals and not vals["kompakapps_report_group"]:
                del vals["kompakapps_report_group"]
        return super().create(vals_list)

    def write(self, vals):
        reset = "kompakapps_report_group" in vals and not vals["kompakapps_report_group"]
        if reset:
            vals = {key: value for key, value in vals.items() if key != "kompakapps_report_group"}
        result = super().write(vals)
        if reset:
            self.env.add_to_compute(self._fields["kompakapps_report_group"], self)
        return result

    @api.constrains("kompakapps_report_group", "account_type")
    def _check_kompakapps_report_group(self):
        for account in self:
            group = account.kompakapps_report_group
            if not group or group == NONE:
                continue
            if GROUP_SECTION.get(group) != type_section(account.account_type):
                raise ValidationError(
                    _(
                        "Pos laporan %(group)s tidak cocok untuk akun %(account)s (jenis %(type)s). Akun Laba Rugi hanya boleh memakai pos Laba Rugi, "
                        "akun Neraca hanya pos Neraca, atau pilih Tidak dilaporkan.",
                        group=dict(SELECTION).get(group, group),
                        account=account.display_name,
                        type=dict(account._fields["account_type"].selection).get(account.account_type, account.account_type),
                    )
                )
