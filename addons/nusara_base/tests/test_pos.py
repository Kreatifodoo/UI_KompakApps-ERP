import uuid

from odoo import Command, fields
from odoo.addons.account.tests.common import AccountTestInvoicingCommon
from odoo.tests import tagged


@tagged("post_install", "-at_install", "nusara")
class TestPointOfSale(AccountTestInvoicingCommon):
    """Sesi kasir, penjualan tunai dengan kembalian, pembayaran campuran, faktur, dan jurnal saat sesi ditutup (D23)."""

    @classmethod
    @AccountTestInvoicingCommon.setup_country("id")
    def setUpClass(cls):
        super().setUpClass()
        cls.env.user.write(
            {
                "group_ids": [
                    Command.link(cls.env.ref("point_of_sale.group_pos_manager").id),
                    Command.link(cls.env.ref("stock.group_stock_manager").id),
                    Command.link(cls.env.ref("sales_team.group_sale_manager").id),
                ]
            }
        )
        cls.company = cls.env.company
        cls.company.nusara_setup_inventory_valuation()
        cls.goods = cls.env.ref("product.product_category_goods").with_company(cls.company)
        cls.tax = cls.company_data["default_tax_sale"]
        cls.product = cls._create_product(
            name="Barang Kasir", type="consu", is_storable=True, categ_id=cls.goods.id, standard_price=100000.0, list_price=300000.0,
            available_in_pos=True, taxes_id=[Command.set(cls.tax.ids)],
        )
        warehouse = cls.env["stock.warehouse"].search([("company_id", "=", cls.company.id)], limit=1)
        quant = cls.env["stock.quant"].with_context(inventory_mode=True).create(
            {"product_id": cls.product.id, "location_id": warehouse.lot_stock_id.id, "inventory_quantity": 20.0}
        )
        quant.action_apply_inventory()
        cash_journal = cls.company_data["default_journal_cash"]
        bank_journal = cls.company_data["default_journal_bank"]
        cls.cash = cls.env["pos.payment.method"].create({"name": "Tunai Kasir", "journal_id": cash_journal.id})
        cls.bank = cls.env["pos.payment.method"].create({"name": "Transfer Kasir", "journal_id": bank_journal.id})
        cls.config = cls.env["pos.config"].create(
            {"name": "Kasir Uji", "payment_method_ids": [Command.set((cls.cash | cls.bank).ids)], "cash_control": True}
        )
        cls.customer = cls.env["res.partner"].create({"name": "PT Pelanggan Kasir", "customer_rank": 1})

    def _session(self, opening_cash=100000.0):
        session = self.env["pos.session"].create({"config_id": self.config.id, "user_id": self.env.user.id})
        session.set_opening_control(opening_cash, "Modal awal")
        return session

    def _order(self, session, qty, payments, change=0.0, partner=None, invoice=False, sequence=1):
        """Meniru payload yang dikirim UI kasir: pajak dihitung lewat compute_all, kembalian sebagai pembayaran is_change."""
        unit = self.product.lst_price
        computed = self.tax.compute_all(unit, quantity=qty)
        total = computed["total_included"]
        now = fields.Datetime.now()
        payment_ids = [Command.create({"payment_method_id": method.id, "amount": amount, "name": str(now)}) for method, amount in payments]
        if change:
            payment_ids.append(Command.create({"payment_method_id": self.cash.id, "amount": -change, "name": str(now), "is_change": True}))
        order = {
            "name": f"Order {uuid.uuid4().hex[:8]}", "uuid": str(uuid.uuid4()), "session_id": session.id, "config_id": self.config.id, "user_id": self.env.user.id,
            "sequence_number": sequence, "date_order": str(now), "amount_tax": total - computed["total_excluded"], "amount_total": total, "amount_paid": total,
            "amount_return": 0.0, "partner_id": partner.id if partner else False, "to_invoice": invoice, "pricelist_id": False, "fiscal_position_id": False,
            "lines": [Command.create({
                "uuid": str(uuid.uuid4()), "product_id": self.product.id, "qty": qty, "price_unit": unit, "discount": 0.0, "tax_ids": [Command.set(self.tax.ids)],
                "price_subtotal": computed["total_excluded"], "price_subtotal_incl": total, "full_product_name": self.product.name, "name": self.product.name,
            })],
            "payment_ids": payment_ids,
        }
        result = self.env["pos.order"].sync_from_ui([order])
        return self.env["pos.order"].browse(result["pos.order"][0]["id"])

    def _close(self, session, counted):
        session.post_closing_cash_details(counted)
        session.update_closing_control_state_session("Penutupan uji")
        return session.close_session_from_ui([])

    def _lines(self, move):
        result = {}
        for line in move.line_ids:
            debit, credit = result.get(line.account_id, (0.0, 0.0))
            result[line.account_id] = (debit + line.debit, credit + line.credit)
        return result

    def test_cash_sale_with_change_then_close_posts_journals(self):
        session = self._session(opening_cash=100000.0)
        self.assertEqual(session.state, "opened")
        order = self._order(session, 2.0, [(self.cash, 700000.0)], change=34000.0)
        self.assertEqual(order.state, "paid")
        self.assertEqual(order.amount_total, 666000.0)
        self.assertEqual(sorted(order.payment_ids.mapped("amount")), [-34000.0, 700000.0])
        self.assertEqual(order.picking_ids.state, "done", "Stok keluar saat pesanan dibayar")
        self.assertFalse(session.move_id, "Belum ada jurnal sebelum sesi ditutup")

        closing = session.get_closing_control_data()
        self.assertEqual(closing["default_cash_details"]["amount"], 766000.0, "Kas awal 100.000 + penerimaan tunai bersih 666.000")
        result = self._close(session, counted=760000.0)
        self.assertTrue(result["successful"])
        self.assertEqual(session.state, "closed")
        self.assertEqual(session.cash_register_difference, -6000.0)

        lines = self._lines(session.move_id)
        by_name = {account.display_name.split(" ", 1)[-1]: values for account, values in lines.items()}
        self.assertTrue(any(credit == 66000.0 for _debit, credit in lines.values()), "PPN dikreditkan 66.000")
        self.assertTrue(any(credit == 600000.0 for _debit, credit in lines.values()), "Penjualan dikreditkan 600.000")
        self.assertTrue(any(debit == 666000.0 for debit, _credit in lines.values()), "Piutang POS didebit sebesar total")
        self.assertTrue(by_name)
        cash_moves = session.statement_line_ids.move_id
        cash_in = cash_moves.filtered(lambda m: any(line.debit == 666000.0 for line in m.line_ids))
        self.assertTrue(cash_in, "Penerimaan tunai bersih dipindahkan ke akun kas")
        shortage = cash_moves.filtered(lambda m: any(line.debit == 6000.0 for line in m.line_ids))
        self.assertTrue(shortage, "Selisih hitung kas 6.000 dijurnal sebagai kerugian selisih kas")
        for move in session.move_id | cash_moves:
            self.assertAlmostEqual(sum(move.line_ids.mapped("debit")), sum(move.line_ids.mapped("credit")), places=2)

    def test_perpetual_valuation_posts_cost_of_goods_when_session_closes(self):
        session = self._session()
        self._order(session, 3.0, [(self.cash, 999000.0)])
        self._close(session, counted=1099000.0)
        stock_account = self.goods.property_stock_valuation_account_id
        cogs = [line for line in session.move_id.line_ids if line.debit == 300000.0]
        self.assertTrue(cogs, "Harga pokok 3 x 100.000 didebit saat sesi ditutup")
        inventory = session.move_id.line_ids.filtered(lambda line: line.account_id == stock_account)
        self.assertEqual(sum(inventory.mapped("credit")), 300000.0, "Persediaan dikreditkan sebesar harga pokok")
        self.assertEqual(self.product.with_context(location=self.config.picking_type_id.default_location_src_id.id).qty_available, 17.0)

    def test_split_payment_and_invoice_for_customer(self):
        session = self._session()
        order = self._order(session, 1.0, [(self.cash, 100000.0), (self.bank, 233000.0)], partner=self.customer, invoice=True)
        self.assertEqual(order.state, "done")
        invoice = order.account_move
        self.assertEqual((invoice.move_type, invoice.state, invoice.partner_id), ("out_invoice", "posted", self.customer))
        self.assertEqual(invoice.amount_total, 333000.0)
        self.assertEqual(order.payment_ids.mapped("payment_method_id"), self.cash | self.bank)
        result = self._close(session, counted=200000.0)
        self.assertTrue(result["successful"])
        bank_payments = session.bank_payment_ids
        self.assertEqual(sum(bank_payments.mapped("amount")), 233000.0, "Pembayaran bank dibuat sebagai pembayaran terpisah saat sesi ditutup")

    def test_session_must_be_open_and_order_must_be_fully_paid(self):
        session = self._session()
        with self.assertRaises(Exception, msg="Pembayaran kurang dari total ditolak"):
            self._order(session, 1.0, [(self.cash, 100000.0)])
        self.assertFalse(session.order_ids, "Pesanan yang gagal tidak meninggalkan sisa")
        self._close(session, counted=100000.0)
        self.assertEqual(session.state, "closed")
        with self.assertRaises(Exception, msg="Sesi yang sudah ditutup tidak menerima pesanan"):
            self._order(session, 1.0, [(self.cash, 333000.0)])
