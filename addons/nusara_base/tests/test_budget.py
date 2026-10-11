import calendar
import datetime

from psycopg2 import IntegrityError

from odoo import Command
from odoo.addons.account.tests.common import AccountTestInvoicingCommon
from odoo.exceptions import ValidationError
from odoo.tests import tagged
from odoo.tools import mute_logger

YEAR = 2030  # tahun tetap agar angka tidak bercampur dengan transaksi lain
REVENUE, ELECTRICITY, COGS = "41000010", "63110080", "51000010"


@tagged("post_install", "-at_install", "nusara")
class TestBudget(AccountTestInvoicingCommon):
    """Anggaran per akun (mis_builder_budget, D31) dibandingkan dengan realisasi dari jurnal nyata."""

    @classmethod
    @AccountTestInvoicingCommon.setup_country("id")
    def setUpClass(cls):
        super().setUpClass()
        cls.company = cls.env.company
        cls.customer = cls.env["res.partner"].create({"name": "PT Pelanggan Anggaran", "customer_rank": 1})
        cls.vendor = cls.env["res.partner"].create({"name": "PT Pemasok Anggaran", "supplier_rank": 1})
        cls.accounts = {}
        for code in (REVENUE, ELECTRICITY, COGS, "11120001"):
            account = cls.env["account.account"].search(
                [("code", "=", code), ("company_ids", "in", cls.company.id)], limit=1
            )
            assert account, f"Akun {code} tidak ada pada COA l10n_id"
            cls.accounts[code] = account

        # Realisasi tahun 2030. Pendapatan kuartal 1 bersih 3.200.000 (3 faktur, 1 nota kredit), draft tidak dihitung.
        cls._invoice("out_invoice", cls.customer, REVENUE, 1_000_000.0, datetime.date(YEAR, 1, 10))
        cls._invoice("out_invoice", cls.customer, REVENUE, 1_500_000.0, datetime.date(YEAR, 2, 12))
        cls._invoice("out_invoice", cls.customer, REVENUE, 800_000.0, datetime.date(YEAR, 3, 5))
        cls._invoice("out_refund", cls.customer, REVENUE, 100_000.0, datetime.date(YEAR, 3, 20))
        cls._invoice("out_invoice", cls.customer, REVENUE, 700_000.0, datetime.date(YEAR, 4, 15))
        cls.draft_invoice = cls._invoice("out_invoice", cls.customer, REVENUE, 999_000.0, datetime.date(YEAR, 2, 20), post=False)
        cls._invoice("in_invoice", cls.vendor, ELECTRICITY, 300_000.0, datetime.date(YEAR, 1, 20))
        cls._invoice("in_invoice", cls.vendor, ELECTRICITY, 450_000.0, datetime.date(YEAR, 2, 18))
        cls._invoice("in_invoice", cls.vendor, ELECTRICITY, 600_000.0, datetime.date(YEAR, 3, 22))
        cogs_entry = cls.env["account.move"].create(
            {
                "move_type": "entry",
                "date": datetime.date(YEAR, 2, 1),
                "journal_id": cls.company_data["default_journal_misc"].id,
                "line_ids": [
                    Command.create({"account_id": cls.accounts[COGS].id, "debit": 200_000.0, "name": "HPP"}),
                    Command.create({"account_id": cls.accounts["11120001"].id, "credit": 200_000.0, "name": "Kas"}),
                ],
            }
        )
        cogs_entry.action_post()

        # Anggaran tahunan 2030, per bulan: pendapatan 1.200.000, listrik 400.000, HPP 150.000.
        cls.budget = cls._budget("Anggaran 2030")
        for month in range(1, 13):
            first, last = cls._month(YEAR, month)
            cls._item(cls.budget, REVENUE, first, last, credit=1_200_000.0)
            cls._item(cls.budget, ELECTRICITY, first, last, debit=400_000.0)
            cls._item(cls.budget, COGS, first, last, debit=150_000.0)
        cls.budget.action_confirm()

    # ---------- pembantu ----------

    @classmethod
    def _invoice(cls, move_type, partner, code, amount, date, post=True, analytic=None):
        line = {
            "name": "Uji anggaran",
            "account_id": cls.accounts[code].id,
            "quantity": 1,
            "price_unit": amount,
            "tax_ids": [Command.set([])],
        }
        if analytic:
            line["analytic_distribution"] = {str(analytic.id): 100}
        move = cls.env["account.move"].create(
            {"move_type": move_type, "partner_id": partner.id, "invoice_date": date, "date": date, "invoice_line_ids": [Command.create(line)]}
        )
        if post:
            move.action_post()
        return move

    @staticmethod
    def _month(year, month):
        return datetime.date(year, month, 1), datetime.date(year, month, calendar.monthrange(year, month)[1])

    @classmethod
    def _budget(cls, name, year=YEAR, **extra):
        return cls.env["mis.budget.by.account"].create(
            {"name": name, "date_from": datetime.date(year, 1, 1), "date_to": datetime.date(year, 12, 31), **extra}
        )

    @classmethod
    def _item(cls, budget, code, date_from, date_to, debit=0.0, credit=0.0, analytic=None):
        vals = {
            "budget_id": budget.id,
            "account_id": cls.accounts[code].id,
            "date_from": date_from,
            "date_to": date_to,
            "debit": debit,
            "credit": credit,
            "company_id": cls.company.id,
        }
        if analytic:
            vals["analytic_distribution"] = {str(analytic.id): 100}
        return cls.env["mis.budget.by.account.item"].create(vals)

    def _report(self, budget, date_from, date_to, key="mis_anggaran", target_move="posted", analytic_domain="[]"):
        """Hitung laporan MIS dengan kolom Anggaran dan Realisasi; kembalikan {label atau kode akun: (anggaran, realisasi)}."""
        instance = self.env["mis.report.instance"].create(
            {
                "name": "Uji anggaran",
                "report_id": self.env.ref(f"nusara_base.{key}").id,
                "company_id": self.company.id,
                "temporary": True,
                "target_move": target_move,
                "analytic_domain": analytic_domain,
                "period_ids": [
                    Command.create(
                        {
                            "name": "Anggaran",
                            "sequence": 1,
                            "mode": "fix",
                            "manual_date_from": date_from,
                            "manual_date_to": date_to,
                            "source": "mis_budget_by_account",
                            "source_mis_budget_by_account_id": budget.id,
                        }
                    ),
                    Command.create(
                        {"name": "Realisasi", "sequence": 2, "mode": "fix", "manual_date_from": date_from, "manual_date_to": date_to}
                    ),
                ],
            }
        )
        values = {}
        for row in instance.compute()["body"]:
            head = row["label"].split(" ")[0]
            key_ = head if head.isdigit() else row["label"]
            values[key_] = tuple(cell.get("val") or 0.0 for cell in row["cells"])
        return values

    def _actual(self, code, date_from, date_to, posted=True):
        """Realisasi dihitung terpisah dari mesin MIS: jumlah saldo item jurnal (debit dikurangi kredit)."""
        domain = [("account_id.code", "=", code), ("date", ">=", date_from), ("date", "<=", date_to)]
        if posted:
            domain.append(("parent_state", "=", "posted"))
        return sum(self.env["account.move.line"].search(domain).mapped("balance"))

    def _prorated(self, budget, code, date_from, date_to):
        """Anggaran dihitung terpisah: saldo baris dikali hari yang beririsan per jumlah hari baris."""
        total = 0.0
        for item in budget.item_ids.filtered(lambda i: i.account_id.code == code):
            start, end = max(item.date_from, date_from), min(item.date_to, date_to)
            if start <= end:
                total += item.balance * ((end - start).days + 1) / ((item.date_to - item.date_from).days + 1)
        return total

    # ---------- uji ----------

    def test_module_and_template_loaded(self):
        installed = self.env["ir.module.module"].search([("name", "=", "mis_builder_budget"), ("state", "=", "installed")])
        self.assertTrue(installed, "mis_builder_budget harus terpasang")
        template = self.env.ref("nusara_base.mis_anggaran")
        kpis = {kpi.name: kpi for kpi in template.kpi_ids}
        self.assertEqual(set(kpis), {"pendapatan", "harga_pokok", "beban", "laba_bersih"})
        self.assertTrue(all(kpis[name].auto_expand_accounts for name in ("pendapatan", "harga_pokok", "beban")))
        self.assertEqual(
            [kpis[name].description for name in ("pendapatan", "harga_pokok", "beban", "laba_bersih")],
            ["Pendapatan", "Harga Pokok", "Beban", "LABA (RUGI) BERSIH"],
            "UI (budgetreport.js) mengenali baris menurut label ini",
        )
        before = self.env["mis.report"].search_count([])
        self.env["nusara.mis.loader"].load_templates()
        self.assertEqual(self.env["mis.report"].search_count([]), before, "Memuat ulang tidak boleh menggandakan template")

    def test_item_sides_and_balance(self):
        first, last = self._month(YEAR, 1)
        revenue = self._item(self._budget("Sisi baris"), REVENUE, first, last, credit=500.0)
        self.assertEqual((revenue.debit, revenue.credit, revenue.balance), (0.0, 500.0, -500.0))
        item = self.budget.item_ids.filtered(lambda i: i.account_id.code == ELECTRICITY)[0]
        self.assertEqual((item.debit, item.credit, item.balance), (400_000.0, 0.0, 400_000.0))
        item.write({"debit": 0.0, "credit": 100.0})
        self.assertEqual(item.balance, -100.0, "Menukar sisi harus menghitung ulang saldo")
        with self.assertRaises(IntegrityError), mute_logger("odoo.sql_db"), self.cr.savepoint():
            item.write({"debit": 50.0, "credit": 50.0})  # kedua sisi terisi ditolak basis data

    def test_budget_vs_actual_first_quarter(self):
        start, end = datetime.date(YEAR, 1, 1), datetime.date(YEAR, 3, 31)
        values = self._report(self.budget, start, end)
        # Angka tangan: pendapatan 1.000.000 + 1.500.000 + 800.000 - 100.000 (nota kredit); draft 999.000 tidak dihitung.
        self.assertEqual(values["Pendapatan"], (3_600_000.0, 3_200_000.0))
        self.assertEqual(values[REVENUE], (3_600_000.0, 3_200_000.0))
        self.assertEqual(values["Beban"], (1_200_000.0, 1_350_000.0))
        self.assertEqual(values[ELECTRICITY], (1_200_000.0, 1_350_000.0))
        self.assertEqual(values["Harga Pokok"], (450_000.0, 200_000.0))
        self.assertEqual(values["LABA (RUGI) BERSIH"], (3_600_000.0 - 450_000.0 - 1_200_000.0, 3_200_000.0 - 200_000.0 - 1_350_000.0))
        # Hitungan terpisah dari buku besar dan dari baris anggaran harus sama.
        self.assertAlmostEqual(values[REVENUE][1], -self._actual(REVENUE, start, end), places=2)
        self.assertAlmostEqual(values[ELECTRICITY][1], self._actual(ELECTRICITY, start, end), places=2)
        self.assertAlmostEqual(values[COGS][1], self._actual(COGS, start, end), places=2)
        self.assertAlmostEqual(values[REVENUE][0], -self._prorated(self.budget, REVENUE, start, end), places=2)
        self.assertAlmostEqual(values[ELECTRICITY][0], self._prorated(self.budget, ELECTRICITY, start, end), places=2)
        self.assertAlmostEqual(values[COGS][0], self._prorated(self.budget, COGS, start, end), places=2)
        # Selisih dan pencapaian yang ditampilkan UI (realisasi dikurangi anggaran, realisasi per anggaran).
        budget_cost, actual_cost = values["Beban"]
        self.assertEqual(actual_cost - budget_cost, 150_000.0)
        self.assertAlmostEqual(actual_cost / budget_cost * 100, 112.5, places=6)

    def test_full_year_and_single_month(self):
        full = self._report(self.budget, datetime.date(YEAR, 1, 1), datetime.date(YEAR, 12, 31))
        self.assertEqual(full[REVENUE], (14_400_000.0, 3_900_000.0))  # realisasi: 3.200.000 kuartal 1 + 700.000 April
        self.assertEqual(full[ELECTRICITY], (4_800_000.0, 1_350_000.0))
        feb = self._report(self.budget, *self._month(YEAR, 2))
        self.assertEqual(feb[REVENUE], (1_200_000.0, 1_500_000.0))
        self.assertEqual(feb[ELECTRICITY], (400_000.0, 450_000.0))
        self.assertEqual(feb["Harga Pokok"], (150_000.0, 200_000.0))

    def test_draft_entries_only_with_all_moves(self):
        start, end = datetime.date(YEAR, 2, 1), datetime.date(YEAR, 2, 28)
        posted = self._report(self.budget, start, end)
        everything = self._report(self.budget, start, end, target_move="all")
        self.assertEqual(posted[REVENUE][1], 1_500_000.0)
        self.assertEqual(everything[REVENUE][1], 1_500_000.0 + self.draft_invoice.amount_total)
        self.assertAlmostEqual(everything[REVENUE][1], -self._actual(REVENUE, start, end, posted=False), places=2)

    def test_budget_is_prorated_by_days(self):
        yearly = self._budget("Tahunan")
        self._item(yearly, REVENUE, datetime.date(YEAR, 1, 1), datetime.date(YEAR, 12, 31), credit=3_650_000.0)  # 365 hari
        ten_days = self._report(yearly, datetime.date(YEAR, 1, 1), datetime.date(YEAR, 1, 10))
        self.assertAlmostEqual(ten_days[REVENUE][0], 100_000.0, places=2)
        march = self._report(yearly, *self._month(YEAR, 3))
        self.assertAlmostEqual(march[REVENUE][0], 310_000.0, places=2)
        whole = self._report(yearly, datetime.date(YEAR, 1, 1), datetime.date(YEAR, 12, 31))
        self.assertAlmostEqual(whole[REVENUE][0], 3_650_000.0, places=2)
        outside = self._report(yearly, datetime.date(YEAR + 1, 1, 1), datetime.date(YEAR + 1, 1, 31))
        self.assertEqual(outside.get(REVENUE, (0.0, 0.0))[0], 0.0, "Periode di luar anggaran tidak mendapat bagian")

    def test_profit_and_loss_view_gets_the_same_budget(self):
        """Template Laba Rugi bawaan juga membaca anggaran: KPI diturunkan dari anggaran per akun."""
        start, end = datetime.date(YEAR, 1, 1), datetime.date(YEAR, 3, 31)
        values = self._report(self.budget, start, end, key="mis_laba_rugi")
        self.assertEqual(values["Penjualan"], (3_600_000.0, 3_200_000.0))
        self.assertEqual(values["Beban Umum dan Kantor"], (1_200_000.0, 1_350_000.0))
        self.assertEqual(values["Harga Pokok Penjualan"], (450_000.0, 200_000.0))

    def test_analytic_filter_applies_to_budget_and_actual(self):
        year = YEAR + 1
        plan = self.env["account.analytic.plan"].create({"name": "Proyek Uji Anggaran"})
        alfa = self.env["account.analytic.account"].create({"name": "Alfa", "plan_id": plan.id})
        beta = self.env["account.analytic.account"].create({"name": "Beta", "plan_id": plan.id})
        self._invoice("in_invoice", self.vendor, ELECTRICITY, 200_000.0, datetime.date(year, 1, 25), analytic=alfa)
        self._invoice("in_invoice", self.vendor, ELECTRICITY, 90_000.0, datetime.date(year, 1, 26))  # tanpa analitik
        budget = self._budget("Anggaran analitik", year=year, allow_items_overlap=True)
        first, last = self._month(year, 1)
        self._item(budget, ELECTRICITY, first, last, debit=500_000.0, analytic=alfa)
        self._item(budget, ELECTRICITY, first, last, debit=700_000.0, analytic=beta)
        everything = self._report(budget, first, last)
        self.assertEqual(everything[ELECTRICITY], (1_200_000.0, 290_000.0))
        only_alfa = self._report(budget, first, last, analytic_domain=str([("analytic_distribution", "in", [alfa.id])]))
        self.assertEqual(only_alfa[ELECTRICITY], (500_000.0, 200_000.0))
        only_beta = self._report(budget, first, last, analytic_domain=str([("analytic_distribution", "in", [beta.id])]))
        self.assertEqual(only_beta[ELECTRICITY], (700_000.0, 0.0))

    def test_item_constraints(self):
        plan = self._budget("Batas baris")
        first, last = self._month(YEAR, 1)
        self._item(plan, ELECTRICITY, first, last, debit=100.0)
        with self.assertRaises(ValidationError), self.cr.savepoint():  # tumpang tindih pada akun yang sama
            self._item(plan, ELECTRICITY, datetime.date(YEAR, 1, 15), datetime.date(YEAR, 2, 15), debit=100.0)
        with self.assertRaises(ValidationError), self.cr.savepoint():  # di luar periode anggaran
            self._item(plan, REVENUE, datetime.date(YEAR - 1, 12, 1), datetime.date(YEAR - 1, 12, 31), credit=100.0)
        with self.assertRaises(ValidationError), self.cr.savepoint():  # tanggal terbalik
            self._item(plan, REVENUE, datetime.date(YEAR, 3, 31), datetime.date(YEAR, 3, 1), credit=100.0)
        plan.allow_items_overlap = True
        overlapping = self._item(plan, ELECTRICITY, datetime.date(YEAR, 1, 15), datetime.date(YEAR, 2, 15), debit=100.0)
        self.assertTrue(overlapping, "Dengan izin tumpang tindih, baris kedua boleh dibuat")

    def test_state_flow(self):
        plan = self._budget("Alur status")
        self.assertEqual(plan.state, "draft")
        plan.action_confirm()
        self.assertEqual(plan.state, "confirmed")
        plan.action_draft()
        self.assertEqual(plan.state, "draft")
        plan.action_cancel()
        self.assertEqual(plan.state, "cancelled")
        plan.action_draft()
        plan.action_archive()
        self.assertFalse(plan.active)
        copy = self.budget.copy()
        self.assertEqual(copy.state, "draft", "Salinan anggaran mulai sebagai draft")
        self.assertEqual(len(copy.item_ids), len(self.budget.item_ids), "Salinan membawa semua baris")
