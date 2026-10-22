import re

from odoo import Command, _, api, fields, models
from odoo.exceptions import AccessError, UserError
from odoo.tools import float_round

from . import payroll_id_data as data

PTKP_STATUSES = [
    ("TK/0", "TK/0 - Tidak kawin, tanpa tanggungan"),
    ("TK/1", "TK/1 - Tidak kawin, 1 tanggungan"),
    ("TK/2", "TK/2 - Tidak kawin, 2 tanggungan"),
    ("TK/3", "TK/3 - Tidak kawin, 3 tanggungan"),
    ("K/0", "K/0 - Kawin, tanpa tanggungan"),
    ("K/1", "K/1 - Kawin, 1 tanggungan"),
    ("K/2", "K/2 - Kawin, 2 tanggungan"),
    ("K/3", "K/3 - Kawin, 3 tanggungan"),
]
# Kategori TER menurut PP 58/2023 Pasal 2 ayat (4): A = TK/0, TK/1, K/0; B = TK/2, TK/3, K/1, K/2; C = K/3.
TER_CATEGORY = {"TK/0": "A", "TK/1": "A", "K/0": "A", "TK/2": "B", "TK/3": "B", "K/1": "B", "K/2": "B", "K/3": "C"}


class HrEmployeePayroll(models.Model):
    """Data pajak dan BPJS karyawan (D86, Q59). Hanya terlihat dan dapat diubah petugas HR."""

    _inherit = "hr.employee"

    kompakapps_ptkp_status = fields.Selection(PTKP_STATUSES, string="Status PTKP", default="TK/0", groups="hr.group_hr_user", help="Status Penghasilan Tidak Kena Pajak pada awal tahun pajak; menentukan PTKP dan kategori tarif TER.")
    kompakapps_ptkp_dependents = fields.Integer(string="Jumlah Tanggungan", compute="_compute_kompakapps_ptkp", groups="hr.group_hr_user")
    kompakapps_ter_category = fields.Char(string="Kategori TER", compute="_compute_kompakapps_ptkp", groups="hr.group_hr_user")
    kompakapps_npwp = fields.Char(string="NPWP", groups="hr.group_hr_user", copy=False)
    kompakapps_nik = fields.Char(string="NIK (KTP)", groups="hr.group_hr_user", copy=False, help="NIK yang terdaftar di DJP berfungsi sebagai NPWP.")
    kompakapps_bpjs_kes = fields.Boolean(string="Ikut BPJS Kesehatan", default=True, groups="hr.group_hr_user")
    kompakapps_bpjs_kes_no = fields.Char(string="No. Kartu BPJS Kesehatan", groups="hr.group_hr_user", copy=False)
    kompakapps_bpjs_jht = fields.Boolean(string="Ikut BPJS JHT", default=True, groups="hr.group_hr_user")
    kompakapps_bpjs_jp = fields.Boolean(string="Ikut BPJS JP", default=True, groups="hr.group_hr_user")
    kompakapps_bpjs_jkk = fields.Boolean(string="Ikut BPJS JKK", default=True, groups="hr.group_hr_user")
    kompakapps_bpjs_jkm = fields.Boolean(string="Ikut BPJS JKM", default=True, groups="hr.group_hr_user")
    kompakapps_pph21_company = fields.Boolean(string="PPh 21 Ditanggung Perusahaan", groups="hr.group_hr_user", help="Pajak ditanggung perusahaan lewat tunjangan PPh 21 (gross-up): tunjangan dan pajak sama besar sehingga gaji bersih tidak berkurang.")
    kompakapps_bpjs_tk_no = fields.Char(string="No. Kartu BPJS Ketenagakerjaan", groups="hr.group_hr_user", copy=False)

    @api.depends("kompakapps_ptkp_status")
    def _compute_kompakapps_ptkp(self):
        for employee in self:
            status = employee.kompakapps_ptkp_status
            employee.kompakapps_ptkp_dependents = int(status[-1]) if status else 0
            employee.kompakapps_ter_category = TER_CATEGORY.get(status, False)


class HrSalaryRulePayroll(models.Model):
    _inherit = "hr.salary.rule"

    def _kompakapps_clean_error(self, error):
        """Pesan parameter kosong dari `tools.param` ikut terbungkus traceback panjang oleh OCA; tampilkan kalimatnya saja."""
        match = re.search(r"((?:Parameter payroll|Tabel tarif) .*?Pasang Aturan Indonesia\)\.)", str(error))
        return UserError(match.group(1)) if match else error

    def _compute_rule_code(self, localdict):
        try:
            return super()._compute_rule_code(localdict)
        except UserError as error:
            raise self._kompakapps_clean_error(error) from error

    def _satisfy_condition_python(self, localdict):
        try:
            return super()._satisfy_condition_python(localdict)
        except UserError as error:
            raise self._kompakapps_clean_error(error) from error


class HrPayslipPayroll(models.Model):
    _inherit = "hr.payslip"

    def _get_tools_dict(self):
        """Alat untuk ekspresi aturan gaji: `tools.param('kode')` (parameter bertanggal berlaku pada akhir periode slip) dan `tools.rp(x)` (bulatkan ke rupiah)."""
        tools = super()._get_tools_dict()
        parameters = self.env["kompakapps.payroll.parameter"]
        date, company = self.date_to, self.company_id
        tools["param"] = lambda code: parameters.kompakapps_value(code, date, company)
        tools["rp"] = lambda amount: float_round(amount, precision_digits=0)
        return tools


class ResCompanyPayroll(models.Model):
    _inherit = "res.company"

    def _kompakapps_payroll_check_manager(self):
        if not self.env.su and not self.env.user.has_group("payroll.group_payroll_manager"):
            raise AccessError(_("Hanya Manager payroll yang boleh memasang aturan payroll."))

    def kompakapps_setup_payroll_accounts(self):
        """Siapkan akun gaji dan jurnal "Gaji" untuk perusahaan (D86, Q59). Akun l10n_id yang cocok dipakai apa adanya (beban gaji, bonus, lembur, tunjangan
        PPh 21, hutang PPh 21, hutang BPJS); yang belum ada dibuat (beban BPJS perusahaan, hutang gaji). Akun dicari menurut kode dan jenisnya harus cocok,
        bila tidak, ditolak dengan pesan jelas (tidak menimpa akun milik penggunaan lain). Aman diulang. Mengembalikan {kunci: account.account}."""
        self.ensure_one()
        self._kompakapps_payroll_check_manager()
        company = self.sudo()
        Account = self.env["account.account"].sudo().with_company(company)
        accounts = {}
        for key, code, name, account_type in data.ACCOUNTS:
            found = Account.search([("code", "=", code), ("company_ids", "in", company.id)], limit=1)
            if found:
                if found.account_type.split("_")[0] != account_type.split("_")[0]:
                    raise UserError(_("Akun %(code)s sudah dipakai untuk jenis lain (%(name)s). Ubah akun itu atau pilih akun gaji secara manual di Salary Rules.", code=code, name=found.name))
                accounts[key] = found
            else:
                accounts[key] = Account.create({"code": code, "name": name, "account_type": account_type, "company_ids": [Command.link(company.id)]})
        journal, _made = company._kompakapps_payroll_record(
            "account.journal", "journal", {"name": "Gaji", "code": "GAJI", "type": "general", "company_id": company.id}, prefix="payroll_id"
        )
        accounts["journal"] = journal
        return accounts

    def kompakapps_setup_payroll_parameters(self):
        """Isi parameter dan tabel tarif bawaan (BPJS, PTKP, biaya jabatan, TER, Pasal 17) yang belum ada. Yang sudah ada tidak ditimpa, jadi nilai yang
        diperbarui petugas tetap. Mengembalikan jumlah baris parameter dan baris tabel yang dibuat."""
        self.ensure_one()
        self._kompakapps_payroll_check_manager()
        Parameter = self.env["kompakapps.payroll.parameter"]
        Bracket = self.env["kompakapps.payroll.bracket"]
        made_params = made_rows = 0
        for code, name, value, unit, date_from, source, note in data.PARAMS:
            if not Parameter.search_count([("company_id", "=", self.id), ("code", "=", code), ("date_from", "=", date_from)]):
                Parameter.create({"company_id": self.id, "code": code, "name": name, "value": value, "unit": unit, "date_from": date_from, "source": source, "note": note})
                made_params += 1
        for table, date_from, rows, source in data.BRACKETS:
            if Bracket.search_count([("company_id", "=", self.id), ("table", "=", table), ("date_from", "=", date_from)]):
                continue
            lower = 0.0
            for upper, rate in rows:
                Bracket.create({"company_id": self.id, "table": table, "date_from": date_from, "lower": lower, "upper": upper, "rate": rate, "source": source})
                lower = upper
                made_rows += 1
        return {"parameters": made_params, "rows": made_rows}

    def kompakapps_setup_payroll_indonesia(self):
        """Pasang struktur gaji "Gaji Indonesia" (D86, Q59): akun dan jurnal Gaji, parameter bertanggal, tabel tarif, kategori, register, aturan BPJS (lalu PPh 21,
        lembur, THR, absen pada irisan berikutnya), dan struktur dengan akun yang sudah dipetakan. Hanya untuk Manager payroll. Aman diulang: yang sudah ada tidak
        ditimpa (perubahan petugas tetap), yang dihapus dibuat lagi, dan aturan baru dari pembaruan ditambahkan ke struktur. Mengembalikan
        {"structure_id", "created", "parameters", "rows"}."""
        self.ensure_one()
        self._kompakapps_payroll_check_manager()
        accounts = self.kompakapps_setup_payroll_accounts()
        counts = self.kompakapps_setup_payroll_parameters()
        created = bool(counts["parameters"] or counts["rows"])
        categories = {}
        for code, name in data.CATEGORIES:
            categories[code], made = self._kompakapps_payroll_record(
                "hr.salary.rule.category", f"cat_{code.lower()}", {"name": name, "code": code, "company_id": self.id}, prefix="payroll_id"
            )
            created = created or made
        registers = {}
        for key, name in data.REGISTERS:
            registers[key], made = self._kompakapps_payroll_record("hr.contribution.register", f"reg_{key}", {"name": name, "company_id": self.id}, prefix="payroll_id")
            created = created or made
        groups = {"gaji": self.env["hr.salary.rule"], "thr": self.env["hr.salary.rule"]}
        fresh = {"gaji": self.env["hr.salary.rule"], "thr": self.env["hr.salary.rule"]}
        for spec in data.RULES:
            values = {
                "code": spec["code"],
                "name": spec["name"],
                "sequence": spec["sequence"],
                "category_id": categories[spec["category"]].id,
                "company_id": self.id,
                "note": spec.get("note", False),
                "amount_select": spec.get("amount_select", "code"),
            }
            if values["amount_select"] == "percentage":
                values.update({"amount_percentage": spec["amount_percentage"], "amount_percentage_base": spec["amount_percentage_base"]})
            else:
                values["amount_python_compute"] = spec["python"]
            if spec.get("condition"):
                values.update({"condition_select": "python", "condition_python": spec["condition"]})
            if spec.get("inputs"):
                values["input_ids"] = [Command.create({"code": code, "name": name}) for code, name in spec["inputs"]]
            if spec.get("debit"):
                values["kompakapps_account_debit_id"] = accounts[spec["debit"]].id
            if spec.get("credit"):
                values["kompakapps_account_credit_id"] = accounts[spec["credit"]].id
            if spec.get("register"):
                values["register_id"] = registers[spec["register"]].id
            rule, made = self._kompakapps_payroll_record("hr.salary.rule", f"rule_{spec['key']}", values, prefix="payroll_id")
            for group in spec.get("in", ("gaji",)):
                groups[group] |= rule
                if made:
                    fresh[group] |= rule
            created = created or made
        structure_ids = {}
        for key, name, code, group, note in data.STRUCTURES:
            structure, made = self._kompakapps_payroll_record(
                "hr.payroll.structure",
                key,
                {"name": name, "code": code, "company_id": self.id, "rule_ids": [Command.set(groups[group].ids)], "kompakapps_journal_id": accounts["journal"].id, "note": note},
                prefix="payroll_id",
            )
            created = created or made
            if not made and fresh[group]:  # struktur lama tetap; hanya aturan yang baru ditautkan
                structure.rule_ids = [Command.link(rule.id) for rule in fresh[group]]
            structure_ids[key] = structure.id
        return {"structure_id": structure_ids["structure"], "thr_structure_id": structure_ids["structure_thr"], "created": created, "parameters": counts["parameters"], "rows": counts["rows"]}
