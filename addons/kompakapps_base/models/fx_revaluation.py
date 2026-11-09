"""Revaluasi mata uang (Q80, D105): selisih kurs yang belum terealisasi pada piutang, hutang, dan kas bank dalam mata uang asing.

Odoo Community mencatat selisih kurs yang SUDAH terealisasi (saat faktur dan pembayaran dalam mata uang asing direkonsiliasi, ke jurnal Exchange Difference).
Saldo yang masih terbuka pada akhir periode tetap dinilai pada kurs saat transaksi, padahal kurs sudah bergerak. Revaluasi menilainya kembali pada kurs
tanggal laporan dan menjurnal selisihnya (Dr atau Cr akun piutang, hutang, atau bank; lawannya akun untung atau rugi selisih kurs belum terealisasi), lalu
membalik jurnal itu otomatis pada tanggal berikutnya supaya penilaian bulan depan selalu mulai dari nilai buku aslinya.

Baris jurnal revaluasi memakai mata uang asing dengan amount_currency nol, seperti jurnal selisih kurs bawaan Odoo: nilai dalam mata uang asing tidak berubah,
hanya nilai dalam rupiah. Saldo piutang dan hutang dihitung per tanggal laporan (pelunasan sebagian yang terjadi setelah tanggal itu dikembalikan).
"""

from collections import defaultdict
from datetime import timedelta

from odoo import Command, _, api, fields, models
from odoo.exceptions import UserError, ValidationError

STATES = [("draft", "Draft"), ("posted", "Diposting"), ("cancel", "Dibatalkan")]
KINDS = [("receivable", "Piutang"), ("payable", "Hutang"), ("liquidity", "Kas dan Bank")]
GAIN_CODE, LOSS_CODE = "81100031", "91100021"


class KompakappsFxRevaluation(models.Model):
    _name = "kompakapps.fx.revaluation"
    _description = "Revaluasi Mata Uang"
    _inherit = ["mail.thread"]
    _order = "date desc, id desc"

    name = fields.Char("Nomor", default="Baru", readonly=True, copy=False)
    company_id = fields.Many2one("res.company", string="Perusahaan", required=True, default=lambda self: self.env.company, ondelete="cascade", index=True)
    currency_id = fields.Many2one(related="company_id.currency_id", string="Mata Uang Perusahaan")
    date = fields.Date("Tanggal Revaluasi", required=True, default=lambda self: fields.Date.context_today(self), tracking=True)
    reverse_date = fields.Date("Tanggal Pembalik", compute="_compute_reverse_date", store=True, readonly=False)
    journal_id = fields.Many2one("account.journal", string="Jurnal", domain="[('type', '=', 'general'), ('company_id', '=', company_id)]")
    gain_account_id = fields.Many2one("account.account", string="Akun Untung Kurs Belum Terealisasi", check_company=True)
    loss_account_id = fields.Many2one("account.account", string="Akun Rugi Kurs Belum Terealisasi", check_company=True)
    state = fields.Selection(STATES, default="draft", required=True, tracking=True, copy=False)
    line_ids = fields.One2many("kompakapps.fx.revaluation.line", "revaluation_id", string="Baris", copy=False)
    move_id = fields.Many2one("account.move", string="Jurnal Revaluasi", readonly=True, copy=False)
    reverse_move_id = fields.Many2one("account.move", string="Jurnal Pembalik", readonly=True, copy=False)
    total_gain = fields.Monetary("Keuntungan", compute="_compute_totals", store=True, currency_field="currency_id")
    total_loss = fields.Monetary("Kerugian", compute="_compute_totals", store=True, currency_field="currency_id")
    total_net = fields.Monetary("Bersih", compute="_compute_totals", store=True, currency_field="currency_id")
    note = fields.Text("Catatan")

    @api.depends("date")
    def _compute_reverse_date(self):
        for revaluation in self:
            revaluation.reverse_date = revaluation.date + timedelta(days=1) if revaluation.date else False

    @api.depends("line_ids.adjustment")
    def _compute_totals(self):
        for revaluation in self:
            gain = sum(line.adjustment for line in revaluation.line_ids if line.adjustment > 0)
            loss = -sum(line.adjustment for line in revaluation.line_ids if line.adjustment < 0)
            revaluation.total_gain, revaluation.total_loss, revaluation.total_net = gain, loss, gain - loss

    @api.constrains("date", "state", "company_id")
    def _check_one_posted_per_date(self):
        for revaluation in self.filtered(lambda rec: rec.state == "posted"):
            other = self.search([("id", "!=", revaluation.id), ("company_id", "=", revaluation.company_id.id), ("state", "=", "posted"), ("date", "=", revaluation.date)], limit=1)
            if other:
                raise ValidationError(_("Revaluasi per %(date)s sudah diposting (%(name)s). Batalkan lebih dulu bila ingin membuat ulang.", date=revaluation.date, name=other.name))

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if vals.get("name", "Baru") == "Baru":
                vals["name"] = self.env["ir.sequence"].next_by_code("kompakapps.fx.revaluation") or "Baru"
        records = super().create(vals_list)
        for record in records:
            record._ensure_defaults()
        return records

    def _ensure_defaults(self):
        """Jurnal umum dan akun untung dan rugi kurs belum terealisasi (dibuat bila perusahaan belum punya)."""
        self.ensure_one()
        company = self.company_id
        Account = self.env["account.account"].sudo().with_company(company)
        values = {}
        if not self.journal_id:
            Journal = self.env["account.journal"]
            general = [("company_id", "=", company.id), ("type", "=", "general")]
            journal = Journal.search([*general, ("code", "=", "MISC")], limit=1) or Journal.search([*general, ("code", "not in", ("CABA", "EXCH", "STJ", "COGM"))], order="code", limit=1) or Journal.search(general, order="code", limit=1)
            values["journal_id"] = journal.id
        for field, code, label, account_type in (
            ("gain_account_id", GAIN_CODE, "Keuntungan Selisih Kurs Belum Terealisasi", "income_other"),
            ("loss_account_id", LOSS_CODE, "Kerugian Selisih Kurs Belum Terealisasi", "expense"),
        ):
            if self[field]:
                continue
            account = Account.search([("code", "=", code), ("company_ids", "in", company.id)], limit=1) or Account.create(
                {"code": code, "name": label, "account_type": account_type, "company_ids": [Command.link(company.id)]}
            )
            values[field] = account.id
        if values:
            self.write(values)

    # ------------------------------------------------------------------ penghitungan

    def _ensure_draft(self):
        for revaluation in self:
            if revaluation.state != "draft":
                raise UserError(_("Revaluasi %s sudah diposting atau dibatalkan, tidak bisa dihitung ulang.", revaluation.name))

    def _residual_as_of(self, line):
        """(valas, rupiah) sisa sebuah baris jurnal per tanggal revaluasi: pelunasan sebagian setelah tanggal itu dikembalikan."""
        day = self.date
        foreign, local = line.amount_currency, line.balance
        for partial in line.matched_credit_ids:  # baris ini di sisi debit
            if partial.max_date and partial.max_date <= day:
                foreign -= partial.debit_amount_currency
                local -= partial.amount
        for partial in line.matched_debit_ids:  # baris ini di sisi kredit
            if partial.max_date and partial.max_date <= day:
                foreign += partial.credit_amount_currency
                local += partial.amount
        return foreign, local

    def _build_lines(self):
        """Nilai-nilai baris revaluasi: per akun, mitra, dan mata uang, dari piutang dan hutang terbuka serta kas bank bermata uang asing."""
        self.ensure_one()
        company, local_currency, day = self.company_id, self.currency_id, self.date
        MoveLine = self.env["account.move.line"].sudo()
        base = [("company_id", "=", company.id), ("parent_state", "=", "posted"), ("date", "<=", day), ("currency_id", "!=", local_currency.id), ("move_id.kompakapps_fx_revaluation_id", "=", False)]
        groups = defaultdict(lambda: [0.0, 0.0])
        for line in MoveLine.search([*base, ("account_id.account_type", "in", ("asset_receivable", "liability_payable"))]):
            foreign, local = self._residual_as_of(line)
            key = (line.account_id.id, line.partner_id.id, line.currency_id.id, "receivable" if line.account_id.account_type == "asset_receivable" else "payable")
            groups[key][0] += foreign
            groups[key][1] += local
        for line in MoveLine.search([*base, ("account_id.account_type", "=", "asset_cash")]):
            key = (line.account_id.id, False, line.currency_id.id, "liquidity")
            groups[key][0] += line.amount_currency
            groups[key][1] += line.balance
        values = []
        for (account_id, partner_id, currency_id, kind), (foreign, local) in groups.items():
            currency = self.env["res.currency"].browse(currency_id)
            if currency.is_zero(foreign) and local_currency.is_zero(local):
                continue
            revalued = local_currency.round(currency._convert(foreign, local_currency, company, day))
            adjustment = local_currency.round(revalued - local)
            if local_currency.is_zero(adjustment):
                continue
            rate = self.env["res.currency"]._get_conversion_rate(currency, local_currency, company, day)
            values.append(
                {
                    "account_id": account_id, "partner_id": partner_id or False, "currency_id": currency_id, "kind": kind, "foreign_balance": foreign, "rate": rate,
                    "booked_balance": local, "revalued_balance": revalued, "adjustment": adjustment,
                }
            )
        order = {"receivable": 0, "payable": 1, "liquidity": 2}
        return sorted(values, key=lambda value: (order[value["kind"]], value["account_id"], value["partner_id"] or 0, value["currency_id"]))

    def action_compute(self):
        for revaluation in self:
            revaluation._ensure_draft()
            values = revaluation._build_lines()
            revaluation.line_ids.unlink()
            revaluation.write({"line_ids": [Command.create(value) for value in values]})
            revaluation.message_post(body=_("Dihitung per %(date)s: %(n)d baris, bersih %(net)s.", date=revaluation.date, n=len(values), net=revaluation.currency_id.format(revaluation.total_net)))
        return True

    # ------------------------------------------------------------------ jurnal

    def _move_vals(self, sign):
        """Nilai jurnal revaluasi (sign 1) atau pembaliknya (-1); baris valas dengan amount_currency nol, lawannya akun untung atau rugi."""
        self.ensure_one()
        day = self.date if sign > 0 else self.reverse_date
        label = _("Revaluasi kurs %(name)s per %(date)s", name=self.name, date=self.date) if sign > 0 else _("Pembalik revaluasi kurs %(name)s", name=self.name)
        lines = []
        gain = sum(line.adjustment for line in self.line_ids if line.adjustment > 0)  # selisih asli: naik nilai = untung, turun nilai = rugi
        loss = -sum(line.adjustment for line in self.line_ids if line.adjustment < 0)
        for line in self.line_ids:
            amount = sign * line.adjustment
            lines.append(
                Command.create(
                    {
                        "account_id": line.account_id.id, "partner_id": line.partner_id.id, "currency_id": line.currency_id.id, "amount_currency": 0.0,
                        "debit": amount if amount > 0 else 0.0, "credit": -amount if amount < 0 else 0.0, "name": label,
                    }
                )
            )
        # lawan: jurnal asli mengkredit untung dan mendebit rugi; pembaliknya sebaliknya
        if gain:
            lines.append(Command.create({"account_id": self.gain_account_id.id, "debit": gain if sign < 0 else 0.0, "credit": gain if sign > 0 else 0.0, "name": label}))
        if loss:
            lines.append(Command.create({"account_id": self.loss_account_id.id, "debit": loss if sign > 0 else 0.0, "credit": loss if sign < 0 else 0.0, "name": label}))
        return {"move_type": "entry", "journal_id": self.journal_id.id, "date": day, "ref": label, "company_id": self.company_id.id, "kompakapps_fx_revaluation_id": self.id, "line_ids": lines}

    def action_post(self):
        for revaluation in self:
            revaluation._ensure_draft()
            if not revaluation.line_ids:
                raise UserError(_("Tidak ada selisih kurs yang perlu dijurnal pada %s. Hitung dulu, atau pastikan ada piutang, hutang, atau kas bank bermata uang asing.", revaluation.date))
            if not revaluation.reverse_date or revaluation.reverse_date <= revaluation.date:
                raise UserError(_("Tanggal pembalik harus setelah tanggal revaluasi."))
            Move = self.env["account.move"].with_company(revaluation.company_id)
            move = Move.create(revaluation._move_vals(1))
            move.action_post()
            reverse = Move.create(revaluation._move_vals(-1))
            reverse.action_post()
            for original, back in zip(move.line_ids.filtered("partner_id"), reverse.line_ids.filtered("partner_id")):  # piutang dan hutang saling meniadakan: tutup agar tidak tersisa sebagai item terbuka
                try:
                    with self.env.cr.savepoint():
                        (original + back).filtered(lambda row: row.account_id.reconcile).reconcile()
                except UserError:
                    continue
            revaluation.write({"state": "posted", "move_id": move.id, "reverse_move_id": reverse.id})
            revaluation.message_post(body=_("Diposting: jurnal %(move)s dan pembalik %(reverse)s pada %(date)s.", move=move.name, reverse=reverse.name, date=revaluation.reverse_date))
        return True

    def action_cancel(self):
        for revaluation in self:
            if revaluation.state == "cancel":
                continue
            moves = revaluation.move_id | revaluation.reverse_move_id
            if moves:
                moves.line_ids.remove_move_reconcile()
                moves.button_draft()
                moves.button_cancel()
            revaluation.state = "cancel"
        return True

    def action_draft(self):
        for revaluation in self:
            if revaluation.state != "cancel":
                raise UserError(_("Hanya revaluasi yang dibatalkan yang bisa dikembalikan ke draft."))
            revaluation.write({"state": "draft", "move_id": False, "reverse_move_id": False})
        return True

    def unlink(self):
        if any(revaluation.state == "posted" for revaluation in self):
            raise UserError(_("Revaluasi yang sudah diposting tidak bisa dihapus. Batalkan lebih dulu."))
        if any(revaluation.move_id or revaluation.reverse_move_id for revaluation in self):
            raise UserError(_("Revaluasi yang pernah dijurnalkan tidak bisa dihapus karena jurnalnya tercatat sebagai jejak audit."))
        return super().unlink()

    # ------------------------------------------------------------------ laporan selisih kurs

    @api.model
    def kompakapps_fx_summary(self, date_from, date_to):
        """Selisih kurs realized (jurnal Exchange Difference) dan unrealized (jurnal revaluasi) per bulan, daftar revaluasi, dan kurs terakhir tiap mata uang."""
        company = self.env.company
        local = company.currency_id
        MoveLine = self.env["account.move.line"].sudo()
        realized_gain, realized_loss = company.income_currency_exchange_account_id, company.expense_currency_exchange_account_id
        month = defaultdict(lambda: {"realized_gain": 0.0, "realized_loss": 0.0, "unrealized_gain": 0.0, "unrealized_loss": 0.0})
        period = [("company_id", "=", company.id), ("parent_state", "=", "posted"), ("date", ">=", date_from), ("date", "<=", date_to)]
        if realized_gain or realized_loss:
            for row in MoveLine.search([*period, ("account_id", "in", (realized_gain | realized_loss).ids), ("move_id.kompakapps_fx_revaluation_id", "=", False)]):
                key = row.date.strftime("%Y-%m")
                if row.account_id == realized_gain:
                    month[key]["realized_gain"] += row.credit - row.debit
                else:
                    month[key]["realized_loss"] += row.debit - row.credit
        for row in MoveLine.search([*period, ("move_id.kompakapps_fx_revaluation_id", "!=", False), ("account_id.code", "in", (GAIN_CODE, LOSS_CODE))]):
            key = row.date.strftime("%Y-%m")
            if row.account_id.code == GAIN_CODE:
                month[key]["unrealized_gain"] += row.credit - row.debit
            else:
                month[key]["unrealized_loss"] += row.debit - row.credit
        revaluations = self.search([("company_id", "=", company.id), ("date", ">=", date_from), ("date", "<=", date_to), ("state", "!=", "cancel")], order="date")
        rates = []
        for currency in self.env["res.currency"].search([("active", "=", True), ("id", "!=", local.id)]):
            record = self.env["res.currency.rate"].sudo().search([("currency_id", "=", currency.id), ("company_id", "in", (company.id, False)), ("name", "<=", fields.Date.context_today(self))], order="name desc", limit=1)
            if record:
                rates.append({"currency": currency.name, "rate": self.env["res.currency"]._get_conversion_rate(currency, local, company, record.name), "date": fields.Date.to_string(record.name)})
        return {
            "months": [{"month": key, **{name: round(value, 2) for name, value in values.items()}} for key, values in sorted(month.items())],
            "revaluations": [
                {"id": rec.id, "name": rec.name, "date": fields.Date.to_string(rec.date), "state": rec.state, "gain": rec.total_gain, "loss": rec.total_loss, "net": rec.total_net}
                for rec in revaluations
            ],
            "rates": rates,
            "currency": local.name,
        }


class KompakappsFxRevaluationLine(models.Model):
    _name = "kompakapps.fx.revaluation.line"
    _description = "Baris Revaluasi Mata Uang"
    _order = "id"

    revaluation_id = fields.Many2one("kompakapps.fx.revaluation", string="Revaluasi", required=True, ondelete="cascade", index=True)
    company_id = fields.Many2one(related="revaluation_id.company_id", store=True, index=True)
    local_currency_id = fields.Many2one(related="revaluation_id.currency_id", string="Mata Uang Perusahaan")
    kind = fields.Selection(KINDS, string="Jenis", required=True)
    account_id = fields.Many2one("account.account", string="Akun", required=True)
    partner_id = fields.Many2one("res.partner", string="Mitra")
    currency_id = fields.Many2one("res.currency", string="Mata Uang", required=True)
    foreign_balance = fields.Float("Saldo Valas", digits=(16, 4))
    rate = fields.Float("Kurs", digits=(16, 6))
    booked_balance = fields.Monetary("Saldo Buku", currency_field="local_currency_id")
    revalued_balance = fields.Monetary("Saldo Revaluasi", currency_field="local_currency_id")
    adjustment = fields.Monetary("Selisih", currency_field="local_currency_id")


class AccountMove(models.Model):
    _inherit = "account.move"

    kompakapps_fx_revaluation_id = fields.Many2one("kompakapps.fx.revaluation", string="Revaluasi Kurs", readonly=True, copy=False, index="btree_not_null", ondelete="restrict")
