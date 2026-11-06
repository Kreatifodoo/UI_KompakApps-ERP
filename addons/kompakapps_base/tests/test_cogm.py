from datetime import datetime, time, timedelta

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
        cls.cogs = cls.config.cogs_account_id
        cls.kit_a = cls._create_product(name="Kit Reagen A COGM", standard_price=0.0, **common)
        cls.kit_b = cls._create_product(name="Kit Reagen B COGM", standard_price=0.0, **common)

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
                "output_ids": [Command.create({"product_id": self.kit_a.id, "qty": 600.0}), Command.create({"product_id": self.kit_b.id, "qty": 400.0})],
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

    def test_draft_worksheet_is_deleted_with_its_content_but_not_one_that_was_ever_journaled(self):
        self._book_period()
        draft = self._complete(self._worksheet())
        content = [draft.line_ids, draft.opname_ids, draft.wip_ids, draft.output_ids]
        self.assertTrue(all(content))
        draft.unlink()
        self.assertFalse(draft.exists())
        self.assertFalse(any(records.exists() for records in content), "isi kertas kerja ikut terhapus")
        cancelled = self._worksheet()
        cancelled.action_cancel()
        cancelled.unlink()
        self.assertFalse(cancelled.exists())
        reversed_ = self._complete(self._worksheet())
        reversed_.action_post()
        reversed_.action_reverse()
        self.assertEqual(reversed_.state, "draft")
        with self.assertRaises(UserError) as caught:
            reversed_.unlink()
        self.assertIn("jejak audit", str(caught.exception))
        self.assertTrue(reversed_.exists() and len(reversed_.move_ids) == 2, "jurnal asli dan pembaliknya tetap ada")

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

    # ------------------------------------------------------------------ biaya rata-rata tertimbang dan penyesuaian stok (Q66)

    def _storable(self, name, cost=10000.0, **extra):
        return self._create_product(name=name, type="consu", is_storable=True, standard_price=cost, taxes_id=[Command.clear()], supplier_taxes_id=[Command.clear()], **extra)

    def _stock(self, product, qty, day):
        """Stok awal lewat penyesuaian stok bertanggal `day` (riwayat stok pada akhir hari itu memuatnya)."""
        location = self.env["stock.warehouse"].search([("company_id", "=", self.company.id)], limit=1).lot_stock_id
        known = self.env["stock.move"].search([("product_id", "=", product.id)]).ids
        self.env["stock.quant"].with_context(inventory_mode=True).create({"product_id": product.id, "location_id": location.id, "inventory_quantity": qty}).action_apply_inventory()
        moves = self.env["stock.move"].search([("product_id", "=", product.id), ("id", "not in", known)])
        moves.write({"date": datetime.combine(day, time(3, 0))})
        moves.move_line_ids.write({"date": datetime.combine(day, time(3, 0))})

    def _bill(self, product, qty, price, day, refund=False):
        self.env["account.move"].create(
            {
                "move_type": "in_refund" if refund else "in_invoice", "partner_id": self.partner_a.id, "invoice_date": day, "date": day,
                "invoice_line_ids": [Command.create({"product_id": product.id, "quantity": qty, "price_unit": price, "account_id": self.purchases.id, "tax_ids": [Command.clear()]})],
            }
        ).action_post()

    def _priced_product(self):
        """Bahan berlacak stok: 100 unit awal @10.000, beli 50 @12.000 dan 50 @14.000, retur 10 @14.000 pada periode."""
        product = self._storable("Bahan Rata-rata COGM")
        self._stock(product, 100.0, self.before)
        self._bill(product, 50.0, 12000.0, self.date_from)
        self._bill(product, 50.0, 14000.0, self.date_from + timedelta(days=1))
        self._bill(product, 10.0, 14000.0, self.date_from + timedelta(days=2), refund=True)
        return product

    def test_weighted_average_cost_from_opening_stock_and_period_purchases(self):
        product = self._priced_product()
        worksheet = self._worksheet()
        worksheet.write({"opname_ids": [Command.create({"product_id": product.id, "qty": 150.0})]})
        worksheet.action_pull()
        line = worksheet.opname_ids
        self.assertEqual((line.opening_qty, line.opening_cost), (100.0, 10000.0))
        self.assertEqual((line.purchase_qty, line.purchase_value), (90.0, 1_160_000.0), "100 dibeli dikurangi retur 10; 1.300.000 dikurangi retur 140.000")
        self.assertEqual(line.avg_cost, 11368.42, "(100 x 10.000 + 1.160.000) / 190")
        self.assertEqual((line.unit_cost, line.cost_source), (11368.42, "average"))
        self.assertEqual(line.value, round(150 * 11368.42))
        line.unit_cost = 13000.0
        self.assertEqual(line.cost_source, "manual", "biaya yang diubah petugas ditandai manual")
        worksheet.action_pull()
        self.assertEqual((line.unit_cost, line.cost_source, line.avg_cost), (13000.0, "manual", 11368.42), "tarik ulang tidak menimpa biaya manual")
        line.action_reset_cost()
        self.assertEqual((line.unit_cost, line.cost_source), (11368.42, "average"))

    def test_standard_method_and_untracked_products_use_the_product_cost(self):
        product = self._priced_product()
        self.config.cost_method = "standard"
        worksheet = self._worksheet()
        worksheet.write({"opname_ids": [Command.create({"product_id": product.id, "qty": 10.0}), Command.create({"product_id": self.resin.id, "qty": 1.0})]})
        self.assertEqual(set(worksheet.opname_ids.mapped("cost_source")), {"standard"})
        self.assertEqual(worksheet.opname_ids.filtered(lambda line: line.product_id == product).unit_cost, 10000.0)
        self.config.cost_method = "average"
        worksheet.action_pull()
        by_product = {line.product_id: line for line in worksheet.opname_ids}
        self.assertEqual((by_product[product].unit_cost, by_product[product].cost_source), (11368.42, "average"))
        self.assertEqual((by_product[self.resin].unit_cost, by_product[self.resin].cost_source), (50000.0, "standard"), "stok tidak dilacak: tidak ada jumlah awal untuk dirata-ratakan")

    def test_next_period_opens_at_the_cost_of_the_previous_closing(self):
        product = self._priced_product()
        self._book_period()
        first = self._complete(self._worksheet())
        first.write({"opname_ids": [Command.create({"product_id": product.id, "qty": 100.0, "explanation": "contoh"})]})
        first.action_pull()
        first.action_post()
        self.assertEqual(self._standard_price(product), 11368.42)
        second = self.env["kompakapps.cogm.worksheet"].create({"date_from": self.date_to + timedelta(days=1), "date_to": self.date_to + timedelta(days=28)})
        second.write({"opname_ids": [Command.create({"product_id": product.id, "qty": 1.0})]})
        self.assertEqual(second.opname_ids.opening_cost, 11368.42, "biaya akhir periode sebelumnya")

    def _standard_price(self, product):
        return product.with_company(self.company).standard_price

    def test_execute_updates_product_cost_and_adjusts_stock_and_reverse_restores_both(self):
        self._book_period()
        product = self._priced_product()
        worksheet = self._complete(self._worksheet())
        worksheet.write({"opname_ids": [Command.create({"product_id": product.id, "qty": 95.0, "explanation": "Susut penyimpanan"})]})
        worksheet.action_pull()
        line = worksheet.opname_ids.filtered(lambda line: line.product_id == product)
        self.assertEqual((line.book_qty, line.variance_qty), (100.0, -5.0))
        result = worksheet.action_check()
        self.assertEqual(result["state"], "green", [c for c in result["checks"] if c["status"] == "error"])
        adjust = next(c for c in result["checks"] if c["key"] == "adjust")
        self.assertEqual(adjust["status"], "info", adjust)
        moves_before = self.env["account.move"].search_count([("company_id", "=", self.company.id)])

        worksheet.action_post()
        self.assertEqual(self.env["account.move"].search_count([("company_id", "=", self.company.id)]), moves_before + 1, "penyesuaian stok periodik tidak membuat jurnal")
        self.assertEqual(self._standard_price(product), 11368.42, "biaya produk = rata-rata tertimbang periode")
        self.assertEqual(product.qty_available, 95.0, "stok sistem disamakan dengan hasil opname")
        cutoff = worksheet._cutoff()
        self.assertEqual(product.with_context(to_date=cutoff).qty_available, 95.0, "bertanggal akhir periode")
        self.assertEqual((line.adjust_qty, line.old_cost, line.cost_updated), (-5.0, 10000.0, True))
        self.assertEqual(line.adjust_move_ids.mapped("date"), [cutoff] * len(line.adjust_move_ids))
        self.assertEqual(self._balance(self.raw), round(11_000_000 + 95 * 11368.42, 2), "persediaan bahan baku = nilai opname semua baris")

        worksheet.action_reverse()
        self.assertEqual(worksheet.state, "draft")
        self.assertEqual(self._standard_price(product), 10000.0, "biaya produk dikembalikan")
        self.assertEqual(product.qty_available, 100.0, "penyesuaian stok dikembalikan")
        self.assertEqual((line.adjust_qty, line.cost_updated), (0.0, False))
        worksheet.action_pull()
        self.assertEqual(line.book_qty, 100.0)
        worksheet.action_post()
        self.assertEqual(product.qty_available, 95.0, "eksekusi ulang menyesuaikan lagi")

    def test_switches_turn_off_cost_update_and_stock_adjustment(self):
        self._book_period()
        product = self._priced_product()
        self.config.write({"update_product_cost": False, "adjust_stock": False})
        worksheet = self._complete(self._worksheet())
        worksheet.write({"opname_ids": [Command.create({"product_id": product.id, "qty": 95.0, "explanation": "Susut"})]})
        worksheet.action_pull()
        worksheet.action_post()
        self.assertEqual(self._standard_price(product), 10000.0)
        self.assertEqual(product.qty_available, 100.0)
        self.assertFalse(worksheet.opname_ids.adjust_move_ids)

    def test_lot_tracked_products_are_not_adjusted_automatically(self):
        self._book_period()
        tracked = self._storable("Bahan Berlot COGM", tracking="lot")
        worksheet = self._complete(self._worksheet())
        worksheet.write({"opname_ids": [Command.create({"product_id": tracked.id, "qty": 3.0, "explanation": "Hitungan awal"})]})
        worksheet.action_pull()
        result = worksheet.action_check()
        adjust = next(c for c in result["checks"] if c["key"] == "adjust")
        self.assertEqual(adjust["status"], "warn")
        self.assertIn("lot", adjust["message"])
        worksheet.action_post()
        self.assertEqual(worksheet.opname_ids.filtered(lambda line: line.product_id == tracked).adjust_qty, 0.0)

    def test_manual_adjustment_after_the_period_is_flagged(self):
        self._book_period()
        product = self._priced_product()
        worksheet = self._complete(self._worksheet())
        worksheet.write({"opname_ids": [Command.create({"product_id": product.id, "qty": 100.0})]})
        worksheet.action_pull()
        self._stock(product, 100.0, self.date_to)  # penyesuaian manual yang tidak mengubah jumlah, bertanggal di akhir periode: bukan peringatan
        self._stock(product, 99.0, self.date_to + timedelta(days=1))
        result = worksheet.action_check()
        adjust = next(c for c in result["checks"] if c["key"] == "adjust")
        self.assertEqual(adjust["status"], "warn")
        self.assertIn("manual", adjust["message"])

    # ------------------------------------------------------------------ HPP per unit: total biaya aktual dibagi qty yang diproduksi (Q67)

    def test_unit_cost_is_the_total_actual_cost_divided_by_the_produced_qty(self):
        self._book_period()
        worksheet = self._complete(self._worksheet())
        self.assertEqual(worksheet.cogm, 61_000_000)
        self.assertEqual(worksheet.qty_produced, 1000.0)
        self.assertEqual(worksheet.unit_cogm, 61_000.0, "COGM 61 juta dibagi 1.000 unit")
        self.assertEqual(
            (worksheet.unit_material, worksheet.unit_labor, worksheet.unit_overhead, worksheet.unit_wip), (47_500.0, 8_000.0, 6_500.0, -1_000.0),
            "bahan terpakai, tenaga kerja, overhead, dan perubahan WIP per unit",
        )
        self.assertEqual(sum([worksheet.unit_material, worksheet.unit_labor, worksheet.unit_overhead, worksheet.unit_wip]), worksheet.unit_cogm)
        by_product = {line.product_id: line.cogm_value for line in worksheet.output_ids}
        self.assertEqual(by_product, {self.kit_a: 36_600_000, self.kit_b: 24_400_000})
        self.assertEqual(sum(by_product.values()), worksheet.cogm)
        self.assertEqual(worksheet.action_check()["state"], "green")

    def test_missing_produced_qty_turns_red_and_blocks_execute(self):
        self._book_period()
        worksheet = self._complete(self._worksheet())
        worksheet.output_ids.unlink()
        self.assertEqual((worksheet.qty_produced, worksheet.unit_cogm), (0.0, 0.0))
        self.assertEqual(self._failing(worksheet), {"output"})
        with self.assertRaises(UserError):
            worksheet.action_post()
        worksheet.write({"output_ids": [Command.create({"product_id": self.kit_a.id, "qty": 0.0})]})
        self.assertEqual(self._failing(worksheet), {"output"}, "qty nol sama dengan belum diisi")
        worksheet.output_ids.qty = 250.0
        self.assertEqual(worksheet.unit_cogm, 244_000.0)
        self.assertEqual(self._failing(worksheet), set())

    def test_produced_qty_is_pulled_from_finished_manufacturing_orders_and_manual_edits_stay(self):
        self.env.user.write({"group_ids": [Command.link(self.env.ref("mrp.group_mrp_manager").id)]})
        finished = self._create_product(name="Barang Jadi MO COGM", type="consu", standard_price=0.0, taxes_id=[Command.clear()], supplier_taxes_id=[Command.clear()])
        bom = self.env["mrp.bom"].create({"product_tmpl_id": finished.product_tmpl_id.id, "product_qty": 1.0, "product_uom_id": finished.uom_id.id})
        production = self.env["mrp.production"].create({"product_id": finished.id, "product_qty": 5.0, "bom_id": bom.id})
        production.action_confirm()
        production.qty_producing = 5.0
        production.button_mark_done()
        self.assertEqual(production.state, "done")
        worksheet = self._worksheet()
        worksheet.action_pull()
        line = worksheet.output_ids
        self.assertEqual((line.product_id, line.mo_qty, line.qty, line.source), (finished, 5.0, 5.0, "mo"))
        line.qty = 6.0
        self.assertEqual(line.source, "manual", "qty yang diubah petugas ditandai manual")
        worksheet.action_pull()
        self.assertEqual((line.mo_qty, line.qty, line.source), (5.0, 6.0, "manual"), "tarik ulang tidak menimpa qty manual")

    # ------------------------------------------------------------------ HPP penjualan periodik dan penyesuaian barang yang laku (Q68)

    def _deliver(self, product, qty, day):
        """Pengiriman ke pelanggan (barang laku) bertanggal `day`."""
        stock = self.env["stock.warehouse"].search([("company_id", "=", self.company.id)], limit=1).lot_stock_id
        move = self.env["stock.move"].create(
            {
                "product_id": product.id, "product_uom_qty": qty, "product_uom": product.uom_id.id, "location_id": stock.id,
                "location_dest_id": self.env.ref("stock.stock_location_customers").id, "company_id": self.company.id,
            }
        )
        move._action_confirm()
        move._action_assign()
        move.write({"quantity": qty, "picked": True})
        move._action_done()
        move.write({"date": datetime.combine(day, time(3, 0))})
        move.move_line_ids.write({"date": datetime.combine(day, time(3, 0))})

    def _provisional_cogs(self, product, amount, day):
        """HPP sementara yang dibukukan saat penjualan: Dr HPP, Cr Inventory COGM, bertanda produk."""
        self.env["account.move"].create(
            {
                "move_type": "entry", "journal_id": self.misc.id, "date": day,
                "line_ids": [
                    Command.create({"account_id": self.cogs.id, "debit": amount, "credit": 0.0, "product_id": product.id}),
                    Command.create({"account_id": self.fg.id, "debit": 0.0, "credit": amount, "product_id": product.id}),
                ],
            }
        ).action_post()

    def _sold_kit(self):
        """Barang jadi: stok awal 10 @80.000, produksi 1.000 unit, terjual 400 unit sebelum COGM dihitung dengan HPP sementara Rp60.000 per unit."""
        kit = self._storable("Barang Jadi HPP COGM", cost=80000.0)
        self._stock(kit, 10.0, self.before)
        self._entry(self.before, self.fg, debit=800_000)
        self._stock(kit, 1010.0, self.date_from + timedelta(days=1))
        self._deliver(kit, 400.0, self.date_from + timedelta(days=5))
        self._provisional_cogs(kit, 24_000_000.0, self.date_from + timedelta(days=5))
        return kit

    def _fg_worksheet(self, kit):
        worksheet = self._complete(self._worksheet())
        worksheet.output_ids.unlink()
        worksheet.write({"output_ids": [Command.create({"product_id": kit.id, "qty": 1000.0})]})
        worksheet.action_pull()
        return worksheet

    def test_cogs_is_trued_up_for_goods_already_sold_and_the_cost_carries_forward(self):
        self._book_period()
        kit = self._sold_kit()
        worksheet = self._fg_worksheet(kit)
        line = worksheet.fg_ids
        self.assertEqual((line.opening_qty, line.opening_cost, line.delivered_qty, line.provisional_cogs), (10.0, 80000.0, 400.0, 24_000_000.0))
        self.assertEqual((line.produced_qty, line.produced_value), (1000.0, 61_000_000.0), "seluruh COGM periode ini")
        self.assertEqual((line.available_qty, line.available_value), (1010.0, 61_800_000.0))
        self.assertEqual(line.unit_cost, 61188.12, "(800.000 + 61.000.000) / 1.010")
        self.assertEqual(line.book_qty, 610.0)
        line.qty = 605.0  # hitung fisik: susut 5 unit
        self.assertEqual((line.sold_qty, line.ending_value, line.cogs), (405.0, 37_018_812.6, 24_781_187.4))
        self.assertEqual(line.cogs_adjustment, 781_187.4, "HPP aktual 24.781.187,40 dikurangi HPP sementara 24.000.000")
        self.assertEqual((worksheet.fg_cogs, worksheet.fg_provisional, worksheet.fg_adjustment), (24_781_187.4, 24_000_000.0, 781_187.4))
        self.assertEqual(line.cost_before, 60000.0, "HPP sementara 24.000.000 / 400 unit terkirim")
        self.assertEqual((line.stock_value_before, line.stock_adjustment), (36_300_000.0, 718_812.6), "605 x 60.000 sebelum; 37.018.812,60 sesudah")
        self.assertEqual(worksheet.fg_stock_adjustment, 718_812.6)
        result = worksheet.action_check()
        self.assertEqual(result["state"], "green", [c for c in result["checks"] if c["status"] == "error"])
        self.assertEqual(next(c for c in result["checks"] if c["key"] == "cogs")["status"], "ok")
        self.assertNotIn("fg_gl", {c["key"] for c in result["checks"]}, "saldo awal Inventory COGM Rp800.000 sama dengan nilai barang jadi awal")

        worksheet.action_post()
        self.assertEqual(self._balance(self.cogs), 24_781_187.4, "HPP sementara + penyesuaian = HPP aktual")
        self.assertEqual(self._balance(self.fg), 37_018_812.6, "Inventory COGM = nilai stok akhir (605 x 61.188,12)")
        self.assertEqual(self._standard_price(kit), 61188.12, "biaya barang jadi diperbarui untuk penjualan berikutnya")
        self.assertEqual(kit.qty_available, 605.0, "stok sistem disamakan dengan hitung fisik")

        second = self.env["kompakapps.cogm.worksheet"].create({"date_from": self.date_to + timedelta(days=1), "date_to": self.date_to + timedelta(days=28)})
        basis = second._fg_basis(kit)
        self.assertEqual((basis["opening_qty"], basis["opening_cost"]), (605.0, 61188.12), "periode berikutnya dibuka pada biaya akhir periode ini")

        worksheet.action_reverse()
        self.assertEqual(self._balance(self.cogs), 24_000_000.0, "tinggal HPP sementara")
        self.assertEqual(self._standard_price(kit), 80000.0)
        self.assertEqual(kit.qty_available, 610.0)

    def test_finished_goods_checks_turn_red(self):
        self._book_period()
        kit = self._sold_kit()
        worksheet = self._fg_worksheet(kit)
        self.assertEqual(self._failing(worksheet), set())
        self._provisional_cogs(kit, 1_000_000.0, self.date_from + timedelta(days=6))  # HPP sementara baru setelah data ditarik
        self.assertIn("cogs", self._failing(worksheet))
        worksheet.action_pull()
        self.assertEqual(worksheet.fg_provisional, 25_000_000.0)
        self.assertEqual(self._failing(worksheet), set())
        worksheet.fg_ids.qty = 2000.0  # salah ketik: melebihi stok awal + produksi
        failing = self._failing(worksheet)
        self.assertIn("cogs", failing)
        self.assertIn("fg_variance", failing)
        with self.assertRaises(UserError):
            worksheet.action_post()

    def test_without_a_cogs_account_the_adjustment_is_not_journaled(self):
        self._book_period()
        kit = self._sold_kit()
        self.config.cogs_account_id = False
        worksheet = self._fg_worksheet(kit)
        worksheet.fg_ids.qty = 605.0
        cogs = next(c for c in worksheet.action_check()["checks"] if c["key"] == "cogs")
        self.assertEqual(cogs["status"], "warn")
        worksheet.action_post()
        self.assertEqual(self._balance(self.cogs), 24_000_000.0, "hanya HPP sementara")

    def test_cogm_allocation_to_finished_goods_adds_up_exactly(self):
        self._book_period()
        worksheet = self._complete(self._worksheet())
        kit_c = self._create_product(name="Kit Reagen C COGM", type="consu", standard_price=0.0, taxes_id=[Command.clear()], supplier_taxes_id=[Command.clear()])
        worksheet.output_ids.unlink()
        worksheet.write({"output_ids": [Command.create({"product_id": product.id, "qty": 1.0}) for product in (self.kit_a, self.kit_b, kit_c)]})
        self.assertEqual(sum(worksheet.output_ids.mapped("cogm_value")), worksheet.cogm, "sisa pembulatan masuk baris terbesar")

    def test_opening_balance_of_the_finished_goods_account_that_does_not_match_the_stock_is_flagged(self):
        self._book_period()
        kit = self._sold_kit()
        self._entry(self.before, self.fg, debit=5_000_000)  # COGM bulan lalu yang barang jadinya tidak dilacak
        worksheet = self._fg_worksheet(kit)
        check = next(c for c in worksheet.action_check()["checks"] if c["key"] == "fg_gl")
        self.assertEqual(check["status"], "warn")
        self.assertIn("5.000.000", check["message"])


    def test_sold_quantity_that_differs_from_the_deliveries_is_a_warning(self):
        self._book_period()
        kit = self._sold_kit()
        worksheet = self._fg_worksheet(kit)
        worksheet.fg_ids.qty = 610.0  # terjual 400 sama dengan pengiriman
        self.assertNotIn("fg_sold", {c["key"] for c in worksheet.action_check()["checks"]})
        worksheet.output_ids.qty = 950.0  # qty diproduksi lebih kecil dari yang diterima gudang: terjual hasil hitungan 350 vs terkirim 400
        check = next(c for c in worksheet.action_check()["checks"] if c["key"] == "fg_sold")
        self.assertEqual(check["status"], "warn")
        self.assertIn("350", check["message"])
