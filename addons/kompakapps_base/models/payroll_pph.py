from collections import defaultdict

from odoo import _, fields, models
from odoo.exceptions import UserError
from odoo.tools import float_round

TER_TABLE = {"A": "ter_a", "B": "ter_b", "C": "ter_c"}


def _rupiah(amount):
    return float_round(amount, precision_digits=0)


def _fmt(amount):
    return f"{amount:,.0f}".replace(",", ".")


class HrPayslipPph(models.Model):
    """PPh 21 untuk pegawai tetap (D86, Q59): TER bulanan (PP 58/2023, PMK 168/2023) pada setiap masa pajak selain yang terakhir, dan pada masa pajak terakhir
    (Desember atau bulan karyawan berhenti bekerja) penghitungan setahun dengan tarif Pasal 17 dikurangi pajak yang sudah dipotong. Semua angka (PTKP, biaya
    jabatan, tabel TER, lapisan Pasal 17, tambahan tanpa NPWP) dibaca dari parameter bertanggal berlaku."""

    _inherit = "hr.payslip"

    def _kompakapps_param(self, code):
        return self.env["kompakapps.payroll.parameter"].kompakapps_value(code, self.date_to, self.company_id)

    def _kompakapps_input(self, code):
        line = self.input_line_ids.filtered(lambda item: item.code == code)[:1]
        return line.amount if line else 0.0

    def _kompakapps_pph21_history(self):
        """Penghasilan bruto, iuran, pajak yang sudah dipotong, dan jumlah bulan dari slip selesai karyawan pada tahun pajak yang sama sebelum periode slip ini
        (slip koreksi mengurangi), ditambah saldo awal yang diisi petugas di input slip bila sistem baru dipakai di tengah tahun."""
        self.ensure_one()
        year_start = fields.Date.to_date(f"{self.date_to.year}-01-01")
        lines = (
            self.env["hr.payslip.line"]
            .sudo()
            .search(
                [
                    ("slip_id.employee_id", "=", self.employee_id.id),
                    ("slip_id.state", "=", "done"),
                    ("slip_id.date_from", ">=", year_start),
                    ("slip_id.date_to", "<", self.date_from),
                    ("code", "in", ["PPH_BRUTO", "PPH_IURAN", "PPH21"]),
                ]
            )
        )
        totals = defaultdict(float)
        for line in lines:
            totals[line.code] += (-1 if line.slip_id.credit_note else 1) * line.total
        slips = lines.slip_id
        months = len(slips.filtered(lambda slip: not slip.credit_note) - slips.filtered("credit_note").refunded_id)
        return {
            "bruto": totals["PPH_BRUTO"] + self._kompakapps_input("PPH_AWAL_BRUTO"),
            "iuran": totals["PPH_IURAN"] + self._kompakapps_input("PPH_AWAL_IURAN"),
            "pajak": -totals["PPH21"] + self._kompakapps_input("PPH_AWAL_PAJAK"),
            "months": months + int(self._kompakapps_input("PPH_AWAL_BULAN")),
        }

    def _kompakapps_pph21_factor(self):
        """Pengali pajak: 1, atau 1 + tambahan (20%) bila karyawan tidak punya NPWP maupun NIK."""
        employee = self.employee_id
        if employee.kompakapps_npwp or employee.kompakapps_nik:
            return 1.0
        return 1.0 + self._kompakapps_param("pph21_tanpa_npwp_tambahan") / 100.0

    def _kompakapps_ptkp(self):
        status = self.employee_id.kompakapps_ptkp_status
        if not status:
            raise UserError(_("Status PTKP %(employee)s belum diisi. Isi di Employees.", employee=self.employee_id.name))
        married = 1 if status.startswith("K") else 0
        return self._kompakapps_param("ptkp_dasar") + married * self._kompakapps_param("ptkp_kawin") + int(status[-1]) * self._kompakapps_param("ptkp_tanggungan")

    def kompakapps_pph21(self, bruto, iuran, history=None):
        """Hitung PPh 21 slip ini. `bruto` = penghasilan bruto kena pajak bulan ini (termasuk iuran JKK, JKM, Kesehatan perusahaan dan tunjangan pajak), `iuran`
        = iuran JHT dan JP karyawan bulan ini. Mengembalikan {"amount": pajak yang dipotong (negatif = kelebihan yang dikembalikan), "label": uraian}."""
        self.ensure_one()
        factor = self._kompakapps_pph21_factor()
        last_period = self.date_to.month == 12 or self._kompakapps_input("PPH_AKHIR") > 0
        if not last_period:
            category = self.employee_id.kompakapps_ter_category
            if not category:
                raise UserError(_("Status PTKP %(employee)s belum diisi. Isi di Employees.", employee=self.employee_id.name))
            rate = self.env["kompakapps.payroll.bracket"].kompakapps_ter_rate(TER_TABLE[category], max(bruto, 0.0), self.date_to, self.company_id)
            amount = _rupiah(max(bruto, 0.0) * rate / 100.0 * factor)
            label = _("PPh 21 TER kategori %(category)s %(rate)s%% dari Rp%(bruto)s", category=category, rate=f"{rate:g}".replace(".", ","), bruto=_fmt(bruto))
            return {"amount": amount, "label": label}
        history = history or self._kompakapps_pph21_history()
        gross_year = history["bruto"] + bruto
        months = history["months"] + 1
        position = min(
            gross_year * self._kompakapps_param("pph21_biaya_jabatan_persen") / 100.0,
            self._kompakapps_param("pph21_biaya_jabatan_maks_tahun"),
            months * self._kompakapps_param("pph21_biaya_jabatan_maks_bulan"),
        )
        net_year = gross_year - position - history["iuran"] - iuran
        step = self._kompakapps_param("pph21_pembulatan_pkp") or 1.0
        taxable = max(0.0, net_year - self._kompakapps_ptkp())
        taxable = taxable - (taxable % step)
        tax_year = _rupiah(self.env["kompakapps.payroll.bracket"].kompakapps_progressive_tax("pasal17", taxable, self.date_to, self.company_id) * factor)
        amount = tax_year - history["pajak"]
        label = _(
            "PPh 21 masa pajak terakhir: pajak setahun Rp%(year)s (PKP Rp%(pkp)s) dikurangi sudah dipotong Rp%(done)s dari %(months)s bulan",
            year=_fmt(tax_year),
            pkp=_fmt(taxable),
            done=_fmt(history["pajak"]),
            months=months,
        )
        return {"amount": amount, "label": label}

    def kompakapps_pph21_grossup(self, bruto, iuran):
        """Tunjangan PPh 21 untuk karyawan yang pajaknya ditanggung perusahaan: nilai T sehingga pajak atas (bruto + T) sama dengan T. Pajak tidak menurun bila T
        naik, jadi iterasi dari nol naik terus sampai tetap (bilangan bulat rupiah)."""
        self.ensure_one()
        history = self._kompakapps_pph21_history() if (self.date_to.month == 12 or self._kompakapps_input("PPH_AKHIR") > 0) else None
        tunjangan = 0.0
        for _step in range(200):
            tax = max(0.0, self.kompakapps_pph21(bruto + tunjangan, iuran, history)["amount"])
            if tax == tunjangan:
                return tunjangan
            tunjangan = tax
        raise UserError(_("Tunjangan PPh 21 tidak konvergen untuk %(employee)s.", employee=self.employee_id.name))
