import datetime as dt
from collections import defaultdict

from pytz import timezone, utc

from odoo import Command, _, api, fields, models
from odoo.tools import float_round

# Baris hari kerja dari kehadiran dan cuti (D86, Q59). Dimuat ulang setiap kali slip Gaji Indonesia dihitung; koreksi lewat input slip atau lewat data sumber.
ATT_CODES = ("JADWAL", "HADIR", "ABSEN", "CUTI_TDK_DIBAYAR", "TERLAMBAT", "LEMBUR_JAM", "LEMBUR_SETARA")


def _days(first, last):
    day = first
    while day <= last:
        yield day
        day += dt.timedelta(days=1)


class HrVersionPayroll(models.Model):
    _inherit = "hr.version"

    kompakapps_allow_transport = fields.Float(string="Tunjangan Transport Tetap (per bulan)", groups="hr.group_hr_user", help="Tunjangan tetap bulanan; ikut dasar BPJS, lembur, dan THR.")
    kompakapps_allow_meal = fields.Float(string="Tunjangan Makan Tetap (per bulan)", groups="hr.group_hr_user", help="Tunjangan tetap bulanan; ikut dasar BPJS, lembur, dan THR.")
    kompakapps_allow_daily = fields.Float(string="Tunjangan Harian (per hari hadir)", groups="hr.group_hr_user", help="Dikali jumlah hari hadir pada periode slip; tunjangan tidak tetap (tidak ikut dasar BPJS dan THR).")

    @api.model
    def _get_whitelist_fields_from_template(self):
        whitelist = super()._get_whitelist_fields_from_template()
        for name in ("kompakapps_allow_transport", "kompakapps_allow_meal", "kompakapps_allow_daily"):
            if name not in whitelist:
                whitelist.append(name)
        return whitelist


class HrPayslipComponents(models.Model):
    _inherit = "hr.payslip"

    @api.model
    def get_worked_day_lines(self, contracts, date_from, date_to):
        lines = list(super().get_worked_day_lines(contracts, date_from, date_to))
        for contract in contracts.filtered("resource_calendar_id"):
            lines.extend(self._kompakapps_attendance_lines(contract, date_from, date_to))
        return lines

    def compute_sheet(self):
        for slip in self.filtered(lambda s: s.state in ("draft", "verify") and s.contract_id and s.struct_id):
            codes = slip.struct_id.get_structure_with_parents().get_all_rules().mapped("code")
            if "POT_ABSEN" in codes or "LEMBUR" in codes:
                lines = self._kompakapps_attendance_lines(slip.contract_id, slip.date_from, slip.date_to)
                slip.worked_days_line_ids.filtered(lambda line: line.code in ATT_CODES).unlink()
                slip.write({"worked_days_line_ids": [Command.create(line) for line in lines]})
        return super().compute_sheet()

    @api.model
    def _kompakapps_attendance_lines(self, contract, date_from, date_to):
        """Hari kerja terjadwal, hadir, absen tanpa keterangan, cuti tidak dibayar, keterlambatan, dan jam lembur (setara upah sejam) dari kalender kerja, cuti
        disetujui, dan kehadiran. Lembur memakai jam yang sudah divalidasi (`validated_overtime_hours`) dan pengali PP 35/2021 Pasal 31 dari parameter."""
        employee, calendar = contract.employee_id, contract.resource_calendar_id
        company = contract.company_id or employee.company_id
        Param = self.env["kompakapps.payroll.parameter"]
        if not Param.sudo().search_count([("company_id", "=", company.id), ("code", "=", "lembur_pembagi")], limit=1):
            return []  # aturan Indonesia belum dipasang untuk perusahaan ini (struktur gaji lain tidak terganggu)

        def param(code):
            return Param.kompakapps_value(code, date_to, company)

        tz = timezone(calendar.tz or employee.tz or "UTC")
        start_hour = {}
        for row in calendar.attendance_ids.filtered(lambda a: not a.display_type):
            weekday = int(row.dayofweek)
            start_hour[weekday] = min(row.hour_from, start_hour.get(weekday, 24.0))
        holidays = set()
        for leave in calendar.global_leave_ids.filtered(lambda item: not item.resource_id):
            holidays.update(_days(utc.localize(leave.date_from).astimezone(tz).date(), utc.localize(leave.date_to).astimezone(tz).date()))
        period_days = [day for day in _days(date_from, date_to) if day.weekday() in start_hour and day not in holidays]
        first, last = max(date_from, contract.contract_date_start or date_from), min(date_to, contract.contract_date_end or date_to)
        scheduled = [day for day in period_days if first <= day <= last]
        scheduled_set = set(scheduled)

        paid, unpaid = {}, {}
        leaves = self.env["hr.leave"].sudo().search([("employee_id", "=", employee.id), ("state", "=", "validate"), ("request_date_from", "<=", last), ("request_date_to", ">=", first)])
        for leave in leaves:
            weight = leave.number_of_days if leave.request_date_from == leave.request_date_to and leave.number_of_days < 1 else 1.0
            target = unpaid if leave.holiday_status_id.unpaid else paid
            for day in _days(max(leave.request_date_from, first), min(leave.request_date_to, last)):
                if day in scheduled_set:
                    target[day] = max(target.get(day, 0.0), weight)

        low = tz.localize(dt.datetime.combine(date_from, dt.time.min)).astimezone(utc).replace(tzinfo=None)
        high = tz.localize(dt.datetime.combine(date_to + dt.timedelta(days=1), dt.time.min)).astimezone(utc).replace(tzinfo=None)
        attendances = self.env["hr.attendance"].sudo().search([("employee_id", "=", employee.id), ("check_in", ">=", low), ("check_in", "<", high)])
        present, first_in, overtime = set(), {}, defaultdict(float)
        for attendance in attendances:
            local = utc.localize(attendance.check_in).astimezone(tz)
            day = local.date()
            present.add(day)
            first_in[day] = min(first_in.get(day, 24.0), local.hour + local.minute / 60.0)
            overtime[day] += attendance.validated_overtime_hours

        hadir = len([day for day in scheduled if day in present])
        unpaid_days = sum(unpaid.get(day, 0.0) for day in scheduled)
        absent = 0.0
        if present:  # tanpa data kehadiran sama sekali, absen tidak dihitung (perusahaan yang tidak memakai Attendance tidak terpotong)
            absent = sum(max(0.0, 1.0 - paid.get(day, 0.0) - unpaid.get(day, 0.0)) for day in scheduled if day not in present)
        tolerance = param("terlambat_toleransi_menit")
        late_count, late_minutes = 0, 0.0
        for day in scheduled:
            if day in first_in:
                delta = (first_in[day] - start_hour[day.weekday()]) * 60.0 - tolerance
                if delta > 0:
                    late_count += 1
                    late_minutes += delta
        five_day = len(start_hour) <= 5
        total_hours = equivalent = 0.0
        for day, hours in overtime.items():
            if hours <= 0:
                continue
            total_hours += hours
            if day in period_days:  # hari kerja: jam pertama 1,5x, berikutnya 2x
                equivalent += min(hours, 1.0) * param("lembur_hk_jam_pertama") + max(hours - 1.0, 0.0) * param("lembur_hk_jam_berikutnya")
            else:  # hari istirahat mingguan atau libur resmi: 2x, lalu 3x satu jam, lalu 4x
                limit = param("lembur_libur_jam_x1_5hari" if five_day else "lembur_libur_jam_x1_6hari")
                equivalent += (
                    min(hours, limit) * param("lembur_libur_x1")
                    + min(max(hours - limit, 0.0), 1.0) * param("lembur_libur_x2")
                    + max(hours - limit - 1.0, 0.0) * param("lembur_libur_x3")
                )

        def line(code, name, days=0.0, hours=0.0):
            return {"name": name, "sequence": 20, "code": code, "number_of_days": days, "number_of_hours": hours, "contract_id": contract.id}

        return [
            line("JADWAL", _("Hari kerja terjadwal (tanpa libur umum)"), len(period_days)),
            line("HADIR", _("Hari hadir"), hadir),
            line("ABSEN", _("Hari absen tanpa keterangan") if present else _("Hari absen (tidak dihitung: belum ada data kehadiran)"), absent),
            line("CUTI_TDK_DIBAYAR", _("Cuti tidak dibayar"), unpaid_days),
            line("TERLAMBAT", _("Keterlambatan (hari; jam = menit/60)"), late_count, late_minutes / 60.0),
            line("LEMBUR_JAM", _("Jam lembur divalidasi"), 0.0, total_hours),
            line("LEMBUR_SETARA", _("Jam lembur setara upah sejam (dengan pengali)"), 0.0, equivalent),
        ]

    def kompakapps_thr(self):
        """THR keagamaan (Permenaker 6/2016, PP 36/2021): masa kerja sampai tanggal akhir slip (= tanggal hari raya yang diisi petugas). Masa kerja 12 bulan
        atau lebih = satu bulan upah; 1 sampai kurang dari 12 bulan = masa kerja/12 x satu bulan upah; kurang dari 1 bulan = tanpa THR. Upah = gaji pokok + tunjangan tetap."""
        self.ensure_one()
        company, date = self.company_id, self.date_to
        Param = self.env["kompakapps.payroll.parameter"]
        starts = [d for d in self.employee_id.version_ids.mapped("contract_date_start") if d]
        start = min(starts) if starts else self.contract_id.contract_date_start
        months = (date.year - start.year) * 12 + date.month - start.month - (1 if date.day < start.day else 0)
        full, minimum = Param.kompakapps_value("thr_masa_kerja_penuh_bulan", date, company), Param.kompakapps_value("thr_masa_kerja_minimum_bulan", date, company)
        portion = 1.0 if months >= full else months / full if months >= minimum else 0.0
        contract = self.contract_id
        wage = contract.wage + contract.kompakapps_allow_transport + contract.kompakapps_allow_meal
        amount = float_round(wage * portion * Param.kompakapps_value("thr_bulan_upah", date, company), precision_digits=0)
        label = _("THR masa kerja %(months)s bulan (%(portion)s bulan upah)", months=months, portion=f"{portion * Param.kompakapps_value('thr_bulan_upah', date, company):.2f}".rstrip("0").rstrip(".").replace(".", ","))
        return {"amount": amount, "label": label}
