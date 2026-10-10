from odoo import Command, fields
from odoo.addons.account.tests.common import AccountTestInvoicingCommon
from odoo.tests import tagged


@tagged("post_install", "-at_install", "nusara")
class TestMisReports(AccountTestInvoicingCommon):
    """Template laporan keuangan MIS (D15) dihitung benar pada COA Indonesia dan lolos pemeriksaannya."""

    @classmethod
    @AccountTestInvoicingCommon.setup_country("id")
    def setUpClass(cls):
        super().setUpClass()
        cls.company = cls.env.company
        cls.today = fields.Date.today()
        cls.year_start = cls.today.replace(month=1, day=1)
        cls.customer = cls.env["res.partner"].create({"name": "PT Pelanggan Laporan", "customer_rank": 1})
        cls.vendor = cls.env["res.partner"].create({"name": "PT Pemasok Laporan", "supplier_rank": 1})

        def account(code):
            return cls.env["account.account"].search(
                [("code", "=", code), ("company_ids", "in", cls.company.id)], limit=1
            )

        cls.accounts = {code: account(code) for code in ("41000010", "63110080", "12210020", "11120001", "31100020")}
        for code, record in cls.accounts.items():
            assert record, f"Akun {code} tidak ada pada COA l10n_id"

        def invoice(move_type, partner, code, amount, name):
            move = cls.env["account.move"].create(
                {
                    "move_type": move_type,
                    "partner_id": partner.id,
                    "invoice_date": cls.today,
                    "invoice_line_ids": [
                        Command.create(
                            {
                                "name": name,
                                "account_id": cls.accounts[code].id,
                                "quantity": 1,
                                "price_unit": amount,
                                "tax_ids": [Command.set([])],
                            }
                        )
                    ],
                }
            )
            move.action_post()
            return move

        invoice("out_invoice", cls.customer, "41000010", 600000.0, "Penjualan")
        invoice("in_invoice", cls.vendor, "63110080", 500000.0, "Listrik")
        invoice("in_invoice", cls.vendor, "12210020", 1200000.0, "Kendaraan")
        capital = cls.env["account.move"].create(
            {
                "move_type": "entry",
                "date": cls.today,
                "journal_id": cls.company_data["default_journal_misc"].id,
                "line_ids": [
                    Command.create({"account_id": cls.accounts["11120001"].id, "debit": 5000000.0, "name": "Setoran modal"}),
                    Command.create({"account_id": cls.accounts["31100020"].id, "credit": 5000000.0, "name": "Modal disetor"}),
                ],
            }
        )
        capital.action_post()

    def _report(self, key, date_from=None, date_to=None):
        instance = self.env["mis.report.instance"].create(
            {
                "name": "Uji",
                "report_id": self.env.ref(f"nusara_base.{key}").id,
                "company_id": self.company.id,
                "temporary": True,
                "target_move": "posted",
                "period_ids": [
                    Command.create(
                        {
                            "name": "Periode",
                            "mode": "fix",
                            "manual_date_from": date_from or self.year_start,
                            "manual_date_to": date_to or self.today,
                        }
                    )
                ],
            }
        )
        return {row["label"]: row["cells"][0].get("val") for row in instance.compute()["body"]}

    def test_templates_are_loaded_once(self):
        loader = self.env["nusara.mis.loader"]
        before = self.env["mis.report"].search_count([])
        loader.load_templates()
        self.assertEqual(self.env["mis.report"].search_count([]), before, "Memuat ulang tidak boleh menggandakan laporan")
        for key in ("mis_laba_rugi", "mis_neraca", "mis_arus_kas", "mis_neraca_saldo", "mis_ringkasan"):
            self.assertTrue(self.env.ref(f"nusara_base.{key}").kpi_ids, key)

    def test_profit_and_loss(self):
        values = self._report("mis_laba_rugi")
        self.assertEqual(values["Penjualan"], 600000.0)
        self.assertEqual(values["Pendapatan Bersih"], 600000.0)
        self.assertEqual(values["Beban Umum dan Kantor"], 500000.0)
        self.assertEqual(values["LABA BERSIH"], 100000.0)
        self.assertFalse(values["Akun laba rugi belum terpetakan (harus 0)"], "Ada akun laba rugi di luar pemetaan")

    def test_balance_sheet_balances(self):
        values = self._report("mis_neraca")
        self.assertEqual(values["Kas dan Bank"], 5000000.0)
        self.assertEqual(values["Piutang Usaha"], 600000.0)
        self.assertEqual(values["Aset Tetap (Harga Perolehan)"], 1200000.0)
        self.assertEqual(values["Hutang Usaha"], 1700000.0)
        self.assertEqual(values["Modal Disetor dan Prive"], 5000000.0)
        self.assertEqual(values["Laba (Rugi) Tahun Berjalan"], 100000.0)
        self.assertEqual(values["TOTAL ASET"], 6800000.0)
        self.assertEqual(values["TOTAL LIABILITAS DAN EKUITAS"], 6800000.0)
        self.assertFalse(values["Selisih aset dan liabilitas + ekuitas (harus 0)"], "Ada akun neraca di luar pemetaan")

    def test_cash_flow_reconciles_to_cash_balance(self):
        values = self._report("mis_arus_kas")
        self.assertEqual(values["Laba (Rugi) Bersih"], 100000.0)
        self.assertEqual(values["Kas Bersih dari Aktivitas Operasi"], 1200000.0)
        self.assertEqual(values["Kas Bersih dari Aktivitas Investasi"], -1200000.0)
        self.assertEqual(values["Kas Bersih dari Aktivitas Pendanaan"], 5000000.0)
        self.assertEqual(values["KENAIKAN (PENURUNAN) KAS BERSIH"], 5000000.0)
        self.assertEqual(values["Kas dan Bank Akhir Periode (saldo buku)"], 5000000.0)
        self.assertFalse(values["Selisih saldo kas (harus 0)"], "Arus kas tidak cocok dengan saldo kas dan bank")

    def test_trial_balance_is_balanced(self):
        # Baris pertama hasil compute adalah total semua akun; kolom: saldo awal, debit, kredit, saldo akhir.
        report = self.env.ref("nusara_base.mis_neraca_saldo")
        instance = self.env["mis.report.instance"].create(
            {
                "name": "Uji TB",
                "report_id": report.id,
                "company_id": self.company.id,
                "temporary": True,
                "period_ids": [
                    Command.create(
                        {"name": "P", "mode": "fix", "manual_date_from": self.year_start, "manual_date_to": self.today}
                    )
                ],
            }
        )
        total = instance.compute()["body"][0]["cells"]
        debit, credit = total[1]["val"], total[2]["val"]
        self.assertEqual(debit, credit)
        # Total debit seluruh jurnal terposting: faktur 600.000, tagihan 500.000 dan 1.200.000, modal 5.000.000.
        self.assertEqual(debit, 600000.0 + 500000.0 + 1200000.0 + 5000000.0)
        self.assertEqual(total[3]["val"], 0.0, "Saldo akhir seluruh akun harus nol")

    def test_executive_summary(self):
        values = self._report("mis_ringkasan")
        self.assertEqual(values["Pendapatan Bersih"], 600000.0)
        self.assertEqual(values["Laba Bersih"], 100000.0)
        self.assertAlmostEqual(values["Margin Laba Bersih"], 100000.0 / 600000.0)
