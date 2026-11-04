from datetime import timedelta

from odoo import Command, fields
from odoo.addons.account.tests.common import AccountTestInvoicingCommon
from odoo.exceptions import AccessError, UserError, ValidationError
from odoo.tests import new_test_user, tagged
from odoo.tools import mute_logger


@tagged("post_install", "-at_install", "kompakapps")
class TestCogmWorksheet(AccountTestInvoicingCommon):
    """Kertas kerja COGM periodik dengan Control Balance (Q64, D92): rumus, jurnal, dan semua pemeriksaan yang membuat statusnya Merah."""

    @classmethod
    @AccountTestInvoicingCommon.setup_country("id")
    def setUpClass(cls):
        super().setUpClass()
        cls.company = cls.env.company
        cls.company.kompakapps_setup_cogm()
        cls.config = cls.env["kompakapps.cogm.config"]._for_company(cls.company)
        # Periode = bulan berjalan supaya stok sistem (pergerakan stok hari ini) ikut terhitung pada akhir periode.
        today = fields.Date.today()
        cls.date_from = today.replace(day=1)
        cls.date_to = (cls.date_from + timedelta(days=32)).replace(day=1) - timedelta(days=1)
        cls.before = cls.date_from - timedelta(days=1)
        cls.counter = cls.company_data["default_account_assets"]
        cls.misc = cls.company_data["default_journal_misc"]
        cls.raw = cls.config.raw_account_id
        cls.wip = cls.config.wip_account_id
        cls.fg = cls.config.fg_account_id
        cls.summary = cls.config.summary_account_id
        cls.purchases = cls._account("51000020")
        cls.freight = cls._account("51000021")
        cls.returns = cls._account("51000022")
        cls.discount = cls._account("51000023")
        cls.labor = cls._account("51200010")
        cls.indirect = cls._account("51300010")
        cls.power = cls._account("51300020")
        cls.depreciation = cls._account("51300030")
        cls.power_map = cls.config.account_ids.filtered(lambda m: m.account_id == cls.power)
        cls.power_map.pct = 50.0
        common = {"type": "consu", "is_storable": False, "taxes_id": [Command.clear()], "supplier_taxes_id": [Command.clear()]}
        cls.resin = cls._create_product(name="Resin COGM", standard_price=50000.0, **common)
        cls.solvent = cls._create_product(name="Pelarut COGM", standard_price=150000.0, **common)

    @classmethod
    def _account(cls, code):
        return cls.env["account.account"].with_company(cls.company).search([("code", "=", code), ("company_ids", "in", cls.company.id)], limit=1)

    def _entry(self, date, account, debit=0.0, credit=0.0):
        """Jurnal manual dua baris: akun yang diuji lawan akun kas."""
        move = self.env["account.move"].create(
            {
                "move_type": "entry", "journal_id": self.misc.id, "date": date,
                "line_ids": [
                    Command.create({"account_id": account.id, "debit": debit, "credit": credit}),
                    Command.create({"account_id": self.counter.id, "debit": credit, "credit": debit}),
                ],
            }
        )
        move.action_post()
        return move

    def _balance(self, account, to=None):
        domain = [("account_id", "=", account.id), ("parent_state", "=", "posted"), ("company_id", "=", self.company.id)]
        if to:
            domain.append(("date", "<=", to))
        return round(sum(self.env["account.move.line"].search(domain).mapped("balance")), 2)

    def _book_period(self):
        """Saldo awal bahan baku Rp10 juta dan WIP Rp3 juta, lalu transaksi periode."""
        self._entry(self.before, self.raw, debit=10_000_000)
        self._entry(self.before, self.wip, debit=3_000_000)
        self._entry(self.date_from, self.purchases, debit=50_000_000)
        self._entry(self.date_from, self.freight, debit=1_000_000)
        self._entry(self.date_from, self.returns, credit=2_000_000)
        self._entry(self.date_from, self.discount, credit=500_000)
        self._entry(self.date_from, self.labor, debit=8_000_000)
        self._entry(self.date_from, self.indirect, debit=3_000_000)
        self._entry(self.date_from, self.power, debit=4_000_000)
        self._entry(self.date_from, self.depreciation, debit=1_500_000)

    def _worksheet(self, **vals):
        return self.env["kompakapps.cogm.worksheet"].create({"date_from": self.date_from, "date_to": self.date_to, **vals})

    def _complete(self, worksheet):
        """Isi opname bahan baku (Rp11 juta) dan WIP (Rp4 juta) lalu tarik buku besar."""
        worksheet.write(
            {
                "opname_ids": [
                    Command.create({"product_id": self.resin.id, "qty": 100.0}),
                    Command.create({"product_id": self.solvent.id, "qty": 40.0}),
                ],
                "wip_ids": [Command.create({"name": "Batch WIP-1", "qty": 100.0, "material_cost": 30000.0, "material_pct": 100.0, "conversion_cost": 20000.0, "completion_pct": 50.0})],
            }
        )
        worksheet.action_pull()
        return worksheet

    def _failing(self, worksheet):
        result = worksheet.action_check()
        return {check["key"] for check in result["checks"] if check["status"] == "error"}

    # ------------------------------------------------------------------ pengaturan

    def test_setup_creates_accounts_config_and_mapping_and_is_idempotent(self):
        config = self.config
        self.assertEqual(len({config.raw_account_id, config.wip_account_id, config.fg_account_id, config.summary_account_id}), 4)
        self.assertEqual(config.journal_id.code, "COGM")
        sections = {m.account_id.code: m.section for m in config.account_ids}
        self.assertEqual(sections["51000020"], "purchase")
        self.assertEqual(sections["51200010"], "labor")
        self.assertEqual(sections["51300020"], "overhead")
        self.assertEqual(sections["51000010"], "excluded", "HPP penjualan bukan biaya produksi")
        before = (self.env["account.account"].search_count([]), len(config.account_ids))
        self.company.kompakapps_setup_cogm()
        self.assertEqual((self.env["account.account"].search_count([]), len(config.account_ids)), before)
        self.assertEqual(self.power_map.pct, 50.0, "Pilihan pengguna tidak ditimpa")
        self.assertEqual(self.purchases.kompakapps_report_group, "pembelian_bahan")
        self.assertEqual(self.freight.kompakapps_report_group, "pembelian_bahan")

    def test_system_account_cannot_be_mapped_as_a_cost_account(self):
        with self.assertRaises(ValidationError):
            self.env["kompakapps.cogm.account"].create({"config_id": self.config.id, "account_id": self.raw.id, "section": "purchase"})

    # ------------------------------------------------------------------ rumus dan jurnal

    def test_cogm_formula_and_balanced_journal(self):
        self._book_period()
        worksheet = self._complete(self._worksheet())
        self.assertEqual(worksheet.rm_opening, 10_000_000)
        self.assertEqual(worksheet.purchases, 48_500_000, "50 juta + angkut 1 juta - retur 2 juta - potongan 0,5 juta")
        self.assertEqual(worksheet.rm_available, 58_500_000)
        self.assertEqual(worksheet.rm_ending, 11_000_000, "100 x 50.000 + 40 x 150.000")
        self.assertEqual(worksheet.rm_used, 47_500_000)
        self.assertEqual(worksheet.direct_labor, 8_000_000)
        self.assertEqual(worksheet.overhead, 6_500_000, "3 juta + listrik 50% x 4 juta + penyusutan 1,5 juta")
        self.assertEqual(worksheet.total_cost, 62_000_000)
        self.assertEqual(worksheet.wip_opening, 3_000_000)
        self.assertEqual(worksheet.wip_ending, 4_000_000, "100 x (30.000 x 100% + 20.000 x 50%)")
        self.assertEqual(worksheet.cogm, 61_000_000)
        result = worksheet.action_check()
        self.assertEqual(result["state"], "green", [c for c in result["checks"] if c["status"] == "error"])
        self.assertEqual(worksheet.control_state, "green")

        worksheet.action_post()
        move = worksheet.move_id
        self.assertEqual((worksheet.state, move.state), ("posted", "posted"))
        self.assertEqual(move.journal_id, self.config.journal_id)
        self.assertEqual(move.date, self.date_to)
        self.assertEqual(sum(move.line_ids.mapped("debit")), sum(move.line_ids.mapped("credit")))
        self.assertEqual(self._balance(self.fg), 61_000_000, "COGM masuk Inventory COGM")
        self.assertEqual(self._balance(self.raw), 11_000_000, "Persediaan bahan baku = hasil opname")
        self.assertEqual(self._balance(self.wip), 4_000_000, "WIP = estimasi akhir")
        self.assertEqual(self._balance(self.summary), 0.0, "Akun ikhtisar kembali nol")
        for account in (self.purchases, self.freight, self.returns, self.discount, self.labor, self.indirect, self.depreciation):
            self.assertEqual(self._balance(account), 0.0, account.display_name)
        self.assertEqual(self._balance(self.power), 2_000_000, "Listrik 50% non-produksi tetap di akun")

    def test_next_period_opens_with_the_closing_balances(self):
        self._book_period()
        first = self._complete(self._worksheet())
        first.action_post()
        next_from = self.date_to + timedelta(days=1)
        next_to = (next_from + timedelta(days=32)).replace(day=1) - timedelta(days=1)
        second = self.env["kompakapps.cogm.worksheet"].create({"date_from": next_from, "date_to": next_to})
        second.action_pull()
        self.assertEqual(second.rm_opening, 11_000_000)
        self.assertEqual(second.wip_opening, 4_000_000)
        self.assertEqual(second.purchases, 0.0)
        self.assertNotIn("period", self._failing(second), "bersambung dengan periode sebelumnya")

    def test_wip_defaults_from_the_bom(self):
        self.env["res.config.settings"].create({"group_mrp_routings": True}).execute()
        finished = self._create_product(name="Barang Jadi COGM", type="consu", standard_price=0.0)
        workcenter = self.env["mrp.workcenter"].create({"name": "Mesin COGM", "costs_hour": 60000.0})
        self.env["mrp.bom"].create(
            {
                "product_tmpl_id": finished.product_tmpl_id.id, "product_qty": 1.0, "product_uom_id": finished.uom_id.id,
                "bom_line_ids": [Command.create({"product_id": self.resin.id, "product_qty": 2.0})],
                "operation_ids": [Command.create({"name": "Filling", "workcenter_id": workcenter.id, "time_cycle_manual": 30.0})],
            }
        )
        material, conversion = self.env["kompakapps.cogm.worksheet"].bom_cost_split(finished.id)
        self.assertEqual((material, conversion), (100000.0, 30000.0), "2 x 50.000 bahan; 30 menit x 60.000 per jam konversi")
        line = self.env["kompakapps.cogm.wip"].create({"worksheet_id": self._worksheet().id, "name": "WIP", "product_id": finished.id, "qty": 10.0, "completion_pct": 40.0})
        self.assertEqual((line.material_cost, line.conversion_cost), (100000.0, 30000.0))
        self.assertEqual(line.value, 10 * (100000.0 + 30000.0 * 0.4))

    # ------------------------------------------------------------------ Control Balance

    def test_check_is_red_until_data_is_pulled_and_goes_stale_when_the_ledger_changes(self):
        self._book_period()
        worksheet = self._worksheet()
        worksheet.write({"opname_ids": [Command.create({"product_id": self.resin.id, "qty": 100.0})]})
        self.assertIn("fresh", self._failing(worksheet), "belum ditarik")
        worksheet.action_pull()
        self.assertNotIn("fresh", self._failing(worksheet))
        self._entry(self.date_from + timedelta(days=1), self.labor, debit=1_000_000)
        self.assertIn("fresh", self._failing(worksheet), "buku besar berubah setelah ditarik")
        worksheet.action_pull()
        self.assertEqual(worksheet.direct_labor, 9_000_000)
        self.assertNotIn("fresh", self._failing(worksheet))

    def test_unclassified_cost_account_turns_red_until_mapped(self):
        self._book_period()
        worksheet = self._complete(self._worksheet())
        stray = self.env["account.account"].with_company(self.company).create({"code": "51400001", "name": "Biaya Lain 51", "account_type": "expense_direct_cost", "company_ids": [Command.link(self.company.id)]})
        self._entry(self.date_from + timedelta(days=2), stray, debit=700_000)
        self.assertIn("unmapped", self._failing(worksheet))
        self.env["kompakapps.cogm.account"].create({"config_id": self.config.id, "account_id": stray.id, "section": "overhead"})
        worksheet.action_pull()
        self.assertEqual(worksheet.overhead, 7_200_000)
        self.assertEqual(self._failing(worksheet), set())

    def test_inventory_account_movement_during_the_period_turns_red(self):
        self._book_period()
        worksheet = self._complete(self._worksheet())
        self._entry(self.date_from + timedelta(days=3), self.raw, debit=1_000_000)
        worksheet.action_pull()
        self.assertEqual(self._failing(worksheet), {"inventory"})

    def test_ending_value_above_available_turns_red(self):
        self._book_period()
        worksheet = self._complete(self._worksheet())
        worksheet.opname_ids.filtered(lambda line: line.product_id == self.solvent).qty = 1000.0  # salah ketik: 40 menjadi 1000
        failing = self._failing(worksheet)
        self.assertIn("usage", failing)
        self.assertIn("cogm", failing)
        with self.assertRaises(UserError):
            worksheet.action_post()
        self.assertFalse(worksheet.move_id)
        self.assertEqual(worksheet.state, "draft")

    def test_quantity_without_unit_cost_turns_red(self):
        self._book_period()
        worksheet = self._complete(self._worksheet())
        worksheet.opname_ids[0].unit_cost = 0.0
        self.assertIn("cost", self._failing(worksheet))
        worksheet.opname_ids[0].unit_cost = 50000.0
        worksheet.wip_ids.write({"material_cost": 0.0, "conversion_cost": 0.0})
        self.assertIn("cost", self._failing(worksheet))

    def test_missing_opname_turns_red_when_material_is_available(self):
        self._book_period()
        worksheet = self._worksheet()
        worksheet.action_pull()
        self.assertIn("opname", self._failing(worksheet))

    def test_physical_count_is_compared_with_the_system_stock(self):
        self._book_period()
        stocked = self._create_product(name="Bahan Berlacak COGM", type="consu", is_storable=True, standard_price=10000.0, taxes_id=[Command.clear()], supplier_taxes_id=[Command.clear()])
        location = self.env["stock.warehouse"].search([("company_id", "=", self.company.id)], limit=1).lot_stock_id
        self.env["stock.quant"].with_context(inventory_mode=True).create({"product_id": stocked.id, "location_id": location.id, "inventory_quantity": 100.0}).action_apply_inventory()
        worksheet = self._worksheet()
        worksheet.write({"opname_ids": [Command.create({"product_id": stocked.id, "qty": 101.0})]})
        worksheet.action_pull()
        line = worksheet.opname_ids
        self.assertEqual(line.book_qty, 100.0)
        self.assertEqual(line.unit_cost, 10000.0, "biaya awal dari produk")
        self.assertEqual((line.variance_qty, line.variance_value), (1.0, 10000.0))
        self.assertNotIn("variance", self._failing(worksheet), "1% di dalam toleransi 2%")
        line.qty = 1000.0  # salah ketik
        self.assertIn("variance", self._failing(worksheet))
        line.explanation = "Penerimaan bahan belum dicatat di sistem"
        self.assertNotIn("variance", self._failing(worksheet), "selisih besar sudah dijelaskan")
        line.write({"explanation": False, "qty": 50.0})
        self.assertIn("variance", self._failing(worksheet), "kurang dari stok sistem pun harus dijelaskan")

    def test_overlapping_posted_period_turns_red(self):
        self._book_period()
        first = self._complete(self._worksheet())
        first.action_post()
        second = self._complete(self._worksheet())
        self.assertIn("period", self._failing(second))
        with self.assertRaises(UserError):
            second.action_post()

    # ------------------------------------------------------------------ penguncian, pembatalan, dan akses

    def test_posted_worksheet_is_locked_and_reverse_restores_the_ledger(self):
        self._book_period()
        worksheet = self._complete(self._worksheet())
        worksheet.action_post()
        with self.assertRaises(UserError):
            worksheet.opname_ids[0].qty = 5.0
        with self.assertRaises(UserError):
            worksheet.write({"date_to": self.date_from})
        with self.assertRaises(UserError):
            worksheet.unlink()
        with self.assertRaises(UserError):
            worksheet.action_cancel()
        original = worksheet.move_id
        worksheet.action_reverse()
        self.assertEqual(worksheet.state, "draft")
        self.assertFalse(worksheet.move_id)
        self.assertEqual(len(worksheet.move_ids), 2, "jurnal asli dan pembaliknya tetap tercatat")
        self.assertIn(original, worksheet.move_ids)
        self.assertEqual(self._balance(self.fg), 0.0)
        self.assertEqual(self._balance(self.raw), 10_000_000)
        self.assertEqual(self._balance(self.wip), 3_000_000)
        self.assertEqual(self._balance(self.purchases), 50_000_000)
        worksheet.action_pull()
        self.assertEqual(worksheet.cogm, 61_000_000, "angka sama karena jurnal pembalik ikut menetralkan")
        worksheet.action_post()
        self.assertEqual(self._balance(self.fg), 61_000_000)

    def test_cancel_and_draft_cycle(self):
        worksheet = self._worksheet()
        worksheet.action_cancel()
        self.assertEqual(worksheet.state, "cancel")
        with self.assertRaises(UserError):
            worksheet.write({"opname_ids": [Command.create({"product_id": self.resin.id, "qty": 1.0})]})
        worksheet.action_draft()
        self.assertEqual(worksheet.state, "draft")
        worksheet.unlink()

    def test_duplicate_product_on_the_count_sheet_is_refused(self):
        worksheet = self._worksheet()
        worksheet.write({"opname_ids": [Command.create({"product_id": self.resin.id, "qty": 1.0})]})
        with self.assertRaises(Exception), self.cr.savepoint(), mute_logger("odoo.sql_db"):  # galat SQL ini memang diharapkan; CI menolak baris ERROR di log
            worksheet.write({"opname_ids": [Command.create({"product_id": self.resin.id, "qty": 2.0})]})

    def test_warehouse_staff_count_but_only_accounting_pulls_and_executes(self):
        self._book_period()
        staff = new_test_user(self.env, login="petugas_cogm", groups="base.group_user,stock.group_stock_user")
        worksheet = self.env["kompakapps.cogm.worksheet"].with_user(staff).create({"date_from": self.date_from, "date_to": self.date_to})
        worksheet.write({"opname_ids": [Command.create({"product_id": self.resin.id, "qty": 100.0})]})
        self.assertEqual(worksheet.opname_ids.value, 5_000_000)
        with self.assertRaises(AccessError):
            worksheet.action_pull()
        with self.assertRaises(AccessError):
            worksheet.action_post()
        with self.assertRaises(AccessError):
            self.config.with_user(staff).write({"tolerance_pct": 50.0})
        accountant = new_test_user(self.env, login="akuntan_cogm", groups="base.group_user,account.group_account_user")
        worksheet.with_user(accountant).action_pull()
        self.assertEqual(worksheet.rm_opening, 10_000_000)

    def test_ledger_data_is_taken_per_company(self):
        other = self.env["res.company"].create({"name": "PT Cabang COGM"})
        other.kompakapps_setup_indonesia()
        other.kompakapps_setup_cogm()
        self._book_period()
        self.env.user.write({"company_ids": [Command.link(other.id)]})
        sheet = self.env["kompakapps.cogm.worksheet"].with_company(other).create({"company_id": other.id, "date_from": self.date_from, "date_to": self.date_to})
        sheet.action_pull()
        self.assertEqual((sheet.rm_opening, sheet.purchases, sheet.direct_labor), (0.0, 0.0, 0.0))
        self.assertNotEqual(sheet._config(), self.config)

    def test_worksheets_are_only_visible_in_their_own_company(self):
        other = self.env["res.company"].create({"name": "PT Cabang Terpisah COGM"})
        other.kompakapps_setup_indonesia()
        other.kompakapps_setup_cogm()
        self.env.user.write({"company_ids": [Command.link(other.id)]})
        mine = self._worksheet()
        theirs = self.env["kompakapps.cogm.worksheet"].with_company(other).create({"company_id": other.id, "date_from": self.date_from, "date_to": self.date_to})
        theirs.write({"opname_ids": [Command.create({"product_id": self.resin.id, "qty": 1.0})]})
        Worksheet = self.env["kompakapps.cogm.worksheet"]
        in_a = Worksheet.with_context(allowed_company_ids=[self.company.id]).search([])
        in_b = Worksheet.with_context(allowed_company_ids=[other.id]).search([])
        self.assertIn(mine, in_a)
        self.assertNotIn(theirs, in_a)
        self.assertIn(theirs, in_b)
        self.assertNotIn(mine, in_b)
        self.assertFalse(self.env["kompakapps.cogm.opname"].with_context(allowed_company_ids=[self.company.id]).search([("worksheet_id", "=", theirs.id)]))
        self.assertEqual(self.env["kompakapps.cogm.config"].with_context(allowed_company_ids=[other.id]).search([]).company_id, other)
