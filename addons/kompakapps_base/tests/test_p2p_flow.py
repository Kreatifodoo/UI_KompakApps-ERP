from odoo import Command, fields
from odoo.addons.account.tests.common import AccountTestInvoicingCommon
from odoo.tests import tagged


@tagged("post_install", "-at_install", "kompakapps")
class TestProcureToPay(AccountTestInvoicingCommon):
    """Alur Procure-to-Pay pada perusahaan Indonesia (IDR, COA l10n_id).

    Purchase Request -> RFQ -> PO -> Goods Receipt -> Vendor Bill -> Payment.
    """

    @classmethod
    @AccountTestInvoicingCommon.setup_country("id")
    def setUpClass(cls):
        super().setUpClass()
        cls.env.user.write(
            {
                "group_ids": [
                    Command.link(
                        cls.env.ref("purchase_request.group_purchase_request_manager").id
                    )
                ]
            }
        )
        cls.company = cls.env.company
        cls.tax = cls.company_data["default_tax_purchase"]
        cls.warehouse = cls.env["stock.warehouse"].search(
            [("company_id", "=", cls.company.id)], limit=1
        )
        cls.vendor = cls.env["res.partner"].create(
            {"name": "PT Pemasok Nusantara", "is_company": True}
        )
        cls.material = cls._create_product(
            name="Bahan Baku KompakApps",
            type="consu",
            is_storable=True,
            standard_price=100000.0,
            supplier_taxes_id=cls.tax,
        )
        cls.env["product.supplierinfo"].create(
            {
                "partner_id": cls.vendor.id,
                "product_tmpl_id": cls.material.product_tmpl_id.id,
                "min_qty": 1.0,
                "price": 100000.0,
                "currency_id": cls.company.currency_id.id,
            }
        )

    def test_company_is_indonesian(self):
        self.assertEqual(self.company.country_id.code, "ID")
        self.assertEqual(self.company.currency_id.name, "IDR")
        self.assertEqual(self.tax.type_tax_use, "purchase")
        self.assertGreater(self.tax.amount, 0)

    def test_procure_to_pay(self):
        # 1. Purchase Request: draft -> to_approve -> approved
        request = self.env["purchase.request"].create(
            {
                "picking_type_id": self.warehouse.in_type_id.id,
                "requested_by": self.env.user.id,
                "company_id": self.company.id,
                "line_ids": [
                    Command.create(
                        {
                            "product_id": self.material.id,
                            "product_uom_id": self.material.uom_id.id,
                            "product_qty": 10.0,
                        }
                    )
                ],
            }
        )
        self.assertEqual(request.state, "draft")
        request.button_to_approve()
        self.assertEqual(request.state, "to_approve")
        request.button_approved()
        self.assertEqual(request.state, "approved")

        # 2. Purchase Request -> RFQ lewat wizard
        line = request.line_ids
        wizard = (
            self.env["purchase.request.line.make.purchase.order"]
            .with_context(
                active_model="purchase.request.line",
                active_ids=line.ids,
                active_id=line.id,
            )
            .create({"supplier_id": self.vendor.id})
        )
        wizard.make_purchase_order()
        order = line.purchase_lines.order_id
        self.assertEqual(len(order), 1)
        self.assertEqual(order.state, "draft")
        self.assertEqual(order.partner_id, self.vendor)
        self.assertEqual(order.company_id, self.company)
        self.assertEqual(order.currency_id.name, "IDR")
        self.assertEqual(order.order_line.product_qty, 10.0)
        self.assertEqual(order.order_line.price_unit, 100000.0)
        self.assertEqual(order.amount_untaxed, 1000000.0)
        expected_tax = order.currency_id.round(1000000.0 * self.tax.amount / 100)
        self.assertEqual(order.amount_tax, expected_tax)
        self.assertEqual(line.purchased_qty, 10.0)

        # 3. RFQ -> Purchase Order
        order.button_confirm()
        self.assertEqual(order.state, "purchase")

        # 4. Goods Receipt
        receipt = order.picking_ids
        self.assertEqual(len(receipt), 1)
        self.assertEqual(receipt.picking_type_id, self.warehouse.in_type_id)
        receipt.move_ids.quantity = 10.0
        receipt.move_ids.picked = True
        receipt.button_validate()
        self.assertEqual(receipt.state, "done")
        self.assertEqual(order.order_line.qty_received, 10.0)

        # 5. Vendor Bill
        order.action_create_invoice()
        bill = order.invoice_ids
        self.assertEqual(len(bill), 1)
        bill.invoice_date = fields.Date.today()
        bill.action_post()
        self.assertEqual(bill.state, "posted")
        self.assertEqual(bill.move_type, "in_invoice")
        self.assertEqual(bill.currency_id.name, "IDR")
        self.assertEqual(bill.amount_untaxed, order.amount_untaxed)
        self.assertEqual(bill.amount_tax, order.amount_tax)
        self.assertEqual(bill.amount_total, order.amount_total)
        self.assertEqual(bill.payment_state, "not_paid")
        self.assertEqual(order.invoice_status, "invoiced")

        # Jurnal seimbang dan hutang usaha sebesar total tagihan
        self.assertEqual(
            sum(bill.line_ids.mapped("debit")), sum(bill.line_ids.mapped("credit"))
        )
        payable = bill.line_ids.filtered(
            lambda move_line: move_line.account_id.account_type == "liability_payable"
        )
        self.assertEqual(payable.credit, bill.amount_total)

        # 6. Payment
        payments = (
            self.env["account.payment.register"]
            .with_context(active_model="account.move", active_ids=bill.ids)
            .create({"payment_date": fields.Date.today()})
            ._create_payments()
        )
        self.assertEqual(payments.payment_type, "outbound")
        self.assertEqual(payments.partner_id, self.vendor)
        self.assertEqual(payments.amount, bill.amount_total)
        self.assertIn(bill.payment_state, ("paid", "in_payment"))

    def test_tiered_vendor_price_follows_line_quantity(self):
        """Harga vendor bertingkat dipakai menurut kuantitas baris, apa pun jalur pembuatannya."""
        self.env["product.supplierinfo"].create(
            {
                "partner_id": self.vendor.id,
                "product_tmpl_id": self.material.product_tmpl_id.id,
                "min_qty": 10.0,
                "price": 80000.0,
                "currency_id": self.company.currency_id.id,
            }
        )

        def new_order_line(qty, **extra):
            order = self.env["purchase.order"].create(
                {
                    "partner_id": self.vendor.id,
                    "order_line": [
                        Command.create(
                            {
                                "product_id": self.material.id,
                                "product_qty": qty,
                                "product_uom_id": self.material.uom_id.id,
                                **extra,
                            }
                        )
                    ],
                }
            )
            return order.order_line

        self.assertEqual(new_order_line(1.0).price_unit, 100000.0)
        self.assertEqual(new_order_line(9.0).price_unit, 100000.0)
        self.assertEqual(new_order_line(10.0).price_unit, 80000.0)
        self.assertEqual(new_order_line(12.0).price_unit, 80000.0)
        # Harga yang dikirim eksplisit tidak ditimpa.
        self.assertEqual(new_order_line(12.0, price_unit=90000.0).price_unit, 90000.0)
        # Menulis ulang kuantitas tetap memperbarui harga.
        line = new_order_line(1.0)
        line.product_qty = 20.0
        self.assertEqual(line.price_unit, 80000.0)

    def _purchase_to_bill(self, qty=10.0):
        """PO -> penerimaan penuh -> tagihan diposting; mengembalikan (order, receipt, bill)."""
        order = self.env["purchase.order"].create(
            {
                "partner_id": self.vendor.id,
                "order_line": [
                    Command.create(
                        {
                            "product_id": self.material.id,
                            "product_qty": qty,
                            "product_uom_id": self.material.uom_id.id,
                        }
                    )
                ],
            }
        )
        moves_before = self.env["account.move"].search_count([])
        order.button_confirm()
        self.assertEqual(
            self.env["account.move"].search_count([]),
            moves_before,
            "Konfirmasi PO tidak boleh membuat jurnal",
        )
        receipt = order.picking_ids
        receipt.move_ids.quantity = qty
        receipt.move_ids.picked = True
        receipt.button_validate()
        self.assertEqual(receipt.state, "done")
        self.assertEqual(
            self.env["account.move"].search_count([]),
            moves_before,
            "Odoo 19 tidak membuat jurnal saat barang diterima; jurnal muncul saat tagihan",
        )
        order.action_create_invoice()
        bill = order.invoice_ids
        bill.invoice_date = fields.Date.today()
        bill.action_post()
        return order, receipt, bill

    def _debits(self, move):
        """Debit per akun pada sebuah jurnal, dikumpulkan menurut kode akun."""
        result = {}
        for line in move.line_ids:
            result[line.account_id] = result.get(line.account_id, 0.0) + line.debit
        return result

    def test_bill_debits_inventory_under_perpetual_valuation(self):
        """Setup KompakApps: barang stok masuk ke akun Persediaan, bukan langsung ke beban."""
        self.company.kompakapps_setup_inventory_valuation()
        goods = self.env.ref("product.product_category_goods").with_company(self.company)
        self.assertEqual(goods.property_valuation, "real_time")
        self.assertEqual(goods.property_cost_method, "average")
        self.material.categ_id = goods
        stock_account = goods.property_stock_valuation_account_id
        self.assertTrue(stock_account)

        order, receipt, bill = self._purchase_to_bill()
        # Nilai persediaan tercatat pada pergerakan stok walau jurnal baru dibuat saat tagihan.
        self.assertEqual(sum(receipt.move_ids.mapped("value")), 1000000.0)
        debits = self._debits(bill)
        self.assertEqual(debits.get(stock_account), 1000000.0)
        # Selain Persediaan hanya pajak masukan yang didebit: tidak ada beban (COGS).
        self.assertEqual(sum(debits.values()), bill.amount_total)
        self.assertEqual(sum(1 for amount in debits.values() if amount), 2)
        payable = bill.line_ids.filtered(
            lambda line: line.account_id.account_type == "liability_payable"
        )
        self.assertEqual(payable.credit, bill.amount_total)
        self.assertEqual(
            sum(bill.line_ids.mapped("debit")), sum(bill.line_ids.mapped("credit"))
        )

        # Pembayaran: debit hutang usaha, kredit akun pembayaran tertunda (Outstanding Payments)
        payment = (
            self.env["account.payment.register"]
            .with_context(active_model="account.move", active_ids=bill.ids)
            .create({"payment_date": fields.Date.today()})
            ._create_payments()
        )
        self.assertEqual(payment.destination_account_id, payable.account_id)
        entry = payment.move_id
        self.assertEqual(sum(entry.line_ids.mapped("debit")), bill.amount_total)
        self.assertEqual(
            sum(entry.line_ids.mapped("debit")), sum(entry.line_ids.mapped("credit"))
        )
        self.assertEqual(self._debits(entry).get(payable.account_id), bill.amount_total)
        self.assertEqual(
            entry.line_ids.filtered("credit").account_id, payment.outstanding_account_id
        )

    def test_bill_debits_expense_under_periodic_valuation(self):
        """Bawaan Odoo (periodik): tagihan barang stok langsung mendebit beban; alasan setup di atas."""
        self.company.inventory_valuation = "periodic"
        goods = self.env.ref("product.product_category_goods").with_company(self.company)
        goods.property_valuation = "periodic"
        self.material.categ_id = goods
        _order, _receipt, bill = self._purchase_to_bill()
        debits = self._debits(bill)
        expense_account = self.material.product_tmpl_id.with_company(
            self.company
        )._get_product_accounts()["expense"]
        self.assertTrue(expense_account)
        self.assertEqual(debits.get(expense_account), 1000000.0)
        self.assertFalse(debits.get(goods.property_stock_valuation_account_id))
