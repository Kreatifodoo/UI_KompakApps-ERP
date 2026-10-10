from odoo import Command, fields
from odoo.addons.account.tests.common import AccountTestInvoicingCommon
from odoo.tests import tagged


@tagged("post_install", "-at_install", "nusara")
class TestOrderToCash(AccountTestInvoicingCommon):
    """Alur Order-to-Cash pada perusahaan Indonesia dengan valuasi perpetual (D13).

    Quotation -> Sales Order -> Delivery -> Faktur pelanggan -> Pembayaran -> Nota kredit,
    termasuk jurnal yang tercipta di tiap tahap.
    """

    @classmethod
    @AccountTestInvoicingCommon.setup_country("id")
    def setUpClass(cls):
        super().setUpClass()
        cls.env.user.write(
            {"group_ids": [Command.link(cls.env.ref("sales_team.group_sale_manager").id)]}
        )
        cls.company = cls.env.company
        cls.company.nusara_setup_inventory_valuation()
        cls.goods = cls.env.ref("product.product_category_goods").with_company(cls.company)
        cls.warehouse = cls.env["stock.warehouse"].search(
            [("company_id", "=", cls.company.id)], limit=1
        )
        cls.customer = cls.env["res.partner"].create(
            {"name": "PT Pelanggan Nusantara", "is_company": True, "customer_rank": 1}
        )
        cls.product = cls._create_product(
            name="Barang Dagang Nusara",
            type="consu",
            is_storable=True,
            categ_id=cls.goods.id,
            standard_price=100000.0,
            list_price=150000.0,
            taxes_id=cls.company_data["default_tax_sale"],
        )
        quant = (
            cls.env["stock.quant"]
            .with_context(inventory_mode=True)
            .create(
                {
                    "product_id": cls.product.id,
                    "location_id": cls.warehouse.lot_stock_id.id,
                    "inventory_quantity": 10.0,
                }
            )
        )
        quant.action_apply_inventory()

    def _entries(self):
        return self.env["account.move"].search([], order="id")

    def _lines(self, move):
        """Debit dan kredit per akun pada sebuah jurnal."""
        result = {}
        for line in move.line_ids:
            debit, credit = result.get(line.account_id, (0.0, 0.0))
            result[line.account_id] = (debit + line.debit, credit + line.credit)
        return result

    def _sold_and_invoiced(self, qty=4.0):
        order = self.env["sale.order"].create(
            {
                "partner_id": self.customer.id,
                "order_line": [
                    Command.create({"product_id": self.product.id, "product_uom_qty": qty})
                ],
            }
        )
        # Harga datang dari daftar harga, bukan diisi manual.
        self.assertEqual(order.order_line.price_unit, 150000.0)
        entries_before = self._entries()
        order.action_confirm()
        self.assertEqual(order.state, "sale")
        self.assertEqual(self._entries(), entries_before, "Konfirmasi SO tidak membuat jurnal")

        picking = order.picking_ids
        self.assertEqual(len(picking), 1)
        self.assertEqual(picking.picking_type_code, "outgoing")
        self.assertEqual(picking.state, "assigned")
        picking.move_ids.quantity = qty
        picking.move_ids.picked = True
        picking.button_validate()
        self.assertEqual(picking.state, "done")
        self.assertEqual(order.delivery_status, "full")
        self.assertEqual(
            self._entries(), entries_before, "Pengiriman barang tidak membuat jurnal"
        )

        invoice = order._create_invoices()
        self.assertEqual(invoice.move_type, "out_invoice")
        self.assertEqual(invoice.state, "draft")
        invoice.action_post()
        return order, picking, invoice

    def test_order_to_cash_with_journals(self):
        order, _picking, invoice = self._sold_and_invoiced()
        self.assertEqual(invoice.amount_untaxed, 600000.0)
        self.assertEqual(invoice.amount_total, order.amount_total)
        self.assertEqual(invoice.invoice_origin, order.name)
        self.assertEqual(order.invoice_status, "invoiced")

        lines = self._lines(invoice)
        receivable = invoice.line_ids.filtered(
            lambda line: line.account_id.account_type == "asset_receivable"
        ).account_id
        income = self.goods.property_account_income_categ_id
        stock = self.goods.property_stock_valuation_account_id
        cogs = self.product.product_tmpl_id.with_company(
            self.company
        )._get_product_accounts()["expense"]
        # Pendapatan: Dr Piutang usaha, Cr Penjualan dan pajak keluaran.
        self.assertEqual(lines[receivable][0], invoice.amount_total)
        self.assertEqual(lines[income][1], 600000.0)
        self.assertEqual(
            sum(credit for _debit, credit in lines.values()) - 600000.0 - 400000.0,
            invoice.amount_tax,
        )
        # Harga pokok (perpetual, biaya rata-rata): Dr HPP, Cr Persediaan sebesar 4 x 100.000.
        self.assertEqual(lines[cogs][0], 400000.0)
        self.assertEqual(lines[stock][1], 400000.0)
        self.assertEqual(
            sum(line.debit for line in invoice.line_ids),
            sum(line.credit for line in invoice.line_ids),
        )
        # Barang keluar dari stok.
        self.assertEqual(self.product.qty_available, 6.0)

        # Pembayaran pelanggan: Dr Pembayaran tertunda, Cr Piutang usaha.
        payment = (
            self.env["account.payment.register"]
            .with_context(active_model="account.move", active_ids=invoice.ids)
            .create({"payment_date": fields.Date.today()})
            ._create_payments()
        )
        self.assertEqual(payment.payment_type, "inbound")
        self.assertEqual(payment.partner_id, self.customer)
        self.assertEqual(payment.amount, invoice.amount_total)
        entry = self._lines(payment.move_id)
        self.assertEqual(entry[payment.outstanding_account_id][0], invoice.amount_total)
        self.assertEqual(entry[payment.destination_account_id][1], invoice.amount_total)
        self.assertIn(invoice.payment_state, ("paid", "in_payment"))

    def test_credit_note_reverses_revenue_and_cost(self):
        _order, _picking, invoice = self._sold_and_invoiced(qty=2.0)
        reversal = (
            self.env["account.move.reversal"]
            .with_context(active_model="account.move", active_ids=invoice.ids)
            .create({"journal_id": invoice.journal_id.id, "reason": "Retur"})
        )
        credit_note = self.env["account.move"].browse(reversal.refund_moves()["res_id"])
        self.assertEqual(credit_note.move_type, "out_refund")
        self.assertEqual(credit_note.reversed_entry_id, invoice)
        credit_note.action_post()
        self.assertEqual(credit_note.amount_total, invoice.amount_total)
        original = self._lines(invoice)
        reversed_lines = self._lines(credit_note)
        for account, (debit, credit) in original.items():
            self.assertEqual(reversed_lines[account], (credit, debit))
