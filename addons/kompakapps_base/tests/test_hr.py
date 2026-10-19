import datetime

from odoo.exceptions import AccessError
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
