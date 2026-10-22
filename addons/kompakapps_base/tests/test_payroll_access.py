import datetime
from unittest.mock import patch

from odoo.exceptions import AccessError, UserError
from odoo.tests import tagged

from odoo.addons.mail.models.mail_mail import MailMail

from .test_payroll_id import OCT_FROM, OCT_TO, PayrollIdCommon

NOV_FROM, NOV_TO = datetime.date(2026, 11, 1), datetime.date(2026, 11, 30)


@tagged("post_install", "-at_install", "kompakapps")
class TestPayrollAccess(PayrollIdCommon):
    """Hak akses slip, Slip Saya, data cetak, dan kirim email (D86 irisan 4, Q59)."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.user_a = cls._user("slip_user_a", [])
        cls.user_b = cls._user("slip_user_b", [])
        cls.officer = cls._user("slip_officer", ["payroll.group_payroll_user"])
        cls.manager = cls._user("slip_manager", ["payroll.group_payroll_manager"])
        cls.hr_manager = cls._user("slip_hr", ["hr.group_hr_manager"])
        cls.plain = cls._user("slip_plain", [])
        cls.emp_a = cls._mk_employee("Ani Slip", 8_500_000, user_id=cls.user_a.id, work_email="ani.slip@example.test")
        cls.emp_b = cls._mk_employee("Budi Slip", 9_000_000, user_id=cls.user_b.id)
        cls.emp_a.kompakapps_npwp = "12.345.678.9-012.000"
        # slip selesai Oktober untuk keduanya, slip Ani November dibiarkan Dihitung (belum selesai)
        cls.slip_a = cls._slip(cls.emp_a, {"BONUS": 500_000})
        cls.slip_b = cls._slip(cls.emp_b)
        (cls.slip_a | cls.slip_b).with_user(cls.manager).action_payslip_done()
        cls.slip_a_nov = cls._slip(cls.emp_a, date_from=NOV_FROM, date_to=NOV_TO)

    @classmethod
    def _mk_employee(cls, name, wage, **extra):
        employee = cls.env["hr.employee"].create(
            {"name": name, "company_id": cls.company.id, "contract_date_start": datetime.date(2026, 1, 1), "wage": wage, **extra}
        )
        employee.current_version_id.write({"struct_id": cls.structure.id})
        return employee

    @classmethod
    def _user(cls, login, xmlids):
        groups = [cls.env.ref("base.group_user").id] + [cls.env.ref(x).id for x in xmlids]
        return cls.env["res.users"].create(
            {"name": login, "login": login, "group_ids": [(6, 0, groups)], "company_ids": [(6, 0, cls.company.ids)], "company_id": cls.company.id}
        )

    @classmethod
    def _slip(cls, employee, inputs=None, date_from=OCT_FROM, date_to=OCT_TO):
        Payslip = cls.env["hr.payslip"]
        slip = Payslip.browse(Payslip.kompakapps_create_payslip(employee.id, date_from, date_to))
        for code, amount in (inputs or {}).items():
            slip.input_line_ids.filtered(lambda line: line.code == code).amount = amount
        slip.compute_sheet()
        return slip

    # ---------- Officer dan Manager ----------
    def test_officer_computes_but_only_manager_confirms_cancels_refunds(self):
        Payslip = self.env["hr.payslip"].with_user(self.officer)
        slip = Payslip.browse(Payslip.kompakapps_create_payslip(self.emp_b.id, NOV_FROM, NOV_TO))  # Officer membuat dan menghitung slip
        slip.compute_sheet()
        self.assertEqual(slip.state, "verify")
        with self.assertRaises(AccessError):
            slip.action_payslip_done()
        slip.with_user(self.manager).action_payslip_done()
        self.assertEqual(slip.state, "done")
        for name in ("action_payslip_cancel", "action_payslip_draft", "refund_sheet", "kompakapps_post_journal"):
            with self.assertRaises(AccessError, msg=name):
                getattr(slip.with_user(self.officer), name)()
        slip.with_user(self.manager).refund_sheet()  # Manager boleh
        self.assertTrue(slip.refunded_id)

    def test_officer_sees_every_slip_and_line_but_not_other_company_data(self):
        officer = self.officer
        found = self.env["hr.payslip"].with_user(officer).search([("id", "in", (self.slip_a | self.slip_b | self.slip_a_nov).ids)])
        self.assertEqual(found, self.slip_a | self.slip_b | self.slip_a_nov)  # termasuk milik karyawan lain dan yang belum selesai
        self.assertTrue(self.env["hr.payslip.line"].with_user(officer).search_count([("slip_id", "=", self.slip_b.id)]))
        self.assertTrue(self.env["hr.payslip.line"].with_user(officer).search_count([("slip_id", "=", self.slip_a_nov.id)]))

    # ---------- Slip Saya ----------
    def test_employee_reads_only_own_done_slips(self):
        Payslip = self.env["hr.payslip"]
        rows = Payslip.with_user(self.user_a).search([])
        self.assertEqual(rows, self.slip_a)  # milik sendiri dan Selesai; slip November (Dihitung) dan slip Budi tidak terlihat
        self.assertEqual(self.slip_a.with_user(self.user_a).number, self.slip_a.number)
        with self.assertRaises(AccessError):
            self.slip_b.with_user(self.user_a).read(["name"])
        with self.assertRaises(AccessError):
            self.slip_a_nov.with_user(self.user_a).read(["name"])
        lines = self.env["hr.payslip.line"].with_user(self.user_a).search([], order="sequence, id")  # urutan bawaan memuat kontrak yang tertutup bagi karyawan
        self.assertTrue(lines)
        self.assertEqual(lines.slip_id, self.slip_a)
        self.assertFalse(self.env["hr.payslip.line"].with_user(self.user_a).search([("slip_id", "=", self.slip_b.id)], order="id"))
        # tanpa hak tulis, buat, atau hapus
        with self.assertRaises(AccessError):
            self.slip_a.with_user(self.user_a).write({"name": "ubah"})
        with self.assertRaises(AccessError):
            self.slip_a.with_user(self.user_a).unlink()
        with self.assertRaises(AccessError):
            Payslip.with_user(self.user_a).create({"employee_id": self.emp_a.id, "date_from": OCT_FROM, "date_to": OCT_TO})
        with self.assertRaises(AccessError):
            self.slip_a.with_user(self.user_a).action_payslip_cancel()
        # input dan hari kerja tidak terbaca karyawan
        with self.assertRaises(AccessError):
            self.env["hr.payslip.input"].with_user(self.user_a).search([])

    def test_user_without_employee_sees_nothing(self):
        self.assertFalse(self.env["hr.payslip"].with_user(self.plain).search([]))
        self.assertFalse(self.env["hr.payslip"].with_user(self.plain).kompakapps_my_employee())
        self.assertEqual(self.env["hr.payslip"].with_user(self.user_a).kompakapps_my_employee()["id"], self.emp_a.id)
        with self.assertRaises(AccessError):
            self.slip_a.with_user(self.plain).kompakapps_slip_data()

    def test_hr_manager_without_payroll_group_is_denied(self):
        hr = self.hr_manager
        self.assertFalse(self.env["hr.payslip.line"].with_user(hr).search([], order="id"))
        for model in ("hr.payslip.input", "hr.payslip.worked_days", "kompakapps.payroll.parameter", "kompakapps.payroll.bracket", "hr.salary.rule"):
            with self.assertRaises(AccessError, msg=model):
                self.env[model].with_user(hr).search([], limit=1, order="id").read()
        # tidak ada slip yang terbaca, karena hanya slip sendiri (tidak ada) yang boleh
        self.assertFalse(self.env["hr.payslip"].with_user(hr).search([]))
        with self.assertRaises(AccessError):
            self.slip_a.with_user(hr).kompakapps_slip_data()

    # ---------- Data cetak ----------
    def test_slip_data_groups_lines_and_totals(self):
        data = self.slip_a.with_user(self.manager).kompakapps_slip_data()[0]
        self.assertEqual(data["employee"]["name"], "Ani Slip")
        self.assertEqual(data["employee"]["npwp"], "12.345.678.9-012.000")
        self.assertEqual(data["state"], "done")
        names = lambda key: {item["code"]: item["amount"] for item in data[key]}  # noqa: E731
        earnings, deductions, employer = names("earnings"), names("deductions"), names("employer")
        self.assertEqual(earnings["GAPOK"], 8_500_000)
        self.assertEqual(earnings["BONUS"], 500_000)
        self.assertEqual(deductions["BPJS_JHT_K"], -170_000)  # 2% x 8.500.000
        self.assertEqual(employer["BPJS_JHT_P"], 314_500)  # 3,7% x 8.500.000
        self.assertNotIn("BPJS_JHT_P", earnings)
        self.assertNotIn("BPJS_JHT_P", deductions)
        self.assertEqual(data["tax"][0]["code"], "PPH21")
        self.assertEqual([item["code"] for item in data["info"]], ["PPH_BRUTO", "PPH_IURAN"])
        net_line = self.slip_a.line_ids.filtered(lambda line: line.code == "NET").total
        self.assertEqual(data["net"], net_line)
        # penghasilan + potongan (termasuk pajak) = gaji bersih; iuran perusahaan tidak mengurangi gaji bersih
        self.assertAlmostEqual(data["total_earnings"] + data["total_deductions"], data["net"], places=2)
        self.assertEqual(data["ytd"]["pph21"], -data["tax"][0]["amount"])  # satu slip selesai di tahun ini
        self.assertTrue(data["worked"])

    def test_slip_data_ytd_accumulates_and_employee_reads_own_only(self):
        self.slip_a_nov.with_user(self.manager).action_payslip_done()
        ytd = self.slip_a_nov.with_user(self.officer).kompakapps_slip_data()[0]["ytd"]
        oct_tax = -self.slip_a.line_ids.filtered(lambda line: line.code == "PPH21").total
        nov_tax = -self.slip_a_nov.line_ids.filtered(lambda line: line.code == "PPH21").total
        self.assertAlmostEqual(ytd["pph21"], oct_tax + nov_tax, places=2)
        own = self.slip_a.with_user(self.user_a).kompakapps_slip_data()
        self.assertEqual(own[0]["employee"]["name"], "Ani Slip")
        with self.assertRaises(AccessError):
            self.slip_b.with_user(self.user_a).kompakapps_slip_data()

    def test_refund_slip_data_flips_sign(self):
        self.slip_b.with_user(self.manager).refund_sheet()
        refund = self.slip_b.refunded_id
        data = refund.with_user(self.manager).kompakapps_slip_data()[0]
        self.assertTrue(data["credit_note"])
        original = self.slip_b.with_user(self.manager).kompakapps_slip_data()[0]
        self.assertAlmostEqual(data["net"], -original["net"], places=2)

    # ---------- Email ----------
    def test_email_without_server_reports_clearly_and_logs(self):
        self.env["ir.mail_server"].search([]).write({"active": False})
        [result] = self.slip_a.with_user(self.officer).kompakapps_send_email()
        self.assertFalse(result["ok"])
        self.assertIn("Server email keluar belum diatur", result["message"])
        note = self.slip_a.message_ids.filtered(lambda m: "Kirim email" in (m.body or ""))
        self.assertTrue(note)  # dicatat di chatter, tidak gagal diam

    @staticmethod
    def _fake_send(self, *args, **kwargs):
        self.write({"state": "sent"})  # pengiriman SMTP dimatikan saat uji; tandai terkirim seperti server sungguhan
        return True

    @staticmethod
    def _fake_fail(self, *args, **kwargs):
        self.write({"state": "exception", "failure_reason": "Connection refused"})
        return True

    def test_email_failure_reason_is_reported(self):
        self.env["ir.mail_server"].create({"name": "Uji SMTP", "smtp_host": "smtp.example.test", "smtp_port": 25, "smtp_encryption": "none"})
        with patch.object(MailMail, "_send", self._fake_fail):
            [result] = self.slip_a.with_user(self.officer).kompakapps_send_email()
        self.assertFalse(result["ok"])
        self.assertIn("Connection refused", result["message"])
        self.assertTrue(self.slip_a.message_ids.filtered(lambda m: "Connection refused" in (m.body or "")))

    def test_email_sent_with_server_and_missing_address(self):
        self.env["ir.mail_server"].create({"name": "Uji SMTP", "smtp_host": "smtp.example.test", "smtp_port": 25, "smtp_encryption": "none"})
        with patch.object(MailMail, "_send", self._fake_send):
            [result] = self.slip_a.with_user(self.officer).kompakapps_send_email()
        self.assertTrue(result["ok"], result["message"])
        mail = self.env["mail.mail"].search([("email_to", "=", "ani.slip@example.test")], order="id desc", limit=1)
        self.assertTrue(mail)
        self.assertIn("Gaji bersih", mail.body_html)
        self.assertIn("Ani Slip", mail.body_html)
        self.assertNotIn("Budi", mail.body_html)
        self.assertTrue(self.slip_a.message_ids.filtered(lambda m: "dikirim ke ani.slip@example.test" in (m.body or "")))
        # karyawan tanpa email kerja
        [missing] = self.slip_b.with_user(self.officer).kompakapps_send_email()
        self.assertFalse(missing["ok"])
        self.assertIn("Email kerja", missing["message"])
        # slip belum selesai ditolak, pengguna tanpa hak payroll ditolak
        with self.assertRaises(UserError):
            self.slip_a_nov.with_user(self.officer).kompakapps_send_email()
        with self.assertRaises(AccessError):
            self.slip_a.with_user(self.user_a).kompakapps_send_email()

    def test_batch_send_emails(self):
        self.env["ir.mail_server"].create({"name": "Uji SMTP", "smtp_host": "smtp.example.test", "smtp_port": 25, "smtp_encryption": "none"})
        run = self.env["hr.payslip.run"].create({"name": "Batch Oktober", "date_start": OCT_FROM, "date_end": OCT_TO, "company_id": self.company.id})
        (self.slip_a | self.slip_b).write({"payslip_run_id": run.id})
        with patch.object(MailMail, "_send", self._fake_send):
            result = run.with_user(self.manager).kompakapps_send_emails()
        self.assertEqual(result["sent"], 1)
        self.assertEqual([item["employee"] for item in result["failed"]], ["Budi Slip"])
        with self.assertRaises(AccessError):
            run.with_user(self.officer).kompakapps_send_emails()  # batch hanya Manager
