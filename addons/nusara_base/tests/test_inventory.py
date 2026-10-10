from odoo import Command
from odoo.addons.account.tests.common import AccountTestInvoicingCommon
from odoo.tests import tagged


@tagged("post_install", "-at_install", "nusara")
class TestInventoryOperations(AccountTestInvoicingCommon):
    """Hitung fisik, scrap, dan aturan stok minimum (D17)."""

    @classmethod
    @AccountTestInvoicingCommon.setup_country("id")
    def setUpClass(cls):
        super().setUpClass()
        cls.env.user.write(
            {
                "group_ids": [
                    Command.link(cls.env.ref("stock.group_stock_manager").id),
                    Command.link(cls.env.ref("purchase.group_purchase_user").id),
                ]
            }
        )
        cls.company = cls.env.company
        cls.company.nusara_setup_inventory_valuation()
        cls.goods = cls.env.ref("product.product_category_goods").with_company(cls.company)
        cls.warehouse = cls.env["stock.warehouse"].search([("company_id", "=", cls.company.id)], limit=1)
        cls.stock_location = cls.warehouse.lot_stock_id
        cls.product = cls._create_product(
            name="Barang Gudang Nusara",
            type="consu",
            is_storable=True,
            categ_id=cls.goods.id,
            standard_price=100000.0,
        )
        cls._count(10.0)

    @classmethod
    def _count(cls, quantity):
        """Hitung fisik: isi jumlah hitungan pada quant lalu terapkan (sama seperti halaman Physical Inventory)."""
        quant = (
            cls.env["stock.quant"]
            .with_context(inventory_mode=True)
            .search([("product_id", "=", cls.product.id), ("location_id", "=", cls.stock_location.id)], limit=1)
        )
        if not quant:
            quant = (
                cls.env["stock.quant"]
                .with_context(inventory_mode=True)
                .create({"product_id": cls.product.id, "location_id": cls.stock_location.id, "inventory_quantity": quantity})
            )
        else:
            quant.inventory_quantity = quantity
        quant.action_apply_inventory()
        return quant

    def _on_hand(self):
        return self.product.with_context(location=self.stock_location.id).qty_available

    def test_count_and_scrap_are_valued_but_not_journaled(self):
        moves_before = self.env["account.move"].search_count([])
        self._count(8.0)
        self.assertEqual(self._on_hand(), 8.0)
        adjustment = self.env["stock.move"].search(
            [("product_id", "=", self.product.id), ("is_inventory", "=", True)], order="id desc", limit=1
        )
        self.assertEqual(adjustment.state, "done")
        self.assertEqual(abs(adjustment.value), 200000.0, "Selisih 2 unit dinilai 2 x 100.000")
        self.assertFalse(adjustment.account_move_id)

        scrap = self.env["stock.scrap"].create(
            {
                "product_id": self.product.id,
                "scrap_qty": 1.0,
                "product_uom_id": self.product.uom_id.id,
                "location_id": self.stock_location.id,
            }
        )
        scrap.action_validate()
        self.assertEqual(scrap.state, "done")
        self.assertEqual(self._on_hand(), 7.0)
        # Odoo 19 (valuasi perpetual saat penagihan) tidak menjurnal penyesuaian dan scrap; laporan stok menampilkan selisihnya.
        self.assertEqual(self.env["account.move"].search_count([]), moves_before)

    def test_scrap_more_than_stock_asks_for_confirmation(self):
        scrap = self.env["stock.scrap"].create(
            {
                "product_id": self.product.id,
                "scrap_qty": 999.0,
                "product_uom_id": self.product.uom_id.id,
                "location_id": self.stock_location.id,
            }
        )
        action = scrap.action_validate()
        self.assertEqual(action["res_model"], "stock.warn.insufficient.qty.scrap")
        self.assertEqual(scrap.state, "draft")
        self.assertEqual(self._on_hand(), 10.0)

    def test_reorder_rule_creates_rfq_at_vendor_price(self):
        vendor = self.env["res.partner"].create({"name": "PT Pemasok Gudang", "supplier_rank": 1})
        self.env["product.supplierinfo"].create(
            {
                "partner_id": vendor.id,
                "product_tmpl_id": self.product.product_tmpl_id.id,
                "min_qty": 1.0,
                "price": 90000.0,
                "currency_id": self.company.currency_id.id,
            }
        )
        rule = self.env["stock.warehouse.orderpoint"].create(
            {
                "product_id": self.product.id,
                "warehouse_id": self.warehouse.id,
                "location_id": self.stock_location.id,
                "product_min_qty": 15.0,
                "product_max_qty": 25.0,
                "trigger": "manual",
            }
        )
        self.assertEqual(rule.qty_forecast, 10.0)
        self.assertEqual(rule.qty_to_order, 15.0)
        rule.action_replenish()
        rfq = self.env["purchase.order"].search([("partner_id", "=", vendor.id)])
        self.assertEqual(len(rfq), 1)
        self.assertEqual(rfq.state, "draft")
        self.assertEqual(rfq.order_line.product_qty, 15.0)
        self.assertEqual(rfq.order_line.price_unit, 90000.0)
        self.assertEqual(rfq.origin, rule.name, "RFQ menunjuk ke aturan stok minimum asalnya")
