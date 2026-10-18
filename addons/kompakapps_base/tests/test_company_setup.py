from unittest.mock import patch

from odoo import Command
from odoo.exceptions import UserError
from odoo.tests import TransactionCase, tagged


@tagged("post_install", "-at_install", "kompakapps")
class TestCompanySetupIndonesia(TransactionCase):
    def test_setup_bare_company(self):
        company = self.env["res.company"].create({"name": "PT Uji Setup"})
        self.assertFalse(company.chart_template)

        company.kompakapps_setup_indonesia()

        self.assertEqual(company.country_id.code, "ID")
        self.assertEqual(company.currency_id.name, "IDR")
        self.assertEqual(company.chart_template, "id")
        purchase_taxes = self.env["account.tax"].search(
            [("company_id", "=", company.id), ("type_tax_use", "=", "purchase")]
        )
        self.assertTrue(purchase_taxes, "COA l10n_id harus membawa pajak pembelian (PPN)")
        self.assertTrue(
            self.env["account.journal"].search_count([("company_id", "=", company.id)]),
            "Jurnal harus terbentuk dari COA l10n_id",
        )
        # Persediaan: perpetual dengan biaya rata-rata untuk kategori Goods.
        self.assertEqual(company.inventory_valuation, "real_time")
        self.assertTrue(company.anglo_saxon_accounting)
        goods = self.env.ref("product.product_category_goods").with_company(company)
        self.assertEqual(goods.property_valuation, "real_time")
        self.assertEqual(goods.property_cost_method, "average")
        self.assertTrue(goods.property_stock_valuation_account_id)

    def test_setup_converts_default_pricelist_only(self):
        company = self.env["res.company"].create({"name": "PT Uji Price List"})
        usd = self.env.ref("base.USD")
        usd.active = True
        pricelist_model = self.env["product.pricelist"]
        default_list = pricelist_model.create(
            {"name": "Default Uji", "company_id": company.id, "currency_id": usd.id}
        )
        custom_list = pricelist_model.create(
            {
                "name": "Harga Khusus Uji",
                "company_id": company.id,
                "currency_id": usd.id,
                "item_ids": [
                    Command.create(
                        {"applied_on": "3_global", "compute_price": "fixed", "fixed_price": 10.0}
                    )
                ],
            }
        )

        company.kompakapps_setup_indonesia()

        self.assertEqual(default_list.currency_id.name, "IDR")
        self.assertEqual(custom_list.currency_id.name, "USD", "Aturan harga tidak boleh diubah")

    def test_setup_is_idempotent(self):
        company = self.env["res.company"].create({"name": "PT Uji Idempoten"})
        company.kompakapps_setup_indonesia()
        domain = [("company_id", "=", company.id)]
        taxes = self.env["account.tax"].search_count(domain)
        journals = self.env["account.journal"].search_count(domain)

        company.kompakapps_setup_indonesia()

        self.assertEqual(self.env["account.tax"].search_count(domain), taxes)
        self.assertEqual(self.env["account.journal"].search_count(domain), journals)

    def test_setup_refuses_company_with_accounting(self):
        company = self.env["res.company"].create({"name": "PT Uji Tolak"})
        with patch(
            "odoo.addons.account.models.company.ResCompany._existing_accounting",
            return_value=True,
        ):
            with self.assertRaises(UserError):
                company.kompakapps_setup_indonesia()
        self.assertFalse(company.chart_template)
        self.assertFalse(company.country_id)
