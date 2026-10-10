from datetime import timedelta

from odoo import Command, fields
from odoo.addons.account.tests.common import AccountTestInvoicingCommon
from odoo.exceptions import UserError
from odoo.tests import tagged


@tagged("post_install", "-at_install", "nusara")
class TestLotTracking(AccountTestInvoicingCommon):
    """Lot, nomor seri, dan tanggal kedaluwarsa pada penerimaan, pengiriman, retur, scrap, dan hitung fisik (D19)."""

    @classmethod
    @AccountTestInvoicingCommon.setup_country("id")
    def setUpClass(cls):
        super().setUpClass()
        cls.env.user.write(
            {
                "group_ids": [
                    Command.link(cls.env.ref("stock.group_stock_manager").id),
                    Command.link(cls.env.ref("purchase.group_purchase_user").id),
                    Command.link(cls.env.ref("sales_team.group_sale_manager").id),
                    Command.link(cls.env.ref("stock.group_production_lot").id),
                ]
            }
        )
        cls.company = cls.env.company
        cls.company.nusara_setup_inventory_valuation()
        cls.goods = cls.env.ref("product.product_category_goods").with_company(cls.company)
        cls.warehouse = cls.env["stock.warehouse"].search([("company_id", "=", cls.company.id)], limit=1)
        cls.stock_location = cls.warehouse.lot_stock_id
        cls.customer = cls.env["res.partner"].create({"name": "PT Pelanggan Lot", "is_company": True, "customer_rank": 1})

    @classmethod
    def _tracked_product(cls, name, tracking="lot", **extra):
        return cls._create_product(
            name=name, type="consu", is_storable=True, tracking=tracking, categ_id=cls.goods.id, standard_price=50000.0, list_price=80000.0, **extra
        )

    def _receive(self, product, lots, **line_vals):
        """Penerimaan dari PO: lots = [(nama, jumlah)]. Meniru UI: baris pertama diubah, sisanya dibuat."""
        total = sum(qty for _name, qty in lots)
        po = self.env["purchase.order"].create(
            {
                "partner_id": self.partner_a.id,
                "order_line": [Command.create({"product_id": product.id, "product_qty": total, "price_unit": 50000.0})],
            }
        )
        po.button_confirm()
        picking = po.picking_ids
        move = picking.move_ids
        first = move.move_line_ids[:1]
        for index, (name, qty) in enumerate(lots):
            vals = {"lot_name": name, "quantity": qty, "picked": True, **line_vals}
            if index == 0:
                first.write(vals)
            else:
                self.env["stock.move.line"].create(
                    {
                        "move_id": move.id,
                        "picking_id": picking.id,
                        "product_id": product.id,
                        "product_uom_id": move.product_uom.id,
                        "location_id": move.location_id.id,
                        "location_dest_id": move.location_dest_id.id,
                        **vals,
                    }
                )
        return po, picking

    def _on_hand(self, product, lot):
        quant = self.env["stock.quant"].search(
            [("product_id", "=", product.id), ("lot_id", "=", lot.id), ("location_id", "child_of", self.stock_location.id)]
        )
        return sum(quant.mapped("quantity"))

    def _lot(self, product, name):
        return self.env["stock.lot"].search([("product_id", "=", product.id), ("name", "=", name)])

    def test_receipt_requires_lot_then_creates_lots(self):
        product = self._tracked_product("Obat Lot Nusara")
        po = self.env["purchase.order"].create(
            {"partner_id": self.partner_a.id, "order_line": [Command.create({"product_id": product.id, "product_qty": 10.0, "price_unit": 50000.0})]}
        )
        po.button_confirm()
        picking = po.picking_ids
        picking.move_ids.move_line_ids.write({"picked": True})
        with self.assertRaises(UserError, msg="Barang berlacak tidak boleh diterima tanpa nomor lot"):
            picking.button_validate()

        _po, picking = self._receive(product, [("LOT-A", 6.0), ("LOT-B", 4.0)])
        picking.button_validate()
        self.assertEqual(picking.state, "done")
        lot_a, lot_b = self._lot(product, "LOT-A"), self._lot(product, "LOT-B")
        self.assertEqual((lot_a.product_qty, lot_b.product_qty), (6.0, 4.0))
        self.assertEqual(lot_a.purchase_order_ids, picking.purchase_id | lot_a.purchase_order_ids)

    def test_same_lot_name_reuses_existing_lot(self):
        product = self._tracked_product("Obat Lot Sama")
        self._receive(product, [("LOT-X", 5.0)])[1].button_validate()
        self._receive(product, [("LOT-X", 3.0)])[1].button_validate()
        lots = self.env["stock.lot"].search([("product_id", "=", product.id)])
        self.assertEqual(len(lots), 1, "Nomor lot yang sama dipakai ulang, bukan dibuat dobel")
        self.assertEqual(lots.product_qty, 8.0)

    def test_delivery_by_lot_and_return_keeps_lot(self):
        product = self._tracked_product("Obat Kirim Lot")
        self._receive(product, [("LOT-A", 6.0), ("LOT-B", 4.0)])[1].button_validate()
        lot_a, lot_b = self._lot(product, "LOT-A"), self._lot(product, "LOT-B")

        order = self.env["sale.order"].create(
            {"partner_id": self.customer.id, "order_line": [Command.create({"product_id": product.id, "product_uom_qty": 7.0})]}
        )
        order.action_confirm()
        delivery = order.picking_ids
        self.assertEqual(delivery.state, "assigned", "Stok lot cukup, jadi pengiriman siap")
        reserved = delivery.move_ids.move_line_ids
        self.assertEqual(sum(reserved.mapped("quantity")), 7.0)
        self.assertTrue(all(reserved.mapped("lot_id")), "Odoo memesan lot tertentu untuk barang berlacak")

        # Seperti UI: hapus pemesanan otomatis, lalu pilih lot sendiri (3 dari A, 4 dari B).
        move = delivery.move_ids
        reserved.unlink()
        for lot, qty in ((lot_a, 3.0), (lot_b, 4.0)):
            self.env["stock.move.line"].create(
                {
                    "move_id": move.id, "picking_id": delivery.id, "product_id": product.id, "product_uom_id": move.product_uom.id,
                    "location_id": move.location_id.id, "location_dest_id": move.location_dest_id.id, "lot_id": lot.id, "quantity": qty, "picked": True,
                }
            )
        delivery.button_validate()
        self.assertEqual(delivery.state, "done")
        self.assertEqual((self._on_hand(product, lot_a), self._on_hand(product, lot_b)), (3.0, 0.0))
        self.assertIn(delivery, lot_b.delivery_ids)
        self.assertEqual(lot_b.sale_order_ids, order)

        wizard = self.env["stock.return.picking"].with_context(active_model="stock.picking", active_ids=delivery.ids, active_id=delivery.id).create({})
        wizard.product_return_moves.filtered(lambda line: line.product_id == product).quantity = 2.0
        returned = self.env["stock.picking"].browse(wizard.action_create_returns()["res_id"])
        self.assertEqual(returned.state, "assigned")
        self.assertTrue(returned.move_ids.move_line_ids.lot_id, "Retur membawa lot dari pengiriman asal")
        returned.move_ids.move_line_ids.write({"picked": True})
        returned.button_validate()
        self.assertEqual(returned.state, "done")
        self.assertEqual(self._on_hand(product, lot_a) + self._on_hand(product, lot_b), 5.0)

    def test_change_lot_on_reserved_delivery_line(self):
        product = self._tracked_product("Obat Ganti Lot")
        self._receive(product, [("LOT-A", 5.0), ("LOT-B", 5.0)])[1].button_validate()
        lot_b = self._lot(product, "LOT-B")
        order = self.env["sale.order"].create(
            {"partner_id": self.customer.id, "order_line": [Command.create({"product_id": product.id, "product_uom_qty": 2.0})]}
        )
        order.action_confirm()
        delivery = order.picking_ids
        line = delivery.move_ids.move_line_ids
        self.assertEqual(len(line), 1)
        line.write({"lot_id": lot_b.id, "picked": True})
        delivery.button_validate()
        self.assertEqual(delivery.state, "done")
        self.assertEqual(self._on_hand(product, lot_b), 3.0)
        self.assertEqual(self._on_hand(product, self._lot(product, "LOT-A")), 5.0)

    def test_serial_numbers_one_unit_each(self):
        product = self._tracked_product("Laptop Seri Nusara", tracking="serial")
        po = self.env["purchase.order"].create(
            {"partner_id": self.partner_a.id, "order_line": [Command.create({"product_id": product.id, "product_qty": 3.0, "price_unit": 50000.0})]}
        )
        po.button_confirm()
        picking = po.picking_ids
        picking.move_ids.move_line_ids.write({"lot_name": "SN-001", "quantity": 3.0, "picked": True})
        with self.assertRaises(UserError, msg="Satu nomor seri tidak boleh untuk tiga unit"):
            picking.button_validate()

        move = picking.move_ids
        move.move_line_ids.unlink()
        for serial in ("SN-001", "SN-002", "SN-003"):
            self.env["stock.move.line"].create(
                {
                    "move_id": move.id, "picking_id": picking.id, "product_id": product.id, "product_uom_id": move.product_uom.id,
                    "location_id": move.location_id.id, "location_dest_id": move.location_dest_id.id, "lot_name": serial, "quantity": 1.0, "picked": True,
                }
            )
        picking.button_validate()
        self.assertEqual(picking.state, "done")
        self.assertEqual(self.env["stock.lot"].search_count([("product_id", "=", product.id)]), 3)

        # Nomor seri yang sudah ada di stok tidak bisa diterima lagi.
        po2 = self.env["purchase.order"].create(
            {"partner_id": self.partner_a.id, "order_line": [Command.create({"product_id": product.id, "product_qty": 1.0, "price_unit": 50000.0})]}
        )
        po2.button_confirm()
        picking2 = po2.picking_ids
        picking2.move_ids.move_line_ids.write({"lot_name": "SN-002", "quantity": 1.0, "picked": True})
        with self.assertRaises(UserError, msg="Nomor seri ganda ditolak"):
            picking2.button_validate()

    def test_expiration_dates_follow_product_settings(self):
        product = self._tracked_product("Susu Kedaluwarsa", use_expiration_date=True, expiration_time=180, use_time=150, removal_time=120, alert_time=90)
        _po, picking = self._receive(product, [("SUSU-01", 20.0)])
        picking.button_validate()
        lot = self._lot(product, "SUSU-01")
        expected = fields.Datetime.now() + timedelta(days=180)
        self.assertLess(abs((lot.expiration_date - expected).total_seconds()), 3600, "Kedaluwarsa = saat diterima + 180 hari")
        self.assertEqual((lot.expiration_date - lot.removal_date).days, 120)
        self.assertEqual((lot.expiration_date - lot.alert_date).days, 90)
        self.assertEqual((lot.expiration_date - lot.use_date).days, 150)

        # Tanggal kedaluwarsa bisa diisi per lot saat penerimaan. Lot yang sudah masuk masa peringatan (alert_date terlewati)
        # membuat Odoo meminta konfirmasi lewat wizard expiry.picking.confirmation; UI menjalankannya dengan process().
        _po, picking = self._receive(product, [("SUSU-02", 5.0)], expiration_date=fields.Datetime.now() + timedelta(days=30))
        result = picking.button_validate()
        self.assertEqual(result["res_model"], "expiry.picking.confirmation", "Lot hampir kedaluwarsa meminta konfirmasi")
        # Lot baru belum ada saat pemeriksaan, jadi nama lot dan produk dibawa lewat konteks wizard.
        self.assertEqual(result["context"]["expired_lot_name"], "SUSU-02")
        wizard = self.env["expiry.picking.confirmation"].with_context(**result["context"]).create({})
        wizard.process()
        self.assertEqual(picking.state, "done")
        lot = self._lot(product, "SUSU-02")
        self.assertLess(abs((lot.expiration_date - (fields.Datetime.now() + timedelta(days=30))).total_seconds()), 3600)

    def test_scrap_needs_lot_and_reduces_that_lot(self):
        product = self._tracked_product("Obat Scrap Lot")
        self._receive(product, [("LOT-A", 6.0), ("LOT-B", 4.0)])[1].button_validate()
        lot_a, lot_b = self._lot(product, "LOT-A"), self._lot(product, "LOT-B")
        values = {"product_id": product.id, "scrap_qty": 2.0, "product_uom_id": product.uom_id.id, "location_id": self.stock_location.id}
        # Tanpa lot, Odoo tidak menolak lewat error tetapi mengembalikan wizard "stok tidak cukup" (stok tanpa lot nol),
        # dan scrap tetap draft. Halaman Scrap Nusara mewajibkan lot untuk produk berlacak sehingga wizard itu tidak muncul.
        unscrapped = self.env["stock.scrap"].create(values)
        result = unscrapped.action_validate()
        self.assertEqual(result["res_model"], "stock.warn.insufficient.qty.scrap")
        self.assertEqual(unscrapped.state, "draft")
        self.assertEqual((self._on_hand(product, lot_a), self._on_hand(product, lot_b)), (6.0, 4.0))
        scrap = self.env["stock.scrap"].create({**values, "lot_id": lot_b.id})
        scrap.action_validate()
        self.assertEqual(scrap.state, "done")
        self.assertEqual((self._on_hand(product, lot_a), self._on_hand(product, lot_b)), (6.0, 2.0))

    def test_physical_count_with_lot(self):
        product = self._tracked_product("Obat Hitung Lot")
        lot = self.env["stock.lot"].create({"name": "LOT-HITUNG", "product_id": product.id})
        quant = (
            self.env["stock.quant"]
            .with_context(inventory_mode=True)
            .create({"product_id": product.id, "location_id": self.stock_location.id, "lot_id": lot.id, "inventory_quantity": 12.0})
        )
        quant.action_apply_inventory()
        self.assertEqual(self._on_hand(product, lot), 12.0)
        self.assertEqual(lot.product_qty, 12.0)

    def test_lot_filters_used_by_the_ui(self):
        """Domain yang dipakai halaman Lot: stok > 0, tanggal kedaluwarsa, dan alert_date."""
        product = self._tracked_product("Susu Filter", use_expiration_date=True, expiration_time=30, alert_time=10)
        self._receive(product, [("SF-1", 5.0)])[1].button_validate()
        now = fields.Datetime.now()
        lots = self.env["stock.lot"]
        self.assertIn(self._lot(product, "SF-1"), lots.search([("product_qty", ">", 0)]))
        self.assertNotIn(self._lot(product, "SF-1"), lots.search([("expiration_date", "<", now), ("product_qty", ">", 0)]))
        lot = self._lot(product, "SF-1")
        lot.expiration_date = now - timedelta(days=1)
        self.assertIn(lot, lots.search([("expiration_date", "<", now), ("product_qty", ">", 0)]))
        lot.write({"expiration_date": now + timedelta(days=5), "alert_date": now - timedelta(days=1)})
        self.assertIn(lot, lots.search([("alert_date", "<", now), ("expiration_date", ">=", now), ("product_qty", ">", 0)]))
