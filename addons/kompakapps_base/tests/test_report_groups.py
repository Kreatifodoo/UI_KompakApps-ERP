from odoo import Command, fields
from odoo.addons.account.tests.common import AccountTestInvoicingCommon
from odoo.exceptions import ValidationError
from odoo.tests import tagged

from ..models.account_report_group import default_group


@tagged("post_install", "-at_install", "kompakapps")
class TestReportGroups(AccountTestInvoicingCommon):
    """Pos Laporan per akun (D67): akun baru otomatis muncul di Laba Rugi dan Neraca dengan uraian, dan mengubah pos memindahkan nilainya."""

    @classmethod
    @AccountTestInvoicingCommon.setup_country("id")
    def setUpClass(cls):
        super().setUpClass()
        cls.company = cls.env.company
        cls.today = fields.Date.today()
        cls.year_start = cls.today.replace(month=1, day=1)
        cls.Account = cls.env["account.account"]
        cls.misc = cls.company_data["default_journal_misc"]

        def account(code):
            return cls.Account.search([("code", "=", code), ("company_ids", "in", cls.company.id)], limit=1)

        cls.sales = account("41000010")
        cls.bank = account("11120001")
        cls.capital = account("31100020")
        # akun baru dengan kode di luar semua awalan lama
        cls.new_expense = cls.Account.create({"code": "71000099", "name": "Beban Riset Baru", "account_type": "expense", "company_ids": [Command.set(cls.company.ids)]})
        cls.new_asset = cls.Account.create({"code": "19999999", "name": "Uang Muka Proyek Baru", "account_type": "asset_current", "company_ids": [Command.set(cls.company.ids)]})
        cls._post(cls.bank, 1000000.0, cls.sales, 1000000.0)  # penjualan tunai
        cls._post(cls.new_expense, 250000.0, cls.bank, 250000.0)  # beban baru dibayar kas
        cls._post(cls.new_asset, 400000.0, cls.bank, 400000.0)  # uang muka proyek (aset baru)
        cls._post(cls.bank, 3000000.0, cls.capital, 3000000.0)  # modal

    @classmethod
    def _post(cls, debit_account, debit, credit_account, credit):
        move = cls.env["account.move"].create(
            {
                "move_type": "entry",
                "date": cls.today,
                "journal_id": cls.misc.id,
                "line_ids": [
                    Command.create({"account_id": debit_account.id, "debit": debit, "name": "Uji"}),
                    Command.create({"account_id": credit_account.id, "credit": credit, "name": "Uji"}),
                ],
            }
        )
        move.action_post()

    def _rows(self, key):
        instance = self.env["mis.report.instance"].create(
            {
                "name": "Uji pos",
                "report_id": self.env.ref(f"kompakapps_base.{key}").id,
                "company_id": self.company.id,
                "temporary": True,
                "target_move": "posted",
                "period_ids": [Command.create({"name": "P", "mode": "fix", "manual_date_from": self.year_start, "manual_date_to": self.today})],
            }
        )
        return instance.compute()["body"]

    def _values(self, key):
        return {row["label"]: row["cells"][0].get("val") for row in self._rows(key)}

    def test_defaults_follow_old_code_mapping_and_account_type(self):
        self.assertEqual(self.sales.kompakapps_report_group, "penjualan")
        self.assertEqual(self.bank.kompakapps_report_group, "kas_bank")
        self.assertEqual(self.capital.kompakapps_report_group, "modal")
        self.assertEqual(self.new_expense.kompakapps_report_group, "beban_lain_operasional", "Beban baru tanpa kode dikenal masuk Beban Operasional Lain")
        self.assertEqual(self.new_asset.kompakapps_report_group, "aset_lancar_lain")
        # fungsi bantu: jenis akun mengalahkan kode, kode tak dikenal memakai cadangan jenis akun, jenis di luar neraca tidak dilaporkan
        self.assertEqual(default_group("65110010", "expense_depreciation"), "beban_penyusutan")
        self.assertEqual(default_group("65110070", "expense"), "beban_pajak")
        self.assertEqual(default_group("61100010", "expense"), "beban_gaji")
        self.assertEqual(default_group("12280010", "asset_fixed"), "akumulasi_penyusutan")
        self.assertEqual(default_group("99999999", "liability_current"), "hutang_lain")
        self.assertEqual(default_group("99999999", "off_balance"), "none")

    def test_new_accounts_appear_in_profit_and_loss_with_detail(self):
        rows = self._rows("mis_laba_rugi")
        values = {row["label"]: row["cells"][0].get("val") for row in rows}
        self.assertEqual(values["Beban Operasional Lain"], 250000.0)
        self.assertEqual(values["LABA BERSIH"], 750000.0, "Laba bersih sudah memuat beban akun baru")
        self.assertFalse(values["Akun laba rugi belum terpetakan (harus 0)"])
        detail = [row for row in rows if row["label"].endswith("Beban Riset Baru")]
        self.assertTrue(detail, "Uraian per akun muncul untuk akun baru")
        self.assertEqual(detail[0]["cells"][0]["val"], 250000.0)

    def test_new_asset_appears_in_balance_sheet_and_it_balances(self):
        values = self._values("mis_neraca")
        self.assertEqual(values["Aset Lancar Lain"], 400000.0)
        self.assertEqual(values["Kas dan Bank"], 1000000.0 - 250000.0 - 400000.0 + 3000000.0)
        self.assertEqual(values["TOTAL ASET"], values["TOTAL LIABILITAS DAN EKUITAS"])
        self.assertFalse(values["Selisih aset dan liabilitas + ekuitas (harus 0)"])

    def test_changing_the_group_moves_the_amount(self):
        self.new_expense.kompakapps_report_group = "beban_gaji"
        values = self._values("mis_laba_rugi")
        self.assertEqual(values["Gaji dan Tunjangan"], 250000.0)
        self.assertFalse(values["Beban Operasional Lain"])
        self.assertEqual(values["LABA BERSIH"], 750000.0, "Laba bersih tidak berubah, hanya pindah baris")
        self.assertFalse(values["Akun laba rugi belum terpetakan (harus 0)"])

    def test_unreported_account_lights_the_check_row(self):
        self.new_expense.kompakapps_report_group = "none"
        values = self._values("mis_laba_rugi")
        self.assertEqual(values["LABA BERSIH"], 1000000.0, "Akun tidak dilaporkan keluar dari laba rugi")
        self.assertEqual(values["Akun laba rugi belum terpetakan (harus 0)"], -250000.0, "Baris pemeriksaan menyala sebesar saldo akun itu")

    def test_group_must_match_account_type(self):
        with self.assertRaises(ValidationError):
            self.new_expense.kompakapps_report_group = "kas_bank"
        with self.assertRaises(ValidationError):
            self.bank.kompakapps_report_group = "penjualan"

    def test_cash_flow_still_reconciles_with_new_accounts(self):
        values = self._values("mis_arus_kas")
        self.assertFalse(values["Selisih saldo kas (harus 0)"])
        self.assertEqual(values["Kas dan Bank Akhir Periode (saldo buku)"], 3350000.0)

    def test_blank_value_means_automatic(self):
        self.new_expense.kompakapps_report_group = "beban_gaji"
        self.new_expense.write({"kompakapps_report_group": False})
        self.assertEqual(self.new_expense.kompakapps_report_group, "beban_lain_operasional", "Dikosongkan berarti kembali ke pos otomatis")
        created = self.Account.create({"code": "71000098", "name": "Beban Impor", "account_type": "expense", "kompakapps_report_group": False, "company_ids": [Command.set(self.company.ids)]})
        self.assertEqual(created.kompakapps_report_group, "beban_lain_operasional", "Kolom kosong pada impor tidak mengeluarkan akun dari laporan")
