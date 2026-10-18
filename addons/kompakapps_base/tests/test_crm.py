from odoo import Command
from odoo.addons.account.tests.common import AccountTestInvoicingCommon
from odoo.tests import tagged


@tagged("post_install", "-at_install", "kompakapps")
class TestCrmPipeline(AccountTestInvoicingCommon):
    """Lead, opportunity, tahap pipeline, menang dan kalah, quotation, dan aktivitas (D21)."""

    @classmethod
    @AccountTestInvoicingCommon.setup_country("id")
    def setUpClass(cls):
        super().setUpClass()
        cls.env.user.write(
            {
                "group_ids": [
                    Command.link(cls.env.ref("sales_team.group_sale_manager").id),
                    Command.link(cls.env.ref("sales_team.group_sale_salesman_all_leads").id),
                ]
            }
        )
        cls.stages = cls.env["crm.stage"].search([], order="sequence, id")
        cls.service = cls._create_product(name="Jasa Implementasi", type="service", list_price=10_000_000.0)

    def _opportunity(self, **values):
        return self.env["crm.lead"].create({"name": "Proyek ERP", "type": "opportunity", "expected_revenue": 50_000_000.0, **values})

    def test_opportunity_moves_through_stages_to_won(self):
        lead = self._opportunity(partner_name="PT Maju", contact_name="Budi", email_from="budi@maju.test")
        self.assertEqual(lead.stage_id, self.stages[0], "Opportunity baru masuk tahap pertama")
        self.assertEqual(lead.won_status, "pending")
        lead.write({"stage_id": self.stages[1].id})
        self.assertEqual(lead.stage_id, self.stages[1])
        lead.action_set_won()
        self.assertEqual((lead.won_status, lead.probability), ("won", 100.0))
        self.assertTrue(lead.stage_id.is_won)
        self.assertTrue(lead.date_closed)

    def test_lost_opportunity_is_archived_with_reason_and_can_be_restored(self):
        reason = self.env["crm.lost.reason"].create({"name": "Harga terlalu tinggi"})
        lead = self._opportunity()
        lead.action_set_lost(lost_reason_id=reason.id)
        self.assertFalse(lead.active)
        self.assertEqual((lead.won_status, lead.lost_reason_id), ("lost", reason))
        lost_domain = [("type", "=", "opportunity"), ("active", "=", False), ("probability", "=", 0)]
        self.assertIn(lead, self.env["crm.lead"].with_context(active_test=False).search(lost_domain), "Filter Kalah di UI menemukannya")
        lead.toggle_active()
        self.assertTrue(lead.active)
        self.assertEqual(lead.won_status, "pending")

    def test_lead_converts_to_opportunity_and_gets_a_customer(self):
        self.env["res.config.settings"].create({"group_use_lead": True}).execute()
        lead = self.env["crm.lead"].create({"name": "Lead Website", "type": "lead", "partner_name": "CV Baru", "contact_name": "Sari", "email_from": "info@baru.test"})
        self.assertEqual(lead.type, "lead")
        lead.convert_opportunity(partner=False)
        self.assertEqual(lead.type, "opportunity")
        # Seperti UI: pelanggan dibuat dari kontak lead lalu dihubungkan.
        partner = self.env["res.partner"].create({"name": lead.partner_name, "is_company": True, "email": lead.email_from, "customer_rank": 1})
        lead.partner_id = partner
        self.assertEqual(lead.partner_id.name, "CV Baru")
        self.assertIn(lead, self.env["crm.lead"].search([("type", "=", "opportunity"), ("partner_name", "ilike", "baru")]))

    def test_quotation_from_opportunity_counts_confirmed_sales(self):
        partner = self.env["res.partner"].create({"name": "PT Quote", "customer_rank": 1})
        lead = self._opportunity(partner_id=partner.id)
        order = self.env["sale.order"].create(
            {"partner_id": partner.id, "opportunity_id": lead.id, "order_line": [Command.create({"product_id": self.service.id, "product_uom_qty": 2.0})]}
        )
        self.assertEqual((lead.quotation_count, lead.order_ids), (1, order))
        self.assertEqual(lead.sale_amount_total, 0.0, "Belum dikonfirmasi: belum dihitung sebagai penjualan")
        order.action_confirm()
        self.assertEqual(lead.sale_amount_total, order.amount_untaxed)
        self.assertEqual(lead.won_status, "pending", "Odoo 19 tidak memenangkan opportunity otomatis saat SO dikonfirmasi; tombol Menang dipakai")
        lead.action_set_won()
        self.assertEqual(lead.won_status, "won")

    def test_activities_are_scheduled_and_completed(self):
        lead = self._opportunity()
        call_type = self.env.ref("mail.mail_activity_data_call")
        activity = self.env["mail.activity"].create(
            {
                "res_model_id": self.env["ir.model"]._get_id("crm.lead"),
                "res_id": lead.id,
                "activity_type_id": call_type.id,
                "summary": "Telepon klien",
                "date_deadline": "2999-01-01",
                "user_id": self.env.user.id,
            }
        )
        found = self.env["mail.activity"].search([("res_model", "=", "crm.lead"), ("res_id", "=", lead.id)])
        self.assertEqual(found, activity)
        self.assertEqual(found.state, "planned")
        activity.action_feedback(feedback="Sudah dihubungi")
        self.assertFalse(self.env["mail.activity"].search([("res_model", "=", "crm.lead"), ("res_id", "=", lead.id)]))
        self.assertIn("Sudah dihubungi", lead.message_ids[0].body)

    def test_stage_and_tag_settings(self):
        stage = self.env["crm.stage"].create({"name": "Negosiasi", "sequence": 15})
        stage.write({"name": "Negosiasi Akhir", "is_won": False})
        tag = self.env["crm.tag"].create({"name": "Prioritas Q4"})
        lead = self._opportunity(stage_id=stage.id, tag_ids=[Command.set(tag.ids)])
        self.assertEqual((lead.stage_id, lead.tag_ids), (stage, tag))
        lead.unlink()
        stage.unlink()
        tag.unlink()
        self.assertFalse(self.env["crm.stage"].search([("name", "=", "Negosiasi Akhir")]))
