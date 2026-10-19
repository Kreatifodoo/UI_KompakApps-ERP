"""Jurnal akuntansi pada transaksi inventori mengikuti pola Product Category (Q49, D69).

Odoo 19 hanya menjurnal stok saat tagihan vendor atau faktur pelanggan diposting ("Perpetual (at invoicing)"): penerimaan dan pengiriman barang
tidak membuat jurnal, dan pergerakan stok baru dijurnal bila lokasi lawannya punya akun valuasi. Di sini setiap transaksi inventori dijurnal pada
saat terjadinya, memakai akun dan jurnal dari Product Category (pola Odoo versi lama):

| Transaksi                          | Jurnal                                                                |
|------------------------------------|-----------------------------------------------------------------------|
| Penerimaan dari vendor             | Dr Akun Valuasi Persediaan, Cr Barang Diterima Belum Ditagih           |
| Tagihan vendor diposting           | Dr Barang Diterima Belum Ditagih, Cr Hutang Usaha (pembersih)          |
| Pengiriman ke pelanggan            | Dr Barang Terkirim Belum Ditagih, Cr Akun Valuasi Persediaan           |
| Faktur pelanggan diposting         | Dr HPP, Cr Barang Terkirim Belum Ditagih (pembersih)                   |
| Retur penerimaan atau pengiriman   | kebalikan dari jurnal asalnya                                          |
| Stock opname, scrap, produksi      | akun pada lokasi virtual (Inventory adjustment, Scrap, Production)     |

Akun Barang Diterima dan Barang Terkirim Belum Ditagih adalah dua field baru pada kategori produk. Semuanya hanya berlaku bila kedua akun terisi dan produk
berbiaya rata-rata atau FIFO; selain itu perilaku bawaan Odoo (jurnal saat tagihan dan faktur) tidak berubah. Pesanan kasir (POS) tetap dijurnal oleh POS.
"""

from collections import defaultdict

from odoo import Command, api, fields, models
from odoo.tools import float_is_zero

INTERIM_COST_METHODS = ("average", "fifo")
INTERIM_FIELDS = ("kompakapps_stock_input_account_id", "kompakapps_stock_output_account_id")
SIDE_BY_USAGE = {"supplier": "input", "customer": "output"}


class ProductCategory(models.Model):
    _inherit = "product.category"

    kompakapps_stock_input_account_id = fields.Many2one(
        "account.account",
        string="Akun Barang Diterima Belum Ditagih",
        company_dependent=True,
        check_company=True,
        ondelete="restrict",
        help="Lawan akun valuasi persediaan saat barang diterima dari vendor (Dr Persediaan, Cr akun ini). Tagihan vendor kemudian mendebit akun ini, "
        "sehingga saldonya adalah barang yang sudah diterima tetapi belum ditagih.",
    )
    kompakapps_stock_output_account_id = fields.Many2one(
        "account.account",
        string="Akun Barang Terkirim Belum Ditagih",
        company_dependent=True,
        check_company=True,
        ondelete="restrict",
        help="Lawan akun valuasi persediaan saat barang dikirim ke pelanggan (Dr akun ini, Cr Persediaan). Faktur pelanggan kemudian mengkredit akun ini "
        "(Dr HPP), sehingga saldonya adalah barang yang sudah dikirim tetapi belum difakturkan.",
    )

    @api.model_create_multi
    def create(self, vals_list):
        """Kategori baru memakai akun perantara kategori induknya, atau kategori Goods bila induknya tidak punya.

        Hanya mengisi field yang tidak disebut sama sekali; nilai kosong yang disebut eksplisit dihormati, dan itulah cara mematikan jurnal per transaksi
        pada sebuah kategori.
        """
        goods = self.env.ref("product.product_category_goods", raise_if_not_found=False)
        for vals in vals_list:
            parent = self.browse(vals["parent_id"]) if vals.get("parent_id") else self.browse()
            for field in INTERIM_FIELDS:
                if field in vals:
                    continue
                source = parent[field] or (goods[field] if goods else False)
                if source:
                    vals[field] = source.id
        return super().create(vals_list)


class ProductProduct(models.Model):
    _inherit = "product.product"

    def _kompakapps_stock_interim(self):
        """Akun jurnal per transaksi untuk produk ini (menurut perusahaan aktif), atau None bila produk hanya dijurnal saat tagihan dan faktur.

        Syarat: produk dilacak stoknya, valuasi perpetual, biaya rata-rata atau FIFO (biaya standar punya selisih harga sendiri dari Odoo), dan kategori
        punya akun valuasi, Barang Diterima, dan Barang Terkirim Belum Ditagih.
        """
        self.ensure_one()
        if not (self.is_storable and self.valuation == "real_time" and self.cost_method in INTERIM_COST_METHODS):
            return None
        category = self.categ_id
        valuation = self._get_product_accounts().get("stock_valuation")
        input_account = category.kompakapps_stock_input_account_id
        output_account = category.kompakapps_stock_output_account_id
        if not (valuation and input_account and output_account):
            return None
        return {
            "valuation": valuation,
            "input": input_account,
            "output": output_account,
            "journal": self.product_tmpl_id.get_product_accounts()["stock_journal"],
        }


class StockMove(models.Model):
    _inherit = "stock.move"

    kompakapps_posted_value = fields.Monetary(
        "Nilai Terjurnal",
        currency_field="company_currency_id",
        copy=False,
        help="Nilai gerakan stok yang sudah tercermin pada jurnal stok. Bila nilai gerakan berubah sesudahnya (mis. harga tagihan berbeda dari harga PO), "
        "selisihnya dijurnal terpisah.",
    )

    # ------------------------------------------------------------------
    # Menentukan apakah dan ke akun mana sebuah gerakan dijurnal
    # ------------------------------------------------------------------

    def _kompakapps_interim_side(self):
        """"input" untuk gerakan dengan vendor, "output" untuk gerakan dengan pelanggan, selain itu False.

        Gerakan yang lokasi lawannya punya akun valuasi (opname, scrap, produksi) ditangani Odoo sendiri, dan pengiriman kasir dijurnal oleh POS.
        """
        self.ensure_one()
        if not (self.is_in or self.is_out):
            return False
        if self.location_id.valuation_account_id or self.location_dest_id.valuation_account_id:
            return False
        picking = self.picking_id
        if picking and ("pos_order_id" in picking._fields and (picking.pos_order_id or picking.pos_session_id)):
            return False
        outside = self.location_id if self.is_in else self.location_dest_id
        return SIDE_BY_USAGE.get(outside.usage, False)

    def _kompakapps_billed_before_activation(self, side, valuation):
        """Dokumen asal gerakan ini sudah ditagih atau difakturkan dengan pola lama (akun valuasi langsung), jadi jurnal baru akan menghitung dua kali."""
        self.ensure_one()
        if side == "input" and "purchase_line_id" in self._fields and self.purchase_line_id:
            lines = self.purchase_line_id.invoice_lines
            return bool(lines.filtered(lambda line: line.move_id.state == "posted" and line.account_id == valuation))
        if side == "output" and "sale_line_id" in self._fields and self.sale_line_id:
            invoices = self.sale_line_id.invoice_lines.move_id.filtered(lambda move: move.state == "posted")
            return bool(
                invoices.line_ids.filtered(
                    lambda line: line.display_type == "cogs" and line.product_id == self.product_id and line.account_id == valuation
                )
            )
        return False

    def _kompakapps_interim_accounts(self):
        """{"side", "valuation", "counter", "journal"} untuk gerakan yang dijurnal per transaksi, atau None."""
        self.ensure_one()
        move = self.with_company(self.company_id)
        if not (move.product_id.is_storable and move.is_valued) or float_is_zero(move.quantity, precision_rounding=move.product_uom.rounding):
            return None
        side = move._kompakapps_interim_side()
        if not side:
            return None
        interim = move.product_id.with_company(move.company_id)._kompakapps_stock_interim()
        if not interim or move._kompakapps_billed_before_activation(side, interim["valuation"]):
            return None
        return {"side": side, "valuation": interim["valuation"], "counter": interim[side], "journal": interim["journal"]}

    # ------------------------------------------------------------------
    # Pembuatan jurnal stok (mengganti pembuatan jurnal bawaan agar jurnal mengikuti kategori)
    # ------------------------------------------------------------------

    def _should_create_account_move(self):
        self.ensure_one()
        return super()._should_create_account_move() or self._kompakapps_interim_accounts() is not None

    def _get_account_move_line_vals(self):
        self.ensure_one()
        interim = self._kompakapps_interim_accounts()
        lines = super()._get_account_move_line_vals() if not interim else self._kompakapps_interim_line_vals(interim)
        if lines and self.company_currency_id.is_zero(self._get_aml_value()):
            return []  # gerakan bernilai nol tidak perlu jurnal
        return lines

    def _kompakapps_interim_line_vals(self, interim):
        """Baris jurnal penerimaan atau pengiriman: masuk Dr Valuasi, Cr lawan; keluar Dr lawan, Cr Valuasi (nilai negatif membalik sisi)."""
        value = self._get_aml_value()
        debit_account, credit_account = (interim["valuation"], interim["counter"]) if self.is_in else (interim["counter"], interim["valuation"])
        if value < 0:
            debit_account, credit_account, value = credit_account, debit_account, -value
        name = f"{self.reference} - {self.product_id.name}"
        return [
            {"account_id": credit_account.id, "name": name, "debit": 0, "credit": value, "product_id": self.product_id.id},
            {"account_id": debit_account.id, "name": name, "debit": value, "credit": 0, "product_id": self.product_id.id},
        ]

    def _kompakapps_stock_journal(self):
        """Jurnal stok sebuah gerakan: Stock Journal pada kategori produknya, atau jurnal stok perusahaan."""
        self.ensure_one()
        move = self.with_company(self.company_id)
        return move.product_id.product_tmpl_id.get_product_accounts()["stock_journal"] or move.company_id.account_stock_journal_id

    def _create_account_move(self):
        """Seperti bawaan Odoo, tetapi jurnal dipisah menurut Stock Journal kategori dan nilai yang terjurnal dicatat untuk koreksi harga tagihan."""
        groups = defaultdict(lambda: self.env["stock.move"])
        for move in self:
            if move._should_create_account_move():
                groups[(move.company_id, move._get_partner_id_for_valuation_lines(), move._kompakapps_stock_journal())] |= move
        account_moves = self.env["account.move"]
        for (company, partner_id, journal), moves in groups.items():
            line_vals = []
            for move in moves:
                line_vals += move._get_account_move_line_vals()
            if not line_vals:
                continue
            refs = ", ".join(sorted(set(moves.mapped("reference"))))
            account_move = self.env["account.move"].sudo().create(
                {
                    "ref": refs if len(refs) <= 43 else refs[:40] + "...",
                    "partner_id": partner_id,
                    "journal_id": journal.id,
                    "line_ids": [Command.create(vals) for vals in line_vals],
                    "date": self.env.context.get("force_period_date") or fields.Date.context_today(self),
                }
            )
            moves.account_move_id = account_move.id
            for move in moves:
                move.kompakapps_posted_value = move.value
            account_move._post()
            account_moves |= account_move
        return account_moves

    def _kompakapps_true_up_value(self):
        """Jurnalkan selisih nilai penerimaan yang dinilai ulang sesudah tagihan diposting (harga tagihan berbeda dari harga PO).

        Odoo mengganti nilai gerakan masuk dengan nilai tagihan. Jurnal penerimaan sudah memakai nilai lama, jadi selisihnya dijurnal sebagai tambahan:
        Dr Persediaan, Cr Barang Diterima Belum Ditagih (atau kebalikannya), supaya akun Barang Diterima habis saat tagihan dan penerimaan sama besar.
        """
        for move in self:
            if not (move.account_move_id and move.is_in):
                continue
            interim = move._kompakapps_interim_accounts()
            if interim is None or interim["side"] != "input":
                continue
            diff = move.value - move.kompakapps_posted_value
            if move.company_currency_id.is_zero(diff):
                continue
            debit_account, credit_account = (interim["valuation"], interim["counter"]) if diff > 0 else (interim["counter"], interim["valuation"])
            amount = abs(diff)
            name = f"Koreksi nilai {move.reference} - {move.product_id.name}"
            correction = self.env["account.move"].sudo().create(
                {
                    "ref": f"Koreksi nilai {move.reference}"[:43],
                    "partner_id": move._get_partner_id_for_valuation_lines(),
                    "journal_id": interim["journal"].id,
                    "date": fields.Date.context_today(self),
                    "line_ids": [
                        Command.create({"account_id": credit_account.id, "name": name, "debit": 0, "credit": amount, "product_id": move.product_id.id}),
                        Command.create({"account_id": debit_account.id, "name": name, "debit": amount, "credit": 0, "product_id": move.product_id.id}),
                    ],
                }
            )
            correction._post()
            move.kompakapps_posted_value = move.value


class AccountMove(models.Model):
    _inherit = "account.move"

    def _post(self, soft=True):
        posted = super()._post(soft)
        if not self.env.context.get("move_reverse_cancel"):
            bills = self.filtered(lambda move: move.is_purchase_document())
            if bills:
                bills.line_ids._get_stock_moves().filtered("is_in")._kompakapps_true_up_value()
        return posted

    def _stock_account_prepare_realtime_out_lines_vals(self):
        """Baris HPP bawaan mengkredit akun valuasi; dengan jurnal per transaksi pengiriman sudah mengkredit persediaan, jadi faktur mengkredit Barang Terkirim."""
        vals_list = super()._stock_account_prepare_realtime_out_lines_vals()
        for vals in vals_list:
            if vals.get("display_type") != "cogs" or not vals.get("product_id"):
                continue
            move = self.browse(vals["move_id"])
            if move.sudo().pos_order_ids if "pos_order_ids" in move._fields else False:
                continue  # faktur pesanan kasir: persediaan dijurnal oleh POS
            product = self.env["product.product"].browse(vals["product_id"]).with_company(move.company_id)
            interim = product._kompakapps_stock_interim()
            if interim and vals["account_id"] == interim["valuation"].id:
                vals["account_id"] = move.fiscal_position_id.map_account(interim["output"]).id
        return vals_list


class AccountMoveLine(models.Model):
    _inherit = "account.move.line"

    def _compute_account_id(self):
        super()._compute_account_id()
        for line in self:
            if not (line.move_id.is_purchase_document() and line._eligible_for_stock_account()):
                continue
            interim = line.product_id.with_company(line.company_id)._kompakapps_stock_interim()
            if interim and line.account_id == interim["valuation"]:
                line.account_id = line.move_id.fiscal_position_id.map_account(interim["input"])

    def _kompakapps_posted_cogs_lines(self):
        """Baris HPP faktur lain atas baris penjualan yang sama yang mengkredit Barang Terkirim (bawaan Odoo hanya mencari yang mengkredit akun valuasi)."""
        self.ensure_one()
        interim = self.product_id.with_company(self.company_id)._kompakapps_stock_interim()
        sale_lines = self.sale_line_ids if "sale_line_ids" in self._fields else self.env["sale.order.line"]
        if not (interim and sale_lines):
            return self.env["account.move.line"]
        output = self.move_id.fiscal_position_id.map_account(interim["output"])
        invoices = sale_lines.order_id.invoice_ids.filtered(lambda move: move.move_type in ("out_invoice", "out_refund"))
        return invoices.line_ids.filtered(
            lambda line: line.display_type == "cogs" and line.account_id == output and line.cogs_origin_id.sale_line_ids & sale_lines
        )

    def _get_cogs_qty(self):
        quantity = super()._get_cogs_qty()
        for line in self._kompakapps_posted_cogs_lines():
            quantity += line.product_uom_id._compute_quantity(line.quantity, line.product_id.uom_id) * (-1 if line.move_id.move_type == "out_refund" else 1)
        return quantity

    def _get_posted_cogs_value(self):
        return super()._get_posted_cogs_value() - sum(self._kompakapps_posted_cogs_lines().mapped("balance"))
