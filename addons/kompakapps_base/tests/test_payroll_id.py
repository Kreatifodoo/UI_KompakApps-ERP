import datetime

from odoo import SUPERUSER_ID
from odoo.addons.account.tests.common import AccountTestInvoicingCommon
from odoo.exceptions import AccessError, UserError
from odoo.tests import tagged

from odoo.addons.kompakapps_base.models import payroll_id_data as data

OCT_FROM, OCT_TO = datetime.date(2026, 10, 1), datetime.date(2026, 10, 31)


class PayrollIdCommon(AccountTestInvoicingCommon):
    """Dasar bersama test Payroll Indonesia: perusahaan COA Indonesia dengan struktur Gaji Indonesia terpasang."""

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


@tagged("post_install", "-at_install", "kompakapps")
class TestPayrollIndonesiaBase(PayrollIdCommon):
    """Payroll Indonesia (D86, Q59): data parameter, tabel tarif, dan iuran BPJS. Angka acuan diambil dari contoh resmi PP 58/2023 dan PMK 168/2023
    atau dari hitungan tangan di komentar, bukan dari keluaran kode itu sendiri."""

    # ---------- pemasangan ----------
    def test_setup_installs_everything_and_is_idempotent(self):
        self.assertTrue(self.result["created"])
        self.assertEqual(len(self.rules), len([r for r in data.RULES if "gaji" in r.get("in", ("gaji",))]))
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
        self.assertEqual(len(self.structure.rule_ids), len([r for r in data.RULES if "gaji" in r.get("in", ("gaji",))]))

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
        self.assertEqual(lines["NET"], lines["GAPOK"] + employee_share + lines["PPH21"])
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


@tagged("post_install", "-at_install", "kompakapps")
class TestPayrollPph21(PayrollIdCommon):
    """PPh 21 (D86, Q59): TER Januari sampai November dan penghitungan setahun pada masa pajak terakhir. Angka acuan: contoh resmi PP 58/2023 (Penjelasan Pasal 2)
    dan PMK 168/2023 (Tuan B), serta hitungan tangan di komentar. Tanpa BPJS supaya penghasilan bruto sama dengan gaji."""

    def _plain(self, name, wage, start=datetime.date(2026, 1, 1), **extra):
        """Karyawan tanpa BPJS (bruto = gaji), dengan NPWP kecuali diubah."""
        values = {"kompakapps_bpjs_kes": False, "kompakapps_bpjs_jht": False, "kompakapps_bpjs_jp": False, "kompakapps_bpjs_jkk": False, "kompakapps_bpjs_jkm": False, "kompakapps_npwp": "09.254.294.3-407.000"}
        values.update(extra)
        employee = self.env["hr.employee"].create({"name": name, "company_id": self.company.id, "contract_date_start": start, "wage": wage, **values})
        employee.current_version_id.write({"struct_id": self.structure.id})
        return employee

    def _month(self, employee, year, month, inputs=None, confirm=True):
        last = (datetime.date(year + (month == 12), month % 12 + 1, 1) - datetime.timedelta(days=1)).day
        slip = self._slip(employee, inputs, datetime.date(year, month, 1), datetime.date(year, month, last))
        if confirm:
            slip.action_payslip_done()
        return self._lines(slip), slip

    def test_ter_category_selects_table(self):
        # Rp12.000.000: kategori A 4% = 480.000, B 3% = 360.000, C 2% = 240.000 (PP 58/2023 Lampiran A, B, C)
        expected = {"TK/0": 480_000, "K/0": 480_000, "TK/2": 360_000, "K/2": 360_000, "K/3": 240_000}
        for status, tax in expected.items():
            employee = self._plain(f"TER {status}", 12_000_000, kompakapps_ptkp_status=status)
            self.assertEqual(self._lines(self._slip(employee))["PPH21"], -tax, status)

    def test_pp58_example_tuan_r_full_year(self):
        # PP 58/2023 Penjelasan Pasal 2: K/0, gaji Rp10.000.000, iuran pensiun Rp100.000 per bulan (di sini JHT karyawan 1%).
        # Januari-November: TER A 2% = 200.000. Desember: bruto 120 juta - biaya jabatan 6 juta - iuran 1,2 juta = neto 112,8 juta;
        # PTKP K/0 58,5 juta; PKP 54,3 juta; pajak setahun 5% = 2.715.000; Desember = 2.715.000 - 11 x 200.000 = 515.000.
        self.Param.search([("company_id", "=", self.company.id), ("code", "=", "bpjs_jht_karyawan")]).value = 1.0
        employee = self._plain("Tuan R", 10_000_000, kompakapps_ptkp_status="K/0", kompakapps_bpjs_jht=True)
        for month in range(1, 12):
            lines, _slip = self._month(employee, 2026, month)
            self.assertEqual(lines["PPH21"], -200_000, month)
            self.assertEqual(lines["PPH_BRUTO"], 10_000_000)
            self.assertEqual(lines["PPH_IURAN"], 100_000)
        lines, slip = self._month(employee, 2026, 12)
        self.assertEqual(lines["PPH21"], -515_000)
        self.assertEqual(lines["NET"], 10_000_000 - 100_000 - 515_000)
        self.assertIn("masa pajak terakhir", slip.line_ids.filtered(lambda line: line.code == "PPH21").name)

    def test_pmk168_example_tuan_b_joins_in_september_and_gets_refund(self):
        # PMK 168/2023 contoh Tuan B (TK/0, mulai 1 September, gaji 15,5 juta): September-November TER A 7% = 1.085.000 (3 x = 3.255.000).
        # Desember (di sini dengan JHT 1% = 155.000 per bulan): bruto 62 juta; biaya jabatan min(5% = 3,1 juta, 4 x 500.000 = 2 juta) = 2 juta;
        # iuran 4 x 155.000 = 620.000; neto 59,38 juta; PTKP 54 juta; PKP 5,38 juta; pajak 5% = 269.000; Desember = 269.000 - 3.255.000 = -2.986.000 (dikembalikan).
        self.Param.search([("company_id", "=", self.company.id), ("code", "=", "bpjs_jht_karyawan")]).value = 1.0
        employee = self._plain("Tuan B", 15_500_000, start=datetime.date(2024, 9, 1), kompakapps_bpjs_jht=True)
        for month in (9, 10, 11):
            self.assertEqual(self._month(employee, 2024, month)[0]["PPH21"], -1_085_000, month)
        lines, _slip = self._month(employee, 2024, 12)
        self.assertEqual(lines["PPH21"], 2_986_000)  # positif = kelebihan potong dikembalikan, menambah gaji bersih
        self.assertEqual(lines["NET"], 15_500_000 - 155_000 + 2_986_000)

    def test_no_npwp_pays_twenty_percent_more(self):
        employee = self._plain("Tanpa NPWP", 10_000_000, kompakapps_npwp=False, kompakapps_nik=False)
        self.assertEqual(self._month(employee, 2026, 3)[0]["PPH21"], -240_000)  # 200.000 x 120%
        with_nik = self._plain("Dengan NIK", 10_000_000, kompakapps_npwp=False, kompakapps_nik="3174010101900001")
        self.assertEqual(self._month(with_nik, 2026, 3)[0]["PPH21"], -200_000)

    def test_employee_leaving_mid_year_uses_last_period_method(self):
        # TK/0, gaji 10 juta, berhenti Juni: Januari-Mei TER 2% = 5 x 200.000 = 1.000.000; Juni (masa pajak terakhir): bruto 60 juta, biaya jabatan
        # min(3 juta, 6 x 500.000) = 3 juta, neto 57 juta, PTKP 54 juta, PKP 3 juta, pajak 150.000; Juni = 150.000 - 1.000.000 = -850.000.
        employee = self._plain("Berhenti Juni", 10_000_000)
        for month in range(1, 6):
            self._month(employee, 2026, month)
        lines, _slip = self._month(employee, 2026, 6, inputs={"PPH_AKHIR": 1})
        self.assertEqual(lines["PPH21"], 850_000)

    def test_opening_balance_for_system_started_mid_year(self):
        # K/0, gaji 10 juta, hanya slip Desember di sistem; saldo awal Januari-November: bruto 110 juta, pajak 2,2 juta, 11 bulan.
        # Desember: bruto 120 juta, biaya jabatan 6 juta, neto 114 juta, PTKP 58,5 juta, PKP 55,5 juta, pajak 2.775.000; Desember = 2.775.000 - 2.200.000 = 575.000.
        employee = self._plain("Saldo Awal", 10_000_000, kompakapps_ptkp_status="K/0")
        lines, _slip = self._month(employee, 2026, 12, inputs={"PPH_AWAL_BRUTO": 110_000_000, "PPH_AWAL_PAJAK": 2_200_000, "PPH_AWAL_BULAN": 11})
        self.assertEqual(lines["PPH21"], -575_000)

    def test_company_borne_tax_grossup_is_fixed_point(self):
        # TK/0, gaji 10 juta, pajak ditanggung perusahaan: cari T sehingga TER(10 juta + T) x (10 juta + T) = T.
        # Iterasi dari 0: 200.000 -> 229.500 -> 230.164 -> 230.179 -> 230.179 (kategori A 2,25% untuk 10,05-10,35 juta). Gaji bersih tetap 10 juta.
        employee = self._plain("Gross Up", 10_000_000, kompakapps_pph21_company=True)
        lines, _slip = self._month(employee, 2026, 4)
        self.assertEqual(lines["TUNJ_PAJAK"], 230_179)
        self.assertEqual(lines["PPH21"], -230_179)
        self.assertEqual(lines["PPH_BRUTO"], 10_230_179)
        self.assertEqual(lines["NET"], 10_000_000)
        self.assertEqual(round(10_230_179 * 0.0225), 230_179)  # titik tetap: pajak atas bruto + tunjangan sama dengan tunjangan

    def test_bpjs_premiums_are_taxable_but_pension_contributions_are_not(self):
        # Rp10.000.000, semua BPJS ikut: bruto kena pajak = 10.000.000 + Kesehatan 4% (400.000) + JKK 0,24% (24.000) + JKM 0,3% (30.000) = 10.454.000
        # (JHT 3,7% dan JP 2% perusahaan tidak termasuk, PMK 168/2023 Pasal 5 ayat 3 dan Pasal 7 huruf c). TER A 10.454.000 = 2,5% -> 261.350.
        employee = self.env["hr.employee"].create({"name": "Semua BPJS", "company_id": self.company.id, "contract_date_start": datetime.date(2026, 1, 1), "wage": 10_000_000, "kompakapps_npwp": "09.254.294.3-407.000"})
        employee.current_version_id.write({"struct_id": self.structure.id})
        lines = self._month(employee, 2026, 5)[0]
        self.assertEqual(lines["PPH_BRUTO"], 10_454_000)
        self.assertEqual(lines["PPH21"], -261_350)

    def test_missing_rate_table_gives_clear_error(self):
        self.Bracket.search([("company_id", "=", self.company.id), ("table", "=", "ter_a")]).unlink()
        employee = self._plain("Tanpa Tabel", 10_000_000)
        with self.assertRaisesRegex(UserError, "Tabel tarif"):
            self._slip(employee)

    def test_pph21_journal_balances(self):
        employee = self._plain("Jurnal Pajak", 10_000_000)
        lines, slip = self._month(employee, 2026, 7)
        move = slip.kompakapps_move_id
        self.assertTrue(move, slip.kompakapps_move_note)
        self.assertAlmostEqual(sum(move.line_ids.mapped("debit")), sum(move.line_ids.mapped("credit")), places=2)
        by_account = {}
        for line in move.line_ids:
            by_account[line.account_id.code] = by_account.get(line.account_id.code, 0.0) + line.credit - line.debit
        self.assertAlmostEqual(by_account["21210010"], 200_000, places=2)  # hutang PPh 21 dikredit
        self.assertAlmostEqual(by_account["21100050"], 9_800_000, places=2)  # hutang gaji = bersih


@tagged("post_install", "-at_install", "kompakapps")
class TestPayrollComponents(PayrollIdCommon):
    """Komponen gaji (D86, Q59): tunjangan tetap dan harian, lembur dari Attendance (PP 35/2021 Pasal 31 dan 32), potongan absen, cuti tidak dibayar, terlambat,
    bonus, potongan lain, dan THR. Oktober 2026 punya 22 hari kerja (Senin sampai Jumat); angka dihitung tangan di komentar."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.calendar = cls.env["resource.calendar"].create(
            {
                "name": "Kantor Uji Jakarta",
                "company_id": cls.company.id,
                "tz": "Asia/Jakarta",
                "attendance_ids": [(5, 0, 0)]
                + [
                    (0, 0, {"name": f"{label} {day}", "dayofweek": str(day), "hour_from": start, "hour_to": end, "day_period": period})
                    for day in range(5)
                    for label, start, end, period in (("Pagi", 8.0, 12.0, "morning"), ("Sore", 13.0, 17.0, "afternoon"))
                ],
            }
        )

    def _worker(self, name, wage, start=datetime.date(2026, 1, 1), **extra):
        values = {"kompakapps_bpjs_kes": False, "kompakapps_bpjs_jht": False, "kompakapps_bpjs_jp": False, "kompakapps_bpjs_jkk": False, "kompakapps_bpjs_jkm": False, "kompakapps_npwp": "09.254.294.3-407.000"}
        contract = {key: extra.pop(key) for key in list(extra) if key.startswith("kompakapps_allow")}
        values.update(extra)
        employee = self.env["hr.employee"].create({"name": name, "company_id": self.company.id, "contract_date_start": start, "wage": wage, **values})
        employee.current_version_id.write({"struct_id": self.structure.id, "resource_calendar_id": self.calendar.id, **contract})
        return employee

    def _attend(self, employee, day, start=8.0, end=16.0, overtime=0.0):
        """Kehadiran WIB pada `day`; jam disimpan UTC (WIB = UTC+7)."""
        base = datetime.datetime.combine(day, datetime.time.min) - datetime.timedelta(hours=7)
        attendance = self.env["hr.attendance"].create({"employee_id": employee.id, "check_in": base + datetime.timedelta(hours=start), "check_out": base + datetime.timedelta(hours=end)})
        if overtime:
            attendance.write({"validated_overtime_hours": overtime})
        return attendance

    def _october_days(self, skip=()):
        days = [datetime.date(2026, 10, d) for d in range(1, 32) if datetime.date(2026, 10, d).weekday() < 5]
        return [day for day in days if day.day not in skip]

    def _oct(self, employee, inputs=None):
        slip = self._slip(employee, inputs)
        return self._lines(slip), slip

    def test_fixed_allowances_count_in_bpjs_base(self):
        # gaji 8.000.000 + transport 500.000 + makan 300.000 = upah 8.800.000; JHT karyawan 2% = 176.000; JHT perusahaan 3,7% = 325.600
        employee = self._worker("Tunjangan Tetap", 8_000_000, kompakapps_allow_transport=500_000, kompakapps_allow_meal=300_000, kompakapps_bpjs_jht=True)
        lines, _slip = self._oct(employee)
        self.assertEqual(lines["TUNJ_TRANSPORT"], 500_000)
        self.assertEqual(lines["TUNJ_MAKAN"], 300_000)
        self.assertEqual(lines["BPJS_JHT_K"], -176_000)
        self.assertEqual(lines["BPJS_JHT_P"], 325_600)

    def test_attendance_lines_daily_allowance_absence_and_overtime(self):
        # 22 hari kerja; hadir 20 (absen 14 dan 15 Oktober tanpa cuti). Tunjangan harian 50.000 x 20 = 1.000.000.
        # Potongan absen = 8.000.000 x 2 / 22 = 727.272,7 -> 727.273.
        # Lembur: Senin 5 Okt 3 jam (hari kerja: 1 x 1,5 + 2 x 2 = 5,5 jam setara) dan Sabtu 10 Okt 9 jam (hari libur, 5 hari kerja: 8 x 2 + 1 x 3 = 19 jam setara) = 24,5 jam setara.
        # Dasar = gaji pokok 8.000.000 (lebih besar dari 75% x 9.000.000 = 6.750.000); upah sejam = 8.000.000 / 173; lembur = 24,5 x 46.242,77 = 1.132.948.
        employee = self._worker("Hadir Lembur", 8_000_000, kompakapps_allow_daily=50_000)
        for day in self._october_days(skip=(14, 15)):
            self._attend(employee, day, overtime=3.0 if day.day == 5 else 0.0)
        self._attend(employee, datetime.date(2026, 10, 10), overtime=9.0)
        lines, slip = self._oct(employee)
        worked = {line.code: line for line in slip.worked_days_line_ids}
        self.assertEqual(worked["JADWAL"].number_of_days, 22)
        self.assertEqual(worked["HADIR"].number_of_days, 20)
        self.assertEqual(worked["ABSEN"].number_of_days, 2)
        self.assertAlmostEqual(worked["LEMBUR_JAM"].number_of_hours, 12.0)
        self.assertAlmostEqual(worked["LEMBUR_SETARA"].number_of_hours, 24.5)
        self.assertEqual(lines["TUNJ_HARIAN"], 1_000_000)
        self.assertEqual(lines["POT_ABSEN"], -727_273)
        self.assertEqual(lines["LEMBUR"], 1_132_948)
        self.assertEqual(lines["NET"], 8_000_000 + 1_000_000 - 727_273 + 1_132_948 + lines["PPH21"])

    def test_overtime_base_is_at_least_75_percent_of_total_wage(self):
        # gaji 3.000.000 dengan tunjangan harian 250.000 x 22 hari hadir = 5.500.000: tetap 3.000.000 < 75% x 8.500.000 = 6.375.000 -> dasar 6.375.000.
        # Lembur 1 jam hari kerja = 1,5 jam setara: 6.375.000 / 173 x 1,5 = 55.274,6 -> 55.275.
        employee = self._worker("Dasar 75", 3_000_000, kompakapps_allow_daily=250_000)
        for day in self._october_days():
            self._attend(employee, day, overtime=1.0 if day.day == 6 else 0.0)
        lines, _slip = self._oct(employee)
        self.assertEqual(lines["TUNJ_HARIAN"], 5_500_000)
        self.assertEqual(lines["LEMBUR"], 55_275)

    def test_no_attendance_data_means_no_absence_deduction(self):
        employee = self._worker("Tanpa Kehadiran", 8_000_000)
        lines, slip = self._oct(employee)
        self.assertNotIn("POT_ABSEN", lines)
        self.assertEqual(slip.worked_days_line_ids.filtered(lambda line: line.code == "ABSEN").number_of_days, 0)
        self.assertEqual(lines["NET"], 8_000_000 + lines["PPH21"])

    def test_unpaid_leave_reduces_wage_and_is_not_counted_absent(self):
        # cuti tidak dibayar 19-20 Okt (2 hari kerja): 8.000.000 x 2 / 22 = 727.272,7 -> 727.273; hadir 20 hari, absen 0.
        leave_type = self.env["hr.leave.type"].create({"name": "Cuti Tak Dibayar Uji", "requires_allocation": False, "leave_validation_type": "no_validation", "unpaid": True})
        employee = self._worker("Cuti Unpaid", 8_000_000)
        for day in self._october_days(skip=(19, 20)):
            self._attend(employee, day)
        self.env["hr.leave"].create({"employee_id": employee.id, "holiday_status_id": leave_type.id, "request_date_from": datetime.date(2026, 10, 19), "request_date_to": datetime.date(2026, 10, 20)})
        lines, slip = self._oct(employee)
        worked = {line.code: line.number_of_days for line in slip.worked_days_line_ids}
        self.assertEqual(worked["CUTI_TDK_DIBAYAR"], 2)
        self.assertEqual(worked["ABSEN"], 0)
        self.assertEqual(lines["POT_CUTI"], -727_273)
        self.assertNotIn("POT_ABSEN", lines)

    def test_late_penalty_is_off_by_default_and_works_when_filled(self):
        employee = self._worker("Telat", 8_000_000)
        for day in self._october_days():
            late = day.day in (1, 2, 5)
            self._attend(employee, day, start=8.5 if late else 8.0)  # 3 hari terlambat 30 menit
        lines, slip = self._oct(employee)
        self.assertNotIn("POT_TERLAMBAT", lines)  # bawaan nol: nonaktif
        for code, value in (("terlambat_per_kejadian", 10_000.0), ("terlambat_per_menit", 1_000.0), ("terlambat_toleransi_menit", 5.0)):
            self.Param.search([("company_id", "=", self.company.id), ("code", "=", code)]).value = value
        slip.compute_sheet()  # Hitung memuat ulang kehadiran dengan parameter terbaru
        # 3 kali x 10.000 + 3 x (30 - 5 menit toleransi) x 1.000 = 30.000 + 75.000 = 105.000
        self.assertEqual(self._lines(slip)["POT_TERLAMBAT"], -105_000)

    def test_bonus_other_deduction_and_tax_base(self):
        # gaji 10 juta + bonus 2 juta = bruto 12 juta, kategori A 4% = 480.000; potongan lain 150.000 mengurangi gaji bersih tetapi bukan dasar pajak.
        employee = self._worker("Bonus", 10_000_000)
        lines, slip = self._oct(employee, {"BONUS": 2_000_000, "POT_LAIN": 150_000})
        self.assertEqual(lines["BONUS"], 2_000_000)
        self.assertEqual(lines["POT_LAIN"], -150_000)
        self.assertEqual(lines["PPH_BRUTO"], 12_000_000)
        self.assertEqual(lines["PPH21"], -480_000)
        self.assertEqual(lines["NET"], 10_000_000 + 2_000_000 - 150_000 - 480_000)
        slip.action_payslip_done()
        move = slip.kompakapps_move_id
        self.assertTrue(move, slip.kompakapps_move_note)
        self.assertAlmostEqual(sum(move.line_ids.mapped("debit")), sum(move.line_ids.mapped("credit")), places=2)
        credits = {line.account_id.code: line.credit - line.debit for line in move.line_ids}
        self.assertAlmostEqual(credits["21100060"], 150_000, places=2)  # hutang potongan karyawan
        self.assertAlmostEqual(credits["61100020"], -2_000_000, places=2)  # bonus didebit ke beban bonus

    def test_thr_is_separate_slip_with_tax_combined_with_the_month(self):
        # THR Maret 2026 (hari raya 20 Maret), masuk 1 Maret 2025: masa kerja 12 bulan = satu bulan upah = 12.000.000 + transport 600.000 = 12.600.000.
        # Slip bulanan Maret (bruto 12,6 juta, TER A 5% = 630.000) dikonfirmasi lebih dulu. THR: bruto gabungan 25,2 juta (TER A 10%) = 2.520.000 dikurangi 630.000 = 1.890.000.
        employee = self._worker("Penerima THR", 12_000_000, start=datetime.date(2025, 3, 1), kompakapps_allow_transport=600_000)
        regular = self._slip(employee, None, datetime.date(2026, 3, 1), datetime.date(2026, 3, 31))
        self.assertEqual(self._lines(regular)["PPH21"], -630_000)
        regular.action_payslip_done()
        holiday = datetime.date(2026, 3, 20)
        Payslip = self.env["hr.payslip"]
        slip = Payslip.browse(Payslip.kompakapps_create_payslip(employee.id, holiday, holiday, struct_id=self.result["thr_structure_id"]))
        slip.compute_sheet()
        lines = self._lines(slip)
        self.assertEqual(lines["THR"], 12_600_000)
        self.assertEqual(lines["PPH21"], -1_890_000)
        self.assertEqual(lines["NET"], 12_600_000 - 1_890_000)
        slip.action_payslip_done()
        self.assertTrue(slip.kompakapps_move_id, slip.kompakapps_move_note)

    def test_thr_is_prorated_for_less_than_twelve_months(self):
        # masuk 1 Oktober 2025, hari raya 20 Maret 2026: 5 bulan penuh -> 5/12 x 12.000.000 = 5.000.000; masuk 10 Maret 2026 (kurang dari sebulan) = 0.
        Payslip = self.env["hr.payslip"]
        newer = self._worker("THR Prorata", 12_000_000, start=datetime.date(2025, 10, 1))
        holiday = datetime.date(2026, 3, 20)
        slip = Payslip.browse(Payslip.kompakapps_create_payslip(newer.id, holiday, holiday, struct_id=self.result["thr_structure_id"]))
        slip.compute_sheet()
        self.assertEqual(self._lines(slip)["THR"], 5_000_000)
        fresh = self._worker("THR Baru", 12_000_000, start=datetime.date(2026, 3, 10))
        slip = Payslip.browse(Payslip.kompakapps_create_payslip(fresh.id, holiday, holiday, struct_id=self.result["thr_structure_id"]))
        slip.compute_sheet()
        self.assertEqual(self._lines(slip)["THR"], 0)

    def test_duplicate_guard_is_per_structure(self):
        employee = self._worker("Dua Struktur", 12_000_000, start=datetime.date(2025, 3, 1))
        Payslip = self.env["hr.payslip"]
        Payslip.kompakapps_create_payslip(employee.id, datetime.date(2026, 3, 1), datetime.date(2026, 3, 31))
        with self.assertRaises(UserError):
            Payslip.kompakapps_create_payslip(employee.id, datetime.date(2026, 3, 1), datetime.date(2026, 3, 31))
        holiday = datetime.date(2026, 3, 20)
        self.assertTrue(Payslip.kompakapps_create_payslip(employee.id, holiday, holiday, struct_id=self.result["thr_structure_id"]))
