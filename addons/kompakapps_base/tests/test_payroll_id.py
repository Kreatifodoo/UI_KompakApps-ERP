import datetime

from odoo import SUPERUSER_ID
from odoo.addons.account.tests.common import AccountTestInvoicingCommon
from odoo.exceptions import AccessError, UserError
from odoo.tests import tagged

from odoo.addons.kompakapps_base.models import payroll_id_data as data

OCT_FROM, OCT_TO = datetime.date(2026, 10, 1), datetime.date(2026, 10, 31)


@tagged("post_install", "-at_install", "kompakapps")
class TestPayrollIndonesiaBase(AccountTestInvoicingCommon):
    """Payroll Indonesia (D86, Q59): data parameter, tabel tarif, dan iuran BPJS. Angka acuan diambil dari contoh resmi PP 58/2023 dan PMK 168/2023
    atau dari hitungan tangan di komentar, bukan dari keluaran kode itu sendiri."""

    @classmethod
    @AccountTestInvoicingCommon.setup_country("id")
    def setUpClass(cls):
        super().setUpClass()
        cls.company = cls.company_data["company"]
        cls.env = cls.env(user=SUPERUSER_ID, context={"allowed_company_ids": cls.company.ids})
        cls.company = cls.company.with_env(cls.env)
        cls.result = cls.company.kompakapps_setup_payroll_indonesia()
        cls.structure = cls.env["hr.payroll.structure"].browse(cls.result["structure_id"])
        cls.rules = {rule.code: rule for rule in cls.structure.rule_ids}
        cls.Param = cls.env["kompakapps.payroll.parameter"]
        cls.Bracket = cls.env["kompakapps.payroll.bracket"]

    def _employee(self, name, wage, **extra):
        employee = self.env["hr.employee"].create(
            {"name": name, "company_id": self.company.id, "contract_date_start": datetime.date(2026, 1, 1), "wage": wage, **extra}
        )
        employee.current_version_id.write({"struct_id": self.structure.id})
        return employee

    def _slip(self, employee, inputs=None, date_from=OCT_FROM, date_to=OCT_TO):
        Payslip = self.env["hr.payslip"]
        slip = Payslip.browse(Payslip.kompakapps_create_payslip(employee.id, date_from, date_to))
        for code, amount in (inputs or {}).items():
            slip.input_line_ids.filtered(lambda line: line.code == code).amount = amount
        slip.compute_sheet()
        return slip

    @staticmethod
    def _lines(slip):
        return {line.code: line.total for line in slip.line_ids}

    # ---------- pemasangan ----------
    def test_setup_installs_everything_and_is_idempotent(self):
        self.assertTrue(self.result["created"])
        self.assertEqual(len(self.rules), len(data.RULES))
        self.assertEqual(self.Param.search_count([("company_id", "=", self.company.id)]), len(data.PARAMS))
        rows = {table: self.Bracket.search_count([("company_id", "=", self.company.id), ("table", "=", table)]) for table in ("ter_a", "ter_b", "ter_c", "pasal17")}
        self.assertEqual(rows, {"ter_a": 44, "ter_b": 40, "ter_c": 41, "pasal17": 5})
        again = self.company.kompakapps_setup_payroll_indonesia()
        self.assertFalse(again["created"])
        self.assertEqual(again["structure_id"], self.structure.id)
        self.assertEqual(again["parameters"] + again["rows"], 0)
        self.assertEqual(self.env["hr.payroll.structure"].search_count([("code", "=", "GAJI-ID"), ("company_id", "=", self.company.id)]), 1)
        self.assertEqual(self.structure.kompakapps_journal_id.code, "GAJI")

    def test_accounts_reuse_coa_and_create_missing(self):
        accounts = self.company.kompakapps_setup_payroll_accounts()
        self.assertEqual(accounts["expense_salary"].code, "61100010")
        self.assertEqual(accounts["payable_pph21"].code, "21210010")
        self.assertEqual(accounts["payable_salary"].account_type, "liability_payable")
        self.assertEqual(accounts["expense_bpjs"].code, "61100040")
        self.assertEqual(self.rules["GAPOK"].kompakapps_account_debit_id, accounts["expense_salary"])
        self.assertEqual(self.rules["NET"].kompakapps_account_credit_id, accounts["payable_salary"])
        self.assertEqual(self.rules["BPJS_KES_P"].kompakapps_account_debit_id, accounts["expense_bpjs"])
        self.assertEqual(self.rules["BPJS_KES_P"].kompakapps_account_credit_id, accounts["payable_bpjs_kes"])

    def test_setup_keeps_manager_changes_and_restores_deleted_rule(self):
        param = self.Param.search([("company_id", "=", self.company.id), ("code", "=", "bpjs_jkk_perusahaan")])
        param.value = 0.54
        self.rules["BPJS_JKM_P"].unlink()
        again = self.company.kompakapps_setup_payroll_indonesia()
        self.assertEqual(param.value, 0.54)
        self.assertTrue(again["created"])
        self.assertIn("BPJS_JKM_P", self.structure.rule_ids.mapped("code"))
        self.assertEqual(len(self.structure.rule_ids), len(data.RULES))

    def test_setup_requires_payroll_manager(self):
        user = self.env["res.users"].create(
            {"name": "Officer Uji", "login": "officer.id.uji", "group_ids": [(6, 0, [self.env.ref("base.group_user").id, self.env.ref("payroll.group_payroll_user").id])]}
        )
        with self.assertRaises(AccessError):
            self.company.with_user(user).kompakapps_setup_payroll_indonesia()

    # ---------- status PTKP dan kategori TER ----------
    def test_ter_category_follows_pp58_article_2(self):
        expected = {"TK/0": "A", "TK/1": "A", "K/0": "A", "TK/2": "B", "TK/3": "B", "K/1": "B", "K/2": "B", "K/3": "C"}
        for status, category in expected.items():
            employee = self._employee(f"Emp {status}", 5_000_000, kompakapps_ptkp_status=status)
            self.assertEqual(employee.kompakapps_ter_category, category, status)
            self.assertEqual(employee.kompakapps_ptkp_dependents, int(status[-1]))

    # ---------- tabel tarif (contoh resmi) ----------
    def test_ter_rates_match_official_examples(self):
        rate = lambda table, amount: self.Bracket.kompakapps_ter_rate(table, amount, OCT_TO, self.company)  # noqa: E731
        self.assertEqual(rate("ter_a", 5_400_000), 0.0)  # batas atas lapisan pertama masuk lapisan itu
        self.assertEqual(rate("ter_a", 5_400_001), 0.25)
        self.assertEqual(rate("ter_a", 10_000_000), 2.0)  # PP 58/2023 Penjelasan Pasal 2: K/0, Rp10.000.000 -> 2%
        self.assertEqual(rate("ter_a", 30_080_000), 13.0)  # PMK 168/2023 contoh Tuan A (Januari)
        self.assertEqual(rate("ter_a", 35_080_000), 14.0)
        self.assertEqual(rate("ter_a", 50_080_000), 18.0)
        self.assertEqual(rate("ter_a", 15_500_000), 7.0)  # PMK 168/2023 contoh Tuan B
        self.assertEqual(rate("ter_a", 2_000_000_000), 34.0)  # lapisan tanpa batas atas
        self.assertEqual(rate("ter_b", 6_300_000), 0.25)  # PMK 168/2023 contoh kategori B (0,25%)
        self.assertEqual(rate("ter_b", 6_200_000), 0.0)
        self.assertEqual(rate("ter_c", 6_600_000), 0.0)
        self.assertEqual(rate("ter_c", 6_600_001), 0.25)

    def test_progressive_tax_matches_pmk_168_example(self):
        # PMK 168/2023 contoh Tuan A: PKP Rp382.860.000 -> 5% x 60jt + 15% x 190jt + 25% x 132,86jt = Rp64.715.000
        self.assertAlmostEqual(self.Bracket.kompakapps_progressive_tax("pasal17", 382_860_000, OCT_TO, self.company), 64_715_000.0, places=2)
        # PP 58/2023 contoh Tuan R: PKP Rp54.300.000 -> 5% = Rp2.715.000
        self.assertAlmostEqual(self.Bracket.kompakapps_progressive_tax("pasal17", 54_300_000, OCT_TO, self.company), 2_715_000.0, places=2)
        self.assertAlmostEqual(self.Bracket.kompakapps_progressive_tax("pasal17", 0, OCT_TO, self.company), 0.0, places=2)
        # 6 miliar: 3jt + 28,5jt + 62,5jt + 30% x 4,5M + 35% x 1M = 1.350jt+... dihitung tangan
        expected = 60_000_000 * 0.05 + 190_000_000 * 0.15 + 250_000_000 * 0.25 + 4_500_000_000 * 0.30 + 1_000_000_000 * 0.35
        self.assertAlmostEqual(self.Bracket.kompakapps_progressive_tax("pasal17", 6_000_000_000, OCT_TO, self.company), expected, places=2)

    def test_parameter_and_table_versions_follow_effective_date(self):
        self.Param.create({"company_id": self.company.id, "code": "bpjs_jkk_perusahaan", "name": "JKK baru", "value": 0.89, "unit": "persen", "date_from": datetime.date(2027, 1, 1)})
        self.assertEqual(self.Param.kompakapps_value("bpjs_jkk_perusahaan", datetime.date(2026, 12, 31), self.company), 0.24)
        self.assertEqual(self.Param.kompakapps_value("bpjs_jkk_perusahaan", datetime.date(2027, 1, 31), self.company), 0.89)
        with self.assertRaisesRegex(UserError, "belum diisi"):
            self.Param.kompakapps_value("bpjs_jkk_perusahaan", datetime.date(2020, 1, 1), self.company)
        with self.assertRaisesRegex(UserError, "belum diisi"):
            self.Param.kompakapps_value("kode_tidak_ada", OCT_TO, self.company)
        copied = self.Bracket.kompakapps_clone_version("pasal17", datetime.date(2024, 1, 1), datetime.date(2027, 1, 1), self.company)
        self.assertEqual(copied, 5)
        with self.assertRaises(UserError):
            self.Bracket.kompakapps_clone_version("pasal17", datetime.date(2024, 1, 1), datetime.date(2027, 1, 1), self.company)

    # ---------- iuran BPJS ----------
    def test_bpjs_below_caps(self):
        # upah = 8.000.000 + 1.000.000 = 9.000.000. Hitung tangan:
        # Kes 1% = 90.000 (perusahaan 4% = 360.000); JHT 2% = 180.000 (3,7% = 333.000); JP 1% = 90.000 (2% = 180.000); JKK 0,24% = 21.600; JKM 0,3% = 27.000
        employee = self._employee("Rina BPJS", 8_000_000)
        lines = self._lines(self._slip(employee, {"TUNJ": 1_000_000}))
        self.assertEqual(lines["GAPOK"], 8_000_000)
        self.assertEqual(lines["BPJS_KES_K"], -90_000)
        self.assertEqual(lines["BPJS_JHT_K"], -180_000)
        self.assertEqual(lines["BPJS_JP_K"], -90_000)
        self.assertEqual(lines["BPJS_KES_P"], 360_000)
        self.assertEqual(lines["BPJS_JHT_P"], 333_000)
        self.assertEqual(lines["BPJS_JP_P"], 180_000)
        self.assertEqual(lines["BPJS_JKK_P"], 21_600)
        self.assertEqual(lines["BPJS_JKM_P"], 27_000)

    def test_bpjs_above_caps(self):
        # upah 20.000.000: Kes dibatasi 12.000.000 (1% = 120.000, 4% = 480.000); JP dibatasi 11.086.300 (1% = 110.863, 2% = 221.726); JHT tanpa batas (2% = 400.000, 3,7% = 740.000)
        employee = self._employee("Budi Gaji Besar", 20_000_000)
        lines = self._lines(self._slip(employee))
        self.assertEqual(lines["BPJS_KES_K"], -120_000)
        self.assertEqual(lines["BPJS_KES_P"], 480_000)
        self.assertEqual(lines["BPJS_JP_K"], -110_863)
        self.assertEqual(lines["BPJS_JP_P"], 221_726)
        self.assertEqual(lines["BPJS_JHT_K"], -400_000)
        self.assertEqual(lines["BPJS_JHT_P"], 740_000)
        self.assertEqual(lines["BPJS_JKK_P"], 48_000)
        self.assertEqual(lines["BPJS_JKM_P"], 60_000)

    def test_bpjs_rounds_to_whole_rupiah(self):
        # upah 9.876.543: JHT karyawan 2% = 197.530,86 -> 197.531; JHT perusahaan 3,7% = 365.432,091 -> 365.432
        employee = self._employee("Cici Pembulatan", 9_876_543)
        lines = self._lines(self._slip(employee))
        self.assertEqual(lines["BPJS_JHT_K"], -197_531)
        self.assertEqual(lines["BPJS_JHT_P"], 365_432)

    def test_programs_can_be_opted_out_per_employee(self):
        employee = self._employee("Dodi Tanpa JP", 8_000_000, kompakapps_bpjs_jp=False, kompakapps_bpjs_kes=False)
        lines = self._lines(self._slip(employee))
        for code in ("BPJS_JP_K", "BPJS_JP_P", "BPJS_KES_K", "BPJS_KES_P"):
            self.assertNotIn(code, lines)
        self.assertEqual(lines["BPJS_JHT_K"], -160_000)

    def test_lower_limit_is_optional_and_used_when_filled(self):
        self.Param.search([("company_id", "=", self.company.id), ("code", "=", "bpjs_kes_batas_bawah")]).value = 3_000_000
        employee = self._employee("Eka Di Bawah UMK", 2_000_000)
        lines = self._lines(self._slip(employee))
        self.assertEqual(lines["BPJS_KES_K"], -30_000)  # dasar dinaikkan ke batas bawah Rp3.000.000, 1%
        self.assertEqual(lines["BPJS_JHT_K"], -40_000)  # JHT tetap dari upah 2.000.000

    def test_missing_parameter_before_effective_date_gives_clear_error(self):
        employee = self._employee("Fani Jan", 8_000_000)
        with self.assertRaisesRegex(UserError, 'Parameter payroll "bpjs_jp_batas_upah" belum diisi'):
            self._slip(employee, date_from=datetime.date(2026, 1, 1), date_to=datetime.date(2026, 1, 31))

    def test_net_excludes_employer_share_and_journal_balances(self):
        employee = self._employee("Gita Jurnal", 10_000_000)
        slip = self._slip(employee)
        lines = self._lines(slip)
        employee_share = lines["BPJS_KES_K"] + lines["BPJS_JHT_K"] + lines["BPJS_JP_K"]
        self.assertEqual(lines["NET"], lines["GAPOK"] + employee_share)
        slip.action_payslip_done()
        move = slip.kompakapps_move_id
        self.assertTrue(move, slip.kompakapps_move_note)
        self.assertEqual(move.state, "posted")
        self.assertAlmostEqual(sum(move.line_ids.mapped("debit")), sum(move.line_ids.mapped("credit")), places=2)
        by_account = {}
        for line in move.line_ids:
            by_account[line.account_id.code] = by_account.get(line.account_id.code, 0.0) + line.credit - line.debit
        employer_total = sum(lines[c] for c in ("BPJS_KES_P", "BPJS_JHT_P", "BPJS_JP_P", "BPJS_JKK_P", "BPJS_JKM_P"))
        self.assertAlmostEqual(by_account["61100040"], -employer_total, places=2)  # beban BPJS perusahaan didebit
        self.assertAlmostEqual(by_account["21100050"], lines["NET"], places=2)  # hutang gaji dikredit sebesar gaji bersih
        self.assertAlmostEqual(by_account["25110110"], -lines["BPJS_KES_K"] + lines["BPJS_KES_P"], places=2)

    # ---------- hak akses ----------
    def test_parameters_are_editable_only_by_payroll_manager(self):
        group_user = self.env.ref("base.group_user").id
        officer = self.env["res.users"].create({"name": "Officer P", "login": "officer.p.uji", "group_ids": [(6, 0, [group_user, self.env.ref("payroll.group_payroll_user").id])]})
        manager = self.env["res.users"].create({"name": "Manager P", "login": "manager.p.uji", "group_ids": [(6, 0, [group_user, self.env.ref("payroll.group_payroll_manager").id])]})
        plain = self.env["res.users"].create({"name": "Biasa P", "login": "biasa.p.uji", "group_ids": [(6, 0, [group_user])]})
        param = self.Param.search([("company_id", "=", self.company.id), ("code", "=", "bpjs_kes_karyawan")])
        self.assertEqual(param.with_user(officer).value, 1.0)
        with self.assertRaises(AccessError):
            param.with_user(officer).value = 2.0
        param.with_user(manager).value = 1.0
        with self.assertRaises(AccessError):
            param.with_user(plain).read(["value"])
        row = self.Bracket.search([("company_id", "=", self.company.id), ("table", "=", "ter_a")], limit=1)
        with self.assertRaises(AccessError):
            row.with_user(officer).rate = 1.0
        with self.assertRaises(AccessError):
            row.with_user(plain).read(["rate"])
