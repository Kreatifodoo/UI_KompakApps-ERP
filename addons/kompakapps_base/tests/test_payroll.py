import datetime

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
