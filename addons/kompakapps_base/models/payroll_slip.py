"""Hak akses slip, data slip untuk cetak dan "Slip Saya", dan kirim slip lewat email (D86 irisan 4, Q59).

Pembagian peran: Officer payroll melihat, membuat, dan menghitung slip; hanya Manager payroll yang mengonfirmasi, membatalkan, mengembalikan ke draf,
me-refund, dan membuat jurnal. Karyawan membaca slipnya sendiri yang sudah Selesai (aturan record di security/payroll_security.xml).
"""

from collections import defaultdict

from markupsafe import Markup, escape

from odoo import _, api, fields, models, tools
from odoo.exceptions import AccessError, UserError

# Kategori aturan menurut kelompok tampil di slip. Kategori lain mengikuti tanda jumlahnya (positif penghasilan, negatif potongan).
EARNING_CATEGORIES = {"BASIC", "ALW", "VAR"}
DEDUCTION_CATEGORIES = {"DED", "POT", "BPJSK"}
TAX_CATEGORIES = {"PAJAK"}
EMPLOYER_CATEGORIES = {"BPJSPT", "BPJSPN"}
INFO_CATEGORIES = {"INFO"}
WORKED_LABELS = {"WORK100": "Hari kerja normal (dibayar 100%)", "GLOBAL": "Libur umum"}


def rupiah(amount):
    """Format rupiah Indonesia: Rp1.234.567 (negatif dengan tanda minus)."""
    value = int(round(amount or 0))
    text = f"{abs(value):,}".replace(",", ".")
    return f"-Rp{text}" if value < 0 else f"Rp{text}"


class HrPayslipAccess(models.Model):
    _inherit = "hr.payslip"

    # ---------- Hak akses: tindakan Manager ----------

    def _kompakapps_require_manager(self, action):
        if not self.env.su and not self.env.user.has_group("payroll.group_payroll_manager"):
            raise AccessError(_("Hanya Manager payroll yang boleh %(action)s slip gaji.", action=action))

    def action_payslip_done(self):
        self._kompakapps_require_manager(_("mengonfirmasi"))
        return super().action_payslip_done()

    def action_payslip_cancel(self):
        self._kompakapps_require_manager(_("membatalkan"))
        return super().action_payslip_cancel()

    def action_payslip_draft(self):
        self._kompakapps_require_manager(_("mengembalikan ke draf"))
        return super().action_payslip_draft()

    def refund_sheet(self):
        self._kompakapps_require_manager(_("me-refund"))
        return super().refund_sheet()

    def kompakapps_post_journal(self):
        self._kompakapps_require_manager(_("membuat jurnal untuk"))
        return super().kompakapps_post_journal()

    # ---------- Data slip (cetak final dan Slip Saya) ----------

    @api.model
    def kompakapps_my_employee(self):
        """Karyawan yang tertaut ke pengguna ini (untuk halaman Slip Saya): {"id", "name"} atau False bila pengguna belum ditautkan ke karyawan."""
        employee = self.env["hr.employee"].sudo().search([("user_id", "=", self.env.uid)], limit=1)
        return {"id": employee.id, "name": employee.name} if employee else False

    def kompakapps_slip_data(self):
        """Isi slip lengkap untuk dicetak atau ditampilkan: kepala (karyawan, periode, perusahaan), baris dikelompokkan menurut kategori (penghasilan,
        potongan, pajak, iuran perusahaan, informasi pajak), hari kerja, total, gaji bersih, dan PPh 21 sejak awal tahun. Hak baca diperiksa lebih dulu
        dengan hak pengguna (ACL dan aturan record), baru dibaca penuh: karyawan hanya mendapat slipnya sendiri yang Selesai, petugas payroll semua slip."""
        self.check_access("read")
        return [slip._kompakapps_slip_dict() for slip in self]

    def _kompakapps_slip_dict(self):
        self.ensure_one()
        slip = self.sudo()
        sign = -1 if slip.credit_note else 1
        employee = slip.employee_id
        groups = defaultdict(list)
        net_line = None
        for line in slip.line_ids.sorted(lambda item: (item.sequence, item.id)):
            code = line.category_id.code or ""
            total = sign * line.total
            if code == "NET":
                net_line = total
                continue
            if not line.appears_on_payslip:
                continue
            if code in INFO_CATEGORIES:
                kind = "info"
            elif code in EMPLOYER_CATEGORIES:
                kind = "employer"
            elif code in TAX_CATEGORIES:
                kind = "tax"
            elif code in DEDUCTION_CATEGORIES:
                kind = "deductions"
            elif code in EARNING_CATEGORIES:
                kind = "earnings"
            else:
                kind = "earnings" if total >= 0 else "deductions"
            if not total and code != "BASIC" and kind != "info":
                continue  # komponen bernilai nol (mis. potongan lain kosong) tidak dicetak
            groups[kind].append({"code": line.code or "", "name": line.name, "amount": total})
        total_earnings = sum(item["amount"] for item in groups["earnings"])
        total_deductions = sum(item["amount"] for item in groups["deductions"]) + sum(item["amount"] for item in groups["tax"])
        net = net_line if net_line is not None else total_earnings + total_deductions
        history = self.env["hr.payslip.line"].sudo().search(
            [
                ("slip_id.employee_id", "=", employee.id),
                ("slip_id.state", "=", "done"),
                ("slip_id.date_to", ">=", f"{slip.date_to.year}-01-01"),
                ("slip_id.date_to", "<=", slip.date_to),
                ("code", "in", ["PPH_BRUTO", "PPH21"]),
            ]
        )
        ytd = defaultdict(float)
        for line in history:
            ytd[line.code] += (-1 if line.slip_id.credit_note else 1) * line.total
        if slip.state != "done":  # pratinjau slip yang belum selesai: ikutkan slip ini
            for line in slip.line_ids.filtered(lambda item: item.code in ("PPH_BRUTO", "PPH21")):
                ytd[line.code] += sign * line.total
        has_tax = any(item["code"] == "PPH21" for item in groups["tax"]) or bool(ytd["PPH21"])
        return {
            "id": slip.id,
            "number": slip.number or "",
            "name": slip.name or "",
            "state": slip.state,
            "credit_note": slip.credit_note,
            "date_from": fields.Date.to_string(slip.date_from),
            "date_to": fields.Date.to_string(slip.date_to),
            "structure": slip.struct_id.name or "",
            "note": slip.note or "",
            "company": {"name": slip.company_id.name or ""},
            "employee": {
                "id": employee.id,
                "name": employee.name or "",
                "job": employee.job_title or employee.job_id.name or "",
                "department": employee.department_id.name or "",
                "npwp": employee.kompakapps_npwp or employee.kompakapps_nik or "",
                "ptkp": employee.kompakapps_ptkp_status or "",
            },
            "earnings": groups["earnings"],
            "deductions": groups["deductions"],
            "tax": groups["tax"],
            "employer": groups["employer"],
            "info": groups["info"],
            "worked": [
                {"code": day.code or "", "name": WORKED_LABELS.get(day.code, day.name), "days": day.number_of_days, "hours": day.number_of_hours}
                for day in slip.worked_days_line_ids.sorted(lambda item: (item.sequence, item.id))
            ],
            "total_earnings": total_earnings,
            "total_deductions": total_deductions,
            "net": net,
            "ytd": {"bruto": ytd["PPH_BRUTO"], "pph21": -ytd["PPH21"]} if has_tax else None,
        }

    # ---------- Kirim slip lewat email ----------

    @api.model
    def _kompakapps_mail_ready(self):
        """Server email keluar sudah diatur: ada server aktif di Pengaturan, atau konfigurasi server Odoo menunjuk host SMTP selain localhost."""
        if self.env["ir.mail_server"].sudo().search_count([("active", "=", True)]):
            return True
        host = tools.config.get("smtp_server")
        return bool(host) and host not in ("localhost", "127.0.0.1")

    def _kompakapps_slip_email_html(self, data):
        def row(label, amount, strong=False):
            style = "font-weight:bold;" if strong else ""
            return (
                f'<tr><td style="padding:3px 12px 3px 0;{style}">{escape(label)}</td>'
                f'<td style="padding:3px 0;text-align:right;white-space:nowrap;{style}">{escape(rupiah(amount))}</td></tr>'
            )

        def block(title, items, total=None, total_label=None):
            if not items:
                return ""
            rows = "".join(row(item["name"], item["amount"]) for item in items)
            if total is not None:
                rows += row(total_label, total, strong=True)
            return f'<p style="margin:14px 0 4px;font-weight:bold;">{escape(title)}</p><table style="border-collapse:collapse;min-width:360px;">{rows}</table>'

        employee, period = data["employee"], f"{data['date_from']} s/d {data['date_to']}"
        html = (
            f'<div style="font-size:13px;color:#111;">'
            f"<p>Yth. {escape(employee['name'])},</p>"
            f"<p>Berikut rincian slip gaji Anda dari {escape(data['company']['name'])} untuk periode {escape(period)}"
            f"{' (slip koreksi)' if data['credit_note'] else ''}.</p>"
            f"{block('Penghasilan', data['earnings'], data['total_earnings'], 'Total penghasilan')}"
            f"{block('Potongan', data['deductions'] + data['tax'], data['total_deductions'], 'Total potongan')}"
            f'<p style="margin:14px 0 4px;font-size:15px;font-weight:bold;">Gaji bersih: {escape(rupiah(data["net"]))}</p>'
        )
        if data["ytd"]:
            html += f"<p>PPh 21 yang sudah dipotong sejak awal tahun sampai periode ini: {escape(rupiah(data['ytd']['pph21']))}.</p>"
        html += (
            '<p style="color:#555;font-size:12px;margin-top:18px;">Email ini berisi data gaji yang bersifat rahasia. '
            "Bila ada yang tidak sesuai, hubungi bagian payroll. Slip yang dapat dicetak tersedia di halaman Slip Saya.</p></div>"
        )
        return Markup(html)

    def kompakapps_send_email(self):
        """Kirim slip Selesai ke email kerja karyawan (isi HTML, tanpa lampiran) dan catat hasilnya di chatter slip. Tidak pernah gagal diam-diam: tiap slip
        mengembalikan {"id", "employee", "ok", "message"}. Gagal karena email kerja kosong atau server email keluar belum diatur dicatat sebagai catatan
        di chatter dan dikembalikan sebagai ok=False dengan pesan yang bisa ditampilkan. Slip yang belum Selesai ditolak. Untuk petugas payroll."""
        if not self.env.su and not self.env.user.has_group("payroll.group_payroll_user"):
            raise AccessError(_("Hanya petugas payroll yang boleh mengirim slip lewat email."))
        self.check_access("read")
        results = []
        for slip in self:
            if slip.state != "done":
                raise UserError(_("Slip %(slip)s belum selesai. Hanya slip yang sudah dikonfirmasi yang dikirim.", slip=slip.number or slip.name))
            results.append(slip._kompakapps_send_one())
        return results

    def _kompakapps_send_one(self):
        self.ensure_one()
        employee = self.employee_id.sudo()
        address = (employee.work_email or "").strip()
        title = self.number or self.name
        if not address:
            ok, message = False, _("Email kerja karyawan %(employee)s belum diisi.", employee=employee.name)
        elif not self._kompakapps_mail_ready():
            ok, message = False, _("Server email keluar belum diatur (Pengaturan > Email keluar). Slip belum terkirim.")
        else:
            data = self._kompakapps_slip_dict()
            mail = self.env["mail.mail"].sudo().create(
                {
                    "subject": _("Slip gaji %(period)s - %(company)s", period=f"{data['date_from']} s/d {data['date_to']}", company=data["company"]["name"]),
                    "body_html": self._kompakapps_slip_email_html(data),
                    "email_to": address,
                    "email_from": self.env.user.email_formatted or self.company_id.email_formatted or False,
                    "auto_delete": False,
                }
            )
            mail.send(raise_exception=False)
            if mail.state == "sent":
                ok, message = True, _("Slip %(slip)s dikirim ke %(address)s.", slip=title, address=address)
            elif mail.state == "outgoing":  # belum diproses server (mis. antre); bukan galat
                ok, message = True, _("Slip %(slip)s masuk antrean pengiriman ke %(address)s.", slip=title, address=address)
            else:
                ok = False
                message = _("Slip %(slip)s gagal dikirim ke %(address)s: %(reason)s", slip=title, address=address, reason=mail.failure_reason or _("sebab tidak diketahui"))
        self.sudo().message_post(
            body=escape(_("Kirim email: %(message)s", message=message)),
            message_type="comment",
            subtype_xmlid="mail.mt_note",
        )
        return {"id": self.id, "employee": employee.name, "ok": ok, "message": message}


class HrPayslipRunMail(models.Model):
    _inherit = "hr.payslip.run"

    def kompakapps_send_emails(self):
        """Kirim semua slip Selesai di batch (bukan slip koreksi yang dibatalkan). Mengembalikan {"sent": n, "failed": [{"employee", "message"}], "skipped": n
        slip yang belum selesai}."""
        self.ensure_one()
        slips = self.slip_ids.filtered(lambda s: s.state == "done")
        results = slips.kompakapps_send_email() if slips else []
        return {
            "sent": sum(1 for r in results if r["ok"]),
            "failed": [{"employee": r["employee"], "message": r["message"]} for r in results if not r["ok"]],
            "skipped": len(self.slip_ids.filtered(lambda s: s.state in ("draft", "verify"))),
        }
