from unittest.mock import patch

from odoo import Command, fields
from odoo.addons.account.tests.common import AccountTestInvoicingCommon
from odoo.exceptions import AccessError
from odoo.tests import tagged


@tagged("post_install", "-at_install", "kompakapps")
class TestMultiCompany(AccountTestInvoicingCommon):
    """Perusahaan kedua dengan COA Indonesia sendiri: data terpisah per perusahaan, mitra dibagi, dan hak perusahaan per pengguna (D62)."""

    @classmethod
    @AccountTestInvoicingCommon.setup_country("id")
    def setUpClass(cls):
        super().setUpClass()
        cls.company_a = cls.env.company
        cls.company_b = cls.env["res.company"].create({"name": "PT Cabang Multi Uji"})
        cls.company_b.kompakapps_setup_indonesia()
        cls.env.user.write({"company_ids": [Command.link(cls.company_b.id)]})
        cls.vendor = cls.env["res.partner"].create({"name": "PT Pemasok Bersama", "supplier_rank": 1})

    def _env(self, company, env=None):
        """Environment yang bekerja untuk satu perusahaan (seperti pemilih perusahaan di UI)."""
        env = env or self.env
        return env(context={**env.context, "allowed_company_ids": [company.id]})

    def _bill(self, company, amount=1_000_000.0):
        env = self._env(company)
        expense = env["account.account"].search([("account_type", "=", "expense"), ("company_ids", "in", company.id)], limit=1)
        tax = env["account.tax"].search([("type_tax_use", "=", "purchase"), ("company_id", "=", company.id)], limit=1)
        bill = env["account.move"].create(
            {
                "move_type": "in_invoice",
                "partner_id": self.vendor.id,
                "invoice_date": fields.Date.today(),
                "invoice_line_ids": [Command.create({"name": "Jasa", "quantity": 1, "price_unit": amount, "account_id": expense.id, "tax_ids": [Command.set(tax.ids)]})],
            }
        )
        bill.action_post()
        return bill

    def test_second_company_has_its_own_chart_taxes_journals_and_warehouse(self):
        b = self.company_b
        self.assertEqual((b.chart_template, b.currency_id.name, b.country_id.code), ("id", "IDR", "ID"))
        env_b = self._env(b)
        env_a = self._env(self.company_a)
        for model in ("account.journal", "account.tax"):
            ids_a = set(env_a[model].search([]).ids)
            ids_b = set(env_b[model].search([]).ids)
            self.assertTrue(ids_b, f"{model}: perusahaan kedua punya data sendiri")
            self.assertFalse(ids_a & ids_b, f"{model}: data kedua perusahaan tidak boleh tercampur")
        warehouse_b = env_b["stock.warehouse"].search([("company_id", "=", b.id)])
        self.assertTrue(warehouse_b, "Perusahaan baru otomatis punya gudang")
        self.assertNotEqual(warehouse_b.lot_stock_id, env_a["stock.warehouse"].search([("company_id", "=", self.company_a.id)], limit=1).lot_stock_id)

    def test_documents_are_isolated_but_partners_are_shared(self):
        bill_a = self._bill(self.company_a)
        bill_b = self._bill(self.company_b, 2_000_000.0)
        env_a = self._env(self.company_a)
        env_b = self._env(self.company_b)
        self.assertEqual(env_a["account.move"].search_count([("id", "in", (bill_a | bill_b).ids)]), 1)
        self.assertEqual(env_b["account.move"].search_count([("id", "in", (bill_a | bill_b).ids)]), 1)
        self.assertEqual(bill_b.company_id, self.company_b)
        self.assertTrue(bill_b.name.startswith("BILL/"), "Nomor dokumen perusahaan kedua punya urutan sendiri")
        self.assertEqual(env_a["res.partner"].search_count([("id", "=", self.vendor.id)]), 1)
        self.assertEqual(env_b["res.partner"].search_count([("id", "=", self.vendor.id)]), 1)
        # setup berulang pada perusahaan yang sudah bertransaksi tidak mengubah apa pun
        self.company_b.kompakapps_setup_indonesia()
        self.assertEqual(bill_b.state, "posted")

    def test_user_limited_to_one_company_cannot_open_the_other(self):
        bill_a = self._bill(self.company_a)
        limited = self.env["res.users"].create(
            {
                "name": "Staf Cabang",
                "login": "staf.cabang.uji",
                "company_id": self.company_b.id,
                "company_ids": [Command.set(self.company_b.ids)],
                "group_ids": [Command.link(self.env.ref("account.group_account_invoice").id)],
            }
        )
        as_limited = self.env(user=limited)
        self.assertFalse(as_limited["account.move"].search([("id", "=", bill_a.id)]), "Pengguna cabang tidak melihat dokumen perusahaan lain")
        with self.assertRaises(AccessError):
            self._env(self.company_a, as_limited)["account.move"].search([])

    def test_new_company_outside_tests_gets_a_warehouse_from_setup(self):
        # di luar test Odoo 19 tidak membuat gudang untuk perusahaan baru; kompakapps_setup_warehouse yang membuatnya
        with patch("odoo.modules.module.current_test", None):
            company = self.env["res.company"].create({"name": "PT Gudang Belakangan"})
        warehouses = self.env["stock.warehouse"].with_context(active_test=False)
        self.assertFalse(warehouses.search([("company_id", "=", company.id)]))
        company.kompakapps_setup_warehouse()
        warehouse = warehouses.search([("company_id", "=", company.id)])
        self.assertEqual(len(warehouse), 1)
        self.assertTrue(warehouse.in_type_id and warehouse.out_type_id and warehouse.lot_stock_id, "Gudang membawa lokasi stok dan tipe operasi")
        company.kompakapps_setup_warehouse()
        self.assertEqual(warehouses.search_count([("company_id", "=", company.id)]), 1, "Menjalankan ulang tidak membuat gudang kedua")
        with patch("odoo.modules.module.current_test", None):
            other = self.env["res.company"].create({"name": "PT Gudang Belakangan Dua"})
        other.kompakapps_setup_warehouse()
        codes = warehouses.search([("company_id", "in", (company | other).ids)]).mapped("code")
        self.assertEqual(len(codes), len(set(codes)), "Kode gudang tidak kembar walau inisial perusahaan sama")
