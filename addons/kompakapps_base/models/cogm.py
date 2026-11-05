"""Kertas kerja COGM periodik (Q64, D92): skema 2 pada dokumen "Proline - COGM Module".

Pada sistem periodik persediaan tidak dijurnal per transaksi. Selama bulan berjalan hanya ada pembelian bahan, biaya tenaga kerja, dan biaya overhead;
nilai persediaan baru diketahui setelah stock opname di akhir bulan. Kertas kerja ini menyusun harga pokok produksi (COGM) dari tiga sumber:

1. buku besar (otomatis): saldo awal persediaan bahan baku dan barang dalam proses (WIP), pembelian bersih, tenaga kerja langsung, dan overhead pabrik;
2. formulir opname (input petugas): jumlah fisik sisa bahan baku dan estimasi tingkat penyelesaian WIP;
3. Control Balance: rangkaian pemeriksaan yang harus Hijau sebelum jurnal COGM boleh dieksekusi.

COGM = Bahan Baku Terpakai + Tenaga Kerja Langsung + Overhead + WIP Awal - WIP Akhir, dengan
Bahan Baku Terpakai = Persediaan Bahan Baku Awal + Pembelian Bersih - Persediaan Bahan Baku Akhir.
"""

from collections import Counter, defaultdict
from datetime import datetime, time, timedelta

import pytz

from odoo import Command, _, api, fields, models
from odoo.exceptions import AccessError, UserError, ValidationError
from odoo.tools import float_is_zero, float_round

SECTIONS = [
    ("purchase", "Pembelian Bahan Baku"),
    ("labor", "Tenaga Kerja Langsung"),
    ("overhead", "Overhead Pabrik"),
    ("excluded", "Bukan Biaya Produksi"),
]
LINE_SECTIONS = [
    ("rm_opening", "Persediaan Bahan Baku Awal"),
    ("purchase", "Pembelian Bersih"),
    ("labor", "Tenaga Kerja Langsung"),
    ("overhead", "Overhead Pabrik"),
    ("wip_opening", "Barang Dalam Proses Awal"),
]
COST_SECTIONS = ("purchase", "labor", "overhead")
STATES = [("draft", "Draft"), ("posted", "Diposting"), ("cancel", "Dibatalkan")]
CONTROL = [("unchecked", "Belum Diperiksa"), ("green", "Hijau (Seimbang)"), ("red", "Merah (Ada Selisih)")]
LOCKED_WHEN_NOT_DRAFT = {"company_id", "date_from", "date_to", "line_ids", "opname_ids", "wip_ids"}
COST_METHODS = [("average", "Rata-rata tertimbang periode"), ("standard", "Biaya standar produk")]
COST_SOURCES = [("standard", "Biaya produk"), ("average", "Rata-rata periode"), ("manual", "Manual")]
BASIS_KEYS = ("opening_qty", "opening_cost", "purchase_qty", "purchase_value", "avg_cost")
FG_BASIS_KEYS = ("opening_qty", "opening_cost", "delivered_qty", "provisional_cogs")


class KompakappsCogmConfig(models.Model):
    _name = "kompakapps.cogm.config"
    _description = "Pengaturan COGM Periodik"
    _rec_name = "company_id"

    company_id = fields.Many2one("res.company", string="Perusahaan", required=True, default=lambda self: self.env.company, ondelete="cascade")
    journal_id = fields.Many2one("account.journal", string="Jurnal COGM", required=True, domain="[('type', '=', 'general'), ('company_id', '=', company_id)]")
    raw_account_id = fields.Many2one(
        "account.account", string="Persediaan Bahan Baku", required=True, help="Disesuaikan ke hasil opname saat jurnal COGM dieksekusi (saldo awal diambil dari buku besar)."
    )
    wip_account_id = fields.Many2one("account.account", string="Barang Dalam Proses (WIP)", required=True, help="Disesuaikan ke estimasi WIP akhir saat jurnal COGM dieksekusi.")
    fg_account_id = fields.Many2one("account.account", string="Persediaan Barang Jadi (Inventory COGM)", required=True, help="Menerima COGM periode: Debit saat jurnal dieksekusi.")
    summary_account_id = fields.Many2one(
        "account.account", string="Akun Ikhtisar COGM", required=True, help="Akun perantara yang saldonya kembali nol setelah jurnal COGM; memperlihatkan seluruh unsur COGM dalam satu jurnal."
    )
    scan_prefix = fields.Char(
        string="Awalan Kode Akun yang Diperiksa",
        default="51",
        help="Akun biaya berawalan kode ini yang bergerak pada periode tetapi belum diklasifikasikan membuat Control Balance Merah. Pisahkan dengan koma. Kosong = tidak diperiksa.",
    )
    tolerance_pct = fields.Float(
        string="Toleransi Selisih Opname (%)", default=2.0, help="Selisih jumlah fisik terhadap stok sistem sampai persentase ini dianggap wajar. Di atasnya perlu alasan selisih per baris."
    )
    cogs_account_id = fields.Many2one(
        "account.account", string="Akun HPP Penjualan", help="Akun harga pokok penjualan. Saat Execute, selisih HPP aktual terhadap HPP sementara yang sudah dibukukan pada akun ini dijurnal (Dr HPP, Cr Persediaan Barang Jadi). Kosong = HPP penjualan tidak dijurnal."
    )
    cost_method = fields.Selection(
        COST_METHODS,
        string="Metode Biaya Persediaan Akhir",
        required=True,
        default="average",
        help="Rata-rata tertimbang periode: biaya per unit = (jumlah awal x biaya awal + pembelian periode) / (jumlah awal + jumlah dibeli). Biaya standar produk: memakai biaya produk apa adanya.",
    )
    update_product_cost = fields.Boolean(
        string="Perbarui Biaya Produk saat Execute", default=True, help="Saat jurnal COGM dieksekusi, biaya produk diganti dengan biaya rata-rata tertimbang periode (baris bersumber rata-rata). Dikembalikan saat Reverse."
    )
    adjust_stock = fields.Boolean(
        string="Samakan Stok Sistem dengan Hasil Opname saat Execute",
        default=True,
        help="Saat jurnal COGM dieksekusi, selisih jumlah fisik terhadap stok sistem dibuat menjadi penyesuaian stok (Inventory Adjustment) bertanggal akhir periode. Dikembalikan saat Reverse.",
    )
    account_ids = fields.One2many("kompakapps.cogm.account", "config_id", string="Akun Biaya Produksi")

    _company_unique = models.Constraint("UNIQUE(company_id)", "Perusahaan ini sudah punya pengaturan COGM.")

    @api.constrains("company_id", "raw_account_id", "wip_account_id", "fg_account_id", "summary_account_id")
    def _check_accounts(self):
        for config in self:
            accounts = config.raw_account_id | config.wip_account_id | config.fg_account_id | config.summary_account_id
            if len(accounts) < 4:
                raise ValidationError(_("Akun persediaan bahan baku, WIP, barang jadi, dan ikhtisar COGM harus empat akun yang berbeda."))
            for account in accounts:
                if config.company_id not in account.company_ids:
                    raise ValidationError(_("Akun %(account)s bukan akun milik %(company)s.", account=account.display_name, company=config.company_id.name))

    @api.model
    def _for_company(self, company):
        return self.sudo().search([("company_id", "=", company.id)], limit=1)

    def _system_accounts(self):
        self.ensure_one()
        return self.raw_account_id | self.wip_account_id | self.fg_account_id | self.summary_account_id


class KompakappsCogmAccount(models.Model):
    _name = "kompakapps.cogm.account"
    _description = "Pemetaan Akun Biaya COGM"
    _order = "section, account_id"

    config_id = fields.Many2one("kompakapps.cogm.config", string="Pengaturan", required=True, ondelete="cascade")
    company_id = fields.Many2one(related="config_id.company_id", store=True)
    account_id = fields.Many2one("account.account", string="Akun", required=True)
    section = fields.Selection(SECTIONS, string="Bagian COGM", required=True, default="overhead")
    pct = fields.Float(
        string="Porsi Produksi (%)", default=100.0, help="Bagian saldo akun periode ini yang dibebankan ke produksi, mis. 70 untuk listrik yang dipakai pabrik 70%. Sisanya tetap di akun."
    )

    _account_unique = models.Constraint("UNIQUE(config_id, account_id)", "Akun ini sudah dipetakan.")

    @api.constrains("pct")
    def _check_pct(self):
        for record in self:
            if not 0.0 <= record.pct <= 100.0:
                raise ValidationError(_("Porsi produksi harus antara 0 dan 100 persen."))

    @api.constrains("account_id", "config_id")
    def _check_account(self):
        for record in self:
            if record.account_id in record.config_id._system_accounts():
                raise ValidationError(_("Akun %s dipakai sebagai akun persediaan atau ikhtisar COGM, jadi tidak bisa dipetakan sebagai akun biaya.", record.account_id.display_name))
            if record.config_id.company_id not in record.account_id.company_ids:
                raise ValidationError(_("Akun %(account)s bukan akun milik %(company)s.", account=record.account_id.display_name, company=record.config_id.company_id.name))


class KompakappsCogmChild(models.AbstractModel):
    """Baris kertas kerja hanya bisa diubah selama kertas kerjanya draft."""

    _name = "kompakapps.cogm.child"
    _description = "Baris Kertas Kerja COGM"

    def _check_draft(self, worksheets):
        for worksheet in worksheets:
            if worksheet.state != "draft":
                raise UserError(_("Kertas kerja %(name)s berstatus %(state)s, jadi isinya tidak bisa diubah. Batalkan jurnalnya lebih dulu.", name=worksheet.name, state=dict(STATES)[worksheet.state]))

    @api.model_create_multi
    def create(self, vals_list):
        self._check_draft(self.env["kompakapps.cogm.worksheet"].browse([v["worksheet_id"] for v in vals_list if v.get("worksheet_id")]))
        return super().create(vals_list)

    def write(self, vals):
        self._check_draft(self.worksheet_id)
        return super().write(vals)

    def unlink(self):
        self._check_draft(self.worksheet_id)
        return super().unlink()


class KompakappsCogmLine(models.Model):
    _name = "kompakapps.cogm.line"
    _inherit = ["kompakapps.cogm.child"]
    _description = "Data Buku Besar Kertas Kerja COGM"
    _order = "worksheet_id, id"

    worksheet_id = fields.Many2one("kompakapps.cogm.worksheet", string="Kertas Kerja", required=True, ondelete="cascade", index=True)
    company_id = fields.Many2one(related="worksheet_id.company_id", store=True, index=True)
    currency_id = fields.Many2one(related="worksheet_id.currency_id")
    section = fields.Selection(LINE_SECTIONS, string="Bagian", required=True)
    account_id = fields.Many2one("account.account", string="Akun", required=True)
    debit = fields.Monetary(string="Debit")
    credit = fields.Monetary(string="Kredit")
    balance = fields.Monetary(string="Saldo (Debit - Kredit)")
    pct = fields.Float(string="Porsi Produksi (%)", default=100.0)
    amount = fields.Monetary(string="Dibebankan ke COGM")


class KompakappsCogmOpname(models.Model):
    _name = "kompakapps.cogm.opname"
    _inherit = ["kompakapps.cogm.child"]
    _description = "Opname Bahan Baku Kertas Kerja COGM"
    _order = "worksheet_id, id"

    worksheet_id = fields.Many2one("kompakapps.cogm.worksheet", string="Kertas Kerja", required=True, ondelete="cascade", index=True)
    company_id = fields.Many2one(related="worksheet_id.company_id", store=True, index=True)
    currency_id = fields.Many2one(related="worksheet_id.currency_id")
    product_id = fields.Many2one("product.product", string="Bahan Baku", required=True, domain="[('type', '=', 'consu')]")
    uom_id = fields.Many2one(related="product_id.uom_id", string="Satuan")
    is_storable = fields.Boolean(related="product_id.is_storable", string="Dilacak Stok")
    qty = fields.Float(string="Jumlah Fisik", digits="Product Unit", help="Hasil hitung fisik di gudang pada akhir periode.")
    unit_cost = fields.Float(string="Biaya per Unit", digits="Product Price", help="Terisi dari biaya produk; ubah bila nilai persediaan akhir memakai biaya lain.")
    value = fields.Monetary(string="Nilai", compute="_compute_value", store=True)
    book_qty = fields.Float(string="Stok Sistem", digits="Product Unit", compute="_compute_book_qty", store=True, help="Jumlah menurut pergerakan stok sistem pada akhir periode; pembanding hitung fisik.")
    variance_qty = fields.Float(string="Selisih Jumlah", digits="Product Unit", compute="_compute_variance", store=True)
    variance_value = fields.Monetary(string="Selisih Nilai", compute="_compute_variance", store=True)
    explanation = fields.Char(string="Alasan Selisih", help="Wajib bila selisih jumlah melebihi toleransi, mis. susut, rusak, atau salah catat penerimaan.")
    cost_source = fields.Selection(COST_SOURCES, string="Sumber Biaya", default="standard", required=True, help="Rata-rata periode dihitung dari saldo awal dan pembelian terposting; Manual bila biaya per unit diubah petugas.")
    opening_qty = fields.Float(string="Jumlah Awal", digits="Product Unit", copy=False, help="Stok sistem pada akhir hari sebelum periode.")
    opening_cost = fields.Float(string="Biaya Awal per Unit", digits="Product Price", copy=False, help="Biaya akhir periode sebelumnya (kertas kerja terposting) atau biaya produk saat ini.")
    purchase_qty = fields.Float(string="Jumlah Dibeli", digits="Product Unit", copy=False, help="Jumlah pada tagihan vendor terposting dalam periode, dikurangi retur.")
    purchase_value = fields.Monetary(string="Nilai Pembelian", copy=False, help="Nilai pada tagihan vendor terposting dalam periode, dikurangi retur.")
    avg_cost = fields.Float(string="Biaya Rata-rata Periode", digits="Product Price", copy=False)
    old_cost = fields.Float(string="Biaya Produk Sebelum Execute", digits="Product Price", copy=False)
    cost_updated = fields.Boolean(string="Biaya Produk Diperbarui", copy=False)
    adjust_qty = fields.Float(string="Penyesuaian Stok", digits="Product Unit", copy=False, help="Selisih yang dijadikan penyesuaian stok saat Execute.")
    adjust_move_ids = fields.Many2many("stock.move", "kompakapps_cogm_opname_move_rel", "opname_id", "move_id", string="Pergerakan Penyesuaian Stok", copy=False, readonly=True)

    _product_unique = models.Constraint("UNIQUE(worksheet_id, product_id)", "Bahan baku ini sudah ada pada lembar opname. Ubah jumlahnya pada baris yang ada (gabungkan semua lokasi).")

    @api.constrains("qty", "unit_cost")
    def _check_non_negative(self):
        for line in self:
            if line.qty < 0 or line.unit_cost < 0:
                raise ValidationError(_("Jumlah fisik dan biaya per unit tidak boleh negatif (%s).", line.product_id.display_name))

    @api.depends("qty", "unit_cost", "currency_id")
    def _compute_value(self):
        for line in self:
            line.value = line.currency_id.round(line.qty * line.unit_cost) if line.currency_id else line.qty * line.unit_cost

    @api.depends("product_id", "worksheet_id.date_to", "worksheet_id.company_id")
    def _compute_book_qty(self):
        for line in self:
            worksheet = line.worksheet_id
            if line.product_id.is_storable and worksheet.date_to:
                company = worksheet.company_id
                product = line.product_id.sudo().with_company(company).with_context(to_date=worksheet._cutoff(), allowed_company_ids=[company.id])
                line.book_qty = product.qty_available
            else:
                line.book_qty = 0.0

    @api.depends("qty", "book_qty", "unit_cost", "product_id.is_storable", "currency_id")
    def _compute_variance(self):
        for line in self:
            if line.product_id.is_storable:
                line.variance_qty = line.qty - line.book_qty
                line.variance_value = line.currency_id.round(line.variance_qty * line.unit_cost)
            else:
                line.variance_qty = 0.0
                line.variance_value = 0.0

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if vals.get("product_id") and vals.get("worksheet_id"):
                worksheet = self.env["kompakapps.cogm.worksheet"].browse(vals["worksheet_id"])
                basis = worksheet._cost_basis(self.env["product.product"].browse(vals["product_id"]))
                for key in BASIS_KEYS:
                    vals.setdefault(key, basis[key])
                given = vals.get("unit_cost")
                if given is None or abs(given - basis["unit_cost"]) <= 0.005:
                    vals["unit_cost"], vals["cost_source"] = basis["unit_cost"], basis["cost_source"]
                else:
                    vals["cost_source"] = "manual"
        return super().create(vals_list)

    def write(self, vals):
        if "unit_cost" in vals and "cost_source" not in vals and not self.env.context.get("kompakapps_cost_auto"):
            changed = self.filtered(lambda line: abs(line.unit_cost - vals["unit_cost"]) > 0.005)
            if changed:
                super(KompakappsCogmOpname, changed).write({**vals, "cost_source": "manual"})  # biaya diubah petugas: tidak ikut dihitung ulang saat data ditarik
                rest = self - changed
                return super(KompakappsCogmOpname, rest).write(vals) if rest else True
        return super().write(vals)

    def _refresh_cost_basis(self):
        """Hitung ulang dasar biaya rata-rata (saldo awal dan pembelian) dan, kecuali yang diubah manual, biaya per unit."""
        for line in self:
            basis = line.worksheet_id._cost_basis(line.product_id)
            vals = {key: basis[key] for key in BASIS_KEYS}
            if line.cost_source != "manual":
                vals.update(unit_cost=basis["unit_cost"], cost_source=basis["cost_source"])
            line.with_context(kompakapps_cost_auto=True).write(vals)

    def action_reset_cost(self):
        """Kembalikan biaya per unit ke hitungan otomatis (menurut metode biaya pada pengaturan)."""
        self.with_context(kompakapps_cost_auto=True).write({"cost_source": "standard"})
        self._refresh_cost_basis()
        return True

    def _tolerance_qty(self, tolerance_pct):
        self.ensure_one()
        return abs(self.book_qty) * tolerance_pct / 100.0


class KompakappsCogmOutput(models.Model):
    _name = "kompakapps.cogm.output"
    _inherit = ["kompakapps.cogm.child"]
    _description = "Hasil Produksi Kertas Kerja COGM"
    _order = "worksheet_id, id"

    worksheet_id = fields.Many2one("kompakapps.cogm.worksheet", string="Kertas Kerja", required=True, ondelete="cascade", index=True)
    company_id = fields.Many2one(related="worksheet_id.company_id", store=True, index=True)
    currency_id = fields.Many2one(related="worksheet_id.currency_id")
    product_id = fields.Many2one("product.product", string="Barang Jadi", required=True, domain="[('type', '=', 'consu')]")
    uom_id = fields.Many2one(related="product_id.uom_id", string="Satuan")
    mo_qty = fields.Float(string="Qty dari MO", digits="Product Unit", copy=False, help="Jumlah yang diselesaikan Manufacturing Order dalam periode.")
    qty = fields.Float(string="Qty Diproduksi", digits="Product Unit", help="Pembagi biaya produksi: HPP per unit = total biaya dibagi jumlah ini.")
    source = fields.Selection([("mo", "Manufacturing Order"), ("manual", "Manual")], string="Sumber", default="manual", required=True)
    cogm_value = fields.Monetary(string="Nilai COGM", compute="_compute_cogm_value", store=True, help="Bagian COGM untuk barang jadi ini: qty diproduksi x HPP per unit.")

    _product_unique = models.Constraint("UNIQUE(worksheet_id, product_id)", "Barang jadi ini sudah ada pada hasil produksi. Ubah qty pada baris yang ada.")

    @api.constrains("qty")
    def _check_qty(self):
        for line in self:
            if line.qty < 0:
                raise ValidationError(_("Qty diproduksi tidak boleh negatif (%s).", line.product_id.display_name))

    @api.depends("qty", "worksheet_id.cogm", "worksheet_id.qty_produced", "currency_id")
    def _compute_cogm_value(self):
        """COGM dialokasikan menurut qty; sisa pembulatan masuk ke baris terbesar supaya jumlah semua barang jadi sama persis dengan COGM."""
        for worksheet in self.worksheet_id:
            lines = worksheet.output_ids
            total = sum(lines.mapped("qty"))
            round_ = worksheet.currency_id.round
            values = {}
            if total > 0:
                values = {line.id: round_(worksheet.cogm * line.qty / total) for line in lines}
                rest = round_(worksheet.cogm - sum(values.values()))
                if rest:
                    values[max(lines, key=lambda line: line.qty).id] += rest
            for line in lines & self:
                line.cogm_value = values.get(line.id, 0.0)

    def write(self, vals):
        if "qty" in vals and "source" not in vals and not self.env.context.get("kompakapps_output_auto"):
            changed = self.filtered(lambda line: line.source == "mo" and abs(line.qty - vals["qty"]) > 1e-9)
            if changed:
                super(KompakappsCogmOutput, changed).write({**vals, "source": "manual"})  # qty dari MO diubah petugas: tidak ikut ditimpa saat data ditarik ulang
                rest = self - changed
                return super(KompakappsCogmOutput, rest).write(vals) if rest else True
        return super().write(vals)


class KompakappsCogmFg(models.Model):
    _name = "kompakapps.cogm.fg"
    _inherit = ["kompakapps.cogm.child"]
    _description = "Barang Jadi dan HPP Penjualan Kertas Kerja COGM"
    _order = "worksheet_id, id"

    worksheet_id = fields.Many2one("kompakapps.cogm.worksheet", string="Kertas Kerja", required=True, ondelete="cascade", index=True)
    company_id = fields.Many2one(related="worksheet_id.company_id", store=True, index=True)
    currency_id = fields.Many2one(related="worksheet_id.currency_id")
    product_id = fields.Many2one("product.product", string="Barang Jadi", required=True, domain="[('type', '=', 'consu'), ('is_storable', '=', True)]")
    uom_id = fields.Many2one(related="product_id.uom_id", string="Satuan")
    opening_qty = fields.Float(string="Stok Awal", digits="Product Unit", copy=False, help="Stok sistem akhir hari sebelum periode.")
    opening_cost = fields.Float(string="Biaya Awal per Unit", digits="Product Price", copy=False, help="Biaya akhir periode sebelumnya (kertas kerja terposting) atau biaya produk saat ini.")
    opening_value = fields.Monetary(string="Nilai Awal", compute="_compute_values", store=True)
    produced_qty = fields.Float(string="Qty Diproduksi", digits="Product Unit", compute="_compute_values", store=True, help="Dari bagian Hasil Produksi.")
    produced_value = fields.Monetary(string="Nilai Produksi (COGM)", compute="_compute_values", store=True)
    available_qty = fields.Float(string="Qty Tersedia", digits="Product Unit", compute="_compute_values", store=True)
    available_value = fields.Monetary(string="Nilai Tersedia", compute="_compute_values", store=True)
    unit_cost = fields.Float(string="Biaya Rata-rata per Unit", digits="Product Price", compute="_compute_values", store=True, help="(nilai awal + nilai produksi) / (stok awal + qty diproduksi).")
    delivered_qty = fields.Float(string="Terkirim (Sistem)", digits="Product Unit", copy=False, help="Pengiriman ke pelanggan menurut pergerakan stok dalam periode, dikurangi retur.")
    book_qty = fields.Float(string="Stok Sistem Akhir", digits="Product Unit", compute="_compute_book_qty", store=True)
    qty = fields.Float(string="Stok Akhir (Fisik)", digits="Product Unit", help="Hasil hitung fisik barang jadi; terisi dari stok sistem, ubah bila hitung fisik berbeda.")
    variance_qty = fields.Float(string="Selisih Jumlah", digits="Product Unit", compute="_compute_values", store=True)
    explanation = fields.Char(string="Alasan Selisih", help="Wajib bila selisih jumlah melebihi toleransi.")
    sold_qty = fields.Float(string="Qty Terjual", digits="Product Unit", compute="_compute_values", store=True, help="Stok tersedia dikurangi stok akhir.")
    ending_value = fields.Monetary(string="Nilai Stok Akhir", compute="_compute_values", store=True)
    cogs = fields.Monetary(string="HPP Aktual", compute="_compute_values", store=True, help="Nilai tersedia dikurangi nilai stok akhir.")
    provisional_cogs = fields.Monetary(string="HPP Sementara", copy=False, help="HPP yang sudah dibukukan saat penjualan pada akun HPP untuk barang ini dalam periode (diambil dari buku besar).")
    cogs_adjustment = fields.Monetary(string="Penyesuaian HPP", compute="_compute_values", store=True, help="HPP aktual dikurangi HPP sementara.")
    old_cost = fields.Float(string="Biaya Produk Sebelum Execute", digits="Product Price", copy=False)
    cost_updated = fields.Boolean(string="Biaya Produk Diperbarui", copy=False)
    adjust_qty = fields.Float(string="Penyesuaian Stok", digits="Product Unit", copy=False)
    adjust_move_ids = fields.Many2many("stock.move", "kompakapps_cogm_fg_move_rel", "fg_id", "move_id", string="Pergerakan Penyesuaian Stok", copy=False, readonly=True)

    _product_unique = models.Constraint("UNIQUE(worksheet_id, product_id)", "Barang jadi ini sudah ada pada HPP penjualan. Ubah stok akhirnya pada baris yang ada.")

    @api.constrains("qty")
    def _check_qty(self):
        for line in self:
            if line.qty < 0:
                raise ValidationError(_("Stok akhir tidak boleh negatif (%s).", line.product_id.display_name))

    @api.depends(
        "product_id", "worksheet_id.output_ids.qty", "worksheet_id.output_ids.cogm_value", "opening_qty", "opening_cost", "qty", "book_qty", "provisional_cogs", "currency_id"
    )
    def _compute_values(self):
        for line in self:
            round_ = line.currency_id.round
            outputs = line.worksheet_id.output_ids.filtered(lambda output: output.product_id == line.product_id)
            line.produced_qty = sum(outputs.mapped("qty"))
            line.produced_value = sum(outputs.mapped("cogm_value"))
            line.opening_value = round_(line.opening_qty * line.opening_cost)
            line.available_qty = line.opening_qty + line.produced_qty
            line.available_value = line.opening_value + line.produced_value
            if line.available_qty > 0 and line.available_value > 0:
                line.unit_cost = float_round(line.available_value / line.available_qty, precision_digits=self.env["decimal.precision"].precision_get("Product Price"))
            else:
                line.unit_cost = line.opening_cost
            line.sold_qty = line.available_qty - line.qty
            line.ending_value = round_(line.qty * line.unit_cost)
            line.cogs = line.available_value - line.ending_value
            line.cogs_adjustment = line.cogs - line.provisional_cogs
            line.variance_qty = line.qty - line.book_qty

    @api.depends("product_id", "worksheet_id.date_to", "worksheet_id.company_id")
    def _compute_book_qty(self):
        for line in self:
            line.book_qty = line.worksheet_id._stock_qty(line.product_id) if line.worksheet_id.date_to else 0.0

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if vals.get("product_id") and vals.get("worksheet_id"):
                worksheet = self.env["kompakapps.cogm.worksheet"].browse(vals["worksheet_id"])
                product = self.env["product.product"].browse(vals["product_id"])
                basis = worksheet._fg_basis(product)
                for key in FG_BASIS_KEYS:
                    vals.setdefault(key, basis[key])
                vals.setdefault("qty", worksheet._stock_qty(product))
        return super().create(vals_list)

    def _refresh_fg_basis(self):
        """Hitung ulang stok awal, biaya awal, pengiriman, dan HPP sementara dari sistem dan buku besar."""
        for line in self:
            basis = line.worksheet_id._fg_basis(line.product_id)
            line.write({key: basis[key] for key in FG_BASIS_KEYS})


class KompakappsCogmWip(models.Model):
    _name = "kompakapps.cogm.wip"
    _inherit = ["kompakapps.cogm.child"]
    _description = "Opname Barang Dalam Proses Kertas Kerja COGM"
    _order = "worksheet_id, id"

    worksheet_id = fields.Many2one("kompakapps.cogm.worksheet", string="Kertas Kerja", required=True, ondelete="cascade", index=True)
    company_id = fields.Many2one(related="worksheet_id.company_id", store=True, index=True)
    currency_id = fields.Many2one(related="worksheet_id.currency_id")
    name = fields.Char(string="Barang Dalam Proses", required=True, help="Batch atau barang yang belum selesai pada akhir periode.")
    product_id = fields.Many2one("product.product", string="Barang Jadi yang Dibuat", help="Bila diisi, biaya bahan dan konversi per unit terisi dari BoM-nya.")
    qty = fields.Float(string="Jumlah", digits="Product Unit")
    material_cost = fields.Float(string="Biaya Bahan per Unit", digits="Product Price", help="Biaya bahan untuk satu unit yang sudah selesai.")
    material_pct = fields.Float(string="Bahan Terpakai (%)", default=100.0, help="Bahan biasanya sudah dimasukkan seluruhnya di awal proses (100%).")
    conversion_cost = fields.Float(string="Biaya Konversi per Unit", digits="Product Price", help="Tenaga kerja dan overhead untuk satu unit yang sudah selesai.")
    completion_pct = fields.Float(string="Tingkat Penyelesaian (%)", help="Estimasi petugas lapangan atas persentase konversi yang sudah dikerjakan.")
    value = fields.Monetary(string="Nilai WIP", compute="_compute_value", store=True)

    @api.constrains("qty", "material_cost", "conversion_cost", "material_pct", "completion_pct")
    def _check_values(self):
        for line in self:
            if min(line.qty, line.material_cost, line.conversion_cost) < 0:
                raise ValidationError(_("Jumlah dan biaya WIP tidak boleh negatif (%s).", line.name))
            if not (0.0 <= line.material_pct <= 100.0 and 0.0 <= line.completion_pct <= 100.0):
                raise ValidationError(_("Persentase bahan dan penyelesaian WIP harus antara 0 dan 100 (%s).", line.name))

    @api.depends("qty", "material_cost", "material_pct", "conversion_cost", "completion_pct", "currency_id")
    def _compute_value(self):
        for line in self:
            value = line.qty * (line.material_cost * line.material_pct + line.conversion_cost * line.completion_pct) / 100.0
            line.value = line.currency_id.round(value) if line.currency_id else value

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if vals.get("product_id") and vals.get("material_cost") is None and vals.get("conversion_cost") is None:
                material, conversion = self.env["kompakapps.cogm.worksheet"].bom_cost_split(vals["product_id"])
                vals["material_cost"], vals["conversion_cost"] = material, conversion
        return super().create(vals_list)


class KompakappsCogmWorksheet(models.Model):
    _name = "kompakapps.cogm.worksheet"
    _description = "Kertas Kerja COGM Periodik"
    _inherit = ["mail.thread"]
    _order = "date_to desc, id desc"

    def _default_date_to(self):
        return fields.Date.context_today(self).replace(day=1) - timedelta(days=1)

    def _default_date_from(self):
        return self._default_date_to().replace(day=1)

    name = fields.Char(string="Nomor", default="Baru", readonly=True, copy=False)
    company_id = fields.Many2one("res.company", string="Perusahaan", required=True, default=lambda self: self.env.company, index=True)
    currency_id = fields.Many2one(related="company_id.currency_id")
    date_from = fields.Date(string="Dari Tanggal", required=True, default=_default_date_from, tracking=True)
    date_to = fields.Date(string="Sampai Tanggal", required=True, default=_default_date_to, tracking=True, help="Tanggal opname dan tanggal jurnal COGM.")
    state = fields.Selection(STATES, string="Status", required=True, default="draft", copy=False, tracking=True, index=True)
    note = fields.Text(string="Catatan")
    line_ids = fields.One2many("kompakapps.cogm.line", "worksheet_id", string="Data Buku Besar", copy=False)
    opname_ids = fields.One2many("kompakapps.cogm.opname", "worksheet_id", string="Opname Bahan Baku", copy=True)
    wip_ids = fields.One2many("kompakapps.cogm.wip", "worksheet_id", string="Opname WIP", copy=True)
    output_ids = fields.One2many("kompakapps.cogm.output", "worksheet_id", string="Hasil Produksi", copy=True)
    fg_ids = fields.One2many("kompakapps.cogm.fg", "worksheet_id", string="Barang Jadi dan HPP Penjualan", copy=False)
    pulled_at = fields.Datetime(string="Data Ditarik Pada", readonly=True, copy=False)

    rm_opening = fields.Monetary(string="Persediaan Bahan Baku Awal", compute="_compute_totals", store=True)
    purchases = fields.Monetary(string="Pembelian Bersih", compute="_compute_totals", store=True)
    rm_available = fields.Monetary(string="Bahan Baku Tersedia", compute="_compute_totals", store=True)
    rm_ending = fields.Monetary(string="Persediaan Bahan Baku Akhir (Opname)", compute="_compute_totals", store=True)
    rm_used = fields.Monetary(string="Bahan Baku Terpakai", compute="_compute_totals", store=True)
    direct_labor = fields.Monetary(string="Tenaga Kerja Langsung", compute="_compute_totals", store=True)
    overhead = fields.Monetary(string="Overhead Pabrik", compute="_compute_totals", store=True)
    total_cost = fields.Monetary(string="Total Biaya Produksi", compute="_compute_totals", store=True)
    wip_opening = fields.Monetary(string="WIP Awal", compute="_compute_totals", store=True)
    wip_ending = fields.Monetary(string="WIP Akhir (Opname)", compute="_compute_totals", store=True)
    cogm = fields.Monetary(string="COGM", compute="_compute_totals", store=True)
    qty_produced = fields.Float(string="Qty Diproduksi", digits="Product Unit", compute="_compute_totals", store=True, help="Pembagi HPP per unit.")
    unit_cogm = fields.Monetary(string="HPP per Unit", compute="_compute_totals", store=True, help="COGM dibagi qty diproduksi.")
    unit_material = fields.Monetary(string="Bahan Baku per Unit", compute="_compute_totals", store=True)
    unit_labor = fields.Monetary(string="Tenaga Kerja per Unit", compute="_compute_totals", store=True)
    unit_overhead = fields.Monetary(string="Overhead per Unit", compute="_compute_totals", store=True)
    unit_wip = fields.Monetary(string="Penyesuaian WIP per Unit", compute="_compute_totals", store=True)
    fg_ending_value = fields.Monetary(string="Nilai Barang Jadi Akhir", compute="_compute_fg_totals")
    fg_cogs = fields.Monetary(string="HPP Penjualan Aktual", compute="_compute_fg_totals")
    fg_provisional = fields.Monetary(string="HPP Sementara Dibukukan", compute="_compute_fg_totals")
    fg_adjustment = fields.Monetary(string="Penyesuaian HPP", compute="_compute_fg_totals")

    control_state = fields.Selection(CONTROL, string="Control Balance", default="unchecked", copy=False)
    control_checked_at = fields.Datetime(string="Diperiksa Pada", readonly=True, copy=False)
    move_id = fields.Many2one("account.move", string="Jurnal COGM", readonly=True, copy=False)
    move_ids = fields.One2many("account.move", "kompakapps_cogm_id", string="Semua Jurnal", readonly=True)
    post_user_id = fields.Many2one("res.users", string="Dieksekusi Oleh", readonly=True, copy=False)
    post_date = fields.Datetime(string="Dieksekusi Pada", readonly=True, copy=False)

    @api.constrains("date_from", "date_to")
    def _check_dates(self):
        for worksheet in self:
            if worksheet.date_from > worksheet.date_to:
                raise ValidationError(_("Tanggal mulai periode tidak boleh setelah tanggal akhir."))

    @api.depends("line_ids.section", "line_ids.amount", "opname_ids.value", "wip_ids.value", "output_ids.qty", "currency_id")
    def _compute_totals(self):
        for worksheet in self:
            total = defaultdict(float)
            for line in worksheet.line_ids:
                total[line.section] += line.amount
            round_ = worksheet.currency_id.round if worksheet.currency_id else round
            worksheet.rm_opening = round_(total["rm_opening"])
            worksheet.purchases = round_(total["purchase"])
            worksheet.direct_labor = round_(total["labor"])
            worksheet.overhead = round_(total["overhead"])
            worksheet.wip_opening = round_(total["wip_opening"])
            worksheet.rm_ending = round_(sum(worksheet.opname_ids.mapped("value")))
            worksheet.wip_ending = round_(sum(worksheet.wip_ids.mapped("value")))
            worksheet.rm_available = worksheet.rm_opening + worksheet.purchases
            worksheet.rm_used = worksheet.rm_available - worksheet.rm_ending
            worksheet.total_cost = worksheet.rm_used + worksheet.direct_labor + worksheet.overhead
            worksheet.cogm = worksheet.total_cost + worksheet.wip_opening - worksheet.wip_ending
            # Seluruh biaya aktual dijumlahkan lebih dulu (COGM), baru dibagi qty yang diproduksi.
            qty = sum(worksheet.output_ids.mapped("qty"))
            worksheet.qty_produced = qty
            divisor = qty if qty > 0 else 0.0
            worksheet.unit_cogm = round_(worksheet.cogm / divisor) if divisor else 0.0
            worksheet.unit_material = round_(worksheet.rm_used / divisor) if divisor else 0.0
            worksheet.unit_labor = round_(worksheet.direct_labor / divisor) if divisor else 0.0
            worksheet.unit_overhead = round_(worksheet.overhead / divisor) if divisor else 0.0
            worksheet.unit_wip = round_((worksheet.wip_opening - worksheet.wip_ending) / divisor) if divisor else 0.0

    @api.depends("fg_ids.ending_value", "fg_ids.cogs", "fg_ids.provisional_cogs", "fg_ids.cogs_adjustment", "currency_id")
    def _compute_fg_totals(self):
        """Jumlah HPP penjualan barang jadi; tidak disimpan supaya selalu dihitung dari baris terbaru."""
        for worksheet in self:
            round_ = worksheet.currency_id.round if worksheet.currency_id else round
            worksheet.fg_ending_value = round_(sum(worksheet.fg_ids.mapped("ending_value")))
            worksheet.fg_cogs = round_(sum(worksheet.fg_ids.mapped("cogs")))
            worksheet.fg_provisional = round_(sum(worksheet.fg_ids.mapped("provisional_cogs")))
            worksheet.fg_adjustment = round_(sum(worksheet.fg_ids.mapped("cogs_adjustment")))

    # ------------------------------------------------------------------ dasar

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if vals.get("name", "Baru") == "Baru":
                vals["name"] = self.env["ir.sequence"].next_by_code("kompakapps.cogm.worksheet") or "Baru"
        return super().create(vals_list)

    def write(self, vals):
        if LOCKED_WHEN_NOT_DRAFT & set(vals) and any(worksheet.state != "draft" for worksheet in self):
            raise UserError(_("Kertas kerja yang sudah diposting atau dibatalkan tidak bisa diubah isinya. Batalkan jurnalnya atau kembalikan ke draft lebih dulu."))
        return super().write(vals)

    def unlink(self):
        if any(worksheet.state == "posted" for worksheet in self):
            raise UserError(_("Kertas kerja yang sudah diposting tidak bisa dihapus. Batalkan jurnal COGM-nya lebih dulu."))
        return super().unlink()

    def _fmt(self, amount):
        """Nominal berformat Indonesia (Rp 1.234.567), sama dengan tampilan UI, terlepas dari bahasa pengguna."""
        self.ensure_one()
        amount = self.currency_id.round(amount)
        decimals = 0 if abs(amount - round(amount)) < 0.005 else self.currency_id.decimal_places
        text = f"{abs(amount):,.{decimals}f}".replace(",", "\x00").replace(".", ",").replace("\x00", ".")
        return f"{'-' if amount < 0 else ''}{self.currency_id.symbol} {text}"

    def _cutoff(self, day=None):
        """Batas akhir hitung stok: akhir hari `day` (bawaan `date_to`) menurut zona waktu pengguna, dalam UTC."""
        self.ensure_one()
        tz = pytz.timezone(self.env.user.tz or self.env.context.get("tz") or "UTC")
        return tz.localize(datetime.combine(day or self.date_to, time.max)).astimezone(pytz.utc).replace(tzinfo=None)

    def _config(self):
        self.ensure_one()
        config = self.env["kompakapps.cogm.config"]._for_company(self.company_id)
        if not config:
            raise UserError(_("Pengaturan COGM untuk %s belum dibuat. Buka Manufacture > Pengaturan COGM dan pilih Siapkan Bawaan.", self.company_id.name))
        return config

    def _ensure_accountant(self):
        if not (self.env.su or self.env.user.has_group("account.group_account_user")):
            raise AccessError(_("Hanya peran Accounting (Akuntan atau Advisor) yang boleh menarik data buku besar, mengeksekusi, atau membatalkan jurnal COGM. Petugas gudang cukup mengisi hasil opname."))

    def _ensure_draft(self):
        for worksheet in self:
            if worksheet.state != "draft":
                raise UserError(_("Kertas kerja %(name)s berstatus %(state)s, bukan draft.", name=worksheet.name, state=dict(STATES)[worksheet.state]))

    # ------------------------------------------------------------------ penarikan data buku besar

    def _gl_sum(self, domain):
        """(debit, kredit) jurnal terposting yang cocok dengan domain, memakai hak sistem karena hasilnya hanya agregat akun yang dipetakan."""
        groups = self.env["account.move.line"].sudo()._read_group(
            [("company_id", "=", self.company_id.id), ("parent_state", "=", "posted"), *domain], [], ["debit:sum", "credit:sum"]
        )
        debit, credit = groups[0] if groups else (0.0, 0.0)
        return debit or 0.0, credit or 0.0

    def _gl_snapshot(self, config):
        """Nilai buku besar yang menjadi isi kertas kerja: saldo awal persediaan dan WIP, serta mutasi periode akun biaya yang dipetakan."""
        self.ensure_one()
        round_ = self.currency_id.round
        values = []
        for section, account in (("rm_opening", config.raw_account_id), ("wip_opening", config.wip_account_id)):
            debit, credit = self._gl_sum([("account_id", "=", account.id), ("date", "<", self.date_from)])
            values.append({"section": section, "account_id": account.id, "debit": debit, "credit": credit, "balance": round_(debit - credit), "pct": 100.0, "amount": round_(debit - credit)})
        mapping = {m.account_id.id: m for m in config.account_ids if m.section in COST_SECTIONS}
        if mapping:
            groups = self.env["account.move.line"].sudo()._read_group(
                [("company_id", "=", self.company_id.id), ("parent_state", "=", "posted"), ("account_id", "in", list(mapping)), ("date", ">=", self.date_from), ("date", "<=", self.date_to)],
                ["account_id"],
                ["debit:sum", "credit:sum"],
            )
            activity = {account.id: (debit or 0.0, credit or 0.0) for account, debit, credit in groups}
            order = {section: index for index, (section, _label) in enumerate(SECTIONS)}
            for account_id, mapped in sorted(mapping.items(), key=lambda item: (order[item[1].section], item[1].account_id.code or "")):
                debit, credit = activity.get(account_id, (0.0, 0.0))
                if not (debit or credit):
                    continue
                balance = round_(debit - credit)
                values.append(
                    {"section": mapped.section, "account_id": account_id, "debit": debit, "credit": credit, "balance": balance, "pct": mapped.pct, "amount": round_(balance * mapped.pct / 100.0)}
                )
        return values

    def action_pull(self):
        """Tarik saldo awal, pembelian bersih, tenaga kerja, dan overhead dari buku besar; segarkan stok sistem pembanding opname."""
        self._ensure_accountant()
        for worksheet in self:
            worksheet._ensure_draft()
            config = worksheet._config()
            values = worksheet._gl_snapshot(config)
            worksheet.line_ids.unlink()
            worksheet.write({"line_ids": [Command.create(v) for v in values], "pulled_at": fields.Datetime.now(), "control_state": "unchecked", "control_checked_at": False})
            worksheet.opname_ids.modified(["product_id"])  # stok sistem dan selisih dihitung ulang
            worksheet.opname_ids._refresh_cost_basis()
            worksheet._pull_outputs()
            worksheet._pull_fg()
            worksheet.message_post(body=_("Data ditarik dari buku besar: periode %(from)s s.d. %(to)s.", **{"from": worksheet.date_from, "to": worksheet.date_to}))
        return True

    def _pull_outputs(self):
        """Qty yang telah diproduksi: jumlah barang jadi dari Manufacturing Order selesai dalam periode, per produk. Baris yang qty-nya diubah petugas (manual) tidak ditimpa."""
        self.ensure_one()
        productions = self.env["mrp.production"].sudo().search(
            [
                ("company_id", "=", self.company_id.id), ("state", "=", "done"),
                ("date_finished", ">", self._cutoff(self.date_from - timedelta(days=1))), ("date_finished", "<=", self._cutoff()),
            ]
        )
        totals = defaultdict(float)
        for production in productions:
            totals[production.product_id] += production.product_uom_id._compute_quantity(production.qty_produced, production.product_id.uom_id)
        existing = {line.product_id: line for line in self.output_ids}
        commands = []
        for product, qty in totals.items():
            line = existing.get(product)
            if not line:
                commands.append(Command.create({"product_id": product.id, "mo_qty": qty, "qty": qty, "source": "mo"}))
            else:
                commands.append(Command.update(line.id, {"mo_qty": qty, **({"qty": qty} if line.source == "mo" else {})}))
        for product, line in existing.items():
            if product not in totals and line.source == "mo":
                commands.append(Command.update(line.id, {"mo_qty": 0.0, "qty": 0.0}))
        if commands:
            self.with_context(kompakapps_output_auto=True).write({"output_ids": commands})

    def _stock_qty(self, product, day=None):
        """Stok sistem `product` pada akhir hari `day` (bawaan akhir periode); nol bila stoknya tidak dilacak."""
        self.ensure_one()
        product = product.sudo().with_company(self.company_id)
        if not product.is_storable:
            return 0.0
        return product.with_context(to_date=self._cutoff(day), allowed_company_ids=[self.company_id.id]).qty_available

    def _fg_basis(self, product):
        """Dasar HPP penjualan satu barang jadi: stok awal dan biayanya, pengiriman ke pelanggan, dan HPP sementara yang sudah dibukukan pada akun HPP."""
        self.ensure_one()
        company = self.company_id
        product = product.sudo().with_company(company)
        config = self.env["kompakapps.cogm.config"]._for_company(company)
        previous = self.env["kompakapps.cogm.fg"].sudo().search(
            [("product_id", "=", product.id), ("worksheet_id.company_id", "=", company.id), ("worksheet_id.state", "=", "posted"), ("worksheet_id.date_to", "<", self.date_from)]
        )
        previous = previous.sorted(lambda line: line.worksheet_id.date_to, reverse=True)[:1]
        moves = self.env["stock.move"].sudo().search(
            [
                ("company_id", "=", company.id), ("product_id", "=", product.id), ("state", "=", "done"),
                ("date", ">", self._cutoff(self.date_from - timedelta(days=1))), ("date", "<=", self._cutoff()),
                "|", ("location_dest_id.usage", "=", "customer"), ("location_id.usage", "=", "customer"),
            ]
        )
        delivered = 0.0
        for move in moves:
            quantity = move.product_uom._compute_quantity(move.quantity, product.uom_id)
            delivered += quantity if move.location_dest_id.usage == "customer" and move.location_id.usage != "customer" else -quantity
        provisional = self._fg_provisional(product, config)
        return {
            "opening_qty": max(self._stock_qty(product, self.date_from - timedelta(days=1)), 0.0), "opening_cost": previous.unit_cost if previous else product.standard_price,
            "delivered_qty": delivered, "provisional_cogs": provisional,
        }

    def _fg_provisional(self, product, config):
        """HPP sementara: saldo akun HPP pada baris bertanda produk ini dalam periode, di luar jurnal kertas kerja COGM."""
        self.ensure_one()
        if not config.cogs_account_id:
            return 0.0
        debit, credit = self._gl_sum(
            [("account_id", "=", config.cogs_account_id.id), ("product_id", "=", product.id), ("date", ">=", self.date_from), ("date", "<=", self.date_to), ("move_id.kompakapps_cogm_id", "=", False)]
        )
        return self.currency_id.round(debit - credit)

    def _pull_fg(self):
        """Barang jadi yang masuk perhitungan HPP penjualan: yang diproduksi pada periode, dan barang buatan (punya BoM) yang punya stok awal. Hanya yang stoknya dilacak."""
        self.ensure_one()
        products = self.output_ids.product_id.filtered("is_storable")
        boms = self.env["mrp.bom"].sudo().search([("type", "=", "normal"), ("company_id", "in", [self.company_id.id, False])])
        for product in boms.product_tmpl_id.product_variant_ids.filtered("is_storable") - products:
            if self._stock_qty(product, self.date_from - timedelta(days=1)) > 0:
                products |= product
        existing = self.fg_ids.mapped("product_id")
        new = products - existing
        if new:
            self.write({"fg_ids": [Command.create({"product_id": product.id}) for product in new]})
        self.fg_ids.filtered(lambda line: line.product_id in existing)._refresh_fg_basis()

    # ------------------------------------------------------------------ bantuan untuk UI

    @api.model
    def kompakapps_defaults(self):
        """Periode bawaan (bulan lalu) dan apakah pengaturan COGM perusahaan aktif sudah ada."""
        config = self.env["kompakapps.cogm.config"]._for_company(self.env.company)
        return {
            "date_from": fields.Date.to_string(self._default_date_from()),
            "date_to": fields.Date.to_string(self._default_date_to()),
            "configured": bool(config),
            "can_execute": bool(self.env.su or self.env.user.has_group("account.group_account_user")),
            "tolerance_pct": config.tolerance_pct if config else 0.0,
            "cost_method": config.cost_method if config else "standard",
            "update_product_cost": bool(config and config.update_product_cost),
            "adjust_stock": bool(config and config.adjust_stock),
        }

    @api.model
    def kompakapps_product_info(self, product_ids, date_to=None, date_from=None):
        """Satuan, stok sistem pada akhir periode, dan dasar biaya (saldo awal, pembelian, rata-rata tertimbang) untuk bahan baku di formulir opname."""
        products = self.env["product.product"].browse(product_ids).sudo().with_company(self.env.company)
        date_to = fields.Date.to_date(date_to) or self._default_date_to()
        date_from = fields.Date.to_date(date_from) or date_to.replace(day=1)
        proxy = self.new({"company_id": self.env.company.id, "date_from": date_from, "date_to": date_to})
        cutoff = proxy._cutoff()
        result = {}
        for product in products:
            stock = product.with_context(to_date=cutoff, allowed_company_ids=[self.env.company.id]).qty_available if product.is_storable else 0.0
            result[product.id] = {"uom": product.uom_id.display_name, "is_storable": product.is_storable, "book_qty": stock, **proxy._cost_basis(product)}
        return result

    def _cost_basis(self, product):
        """Dasar biaya satu bahan baku untuk periode kertas kerja ini.

        Rata-rata tertimbang periode = (jumlah awal x biaya awal + nilai pembelian) / (jumlah awal + jumlah dibeli). Jumlah awal adalah stok sistem akhir hari
        sebelum periode; biaya awal adalah biaya akhir kertas kerja terposting sebelumnya (atau biaya produk bila belum ada); pembelian adalah baris tagihan vendor
        terposting pada akun pembelian periode itu, dikurangi retur. Bahan yang stoknya tidak dilacak tidak punya jumlah awal, jadi memakai biaya produk.
        """
        self.ensure_one()
        company = self.company_id
        product = product.sudo().with_company(company)
        standard = product.standard_price
        config = self.env["kompakapps.cogm.config"]._for_company(company)
        basis = {"opening_qty": 0.0, "opening_cost": standard, "purchase_qty": 0.0, "purchase_value": 0.0, "avg_cost": standard, "unit_cost": standard, "cost_source": "standard"}
        if not product.is_storable:
            return basis
        precision = self.env["decimal.precision"].precision_get("Product Price")
        opening_qty = max(product.with_context(to_date=self._cutoff(self.date_from - timedelta(days=1)), allowed_company_ids=[company.id]).qty_available, 0.0)
        previous = self.env["kompakapps.cogm.opname"].sudo().search(
            [("product_id", "=", product.id), ("worksheet_id.company_id", "=", company.id), ("worksheet_id.state", "=", "posted"), ("worksheet_id.date_to", "<", self.date_from)]
        )
        previous = previous.sorted(lambda line: line.worksheet_id.date_to, reverse=True)[:1]
        opening_cost = previous.unit_cost if previous else standard
        purchase_accounts = config.account_ids.filtered(lambda m: m.section == "purchase").account_id
        lines = self.env["account.move.line"].sudo().search(
            [
                ("company_id", "=", company.id), ("parent_state", "=", "posted"), ("product_id", "=", product.id), ("move_id.move_type", "in", ("in_invoice", "in_refund")),
                ("account_id", "in", purchase_accounts.ids), ("date", ">=", self.date_from), ("date", "<=", self.date_to),
            ]
        )
        purchase_qty = purchase_value = 0.0
        for line in lines:
            sign = -1.0 if line.move_id.move_type == "in_refund" else 1.0
            purchase_qty += sign * line.product_uom_id._compute_quantity(line.quantity, product.uom_id)
            purchase_value += line.balance
        total_qty = opening_qty + purchase_qty
        total_value = opening_qty * opening_cost + purchase_value
        avg_cost = float_round(total_value / total_qty, precision_digits=precision) if total_qty > 0 and total_value > 0 else opening_cost
        basis.update(opening_qty=opening_qty, opening_cost=opening_cost, purchase_qty=purchase_qty, purchase_value=purchase_value, avg_cost=avg_cost)
        if config and config.cost_method == "average":
            basis.update(unit_cost=avg_cost, cost_source="average")
        return basis

    @api.model
    def bom_cost_split(self, product_id):
        """(biaya bahan, biaya konversi) per unit barang jadi menurut BoM-nya; tanpa BoM seluruh biaya produk dianggap bahan."""
        product = self.env["product.product"].browse(product_id).sudo().with_company(self.env.company)
        bom = self.env["mrp.bom"]._bom_find(product)[product]
        if not bom:
            return product.standard_price, 0.0
        operations = sum(operation.cost for operation in bom.operation_ids if not operation._skip_operation_line(product))
        conversion = bom.product_uom_id._compute_price(operations / bom.product_qty, product.uom_id)
        total = product._compute_bom_price(bom)
        return max(total - conversion, 0.0), conversion

    # ------------------------------------------------------------------ Control Balance

    def _check(self, key, title, status, message, **extra):
        return {"key": key, "title": title, "status": status, "message": message, **extra}

    def _run_checks(self):
        """Rangkaian pemeriksaan Control Balance. Status tiap pemeriksaan: ok, error (Merah), warn, atau info. Hijau bila tidak ada error."""
        self.ensure_one()
        checks = []

        def add(*args, **kwargs):
            checks.append(self._check(*args, **kwargs))

        config = self.env["kompakapps.cogm.config"]._for_company(self.company_id)
        missing = []
        if not config:
            missing.append(_("pengaturan COGM perusahaan belum dibuat"))
        else:
            if not config.account_ids.filtered(lambda m: m.section in COST_SECTIONS):
                missing.append(_("belum ada akun biaya yang dipetakan"))
        if missing:
            add("config", _("Pengaturan COGM lengkap"), "error", _("Belum lengkap: %s. Buka Manufacture > Pengaturan COGM.", "; ".join(missing)))
            return checks
        add("config", _("Pengaturan COGM lengkap"), "ok", _("%d akun biaya dipetakan.", len(config.account_ids.filtered(lambda m: m.section in COST_SECTIONS))))

        # Periode: tidak boleh tumpang tindih dengan kertas kerja lain yang sudah diposting; celah diberi peringatan.
        overlap = self.search(
            [("id", "!=", self.id), ("company_id", "=", self.company_id.id), ("state", "=", "posted"), ("date_from", "<=", self.date_to), ("date_to", ">=", self.date_from)], limit=1
        )
        previous = self.search([("id", "!=", self.id), ("company_id", "=", self.company_id.id), ("state", "=", "posted"), ("date_to", "<", self.date_from)], order="date_to desc", limit=1)
        if overlap:
            add("period", _("Periode tidak tumpang tindih"), "error", _("Periode ini beririsan dengan %(name)s (%(from)s s.d. %(to)s) yang sudah diposting.", name=overlap.name, **{"from": overlap.date_from, "to": overlap.date_to}))
        elif previous and (self.date_from - previous.date_to).days > 1:
            add("period", _("Periode bersambung"), "warn", _("Ada celah antara %(name)s (sampai %(to)s) dan periode ini; saldo awal diambil dari buku besar apa adanya.", name=previous.name, to=previous.date_to))
        else:
            add("period", _("Periode bersambung"), "ok", _("Tidak tumpang tindih dan bersambung dengan periode sebelumnya.") if previous else _("Kertas kerja pertama untuk perusahaan ini; saldo awal diambil dari buku besar."))

        # Data buku besar harus sudah ditarik dan masih sama dengan buku besar saat ini.
        if not self.pulled_at:
            add("fresh", _("Data buku besar mutakhir"), "error", _("Data buku besar belum ditarik. Tekan Tarik dari Buku Besar."))
        else:
            live = {(v["section"], v["account_id"]): v["amount"] for v in self._gl_snapshot(config)}
            stored = {(line.section, line.account_id.id): line.amount for line in self.line_ids}
            changed = [key for key in live.keys() | stored.keys() if abs(live.get(key, 0.0) - stored.get(key, 0.0)) > 0.005]
            if changed:
                names = ", ".join(self.env["account.account"].browse(account).display_name for _section, account in changed[:3])
                add("fresh", _("Data buku besar mutakhir"), "error", _("Buku besar berubah sejak ditarik (%(n)d akun, mis. %(names)s). Tekan Tarik dari Buku Besar lagi.", n=len(changed), names=names))
            else:
                add("fresh", _("Data buku besar mutakhir"), "ok", _("Sama dengan buku besar saat ini (ditarik %s).", fields.Datetime.context_timestamp(self, self.pulled_at).strftime("%d/%m/%Y %H:%M")))

        # Akun biaya berawalan kode tertentu yang bergerak tetapi belum diklasifikasikan = selisih tak teralokasi.
        prefixes = tuple(p.strip() for p in (config.scan_prefix or "").split(",") if p.strip())
        if prefixes:
            known = config.account_ids.account_id | config._system_accounts()
            groups = self.env["account.move.line"].sudo()._read_group(
                [
                    ("company_id", "=", self.company_id.id), ("parent_state", "=", "posted"), ("date", ">=", self.date_from), ("date", "<=", self.date_to),
                    ("account_id", "not in", known.ids), ("account_id.account_type", "in", ("expense", "expense_direct_cost", "expense_depreciation", "expense_other")),
                ],
                ["account_id"],
                ["debit:sum", "credit:sum"],
            )
            loose = [(account, debit - credit) for account, debit, credit in groups if (account.with_company(self.company_id).code or "").startswith(prefixes) and (debit or credit)]
            if loose:
                detail = "; ".join(f"{account.display_name} ({self._fmt(balance)})" for account, balance in loose[:4])
                add(
                    "unmapped", _("Semua akun biaya produksi terklasifikasi"), "error",
                    _("%(n)d akun berawalan %(prefix)s bergerak pada periode tetapi belum diklasifikasikan: %(detail)s. Petakan sebagai Pembelian, Tenaga Kerja, Overhead, atau Bukan Biaya Produksi di Pengaturan COGM.", n=len(loose), prefix="/".join(prefixes), detail=detail),
                )
            else:
                add("unmapped", _("Semua akun biaya produksi terklasifikasi"), "ok", _("Tidak ada akun berawalan %s yang bergerak tanpa klasifikasi.", "/".join(prefixes)))

        # Pada sistem periodik akun persediaan hanya disesuaikan saat tutup periode; mutasi di tengah periode menandakan sistem perpetual atau salah jurnal.
        inventory = config.raw_account_id | config.wip_account_id
        in_period = [("account_id", "in", inventory.ids), ("date", ">=", self.date_from), ("date", "<=", self.date_to), ("move_id.kompakapps_cogm_id", "=", False)]
        debit, credit = self._gl_sum(in_period)
        movement = self.env["account.move.line"].sudo().search_count([("company_id", "=", self.company_id.id), ("parent_state", "=", "posted"), *in_period])
        if movement:
            add(
                "inventory", _("Akun persediaan tidak bergerak selama periode"), "error",
                _("Akun %(accounts)s punya %(n)d baris jurnal pada periode ini (bersih %(net)s). Skema periodik menyesuaikan akun persediaan hanya lewat jurnal COGM; pergerakan di tengah periode (mis. jurnal stok perpetual) membuat saldo akhirnya tidak sama dengan hasil opname.", accounts=", ".join(inventory.mapped("display_name")), n=movement, net=self._fmt(debit - credit)),
            )
        else:
            add("inventory", _("Akun persediaan tidak bergerak selama periode"), "ok", _("Persediaan bahan baku dan WIP hanya berubah lewat jurnal COGM."))

        # Opname bahan baku.
        opname = self.opname_ids
        if not opname and self.rm_available > 0:
            add("opname", _("Opname bahan baku lengkap"), "error", _("Bahan baku tersedia %s tetapi belum ada hasil opname. Isi jumlah fisik (isi 0 bila habis).", self._fmt(self.rm_available)))
        else:
            add("opname", _("Opname bahan baku lengkap"), "ok", _("%(n)d bahan baku dihitung, nilai akhir %(value)s.", n=len(opname), value=self._fmt(self.rm_ending)))
        no_cost = opname.filtered(lambda line: line.qty > 0 and line.unit_cost <= 0)
        no_cost_wip = self.wip_ids.filtered(lambda line: line.qty > 0 and line.material_cost <= 0 and line.conversion_cost <= 0)
        if no_cost or no_cost_wip:
            names = ", ".join((no_cost.mapped("product_id.display_name") + no_cost_wip.mapped("name"))[:4])
            add("cost", _("Biaya per unit terisi"), "error", _("Ada jumlah tanpa biaya per unit: %s. Nilai persediaan akan nol dan COGM salah.", names))
        else:
            sources = Counter(opname.mapped("cost_source"))
            add(
                "cost", _("Biaya per unit terisi"), "ok",
                _("Semua baris punya biaya per unit (%(avg)d rata-rata tertimbang periode, %(std)d biaya produk, %(man)d manual).", avg=sources["average"], std=sources["standard"], man=sources["manual"]),
            )

        # Hitung fisik vs stok sistem: salah ketik terlihat sebagai selisih besar.
        tracked = opname.filtered("is_storable")
        if tracked:
            off = tracked.filtered(lambda line: abs(line.variance_qty) > line._tolerance_qty(config.tolerance_pct) + 1e-9)
            unexplained = off.filtered(lambda line: not (line.explanation or "").strip())
            if unexplained:
                detail = "; ".join(
                    f"{line.product_id.display_name}: fisik {line.qty:g}, sistem {line.book_qty:g} ({line.variance_qty:+g} {line.uom_id.name})" for line in unexplained[:4]
                )
                add(
                    "variance", _("Selisih opname terhadap stok sistem wajar"), "error",
                    _("%(n)d bahan baku selisih di atas toleransi %(tol)g%% tanpa alasan: %(detail)s. Periksa salah ketik atau isi Alasan Selisih.", n=len(unexplained), tol=config.tolerance_pct, detail=detail),
                )
            elif off:
                add("variance", _("Selisih opname terhadap stok sistem wajar"), "ok", _("%(n)d selisih di atas toleransi sudah dijelaskan (nilai %(value)s).", n=len(off), value=self._fmt(sum(off.mapped("variance_value")))))
            else:
                add("variance", _("Selisih opname terhadap stok sistem wajar"), "ok", _("Semua hitungan fisik dalam toleransi %g%% terhadap stok sistem.", config.tolerance_pct))
        else:
            add("variance", _("Selisih opname terhadap stok sistem wajar"), "info", _("Tidak ada bahan baku berlacak stok untuk dibandingkan dengan stok sistem."))

        # Kewajaran angka.
        if self.rm_used < 0:
            add("usage", _("Bahan baku terpakai tidak negatif"), "error", _("Persediaan akhir %(end)s melebihi bahan baku tersedia %(available)s, sehingga terpakai %(used)s. Periksa hasil opname dan pembelian.", end=self._fmt(self.rm_ending), available=self._fmt(self.rm_available), used=self._fmt(self.rm_used)))
        else:
            add("usage", _("Bahan baku terpakai tidak negatif"), "ok", _("Terpakai %(used)s dari tersedia %(available)s.", used=self._fmt(self.rm_used), available=self._fmt(self.rm_available)))
        if self.wip_opening > 0 and not self.wip_ids:
            add("wip", _("Opname WIP lengkap"), "warn", _("WIP awal %s tetapi tidak ada WIP akhir: dianggap seluruhnya sudah selesai.", self._fmt(self.wip_opening)))
        else:
            add("wip", _("Opname WIP lengkap"), "ok", _("%(n)d baris WIP, nilai akhir %(value)s.", n=len(self.wip_ids), value=self._fmt(self.wip_ending)))
        if self.cogm < 0:
            add("cogm", _("COGM tidak negatif"), "error", _("COGM %s negatif. Periksa WIP akhir dan persediaan akhir.", self._fmt(self.cogm)))
        else:
            add("cogm", _("COGM tidak negatif"), "ok", _("COGM %s.", self._fmt(self.cogm)))

        # Pembagi HPP per unit: qty yang telah diproduksi.
        outputs = self.output_ids
        if self.cogm != 0 and self.qty_produced <= 0:
            add("output", _("Qty diproduksi terisi"), "error", _("COGM %s belum bisa dibagi: isi qty barang jadi yang diproduksi pada periode ini (otomatis dari MO selesai, atau ketik manual).", self._fmt(self.cogm)))
        elif outputs and len(outputs.uom_id) > 1:
            add("output", _("Qty diproduksi terisi"), "warn", _("Barang jadi memakai satuan berbeda (%s) tetapi qty-nya dijumlahkan sebagai pembagi. Pastikan satuannya sebanding.", ", ".join(outputs.uom_id.mapped("name"))))
        elif outputs:
            add("output", _("Qty diproduksi terisi"), "ok", _("%(qty)g unit diproduksi (%(n)d barang jadi); HPP per unit %(unit)s.", qty=self.qty_produced, n=len(outputs), unit=self._fmt(self.unit_cogm)))
        else:
            add("output", _("Qty diproduksi terisi"), "info", _("Tidak ada produksi dan COGM nol; tidak ada yang dibagi."))

        # HPP penjualan: barang jadi (qty awal + produksi - stok akhir = terjual) dinilai pada biaya rata-rata tertimbang.
        fg = self.fg_ids
        if fg:
            problems = []
            stale = fg.filtered(lambda line: abs(self._fg_provisional(line.product_id, config) - line.provisional_cogs) > 0.005)
            if stale:
                problems.append(_("HPP sementara di buku besar berubah sejak ditarik (%s): tarik ulang.", ", ".join(stale.mapped("product_id.display_name")[:3])))
            over = fg.filtered(lambda line: line.sold_qty < -1e-9)
            if over:
                problems.append(_("stok akhir melebihi yang tersedia (stok awal + produksi) pada %s: periksa hitung fisik dan qty diproduksi.", ", ".join(over.mapped("product_id.display_name")[:3])))
            no_cost = fg.filtered(lambda line: line.available_qty > 0 and line.unit_cost <= 0)
            if no_cost:
                problems.append(_("biaya per unit nol pada %s.", ", ".join(no_cost.mapped("product_id.display_name")[:3])))
            if problems:
                add("cogs", _("HPP penjualan barang jadi"), "error", "; ".join(str(p) for p in problems).capitalize())
            elif not config.cogs_account_id:
                add("cogs", _("HPP penjualan barang jadi"), "warn", _("Akun HPP penjualan belum dipilih di Pengaturan COGM, jadi HPP aktual %s tidak dijurnal.", self._fmt(self.fg_cogs)))
            else:
                add(
                    "cogs", _("HPP penjualan barang jadi"), "ok",
                    _("HPP aktual %(cogs)s untuk %(sold)g unit terjual; sementara %(prov)s; penyesuaian %(adj)s; nilai stok akhir %(end)s.", cogs=self._fmt(self.fg_cogs), sold=sum(fg.mapped("sold_qty")), prov=self._fmt(self.fg_provisional), adj=self._fmt(self.fg_adjustment), end=self._fmt(self.fg_ending_value)),
                )
            # Saldo awal akun barang jadi di buku besar seharusnya sama dengan nilai barang jadi awal per produk.
            debit, credit = self._gl_sum([("account_id", "=", config.fg_account_id.id), ("date", "<", self.date_from)])
            opening_gl = self.currency_id.round(debit - credit)
            opening_fg = self.currency_id.round(sum(fg.mapped("opening_value")))
            if abs(opening_gl - opening_fg) > 0.5:
                add(
                    "fg_gl", _("Saldo awal Inventory COGM cocok"), "warn",
                    _("Saldo awal %(account)s di buku besar %(gl)s berbeda dari nilai barang jadi awal %(fg)s (selisih %(diff)s), mis. COGM bulan sebelumnya yang barang jadinya belum dilacak. Selisih ini tidak ikut dihitung sebagai HPP.", account=config.fg_account_id.display_name, gl=self._fmt(opening_gl), fg=self._fmt(opening_fg), diff=self._fmt(opening_gl - opening_fg)),
                )
            tolerance = config.tolerance_pct
            off = fg.filtered(lambda line: abs(line.variance_qty) > abs(line.book_qty) * tolerance / 100.0 + 1e-9)
            unexplained = off.filtered(lambda line: not (line.explanation or "").strip())
            if unexplained:
                detail = "; ".join(f"{line.product_id.display_name}: fisik {line.qty:g}, sistem {line.book_qty:g} ({line.variance_qty:+g})" for line in unexplained[:3])
                add("fg_variance", _("Stok akhir barang jadi wajar"), "error", _("%(n)d barang jadi selisih di atas toleransi %(tol)g%% tanpa alasan: %(detail)s.", n=len(unexplained), tol=tolerance, detail=detail))
            else:
                add("fg_variance", _("Stok akhir barang jadi wajar"), "ok", _("Stok akhir barang jadi dalam toleransi atau sudah dijelaskan."))

        # Jurnal yang akan dibuat harus seimbang dan angka COGM-nya harus sama dengan kertas kerja.
        lines = self._journal_lines(config)
        debit_total = round(sum(line[1] for line in lines), 2)
        credit_total = round(sum(line[2] for line in lines), 2)
        fg_debit = sum(line[1] - line[2] for line in lines if line[0] == config.fg_account_id)
        fg_expected = self.cogm - (self.fg_adjustment if config.cogs_account_id else 0.0)  # akun barang jadi menerima COGM dan dikurangi penyesuaian HPP penjualan
        if abs(debit_total - credit_total) > 0.005 or abs(fg_debit - fg_expected) > 0.005:
            add(
                "journal", _("Jurnal COGM seimbang"), "error",
                _("Jurnal tidak seimbang atau tidak sama dengan kertas kerja: Debit %(d)s, Kredit %(c)s, COGM di jurnal %(fg)s, COGM kertas kerja %(cogm)s.", d=self._fmt(debit_total), c=self._fmt(credit_total), fg=self._fmt(fg_debit), cogm=self._fmt(fg_expected)),
                expected=fg_expected, actual=fg_debit,
            )
        else:
            add("journal", _("Jurnal COGM seimbang"), "ok", _("Debit = Kredit = %(total)s; selisih 0.", total=self._fmt(debit_total)), expected=debit_total, actual=credit_total)

        # Penyesuaian stok dan biaya produk yang akan dilakukan saat Execute.
        if config.adjust_stock and (opname or self.fg_ids):
            todo, skipped = self._adjustment_plan(config)
            manual = self._manual_adjustments_after_period()
            notes = []
            if todo:
                notes.append(_("Saat Execute stok sistem disesuaikan ke hasil opname untuk %(n)d bahan (bersih %(net)+g).", n=len(todo), net=sum(delta for _line, delta in todo)))
            if skipped:
                notes.append(_("%(n)d bahan tidak disesuaikan otomatis: %(names)s. Sesuaikan lewat Physical Inventory.", n=len(skipped), names="; ".join(f"{line.product_id.display_name} ({reason})" for line, reason in skipped[:3])))
            if manual:
                notes.append(_("Sudah ada %(n)d penyesuaian stok manual setelah akhir periode pada bahan ini; pastikan tidak menyesuaikan dua kali.", n=manual))
            if notes:
                add("adjust", _("Penyesuaian stok saat Execute"), "warn" if (skipped or manual) else "info", " ".join(notes))
            else:
                add("adjust", _("Penyesuaian stok saat Execute"), "ok", _("Stok sistem sudah sama dengan hasil opname; tidak ada penyesuaian."))

        # Dokumen belum diposting pada periode untuk akun terkait.
        related = config.account_ids.filtered(lambda m: m.section in COST_SECTIONS).account_id | config.raw_account_id | config.wip_account_id
        drafts = self.env["account.move.line"].sudo().search_count(
            [("company_id", "=", self.company_id.id), ("parent_state", "=", "draft"), ("account_id", "in", related.ids), ("date", ">=", self.date_from), ("date", "<=", self.date_to)]
        )
        if drafts:
            add("drafts", _("Tidak ada dokumen draf pada periode"), "warn", _("Ada %d baris jurnal draf pada akun terkait di periode ini (tagihan atau jurnal belum diposting). Nilainya belum masuk COGM.", drafts))
        else:
            add("drafts", _("Tidak ada dokumen draf pada periode"), "ok", _("Semua dokumen pada akun terkait sudah diposting."))
        return checks

    def action_check(self):
        """Jalankan Control Balance, simpan statusnya (Hijau atau Merah), dan kembalikan rinciannya untuk ditampilkan."""
        self.ensure_one()
        if self.state == "draft":
            self.opname_ids.modified(["product_id"])  # stok sistem pembanding dihitung ulang (pergerakan stok bisa berubah sejak ditarik)
        checks = self._run_checks()
        errors = [check for check in checks if check["status"] == "error"]
        state = "red" if errors else "green"
        if self.state == "draft" and (self.control_state != state):
            self.write({"control_state": state, "control_checked_at": fields.Datetime.now()})
        return {"state": state, "errors": len(errors), "warnings": len([c for c in checks if c["status"] == "warn"]), "checks": checks}

    # ------------------------------------------------------------------ jurnal COGM

    def _journal_lines(self, config):
        """Baris jurnal COGM: [(akun, debit, kredit, label)].

        Seluruh unsur dikumpulkan di akun ikhtisar (Dr biaya periode dan persediaan awal, Cr persediaan akhir), lalu COGM dipindah dari ikhtisar ke persediaan
        barang jadi. Akun ikhtisar berakhir nol; akun biaya ditutup; persediaan bahan baku dan WIP berakhir sebesar hasil opname.
        """
        self.ensure_one()
        round_ = self.currency_id.round
        summary = config.summary_account_id
        lines = []

        def move(account, amount, label):
            amount = round_(amount)
            if amount > 0:
                lines.append((account, amount, 0.0, label))
            elif amount < 0:
                lines.append((account, 0.0, -amount, label))

        titles = dict(LINE_SECTIONS)
        section_total = defaultdict(float)
        for line in self.line_ids.filtered(lambda line: line.section in COST_SECTIONS):
            move(line.account_id, -line.amount, _("Tutup %s ke COGM", line.account_id.display_name))
            section_total[line.section] += line.amount
        for section in COST_SECTIONS:
            move(summary, section_total[section], titles[section])
        move(summary, self.rm_opening, titles["rm_opening"])
        move(config.raw_account_id, -self.rm_opening, _("Tutup %s awal", config.raw_account_id.display_name))
        move(config.raw_account_id, self.rm_ending, _("Persediaan bahan baku akhir (opname)"))
        move(summary, -self.rm_ending, _("Persediaan bahan baku akhir (opname)"))
        move(summary, self.wip_opening, titles["wip_opening"])
        move(config.wip_account_id, -self.wip_opening, _("Tutup %s awal", config.wip_account_id.display_name))
        move(config.wip_account_id, self.wip_ending, _("Barang dalam proses akhir (opname)"))
        move(summary, -self.wip_ending, _("Barang dalam proses akhir (opname)"))
        move(config.fg_account_id, self.cogm, _("COGM periode %(from)s s.d. %(to)s", **{"from": self.date_from, "to": self.date_to}))
        move(summary, -self.cogm, _("COGM dipindah ke persediaan barang jadi"))
        if config.cogs_account_id:
            # HPP penjualan aktual (qty terjual x biaya rata-rata) dikurangi HPP sementara yang sudah dibukukan saat penjualan
            move(config.cogs_account_id, self.fg_adjustment, _("HPP penjualan: penyesuaian terhadap HPP sementara"))
            move(config.fg_account_id, -self.fg_adjustment, _("HPP penjualan barang jadi (penyesuaian)"))
        return lines

    def action_post(self):
        """Eksekusi jurnal COGM. Hanya bila Control Balance Hijau; dicek ulang di server saat ini juga."""
        self._ensure_accountant()
        for worksheet in self:
            worksheet._ensure_draft()
            result = worksheet.action_check()
            if result["state"] != "green":
                failing = "; ".join(check["title"] for check in result["checks"] if check["status"] == "error")
                raise UserError(_("Control Balance Merah, jurnal COGM tidak bisa dieksekusi. Perbaiki dulu: %s.", failing))
            config = worksheet._config()
            lines = worksheet._journal_lines(config)
            move = self.env["account.move"].with_company(worksheet.company_id).create(
                {
                    "move_type": "entry",
                    "journal_id": config.journal_id.id,
                    "date": worksheet.date_to,
                    "ref": _("%(name)s - COGM periode %(from)s s.d. %(to)s", name=worksheet.name, **{"from": worksheet.date_from, "to": worksheet.date_to}),
                    "kompakapps_cogm_id": worksheet.id,
                    "line_ids": [Command.create({"account_id": account.id, "debit": debit, "credit": credit, "name": label}) for account, debit, credit, label in lines],
                }
            )
            move.action_post()
            worksheet._verify_posted(config)
            costs = worksheet._apply_costs(config)
            adjusted, skipped = worksheet._apply_stock_adjustments(config)
            worksheet.write({"state": "posted", "move_id": move.id, "post_user_id": self.env.user.id, "post_date": fields.Datetime.now(), "control_state": "green", "control_checked_at": fields.Datetime.now()})
            worksheet.message_post(
                body=_(
                    "Jurnal COGM %(move)s dieksekusi: COGM %(cogm)s. Biaya produk diperbarui: %(costs)d bahan. Stok disesuaikan: %(adjusted)d bahan, dilewati: %(skipped)d.",
                    move=move.name, cogm=worksheet._fmt(worksheet.cogm), costs=costs, adjusted=adjusted, skipped=skipped,
                )
            )
        return True

    # ------------------------------------------------------------------ biaya produk dan penyesuaian stok saat Execute

    def _adjustment_plan(self, config):
        """([(baris, selisih jumlah)], [(baris, alasan dilewati)]) penyesuaian stok yang dilakukan saat Execute: jumlah fisik dikurangi stok sistem akhir periode."""
        self.ensure_one()
        todo, skipped = [], []
        for line in [*self.opname_ids, *self.fg_ids]:
            product = line.product_id.sudo().with_company(self.company_id)
            if not product.is_storable:
                continue
            delta = line.qty - line.book_qty
            if float_is_zero(delta, precision_rounding=product.uom_id.rounding):
                continue
            if product.tracking != "none":
                skipped.append((line, _("berlacak lot atau serial")))
            elif product.categ_id.property_valuation == "real_time":
                skipped.append((line, _("kategori valuasi perpetual")))
            else:
                todo.append((line, delta))
        return todo, skipped

    def _manual_adjustments_after_period(self):
        """Jumlah penyesuaian stok (inventory adjustment) terselesaikan setelah akhir periode pada bahan dan barang jadi yang dihitung, di luar yang dibuat kertas kerja ini."""
        self.ensure_one()
        products = self.opname_ids.product_id | self.fg_ids.product_id
        own = self.opname_ids.adjust_move_ids | self.fg_ids.adjust_move_ids
        return self.env["stock.move"].sudo().search_count(
            [
                ("company_id", "=", self.company_id.id), ("product_id", "in", products.ids), ("is_inventory", "=", True), ("state", "=", "done"),
                ("date", ">", self._cutoff()), ("id", "not in", own.ids),
            ]
        )

    def _apply_costs(self, config):
        """Ganti biaya produk dengan biaya rata-rata tertimbang periode (baris bersumber rata-rata). Mengembalikan jumlah bahan yang berubah."""
        self.ensure_one()
        if not config.update_product_cost:
            return 0
        changed = 0
        # bahan baku: hanya baris bersumber rata-rata tertimbang; barang jadi: biaya rata-rata tertimbang HPP penjualan
        lines = [*(self.opname_ids.filtered(lambda line: line.cost_source == "average") if config.cost_method == "average" else []), *self.fg_ids]
        for line in lines:
            product = line.product_id.sudo().with_company(self.company_id)
            if product.categ_id.property_valuation == "real_time" or line.unit_cost <= 0 or abs(product.standard_price - line.unit_cost) <= 0.004:
                continue
            line.write({"old_cost": product.standard_price, "cost_updated": True})
            product.standard_price = line.unit_cost
            changed += 1
        return changed

    def _apply_inventory(self, product, location, signed, when):
        """Penyesuaian stok `signed` pada satu lokasi (Inventory Adjustment) bertanggal `when`; mengembalikan pergerakan stok yang terbentuk."""
        Move = self.env["stock.move"].sudo()
        Quant = self.env["stock.quant"].sudo().with_context(inventory_mode=True)
        known = Move.search([("product_id", "=", product.id), ("is_inventory", "=", True)]).ids
        quant = Quant.search([("product_id", "=", product.id), ("location_id", "=", location.id), ("company_id", "=", self.company_id.id)], limit=1)
        if quant:
            quant.inventory_quantity = quant.quantity + signed
        else:
            quant = Quant.create({"product_id": product.id, "location_id": location.id, "inventory_quantity": signed})
        quant.action_apply_inventory()
        moves = Move.search([("product_id", "=", product.id), ("is_inventory", "=", True), ("id", "not in", known)])
        moves.write({"date": when})
        moves.move_line_ids.write({"date": when})
        return moves

    def _adjust_product_stock(self, product, delta, when):
        """Wujudkan `delta` sebagai penyesuaian stok: tambahan masuk ke lokasi stok utama gudang; pengurangan diambil dari lokasi dengan stok terbanyak lebih dulu."""
        self.ensure_one()
        product = product.sudo().with_company(self.company_id)
        main = self.env["stock.warehouse"].sudo().search([("company_id", "=", self.company_id.id)], limit=1).lot_stock_id
        steps = {}
        if delta > 0:
            steps[main] = delta
        else:
            need = -delta
            quants = self.env["stock.quant"].sudo().search([("product_id", "=", product.id), ("company_id", "=", self.company_id.id), ("location_id.usage", "=", "internal")])
            for quant in quants.sorted("quantity", reverse=True):
                take = min(need, max(quant.quantity, 0.0))
                if take > 0:
                    steps[quant.location_id] = steps.get(quant.location_id, 0.0) - take
                    need -= take
                if need <= 1e-9:
                    break
            if need > 1e-9:
                steps[main] = steps.get(main, 0.0) - need  # stok sekarang kurang dari pengurangan: sisanya menjadi saldo negatif di lokasi utama
        moves = self.env["stock.move"]
        for location, signed in steps.items():
            moves |= self._apply_inventory(product, location, signed, when)
        return moves

    def _apply_stock_adjustments(self, config):
        """Samakan stok sistem dengan hasil opname. Mengembalikan (jumlah bahan disesuaikan, jumlah dilewati)."""
        self.ensure_one()
        if not config.adjust_stock:
            return 0, 0
        todo, skipped = self._adjustment_plan(config)
        when = self._cutoff()
        for line, delta in todo:
            moves = self._adjust_product_stock(line.product_id, delta, when)
            line.write({"adjust_qty": delta, "adjust_move_ids": [Command.link(move.id) for move in moves]})
        return len(todo), len(skipped)

    def _reverse_costs_and_stock(self):
        """Kembalikan biaya produk dan penyesuaian stok yang dibuat saat Execute (dipanggil setelah kertas kerja kembali ke draft)."""
        self.ensure_one()
        when = self._cutoff()
        for line in [*self.opname_ids, *self.fg_ids]:
            product = line.product_id.sudo().with_company(self.company_id)
            if line.cost_updated:
                if abs(product.standard_price - line.unit_cost) <= 0.004:  # tidak menimpa biaya yang sudah diubah pihak lain sesudah Execute
                    product.standard_price = line.old_cost
                line.write({"cost_updated": False, "old_cost": 0.0})
            if line.adjust_move_ids:
                net = defaultdict(float)
                for move in line.adjust_move_ids.sudo():
                    if move.location_dest_id.usage == "internal" and move.location_id.usage != "internal":
                        net[move.location_dest_id] += move.quantity
                    elif move.location_id.usage == "internal" and move.location_dest_id.usage != "internal":
                        net[move.location_id] -= move.quantity
                moves = self.env["stock.move"]
                for location, signed in net.items():
                    if not float_is_zero(signed, precision_rounding=product.uom_id.rounding):
                        moves |= self._apply_inventory(product, location, -signed, when)
                line.write({"adjust_qty": 0.0, "adjust_move_ids": [Command.link(move.id) for move in moves]})

    def _verify_posted(self, config):
        """Rekonsiliasi pasca-posting: saldo persediaan dan WIP sama dengan hasil opname dan akun ikhtisar berakhir nol. Gagal = seluruh transaksi dibatalkan."""
        self.ensure_one()
        expectations = (
            (config.raw_account_id, self.rm_ending, [("date", "<=", self.date_to)]),
            (config.wip_account_id, self.wip_ending, [("date", "<=", self.date_to)]),
            (config.summary_account_id, 0.0, [("move_id.kompakapps_cogm_id", "=", self.id)]),
        )
        for account, wanted, scope in expectations:
            debit, credit = self._gl_sum([("account_id", "=", account.id), *scope])
            balance = self.currency_id.round(debit - credit)
            if abs(balance - wanted) > 0.005:
                raise UserError(_("Rekonsiliasi pasca-posting gagal pada %(account)s: saldo %(balance)s, seharusnya %(wanted)s. Jurnal dibatalkan.", account=account.display_name, balance=self._fmt(balance), wanted=self._fmt(wanted)))

    def action_reverse(self):
        """Batalkan jurnal COGM yang sudah diposting dengan jurnal pembalik pada tanggal yang sama, lalu kembalikan kertas kerja ke draft."""
        self._ensure_accountant()
        for worksheet in self:
            if worksheet.state != "posted":
                raise UserError(_("Hanya kertas kerja yang sudah diposting yang jurnalnya bisa dibatalkan."))
            move = worksheet.move_id
            reversal = move._reverse_moves([{"date": move.date, "ref": _("Pembalik %s", move.name), "kompakapps_cogm_id": worksheet.id}], cancel=True)
            worksheet.write({"state": "draft", "move_id": False, "post_user_id": False, "post_date": False, "control_state": "unchecked", "control_checked_at": False})
            worksheet._reverse_costs_and_stock()
            worksheet.message_post(body=_("Jurnal COGM %(move)s dibatalkan dengan %(reversal)s; biaya produk dan penyesuaian stok dikembalikan; kertas kerja kembali ke draft.", move=move.name, reversal=reversal.name))
        return True

    def action_cancel(self):
        for worksheet in self:
            worksheet._ensure_draft()
        self.write({"state": "cancel"})
        return True

    def action_draft(self):
        for worksheet in self:
            if worksheet.state != "cancel":
                raise UserError(_("Hanya kertas kerja yang dibatalkan yang bisa dikembalikan ke draft."))
        self.write({"state": "draft", "control_state": "unchecked", "control_checked_at": False})
        return True


class AccountMove(models.Model):
    _inherit = "account.move"

    kompakapps_cogm_id = fields.Many2one("kompakapps.cogm.worksheet", string="Kertas Kerja COGM", readonly=True, copy=False, index="btree_not_null", ondelete="restrict")
