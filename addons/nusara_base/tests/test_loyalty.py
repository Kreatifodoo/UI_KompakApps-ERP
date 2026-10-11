from odoo import Command, fields
from odoo.addons.account.tests.common import AccountTestInvoicingCommon
from odoo.exceptions import ValidationError
from odoo.tests import tagged
from odoo.tools import mute_logger

# program_type harus ikut dalam daftar field: default_get hanya mengisi nilai bawaan tipe bila field itu diminta.
PROGRAM_FIELDS = ["program_type", "applies_on", "trigger", "portal_visible", "portal_point_name"]


@tagged("post_install", "-at_install", "nusara")
class TestLoyalty(AccountTestInvoicingCommon):
    """Promotion & Loyalty (D30): program, aturan, hadiah, dan penerapannya pada Sales Order.

    Memakai panggilan yang sama dengan UI Nusara (wizard `sale.loyalty.coupon.wizard` dan
    `sale.loyalty.reward.wizard`, tombol `action_open_reward_wizard`), karena metode privat seperti
    `_try_apply_code` tidak bisa dipanggil lewat JSON-2.
    """

    @classmethod
    @AccountTestInvoicingCommon.setup_country("id")
    def setUpClass(cls):
        super().setUpClass()
        cls.env.user.write(
            {"group_ids": [Command.link(cls.env.ref("sales_team.group_sale_manager").id)]}
        )
        cls.company = cls.env.company
        cls.company.nusara_setup_inventory_valuation()
        cls.goods = cls.env.ref("product.product_category_goods").with_company(cls.company)
        cls.warehouse = cls.env["stock.warehouse"].search(
            [("company_id", "=", cls.company.id)], limit=1
        )
        cls.customer = cls.env["res.partner"].create(
            {"name": "PT Pelanggan Promo", "is_company": True, "customer_rank": 1}
        )
        cls.other_customer = cls.env["res.partner"].create(
            {"name": "CV Pelanggan Lain", "is_company": True, "customer_rank": 1}
        )
        cls.product = cls._create_product(
            name="Barang Promo",
            type="consu",
            is_storable=True,
            categ_id=cls.goods.id,
            standard_price=100000.0,
            list_price=150000.0,
            taxes_id=cls.company_data["default_tax_sale"],
        )
        quant = (
            cls.env["stock.quant"]
            .with_context(inventory_mode=True)
            .create(
                {
                    "product_id": cls.product.id,
                    "location_id": cls.warehouse.lot_stock_id.id,
                    "inventory_quantity": 50.0,
                }
            )
        )
        quant.action_apply_inventory()
        # Program bawaan Odoo (kartu hadiah) tidak ikut campur, dan program lain tidak boleh
        # mengubah hitungan uji karena promosi otomatis berlaku untuk semua pesanan.
        cls.env["loyalty.program"].search([]).action_archive()

    # ----- pembantu -----

    def _defaults(self, program_type):
        """Nilai bawaan Odoo menurut tipe program, seperti yang dipakai halaman UI saat membuat program."""
        return self.env["loyalty.program"].with_context(default_program_type=program_type).default_get(PROGRAM_FIELDS)

    def _program(self, program_type, rules, rewards, **values):
        vals = {
            "name": f"Program {program_type}",
            "program_type": program_type,
            "sale_ok": True,
            "pos_ok": False,
            **self._defaults(program_type),
            "rule_ids": [Command.create(rule) for rule in rules],
            "reward_ids": [Command.create(reward) for reward in rewards],
            **values,
        }
        return self.env["loyalty.program"].create(vals)

    def _order(self, qty=2.0, partner=None):
        return self.env["sale.order"].create(
            {
                "partner_id": (partner or self.customer).id,
                "order_line": [Command.create({"product_id": self.product.id, "product_uom_qty": qty})],
            }
        )

    def _apply_code(self, order, code):
        wizard = (
            self.env["sale.loyalty.coupon.wizard"]
            .with_context(active_model="sale.order", active_id=order.id)
            .create({"order_id": order.id, "coupon_code": code})
        )
        return wizard.action_apply()

    def _claimable(self, order):
        wizard = (
            self.env["sale.loyalty.reward.wizard"]
            .with_context(active_model="sale.order", active_id=order.id)
            .create({"order_id": order.id})
        )
        return wizard.reward_ids

    def _claim(self, order, reward, product=None):
        wizard = (
            self.env["sale.loyalty.reward.wizard"]
            .with_context(active_model="sale.order", active_id=order.id)
            .create({"order_id": order.id, "selected_reward_id": reward.id, "selected_product_id": product.id if product else False})
        )
        return wizard.action_apply()

    def _reward_lines(self, order):
        return order.order_line.filtered("reward_id")

    def _assert_balanced(self, move):
        self.assertAlmostEqual(
            sum(move.line_ids.mapped("debit")), sum(move.line_ids.mapped("credit")), places=2
        )

    def _invoice(self, order):
        order.action_confirm()
        invoice = order._create_invoices()
        invoice.action_post()
        self._assert_balanced(invoice)
        self.assertAlmostEqual(invoice.amount_total, order.amount_total, places=2)
        return invoice

    # ----- program -----

    def test_default_values_follow_program_type(self):
        """default_get memberi pemicu dan masa berlaku poin menurut tipe; UI memakainya saat membuat program."""
        expected = {
            "promotion": ("auto", "current"),
            "promo_code": ("with_code", "current"),
            "buy_x_get_y": ("auto", "current"),
            "coupons": ("with_code", "current"),
            "next_order_coupons": ("auto", "future"),
            "loyalty": ("auto", "both"),
            "gift_card": ("auto", "future"),
            "ewallet": ("auto", "future"),
        }
        for program_type, (trigger, applies_on) in expected.items():
            values = self._defaults(program_type)
            self.assertEqual((values["trigger"], values["applies_on"]), (trigger, applies_on), program_type)

    def test_program_without_explicit_trigger_loses_it(self):
        """Temuan D30: program yang dibuat lewat API dengan aturan dan hadiah eksplisit tidak mendapat `trigger`
        otomatis, jadi UI harus mengirim nilai bawaan tipe (trigger, applies_on, portal_*) sendiri."""
        program = self.env["loyalty.program"].create(
            {
                "name": "Tanpa pemicu",
                "program_type": "promo_code",
                "rule_ids": [Command.create({"mode": "with_code", "code": "TANPAPEMICU", "minimum_qty": 0})],
                "reward_ids": [Command.create({"discount": 10, "discount_mode": "percent", "discount_applicability": "order"})],
            }
        )
        self.assertFalse(program.trigger)
        program.write(self._defaults("promo_code"))
        self.assertEqual(program.trigger, "with_code")

    def test_program_needs_at_least_one_reward(self):
        program = self._program("coupons", [], [{"discount": 10, "discount_mode": "percent", "discount_applicability": "order"}])
        self.assertEqual(len(program.reward_ids), 1)
        with self.assertRaises(ValidationError):
            program.reward_ids.unlink()
        with self.assertRaises(ValidationError):
            self.env["loyalty.program"].create({"name": "Kosong", "program_type": "promotion", "reward_ids": [Command.clear()]})

    def test_rule_and_reward_edit_through_commands(self):
        """Aturan dan hadiah diubah lewat perintah one2many, seperti yang dikirim form UI."""
        program = self._program(
            "promotion",
            [{"minimum_amount": 100000.0, "minimum_qty": 0, "minimum_amount_tax_mode": "excl"}],
            [{"discount": 5, "discount_mode": "percent", "discount_applicability": "order", "required_points": 1}],
        )
        rule, reward = program.rule_ids, program.reward_ids
        program.write(
            {
                "rule_ids": [Command.update(rule.id, {"minimum_amount": 250000.0})],
                "reward_ids": [Command.update(reward.id, {"discount": 12.5}), Command.create({"discount": 20000.0, "discount_mode": "per_order", "discount_applicability": "order", "required_points": 2})],
            }
        )
        self.assertEqual(program.rule_ids.minimum_amount, 250000.0)
        self.assertEqual(len(program.reward_ids), 2)
        self.assertEqual(reward.discount, 12.5)
        # Memilih deskripsi sendiri tidak dihapus Odoo selama kolom pembentuknya tidak berubah.
        reward.write({"description": "Diskon Lebaran"})
        self.assertEqual(reward.description, "Diskon Lebaran")
        self.assertEqual(reward.discount_line_product_id.name, "Diskon Lebaran")
        # Temuan D30: pada perintah update one2many di program, deskripsi yang disebut sebelum kolom pembentuknya (di sini discount) dihitung
        # ulang oleh Odoo; urutan terbalik lolos. UI menulis deskripsi sebagai langkah kedua supaya tidak bergantung pada urutan kunci.
        program.write({"reward_ids": [Command.update(reward.id, {"description": "Diskon 20% Lebaran", "discount": 20.0})]})
        self.assertNotEqual(reward.description, "Diskon 20% Lebaran")
        reward.write({"description": "Diskon 20% Lebaran"})
        self.assertEqual(reward.description, "Diskon 20% Lebaran")
        program.action_archive()
        self.assertFalse(program.rule_ids.active or program.reward_ids.active, "Arsip program ikut mengarsipkan aturan dan hadiah")

    # ----- kode promo -----

    def test_promo_code_discount_on_sale_order_and_invoice(self):
        program = self._program(
            "promo_code",
            [{"mode": "with_code", "code": "HEMAT10", "minimum_qty": 0}],
            [{"reward_type": "discount", "discount_mode": "percent", "discount": 10, "discount_applicability": "order", "required_points": 1}],
        )
        order = self._order(qty=2.0)
        self.assertEqual(order.amount_total, 333000.0)
        action = self._apply_code(order, "HEMAT10")
        self.assertEqual(action["res_model"], "sale.loyalty.reward.wizard")
        self.assertEqual(action["context"]["default_reward_ids"], program.reward_ids.ids)
        self.assertFalse(self._reward_lines(order), "Kode saja belum menambah baris; hadiah dipilih lewat wizard hadiah")
        self.assertEqual(self._claimable(order), program.reward_ids)

        self._claim(order, program.reward_ids)
        line = self._reward_lines(order)
        self.assertEqual(len(line), 1)
        self.assertEqual(line.price_unit, -30000.0)
        self.assertEqual(line.points_cost, 1.0)
        self.assertEqual(order.amount_untaxed, 270000.0)
        self.assertEqual(order.amount_total, 299700.0)
        self.assertEqual(order.reward_amount, -30000.0)

        invoice = self._invoice(order)
        self.assertEqual(invoice.amount_untaxed, 270000.0)
        self.assertEqual(invoice.amount_tax, 29700.0)
        receivable = invoice.line_ids.filtered(lambda move_line: move_line.account_id.account_type == "asset_receivable")
        self.assertEqual(sum(receivable.mapped("debit")), 299700.0)
        # Satu pemakaian tercatat pada program.
        self.assertEqual(program.order_count, 1)
        self.assertEqual(program.total_order_count, 1)

    def test_invalid_and_repeated_codes_are_rejected(self):
        program = self._program(
            "promo_code",
            [{"mode": "with_code", "code": "SEKALI5", "minimum_qty": 0}],
            [{"reward_type": "discount", "discount_mode": "per_order", "discount": 5000.0, "discount_applicability": "order", "required_points": 1}],
        )
        order = self._order()
        with self.assertRaisesRegex(ValidationError, "invalid"):
            self._apply_code(order, "TIDAKADA")
        self._apply_code(order, "SEKALI5")
        self._claim(order, program.reward_ids)
        with self.assertRaisesRegex(ValidationError, "already applied"):
            self._apply_code(order, "SEKALI5")
        self.assertEqual(len(self._reward_lines(order)), 1)

    def test_code_must_be_unique_between_programs(self):
        self._program("promo_code", [{"mode": "with_code", "code": "KEMBAR", "minimum_qty": 0}], [{"discount": 10, "discount_mode": "percent"}])
        with self.assertRaisesRegex(ValidationError, "unique"):
            self._program("promo_code", [{"mode": "with_code", "code": "KEMBAR", "minimum_qty": 0}], [{"discount": 5, "discount_mode": "percent"}])

    def test_validity_dates_and_usage_limit(self):
        today = fields.Date.today()
        yesterday = fields.Date.subtract(today, days=1)
        tomorrow = fields.Date.add(today, days=1)
        reward = {"discount": 10, "discount_mode": "percent", "discount_applicability": "order"}
        self._program("promo_code", [{"mode": "with_code", "code": "KEMARIN", "minimum_qty": 0}], [reward], date_to=yesterday)
        self._program("promo_code", [{"mode": "with_code", "code": "BESOK", "minimum_qty": 0}], [reward], date_from=tomorrow)
        for code in ("KEMARIN", "BESOK"):
            with self.assertRaisesRegex(ValidationError, "invalid"):
                self._apply_code(self._order(), code)

        limited = self._program(
            "promo_code", [{"mode": "with_code", "code": "TERBATAS", "minimum_qty": 0}], [reward], limit_usage=True, max_usage=1
        )
        order = self._order()
        self._apply_code(order, "TERBATAS")
        self._claim(order, limited.reward_ids)
        order.action_confirm()
        limited.invalidate_recordset()
        self.assertEqual(limited.total_order_count, 1)
        with self.assertRaisesRegex(ValidationError, "expired"):
            self._apply_code(self._order(), "TERBATAS")
        with mute_logger("odoo.sql_db"), self.assertRaises(Exception):
            self.env["loyalty.program"].create({"name": "Batas nol", "limit_usage": True, "max_usage": 0, "reward_ids": [Command.create({})]})

    def test_archived_program_code_is_invalid(self):
        program = self._program(
            "promo_code", [{"mode": "with_code", "code": "ARSIP", "minimum_qty": 0}], [{"discount": 10, "discount_mode": "percent"}]
        )
        program.action_archive()
        with self.assertRaisesRegex(ValidationError, "invalid"):
            self._apply_code(self._order(), "ARSIP")
        program.action_unarchive()
        self.assertTrue(program.rule_ids.active and program.reward_ids.active)
        self._apply_code(self._order(), "ARSIP")

    # ----- promosi otomatis -----

    def test_automatic_promotion_follows_order_amount(self):
        program = self._program(
            "promotion",
            [{"reward_point_mode": "order", "reward_point_amount": 1, "minimum_amount": 200000.0, "minimum_qty": 0, "minimum_amount_tax_mode": "excl"}],
            [{"discount": 15, "discount_mode": "percent", "discount_applicability": "order", "required_points": 1}],
        )
        order = self._order(qty=2.0)
        self.assertFalse(self._reward_lines(order))
        self.assertIs(order.action_open_reward_wizard(), True, "Satu hadiah langsung diterapkan tanpa dialog")
        self.assertEqual(self._reward_lines(order).price_unit, -45000.0)
        self.assertEqual(order.amount_untaxed, 255000.0)
        self.assertEqual(order.reward_amount, -45000.0)

        # Jumlah dikurangi di bawah syarat: pembaruan menghapus hadiahnya.
        order.order_line.filtered(lambda line: not line.reward_id).product_uom_qty = 1.0
        order.action_open_reward_wizard()
        self.assertFalse(self._reward_lines(order))
        self.assertEqual(order.amount_untaxed, 150000.0)
        self.assertFalse(order.coupon_point_ids)

        order.order_line.filtered(lambda line: not line.reward_id).product_uom_qty = 3.0
        order.action_open_reward_wizard()
        self.assertEqual(self._reward_lines(order).price_unit, -67500.0)
        # Hadiah ikut dibawa sampai faktur.
        invoice = self._invoice(order)
        self.assertEqual(invoice.amount_untaxed, 382500.0)
        self.assertEqual(program.order_count, 1)

    def test_discount_for_specific_and_cheapest_products(self):
        other = self._create_product(name="Barang Murah", type="consu", list_price=20000.0, taxes_id=self.company_data["default_tax_sale"])
        program = self._program(
            "promotion",
            [{"reward_point_mode": "order", "reward_point_amount": 1, "minimum_amount": 0.0, "minimum_qty": 1}],
            [
                {
                    "discount": 10000.0, "discount_mode": "per_order", "discount_applicability": "specific",
                    "discount_product_ids": [Command.set(self.product.ids)], "required_points": 1,
                },
            ],
        )
        order = self._order(qty=1.0)
        order.write({"order_line": [Command.create({"product_id": other.id, "product_uom_qty": 2.0})]})
        order.action_open_reward_wizard()
        line = self._reward_lines(order)
        self.assertEqual(len(line), 1)
        # Rp 10.000 sudah termasuk PPN 11%: dasar pengenaan pajak 9.009,01.
        self.assertAlmostEqual(line.price_subtotal, -9009.01, places=2)
        program.reward_ids.write(
            {"discount": 50, "discount_mode": "percent", "discount_applicability": "cheapest", "discount_product_ids": [Command.clear()]}
        )
        order.action_open_reward_wizard()
        lines = self._reward_lines(order)
        self.assertEqual(sum(lines.mapped("price_subtotal")), -10000.0, "50% dari barang termurah (satu unit Rp 20.000)")

    # ----- buy X get Y -----

    def test_buy_x_get_y_gives_free_product(self):
        program = self._program(
            "buy_x_get_y",
            [{"reward_point_mode": "unit", "reward_point_amount": 1, "product_ids": [Command.set(self.product.ids)], "minimum_qty": 2}],
            [{"reward_type": "product", "reward_product_id": self.product.id, "reward_product_qty": 1, "required_points": 3}],
        )
        order = self._order(qty=3.0)
        self.assertIs(order.action_open_reward_wizard(), True)
        free = self._reward_lines(order)
        self.assertEqual(len(free), 1)
        self.assertEqual(free.product_id, self.product)
        self.assertEqual(free.product_uom_qty, 1.0)
        self.assertEqual(free.discount, 100.0)
        self.assertEqual(free.price_subtotal, 0.0)
        self.assertEqual(order.amount_untaxed, 450000.0, "3 dibeli, 1 gratis di atas: tetap membayar 3 unit")
        self.assertEqual(order.reward_amount, -150000.0)
        invoice = self._invoice(order)
        self.assertEqual(invoice.amount_untaxed, 450000.0)
        # Pengiriman memuat unit gratisnya juga (3 dibeli + 1 hadiah).
        self.assertEqual(sum(order.picking_ids.move_ids.mapped("product_uom_qty")), 4.0)
        self.assertEqual(program.order_count, 1)

    # ----- kupon -----

    def test_generated_coupons_are_single_use(self):
        program = self._program(
            "coupons",
            [],
            [{"discount": 25000.0, "discount_mode": "per_order", "discount_applicability": "order", "required_points": 1}],
        )
        wizard = self.env["loyalty.generate.wizard"].with_context(active_id=program.id).create(
            {"program_id": program.id, "mode": "anonymous", "coupon_qty": 2, "points_granted": 1}
        )
        coupons = wizard.generate_coupons()
        self.assertEqual(len(coupons), 2)
        self.assertEqual(program.coupon_count, 2)
        self.assertEqual(set(coupons.mapped("points")), {1.0})
        code = coupons[0].code

        order = self._order()
        action = self._apply_code(order, code)
        self.assertEqual(action["context"]["default_reward_ids"], program.reward_ids.ids)
        self._claim(order, program.reward_ids)
        line = self._reward_lines(order)
        self.assertAlmostEqual(line.price_total, -25000.0, places=2, msg="Rp 25.000 sudah termasuk pajak")
        self.assertEqual(order.amount_total, 308000.0)
        self.assertEqual(coupons[0].points, 1.0, "Poin baru berkurang saat pesanan dikonfirmasi")
        self._invoice(order)
        self.assertEqual(coupons[0].points, 0.0)
        self.assertEqual(coupons[1].points, 1.0)
        coupons[0].invalidate_recordset()
        self.assertEqual(sum(coupons[0].history_ids.mapped("used")), 1.0)

        with self.assertRaisesRegex(ValidationError, "already been used"):
            self._apply_code(self._order(), code)

        # Membatalkan pesanan mengembalikan poin kupon dan membuang hadiahnya.
        order.action_cancel()
        self.assertEqual(coupons[0].points, 1.0)
        self.assertFalse(self._reward_lines(order))

    def test_named_coupons_reserve_for_customer_and_expire(self):
        program = self._program(
            "coupons", [], [{"discount": 10, "discount_mode": "percent", "discount_applicability": "order", "required_points": 1}]
        )
        yesterday = fields.Date.subtract(fields.Date.today(), days=1)
        wizard = self.env["loyalty.generate.wizard"].with_context(active_id=program.id).create(
            {"program_id": program.id, "mode": "selected", "customer_ids": [Command.set(self.customer.ids)], "points_granted": 1, "valid_until": yesterday}
        )
        expired = wizard.generate_coupons()
        self.assertEqual(expired.partner_id, self.customer)
        with self.assertRaisesRegex(ValidationError, "expired"):
            self._apply_code(self._order(), expired.code)

    # ----- kartu loyalti -----

    def test_loyalty_card_accumulates_points_and_pays_rewards(self):
        program = self._program(
            "loyalty",
            [{"reward_point_mode": "money", "reward_point_amount": 0.001}],
            [{"reward_type": "discount", "discount_mode": "per_order", "discount": 10000.0, "discount_applicability": "order", "required_points": 100}],
            portal_point_name="Poin",
        )
        first = self._order(qty=2.0)
        first.action_open_reward_wizard()
        card = program.coupon_ids
        self.assertEqual(len(card), 1)
        self.assertEqual(card.partner_id, self.customer)
        # 1 poin per Rp 1.000 dari total 333.000 = 333 poin; sudah cukup untuk satu hadiah pada pesanan ini juga (applies_on both).
        self.assertEqual(first.coupon_point_ids.points, 333.0)
        self.assertEqual(len(self._reward_lines(first)), 1)
        first.action_confirm()
        self.assertEqual(card.points, 233.0, "333 diterima, 100 dipakai")
        self.assertEqual(card.history_ids.mapped("issued"), [333.0])
        self.assertEqual(card.history_ids.mapped("used"), [100.0])
        self.assertEqual(first.loyalty_data["issued"], 333.0)

        # Pesanan berikutnya memuat kartu pelanggan yang sama otomatis; pelanggan lain mendapat kartu sendiri.
        second = self._order(qty=1.0)
        second.action_open_reward_wizard()
        self.assertEqual(program.coupon_count, 1)
        self.assertEqual(second.applied_coupon_ids, card)
        second.action_confirm()
        self.assertEqual(card.points, 233.0 + 166.5 - 100.0, "166,5 poin baru, hadiah dipakai lagi")

        third = self._order(qty=1.0, partner=self.other_customer)
        third.action_confirm()
        other_card = program.coupon_ids.filtered(lambda c: c.partner_id == self.other_customer)
        self.assertTrue(other_card)
        self.assertEqual(other_card.points, 166.5)

        # Saldo diubah manual lewat wizard (dengan catatan riwayat).
        wizard = self.env["loyalty.card.update.balance"].create({"card_id": card.id, "new_balance": 500.0, "description": "Koreksi"})
        wizard.action_update_card_point()
        self.assertEqual(card.points, 500.0)
        self.assertEqual(card.history_ids.filtered(lambda h: h.description == "Koreksi").issued, 500.0 - 299.5)

    def test_next_order_coupon_is_issued_on_confirmation(self):
        program = self._program(
            "next_order_coupons",
            [{"minimum_amount": 200000.0, "minimum_qty": 0, "minimum_amount_tax_mode": "excl"}],
            [{"reward_type": "discount", "discount_mode": "percent", "discount": 15, "discount_applicability": "order", "required_points": 1}],
        )
        small = self._order(qty=1.0)
        small.action_confirm()
        self.assertFalse(program.coupon_ids, "Di bawah syarat: tidak ada kupon")
        order = self._order(qty=2.0)
        order.action_open_reward_wizard()
        self.assertTrue(order.coupon_point_ids)
        order.action_confirm()
        coupon = program.coupon_ids
        self.assertEqual(len(coupon), 1)
        self.assertEqual((coupon.partner_id, coupon.order_id, coupon.points), (self.customer, order, 1.0))
        # Kupon tidak bisa dipakai pada pesanan yang membuatnya, tetapi bisa pada pesanan berikutnya.
        nxt = self._order(qty=2.0)
        self._apply_code(nxt, coupon.code)
        self._claim(nxt, program.reward_ids)
        self.assertEqual(self._reward_lines(nxt).price_unit, -45000.0)

    def test_gift_card_program_uses_default_template(self):
        """Tipe kartu hadiah dan e-wallet memakai produk pemicu dan hadiah tetap dari default_get."""
        for program_type in ("gift_card", "ewallet"):
            program = self._program(
                program_type,
                [{"reward_point_mode": "money", "reward_point_amount": 1, "minimum_qty": 0}],
                [{"reward_type": "discount", "discount_mode": "per_point", "discount": 1, "discount_applicability": "order", "required_points": 1, "description": program_type}],
            )
            self.assertTrue(program.is_payment_program)
            self.assertEqual(program.payment_program_discount_product_id, program.reward_ids.discount_line_product_id)
        wizard = self.env["loyalty.generate.wizard"].with_context(active_id=program.id).create(
            {"program_id": program.id, "mode": "selected", "customer_ids": [Command.set(self.customer.ids)], "points_granted": 50000.0}
        )
        wallet = wizard.generate_coupons()
        order = self._order(qty=1.0)
        self.assertIs(order.action_open_reward_wizard(), True, "Satu-satunya hadiah langsung dipakai")
        self.assertEqual(order.applied_coupon_ids, wallet, "E-wallet pelanggan dimuat otomatis")
        self.assertEqual(self._reward_lines(order).coupon_id, wallet)
        self.assertAlmostEqual(order.amount_total, 166500.0 - 50000.0, places=2)
        self._invoice(order)
        self.assertEqual(wallet.points, 0.0, "Saldo e-wallet terpakai habis")

    # ----- jurnal -----

    def test_journals_stay_balanced_with_stacked_promotions(self):
        """Diskon global hanya boleh satu, tetapi diskon produk tertentu bisa menumpuk; faktur dan jurnal tetap seimbang."""
        auto = self._program(
            "promotion",
            [{"reward_point_mode": "order", "reward_point_amount": 1, "minimum_amount": 100000.0, "minimum_qty": 0, "minimum_amount_tax_mode": "excl"}],
            [{"discount": 10, "discount_mode": "percent", "discount_applicability": "order", "required_points": 1}],
        )
        global_code = self._program(
            "promo_code",
            [{"mode": "with_code", "code": "GLOBAL20RB", "minimum_qty": 0}],
            [{"discount": 20000.0, "discount_mode": "per_order", "discount_applicability": "order", "required_points": 1}],
        )
        product_code = self._program(
            "promo_code",
            [{"mode": "with_code", "code": "BARANG20RB", "minimum_qty": 0}],
            [{
                "discount": 20000.0, "discount_mode": "per_order", "discount_applicability": "specific",
                "discount_product_ids": [Command.set(self.product.ids)], "required_points": 1,
            }],
        )
        order = self._order(qty=3.0)
        order.action_open_reward_wizard()
        self.assertEqual(self._reward_lines(order).reward_id, auto.reward_ids)
        with self.assertRaisesRegex(ValidationError, "not compatible"):
            self._apply_code(order, "GLOBAL20RB")
        self.assertEqual(len(self._reward_lines(order)), 1)

        self._apply_code(order, "BARANG20RB")
        self._claim(order, product_code.reward_ids)
        order.action_open_reward_wizard()
        self.assertEqual(self._reward_lines(order).reward_id, auto.reward_ids | product_code.reward_ids)
        self.assertGreater(abs(order.reward_amount), 45000.0)
        invoice = self._invoice(order)
        self.assertEqual(invoice.amount_untaxed, order.amount_untaxed)
        for move in self.env["account.move"].search([("state", "=", "posted"), ("id", ">=", invoice.id)]):
            self._assert_balanced(move)
        self.assertEqual(global_code.order_count, 0)


@tagged("post_install", "-at_install", "nusara")
class TestLoyaltyPos(AccountTestInvoicingCommon):
    """Program di kasir POS (D30): program mana yang berlaku untuk stasiun, dan pesanan dengan baris hadiah seperti yang dikirim UI kasir."""

    @classmethod
    @AccountTestInvoicingCommon.setup_country("id")
    def setUpClass(cls):
        super().setUpClass()
        cls.env.user.write(
            {
                "group_ids": [
                    Command.link(cls.env.ref("point_of_sale.group_pos_manager").id),
                    Command.link(cls.env.ref("stock.group_stock_manager").id),
                    Command.link(cls.env.ref("sales_team.group_sale_manager").id),
                ]
            }
        )
        cls.company = cls.env.company
        cls.company.nusara_setup_inventory_valuation()
        cls.goods = cls.env.ref("product.product_category_goods").with_company(cls.company)
        cls.tax = cls.company_data["default_tax_sale"]
        cls.product = cls._create_product(
            name="Barang Kasir Promo",
            type="consu",
            is_storable=True,
            categ_id=cls.goods.id,
            standard_price=100000.0,
            list_price=150000.0,
            available_in_pos=True,
            taxes_id=[Command.set(cls.tax.ids)],
        )
        warehouse = cls.env["stock.warehouse"].search([("company_id", "=", cls.company.id)], limit=1)
        quant = (
            cls.env["stock.quant"]
            .with_context(inventory_mode=True)
            .create(
                {
                    "product_id": cls.product.id,
                    "location_id": warehouse.lot_stock_id.id,
                    "inventory_quantity": 50.0,
                }
            )
        )
        quant.action_apply_inventory()
        cls.cash = cls.env["pos.payment.method"].create(
            {"name": "Tunai Kasir Promo", "journal_id": cls.company_data["default_journal_cash"].id}
        )
        cls.config = cls.env["pos.config"].create(
            {"name": "Kasir Promo Uji", "payment_method_ids": [Command.set(cls.cash.ids)], "cash_control": True}
        )
        # Metode tunai hanya boleh dipakai satu stasiun, jadi stasiun lain memakai metode bank.
        bank = cls.env["pos.payment.method"].create(
            {"name": "Transfer Kasir Promo", "journal_id": cls.company_data["default_journal_bank"].id}
        )
        cls.other_config = cls.env["pos.config"].create({"name": "Kasir Lain", "payment_method_ids": [Command.set(bank.ids)]})
        cls.env["loyalty.program"].search([]).action_archive()

    def _program(self, name, program_type, trigger, rules, rewards, **values):
        return self.env["loyalty.program"].create(
            {
                "name": name,
                "program_type": program_type,
                "trigger": trigger,
                "applies_on": "current",
                "sale_ok": False,
                "pos_ok": True,
                "rule_ids": [Command.create(rule) for rule in rules],
                "reward_ids": [Command.create(reward) for reward in rewards],
                **values,
            }
        )

    def _discount(self, **values):
        return {
            "reward_type": "discount",
            "discount_mode": "percent",
            "discount": 10,
            "discount_applicability": "order",
            "required_points": 1,
            **values,
        }

    def test_programs_for_station_follow_dates_stations_and_scope(self):
        today = fields.Date.today()
        rule = [{"reward_point_mode": "order", "reward_point_amount": 1, "minimum_qty": 0}]
        valid = self._program("Berlaku", "promotion", "auto", rule, [self._discount()])
        self._program(
            "Kedaluwarsa", "promotion", "auto", rule, [self._discount()], date_to=fields.Date.subtract(today, days=1)
        )
        self._program(
            "Belum mulai", "promotion", "auto", rule, [self._discount()], date_from=fields.Date.add(today, days=1)
        )
        other = self._program(
            "Stasiun lain", "promotion", "auto", rule, [self._discount()], pos_config_ids=[Command.set(self.other_config.ids)]
        )
        here = self._program(
            "Stasiun ini", "promotion", "auto", rule, [self._discount()], pos_config_ids=[Command.set(self.config.ids)]
        )
        sales_only = self._program(
            "Hanya Sales Order", "promotion", "auto", rule, [self._discount()], pos_ok=False, sale_ok=True
        )
        programs = self.config._get_program_ids()
        self.assertEqual(programs, valid | here)
        self.assertEqual(self.other_config._get_program_ids(), valid | other)
        self.assertNotIn(sales_only, programs)

    def test_order_with_reward_lines_counts_usage_and_closes_session_balanced(self):
        promo = self._program(
            "Diskon 10%",
            "promotion",
            "auto",
            [
                {
                    "reward_point_mode": "order",
                    "reward_point_amount": 1,
                    "minimum_amount": 100000.0,
                    "minimum_amount_tax_mode": "excl",
                    "minimum_qty": 0,
                }
            ],
            [self._discount(description="10% untuk seluruh pesanan")],
        )
        code = self._program(
            "Kode KOPI5",
            "promo_code",
            "with_code",
            [{"mode": "with_code", "code": "KOPI5", "minimum_qty": 0}],
            [
                self._discount(
                    discount=5000.0,
                    discount_mode="per_order",
                    discount_applicability="specific",
                    discount_product_ids=[Command.set(self.product.ids)],
                )
            ],
            limit_usage=True,
            max_usage=1,
        )
        free = self._program(
            "Beli 3 Gratis 1",
            "buy_x_get_y",
            "auto",
            [
                {
                    "reward_point_mode": "unit",
                    "reward_point_amount": 1,
                    "product_ids": [Command.set(self.product.ids)],
                    "minimum_qty": 3,
                }
            ],
            [{"reward_type": "product", "reward_product_id": self.product.id, "reward_product_qty": 1, "required_points": 3}],
        )
        self.assertEqual(self.config._get_program_ids(), promo | code | free)
        session = self.env["pos.session"].create({"config_id": self.config.id, "user_id": self.env.user.id})
        session.set_opening_control(100000.0, "Modal awal")

        # Nilai seperti yang dihitung kasir: 3 x 150.000, diskon 10% (45.000), diskon Rp5.000 termasuk pajak, dan 1 unit gratis.
        # Total memakai pembulatan pajak global perusahaan; menjumlah total per baris membuat jurnal sesi selisih satu sen.
        self.assertEqual(self.company.tax_calculation_rounding_method, "round_globally")
        discount_excl = self.tax.with_context(force_price_include=True).compute_all(5000.0)["total_excluded"]
        excl = 450000.0 - 45000.0 - discount_excl
        total = self.tax.compute_all(excl)["total_included"]
        now = fields.Datetime.now()
        reward_lines = [
            (promo.reward_ids, -45000.0, 0.0, promo.reward_ids.discount_line_product_id, 1.0),
            (code.reward_ids, -discount_excl, 0.0, code.reward_ids.discount_line_product_id, 1.0),
            (free.reward_ids, self.product.lst_price, 100.0, self.product, 3.0),
        ]
        lines = [
            Command.create(
                {
                    "uuid": "baris-barang",
                    "product_id": self.product.id,
                    "qty": 3.0,
                    "price_unit": 150000.0,
                    "discount": 0.0,
                    "tax_ids": [Command.set(self.tax.ids)],
                    "price_subtotal": 450000.0,
                    "price_subtotal_incl": 499500.0,
                    "full_product_name": self.product.name,
                    "name": self.product.name,
                }
            )
        ]
        for index, (reward, price, discount, product, cost) in enumerate(reward_lines):
            lines.append(
                Command.create(
                    {
                        "uuid": f"baris-hadiah-{index}",
                        "product_id": product.id,
                        "qty": 1.0,
                        "price_unit": price,
                        "discount": discount,
                        "tax_ids": [Command.set(self.tax.ids)],
                        "price_subtotal": 0.0 if discount else price,
                        "price_subtotal_incl": 0.0 if discount else price * 1.11,
                        "full_product_name": reward.description,
                        "name": reward.description,
                        "is_reward_line": True,
                        "reward_id": reward.id,
                        "reward_identifier_code": f"kode-{index}",
                        "points_cost": cost,
                    }
                )
            )
        payload = {
            "name": "Order Promo",
            "uuid": "order-promo",
            "session_id": session.id,
            "config_id": self.config.id,
            "user_id": self.env.user.id,
            "sequence_number": 1,
            "date_order": str(now),
            "amount_tax": total - excl,
            "amount_total": total,
            "amount_paid": total,
            "amount_return": 0.0,
            "partner_id": False,
            "to_invoice": False,
            "pricelist_id": False,
            "fiscal_position_id": False,
            "lines": lines,
            "payment_ids": [Command.create({"payment_method_id": self.cash.id, "amount": total, "name": str(now)})],
        }
        result = self.env["pos.order"].sync_from_ui([payload])
        order = self.env["pos.order"].browse(result["pos.order"][0]["id"])
        self.assertEqual(order.state, "paid")
        self.assertEqual(order.amount_total, total)
        self.assertEqual(
            order.lines.filtered("is_reward_line").mapped("reward_id"), promo.reward_ids | code.reward_ids | free.reward_ids
        )
        # Pemakaian program dihitung dari baris hadiah; batas pemakaian kode (maks 1) membuat programnya lepas dari stasiun.
        for program in (promo, code, free):
            program.invalidate_recordset()
            self.assertEqual((program.pos_order_count, program.total_order_count), (1, 1), program.name)
        self.assertEqual(promo | free, self.config._get_program_ids())

        session.post_closing_cash_details(100000.0 + total)
        session.update_closing_control_state_session("Penutupan promo")
        closed = session.close_session_from_ui([])
        self.assertTrue(closed["successful"], closed)
        self.assertEqual(session.state, "closed")
        for move in session.move_id | session.statement_line_ids.move_id:
            self.assertAlmostEqual(sum(move.line_ids.mapped("debit")), sum(move.line_ids.mapped("credit")), places=2)
        # Unit gratis tetap keluar dari stok: 3 dibeli + 1 hadiah.
        moves = order.picking_ids.move_ids.filtered(lambda move: move.product_id == self.product)
        self.assertEqual(sum(moves.mapped("quantity")), 4.0)
