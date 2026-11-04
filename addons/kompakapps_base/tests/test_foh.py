from odoo import Command
from odoo.addons.account.tests.common import AccountTestInvoicingCommon
from odoo.tests import tagged


@tagged("post_install", "-at_install", "kompakapps")
class TestFactoryOverhead(AccountTestInvoicingCommon):
    """Work center membawa tarif FOH per jam; work order yang selesai membebankannya ke produksi dan nilainya masuk Inventory COGM (Q63, D91)."""

    @classmethod
    @AccountTestInvoicingCommon.setup_country("id")
    def setUpClass(cls):
        super().setUpClass()
        cls.env.user.write({"group_ids": [Command.link(cls.env.ref("stock.group_stock_manager").id), Command.link(cls.env.ref("mrp.group_mrp_manager").id)]})
        cls.env["res.config.settings"].create({"group_mrp_routings": True}).execute()
        cls.company = cls.env.company
        cls.company.kompakapps_setup_inventory_valuation()
        cls.company.kompakapps_setup_stock_journals()
        goods = cls.env.ref("product.product_category_goods").with_company(cls.company)
        cls.raw_category = cls.env["product.category"].create({"name": "Bahan Baku FOH", "parent_id": goods.id, "property_cost_method": "average"})
        cls.fin_category = cls.env["product.category"].create({"name": "Barang Jadi FOH", "parent_id": goods.id, "property_cost_method": "average"})
        cls.company.kompakapps_split_inventory_accounts(cls.raw_category, cls.fin_category)
        cls.raw_account = cls.raw_category.property_stock_valuation_account_id
        cls.cogm_account = cls.fin_category.property_stock_valuation_account_id
        cls.foh_account = cls.env["account.account"].search([("code", "=", "51100002"), ("company_ids", "in", cls.company.id)])
        cls.wip_account = cls.env["stock.location"].search([("company_id", "=", cls.company.id), ("usage", "=", "production")], limit=1).valuation_account_id
        common = {"type": "consu", "is_storable": True, "standard_price": 0.0, "list_price": 500000.0, "taxes_id": [Command.clear()], "supplier_taxes_id": [Command.clear()]}
        cls.raw = cls._create_product(name="Bahan FOH", categ_id=cls.raw_category.id, **common)
        cls.fin = cls._create_product(name="Barang Jadi FOH", categ_id=cls.fin_category.id, **common)
        vendor = cls.env["res.partner"].create({"name": "PT Pemasok FOH", "is_company": True, "supplier_rank": 1})
        order = cls.env["purchase.order"].create({"partner_id": vendor.id, "order_line": [Command.create({"product_id": cls.raw.id, "product_qty": 20.0, "price_unit": 100000.0})]})
        order.button_confirm()
        order.picking_ids.move_ids.quantity = 20.0
        order.picking_ids.move_ids.picked = True
        order.picking_ids.button_validate()

    def _balance(self, account):
        lines = self.env["account.move.line"].search([("account_id", "=", account.id), ("parent_state", "=", "posted"), ("company_id", "=", self.company.id)])
        return round(sum(lines.mapped("balance")), 2)

    def _workcenter(self, **vals):
        return self.env["mrp.workcenter"].create({"name": "Mesin Filling", "code": "FILL", "costs_hour": 60000.0, **vals})

    def _bom(self, workcenter, minutes=30.0, cost_mode="estimated"):
        return self.env["mrp.bom"].create(
            {
                "product_tmpl_id": self.fin.product_tmpl_id.id,
                "product_qty": 1.0,
                "product_uom_id": self.fin.uom_id.id,
                "bom_line_ids": [Command.create({"product_id": self.raw.id, "product_qty": 2.0})],
                "operation_ids": [Command.create({"name": "Filling", "workcenter_id": workcenter.id, "time_cycle_manual": minutes, "cost_mode": cost_mode})],
            }
        )

    def _produce(self, bom, qty):
        production = self.env["mrp.production"].create({"product_id": self.fin.id, "product_qty": qty, "bom_id": bom.id})
        production.action_confirm()
        workorder = production.workorder_ids
        workorder.button_start()
        workorder.button_finish()
        production.qty_producing = qty
        for move in production.move_raw_ids:
            move.write({"quantity": move.product_uom_qty, "picked": True})
        production.button_mark_done()
        self.assertEqual(production.state, "done")
        return production

    def test_new_work_center_defaults_to_the_foh_account(self):
        self.assertEqual(self.foh_account.name, "FOH Dibebankan ke Produksi")
        self.assertEqual(self.foh_account.kompakapps_report_group, "perubahan_persediaan")
        self.assertEqual(self._workcenter().expense_account_id, self.foh_account)

    def test_setup_fills_work_centers_without_an_account_and_is_idempotent(self):
        bare = self._workcenter(name="Tanpa Akun", code="BARE", expense_account_id=False)
        self.assertFalse(bare.expense_account_id)
        accounts_before = self.env["account.account"].search_count([])
        self.company.kompakapps_setup_foh()
        self.assertEqual(bare.expense_account_id, self.foh_account)
        self.assertEqual(self.env["account.account"].search_count([]), accounts_before)

    def test_foh_is_charged_to_production_and_lands_in_inventory_cogm(self):
        production = self._produce(self._bom(self._workcenter()), 2.0)
        # 2 siklus x 30 menit = 60 menit x Rp60.000 per jam = Rp60.000 FOH; komponen 4 x 100.000
        self.assertEqual(production.workorder_ids.duration_expected, 60.0)
        finished = production.move_finished_ids
        self.assertEqual(finished.value, 460000.0, "Nilai barang jadi = komponen 400.000 + FOH 60.000")
        self.assertEqual(self.fin.total_value, 460000.0)
        self.assertEqual(self._balance(self.cogm_account), 460000.0, "Saldo Inventory COGM memuat FOH")
        self.assertEqual(self._balance(self.foh_account), -60000.0, "FOH dibebankan dikredit")
        self.assertEqual(self._balance(self.wip_account), 0.0, "Barang Dalam Proses habis")
        self.assertEqual(self._balance(self.raw_account), self.raw.total_value, "Bahan baku tetap sama dengan nilai stok")
        labour = self.env["account.move"].search([("ref", "=like", f"{production.name} - %"), ("id", "!=", finished.account_move_id.id)])
        self.assertEqual(len(labour), 1)
        self.assertEqual(labour.ref, f"{production.name} - Biaya produksi (FOH)")
        lines = {line.account_id: (line.debit, line.credit) for line in labour.line_ids}
        self.assertEqual(lines, {self.wip_account: (60000.0, 0.0), self.foh_account: (0.0, 60000.0)})

    def test_no_foh_when_the_rate_is_zero(self):
        production = self._produce(self._bom(self._workcenter(costs_hour=0.0)), 1.0)
        self.assertEqual(production.move_finished_ids.value, 200000.0)
        self.assertEqual(self._balance(self.foh_account), 0.0)
        self.assertEqual(self._balance(self.cogm_account), 200000.0)
