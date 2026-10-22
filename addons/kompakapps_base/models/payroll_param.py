from odoo import _, api, fields, models
from odoo.exceptions import UserError, ValidationError

# Parameter dan tabel tarif payroll Indonesia (D86, Q59). Semua angka hukum (persentase BPJS, batas upah, PTKP, tarif TER, lapisan Pasal 17, pengali lembur, dan
# sejenisnya) disimpan sebagai DATA bertanggal berlaku, bukan konstanta di kode, supaya petugas payroll bisa memperbaruinya di UI saat ketentuan berubah.
# Nilai yang dipakai untuk sebuah slip adalah yang "Berlaku Mulai"-nya paling akhir tetapi tidak melewati tanggal akhir periode slip.

PARAM_UNITS = [("persen", "Persen"), ("rupiah", "Rupiah"), ("kali", "Kali"), ("angka", "Angka")]
BRACKET_TABLES = [
    ("ter_a", "TER Bulanan Kategori A"),
    ("ter_b", "TER Bulanan Kategori B"),
    ("ter_c", "TER Bulanan Kategori C"),
    ("pasal17", "Tarif Pasal 17 (Tahunan)"),
]


class KompakappsPayrollParameter(models.Model):
    _name = "kompakapps.payroll.parameter"
    _description = "Parameter Payroll Bertanggal Berlaku"
    _order = "code, date_from desc"

    name = fields.Char(string="Nama", required=True)
    code = fields.Char(string="Kode", required=True, index=True, help="Kode dipakai oleh aturan gaji. Jangan diubah untuk parameter bawaan.")
    value = fields.Float(string="Nilai", digits=(16, 4))
    unit = fields.Selection(PARAM_UNITS, string="Satuan", required=True, default="angka")
    date_from = fields.Date(string="Berlaku Mulai", required=True, default=fields.Date.context_today)
    company_id = fields.Many2one("res.company", string="Perusahaan", required=True, default=lambda self: self.env.company)
    source = fields.Char(string="Sumber Hukum")
    note = fields.Text(string="Catatan")

    _unique_version = models.Constraint(
        "UNIQUE(company_id, code, date_from)", "Parameter dengan kode dan tanggal berlaku yang sama sudah ada untuk perusahaan ini."
    )

    @api.model
    def kompakapps_value(self, code, date, company=None):
        """Nilai parameter `code` yang berlaku pada `date`. Menolak dengan pesan jelas bila belum diisi (tidak pernah diam-diam bernilai nol)."""
        company = company or self.env.company
        date = fields.Date.to_date(date) or fields.Date.context_today(self)
        record = self.sudo().search([("code", "=", code), ("company_id", "=", company.id), ("date_from", "<=", date)], order="date_from desc", limit=1)
        if not record:
            raise UserError(
                _(
                    'Parameter payroll "%(code)s" belum diisi untuk %(company)s pada tanggal %(date)s. Isi di Payroll > Setting > Parameter Payroll (atau jalankan Pasang Aturan Indonesia).',
                    code=code,
                    company=company.name,
                    date=date,
                )
            )
        return record.value

    @api.constrains("value", "unit")
    def _check_percent(self):
        for record in self:
            if record.unit == "persen" and record.value < 0:
                raise ValidationError(_("Persentase tidak boleh negatif."))


class KompakappsPayrollBracket(models.Model):
    _name = "kompakapps.payroll.bracket"
    _description = "Baris Tabel Tarif Payroll (TER dan Pasal 17)"
    _order = "table, date_from desc, lower"

    table = fields.Selection(BRACKET_TABLES, string="Tabel", required=True, index=True)
    date_from = fields.Date(string="Berlaku Mulai", required=True, default=fields.Date.context_today)
    company_id = fields.Many2one("res.company", string="Perusahaan", required=True, default=lambda self: self.env.company)
    lower = fields.Float(string="Di Atas (Rp)", digits=(16, 2), help="Batas bawah (tidak termasuk).")
    upper = fields.Float(string="Sampai Dengan (Rp)", digits=(16, 2), help="Batas atas (termasuk). 0 = tanpa batas atas.")
    rate = fields.Float(string="Tarif (%)", digits=(16, 4))
    source = fields.Char(string="Sumber Hukum")

    @api.constrains("lower", "upper", "rate")
    def _check_bracket(self):
        for record in self:
            if record.lower < 0 or record.rate < 0:
                raise ValidationError(_("Batas bawah dan tarif tidak boleh negatif."))
            if record.upper and record.upper <= record.lower:
                raise ValidationError(_("Batas atas harus lebih besar dari batas bawah (atau 0 untuk tanpa batas)."))

    @api.model
    def kompakapps_rows(self, table, date, company=None):
        """Baris tabel `table` pada versi yang berlaku di `date`, urut dari batas terendah."""
        company = company or self.env.company
        date = fields.Date.to_date(date) or fields.Date.context_today(self)
        latest = self.sudo().search([("table", "=", table), ("company_id", "=", company.id), ("date_from", "<=", date)], order="date_from desc", limit=1)
        if not latest:
            label = dict(BRACKET_TABLES).get(table, table)
            raise UserError(
                _(
                    'Tabel tarif "%(table)s" belum diisi untuk %(company)s pada tanggal %(date)s. Isi di Payroll > Setting > Tabel Tarif Pajak (atau jalankan Pasang Aturan Indonesia).',
                    table=label,
                    company=company.name,
                    date=date,
                )
            )
        rows = self.sudo().search([("table", "=", table), ("company_id", "=", company.id), ("date_from", "=", latest.date_from)])
        return rows.sorted(key=lambda row: (row.upper or float("inf"), row.lower))

    @api.model
    def kompakapps_ter_rate(self, table, amount, date, company=None):
        """Tarif efektif (persen) untuk penghasilan bruto sebulan `amount`: baris pertama yang batas atasnya tidak kurang dari `amount`."""
        for row in self.kompakapps_rows(table, date, company):
            if not row.upper or amount <= row.upper:
                return row.rate
        return 0.0

    @api.model
    def kompakapps_progressive_tax(self, table, taxable, date, company=None):
        """Pajak berlapis (Pasal 17) atas penghasilan kena pajak setahun `taxable`: tiap lapisan dikenai tarifnya pada bagian yang jatuh di lapisan itu."""
        total = 0.0
        for row in self.kompakapps_rows(table, date, company):
            top = row.upper or float("inf")
            slice_amount = min(taxable, top) - row.lower
            if slice_amount > 0:
                total += slice_amount * row.rate / 100.0
        return total

    @api.model
    def kompakapps_clone_version(self, table, date_from, new_date_from, company=None):
        """Salin satu versi tabel ke tanggal berlaku baru supaya bisa disunting tanpa mengubah versi lama. Mengembalikan jumlah baris yang disalin."""
        company = company or self.env.company
        date_from, new_date_from = fields.Date.to_date(date_from), fields.Date.to_date(new_date_from)
        if not self.env.su and not self.env.user.has_group("payroll.group_payroll_manager"):
            raise UserError(_("Hanya Manager payroll yang boleh menyalin tabel tarif."))
        rows = self.search([("table", "=", table), ("company_id", "=", company.id), ("date_from", "=", date_from)])
        if not rows:
            raise UserError(_("Versi tabel yang akan disalin tidak ditemukan."))
        if self.search_count([("table", "=", table), ("company_id", "=", company.id), ("date_from", "=", new_date_from)]):
            raise UserError(_("Sudah ada versi tabel untuk tanggal berlaku tersebut."))
        for row in rows:
            row.copy({"date_from": new_date_from})
        return len(rows)
