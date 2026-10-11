from odoo import Command
from odoo.addons.account.tests.common import AccountTestInvoicingCommon
from odoo.exceptions import UserError
from odoo.tests import tagged


@tagged("post_install", "-at_install", "nusara")
class TestManufacturing(AccountTestInvoicingCommon):
    """BoM, Manufacturing Order, produksi sebagian, konsumsi berlebih, unbuild, work order, dan biaya (D20)."""

    @classmethod
    @AccountTestInvoicingCommon.setup_country("id")
    def setUpClass(cls):
        super().setUpClass()
        cls.env.user.write(
            {
                "group_ids": [
                    Command.link(cls.env.ref("stock.group_stock_manager").id),
                    Command.link(cls.env.ref("mrp.group_mrp_manager").id),
                    Command.link(cls.env.ref("stock.group_production_lot").id),
                ]
            }
        )
        cls.company = cls.env.company
        cls.company.nusara_setup_inventory_valuation()
        cls.goods = cls.env.ref("product.product_category_goods").with_company(cls.company)
        cls.warehouse = cls.env["stock.warehouse"].search([("company_id", "=", cls.company.id)], limit=1)
        cls.stock_location = cls.warehouse.lot_stock_id
        common = {"type": "consu", "is_storable": True, "categ_id": cls.goods.id}
        cls.flour = cls._create_product(name="Tepung Nusara", standard_price=10000.0, **common)
        cls.sugar = cls._create_product(name="Gula Nusara", standard_price=5000.0, **common)
        cls.cake = cls._create_product(name="Kue Nusara", standard_price=0.0, **common)
        for product, qty in ((cls.flour, 100.0), (cls.sugar, 100.0)):
            cls._count(product, qty)
        cls.bom = cls.env["mrp.bom"].create(
            {
                "product_tmpl_id": cls.cake.product_tmpl_id.id,
                "product_qty": 1.0,
                "product_uom_id": cls.cake.uom_id.id,
                "bom_line_ids": [
                    Command.create({"product_id": cls.flour.id, "product_qty": 2.0}),
                    Command.create({"product_id": cls.sugar.id, "product_qty": 1.0}),
                ],
            }
        )

    @classmethod
    def _count(cls, product, quantity):
        quant = (
            cls.env["stock.quant"]
            .with_context(inventory_mode=True)
            .create({"product_id": product.id, "location_id": cls.stock_location.id, "inventory_quantity": quantity})
        )
        quant.action_apply_inventory()

    def _on_hand(self, product):
        return product.with_context(location=self.stock_location.id).qty_available

    def _mo(self, qty, bom=None, product=None):
        mo = self.env["mrp.production"].create(
            {"product_id": (product or self.cake).id, "product_qty": qty, "bom_id": (bom or self.bom).id}
        )
        mo.action_confirm()
        return mo

    def _produce(self, mo, qty, consume=None):
        """Seperti UI: isi jumlah diproduksi dan konsumsi komponen, lalu tandai selesai."""
        mo.qty_producing = qty
        for move in mo.move_raw_ids:
            planned = move.product_uom_qty * qty / mo.product_qty
            used = (consume or {}).get(move.product_id, planned)
            move.write({"quantity": used, "picked": used > 0})
        return mo.button_mark_done()

    def test_complete_mo_values_goods_and_posts_no_journal(self):
        journals_before = self.env["account.move"].search_count([])
        mo = self._mo(3.0)
        self.assertEqual(mo.state, "confirmed")
        self.assertEqual(mo.reservation_state, "assigned", "Komponen cukup, jadi dicadangkan")
        self.assertEqual({m.product_id: m.product_uom_qty for m in mo.move_raw_ids}, {self.flour: 6.0, self.sugar: 3.0})
        self.assertTrue(self._produce(mo, 3.0))
        self.assertEqual(mo.state, "done")
        self.assertEqual((self._on_hand(self.flour), self._on_hand(self.sugar), self._on_hand(self.cake)), (94.0, 97.0, 3.0))
        # Biaya barang jadi = jumlah biaya komponen: 2 x 10.000 + 1 x 5.000 = 25.000 per unit.
        finished = mo.move_finished_ids
        self.assertEqual(abs(finished.value), 75000.0)
        self.assertEqual(self.cake.avg_cost, 25000.0)
        self.assertEqual(self.env["account.move"].search_count([]), journals_before, "Valuasi saat penagihan: produksi tidak menjurnal")

    def test_partial_production_creates_backorder(self):
        mo = self._mo(3.0)
        wizard_action = self._produce(mo, 2.0)
        self.assertEqual(wizard_action["res_model"], "mrp.production.backorder")
        wizard = self.env["mrp.production.backorder"].with_context(**wizard_action["context"]).create({})
        wizard.action_backorder()
        self.assertEqual(mo.state, "done")
        self.assertEqual(mo.qty_produced, 2.0)
        backorder = self.env["mrp.production"].search([("product_id", "=", self.cake.id), ("id", "!=", mo.id), ("production_group_id", "=", mo.production_group_id.id)])
        self.assertEqual(len(backorder), 1)
        self.assertEqual((backorder.state, backorder.product_qty), ("confirmed", 1.0))
        self.assertEqual(self._on_hand(self.cake), 2.0)

    def test_close_without_backorder(self):
        mo = self._mo(3.0)
        action = self._produce(mo, 2.0)
        wizard = self.env["mrp.production.backorder"].with_context(**action["context"]).create({})
        wizard.action_close_mo()
        self.assertEqual(mo.state, "done")
        self.assertEqual(self.env["mrp.production"].search_count([("product_id", "=", self.cake.id), ("state", "=", "confirmed")]), 0)

    def test_extra_consumption_asks_for_confirmation(self):
        mo = self._mo(2.0)
        action = self._produce(mo, 2.0, consume={self.flour: 5.0, self.sugar: 2.0})
        self.assertEqual(action["res_model"], "mrp.consumption.warning", "Konsumsi lebih dari rencana (4) meminta konfirmasi")
        wizard = self.env["mrp.consumption.warning"].with_context(**action["context"]).create({})
        wizard.action_confirm()
        self.assertEqual(mo.state, "done")
        self.assertEqual(self._on_hand(self.flour), 95.0)
        self.assertEqual(self.cake.avg_cost, 30000.0, "Biaya mengikuti konsumsi sebenarnya: (5 x 10.000 + 2 x 5.000) / 2")

    def test_cancel_releases_reservation(self):
        mo = self._mo(4.0)
        self.assertEqual(sum(mo.move_raw_ids.mapped("quantity")), 12.0)
        mo.action_cancel()
        self.assertEqual(mo.state, "cancel")
        reserved = self.env["stock.quant"].search([("product_id", "in", (self.flour + self.sugar).ids), ("location_id", "=", self.stock_location.id)]).mapped("reserved_quantity")
        self.assertEqual(sum(reserved), 0.0)

    def test_unbuild_returns_components(self):
        mo = self._mo(2.0)
        self._produce(mo, 2.0)
        unbuild = self.env["mrp.unbuild"].create(
            {
                "mo_id": mo.id,
                "product_id": self.cake.id,
                "product_qty": 1.0,
                "product_uom_id": self.cake.uom_id.id,
                "location_id": mo.location_dest_id.id,
                "location_dest_id": mo.location_src_id.id,
            }
        )
        unbuild.action_validate()
        self.assertEqual(unbuild.state, "done")
        self.assertEqual((self._on_hand(self.cake), self._on_hand(self.flour), self._on_hand(self.sugar)), (1.0, 98.0, 99.0))

    def test_lot_tracked_product_and_byproduct_cost_share(self):
        syrup = self._create_product(name="Sirup Nusara", type="consu", is_storable=True, tracking="lot", categ_id=self.goods.id)
        pulp = self._create_product(name="Ampas Nusara", type="consu", is_storable=True, categ_id=self.goods.id)
        self.env["res.config.settings"].create({"group_mrp_byproducts": True}).execute()
        bom = self.env["mrp.bom"].create(
            {
                "product_tmpl_id": syrup.product_tmpl_id.id,
                "product_qty": 1.0,
                "product_uom_id": syrup.uom_id.id,
                "bom_line_ids": [Command.create({"product_id": self.flour.id, "product_qty": 1.0})],
                "byproduct_ids": [Command.create({"product_id": pulp.id, "product_qty": 0.5, "product_uom_id": pulp.uom_id.id, "cost_share": 10.0})],
            }
        )
        mo = self._mo(4.0, bom=bom, product=syrup)
        lot = self.env["stock.lot"].create({"name": "SRP-001", "product_id": syrup.id})
        mo.lot_producing_ids = [Command.set(lot.ids)]
        self._produce(mo, 4.0)
        self.assertEqual(mo.state, "done")
        self.assertEqual(lot.product_qty, 4.0)
        values = {move.product_id: abs(move.value) for move in mo.move_finished_ids}
        self.assertEqual(values[syrup], 36000.0, "90% dari biaya komponen 40.000")
        self.assertEqual(values[pulp], 4000.0, "Produk sampingan menanggung 10%")
        self.assertEqual(self._on_hand(pulp), 2.0)

    def test_lot_tracked_product_gets_a_lot_when_none_is_given(self):
        syrup = self._create_product(name="Sirup Otomatis", type="consu", is_storable=True, tracking="lot", categ_id=self.goods.id)
        bom = self.env["mrp.bom"].create(
            {
                "product_tmpl_id": syrup.product_tmpl_id.id,
                "product_qty": 1.0,
                "product_uom_id": syrup.uom_id.id,
                "bom_line_ids": [Command.create({"product_id": self.sugar.id, "product_qty": 1.0})],
            }
        )
        mo = self._mo(2.0, bom=bom, product=syrup)
        self._produce(mo, 2.0)
        self.assertEqual(mo.state, "done")
        lots = self.env["stock.lot"].search([("product_id", "=", syrup.id)])
        self.assertEqual(len(lots), 1, "Odoo membuat nomor lot otomatis bila tidak diisi")
        self.assertEqual(lots.product_qty, 2.0)

    def test_work_orders_and_bom_cost_report(self):
        self.env["res.config.settings"].create({"group_mrp_routings": True}).execute()
        center = self.env["mrp.workcenter"].create({"name": "Oven Nusara", "code": "OVN", "costs_hour": 60000.0, "time_efficiency": 100.0})
        bom = self.env["mrp.bom"].create(
            {
                "product_tmpl_id": self.cake.product_tmpl_id.id,
                "product_qty": 1.0,
                "product_uom_id": self.cake.uom_id.id,
                "bom_line_ids": [Command.create({"product_id": self.flour.id, "product_qty": 2.0})],
                "operation_ids": [Command.create({"name": "Panggang", "workcenter_id": center.id, "time_cycle_manual": 30.0})],
            }
        )
        # Laporan biaya BoM yang dipakai halaman BoM: komponen 2 x 10.000 + operasi 30 menit x 60.000/jam.
        data = self.env["report.mrp.report_bom_structure"].get_html(bom_id=bom.id, searchQty=1)["lines"]
        self.assertEqual(data["operations_cost"], 30000.0)
        self.assertEqual(data["operations_time"], 30.0)
        self.assertEqual(data["bom_cost"], 50000.0)
        self.assertEqual(sum(c["bom_cost"] for c in data["components"]), 20000.0)

        mo = self._mo(2.0, bom=bom)
        self.assertEqual(len(mo.workorder_ids), 1)
        workorder = mo.workorder_ids
        self.assertEqual((workorder.state, workorder.duration_expected), ("ready", 60.0))
        workorder.button_start()
        self.assertEqual(workorder.state, "progress")
        self.assertEqual(mo.state, "progress")
        workorder.button_finish()
        self.assertEqual((workorder.state, mo.state), ("done", "to_close"))
        self._produce(mo, 2.0)
        self.assertEqual(mo.state, "done")
        self.assertEqual(workorder.duration, 60.0, "Tanpa waktu nyata, MO selesai mengisi durasi aktual sebesar durasi rencana")
        # Nilai barang jadi mencakup biaya operasi: komponen 4 x 10.000 ditambah 60 menit x 60.000 per jam.
        self.assertEqual(abs(mo.move_finished_ids.value), 100000.0)

    def test_byproduct_quantity_is_not_scaled_by_api_writes(self):
        """Lewat API, qty_producing tidak mengubah jumlah produk sampingan; UI menyesuaikannya sendiri."""
        self.env["res.config.settings"].create({"group_mrp_byproducts": True}).execute()
        pulp = self._create_product(name="Ampas Skala", type="consu", is_storable=True, categ_id=self.goods.id)
        bom = self.env["mrp.bom"].create(
            {
                "product_tmpl_id": self.cake.product_tmpl_id.id,
                "product_qty": 1.0,
                "product_uom_id": self.cake.uom_id.id,
                "bom_line_ids": [Command.create({"product_id": self.flour.id, "product_qty": 1.0})],
                "byproduct_ids": [Command.create({"product_id": pulp.id, "product_qty": 1.0, "product_uom_id": pulp.uom_id.id, "cost_share": 10.0})],
            }
        )
        mo = self._mo(4.0, bom=bom)
        side = mo.move_finished_ids.filtered(lambda move: move.byproduct_id)
        mo.qty_producing = 2.0
        self.assertEqual(side.quantity, 4.0, "Jumlah produk sampingan tetap sebesar rencana sampai disesuaikan")
        side.quantity = side.product_uom_qty * 2.0 / mo.product_qty
        mo.move_raw_ids.write({"quantity": 2.0, "picked": True})
        action = mo.button_mark_done()
        self.env["mrp.production.backorder"].with_context(**action["context"]).create({}).action_backorder()
        self.assertEqual(self._on_hand(pulp), 2.0)

    def test_blocked_when_components_are_missing(self):
        mo = self._mo(80.0)  # butuh 160 tepung, stok 100
        self.assertEqual(mo.reservation_state, "confirmed", "Komponen kurang: MO menunggu")
        self.assertEqual(mo.components_availability_state, "unavailable")
        with self.assertRaises(UserError, msg="Tidak bisa membatalkan MO yang sudah selesai"):
            done = self._mo(1.0)
            self._produce(done, 1.0)
            done.action_cancel()
