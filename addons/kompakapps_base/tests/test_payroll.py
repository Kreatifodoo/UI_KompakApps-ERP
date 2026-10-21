import datetime

from odoo import SUPERUSER_ID
from odoo.addons.account.tests.common import AccountTestInvoicingCommon
from odoo.exceptions import AccessError, UserError
from odoo.tests import TransactionCase, tagged


@tagged("post_install", "-at_install", "kompakapps")
class TestPayrollEngine(TransactionCase):
    """Payroll (D85): OCA payroll sebagai mesin hitung. Angka di test ini hanya untuk memeriksa mekanik
    (tetap, persentase, ekspresi), BUKAN aturan BPJS, PPh 21, atau lembur."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        env = cls.env
        cls.employee = env["hr.employee"].create(
            {"name": "Rina Uji Gaji", "contract_date_start": datetime.date(2026, 1, 1), "wage": 8_000_000}
        )
        category = env["hr.salary.rule.category"]
        cls.cat_basic = category.create({"name": "Dasar", "code": "BASIC"})
        cls.cat_alw = category.create({"name": "Tunjangan", "code": "ALW"})
        cls.cat_ded = category.create({"name": "Potongan", "code": "DED"})
        cls.cat_net = category.create({"name": "Bersih", "code": "NET"})
        rule = env["hr.salary.rule"]
        cls.rule_basic = rule.create(
            {"name": "Gaji Pokok", "code": "BASIC", "sequence": 1, "category_id": cls.cat_basic.id,
             "amount_select": "code", "amount_python_compute": "result = contract.wage"}
        )
        cls.rule_alw = rule.create(
            {"name": "Tunjangan Uji", "code": "TUNJ", "sequence": 2, "category_id": cls.cat_alw.id,
             "amount_select": "fix", "amount_fix": 500_000}
        )
        cls.rule_ded = rule.create(
            {"name": "Potongan Uji 2 persen", "code": "POT", "sequence": 3, "category_id": cls.cat_ded.id,
             "amount_select": "percentage", "amount_percentage": 2.0, "amount_percentage_base": "contract.wage",
             "quantity": "-1"}
        )
        cls.rule_net = rule.create(
            {"name": "Gaji Bersih", "code": "NET", "sequence": 10, "category_id": cls.cat_net.id,
             "amount_select": "code", "amount_python_compute": "result = categories.BASIC + categories.ALW + categories.DED"}
        )
        cls.structure = env["hr.payroll.structure"].create(
            {"name": "Struktur Uji", "code": "UJI", "rule_ids": [(6, 0, (cls.rule_basic | cls.rule_alw | cls.rule_ded | cls.rule_net).ids)]}
        )
        cls.version = cls.employee.current_version_id
        cls.version.write({"struct_id": cls.structure.id})

    def _make_user(self, login, group_xmlids):
        groups = [self.env.ref("base.group_user").id] + [self.env.ref(x).id for x in group_xmlids]
        return self.env["res.users"].create({"name": login, "login": login, "group_ids": [(6, 0, groups)]})

    def _new_slip(self, date_from=datetime.date(2026, 10, 1), date_to=datetime.date(2026, 10, 31)):
        vals = self.env["hr.payslip"].get_payslip_vals(date_from, date_to, self.employee.id)["value"]
        return self.env["hr.payslip"].create(
            {
                "employee_id": self.employee.id,
                "date_from": date_from,
                "date_to": date_to,
                "contract_id": vals["contract_id"],
                "struct_id": vals["struct_id"],
                "name": "Slip Uji",
                "input_line_ids": [(0, 0, line) for line in vals["input_line_ids"]],
                "worked_days_line_ids": [(0, 0, line) for line in vals["worked_days_line_ids"]],
            }
        )

    def test_modules_installed(self):
        module = self.env["ir.module.module"].search([("name", "=", "payroll")])
        self.assertEqual(module.state, "installed")
        self.assertIn("payroll", self.env["ir.module.module"].search([("name", "=", "kompakapps_base")]).dependencies_id.mapped("name"))

    def test_admin_is_payroll_manager(self):
        admin = self.env.ref("base.user_admin")
        self.assertTrue(admin.has_group("payroll.group_payroll_manager"))
        self.assertTrue(admin.has_group("payroll.group_payroll_user"))

    def test_slip_flow_computes_lines_and_net(self):
        slip = self._new_slip()
        self.assertEqual(slip.state, "draft")
        self.assertEqual(slip.struct_id, self.structure)
        self.assertTrue(slip.worked_days_line_ids.filtered(lambda w: w.code == "WORK100"))
        slip.compute_sheet()
        self.assertEqual(slip.state, "verify")
        self.assertTrue(slip.number)
        totals = {line.code: line.total for line in slip.line_ids}
        self.assertAlmostEqual(totals["BASIC"], 8_000_000, places=2)
        self.assertAlmostEqual(totals["TUNJ"], 500_000, places=2)
        self.assertAlmostEqual(totals["POT"], -160_000, places=2)
        self.assertAlmostEqual(totals["NET"], 8_340_000, places=2)
        slip.action_payslip_done()
        self.assertEqual(slip.state, "done")
        with self.assertRaises(UserError):
            slip.action_payslip_cancel()  # slip yang sudah selesai tidak boleh dibatalkan
        with self.assertRaises(UserError):
            slip.unlink()

    def test_cancel_and_back_to_draft(self):
        slip = self._new_slip()
        slip.compute_sheet()
        slip.action_payslip_cancel()
        self.assertEqual(slip.state, "cancel")
        slip.action_payslip_draft()
        self.assertEqual(slip.state, "draft")
        slip.unlink()

    def test_broken_python_rule_gives_clear_error(self):
        self.rule_basic.write({"amount_python_compute": "result = tidak_ada + 1"})
        slip = self._new_slip()
        with self.assertRaises(UserError) as caught:
            slip.compute_sheet()
        self.assertIn("Gaji Pokok", str(caught.exception))

    def test_only_manager_edits_rules(self):
        """Hanya Manager payroll yang boleh membuat atau mengubah aturan (ada ekspresi Python); Officer hanya membaca."""
        officer = self._make_user("officer_payroll", ["payroll.group_payroll_user"])
        manager = self._make_user("manager_payroll", ["payroll.group_payroll_manager"])
        rules = self.env["hr.salary.rule"]
        self.assertTrue(rules.with_user(officer).search([("code", "=", "BASIC")]))
        with self.assertRaises(AccessError):
            self.rule_basic.with_user(officer).write({"amount_python_compute": "result = 1"})
        with self.assertRaises(AccessError):
            rules.with_user(officer).create(
                {"name": "Coba Officer", "code": "COBA", "amount_select": "code", "amount_python_compute": "result = 1"}
            )
        with self.assertRaises(AccessError):
            self.rule_basic.with_user(officer).unlink()
        created = rules.with_user(manager).create(
            {"name": "Aturan Manager", "code": "MGR", "amount_select": "code", "amount_python_compute": "result = 2"}
        )
        self.assertEqual(created.amount_python_compute, "result = 2")

    def test_plain_users_are_denied(self):
        """Pengguna biasa dan staf HR tanpa grup payroll tidak melihat aturan maupun slip gaji."""
        plain = self._make_user("biasa_payroll", [])
        hr_only = self._make_user("hr_only_payroll", ["hr.group_hr_user"])
        slip = self._new_slip()
        for user in (plain, hr_only):
            with self.assertRaises(AccessError):
                self.env["hr.salary.rule"].with_user(user).search([])
            with self.assertRaises(AccessError):
                slip.with_user(user).read(["name"])
            with self.assertRaises(AccessError):
                self.env["hr.salary.rule"].with_user(user).create({"name": "X", "code": "X"})

    def test_batch_needs_manager(self):
        """Batch slip (hr.payslip.run) hanya untuk Manager payroll."""
        officer = self._make_user("officer_batch", ["payroll.group_payroll_user"])
        manager = self._make_user("manager_batch", ["payroll.group_payroll_manager"])
        values = {"name": "Batch Oktober Uji", "date_start": datetime.date(2026, 10, 1), "date_end": datetime.date(2026, 10, 31)}
        with self.assertRaises(AccessError):
            self.env["hr.payslip.run"].with_user(officer).create(values)
        self.assertTrue(self.env["hr.payslip.run"].with_user(manager).create(values))


@tagged("post_install", "-at_install", "kompakapps")
class TestPayrollStandardStructure(TransactionCase):
    """Struktur umum netral "Gaji Standar" (D85): idempoten, dihitung dari kontrak dan input slip, tanpa angka hukum."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.company = cls.env.company
        cls.employee = cls.env["hr.employee"].create(
            {"name": "Dewi Uji Struktur", "contract_date_start": datetime.date(2026, 1, 1), "wage": 8_000_000}
        )

    def _slip(self, structure, inputs=None):
        self.employee.current_version_id.write({"struct_id": structure.id})
        Payslip = self.env["hr.payslip"]
        slip = Payslip.browse(Payslip.kompakapps_create_payslip(self.employee.id, datetime.date(2026, 10, 1), datetime.date(2026, 10, 31)))
        for code, amount in (inputs or {}).items():
            slip.input_line_ids.filtered(lambda line, code=code: line.code == code).write({"amount": amount})
        return slip

    def test_setup_is_idempotent_and_neutral(self):
        result = self.company.kompakapps_setup_payroll()
        self.assertTrue(result["created"])
        structure = self.env["hr.payroll.structure"].browse(result["structure_id"])
        self.assertEqual(structure.code, "GAJI-STD")
        self.assertEqual(sorted(structure.rule_ids.mapped("code")), ["GAPOK", "NET", "POT", "TUNJ"])
        self.assertEqual(sorted(structure.rule_ids.input_ids.mapped("code")), ["POT", "TUNJ"])
        rules_before = self.env["hr.salary.rule"].search_count([("company_id", "=", self.company.id)])
        again = self.company.kompakapps_setup_payroll()
        self.assertFalse(again["created"])
        self.assertEqual(again["structure_id"], structure.id)
        self.assertEqual(self.env["hr.salary.rule"].search_count([("company_id", "=", self.company.id)]), rules_before)
        # tidak ada aturan hukum: tidak ada BPJS, PPh, lembur, THR
        names = " ".join(structure.rule_ids.mapped("name")).lower()
        for word in ("bpjs", "pph", "lembur", "thr", "jht", "jkk"):
            self.assertNotIn(word, names)

    def test_standard_slip_uses_wage_and_inputs(self):
        structure = self.env["hr.payroll.structure"].browse(self.company.kompakapps_setup_payroll()["structure_id"])
        slip = self._slip(structure, {"TUNJ": 500_000, "POT": 100_000})
        slip.compute_sheet()
        totals = {line.code: line.total for line in slip.line_ids}
        self.assertAlmostEqual(totals["GAPOK"], 8_000_000, places=2)
        self.assertAlmostEqual(totals["TUNJ"], 500_000, places=2)
        self.assertAlmostEqual(totals["POT"], -100_000, places=2)
        self.assertAlmostEqual(totals["NET"], 8_400_000, places=2)

    def test_standard_slip_without_inputs(self):
        structure = self.env["hr.payroll.structure"].browse(self.company.kompakapps_setup_payroll()["structure_id"])
        slip = self._slip(structure)
        slip.input_line_ids.unlink()  # tanpa input sama sekali tetap terhitung (tunjangan dan potongan nol)
        slip.compute_sheet()
        totals = {line.code: line.total for line in slip.line_ids}
        self.assertAlmostEqual(totals["NET"], 8_000_000, places=2)

    def test_setup_restores_deleted_rule_only(self):
        structure = self.env["hr.payroll.structure"].browse(self.company.kompakapps_setup_payroll()["structure_id"])
        allowance = structure.rule_ids.filtered(lambda rule: rule.code == "TUNJ")
        deduction = structure.rule_ids.filtered(lambda rule: rule.code == "POT")
        structure.write({"rule_ids": [(3, deduction.id)]})  # pengguna sengaja melepas Potongan dari struktur: tidak dipasang lagi
        allowance.input_ids.unlink()  # input harus dihapus lebih dulu (kunci asing)
        allowance.unlink()
        result = self.company.kompakapps_setup_payroll()
        self.assertTrue(result["created"])
        self.assertEqual(result["structure_id"], structure.id)
        self.assertEqual(sorted(structure.rule_ids.mapped("code")), ["GAPOK", "NET", "TUNJ"])

    def test_setup_requires_payroll_manager(self):
        groups = [self.env.ref("base.group_user").id, self.env.ref("payroll.group_payroll_user").id]
        officer = self.env["res.users"].create({"name": "officer_setup", "login": "officer_setup", "group_ids": [(6, 0, groups)]})
        with self.assertRaises(AccessError):
            self.company.with_user(officer).kompakapps_setup_payroll()

    def test_create_payslip_guards(self):
        Payslip = self.env["hr.payslip"]
        structure = self.env["hr.payroll.structure"].browse(self.company.kompakapps_setup_payroll()["structure_id"])
        first, last = datetime.date(2026, 10, 1), datetime.date(2026, 10, 31)
        # kontrak belum bersruktur
        with self.assertRaises(UserError):
            Payslip.kompakapps_create_payslip(self.employee.id, first, last)
        # tidak ada kontrak pada periode itu
        self.employee.current_version_id.write({"struct_id": structure.id})
        with self.assertRaises(UserError):
            Payslip.kompakapps_create_payslip(self.employee.id, datetime.date(2025, 10, 1), datetime.date(2025, 10, 31))
        # periode terbalik
        with self.assertRaises(UserError):
            Payslip.kompakapps_create_payslip(self.employee.id, last, first)
        slip = Payslip.browse(Payslip.kompakapps_create_payslip(self.employee.id, first, last))
        self.assertIn("Oktober 2026", slip.name)
        self.assertEqual(sorted(slip.input_line_ids.mapped("code")), ["POT", "TUNJ"])
        # slip kembar pada periode beririsan ditolak, kecuali yang lama dibatalkan
        with self.assertRaises(UserError):
            Payslip.kompakapps_create_payslip(self.employee.id, datetime.date(2026, 10, 15), datetime.date(2026, 11, 14))
        slip.action_payslip_cancel()
        again = Payslip.kompakapps_create_payslip(self.employee.id, first, last)
        self.assertNotEqual(again, slip.id)

    def test_refund_allows_reissue(self):
        """Slip selesai yang dikoreksi (refund) tidak menghalangi slip baru pada periode yang sama; slip koreksi sendiri berstatus selesai."""
        structure = self.env["hr.payroll.structure"].browse(self.company.kompakapps_setup_payroll()["structure_id"])
        slip = self._slip(structure, {"TUNJ": 300_000})
        slip.compute_sheet()
        slip.action_payslip_done()
        with self.assertRaises(UserError):
            self.env["hr.payslip"].kompakapps_create_payslip(self.employee.id, slip.date_from, slip.date_to)
        slip.refund_sheet()
        refund = slip.refunded_id
        self.assertTrue(refund.credit_note)
        self.assertEqual(refund.state, "done")
        reissued = self.env["hr.payslip"].kompakapps_create_payslip(self.employee.id, slip.date_from, slip.date_to)
        self.assertNotIn(reissued, (slip.id, refund.id))


@tagged("post_install", "-at_install", "kompakapps")
class TestPayrollBatch(TransactionCase):
    """Batch slip (D85): buat slip massal, karyawan bermasalah dilewati, hitung dan konfirmasi semua, tutup, dan penjaga akses."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.company = cls.env.company
        cls.structure = cls.env["hr.payroll.structure"].browse(cls.company.kompakapps_setup_payroll()["structure_id"])
        Employee = cls.env["hr.employee"]
        values = {"contract_date_start": datetime.date(2026, 1, 1)}
        cls.emp_a = Employee.create({"name": "Batch A Uji", "wage": 6_000_000, **values})
        cls.emp_b = Employee.create({"name": "Batch B Uji", "wage": 7_000_000, **values})
        cls.emp_nostruct = Employee.create({"name": "Batch Tanpa Struktur", "wage": 5_000_000, **values})
        cls.emp_nocontract = Employee.create({"name": "Batch Tanpa Kontrak Uji"})
        for employee in (cls.emp_a, cls.emp_b):
            employee.current_version_id.write({"struct_id": cls.structure.id})
        cls.batch = cls.env["hr.payslip.run"].create(
            {"name": "Batch Oktober Uji", "date_start": datetime.date(2026, 10, 1), "date_end": datetime.date(2026, 10, 31)}
        )

    def test_generate_compute_confirm_close(self):
        employees = self.emp_a | self.emp_b | self.emp_nostruct
        result = self.batch.kompakapps_generate_slips(employees.ids)
        self.assertEqual(len(result["created"]), 2)
        self.assertEqual([s["employee"] for s in result["skipped"]], ["Batch Tanpa Struktur"])
        self.assertIn("Struktur Gaji", result["skipped"][0]["reason"])
        self.assertEqual(self.batch.slip_ids.employee_id, self.emp_a | self.emp_b)
        # slip yang sudah ada tidak dibuat ulang
        again = self.batch.kompakapps_generate_slips(employees.ids)
        self.assertEqual(len(again["created"]), 0)
        # confirm sebelum hitung tidak menyentuh slip draf
        self.assertEqual(self.batch.kompakapps_confirm_all(), {"confirmed": 0, "pending": 2})
        self.assertEqual(self.batch.kompakapps_compute_all(), 2)
        self.assertEqual(set(self.batch.slip_ids.mapped("state")), {"verify"})
        self.assertEqual(self.batch.kompakapps_confirm_all(), {"confirmed": 2, "pending": 0})
        self.assertEqual(set(self.batch.slip_ids.mapped("state")), {"done"})
        nets = {slip.employee_id.name: slip.get_salary_line_total("NET") for slip in self.batch.slip_ids}
        self.assertEqual(nets, {"Batch A Uji": 6_000_000, "Batch B Uji": 7_000_000})
        self.batch.close_payslip_run()
        with self.assertRaises(UserError):
            self.batch.kompakapps_generate_slips(employees.ids)
        self.batch.draft_payslip_run()
        self.assertEqual(self.batch.state, "draft")

    def test_generate_for_all_counts_ineligible(self):
        result = self.batch.kompakapps_generate_slips()
        created_employees = self.env["hr.payslip"].browse(result["created"]).employee_id
        self.assertIn(self.emp_a, created_employees)
        self.assertIn(self.emp_b, created_employees)
        self.assertNotIn(self.emp_nocontract, created_employees)
        self.assertIn("Batch Tanpa Struktur", [s["employee"] for s in result["skipped"]])
        self.assertGreaterEqual(result["ineligible"], 1)

    def test_batch_requires_manager(self):
        groups = [self.env.ref("base.group_user").id, self.env.ref("payroll.group_payroll_user").id]
        officer = self.env["res.users"].create({"name": "officer_run", "login": "officer_run", "group_ids": [(6, 0, groups)]})
        with self.assertRaises(AccessError):
            self.batch.with_user(officer).kompakapps_generate_slips(self.emp_a.ids)


@tagged("post_install", "-at_install", "kompakapps")
class TestPayrollJournal(AccountTestInvoicingCommon):
    """Jurnal gaji ke COA (D85): jurnal seimbang saat slip dikonfirmasi, tanpa tebakan akun, koreksi dan pembatalan membalik jurnal."""

    @classmethod
    @AccountTestInvoicingCommon.setup_country("id")
    def setUpClass(cls):
        super().setUpClass()
        cls.company = cls.company_data["company"]
        cls.journal = cls.company_data["default_journal_misc"]
        # pengguna uji akuntansi tidak punya hak payroll, dan perusahaan uji berbeda dari perusahaan utama
        cls.env = cls.env(user=SUPERUSER_ID, context={"allowed_company_ids": cls.company.ids})
        cls.company, cls.journal = cls.company.with_env(cls.env), cls.journal.with_env(cls.env)
        cls.employee = cls.env["hr.employee"].create(
            {"name": "Karyawan Jurnal Uji", "company_id": cls.company.id, "contract_date_start": datetime.date(2026, 1, 1), "wage": 10_000_000}
        )
        cls.structure = cls.env["hr.payroll.structure"].browse(cls.company.kompakapps_setup_payroll()["structure_id"])
        cls.rules = {rule.code: rule for rule in cls.structure.rule_ids}
        cls.employee.current_version_id.write({"struct_id": cls.structure.id})
        Account = cls.env["account.account"]
        domain = [("company_ids", "in", cls.company.id)]
        cls.expense_basic, cls.expense_allowance = Account.search(domain + [("account_type", "=", "expense"), ("code", "=like", "6%")], limit=2)
        cls.liability = Account.search(domain + [("account_type", "=", "liability_current")], limit=1)
        cls.payable = Account.search(domain + [("account_type", "=", "liability_payable")], limit=1)

    def _configure(self, net=True, journal=True):
        """Akun uji: GAPOK dan TUNJ didebit ke beban, POT (negatif) dikredit ke hutang potongan lewat akun debit, NET dikredit ke hutang gaji."""
        self.rules["GAPOK"].kompakapps_account_debit_id = self.expense_basic
        self.rules["TUNJ"].kompakapps_account_debit_id = self.expense_allowance
        self.rules["POT"].kompakapps_account_debit_id = self.liability
        if net:
            self.rules["NET"].kompakapps_account_credit_id = self.payable
        if journal:
            self.structure.kompakapps_journal_id = self.journal

    def _slip(self, allowance=1_000_000, deduction=200_000):
        Payslip = self.env["hr.payslip"]
        slip = Payslip.browse(Payslip.kompakapps_create_payslip(self.employee.id, datetime.date(2026, 10, 1), datetime.date(2026, 10, 31)))
        slip.input_line_ids.filtered(lambda line: line.code == "TUNJ").amount = allowance
        slip.input_line_ids.filtered(lambda line: line.code == "POT").amount = deduction
        slip.compute_sheet()
        return slip

    def _lines(self, move):
        return sorted((line.account_id.id, line.debit, line.credit) for line in move.line_ids)

    def test_confirm_without_accounts_has_no_journal(self):
        slip = self._slip()
        slip.action_payslip_done()
        self.assertEqual(slip.state, "done")
        self.assertFalse(slip.kompakapps_move_id)
        self.assertIn("Pengaturan akun gaji belum lengkap", slip.kompakapps_move_note)
        with self.assertRaises(UserError):
            slip.kompakapps_post_journal()

    def test_confirm_posts_balanced_journal(self):
        self._configure()
        slip = self._slip()
        slip.action_payslip_done()
        move = slip.kompakapps_move_id
        self.assertEqual(move.state, "posted")
        self.assertEqual(move.journal_id, self.journal)
        self.assertEqual(move.date, datetime.date(2026, 10, 31))
        self.assertFalse(slip.kompakapps_move_note)
        self.assertAlmostEqual(sum(move.line_ids.mapped("debit")), sum(move.line_ids.mapped("credit")), places=2)
        self.assertEqual(
            self._lines(move),
            sorted(
                [
                    (self.expense_basic.id, 10_000_000, 0.0),
                    (self.expense_allowance.id, 1_000_000, 0.0),
                    (self.liability.id, 0.0, 200_000),
                    (self.payable.id, 0.0, 10_800_000),
                ]
            ),
        )
        payable_line = move.line_ids.filtered(lambda line: line.account_id == self.payable)
        self.assertEqual(payable_line.partner_id, self.employee.work_contact_id)

    def test_unbalanced_setup_confirms_without_journal_then_retry(self):
        self._configure(net=False)  # akun kredit gaji bersih belum diisi: jurnal tidak seimbang
        slip = self._slip()
        slip.action_payslip_done()
        self.assertFalse(slip.kompakapps_move_id)
        self.assertIn("tidak seimbang", slip.kompakapps_move_note)
        self.rules["NET"].kompakapps_account_credit_id = self.payable
        slip.kompakapps_post_journal()
        self.assertEqual(slip.kompakapps_move_id.state, "posted")
        self.assertFalse(slip.kompakapps_move_note)
        with self.assertRaises(UserError):
            slip.kompakapps_post_journal()  # sudah punya jurnal

    def test_missing_journal_confirms_without_journal(self):
        self._configure(journal=False)
        slip = self._slip()
        slip.action_payslip_done()
        self.assertFalse(slip.kompakapps_move_id)
        self.assertIn("Jurnal Gaji", slip.kompakapps_move_note)

    def test_refund_posts_reversing_journal(self):
        self._configure()
        slip = self._slip()
        slip.action_payslip_done()
        slip.refund_sheet()
        refund = slip.refunded_id
        self.assertEqual(refund.state, "done")
        original = slip.kompakapps_move_id
        reversal = refund.kompakapps_move_id
        self.assertTrue(reversal and reversal != original)
        self.assertEqual(
            self._lines(reversal),
            sorted((account, credit, debit) for account, debit, credit in self._lines(original)),
        )
        total = sum((original | reversal).line_ids.mapped("balance"))
        self.assertAlmostEqual(total, 0.0, places=2)

    def test_cancel_done_slip_reverses_journal(self):
        self.env["ir.config_parameter"].sudo().set_param("payroll.allow_cancel_payslips", "True")
        self._configure()
        slip = self._slip()
        slip.action_payslip_done()
        move = slip.kompakapps_move_id
        slip.action_payslip_cancel()
        self.assertEqual(slip.state, "cancel")
        self.assertFalse(slip.kompakapps_move_id)
        self.assertTrue(move.reversal_move_ids)
        self.assertEqual(move.reversal_move_ids.state, "posted")
        self.assertAlmostEqual(sum((move | move.reversal_move_ids).line_ids.mapped("balance")), 0.0, places=2)

    def test_officer_confirms_but_cannot_change_journal(self):
        self._configure()
        groups = [self.env.ref("base.group_user").id, self.env.ref("payroll.group_payroll_user").id]
        officer = self.env["res.users"].create(
            {"name": "officer_journal", "login": "officer_journal", "group_ids": [(6, 0, groups)], "company_ids": [(6, 0, self.company.ids)], "company_id": self.company.id}
        )
        slip = self._slip().with_user(officer)
        slip.action_payslip_done()  # petugas tanpa hak akuntansi tetap menghasilkan jurnal (diposting dengan sudo)
        self.assertEqual(slip.kompakapps_move_id.state, "posted")
        with self.assertRaises(AccessError):
            self.structure.with_user(officer).write({"kompakapps_journal_id": False})
