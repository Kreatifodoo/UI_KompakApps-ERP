from odoo import Command, fields
from odoo.addons.account.tests.common import AccountTestInvoicingCommon
from odoo.exceptions import AccessError
from odoo.tests import tagged

SALESMAN = "sales_team.group_sale_salesman"  # Odoo: "User: Own Documents Only"
SALES_ALL = "sales_team.group_sale_salesman_all_leads"  # Odoo: "User: All Documents"
SALES_MANAGER = "sales_team.group_sale_manager"


def make_scope_user(env, login, xmlids):
    """Pengguna internal dengan grup tertentu (di luar pengguna internal) untuk menguji cakupan data."""
    groups = [env.ref("base.group_user").id] + [env.ref(x).id for x in xmlids]
    return env["res.users"].create(
        {"name": login, "login": login, "group_ids": [Command.set(groups)], "company_ids": [Command.set(env.company.ids)], "company_id": env.company.id}
    )


@tagged("post_install", "-at_install", "kompakapps")
class TestAccessScopeSales(AccountTestInvoicingCommon):
    """Cakupan data Sales dan CRM (D87, Q9 irisan 1): penjual "sendiri" hanya melihat dan mengubah dokumennya, "semua" dan manajer melihat semua."""

    @classmethod
    @AccountTestInvoicingCommon.setup_country("id")
    def setUpClass(cls):
        super().setUpClass()
        cls.env.user.write({"group_ids": [Command.link(cls.env.ref(SALES_MANAGER).id)]})  # pembuat data uji
        cls.user_a = cls._scope_user("scope_sales_a", [SALESMAN])
        cls.user_b = cls._scope_user("scope_sales_b", [SALESMAN])
        cls.user_all = cls._scope_user("scope_sales_all", [SALES_ALL])
        cls.user_mgr = cls._scope_user("scope_sales_mgr", [SALES_MANAGER])
        cls.user_acct = cls._scope_user("scope_acct", ["account.group_account_invoice"])
        cls.user_plain = cls._scope_user("scope_plain", [])
        cls.service = cls._create_product(name="Jasa Cakupan Data", type="service", list_price=1_000_000.0)
        cls.so_a = cls._order(cls.user_a)
        cls.so_b = cls._order(cls.user_b)
        cls.so_none = cls._order(None)
        (cls.so_a | cls.so_b).action_confirm()
        cls.orders = cls.so_a | cls.so_b | cls.so_none
        cls.inv_a = cls._invoice(cls.user_a)
        cls.inv_b = cls._invoice(cls.user_b)
        cls.invoices = cls.inv_a | cls.inv_b
        cls.bill = cls.env["account.move"].create(
            {
                "move_type": "in_invoice",
                "partner_id": cls.partner_b.id,
                "invoice_date": fields.Date.today(),
                "invoice_line_ids": [Command.create({"name": "Biaya", "quantity": 1, "price_unit": 500_000.0})],
            }
        )
        cls.lead_a = cls._lead("Peluang A", cls.user_a)
        cls.lead_b = cls._lead("Peluang B", cls.user_b)
        cls.lead_none = cls._lead("Peluang tanpa penjual", None)
        cls.leads = cls.lead_a | cls.lead_b | cls.lead_none

    @classmethod
    def _scope_user(cls, login, xmlids):
        return make_scope_user(cls.env, login, xmlids)

    @classmethod
    def _order(cls, user):
        return cls.env["sale.order"].create(
            {
                "partner_id": cls.partner_a.id,
                "user_id": user.id if user else False,
                "order_line": [Command.create({"product_id": cls.service.id, "product_uom_qty": 1})],
            }
        )

    @classmethod
    def _invoice(cls, user):
        return cls.env["account.move"].create(
            {
                "move_type": "out_invoice",
                "partner_id": cls.partner_a.id,
                "invoice_user_id": user.id,
                "invoice_date": fields.Date.today(),
                "invoice_line_ids": [Command.create({"name": "Jasa", "quantity": 1, "price_unit": 1_000_000.0})],
            }
        )

    @classmethod
    def _lead(cls, name, user):
        return cls.env["crm.lead"].create({"name": name, "type": "opportunity", "expected_revenue": 10_000_000.0, "user_id": user.id if user else False})

    def _as(self, user, model):
        return self.env[model].with_user(user)

    def _visible(self, user, records):
        return self._as(user, records._name).search([("id", "in", records.ids)])

    # ---------- Sales Order ----------
    def test_own_scope_lists_counts_and_groups_only_own_and_unassigned_orders(self):
        orders = self._as(self.user_a, "sale.order")
        domain = [("id", "in", self.orders.ids)]
        self.assertEqual(orders.search(domain), self.so_a | self.so_none, "Penjual sendiri melihat miliknya dan yang belum punya penanggung jawab")
        self.assertEqual(orders.search_count(domain), 2, "Hitungan (smart button, dashboard) ikut aturan")
        groups = orders.formatted_read_group(domain, ["user_id"], ["__count"])
        self.assertEqual(sum(g["__count"] for g in groups), 2, "Pengelompokan tidak menghitung dokumen orang lain")
        self.assertNotIn(self.user_b.id, [g["user_id"][0] for g in groups if g["user_id"]], "Kelompok penjual lain tidak muncul")
        self.assertEqual(self._visible(self.user_b, self.orders), self.so_b | self.so_none)

    def test_own_scope_cannot_read_write_delete_or_confirm_other_users_order(self):
        other = self.so_b.with_user(self.user_a)
        with self.assertRaises(AccessError):
            other.read(["name"])
        with self.assertRaises(AccessError):
            other.write({"client_order_ref": "diubah orang lain"})
        with self.assertRaises(AccessError):
            other.action_cancel()
        with self.assertRaises(AccessError):
            other.unlink()
        self.assertFalse(self.so_b.client_order_ref, "Referensi tidak berubah")
        with self.assertRaises(AccessError):
            self.env["sale.order.line"].with_user(self.user_a).browse(self.so_b.order_line.ids).read(["name"])

    def test_unassigned_order_is_visible_and_editable_by_every_own_scope_user(self):
        self.so_none.with_user(self.user_a).write({"client_order_ref": "dikerjakan A"})
        self.assertEqual(self.so_none.client_order_ref, "dikerjakan A")
        self.assertIn(self.so_none, self._visible(self.user_b, self.orders))

    def test_all_documents_scope_and_manager_see_every_order_and_can_edit(self):
        for user in (self.user_all, self.user_mgr):
            self.assertEqual(self._visible(user, self.orders), self.orders, user.login)
            self.assertEqual(self._as(user, "sale.order").search_count([("id", "in", self.orders.ids)]), 3)
            self.so_b.with_user(user).write({"client_order_ref": f"oleh {user.login}"})
        self.assertEqual(self.so_b.client_order_ref, f"oleh {self.user_mgr.login}")

    def test_new_user_without_documents_sees_empty_lists_without_error_and_can_create_own_quotation(self):
        fresh = self._scope_user("scope_sales_fresh", [SALESMAN])
        orders = self._as(fresh, "sale.order")
        self.assertFalse(orders.search([("id", "in", self.so_b.ids)]), "Dokumen orang lain tidak tampil")
        self.assertEqual(orders.search_count([("id", "in", self.so_b.ids)]), 0)
        self.assertEqual(orders.formatted_read_group([("id", "in", self.so_b.ids)], ["user_id"], ["__count"]), [])
        self.assertFalse(self._as(fresh, "crm.lead").search([("id", "in", self.lead_b.ids)]))
        own = orders.create({"partner_id": self.partner_a.id, "order_line": [Command.create({"product_id": self.service.id, "product_uom_qty": 1})]})
        self.assertEqual(own.user_id, fresh, "Quotation baru otomatis milik pembuatnya")
        self.assertIn(own, orders.search([("id", "=", own.id)]))

    def test_sales_analysis_follows_the_same_scope(self):
        domain = [("name", "in", [self.so_a.name, self.so_b.name])]
        report = self._as(self.user_a, "sale.report")
        rows = report.formatted_read_group(domain, ["user_id"], ["__count"])
        self.assertEqual({g["user_id"][0] for g in rows if g["user_id"]}, {self.user_a.id}, "Analisis penjualan hanya memuat milik penjual itu")
        all_rows = self._as(self.user_all, "sale.report").formatted_read_group(domain, ["user_id"], ["__count"])
        self.assertEqual({g["user_id"][0] for g in all_rows if g["user_id"]}, {self.user_a.id, self.user_b.id})

    # ---------- Faktur penjualan ----------
    def test_customer_invoices_follow_scope_and_vendor_bills_stay_hidden_from_sales(self):
        everything = self.invoices | self.bill
        self.assertEqual(self._visible(self.user_a, everything), self.inv_a, "Penjual sendiri melihat fakturnya, bukan faktur penjual lain dan bukan tagihan vendor")
        self.assertEqual(self._as(self.user_a, "account.move").search_count([("id", "in", everything.ids)]), 1)
        with self.assertRaises(AccessError):
            self.inv_b.with_user(self.user_a).read(["name"])
        with self.assertRaises(AccessError):
            self.inv_b.with_user(self.user_a).write({"ref": "diubah"})
        with self.assertRaises(AccessError):
            self.bill.with_user(self.user_a).read(["name"])
        self.assertEqual(self._visible(self.user_all, everything), self.invoices, "Semua dokumen: semua faktur penjualan, tetap bukan tagihan vendor")
        line = self.env["account.move.line"].with_user(self.user_a)
        self.assertFalse(line.search([("move_id", "=", self.inv_b.id)]), "Baris faktur penjual lain juga tersembunyi")

    def test_accounting_invoicing_role_sees_all_customer_invoices_regardless_of_sales_scope(self):
        self.assertEqual(self._visible(self.user_acct, self.invoices | self.bill), self.invoices | self.bill)
        both = self._scope_user("scope_sales_and_acct", [SALESMAN, "account.group_account_invoice"])
        self.assertEqual(self._visible(both, self.invoices), self.invoices, "Aturan grup digabung (OR): peran Penagihan melonggarkan cakupan Sales")

    def test_inventory_user_without_sales_group_sees_all_orders_but_salesperson_with_inventory_stays_limited(self):
        stock_user = self._scope_user("scope_stock_only", ["stock.group_stock_user"])
        self.assertEqual(self._visible(stock_user, self.orders), self.orders, "Tanpa grup Sales tidak ada aturan grup: semua pesanan (perilaku bawaan, didokumentasikan)")
        both = self._scope_user("scope_sales_and_stock", [SALESMAN, "stock.group_stock_user"])
        self.assertEqual(self._visible(both, self.orders), self.so_none, "Salesperson 'sendiri' tetap dibatasi walau punya peran Inventory")

    # ---------- CRM ----------
    def test_leads_follow_scope(self):
        leads = self._as(self.user_a, "crm.lead")
        domain = [("id", "in", self.leads.ids)]
        self.assertEqual(leads.search(domain), self.lead_a | self.lead_none)
        rows = leads.formatted_read_group(domain, ["stage_id"], ["__count", "expected_revenue:sum"])
        self.assertEqual(sum(g["__count"] for g in rows), 2)
        self.assertEqual(sum(g["expected_revenue:sum"] for g in rows), 20_000_000.0)
        with self.assertRaises(AccessError):
            self.lead_b.with_user(self.user_a).write({"name": "dicuri"})
        with self.assertRaises(AccessError):
            self.lead_b.with_user(self.user_a).read(["name"])
        for user in (self.user_all, self.user_mgr):
            self.assertEqual(self._visible(user, self.leads), self.leads)

    # ---------- Pelanggan dan pengguna tanpa peran ----------
    def test_customers_are_shared_master_data_and_users_without_sales_role_have_no_sales_access(self):
        partner = self._as(self.user_b, "res.partner").search([("id", "=", self.partner_a.id)])
        self.assertEqual(partner, self.partner_a, "Pelanggan (res.partner) tidak dibatasi per penjual: master bersama lintas modul")
        for model in ("sale.order", "crm.lead"):
            with self.assertRaises(AccessError, msg=model):
                self._as(self.user_plain, model).search_count([])

    # ---------- Perintah grup yang dipakai Users & Access ----------
    def _apply_sales_role(self, user, role, scope):
        """Meniru afterSave di ui/live/pages/users.js: tingkat lebih tinggi dicabut, tingkat dipilih ditambahkan, cakupan Semua = grup 'semua dokumen'."""
        levels = [self.env.ref(SALESMAN).id, self.env.ref(SALES_MANAGER).id]
        desired = {"": -1, "user": 0, "manager": 1}[role]
        commands = []
        for index, gid in enumerate(levels):
            if index == desired:
                commands.append(Command.link(gid))
            elif index > desired:
                commands.append(Command.unlink(gid))
        all_gid = self.env.ref(SALES_ALL).id
        commands.append(Command.link(all_gid) if role == "user" and scope == "all" else Command.unlink(all_gid))
        user.write({"group_ids": commands})

    def test_users_and_access_commands_switch_between_own_all_manager_and_none(self):
        user = self._scope_user("scope_switch", [])
        self._apply_sales_role(user, "user", "own")
        self.assertEqual(self._visible(user, self.orders), self.so_none, "Salesperson + Sendiri")
        self._apply_sales_role(user, "user", "all")
        self.assertEqual(self._visible(user, self.orders), self.orders, "Salesperson + Semua")
        self._apply_sales_role(user, "manager", "all")
        self.assertEqual(self._visible(user, self.orders), self.orders, "Manajer melihat semua")
        self._apply_sales_role(user, "user", "own")
        self.assertEqual(self._visible(user, self.orders), self.so_none, "Turun ke Salesperson + Sendiri mencabut hak lihat semua (tidak ada sisa dari Manajer)")
        self.assertNotIn(self.env.ref(SALES_ALL), user.all_group_ids)
        self._apply_sales_role(user, "", "own")
        with self.assertRaises(AccessError):
            self._as(user, "sale.order").search_count([])


PURCHASE_USER = "purchase.group_purchase_user"
PURCHASE_MANAGER = "purchase.group_purchase_manager"
PURCHASE_OWN = "kompakapps_base.group_purchase_own"
STOCK_USER = "stock.group_stock_user"


@tagged("post_install", "-at_install", "kompakapps")
class TestAccessScopePurchase(AccountTestInvoicingCommon):
    """Cakupan data Purchase dan Purchase Request (D87, Q9 irisan 2): pembeli "sendiri" hanya melihat PO, penerimaan, dan tagihan dari PO miliknya."""

    @classmethod
    @AccountTestInvoicingCommon.setup_country("id")
    def setUpClass(cls):
        super().setUpClass()
        cls.env.user.write(
            {"group_ids": [Command.link(cls.env.ref(x).id) for x in (PURCHASE_MANAGER, "purchase_request.group_purchase_request_manager", "stock.group_stock_manager")]}
        )
        # Pembeli yang juga menerima barang butuh peran Inventory (bawaan Odoo: validasi penerimaan membaca referensi stok yang menyentuh Sales Order)
        cls.buyer_a = cls._scope_user("scope_buyer_a", [PURCHASE_USER, STOCK_USER, PURCHASE_OWN])
        cls.buyer_b = cls._scope_user("scope_buyer_b", [PURCHASE_USER, STOCK_USER, PURCHASE_OWN])
        cls.buyer_all = cls._scope_user("scope_buyer_all", [PURCHASE_USER, STOCK_USER])
        cls.manager = cls._scope_user("scope_buyer_mgr", [PURCHASE_MANAGER, PURCHASE_OWN])  # keliru diberi grup penanda: tetap melihat semua
        cls.sysadmin = cls._scope_user("scope_buyer_admin", ["base.group_system", PURCHASE_USER, PURCHASE_OWN])
        cls.accountant = cls._scope_user("scope_buyer_acct", ["account.group_account_invoice"])
        cls.plain = cls._scope_user("scope_buyer_plain", [])
        cls.vendor = cls.env["res.partner"].create({"name": "PT Pemasok Cakupan", "is_company": True})
        cls.material = cls._create_product(
            name="Bahan Cakupan Data", type="consu", is_storable=True, standard_price=100000.0, supplier_taxes_id=cls.company_data["default_tax_purchase"]
        )
        cls.po_a = cls._order(cls.buyer_a)
        cls.po_b = cls._order(cls.buyer_b)
        cls.po_none = cls._order(None)
        (cls.po_a | cls.po_b).button_confirm()
        cls.orders = cls.po_a | cls.po_b | cls.po_none

    @classmethod
    def _scope_user(cls, login, xmlids):
        return make_scope_user(cls.env, login, xmlids)

    @classmethod
    def _order(cls, user):
        return cls.env["purchase.order"].create(
            {
                "partner_id": cls.vendor.id,
                "user_id": user.id if user else False,
                "order_line": [Command.create({"product_id": cls.material.id, "product_qty": 10.0, "price_unit": 100000.0})],
            }
        )

    def _visible(self, user, records):
        return records.with_user(user).search([("id", "in", records.ids)])

    # ---------- Purchase Order ----------
    def test_own_buyer_sees_only_own_orders_lines_counts_groups_and_analysis(self):
        orders = self.env["purchase.order"].with_user(self.buyer_a)
        domain = [("id", "in", self.orders.ids)]
        self.assertEqual(orders.search(domain), self.po_a, "Pembeli sendiri hanya melihat PO miliknya (PO tanpa pembeli tersembunyi)")
        self.assertEqual(orders.search_count(domain), 1)
        groups = orders.formatted_read_group(domain, ["user_id"], ["__count"])
        self.assertEqual(sum(g["__count"] for g in groups), 1)
        lines = self.env["purchase.order.line"].with_user(self.buyer_a)
        self.assertEqual(lines.search([("order_id", "in", self.orders.ids)]).order_id, self.po_a, "Baris PO ikut terbatas")
        report = self.env["purchase.report"].with_user(self.buyer_a)
        rows = report.formatted_read_group([("order_id", "in", self.orders.ids)], ["user_id"], ["__count"])
        self.assertEqual({g["user_id"][0] for g in rows if g["user_id"]}, {self.buyer_a.id}, "Analisis pembelian ikut terbatas")
        self.assertEqual(self._visible(self.buyer_b, self.orders), self.po_b)

    def test_own_buyer_cannot_read_write_cancel_or_delete_other_buyers_order(self):
        other = self.po_b.with_user(self.buyer_a)
        with self.assertRaises(AccessError):
            other.read(["name"])
        with self.assertRaises(AccessError):
            other.write({"partner_ref": "diubah"})
        with self.assertRaises(AccessError):
            other.button_cancel()
        with self.assertRaises(AccessError):
            other.unlink()
        self.assertFalse(self.po_b.partner_ref)

    def test_users_without_own_group_managers_and_administrators_see_every_order(self):
        for user in (self.buyer_all, self.manager, self.sysadmin):
            self.assertEqual(self._visible(user, self.orders), self.orders, user.login)
            self.assertEqual(len(self.env["purchase.order.line"].with_user(user).search([("order_id", "in", self.orders.ids)]).order_id), 3)
        self.po_b.with_user(self.manager).write({"partner_ref": "oleh manajer"})
        self.assertEqual(self.po_b.partner_ref, "oleh manajer")

    def test_user_without_purchase_role_has_no_purchase_access(self):
        with self.assertRaises(AccessError):
            self.env["purchase.order"].with_user(self.plain).search_count([])

    # ---------- Purchase Request ----------
    def test_purchase_requests_follow_own_scope_for_users_without_a_request_role(self):
        warehouse = self.env["stock.warehouse"].search([("company_id", "=", self.env.company.id)], limit=1)

        def make(user):
            return self.env["purchase.request"].create(
                {
                    "picking_type_id": warehouse.in_type_id.id,
                    "requested_by": user.id,
                    "line_ids": [Command.create({"product_id": self.material.id, "product_uom_id": self.material.uom_id.id, "product_qty": 5.0})],
                }
            )

        pr_a, pr_b = make(self.buyer_a), make(self.buyer_b)
        both = pr_a | pr_b
        self.assertEqual(self._visible(self.buyer_a, both), pr_a, "Pembeli sendiri melihat PR yang ia ajukan")
        self.assertEqual(self.env["purchase.request.line"].with_user(self.buyer_a).search([("request_id", "in", both.ids)]).request_id, pr_a)
        self.assertEqual(self._visible(self.buyer_all, both), both, "Pembeli tanpa grup penanda dan tanpa peran PR melihat semua PR (bawaan Odoo)")
        self.assertEqual(self._visible(self.env.user, both), both, "Manajer PR melihat semua")
        with self.assertRaises(AccessError):
            pr_b.with_user(self.buyer_a).write({"description": "diubah"})

    # ---------- Dokumen turunan ----------
    def test_receipts_moves_and_bills_follow_the_order_owner_and_the_buyer_can_run_the_flow(self):
        receipt_a, receipt_b = self.po_a.picking_ids, self.po_b.picking_ids
        self.assertTrue(receipt_a and receipt_b)
        pickings = receipt_a | receipt_b
        self.assertEqual(self._visible(self.buyer_a, pickings), receipt_a, "Penerimaan dari PO pembeli lain tersembunyi")
        self.assertEqual(self._visible(self.buyer_all, pickings), pickings)
        self.assertEqual(self._visible(self.manager, pickings), pickings)
        with self.assertRaises(AccessError):
            receipt_b.with_user(self.buyer_a).read(["name"])
        moves = pickings.move_ids
        self.assertEqual(self._visible(self.buyer_a, moves).picking_id, receipt_a)
        move_lines = pickings.move_ids.move_line_ids
        self.assertEqual(self._visible(self.buyer_a, move_lines).move_id.picking_id, receipt_a)
        warehouse = self.env["stock.warehouse"].search([("company_id", "=", self.env.company.id)], limit=1)
        internal = self.env["stock.picking"].create({"picking_type_id": warehouse.int_type_id.id})
        self.assertEqual(self._visible(self.buyer_a, internal), internal, "Transfer tanpa PO tetap terlihat")

        # pembeli sendiri menerima barang dan membuat tagihan dari PO miliknya
        for receipt in (receipt_a, receipt_b):
            receipt.move_ids.quantity = 10.0
            receipt.move_ids.picked = True
        receipt_a.with_user(self.buyer_a).button_validate()
        self.assertEqual(receipt_a.state, "done")
        self.po_a.with_user(self.buyer_a).action_create_invoice()
        bill_a = self.po_a.invoice_ids
        self.assertEqual(len(bill_a), 1)
        receipt_b.with_user(self.buyer_b).button_validate()
        self.po_b.with_user(self.buyer_b).action_create_invoice()
        bill_b = self.po_b.invoice_ids
        bills = bill_a | bill_b
        self.assertEqual(self._visible(self.buyer_a, bills), bill_a, "Tagihan dari PO milik pembeli lain tersembunyi")
        self.assertEqual(self._visible(self.buyer_b, bills), bill_b)
        for user in (self.buyer_all, self.manager, self.accountant, self.sysadmin):
            self.assertEqual(self._visible(user, bills), bills, user.login)
        with self.assertRaises(AccessError):
            bill_b.with_user(self.buyer_a).read(["name"])
        with self.assertRaises(AccessError):
            bill_b.with_user(self.buyer_a).write({"ref": "diubah"})
        journal_items = self.env["account.move.line"].with_user(self.buyer_a).search([("move_id", "in", bills.ids)]).move_id
        self.assertEqual(journal_items, bill_a, "Item jurnal tagihan pembeli lain tersembunyi")
        bill_a.invoice_date = fields.Date.today()
        bill_a.with_user(self.accountant).action_post()  # memposting adalah hak Accounting Penagihan (bawaan Odoo), bukan pembeli
        self.assertEqual(bill_a.state, "posted")
        self.assertEqual(self._visible(self.buyer_a, bills), bill_a, "Tagihan terposting tetap terlihat oleh pembeli pemilik PO")

    def test_manual_vendor_bill_is_visible_to_its_creator_only_among_own_scope_buyers(self):
        vals = {
            "move_type": "in_invoice",
            "partner_id": self.vendor.id,
            "invoice_date": fields.Date.today(),
            "invoice_line_ids": [Command.create({"name": "Biaya lain", "quantity": 1, "price_unit": 250_000.0})],
        }
        bill = self.env["account.move"].with_user(self.buyer_a).create(vals)
        self.assertEqual(self._visible(self.buyer_a, bill), bill)
        self.assertFalse(self._visible(self.buyer_b, bill), "Tagihan manual buatan pembeli lain tersembunyi")
        self.assertEqual(self._visible(self.buyer_all, bill), bill)

    # ---------- Perintah grup yang dipakai Users & Access ----------
    def test_users_and_access_commands_switch_purchase_scope(self):
        own, user_group, manager_group = (self.env.ref(x).id for x in (PURCHASE_OWN, PURCHASE_USER, PURCHASE_MANAGER))
        user = self._scope_user("scope_purchase_switch", [])

        def apply(role, scope, admin=False):
            """Meniru afterSave di ui/live/pages/users.js untuk Purchase (grup penanda berarti Sendiri)."""
            desired = {"": -1, "user": 0, "manager": 1}[role]
            commands = []
            for index, gid in enumerate((user_group, manager_group)):
                if index == desired:
                    commands.append(Command.link(gid))
                elif index > desired:
                    commands.append(Command.unlink(gid))
            effective = "all" if admin or role != "user" else scope
            commands.append(Command.link(own) if role == "user" and effective == "own" else Command.unlink(own))
            user.write({"group_ids": commands})

        apply("user", "own")
        self.assertFalse(self._visible(user, self.orders), "Pembeli sendiri tanpa PO miliknya tidak melihat PO orang lain")
        apply("user", "all")
        self.assertEqual(self._visible(user, self.orders), self.orders)
        apply("user", "own")
        apply("manager", "own")
        self.assertNotIn(self.env.ref(PURCHASE_OWN), user.all_group_ids, "Manajer: grup penanda dicabut")
        self.assertEqual(self._visible(user, self.orders), self.orders)
        apply("user", "own", admin=True)
        self.assertNotIn(self.env.ref(PURCHASE_OWN), user.all_group_ids, "Administrator otomatis Semua")
