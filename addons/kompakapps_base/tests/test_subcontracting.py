from odoo import Command, fields
from odoo.addons.account.tests.common import AccountTestInvoicingCommon
from odoo.exceptions import ValidationError
from odoo.tests import tagged


@tagged("post_install", "-at_install", "kompakapps")
class TestSubcontracting(AccountTestInvoicingCommon):
    """Subkontrak pada Bill of Material (Q54, D82) dan jurnalnya terhadap jurnal per transaksi (D69).

    PO barang ber-BoM subkontrak ke pemasok terdaftar membuat penerimaan dan MO subkontrak; komponen dikirim lewat Resupply Subcontractor; validasi
    penerimaan menyelesaikan MO. Resupply tidak dijurnal (lokasi Subcontracting bertipe internal), komponen dan barang jadi dijurnal lewat Barang Dalam
    Proses, dan biaya jasa dikreditkan ke Barang Diterima Belum Ditagih saat barang jadi diterima lalu dibersihkan tagihan vendor.
    """

    @classmethod
    @AccountTestInvoicingCommon.setup_country("id")
    def setUpClass(cls):
        super().setUpClass()
        cls.env.user.write(
            {
                "group_ids": [
                    Command.link(cls.env.ref("stock.group_stock_manager").id),
                    Command.link(cls.env.ref("mrp.group_mrp_manager").id),
                ]
            }
        )
        cls.company = cls.env.company
        cls.company.kompakapps_setup_inventory_valuation()
        cls.company.kompakapps_setup_stock_journals()
        cls.goods = cls.env.ref("product.product_category_goods").with_company(cls.company)
        cls.stock_account = cls.goods.property_stock_valuation_account_id
        cls.input_account = cls.goods.kompakapps_stock_input_account_id
        cls.wip_account = cls.env["stock.location"].search([("usage", "=", "production"), ("company_id", "in", [cls.company.id, False])], limit=1).valuation_account_id
        cls.warehouse = cls.env["stock.warehouse"].search([("company_id", "=", cls.company.id)], limit=1)
        cls.subcontracting_location = cls.company.subcontracting_location_id
        cls.supplier = cls.env["res.partner"].create({"name": "PT Pemasok Komponen", "is_company": True, "supplier_rank": 1})
        cls.subcontractor = cls.env["res.partner"].create({"name": "CV Subkon Rakit", "is_company": True, "supplier_rank": 1})
        cls.other_vendor = cls.env["res.partner"].create({"name": "CV Bukan Subkon", "is_company": True, "supplier_rank": 1})
        cls.component = cls._create_product(
            name="Komponen Subkon", type="consu", is_storable=True, categ_id=cls.goods.id, standard_price=0.0,
            taxes_id=[Command.clear()], supplier_taxes_id=[Command.clear()],
        )
        cls.finished = cls._create_product(
            name="Barang Jadi Subkon", type="consu", is_storable=True, categ_id=cls.goods.id, standard_price=0.0,
            taxes_id=[Command.clear()], supplier_taxes_id=[Command.clear()],
        )
        cls.bom = cls.env["mrp.bom"].create(
            {
                "product_tmpl_id": cls.finished.product_tmpl_id.id,
                "type": "subcontract",
                "subcontractor_ids": [Command.link(cls.subcontractor.id)],
                "product_qty": 1.0,
                "bom_line_ids": [Command.create({"product_id": cls.component.id, "product_qty": 2.0})],
            }
        )

    # ------------------------------------------------------------------ pembantu

    def _balance(self, account):
        lines = self.env["account.move.line"].search([("account_id", "=", account.id), ("parent_state", "=", "posted"), ("company_id", "=", self.company.id)])
        return round(sum(lines.mapped("balance")), 2)

    def _stock_components(self, qty=20.0, price=10000.0):
        order = self.env["purchase.order"].create(
            {"partner_id": self.supplier.id, "order_line": [Command.create({"product_id": self.component.id, "product_qty": qty, "price_unit": price})]}
        )
        order.button_confirm()
        picking = order.picking_ids
        picking.move_ids.quantity = qty
        picking.move_ids.picked = True
        picking.button_validate()
        self._bill(order)

    def _bill(self, order, price=None):
        order.action_create_invoice()
        bill = order.invoice_ids.filtered(lambda move: move.state == "draft")
        bill.invoice_date = fields.Date.today()
        if price is not None:
            bill.invoice_line_ids.price_unit = price
        bill.action_post()
        return bill

    def _subcontract_order(self, qty=5.0, price=50000.0, partner=None):
        order = self.env["purchase.order"].create(
            {"partner_id": (partner or self.subcontractor).id, "order_line": [Command.create({"product_id": self.finished.id, "product_qty": qty, "price_unit": price})]}
        )
        order.button_confirm()
        return order

    def _resupply(self, qty):
        """Resupply seperti yang dibuat tombol "Buat Resupply Komponen" di UI: tipe Resupply Subcontractor, grup produksi MO pada gerakan supaya tertaut ke PO."""
        production = self.env["mrp.production"].search([("product_id", "=", self.finished.id), ("subcontractor_id", "=", self.subcontractor.id)], order="id desc", limit=1)
        group = production.production_group_id
        picking = self.env["stock.picking"].create(
            {
                "picking_type_id": self.warehouse.subcontracting_resupply_type_id.id,
                "partner_id": self.subcontractor.id,
                "location_id": self.warehouse.lot_stock_id.id,
                "location_dest_id": self.subcontracting_location.id,
                "move_ids": [
                    Command.create(
                        {
                            "product_id": self.component.id,
                            "product_uom_qty": qty,
                            "location_id": self.warehouse.lot_stock_id.id,
                            "location_dest_id": self.subcontracting_location.id,
                            "production_group_id": group.id,
                        }
                    )
                ],
            }
        )
        picking.action_confirm()
        picking.move_ids.quantity = qty
        picking.move_ids.picked = True
        picking.button_validate()
        self.assertEqual(picking.state, "done")
        return picking

    def _receive(self, order):
        receipt = order.picking_ids
        receipt.move_ids.quantity = order.order_line.product_qty
        receipt.move_ids.picked = True
        receipt.button_validate()
        self.assertEqual(receipt.state, "done")
        return receipt

    def _service_balance(self):
        return self._balance(self.input_account)

    # ------------------------------------------------------------------ BoM

    def test_subcontract_bom_type_and_subcontractors(self):
        self.assertEqual(self.bom.type, "subcontract")
        self.assertEqual(self.bom.subcontractor_ids, self.subcontractor)
        self.assertIn(("subcontract", "Subcontracting"), self.env["mrp.bom"]._fields["type"]._description_selection(self.env))

    def test_subcontract_bom_cannot_have_operations(self):
        workcenter = self.env["mrp.workcenter"].create({"name": "WC Subkon"})
        with self.assertRaises(ValidationError):
            self.bom.write({"operation_ids": [Command.create({"name": "Rakit", "workcenter_id": workcenter.id})]})

    # ------------------------------------------------------------------ alur dokumen

    def test_purchase_order_creates_receipt_and_subcontract_production(self):
        order = self._subcontract_order()
        receipt = order.picking_ids
        self.assertEqual(len(receipt), 1)
        self.assertTrue(receipt.move_ids.is_subcontract)
        production = self.env["mrp.production"].search([("product_id", "=", self.finished.id), ("subcontractor_id", "=", self.subcontractor.id)])
        self.assertEqual(len(production), 1)
        self.assertEqual(production.bom_id, self.bom)
        self.assertEqual(production.product_qty, 5.0)
        self.assertEqual(production.move_raw_ids.location_id, self.subcontracting_location)
        self.assertEqual(order.subcontracting_resupply_picking_count, 0)

    def test_vendor_not_registered_gets_plain_receipt(self):
        order = self._subcontract_order(partner=self.other_vendor)
        self.assertFalse(order.picking_ids.move_ids.is_subcontract)
        self.assertFalse(self.env["mrp.production"].search([("product_id", "=", self.finished.id), ("subcontractor_id", "!=", False)]))

    def test_resupply_is_linked_to_purchase_order_and_production(self):
        self._stock_components()
        order = self._subcontract_order()
        picking = self._resupply(10.0)
        self.env.invalidate_all()
        self.assertEqual(order.subcontracting_resupply_picking_count, 1)
        self.assertEqual(order._get_subcontracting_resupplies(), picking)
        production = self.env["mrp.production"].search([("product_id", "=", self.finished.id), ("subcontractor_id", "=", self.subcontractor.id)])
        self.assertIn(picking, production.picking_ids)

    def test_receipt_validation_completes_production_and_consumes_resupplied_components(self):
        self._stock_components()
        order = self._subcontract_order()
        self._resupply(10.0)
        self.assertEqual(self.component.with_context(location=self.subcontracting_location.id).qty_available, 10.0)
        self._receive(order)
        production = self.env["mrp.production"].search([("product_id", "=", self.finished.id), ("subcontractor_id", "=", self.subcontractor.id)])
        self.assertEqual(production.state, "done")
        self.assertEqual(self.finished.qty_available, 5.0)
        self.assertEqual(self.component.with_context(location=self.subcontracting_location.id).qty_available, 0.0)

    # ------------------------------------------------------------------ jurnal (D69)

    def test_resupply_is_not_journaled_and_keeps_value_in_inventory(self):
        self._stock_components(20.0, 10000.0)
        before = (self._balance(self.stock_account), self._balance(self.input_account))
        picking = self._resupply(10.0)
        self.assertFalse(picking.move_ids.account_move_id)
        self.assertEqual((self._balance(self.stock_account), self._balance(self.input_account)), before)
        self.assertEqual(before[0], 200000.0)

    def test_receipt_journals_service_cost_against_goods_received_and_bill_clears_it(self):
        self._stock_components(20.0, 10000.0)
        order = self._subcontract_order(5.0, 50000.0)
        self._resupply(10.0)
        self._receive(order)
        # Komponen 10 x 10.000 + biaya jasa 5 x 50.000 = nilai barang jadi 350.000; sisa komponen di gudang 10 x 10.000
        self.assertEqual(self.finished.total_value, 350000.0)
        self.assertEqual(self._balance(self.wip_account), 0.0, "Barang Dalam Proses habis: komponen masuk, barang jadi keluar")
        self.assertEqual(self._balance(self.input_account), -250000.0, "Biaya jasa menunggu tagihan di Barang Diterima Belum Ditagih")
        self.assertEqual(self._balance(self.stock_account), self.finished.total_value + self.component.total_value, "Persediaan sama dengan nilai stok")
        bill = self._bill(order)
        self.assertEqual(bill.invoice_line_ids.account_id, self.input_account)
        self.assertEqual(self._balance(self.input_account), 0.0)
        self.assertEqual(self._balance(self.stock_account), self.finished.total_value + self.component.total_value)
        self.assertEqual(self.env["account.move"].search_count([("ref", "like", "Koreksi nilai%"), ("state", "=", "posted")]), 0)

    def test_bill_price_difference_after_receipt_is_trued_up(self):
        self._stock_components(20.0, 10000.0)
        order = self._subcontract_order(5.0, 50000.0)
        self._resupply(10.0)
        self._receive(order)
        self._bill(order, price=55000.0)
        # Selisih 5 x 5.000 = 25.000 dijurnal Dr Persediaan, Cr Barang Diterima; akun Barang Diterima habis
        self.assertEqual(self._balance(self.input_account), 0.0)
        self.assertEqual(self._balance(self.stock_account), 450000.0 + 25000.0)

    def test_bill_before_receipt_sets_service_cost_and_clears_goods_received(self):
        self._stock_components(20.0, 10000.0)
        order = self._subcontract_order(5.0, 50000.0)
        order.order_line.product_id.product_tmpl_id.purchase_method = "purchase"
        self._bill(order, price=60000.0)
        self._resupply(10.0)
        self._receive(order)
        self.assertEqual(self.finished.total_value, 400000.0, "Biaya jasa memakai harga tagihan: 100.000 + 5 x 60.000")
        self.assertEqual(self._balance(self.input_account), 0.0)
        self.assertEqual(self._balance(self.stock_account), self.finished.total_value + self.component.total_value)

    def test_category_without_interim_accounts_keeps_odoo_default(self):
        category = self.env["product.category"].create(
            {
                "name": "Kategori Tanpa Jurnal Transaksi",
                "property_cost_method": "average",
                "property_valuation": "real_time",
                "kompakapps_stock_input_account_id": False,
                "kompakapps_stock_output_account_id": False,
            }
        )
        self.finished.categ_id = category
        self._stock_components(20.0, 10000.0)
        order = self._subcontract_order(5.0, 50000.0)
        self._resupply(10.0)
        self._receive(order)
        self.assertEqual(self._balance(self.input_account), 0.0, "Tanpa akun perantara tidak ada kredit biaya jasa pada penerimaan")
        bill = self._bill(order)
        self.assertEqual(bill.invoice_line_ids.account_id, self.stock_account, "Bawaan Odoo: tagihan mendebit akun valuasi")
