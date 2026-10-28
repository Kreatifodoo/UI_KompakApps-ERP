from datetime import timedelta

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


STOCK_MANAGER = "stock.group_stock_manager"


@tagged("post_install", "-at_install", "kompakapps")
class TestAccessScopeInventory(AccountTestInvoicingCommon):
    """Cakupan data Inventory per gudang (D87, Q9 irisan 3): pengguna dengan gudang terpilih hanya melihat dan memproses dokumen gudangnya."""

    @classmethod
    @AccountTestInvoicingCommon.setup_country("id")
    def setUpClass(cls):
        super().setUpClass()
        cls.env.user.write({"group_ids": [Command.link(cls.env.ref(x).id) for x in (STOCK_MANAGER, PURCHASE_MANAGER)]})
        cls.wh_a = cls.env["stock.warehouse"].search([("company_id", "=", cls.env.company.id)], limit=1)
        cls.wh_b = cls.env["stock.warehouse"].create({"name": "Gudang Cakupan B", "code": "GCB", "company_id": cls.env.company.id})
        cls.vendor_loc = cls.env.ref("stock.stock_location_suppliers")
        cls.customer_loc = cls.env.ref("stock.stock_location_customers")
        cls.user_a = cls._scope_user("scope_wh_a", [STOCK_USER], cls.wh_a)
        cls.user_b = cls._scope_user("scope_wh_b", [STOCK_USER], cls.wh_b)
        cls.user_ab = cls._scope_user("scope_wh_ab", [STOCK_USER], cls.wh_a | cls.wh_b)
        cls.user_all = cls._scope_user("scope_wh_all", [STOCK_USER], cls.env["stock.warehouse"])  # tanpa gudang terpilih = semua
        cls.manager = cls._scope_user("scope_wh_mgr", [STOCK_MANAGER], cls.wh_a)  # kepala gudang A: Manajer Inventory dengan gudang terpilih tetap dibatasi
        cls.manager_all = cls._scope_user("scope_wh_mgr_all", [STOCK_MANAGER], cls.env["stock.warehouse"])
        cls.sysadmin = cls._scope_user("scope_wh_admin", ["base.group_system", STOCK_USER], cls.wh_a)  # Administrator selalu melihat semua
        cls.plain = cls._scope_user("scope_wh_plain", [], cls.env["stock.warehouse"])
        cls.product = cls._create_product(name="Barang Per Gudang", type="consu", is_storable=True, standard_price=100000.0)
        cls._count(cls.wh_a.lot_stock_id, 10.0)
        cls._count(cls.wh_b.lot_stock_id, 6.0)
        cls.receipt_a = cls._picking(cls.wh_a.in_type_id, cls.vendor_loc, cls.wh_a.lot_stock_id, 5.0)
        cls.receipt_b = cls._picking(cls.wh_b.in_type_id, cls.vendor_loc, cls.wh_b.lot_stock_id, 5.0)
        cls.delivery_a = cls._picking(cls.wh_a.out_type_id, cls.wh_a.lot_stock_id, cls.customer_loc, 3.0)
        cls.delivery_b = cls._picking(cls.wh_b.out_type_id, cls.wh_b.lot_stock_id, cls.customer_loc, 2.0)
        # transfer manual dari gudang A ke gudang B: terkait kedua gudang
        cls.cross = cls._picking(cls.wh_a.int_type_id, cls.wh_a.lot_stock_id, cls.wh_b.lot_stock_id, 1.0)
        # transfer yang sama sekali tidak menyentuh gudang (mis. dropship): terlihat semua
        no_wh_type = cls.env["stock.picking.type"].create(
            {
                "name": "Dropship Uji",
                "code": "incoming",
                "sequence_code": "DSU",
                "warehouse_id": False,
                "company_id": cls.env.company.id,
                "default_location_src_id": cls.vendor_loc.id,
                "default_location_dest_id": cls.customer_loc.id,
            }
        )
        cls.no_wh = cls._picking(no_wh_type, cls.vendor_loc, cls.customer_loc, 1.0)
        cls.pickings = cls.receipt_a | cls.receipt_b | cls.delivery_a | cls.delivery_b | cls.cross | cls.no_wh

    @classmethod
    def _scope_user(cls, login, xmlids, warehouses):
        user = make_scope_user(cls.env, login, xmlids)
        if warehouses:
            user.write({"kompakapps_warehouse_ids": [Command.set(warehouses.ids)]})
        return user

    @classmethod
    def _count(cls, location, quantity):
        quant = cls.env["stock.quant"].with_context(inventory_mode=True).create({"product_id": cls.product.id, "location_id": location.id, "inventory_quantity": quantity})
        quant.action_apply_inventory()

    @classmethod
    def _picking(cls, picking_type, source, dest, quantity):
        picking = cls.env["stock.picking"].create(
            {
                "picking_type_id": picking_type.id,
                "location_id": source.id,
                "location_dest_id": dest.id,
                "move_ids": [
                    Command.create({"product_id": cls.product.id, "product_uom_qty": quantity, "location_id": source.id, "location_dest_id": dest.id})
                ],
            }
        )
        picking.action_confirm()
        picking.move_ids.quantity = quantity  # membuat detail gerakan (move line)
        return picking

    def _visible(self, user, records):
        return records.with_user(user).search([("id", "in", records.ids)])

    def _on_hand(self, user):
        self.env.invalidate_all()  # cache field hitung tidak dipisah per pengguna dalam satu transaksi uji
        return self.product.with_user(user).qty_available

    # ---------- Transfer, gerakan, detail gerakan ----------
    def test_restricted_user_sees_only_pickings_moves_and_lines_related_to_the_allowed_warehouse(self):
        # A: penerimaan/pengiriman A, transfer A ke B (kedua gudang), dan transfer tanpa gudang
        self.assertEqual(self._visible(self.user_a, self.pickings), self.receipt_a | self.delivery_a | self.cross | self.no_wh)
        self.assertEqual(self._visible(self.user_b, self.pickings), self.receipt_b | self.delivery_b | self.cross | self.no_wh)
        self.assertEqual(self._visible(self.user_ab, self.pickings), self.pickings)
        pickings = self.env["stock.picking"].with_user(self.user_a)
        domain = [("id", "in", self.pickings.ids)]
        self.assertEqual(pickings.search_count(domain), 4)
        groups = pickings.formatted_read_group(domain, ["picking_type_id"], ["__count"])
        self.assertEqual(sum(g["__count"] for g in groups), 4)
        moves = self.pickings.move_ids
        self.assertEqual(self._visible(self.user_a, moves).picking_id, self.receipt_a | self.delivery_a | self.cross | self.no_wh)
        self.assertEqual(self._visible(self.user_b, moves).picking_id, self.receipt_b | self.delivery_b | self.cross | self.no_wh)
        lines = moves.move_line_ids
        self.assertTrue(lines)
        self.assertEqual(self._visible(self.user_a, lines).move_id.picking_id, self.receipt_a | self.delivery_a | self.cross | self.no_wh)
        self.assertEqual(self._visible(self.user_b, lines).move_id.picking_id, self.receipt_b | self.delivery_b | self.cross | self.no_wh)

    def test_restricted_user_cannot_read_write_or_delete_other_warehouse_documents(self):
        other = self.receipt_b.with_user(self.user_a)
        with self.assertRaises(AccessError):
            other.read(["name"])
        with self.assertRaises(AccessError):
            other.write({"origin": "diubah"})
        with self.assertRaises(AccessError):
            other.action_cancel()
        with self.assertRaises(AccessError):
            self.delivery_b.move_ids.with_user(self.user_a).write({"description_picking": "diubah"})
        with self.assertRaises(AccessError):
            self.delivery_b.move_ids.move_line_ids.with_user(self.user_a).read(["quantity"])
        self.assertFalse(self.receipt_b.origin)
        own = self.receipt_a.with_user(self.user_a)
        own.write({"origin": "oleh pengguna gudang A"})
        self.assertEqual(self.receipt_a.origin, "oleh pengguna gudang A")

    def test_restricted_user_cannot_create_documents_in_another_warehouse(self):
        vals = {"picking_type_id": self.wh_b.in_type_id.id, "location_id": self.vendor_loc.id, "location_dest_id": self.wh_b.lot_stock_id.id}
        with self.assertRaises(AccessError):
            self.env["stock.picking"].with_user(self.user_a).create(vals)
        created = self.env["stock.picking"].with_user(self.user_b).create(vals)
        self.assertEqual(created.picking_type_id, self.wh_b.in_type_id)
        types = self.env["stock.picking.type"].with_user(self.user_a).search([("id", "in", (self.wh_a | self.wh_b).mapped("in_type_id").ids)])
        self.assertEqual(types, self.wh_a.in_type_id, "Tipe operasi gudang lain tidak tampil sehingga tidak bisa dipilih")

    def test_other_warehouses_and_their_locations_are_hidden_from_pickers(self):
        both_wh, both_loc = self.wh_a | self.wh_b, self.wh_a.lot_stock_id | self.wh_b.lot_stock_id
        self.assertEqual(self.env["stock.warehouse"].with_user(self.user_a).search([("id", "in", both_wh.ids)]), self.wh_a)
        self.assertEqual(self.env["stock.location"].with_user(self.user_a).search([("id", "in", both_loc.ids)]), self.wh_a.lot_stock_id)
        self.assertEqual(self.env["stock.warehouse"].with_user(self.user_ab).search([("id", "in", both_wh.ids)]), both_wh)
        for user in (self.user_all, self.sysadmin):
            self.assertEqual(self.env["stock.warehouse"].with_user(user).search([("id", "in", both_wh.ids)]), both_wh, user.login)
            self.assertEqual(self.env["stock.location"].with_user(user).search([("id", "in", both_loc.ids)]), both_loc, user.login)
        # lokasi tujuan di gudang lain tidak tampil, tetapi transfer antar gudang yang terlihat tetap bisa dibaca
        row = self.cross.with_user(self.user_a).read(["location_dest_id", "picking_type_id"])[0]
        self.assertEqual(row["location_dest_id"][0], self.wh_b.lot_stock_id.id)

    def test_restricted_user_runs_receipt_and_delivery_in_the_allowed_warehouse(self):
        self.receipt_a.move_ids.picked = True
        self.receipt_a.with_user(self.user_a).button_validate()
        self.assertEqual(self.receipt_a.state, "done")
        self.delivery_a.move_ids.picked = True
        self.delivery_a.with_user(self.user_a).button_validate()
        self.assertEqual(self.delivery_a.state, "done")
        self.cross.move_ids.picked = True
        self.cross.with_user(self.user_a).button_validate()  # transfer antar gudang dari gudang A ke B dijalankan oleh pengguna gudang A
        self.assertEqual(self.cross.state, "done")
        with self.assertRaises(AccessError):
            self.receipt_b.with_user(self.user_a).button_validate()
        self.assertNotEqual(self.receipt_b.state, "done")

    # ---------- Stok on-hand dan penyesuaian ----------
    def test_on_hand_stock_and_quants_follow_the_allowed_warehouse(self):
        domain = [("product_id", "=", self.product.id), ("location_id.usage", "=", "internal")]
        quants = self.env["stock.quant"]
        self.assertEqual(quants.with_user(self.user_a).search(domain).location_id, self.wh_a.lot_stock_id)
        self.assertEqual(quants.with_user(self.user_b).search(domain).location_id, self.wh_b.lot_stock_id)
        self.assertEqual(quants.with_user(self.user_ab).search(domain).location_id, self.wh_a.lot_stock_id | self.wh_b.lot_stock_id)
        self.assertEqual(quants.with_user(self.user_a).search_count(domain), 1)
        grouped = quants.with_user(self.user_a).formatted_read_group(domain, ["location_id"], ["quantity:sum"])
        self.assertEqual({g["location_id"][0]: g["quantity:sum"] for g in grouped}, {self.wh_a.lot_stock_id.id: 10.0})
        self.assertEqual(self._on_hand(self.user_a), 10.0, "Hitungan stok produk hanya gudang yang diizinkan")
        self.assertEqual(self._on_hand(self.user_b), 6.0)
        self.assertEqual(self._on_hand(self.user_ab), 16.0)
        for user in (self.user_all, self.manager_all, self.sysadmin):
            self.assertEqual(self._on_hand(user), 16.0, user.login)
        self.assertEqual(self._on_hand(self.manager), 10.0, "Manajer Inventory dengan gudang terpilih hanya melihat gudangnya")

    def test_stock_adjustments_are_limited_to_the_allowed_warehouse(self):
        Quant = self.env["stock.quant"]
        quant_b = Quant.search([("product_id", "=", self.product.id), ("location_id", "=", self.wh_b.lot_stock_id.id)])
        with self.assertRaises(AccessError):
            quant_b.with_user(self.user_a).with_context(inventory_mode=True).write({"inventory_quantity": 99.0})
        # mode inventaris membuat quant sebagai superuser; hasilnya diperiksa ulang dengan hak pengguna (models/stock_quant.py)
        for field in ("inventory_quantity", "inventory_quantity_auto_apply"):
            with self.assertRaises(AccessError, msg=field):
                Quant.with_user(self.user_a).with_context(inventory_mode=True).create(
                    {"product_id": self.product.id, "location_id": self.wh_b.lot_stock_id.id, field: 1.0}
                )
        self.assertEqual(self._on_hand(self.user_b), 6.0, "Gudang lain tidak berubah")
        quant_a = Quant.search([("product_id", "=", self.product.id), ("location_id", "=", self.wh_a.lot_stock_id.id)])
        quant_a.with_user(self.user_a).with_context(inventory_mode=True).write({"inventory_quantity": 8.0})
        quant_a.with_user(self.user_a).with_context(inventory_mode=True).action_apply_inventory()
        self.assertEqual(self._on_hand(self.user_a), 8.0)
        self.assertEqual(self._on_hand(self.user_b), 6.0, "Gudang lain tidak berubah")
        new_product = self._create_product(name="Barang Baru Gudang A", type="consu", is_storable=True)
        counted = Quant.with_user(self.user_a).with_context(inventory_mode=True).create(
            {"product_id": new_product.id, "location_id": self.wh_a.lot_stock_id.id, "inventory_quantity_auto_apply": 3.0}
        )
        self.assertEqual(counted.quantity, 3.0, "Penyesuaian langsung di gudang yang diizinkan berjalan")

    def test_scrap_in_another_warehouse_is_rejected(self):
        scrap_vals = {"product_id": self.product.id, "scrap_qty": 1.0, "location_id": self.wh_b.lot_stock_id.id}
        with self.assertRaises(AccessError):
            scrap = self.env["stock.scrap"].with_user(self.user_a).create(scrap_vals)
            scrap.action_validate()
        self.assertEqual(self._on_hand(self.user_b), 6.0)
        scrap = self.env["stock.scrap"].with_user(self.user_b).create(scrap_vals)
        scrap.action_validate()
        self.assertEqual(self._on_hand(self.user_b), 5.0)
        self.assertFalse(self.env["stock.scrap"].with_user(self.user_a).search([("id", "=", scrap.id)]), "Scrap gudang lain tidak tampil")
        self.assertEqual(self.env["stock.scrap"].with_user(self.user_b).search([("id", "=", scrap.id)]), scrap)

    # ---------- Tanpa pembatasan, peran lain, cache ----------
    def test_users_without_selection_and_administrators_see_everything_while_a_warehouse_manager_stays_limited(self):
        quants = [("product_id", "=", self.product.id), ("location_id.usage", "=", "internal")]
        for user in (self.user_all, self.manager_all, self.sysadmin):
            self.assertEqual(self._visible(user, self.pickings), self.pickings, user.login)
            self.assertEqual(self._visible(user, self.pickings.move_ids), self.pickings.move_ids, user.login)
            self.assertEqual(len(self.env["stock.quant"].with_user(user).search(quants)), 2, user.login)
        self.receipt_b.with_user(self.manager_all).write({"origin": "oleh manajer"})
        self.assertEqual(self.receipt_b.origin, "oleh manajer")
        self.receipt_b.with_user(self.sysadmin).write({"origin": "oleh administrator"})
        # kepala gudang A: Manajer Inventory dengan gudang terpilih tidak melihat dan tidak mengubah gudang B
        self.assertEqual(self._visible(self.manager, self.pickings), self.receipt_a | self.delivery_a | self.cross | self.no_wh)
        with self.assertRaises(AccessError):
            self.receipt_b.with_user(self.manager).write({"origin": "diubah"})

    def test_user_without_inventory_role_has_no_stock_access(self):
        with self.assertRaises(AccessError):
            self.env["stock.picking"].with_user(self.plain).search_count([])

    def test_changing_the_warehouse_selection_takes_effect_immediately(self):
        user = self._scope_user("scope_wh_switch", [STOCK_USER], self.env["stock.warehouse"])
        self.assertEqual(self._visible(user, self.pickings), self.pickings, "Tanpa gudang terpilih = semua")
        user.write({"kompakapps_warehouse_ids": [Command.set(self.wh_a.ids)]})
        self.assertEqual(self._visible(user, self.pickings), self.receipt_a | self.delivery_a | self.cross | self.no_wh)
        user.write({"kompakapps_warehouse_ids": [Command.set(self.wh_b.ids)]})
        self.assertEqual(self._visible(user, self.pickings), self.receipt_b | self.delivery_b | self.cross | self.no_wh)
        user.write({"kompakapps_warehouse_ids": [Command.clear()]})
        self.assertEqual(self._visible(user, self.pickings), self.pickings, "Mengosongkan pilihan = semua gudang lagi")

    def test_user_can_read_own_warehouse_selection_for_the_scope_note(self):
        row = self.user_a.with_user(self.user_a).read(["kompakapps_warehouse_ids"])[0]
        self.assertEqual(row["kompakapps_warehouse_ids"], self.wh_a.ids)
        with self.assertRaises(AccessError):
            self.user_a.with_user(self.user_a).write({"kompakapps_warehouse_ids": [Command.clear()]})  # hanya administrator yang mengubah

    # ---------- Kombinasi dengan Cakupan data Purchase (irisan 2) ----------
    def test_warehouse_scope_does_not_loosen_the_purchase_own_rules_and_vice_versa(self):
        vendor = self.env["res.partner"].create({"name": "PT Pemasok Gudang"})
        buyer = self._scope_user("scope_wh_buyer", [PURCHASE_USER, STOCK_USER, PURCHASE_OWN], self.wh_a)
        other_buyer = self._scope_user("scope_wh_buyer2", [PURCHASE_USER, STOCK_USER, PURCHASE_OWN], self.env["stock.warehouse"])
        pm = self._scope_user("scope_wh_pm", [PURCHASE_MANAGER, STOCK_USER], self.wh_a)  # aturan "semua" Purchase tidak boleh melonggarkan gudang

        def order(user, warehouse):
            po = self.env["purchase.order"].create(
                {
                    "partner_id": vendor.id,
                    "user_id": user.id,
                    "picking_type_id": warehouse.in_type_id.id,
                    "order_line": [Command.create({"product_id": self.product.id, "product_qty": 2.0, "price_unit": 100000.0})],
                }
            )
            po.button_confirm()
            return po.picking_ids

        own_a, own_b, other_a, other_b = order(buyer, self.wh_a), order(buyer, self.wh_b), order(other_buyer, self.wh_a), order(other_buyer, self.wh_b)
        every = own_a | own_b | other_a | other_b
        self.assertEqual(self._visible(buyer, every), own_a, "PO sendiri di gudang yang diizinkan saja: kedua aturan berlaku bersamaan")
        self.assertEqual(self._visible(pm, every), own_a | other_a, "Manajer Purchase tetap dibatasi gudang")
        self.assertEqual(self._visible(other_buyer, every), other_a | other_b, "Pembeli tanpa gudang terpilih hanya dibatasi PO sendiri")

    # ---------- Perintah yang dipakai Users & Access ----------
    def test_users_and_access_commands_switch_warehouse_scope(self):
        stock_user, stock_manager = self.env.ref(STOCK_USER).id, self.env.ref(STOCK_MANAGER).id  # bertingkat: manajer membawa pengguna
        user = self._scope_user("scope_wh_ui", [], self.env["stock.warehouse"])

        def apply(role, warehouses, admin=False):
            """Meniru afterSave di ui/live/pages/users.js untuk Inventory: pilihan gudang berlaku bagi peran Pengguna dan Manajer, tidak bagi Administrator atau tanpa peran."""
            desired = {"": -1, "user": 0, "manager": 1}[role]
            commands = []
            for index, gid in enumerate((stock_user, stock_manager)):
                if index == desired:
                    commands.append(Command.link(gid))
                elif index > desired:
                    commands.append(Command.unlink(gid))
            vals = {"group_ids": commands}
            if role == "" or admin:
                vals["kompakapps_warehouse_ids"] = [Command.clear()]
            else:
                vals["kompakapps_warehouse_ids"] = [Command.set(warehouses.ids)]
            user.write(vals)

        apply("user", self.wh_a)
        self.assertEqual(self._visible(user, self.pickings), self.receipt_a | self.delivery_a | self.cross | self.no_wh)
        apply("user", self.wh_a | self.wh_b)
        self.assertEqual(self._visible(user, self.pickings), self.pickings)
        apply("user", self.wh_b)
        self.assertEqual(self._visible(user, self.pickings), self.receipt_b | self.delivery_b | self.cross | self.no_wh)
        apply("manager", self.wh_b)
        self.assertEqual(user.kompakapps_warehouse_ids, self.wh_b, "Manajer Inventory (kepala gudang) tetap bisa dibatasi ke gudangnya")
        self.assertEqual(self._visible(user, self.pickings), self.receipt_b | self.delivery_b | self.cross | self.no_wh)
        apply("manager", self.env["stock.warehouse"])
        self.assertEqual(self._visible(user, self.pickings), self.pickings, "Manajer tanpa gudang terpilih melihat semua")
        apply("user", self.wh_a, admin=True)
        self.assertFalse(user.kompakapps_warehouse_ids, "Administrator otomatis semua gudang")
        apply("", self.wh_a)
        self.assertFalse(user.kompakapps_warehouse_ids)


ATT_OFFICER = "hr_attendance.group_hr_attendance_officer"
ATT_MANAGER = "hr_attendance.group_hr_attendance_manager"
LEAVE_RESPONSIBLE = "hr_holidays.group_hr_holidays_responsible"
LEAVE_OFFICER = "hr_holidays.group_hr_holidays_user"
EXPENSE_TEAM = "hr_expense.group_hr_expense_team_approver"
EXPENSE_ALL = "hr_expense.group_hr_expense_user"
ACCOUNT_INVOICE = "account.group_account_invoice"
ACCOUNT_READONLY = "account.group_account_readonly"
ACCOUNT_BOOKKEEPER = "account.group_account_user"


@tagged("post_install", "-at_install", "kompakapps")
class TestAccessScopeHR(AccountTestInvoicingCommon):
    """Audit HR dan Accounting (D87, Q9 irisan 3): bukti bahwa cakupan Attendance, Time Off, dan Expenses yang dipetakan di Users & Access benar-benar berlaku."""

    @classmethod
    @AccountTestInvoicingCommon.setup_country("id")
    def setUpClass(cls):
        super().setUpClass()
        cls.env.user.write({"group_ids": [Command.link(cls.env.ref(x).id) for x in ("hr.group_hr_manager", ATT_MANAGER, "hr_holidays.group_hr_holidays_manager", "hr_expense.group_hr_expense_manager")]})
        Users = {}
        for key, xmlids in {
            "own1": [], "own2": [], "own3": [],
            "att_officer": [ATT_OFFICER], "att_manager": [ATT_MANAGER],
            "leave_resp": [LEAVE_RESPONSIBLE], "leave_officer": [LEAVE_OFFICER],
            "exp_team": [EXPENSE_TEAM], "exp_all": [EXPENSE_ALL], "bookkeeper": [ACCOUNT_BOOKKEEPER],
            "acct_invoice": [ACCOUNT_INVOICE], "acct_readonly": [ACCOUNT_READONLY],
        }.items():
            Users[key] = make_scope_user(cls.env, f"scope_hr_{key}", xmlids)
        cls.users = Users
        cls.emp = {key: cls.env["hr.employee"].create({"name": f"Karyawan {key}", "user_id": user.id, "company_id": cls.env.company.id}) for key, user in Users.items()}
        # keterkaitan tim: pengelola kehadiran, penyetuju cuti, dan penyetuju biaya untuk karyawan own2
        cls.emp["own2"].write(
            {
                "attendance_manager_id": Users["att_officer"].id,
                "leave_manager_id": Users["leave_resp"].id,
                "expense_manager_id": Users["exp_team"].id,
            }
        )
        now = fields.Datetime.now()
        cls.attendance = {k: cls.env["hr.attendance"].create({"employee_id": cls.emp[k].id, "check_in": now - timedelta(hours=9), "check_out": now - timedelta(hours=1)}) for k in ("own1", "own2", "own3")}
        leave_type = cls.env["hr.leave.type"].create({"name": "Cuti Uji Cakupan", "requires_allocation": False, "leave_validation_type": "no_validation"})
        day = fields.Date.today() + timedelta(days=(7 - fields.Date.today().weekday()) % 7 + 14)  # Senin dua minggu ke depan
        cls.leave = {
            k: cls.env["hr.leave"].create({"employee_id": cls.emp[k].id, "holiday_status_id": leave_type.id, "request_date_from": day, "request_date_to": day})
            for k in ("own1", "own2", "own3")
        }
        cls.expense = {
            k: cls.env["hr.expense"].create({"name": f"Biaya {k}", "employee_id": cls.emp[k].id, "total_amount_currency": 100000.0, "payment_mode": "own_account"})
            for k in ("own1", "own2", "own3")
        }

    def _seen(self, user_key, records):
        return records.with_user(self.users[user_key]).search([("id", "in", records.ids)])

    def _all(self, mapping):
        return sum(mapping.values(), self.env[next(iter(mapping.values()))._name])

    # ---------- Attendance ----------
    def test_attendance_scopes_own_managed_employees_and_all(self):
        attendances = self._all(self.attendance)
        a = self.attendance
        self.assertEqual(self._seen("own1", attendances), a["own1"], "Pengguna internal tanpa peran Attendance hanya membaca kehadirannya sendiri")
        self.assertEqual(self._seen("own2", attendances), a["own2"])
        self.assertEqual(self._seen("att_officer", attendances), a["own2"], "Petugas hanya melihat karyawan yang ia kelola (pengelola kehadiran), bukan semua")
        self.assertEqual(self._seen("att_manager", attendances), attendances, "Administrator Attendance melihat semua")
        with self.assertRaises(AccessError):
            a["own2"].with_user(self.users["own1"]).read(["check_in"])
        with self.assertRaises(AccessError):
            a["own1"].with_user(self.users["own2"]).write({"check_out": fields.Datetime.now()})
        self.assertEqual(self.env["hr.attendance"].with_user(self.users["own1"]).search_count([("id", "in", attendances.ids)]), 1)

    # ---------- Time Off ----------
    def test_time_off_scopes_own_responsible_team_and_all(self):
        leaves = self._all(self.leave)
        lv = self.leave
        self.assertEqual(self._seen("own1", leaves), lv["own1"], "Pengguna internal hanya melihat cutinya sendiri")
        self.assertEqual(self._seen("own3", leaves), lv["own3"])
        self.assertEqual(self._seen("leave_resp", leaves), lv["own2"], "Penyetuju tim melihat cuti karyawan yang ia setujui")
        self.assertEqual(self._seen("leave_officer", leaves), leaves, "Petugas Time Off melihat semua cuti")
        with self.assertRaises(AccessError):
            lv["own2"].with_user(self.users["own1"]).read(["name"])
        with self.assertRaises(AccessError):
            lv["own2"].with_user(self.users["own1"]).write({"name": "diubah"})
        self.assertIn(self.env.ref("hr.group_hr_user"), self.users["leave_officer"].all_group_ids, "Temuan: peran Petugas Time Off membawa Petugas HR (data karyawan) secara tersirat")

    # ---------- Expenses ----------
    def test_expense_scopes_own_team_and_all(self):
        expenses = self._all(self.expense)
        ex = self.expense
        self.assertEqual(self._seen("own1", expenses), ex["own1"], "Pengguna internal hanya melihat biaya miliknya sendiri")
        self.assertEqual(self._seen("exp_team", expenses), ex["own2"], "Penyetuju tim melihat biaya karyawan yang ia setujui")
        for key in ("exp_all", "bookkeeper"):
            self.assertEqual(self._seen(key, expenses), expenses, f"{key} melihat semua biaya")
        with self.assertRaises(AccessError):
            ex["own2"].with_user(self.users["own1"]).read(["name"])
        with self.assertRaises(AccessError):
            ex["own2"].with_user(self.users["own1"]).unlink()

    # ---------- Accounting: dokumentasi hak, tidak diperketat ----------
    def test_accounting_roles_see_all_journals_and_plain_users_have_no_access(self):
        invoice = self.init_invoice("out_invoice", products=self.product_a, post=True)
        bill = self.init_invoice("in_invoice", products=self.product_b, post=True)
        moves = invoice | bill
        for key in ("acct_invoice", "acct_readonly", "bookkeeper"):
            self.assertEqual(self._seen(key, moves), moves, f"{key} melihat semua jurnal, faktur, dan tagihan")
        with self.assertRaises(AccessError):
            moves.with_user(self.users["acct_readonly"]).write({"ref": "diubah"})
        for key in ("own1", "exp_team"):
            with self.assertRaises(AccessError, msg=key):
                moves.with_user(self.users[key]).read(["name"])
        lines = self.env["account.move.line"].with_user(self.users["acct_readonly"]).search([("move_id", "in", moves.ids)])
        self.assertTrue(lines, "Accounting Hanya baca membaca item jurnal")
