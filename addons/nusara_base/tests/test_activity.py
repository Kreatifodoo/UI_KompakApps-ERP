from odoo import Command, fields
from odoo.addons.account.tests.common import AccountTestInvoicingCommon
from odoo.tests import tagged

# Model yang formulirnya di UI menampilkan "Jadwalkan Aktivitas" (D59): dokumen inti Odoo ditambah model yang diperluas modul ini.
ACTIVITY_MODELS = [
    "sale.order", "purchase.order", "purchase.request", "stock.picking", "mrp.production", "account.move", "account.payment", "res.partner",
    "product.template", "crm.lead", "stock.lot", "pos.session", "account.asset", "account.account", "account.journal", "product.pricelist",
    "mrp.bom", "mrp.workcenter", "stock.scrap", "account.analytic.account", "account.tax", "product.category", "pos.order", "mis.budget.by.account",
]


@tagged("post_install", "-at_install", "nusara")
class TestScheduledActivities(AccountTestInvoicingCommon):
    """Aktivitas terjadwal (mail.activity) bisa dibuat, dilihat, diselesaikan, dan dihapus pada formulir dokumen dan master (D59)."""

    @classmethod
    @AccountTestInvoicingCommon.setup_country("id")
    def setUpClass(cls):
        super().setUpClass()
        cls.env.user.write(
            {
                "group_ids": [
                    Command.link(cls.env.ref("sales_team.group_sale_manager").id),
                    Command.link(cls.env.ref("purchase.group_purchase_manager").id),
                    Command.link(cls.env.ref("mrp.group_mrp_manager").id),
                    Command.link(cls.env.ref("stock.group_stock_manager").id),
                    Command.link(cls.env.ref("analytic.group_analytic_accounting").id),
                ]
            }
        )
        cls.todo = cls.env.ref("mail.mail_activity_data_todo")

    def _schedule(self, record, **values):
        return self.env["mail.activity"].create(
            {
                "res_model_id": self.env["ir.model"]._get_id(record._name),
                "res_id": record.id,
                "activity_type_id": self.todo.id,
                "summary": "Tindak lanjut",
                "date_deadline": fields.Date.today(),
                "user_id": self.env.user.id,
                **values,
            }
        )

    def test_every_form_model_supports_activities(self):
        missing = [m for m in ACTIVITY_MODELS if not self.env["ir.model"]._get(m).is_mail_activity]
        self.assertEqual(missing, [], "Model ini harus bisa dijadwali aktivitasnya")

    def test_schedule_complete_and_cancel_on_documents_and_masters(self):
        partner = self.env["res.partner"].create({"name": "PT Aktivitas"})
        records = [
            partner,
            self.env["sale.order"].create({"partner_id": partner.id}),
            self.env["purchase.order"].create({"partner_id": partner.id}),
            self.env["mrp.workcenter"].create({"name": "Mesin Pengemas"}),
            self.env["account.analytic.account"].create({"name": "Proyek Aktivitas", "plan_id": self.env["account.analytic.plan"].create({"name": "Rencana Aktivitas"}).id}),
            self.env["product.category"].create({"name": "Kategori Aktivitas"}),
            self.env["mrp.bom"].create({"product_tmpl_id": self.product_a.product_tmpl_id.id, "product_qty": 1.0}),
        ]
        for record in records:
            activity = self._schedule(record)
            self.assertEqual(record.activity_ids, activity, f"{record._name}: aktivitas tercatat pada dokumen")
            self.assertEqual(activity.state, "today")
            activity.action_feedback(feedback="Selesai dikerjakan")
            self.assertFalse(record.activity_ids, f"{record._name}: aktivitas selesai hilang dari daftar")
            cancelled = self._schedule(record, summary="Batal")
            cancelled.unlink()
            self.assertFalse(record.activity_ids, f"{record._name}: aktivitas dihapus")

    def test_overdue_and_planned_states(self):
        partner = self.env["res.partner"].create({"name": "PT Tenggat"})
        today = fields.Date.today()
        overdue = self._schedule(partner, date_deadline=fields.Date.subtract(today, days=3))
        planned = self._schedule(partner, date_deadline=fields.Date.add(today, days=3))
        self.assertEqual((overdue.state, planned.state), ("overdue", "planned"))

    def test_activity_types_can_be_limited_to_a_model(self):
        types = self.env["mail.activity.type"].search(["|", ("res_model", "=", False), ("res_model", "=", "sale.order")])
        self.assertIn(self.todo, types, "Jenis To-Do tersedia di semua formulir")
