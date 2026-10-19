import datetime

from odoo.exceptions import AccessError, ValidationError
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
