from odoo.tests import TransactionCase, tagged


@tagged("post_install", "-at_install", "kompakapps")
class TestKompakAppsBaseSmoke(TransactionCase):
    """Memastikan modul inti dan OCA yang dibutuhkan alur Procure-to-Pay terpasang.

    Test alur lengkap (Purchase Request sampai Payment) ditambahkan setelah
    instance Odoo bisa dijalankan dan API modul purchase_request diverifikasi.
    """

    def test_required_models_available(self):
        for model in (
            "purchase.request",
            "purchase.order",
            "account.move",
            "account.payment",
            "stock.picking",
            "sale.order",
        ):
            self.assertIn(model, self.env, f"Model {model} tidak tersedia")
