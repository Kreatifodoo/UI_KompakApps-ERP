from odoo import Command, fields
from odoo.addons.account.tests.common import AccountTestInvoicingCommon
from odoo.tests import tagged

OCA_ACCOUNTING_MODULES = (
    "mis_builder",
    "account_financial_report",
    "account_reconcile_oca",
    "account_asset_management",
    "account_usability",
)


@tagged("post_install", "-at_install", "kompakapps")
class TestOcaAccounting(AccountTestInvoicingCommon):
    """Modul akuntansi OCA yang melengkapi Community terpasang dan berfungsi pada data Indonesia."""

    @classmethod
    @AccountTestInvoicingCommon.setup_country("id")
    def setUpClass(cls):
        super().setUpClass()
        cls.today = fields.Date.today()
        cls.year_start = cls.today.replace(month=1, day=1)

    def test_modules_installed(self):
        installed = self.env["ir.module.module"].search(
            [("name", "in", OCA_ACCOUNTING_MODULES), ("state", "=", "installed")]
        )
        self.assertEqual(set(installed.mapped("name")), set(OCA_ACCOUNTING_MODULES))

    def test_trial_balance_reflects_vendor_bill(self):
        bill = self.init_invoice(
            "in_invoice", invoice_date=self.today, post=True, amounts=[1_000_000.0]
        )
        payable = bill.line_ids.filtered(
            lambda line: line.account_id.account_type == "liability_payable"
        ).account_id
        wizard = self.env["trial.balance.report.wizard"].create(
            {
                "date_from": self.year_start,
                "date_to": self.today,
                "target_move": "posted",
                "hide_account_at_0": True,
                "company_id": self.env.company.id,
                "fy_start_date": self.year_start,
            }
        )
        values = self.env[
            "report.account_financial_report.trial_balance"
        ]._get_report_values(wizard, wizard._prepare_report_data())
        rows = {
            row["id"]: row
            for row in values["trial_balance"]
            if row["type"] == "account_type"
        }
        self.assertIn(payable.id, rows)
        self.assertEqual(rows[payable.id]["credit"], bill.amount_total)
        # Neraca saldo seimbang: total debit sama dengan total kredit.
        self.assertAlmostEqual(
            sum(row["debit"] for row in rows.values()),
            sum(row["credit"] for row in rows.values()),
            places=2,
        )

    def test_mis_builder_report_reads_ledger(self):
        bill = self.init_invoice(
            "in_invoice", invoice_date=self.today, post=True, amounts=[1_000_000.0]
        )
        report = self.env["mis.report"].create(
            {
                "name": "Hutang usaha",
                "kpi_ids": [
                    Command.create(
                        {
                            "name": "hutang",
                            "description": "Hutang usaha",
                            "expression": "-balp[('account_type', '=', 'liability_payable')]",
                        }
                    )
                ],
            }
        )
        instance = self.env["mis.report.instance"].create(
            {
                "name": "Hutang usaha",
                "report_id": report.id,
                "company_id": self.env.company.id,
                "period_ids": [
                    Command.create(
                        {
                            "name": "Tahun berjalan",
                            "mode": "fix",
                            "manual_date_from": self.year_start,
                            "manual_date_to": self.today,
                        }
                    )
                ],
            }
        )
        matrix = instance._compute_matrix()
        values = [
            cell.val
            for row in matrix.iter_rows()
            if row.kpi.name == "hutang"
            for cell in row.iter_cells()
        ]
        self.assertEqual(values, [bill.amount_total])

    def test_asset_depreciation_board(self):
        profile = self.env["account.asset.profile"].create(
            {
                "name": "Kendaraan 5 tahun",
                "journal_id": self.company_data["default_journal_purchase"].id,
                "account_asset_id": self.company_data["default_account_assets"].id,
                "account_depreciation_id": self.company_data[
                    "default_account_assets"
                ].id,
                "account_expense_depreciation_id": self.company_data[
                    "default_account_expense"
                ].id,
                "method_time": "year",
                "method_number": 5,
                "method_period": "year",
            }
        )
        asset = self.env["account.asset"].create(
            {
                "name": "Mobil operasional",
                "profile_id": profile.id,
                "purchase_value": 12_000_000.0,
                "salvage_value": 0.0,
                "date_start": self.year_start,
                "method_time": "year",
                "method_number": 5,
                "method_period": "year",
            }
        )
        asset.compute_depreciation_board()
        lines = asset.depreciation_line_ids.filtered(
            lambda line: line.type == "depreciate"
        ).sorted("line_date")
        self.assertEqual(len(lines), 5)
        self.assertAlmostEqual(sum(lines.mapped("amount")), 12_000_000.0, places=2)
        self.assertAlmostEqual(lines[-1].remaining_value, 0.0, places=2)
