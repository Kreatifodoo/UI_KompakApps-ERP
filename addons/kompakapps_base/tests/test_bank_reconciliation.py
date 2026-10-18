from odoo import Command, fields
from odoo.addons.account.tests.common import AccountTestInvoicingCommon
from odoo.tests import tagged


@tagged("post_install", "-at_install", "kompakapps")
class TestBankReconciliation(AccountTestInvoicingCommon):
    """Rekonsiliasi bank (OCA account_reconcile_oca): pembayaran tertunda berpindah ke akun bank (D16)."""

    @classmethod
    @AccountTestInvoicingCommon.setup_country("id")
    def setUpClass(cls):
        super().setUpClass()
        cls.company = cls.env.company
        cls.bank = cls.company_data["default_journal_bank"]
        cls.customer = cls.env["res.partner"].create({"name": "PT Pelanggan Bank", "customer_rank": 1})
        invoice = cls.init_invoice(
            "out_invoice", partner=cls.customer, invoice_date=fields.Date.today(), post=True, amounts=[1000000.0]
        )
        cls.payment = (
            cls.env["account.payment.register"]
            .with_context(active_model="account.move", active_ids=invoice.ids)
            .create({"payment_date": fields.Date.today(), "journal_id": cls.bank.id})
            ._create_payments()
        )
        cls.outstanding_account = cls.payment.outstanding_account_id
        cls.bank_account = cls.bank.default_account_id

    def _balance(self, account):
        lines = self.env["account.move.line"].search(
            [("account_id", "=", account.id), ("parent_state", "=", "posted")]
        )
        return sum(lines.mapped("balance"))

    def _statement_line(self, amount, partner=None, ref="Mutasi uji"):
        statement = self.env["account.bank.statement"].create(
            {
                "name": ref,
                "journal_id": self.bank.id,
                "line_ids": [
                    Command.create(
                        {
                            "journal_id": self.bank.id,
                            "date": fields.Date.today(),
                            "payment_ref": ref,
                            "amount": amount,
                            "partner_id": partner.id if partner else False,
                        }
                    )
                ],
            }
        )
        return statement.line_ids

    def test_payment_is_matched_and_balances_move_to_bank(self):
        self.assertFalse(self.payment.is_matched)
        outstanding_before = self._balance(self.outstanding_account)
        bank_before = self._balance(self.bank_account)
        line = self._statement_line(1000000.0, self.customer, "Transfer pelanggan")
        line.clean_reconcile()
        outstanding_line = self.payment.move_id.line_ids.filtered(
            lambda move_line: move_line.account_id == self.outstanding_account
        )
        line._add_account_move_line(outstanding_line)
        info = line.reconcile_data_info
        self.assertTrue(info["can_reconcile"])
        self.assertFalse([item for item in info["data"] if item["kind"] == "suspense"])
        line.reconcile_bank_line()

        self.assertTrue(line.is_reconciled)
        self.assertTrue(self.payment.is_matched)
        self.assertAlmostEqual(self._balance(self.bank_account) - bank_before, 1000000.0)
        self.assertAlmostEqual(self._balance(self.outstanding_account) - outstanding_before, -1000000.0)

        line.unreconcile_bank_line()
        self.assertFalse(line.is_reconciled)
        self.assertFalse(self.payment.is_matched)

    def test_bank_fee_is_posted_to_an_expense_account(self):
        fee_account = self.env["account.account"].search(
            [("code", "=", "65110020"), ("company_ids", "in", self.company.id)], limit=1
        )
        self.assertTrue(fee_account, "Akun Bank Administration Fees tidak ada pada COA l10n_id")
        bank_before = self._balance(self.bank_account)
        line = self._statement_line(-15000.0, ref="Biaya admin bank")
        line.clean_reconcile()
        suspense = [item for item in line.reconcile_data_info["data"] if item["kind"] == "suspense"][0]
        # Sisa mutasi dicatat ke akun beban lewat isian manual, seperti pada penampil rekonsiliasi.
        line.manual_reference = suspense["reference"]
        line.manual_account_id = fee_account
        line.manual_name = suspense["name"]
        line.manual_amount = suspense["amount"]
        line._onchange_manual_reconcile_vals()
        self.assertTrue(line.reconcile_data_info["can_reconcile"])
        line.reconcile_bank_line()
        self.assertTrue(line.is_reconciled)
        self.assertAlmostEqual(self._balance(self.bank_account) - bank_before, -15000.0)
        self.assertAlmostEqual(self._balance(fee_account), 15000.0)
