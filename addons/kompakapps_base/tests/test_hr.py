import datetime

from odoo import SUPERUSER_ID
from odoo.addons.account.tests.common import AccountTestInvoicingCommon
from odoo.exceptions import AccessError, UserError, ValidationError
from odoo.tests import TransactionCase, tagged


@tagged("post_install", "-at_install", "kompakapps")
class TestHumanResources(TransactionCase):
    """Fondasi menu Human Resources (D83): modul terpasang, data kerja karyawan lewat hr.version, dan kehadiran."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.department = cls.env["hr.department"].create({"name": "Operasional Uji"})
        cls.job = cls.env["hr.job"].create({"name": "Staf Gudang Uji", "department_id": cls.department.id})
        cls.employee = cls.env["hr.employee"].create(
            {
                "name": "Budi Uji",
                "department_id": cls.department.id,
                "job_id": cls.job.id,
                "contract_date_start": datetime.date(2026, 1, 1),
                "wage": 8_000_000,
            }
        )

    def test_modules_installed(self):
        for name in ("hr", "hr_attendance", "hr_holidays", "hr_expense"):
            module = self.env["ir.module.module"].search([("name", "=", name)])
            self.assertEqual(module.state, "installed", name)

    def test_employee_work_data_lives_on_version(self):
        """Odoo 19: departemen, jabatan, gaji dan tanggal kontrak disimpan pada versi berjalan karyawan."""
        version = self.employee.current_version_id
        self.assertTrue(version)
        self.assertEqual(version.department_id, self.department)
        self.assertEqual(version.job_id, self.job)
        self.assertEqual(version.wage, 8_000_000)
        self.assertEqual(version.contract_date_start, datetime.date(2026, 1, 1))
        self.employee.write({"wage": 9_000_000})
        self.assertEqual(self.employee.current_version_id.wage, 9_000_000)

    def test_attendance_hours_and_check_out(self):
        check_in = datetime.datetime(2026, 10, 19, 1, 0)
        attendance = self.env["hr.attendance"].create({"employee_id": self.employee.id, "check_in": check_in})
        self.assertEqual(self.employee.attendance_state, "checked_in")
        attendance.write({"check_out": check_in + datetime.timedelta(hours=9)})
        self.assertEqual(self.employee.attendance_state, "checked_out")
        self.assertAlmostEqual(attendance.worked_hours, 9.0, places=2)

    def test_attendance_requires_officer_group(self):
        """Pengguna biasa tanpa grup HR tidak boleh mencatat kehadiran orang lain (UI menampilkan pesan akses ditolak)."""
        plain = self.env["res.users"].create(
            {"name": "Pengguna Biasa", "login": "biasa_hr", "group_ids": [(6, 0, [self.env.ref("base.group_user").id])]}
        )
        with self.assertRaises(AccessError):
            self.env["hr.attendance"].with_user(plain).create(
                {"employee_id": self.employee.id, "check_in": datetime.datetime(2026, 10, 19, 1, 0)}
            )


@tagged("post_install", "-at_install", "kompakapps")
class TestTimeOff(TransactionCase):
    """Time Off (D83): jatah disetujui menambah saldo, pengajuan cuti dikurangkan, ditolak tidak mengurangi, dan jenis berunit setengah hari."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.employee = cls.env["hr.employee"].create({"name": "Siti Uji Cuti"})
        cls.leave_type = cls.env["hr.leave.type"].create(
            {"name": "Cuti Uji", "requires_allocation": True, "leave_validation_type": "hr", "request_unit": "half_day"}
        )
        cls.allocation = cls.env["hr.leave.allocation"].create(
            {
                "employee_id": cls.employee.id,
                "holiday_status_id": cls.leave_type.id,
                "number_of_days": 10,
                "date_from": datetime.date(2026, 1, 1),
            }
        )

    def _leave(self, start, end, **extra):
        return self.env["hr.leave"].create(
            {
                "employee_id": self.employee.id,
                "holiday_status_id": self.leave_type.id,
                "request_date_from": start,
                "request_date_to": end,
                **extra,
            }
        )

    def test_allocation_approval_and_balance(self):
        self.assertEqual(self.allocation.state, "confirm")
        self.allocation.action_approve()
        self.assertEqual(self.allocation.state, "validate")
        self.assertEqual(self.leave_type.with_context(employee_id=self.employee.id).max_leaves, 10)

    def test_leave_lifecycle(self):
        self.allocation.action_approve()
        # Senin 9 Nov sampai Selasa 10 Nov 2026 = 2 hari kerja
        leave = self._leave(datetime.date(2026, 11, 9), datetime.date(2026, 11, 10), request_date_from_period="am", request_date_to_period="pm")
        self.assertEqual(leave.state, "confirm")
        self.assertEqual(leave.number_of_days, 2)
        leave.action_approve()
        self.assertEqual(leave.state, "validate")
        taken = self.leave_type.with_context(employee_id=self.employee.id).leaves_taken
        self.assertEqual(taken, 2)
        leave.action_back_to_approval()
        self.assertEqual(leave.state, "confirm")
        leave.action_refuse()
        self.assertEqual(leave.state, "refuse")
        self.assertEqual(self.leave_type.with_context(employee_id=self.employee.id).leaves_taken, 0)

    def test_half_day(self):
        self.allocation.action_approve()
        leave = self._leave(datetime.date(2026, 11, 11), datetime.date(2026, 11, 11), request_date_from_period="am", request_date_to_period="am")
        self.assertEqual(leave.number_of_days, 0.5)

    def test_leave_over_balance_rejected(self):
        self.allocation.action_approve()
        with self.assertRaises(ValidationError):
            self._leave(datetime.date(2026, 11, 16), datetime.date(2026, 12, 4))  # 15 hari kerja > jatah 10

    def test_leave_without_allocation_rejected(self):
        other = self.env["hr.employee"].create({"name": "Tanpa Jatah"})
        with self.assertRaises(ValidationError):
            self.env["hr.leave"].create(
                {
                    "employee_id": other.id,
                    "holiday_status_id": self.leave_type.id,
                    "request_date_from": datetime.date(2026, 11, 9),
                    "request_date_to": datetime.date(2026, 11, 9),
                }
            )


@tagged("post_install", "-at_install", "kompakapps")
class TestExpenses(AccountTestInvoicingCommon):
    """Expenses (D83): biaya dibayar karyawan dari draft sampai dibayar, dengan akun biaya dan pajak COA Indonesia, serta penolakan."""

    @classmethod
    @AccountTestInvoicingCommon.setup_country("id")
    def setUpClass(cls):
        super().setUpClass()
        cls.company = cls.company_data["company"]
        # pengguna uji akuntansi tidak punya hak HR, dan perusahaan uji berbeda dari perusahaan utama
        cls.env = cls.env(user=SUPERUSER_ID, context={"allowed_company_ids": cls.company.ids})
        cls.employee = cls.env["hr.employee"].create({"name": "Karyawan Biaya Uji", "company_id": cls.company.id})
        cls.category = cls.env["product.product"].create({"name": "Makan Uji", "can_be_expensed": True, "standard_price": 0.0})
        cls.expense_account = cls.env["account.account"].search(
            [("account_type", "=", "expense"), ("company_ids", "in", cls.company.id), ("code", "=like", "6%")], limit=1
        )
        assert cls.expense_account, "COA l10n_id tidak punya akun beban 6xxxxxxx"
        cls.tax = cls.env["account.tax"].search(
            [("type_tax_use", "=", "purchase"), ("amount", "=", 12.0), ("amount_type", "=", "percent"), ("company_id", "=", cls.company.id)], limit=1
        )
        assert cls.tax, "pajak pembelian 12% tidak ada"

    def _expense(self, **extra):
        return self.env["hr.expense"].create(
            {
                "name": "Makan siang klien",
                "employee_id": self.employee.id,
                "product_id": self.category.id,
                "total_amount_currency": 111_000.0,
                "account_id": self.expense_account.id,
                "tax_ids": [(6, 0, self.tax.ids)],
                "payment_mode": "own_account",
                **extra,
            }
        )

    def test_tax_included_split(self):
        expense = self._expense()
        self.assertEqual(expense.state, "draft")
        self.assertAlmostEqual(expense.total_amount, 111_000.0, places=1)
        self.assertAlmostEqual(expense.untaxed_amount, 99_107.14, places=1)
        self.assertAlmostEqual(expense.tax_amount, 11_892.86, places=1)

    def test_employee_paid_flow_posts_receipt_to_payable(self):
        expense = self._expense()
        expense.action_submit()
        self.assertIn(expense.state, ("submitted", "approved"))
        if expense.state == "submitted":
            expense.action_approve()
        self.assertEqual(expense.state, "approved")
        wizard = self.env["hr.expense.post.wizard"].with_context(active_ids=expense.ids, validate_analytic=True).create({})
        wizard.action_post_entry()
        self.assertEqual(expense.state, "posted")
        move = expense.account_move_id
        self.assertEqual(move.state, "posted")
        debit = move.line_ids.filtered(lambda line: line.debit)
        credit = move.line_ids.filtered(lambda line: line.credit)
        self.assertIn(self.expense_account, debit.account_id)
        self.assertAlmostEqual(sum(debit.mapped("debit")), 111_000.0, places=1)
        self.assertEqual(credit.account_id.account_type, "liability_payable")
        self.assertEqual(credit.partner_id, self.employee.work_contact_id)
        context = {"active_model": "account.move", "active_ids": move.ids}
        register = self.env["account.payment.register"].with_context(**context).create({})
        register.action_create_payments()
        self.assertEqual(move.payment_state, "paid")
        self.assertEqual(expense.state, "paid")

    def test_refuse_and_reset(self):
        expense = self._expense()
        expense.action_submit()
        if expense.state == "approved":
            expense.action_reset()
            expense.manager_id = self.env.user
            expense.action_submit()
        wizard = self.env["hr.expense.refuse.wizard"].with_context(active_ids=expense.ids).create({"reason": "Tanpa struk"})
        wizard.action_refuse()
        self.assertEqual(expense.state, "refused")
        expense.action_reset()
        self.assertEqual(expense.state, "draft")

    def test_cannot_post_unapproved(self):
        expense = self._expense()
        with self.assertRaises(UserError):
            expense.action_post()
