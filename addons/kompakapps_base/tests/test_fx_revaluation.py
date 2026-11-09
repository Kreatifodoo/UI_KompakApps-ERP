from datetime import date

from odoo import Command
from odoo.addons.account.tests.common import AccountTestInvoicingCommon
from odoo.exceptions import UserError, ValidationError
from odoo.tests import tagged


@tagged("post_install", "-at_install", "kompakapps")
class TestFxRevaluation(AccountTestInvoicingCommon):
    """Revaluasi mata uang (Q80, D105): selisih kurs belum terealisasi pada piutang dan hutang valas, jurnal dengan pembalik otomatis, dan ringkasan realized dibanding unrealized."""

    @classmethod
    @AccountTestInvoicingCommon.setup_country("id")
    def setUpClass(cls):
        super().setUpClass()
        cls.company = cls.env.company
        cls.usd = cls.env.ref("base.USD")
        cls.usd.active = True
        cls.env["res.currency.rate"].search([("currency_id", "=", cls.usd.id), ("company_id", "=", cls.company.id)]).unlink()
        for day, idr in ((date(2026, 3, 1), 16000), (date(2026, 3, 5), 16200), (date(2026, 3, 31), 16500), (date(2026, 4, 15), 16800)):
            cls.env["res.currency.rate"].create({"currency_id": cls.usd.id, "name": day, "rate": 1.0 / idr, "company_id": cls.company.id})
        Account = cls.env["account.account"]
        cls.company.income_currency_exchange_account_id = Account.create({"code": "X80010", "name": "Untung Kurs Terealisasi", "account_type": "income_other"})
        cls.company.expense_currency_exchange_account_id = Account.create({"code": "X90010", "name": "Rugi Kurs Terealisasi", "account_type": "expense"})

    def _foreign(self, move_type, amount, day):
        move = self.env["account.move"].create(
            {
                "move_type": move_type, "partner_id": self.partner_a.id, "invoice_date": day, "date": day, "currency_id": self.usd.id,
                "invoice_line_ids": [Command.create({"name": "Jasa", "quantity": 1.0, "price_unit": amount, "tax_ids": [Command.clear()]})],
            }
        )
        move.action_post()
        return move

    def _pay(self, move, day, amount=None):
        vals = {"payment_date": day}
        if amount:
            vals["amount"] = amount
        self.env["account.payment.register"].with_context(active_model="account.move", active_ids=move.ids).create(vals)._create_payments()

    def _revaluation(self, day):
        revaluation = self.env["kompakapps.fx.revaluation"].create({"date": day})
        revaluation.action_compute()
        return revaluation

    def test_receivable_gain_and_payable_loss(self):
        invoice = self._foreign("out_invoice", 1000.0, date(2026, 3, 1))
        self._foreign("in_invoice", 400.0, date(2026, 3, 1))
        self.assertEqual(invoice.amount_total_signed, 16_000_000, "dibukukan pada kurs 16.000")
        revaluation = self._revaluation(date(2026, 3, 31))  # kurs 16.500
        receivable = revaluation.line_ids.filtered(lambda row: row.kind == "receivable")
        payable = revaluation.line_ids.filtered(lambda row: row.kind == "payable")
        self.assertEqual(len(receivable), 1)
        self.assertEqual((receivable.foreign_balance, receivable.booked_balance, receivable.revalued_balance, receivable.adjustment), (1000.0, 16_000_000, 16_500_000, 500_000))
        self.assertEqual((payable.foreign_balance, payable.booked_balance, payable.revalued_balance, payable.adjustment), (-400.0, -6_400_000, -6_600_000, -200_000))
        self.assertEqual((revaluation.total_gain, revaluation.total_loss, revaluation.total_net), (500_000, 200_000, 300_000))

    def test_posting_is_balanced_and_reversed_the_next_day(self):
        invoice = self._foreign("out_invoice", 1000.0, date(2026, 3, 1))
        self._foreign("in_invoice", 400.0, date(2026, 3, 1))
        revaluation = self._revaluation(date(2026, 3, 31))
        revaluation.action_post()
        move, back = revaluation.move_id, revaluation.reverse_move_id
        self.assertEqual((revaluation.state, move.state, back.state), ("posted", "posted", "posted"))
        self.assertEqual(back.date, date(2026, 4, 1))
        self.assertEqual(sum(move.line_ids.mapped("debit")), sum(move.line_ids.mapped("credit")))
        valas = move.line_ids.filtered("partner_id")
        self.assertTrue(all(row.currency_id == self.usd and not row.amount_currency for row in valas), "nilai valas tidak berubah, hanya nilai rupiah")
        self.assertEqual(move.line_ids.filtered(lambda row: row.account_id == revaluation.gain_account_id).credit, 500_000)
        self.assertEqual(move.line_ids.filtered(lambda row: row.account_id == revaluation.loss_account_id).debit, 200_000)
        for account in (revaluation.gain_account_id, revaluation.loss_account_id, invoice.line_ids.filtered("account_id.reconcile").account_id):
            net = sum((move | back).line_ids.filtered(lambda row, acc=account: row.account_id == acc).mapped("balance"))
            self.assertEqual(net, 0.0, f"jurnal dan pembaliknya saling meniadakan pada {account.code}")
        self.assertEqual(invoice.amount_residual, 1000.0, "sisa tagihan dalam USD tidak berubah")

    def test_partial_payment_is_taken_into_account_by_date(self):
        invoice = self._foreign("out_invoice", 1000.0, date(2026, 3, 1))
        self._pay(invoice, date(2026, 3, 20), 300.0)
        before = self._revaluation(date(2026, 3, 10)).line_ids.filtered(lambda row: row.kind == "receivable")
        after = self._revaluation(date(2026, 3, 31)).line_ids.filtered(lambda row: row.kind == "receivable")
        self.assertAlmostEqual(before.foreign_balance, 1000.0, msg="pembayaran setelah tanggal revaluasi dikembalikan")
        self.assertAlmostEqual(after.foreign_balance, 700.0)
        self.assertEqual(after.revalued_balance, 700 * 16_500)
        self.assertEqual(after.adjustment, after.revalued_balance - after.booked_balance)

    def test_one_posted_revaluation_per_date_and_cancel(self):
        self._foreign("out_invoice", 1000.0, date(2026, 3, 1))
        first = self._revaluation(date(2026, 3, 31))
        first.action_post()
        second = self._revaluation(date(2026, 3, 31))
        with self.assertRaises(ValidationError):
            second.action_post()
        with self.assertRaises(UserError):
            first.unlink()
        first.action_cancel()
        self.assertEqual((first.state, first.move_id.state, first.reverse_move_id.state), ("cancel", "cancel", "cancel"))
        with self.assertRaises(UserError):
            first.unlink()
        with self.assertRaises(UserError):
            self.env["kompakapps.fx.revaluation"].create({"date": date(2026, 3, 1)}).action_post()  # tanpa baris tidak ada yang dijurnal

    def test_summary_separates_realized_and_unrealized(self):
        paid = self._foreign("out_invoice", 1000.0, date(2026, 3, 1))
        self._foreign("in_invoice", 400.0, date(2026, 3, 1))
        self._pay(paid, date(2026, 3, 20))  # dilunasi pada kurs 16.200: untung terealisasi 200.000
        revaluation = self._revaluation(date(2026, 3, 31))
        revaluation.action_post()
        summary = self.env["kompakapps.fx.revaluation"].kompakapps_fx_summary("2026-03-01", "2026-04-30")
        months = {row["month"]: row for row in summary["months"]}
        self.assertEqual(months["2026-03"]["realized_gain"], 200_000)
        self.assertEqual(months["2026-03"]["unrealized_loss"], 200_000, "hutang USD 400 naik dari 16.000 ke 16.500")
        self.assertEqual(months["2026-04"]["unrealized_loss"], -200_000, "pembalik pada 1 April")
        self.assertEqual([row["id"] for row in summary["revaluations"]], [revaluation.id])
        self.assertIn("USD", [row["currency"] for row in summary["rates"]])
