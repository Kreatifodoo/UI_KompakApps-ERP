from odoo import Command, fields
from odoo.addons.account.tests.common import AccountTestInvoicingCommon
from odoo.tests import tagged


@tagged("post_install", "-at_install", "kompakapps")
class TestStockJournals(AccountTestInvoicingCommon):
    """Jurnal pada transaksi inventori mengikuti Product Category (Q49, D69).

    Penerimaan Dr Persediaan, Cr Barang Diterima Belum Ditagih; tagihan membersihkannya. Pengiriman Dr Barang Terkirim Belum Ditagih, Cr Persediaan;
    faktur membersihkannya dengan Dr HPP. Opname, scrap, dan produksi memakai akun lokasi virtual.
    """

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
        cls.goods = cls.env.ref("product.product_category_goods").with_company(cls.company)
        cls.stock_account = cls.goods.property_stock_valuation_account_id
        cls.input_account = cls.goods.kompakapps_stock_input_account_id
        cls.output_account = cls.goods.kompakapps_stock_output_account_id
        cls.warehouse = cls.env["stock.warehouse"].search([("company_id", "=", cls.company.id)], limit=1)
        cls.stock_location = cls.warehouse.lot_stock_id
        cls.vendor = cls.env["res.partner"].create({"name": "PT Pemasok Jurnal Stok", "is_company": True, "supplier_rank": 1})
        cls.customer = cls.env["res.partner"].create({"name": "PT Pelanggan Jurnal Stok", "is_company": True, "customer_rank": 1})
        cls.product = cls._create_product(
            name="Barang Jurnal Stok", type="consu", is_storable=True, categ_id=cls.goods.id, standard_price=0.0, list_price=150000.0,
            taxes_id=[Command.clear()], supplier_taxes_id=[Command.clear()],
        )
        cls.cogs_account = cls.product._get_product_accounts()["expense"]

    # ------------------------------------------------------------------ pembantu

    def _balance(self, account):
        lines = self.env["account.move.line"].search([("account_id", "=", account.id), ("parent_state", "=", "posted"), ("company_id", "=", self.company.id)])
        return round(sum(lines.mapped("balance")), 2)

    def _lines(self, move):
        """Debit dan kredit per akun pada sebuah jurnal."""
        result = {}
        for line in move.line_ids:
            debit, credit = result.get(line.account_id, (0.0, 0.0))
            result[line.account_id] = (debit + line.debit, credit + line.credit)
        return result

    def _receive(self, qty, price, product=None):
        order = self.env["purchase.order"].create(
            {"partner_id": self.vendor.id, "order_line": [Command.create({"product_id": (product or self.product).id, "product_qty": qty, "price_unit": price})]}
        )
        order.button_confirm()
        picking = order.picking_ids
        picking.move_ids.quantity = qty
        picking.move_ids.picked = True
        picking.button_validate()
        self.assertEqual(picking.state, "done")
        return order, picking

    def _bill(self, order, price=None, post=True):
        order.action_create_invoice()
        bill = order.invoice_ids
        bill.invoice_date = fields.Date.today()
        if price is not None:
            bill.invoice_line_ids.price_unit = price
        if post:
            bill.action_post()
        return bill

    def _deliver(self, qty, product=None):
        order = self.env["sale.order"].create(
            {"partner_id": self.customer.id, "order_line": [Command.create({"product_id": (product or self.product).id, "product_uom_qty": qty})]}
        )
        order.action_confirm()
        picking = order.picking_ids
        picking.move_ids.quantity = qty
        picking.move_ids.picked = True
        picking.button_validate()
        self.assertEqual(picking.state, "done")
        return order, picking

    def _stocked(self, qty=10.0, price=100000.0):
        """Terima dan tagih qty unit dengan harga yang sama: persediaan qty x price, Barang Diterima nol."""
        order, picking = self._receive(qty, price)
        self._bill(order)
        return order, picking

    # ------------------------------------------------------------------ pembelian

    def test_receipt_is_journaled_against_goods_received_not_billed(self):
        _order, picking = self._receive(10.0, 100000.0)
        move = picking.move_ids
        entry = move.account_move_id
        self.assertEqual(entry.state, "posted")
        self.assertEqual(entry.journal_id, self.goods.property_stock_journal or self.company.account_stock_journal_id)
        self.assertEqual(self._lines(entry), {self.stock_account: (1000000.0, 0.0), self.input_account: (0.0, 1000000.0)})
        self.assertEqual(move.kompakapps_posted_value, 1000000.0)
        self.assertEqual((self._balance(self.stock_account), self._balance(self.input_account)), (1000000.0, -1000000.0))

    def test_bill_clears_goods_received_and_does_not_debit_inventory_again(self):
        order, _picking = self._receive(10.0, 100000.0)
        bill = self._bill(order)
        line = bill.invoice_line_ids
        self.assertEqual(line.account_id, self.input_account, "Baris tagihan barang stok mendebit Barang Diterima Belum Ditagih, bukan Persediaan")
        self.assertEqual(self._lines(bill)[self.input_account], (1000000.0, 0.0))
        self.assertNotIn(self.stock_account, self._lines(bill))
        self.assertEqual((self._balance(self.stock_account), self._balance(self.input_account)), (1000000.0, 0.0))
        self.assertEqual(self.product.total_value, 1000000.0, "Saldo akun persediaan sama dengan nilai persediaan")

    def test_bill_price_difference_is_trued_up_on_inventory(self):
        order, picking = self._receive(10.0, 100000.0)
        self._bill(order, price=110000.0)
        move = picking.move_ids
        self.assertEqual(move.value, 1100000.0, "Odoo menilai ulang penerimaan sesuai harga tagihan")
        self.assertEqual(move.kompakapps_posted_value, 1100000.0)
        corrections = self.env["account.move"].search([("ref", "like", "Koreksi nilai")])
        self.assertEqual(len(corrections), 1)
        self.assertEqual(self._lines(corrections), {self.stock_account: (100000.0, 0.0), self.input_account: (0.0, 100000.0)})
        self.assertEqual((self._balance(self.stock_account), self._balance(self.input_account)), (1100000.0, 0.0))
        self.assertEqual(self.product.total_value, 1100000.0)

    def test_bill_posted_before_receipt_clears_after_receipt(self):
        self.product.purchase_method = "purchase"  # tagihan atas jumlah pesanan, boleh sebelum barang diterima
        order = self.env["purchase.order"].create(
            {"partner_id": self.vendor.id, "order_line": [Command.create({"product_id": self.product.id, "product_qty": 5.0, "price_unit": 80000.0})]}
        )
        order.button_confirm()
        bill = self._bill(order)
        self.assertEqual(self._balance(self.input_account), 400000.0, "Tagihan lebih dulu: Barang Diterima berdebit sampai barangnya diterima")
        picking = order.picking_ids
        picking.move_ids.quantity = 5.0
        picking.move_ids.picked = True
        picking.button_validate()
        self.assertEqual((self._balance(self.stock_account), self._balance(self.input_account)), (400000.0, 0.0))
        self.assertEqual(bill.state, "posted")

    def test_vendor_return_and_credit_note_reverse_the_receipt(self):
        order, picking = self._stocked(10.0, 100000.0)
        wizard = (
            self.env["stock.return.picking"]
            .with_context(active_ids=picking.ids, active_id=picking.id, active_model="stock.picking")
            .create({})
        )
        wizard.product_return_moves.quantity = 4.0
        return_picking = self.env["stock.picking"].browse(wizard.action_create_returns()["res_id"])
        return_picking.move_ids.quantity = 4.0
        return_picking.move_ids.picked = True
        return_picking.button_validate()
        entry = return_picking.move_ids.account_move_id
        self.assertEqual(self._lines(entry), {self.input_account: (400000.0, 0.0), self.stock_account: (0.0, 400000.0)})
        reversal = (
            self.env["account.move.reversal"]
            .with_context(active_model="account.move", active_ids=order.invoice_ids.ids)
            .create({"journal_id": order.invoice_ids.journal_id.id, "date": fields.Date.today()})
        )
        refund = self.env["account.move"].browse(reversal.refund_moves()["res_id"])
        refund.invoice_line_ids.quantity = 4.0
        refund.action_post()
        self.assertEqual((self._balance(self.stock_account), self._balance(self.input_account)), (600000.0, 0.0))
        self.assertEqual(self.product.total_value, 600000.0)

    def test_bill_for_goods_already_billed_the_old_way_is_not_counted_twice(self):
        self.product.purchase_method = "purchase"  # tagihan atas jumlah pesanan, sebelum barang diterima
        order = self.env["purchase.order"].create(
            {"partner_id": self.vendor.id, "order_line": [Command.create({"product_id": self.product.id, "product_qty": 3.0, "price_unit": 50000.0})]}
        )
        order.button_confirm()
        bill = self._bill(order, post=False)
        bill.invoice_line_ids.account_id = self.stock_account  # tagihan pola lama: langsung mendebit Persediaan
        bill.action_post()
        picking = order.picking_ids
        picking.move_ids.quantity = 3.0
        picking.move_ids.picked = True
        picking.button_validate()
        self.assertFalse(picking.move_ids.account_move_id, "Sudah ditagih dengan pola lama: penerimaan tidak dijurnal lagi")
        self.assertEqual((self._balance(self.stock_account), self._balance(self.input_account)), (150000.0, 0.0))

    # ------------------------------------------------------------------ penjualan

    def test_delivery_is_journaled_and_invoice_clears_goods_delivered(self):
        self._stocked(10.0, 100000.0)
        order, picking = self._deliver(4.0)
        entry = picking.move_ids.account_move_id
        self.assertEqual(entry.state, "posted")
        self.assertEqual(self._lines(entry), {self.output_account: (400000.0, 0.0), self.stock_account: (0.0, 400000.0)})
        self.assertEqual((self._balance(self.stock_account), self._balance(self.output_account)), (600000.0, 400000.0))
        invoice = order._create_invoices()
        invoice.action_post()
        cogs = invoice.line_ids.filtered(lambda line: line.display_type == "cogs")
        self.assertEqual(sorted((line.account_id.id, line.debit, line.credit) for line in cogs), sorted([(self.cogs_account.id, 400000.0, 0.0), (self.output_account.id, 0.0, 400000.0)]))
        self.assertNotIn(self.stock_account, [line.account_id for line in cogs], "Faktur tidak lagi mengkredit Persediaan")
        self.assertEqual((self._balance(self.stock_account), self._balance(self.output_account)), (600000.0, 0.0))
        self.assertEqual(self.product.total_value, 600000.0)

    def test_partial_invoicing_posts_cost_of_goods_once(self):
        self._stocked(10.0, 100000.0)
        order, _picking = self._deliver(4.0)
        first = order._create_invoices()
        first.invoice_line_ids.quantity = 2.0
        first.action_post()
        self.assertEqual((self._balance(self.cogs_account), self._balance(self.output_account)), (200000.0, 200000.0))
        second = order._create_invoices()
        self.assertEqual(second.invoice_line_ids.quantity, 2.0)
        second.action_post()
        self.assertEqual((self._balance(self.cogs_account), self._balance(self.output_account)), (400000.0, 0.0), "HPP tidak dihitung dua kali pada faktur kedua")

    def test_invoice_before_delivery_then_delivery_clears_goods_delivered(self):
        self._stocked(10.0, 100000.0)
        order = self.env["sale.order"].create(
            {"partner_id": self.customer.id, "order_line": [Command.create({"product_id": self.product.id, "product_uom_qty": 2.0})]}
        )
        order.action_confirm()
        invoice = order._create_invoices()
        invoice.action_post()
        self.assertEqual(self._balance(self.output_account), -200000.0, "Faktur lebih dulu: Barang Terkirim berkredit sampai barangnya dikirim")
        picking = order.picking_ids
        picking.move_ids.quantity = 2.0
        picking.move_ids.picked = True
        picking.button_validate()
        self.assertEqual((self._balance(self.output_account), self._balance(self.stock_account)), (0.0, 800000.0))

    def test_customer_return_and_credit_note_reverse_the_delivery(self):
        self._stocked(10.0, 100000.0)
        order, picking = self._deliver(4.0)
        invoice = order._create_invoices()
        invoice.action_post()
        wizard = (
            self.env["stock.return.picking"]
            .with_context(active_ids=picking.ids, active_id=picking.id, active_model="stock.picking")
            .create({})
        )
        wizard.product_return_moves.quantity = 4.0
        return_picking = self.env["stock.picking"].browse(wizard.action_create_returns()["res_id"])
        return_picking.move_ids.quantity = 4.0
        return_picking.move_ids.picked = True
        return_picking.button_validate()
        self.assertEqual(self._lines(return_picking.move_ids.account_move_id), {self.stock_account: (400000.0, 0.0), self.output_account: (0.0, 400000.0)})
        reversal = (
            self.env["account.move.reversal"]
            .with_context(active_model="account.move", active_ids=invoice.ids)
            .create({"journal_id": invoice.journal_id.id, "date": fields.Date.today()})
        )
        refund = self.env["account.move"].browse(reversal.refund_moves()["res_id"])
        refund.action_post()
        self.assertEqual((self._balance(self.stock_account), self._balance(self.output_account), self._balance(self.cogs_account)), (1000000.0, 0.0, 0.0))
        self.assertEqual(self.product.total_value, 1000000.0)

    # ------------------------------------------------------------------ opname, scrap, produksi

    def _count(self, product, quantity):
        quant = (
            self.env["stock.quant"]
            .with_context(inventory_mode=True)
            .create({"product_id": product.id, "location_id": self.stock_location.id, "inventory_quantity": quantity})
        )
        quant.action_apply_inventory()

    def test_count_gain_and_loss_use_the_adjustment_account(self):
        self._stocked(10.0, 100000.0)
        adjustment = self.env["stock.location"].search([("company_id", "=", self.company.id), ("usage", "=", "inventory"), ("name", "!=", "Scrap")], limit=1).valuation_account_id
        self.assertTrue(adjustment, "Lokasi Inventory adjustment punya akun selisih persediaan")
        self._count(self.product, 12.0)
        self.assertEqual((self._balance(self.stock_account), self._balance(adjustment)), (1200000.0, -200000.0), "Selisih lebih: Dr Persediaan, Cr Selisih Persediaan")
        self._count(self.product, 11.0)
        self.assertEqual((self._balance(self.stock_account), self._balance(adjustment)), (1100000.0, -100000.0), "Selisih kurang: Dr Selisih Persediaan, Cr Persediaan")
        self.assertEqual(self.product.total_value, 1100000.0)

    def test_scrap_location_has_its_own_expense_account(self):
        self._stocked(10.0, 100000.0)
        scrap_location = self.env["stock.location"].search([("company_id", "=", self.company.id), ("usage", "=", "inventory"), ("name", "=", "Scrap")])
        self.assertEqual(len(scrap_location), 1)
        scrap = self.env["stock.scrap"].create(
            {"product_id": self.product.id, "scrap_qty": 2.0, "location_id": self.stock_location.id, "scrap_location_id": scrap_location.id}
        )
        scrap.action_validate()
        self.assertEqual(scrap.state, "done")
        self.assertEqual(self._lines(scrap.move_ids.account_move_id), {scrap_location.valuation_account_id: (200000.0, 0.0), self.stock_account: (0.0, 200000.0)})
        self.assertEqual(self.product.total_value, 800000.0)
        self.assertEqual(self._balance(self.stock_account), 800000.0)

    def test_manufacturing_moves_value_through_work_in_progress(self):
        self._stocked(10.0, 100000.0)
        common = {"type": "consu", "is_storable": True, "categ_id": self.goods.id}
        sugar = self._create_product(name="Gula Jurnal Stok", standard_price=5000.0, **common)
        cake = self._create_product(name="Kue Jurnal Stok", standard_price=0.0, **common)
        self._count(sugar, 20.0)
        bom = self.env["mrp.bom"].create(
            {
                "product_tmpl_id": cake.product_tmpl_id.id,
                "product_qty": 1.0,
                "product_uom_id": cake.uom_id.id,
                "bom_line_ids": [
                    Command.create({"product_id": self.product.id, "product_qty": 2.0}),
                    Command.create({"product_id": sugar.id, "product_qty": 1.0}),
                ],
            }
        )
        production = self.env["mrp.production"].create({"product_id": cake.id, "product_qty": 3.0, "bom_id": bom.id})
        production.action_confirm()
        production.qty_producing = 3.0
        for move in production.move_raw_ids:
            move.write({"quantity": move.product_uom_qty, "picked": True})
        production.button_mark_done()
        self.assertEqual(production.state, "done")
        wip = self.env["stock.location"].search([("company_id", "=", self.company.id), ("usage", "=", "production")], limit=1).valuation_account_id
        self.assertTrue(wip)
        # komponen: 6 x 100.000 + 3 x 5.000 = 615.000 pindah ke barang jadi
        consumed = production.move_raw_ids.account_move_id
        self.assertEqual(sum(consumed.line_ids.filtered(lambda line: line.account_id == wip).mapped("debit")), 615000.0)
        self.assertEqual(self._balance(wip), 0.0, "Barang Dalam Proses habis: nilai komponen seluruhnya pindah ke barang jadi")
        self.assertEqual(self.product.total_value + sugar.total_value + cake.total_value, 1100000.0)
        self.assertEqual(self._balance(self.stock_account), 1100000.0, "Persediaan di buku besar sama dengan nilai persediaan seluruh produk")

    # ------------------------------------------------------------------ cadangan

    def test_standard_cost_products_keep_the_invoicing_pattern(self):
        category = self.env["product.category"].create({"name": "Biaya Standar Jurnal", "property_valuation": "real_time", "property_cost_method": "standard"})
        product = self._create_product(
            name="Barang Biaya Standar", type="consu", is_storable=True, categ_id=category.id, standard_price=100000.0, taxes_id=[Command.clear()], supplier_taxes_id=[Command.clear()]
        )
        self.assertIsNone(product._kompakapps_stock_interim())
        order, picking = self._receive(2.0, 100000.0, product=product)
        self.assertFalse(picking.move_ids.account_move_id, "Biaya standar: penerimaan tidak dijurnal, jurnal tetap saat tagihan")
        bill = self._bill(order)
        self.assertEqual(bill.invoice_line_ids.account_id, category.property_stock_valuation_account_id)

    def test_setup_is_idempotent_and_does_not_overwrite_choices(self):
        custom = self.env["account.account"].create({"code": "21100077", "name": "Pilihan Pengguna", "account_type": "liability_current", "company_ids": [Command.set(self.company.ids)]})
        category = self.env["product.category"].create({"name": "Kategori Pilihan", "property_cost_method": "average", "kompakapps_stock_input_account_id": custom.id})
        self.company.kompakapps_setup_stock_journals()
        self.assertEqual(category.kompakapps_stock_input_account_id, custom)
        self.assertEqual(category.kompakapps_stock_output_account_id, self.output_account)
        accounts_before = self.env["account.account"].search_count([])
        locations_before = self.env["stock.location"].search_count([])
        self.company.kompakapps_setup_stock_journals()
        self.assertEqual((self.env["account.account"].search_count([]), self.env["stock.location"].search_count([])), (accounts_before, locations_before))
        new_category = self.env["product.category"].create({"name": "Kategori Baru Jurnal", "property_cost_method": "average"})
        self.assertEqual(new_category.kompakapps_stock_input_account_id, self.input_account, "Kategori baru ikut nilai bawaan perusahaan")

    def test_clearing_the_accounts_turns_the_journals_off_for_a_category(self):
        off = self.env["product.category"].create({"name": "Tanpa Jurnal Transaksi", "property_cost_method": "average", "kompakapps_stock_input_account_id": False})
        self.assertFalse(off.kompakapps_stock_input_account_id, "Nilai kosong yang disebut eksplisit tidak diisi otomatis")
        product = self._create_product(
            name="Barang Tanpa Jurnal Transaksi", type="consu", is_storable=True, categ_id=off.id, standard_price=0.0, taxes_id=[Command.clear()], supplier_taxes_id=[Command.clear()]
        )
        self.assertIsNone(product._kompakapps_stock_interim())
        order, picking = self._receive(2.0, 100000.0, product=product)
        self.assertFalse(picking.move_ids.account_move_id, "Kategori yang dimatikan tidak dijurnal saat penerimaan")
        bill = self._bill(order)
        self.assertEqual(bill.invoice_line_ids.account_id, off.property_stock_valuation_account_id, "Tagihan tetap mendebit Persediaan (pola lama)")

    def test_child_category_follows_its_parent_accounts(self):
        custom = self.env["account.account"].create({"code": "21100078", "name": "Pilihan Induk", "account_type": "liability_current", "company_ids": [Command.set(self.company.ids)]})
        parent = self.env["product.category"].create({"name": "Induk Jurnal", "property_cost_method": "average", "kompakapps_stock_input_account_id": custom.id})
        child = self.env["product.category"].create({"name": "Anak Jurnal", "parent_id": parent.id})
        self.assertEqual((child.kompakapps_stock_input_account_id, child.kompakapps_stock_output_account_id), (custom, parent.kompakapps_stock_output_account_id))
