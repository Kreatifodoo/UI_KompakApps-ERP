from odoo import Command, fields
from odoo.addons.account.tests.common import AccountTestInvoicingCommon
from odoo.tests import tagged


@tagged("post_install", "-at_install", "kompakapps")
class TestInventorySplit(AccountTestInvoicingCommon):
    """Akun persediaan dipisah menurut kategori: bahan baku dan barang jadi (COGM), termasuk jurnal yang sudah ada (Q61, D89)."""

    @classmethod
    @AccountTestInvoicingCommon.setup_country("id")
    def setUpClass(cls):
        super().setUpClass()
        cls.env.user.write(
            {
                "group_ids": [
                    Command.link(cls.env.ref("sales_team.group_sale_manager").id),
                    Command.link(cls.env.ref("stock.group_stock_manager").id),
                    Command.link(cls.env.ref("mrp.group_mrp_manager").id),
                ]
            }
        )
        cls.company = cls.env.company
        cls.company.kompakapps_setup_inventory_valuation()
        cls.company.kompakapps_setup_stock_journals()
        goods = cls.env.ref("product.product_category_goods").with_company(cls.company)
        cls.old_account = goods.property_stock_valuation_account_id
        cls.raw_category = cls.env["product.category"].create({"name": "Bahan Baku Uji", "parent_id": goods.id, "property_cost_method": "average"})
        cls.fin_category = cls.env["product.category"].create({"name": "Barang Jadi Uji", "parent_id": goods.id, "property_cost_method": "average"})
        cls.vendor = cls.env["res.partner"].create({"name": "PT Pemasok Pisah Akun", "is_company": True, "supplier_rank": 1})
        cls.customer = cls.env["res.partner"].create({"name": "PT Pelanggan Pisah Akun", "is_company": True, "customer_rank": 1})
        common = {"type": "consu", "is_storable": True, "standard_price": 0.0, "list_price": 150000.0, "taxes_id": [Command.clear()], "supplier_taxes_id": [Command.clear()]}
        cls.raw = cls._create_product(name="Bahan Baku Pisah Akun", categ_id=cls.raw_category.id, **common)
        cls.fin = cls._create_product(name="Barang Jadi Pisah Akun", categ_id=cls.fin_category.id, **common)

    # ------------------------------------------------------------------ pembantu

    def _balance(self, account, product=None):
        domain = [("account_id", "=", account.id), ("parent_state", "=", "posted"), ("company_id", "=", self.company.id)]
        if product:
            domain.append(("product_id", "=", product.id))
        return round(sum(self.env["account.move.line"].search(domain).mapped("balance")), 2)

    def _receive_and_bill(self, product, qty=10.0, price=100000.0):
        order = self.env["purchase.order"].create(
            {"partner_id": self.vendor.id, "order_line": [Command.create({"product_id": product.id, "product_qty": qty, "price_unit": price})]}
        )
        order.button_confirm()
        picking = order.picking_ids
        picking.move_ids.quantity = qty
        picking.move_ids.picked = True
        picking.button_validate()
        order.action_create_invoice()
        bill = order.invoice_ids
        bill.invoice_date = fields.Date.today()
        bill.action_post()
        return order, picking

    def _sell(self, product, qty):
        order = self.env["sale.order"].create({"partner_id": self.customer.id, "order_line": [Command.create({"product_id": product.id, "product_uom_qty": qty})]})
        order.action_confirm()
        picking = order.picking_ids
        picking.move_ids.quantity = qty
        picking.move_ids.picked = True
        picking.button_validate()
        invoice = order._create_invoices()
        invoice.action_post()
        return order

    def _totals(self):
        """Debit dan kredit per jurnal: tidak boleh berubah oleh pemisahan akun."""
        lines = self.env["account.move.line"].search([("company_id", "=", self.company.id)])
        result = {}
        for line in lines:
            debit, credit = result.get(line.move_id.id, (0.0, 0.0))
            result[line.move_id.id] = (round(debit + line.debit, 2), round(credit + line.credit, 2))
        return result

    # ------------------------------------------------------------------ uji

    def test_existing_entries_move_to_the_new_accounts(self):
        self._receive_and_bill(self.raw)
        self._receive_and_bill(self.fin)
        self._sell(self.fin, 4.0)
        raw_draft = self.env["purchase.order"].create(
            {"partner_id": self.vendor.id, "order_line": [Command.create({"product_id": self.raw.id, "product_qty": 3.0, "price_unit": 50000.0})]}
        )
        raw_draft.button_confirm()
        raw_draft.order_line.product_id.purchase_method = "purchase"
        raw_draft.action_create_invoice()
        draft_line = raw_draft.invoice_ids.invoice_line_ids
        self.assertEqual(draft_line.account_id, self.env.ref("product.product_category_goods").with_company(self.company).kompakapps_stock_input_account_id)
        manual = self.env["account.move"].create(
            {
                "move_type": "entry",
                "date": fields.Date.today(),
                "journal_id": self.company_data["default_journal_misc"].id,
                "line_ids": [
                    Command.create({"account_id": self.old_account.id, "credit": 5000.0, "name": "Manual tanpa produk"}),
                    Command.create({"account_id": self.company_data["default_account_expense"].id, "debit": 5000.0, "name": "Manual tanpa produk"}),
                ],
            }
        )
        manual.action_post()
        total_before = self._balance(self.old_account)
        entries_before = self._totals()
        raw_value, fin_value = self.raw.total_value, self.fin.total_value
        self.assertEqual(total_before, raw_value + fin_value - 5000.0, "Sebelum dipisah semua nilai ada di satu akun")

        summary = self.company.kompakapps_split_inventory_accounts(self.raw_category, self.fin_category)

        raw_account = self.raw_category.property_stock_valuation_account_id
        fin_account = self.fin_category.property_stock_valuation_account_id
        self.assertEqual((raw_account.code, raw_account.name), ("11300181", "Inventory Bahan Baku"))
        self.assertEqual((fin_account.code, fin_account.name), ("11300182", "Inventory COGM"))
        self.assertEqual(raw_account.account_type, "asset_current")
        self.assertTrue(summary[self.company.id]["raw"] > 0 and summary[self.company.id]["finished"] > 0)
        self.assertEqual(self._balance(raw_account), raw_value, "Saldo Inventory Bahan Baku sama dengan nilai stok bahan baku")
        self.assertEqual(self._balance(fin_account), fin_value, "Saldo Inventory COGM sama dengan nilai stok barang jadi")
        self.assertEqual(self._balance(self.old_account), -5000.0, "Jurnal manual tanpa produk tetap di akun lama")
        self.assertEqual(self._balance(raw_account) + self._balance(fin_account) + self._balance(self.old_account), total_before)
        self.assertEqual(self._totals(), entries_before, "Debit dan kredit tiap jurnal tidak berubah")
        self.assertEqual(manual.line_ids.filtered(lambda line: line.credit).account_id, self.old_account)
        self.assertEqual(self._balance(raw_account, self.fin) + self._balance(fin_account, self.raw), 0.0, "Tidak ada produk di akun yang salah")

        # transaksi berikutnya langsung memakai akun baru
        _order, picking = self._receive_and_bill(self.raw, qty=2.0, price=100000.0)
        self.assertEqual(picking.move_ids.account_move_id.line_ids.filtered(lambda line: line.debit).account_id, raw_account)

        again = self.company.kompakapps_split_inventory_accounts(self.raw_category, self.fin_category)
        self.assertEqual(again[self.company.id], {"raw": 0, "finished": 0}, "Menjalankan ulang tidak memindahkan apa pun")

    def test_draft_entries_follow_the_new_account(self):
        self.raw.purchase_method = "purchase"
        category_account = self.raw_category.property_stock_valuation_account_id
        order = self.env["purchase.order"].create(
            {"partner_id": self.vendor.id, "order_line": [Command.create({"product_id": self.raw.id, "product_qty": 1.0, "price_unit": 1000.0})]}
        )
        order.button_confirm()
        order.action_create_invoice()
        line = order.invoice_ids.invoice_line_ids
        line.account_id = category_account  # pola lama: tagihan draf langsung ke akun persediaan
        self.company.kompakapps_split_inventory_accounts(self.raw_category, self.fin_category)
        self.assertEqual(line.account_id.code, "11300181", "Tagihan draf ikut dipindahkan")

    def test_cogm_account_holds_only_manufactured_goods(self):
        """Barang yang dibeli jadi kembali ke Inventory; Inventory COGM hanya berisi hasil produksi, termasuk MO lama yang belum punya jurnal."""
        goods = self.env.ref("product.product_category_goods").with_company(self.company)
        trade_category = self.env["product.category"].create({"name": "Barang Dagang Uji", "parent_id": goods.id, "property_cost_method": "average"})
        common = {"type": "consu", "is_storable": True, "standard_price": 0.0, "list_price": 300000.0, "taxes_id": [Command.clear()], "supplier_taxes_id": [Command.clear()]}
        trade = self._create_product(name="Barang Dagang Pisah Akun", categ_id=trade_category.id, **common)
        self._receive_and_bill(self.raw, qty=10.0, price=100000.0)
        self._receive_and_bill(trade, qty=5.0, price=200000.0)
        # MO yang selesai sebelum jurnal per transaksi aktif: akun Barang Dalam Proses pada lokasi Production dikosongkan dulu
        production_location = self.env["stock.location"].search([("company_id", "=", self.company.id), ("usage", "=", "production")], limit=1)
        wip_account = production_location.valuation_account_id
        production_location.valuation_account_id = False
        bom = self.env["mrp.bom"].create(
            {
                "product_tmpl_id": self.fin.product_tmpl_id.id,
                "product_qty": 1.0,
                "product_uom_id": self.fin.uom_id.id,
                "bom_line_ids": [Command.create({"product_id": self.raw.id, "product_qty": 2.0})],
            }
        )
        production = self.env["mrp.production"].create({"product_id": self.fin.id, "product_qty": 3.0, "bom_id": bom.id})
        production.action_confirm()
        production.qty_producing = 3.0
        for move in production.move_raw_ids:
            move.write({"quantity": move.product_uom_qty, "picked": True})
        production.button_mark_done()
        self.assertEqual(production.state, "done")
        self.assertFalse((production.move_raw_ids | production.move_finished_ids).account_move_id, "MO lama tidak dijurnal")
        self._sell(self.fin, 1.0)  # satu unit barang jadi terjual: pengiriman mengkredit akun persediaannya
        production_location.valuation_account_id = wip_account

        self.company.kompakapps_split_inventory_accounts(self.raw_category, self.fin_category, trade_category)
        trade_account = self.company.account_stock_valuation_id
        raw_account = self.raw_category.property_stock_valuation_account_id
        cogm_account = self.fin_category.property_stock_valuation_account_id
        self.assertEqual(trade_category.property_stock_valuation_account_id, trade_account, "Barang dibeli jadi memakai akun Inventory bawaan")
        self.assertEqual(self._balance(trade_account), trade.total_value, "Inventory berisi barang dagang")
        self.assertEqual(self._balance(trade_account, self.fin), 0.0, "Tidak ada barang jadi produksi di Inventory")
        self.assertEqual(self._balance(cogm_account, trade) + self._balance(cogm_account, self.raw), 0.0, "Tidak ada barang dibeli di Inventory COGM")
        self.assertEqual(self._balance(cogm_account), -200000.0, "Sebelum MO dijurnalkan, COGM hanya punya kredit penjualan")

        created = production.kompakapps_post_missing_stock_journals()
        self.assertEqual(created, 1)
        entry = (production.move_raw_ids | production.move_finished_ids).account_move_id
        self.assertEqual(len(entry), 1)
        self.assertEqual(entry.date, fields.Date.context_today(production, production.date_finished))
        lines = {}
        for line in entry.line_ids:
            debit, credit = lines.get(line.account_id, (0.0, 0.0))
            lines[line.account_id] = (debit + line.debit, credit + line.credit)
        self.assertEqual(lines, {wip_account: (600000.0, 600000.0), raw_account: (0.0, 600000.0), cogm_account: (600000.0, 0.0)})
        self.assertEqual(self._balance(cogm_account), self.fin.total_value, "Saldo Inventory COGM sama dengan nilai stok barang jadi produksi")
        self.assertEqual(self._balance(raw_account), self.raw.total_value, "Saldo Inventory Bahan Baku sama dengan nilai stok bahan baku")
        self.assertEqual(self._balance(wip_account), 0.0)
        self.assertEqual(production.kompakapps_post_missing_stock_journals(), 0, "Jalan ulang tidak membuat jurnal lagi")
