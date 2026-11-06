from odoo.tests import TransactionCase, tagged


@tagged("post_install", "-at_install", "kompakapps")
class TestSystemUser(TransactionCase):
    """Pengguna sistem Odoo tidak boleh tampil sebagai "OdooBot" di Nusara ERP (Q78, D103)."""

    def test_system_user_is_named_for_nusara(self):
        root = self.env.ref("base.user_root")
        self.assertEqual(self.env.ref("base.partner_root").name, "Sistem Nusara")
        self.assertEqual(root.name, "Sistem Nusara")
        self.assertNotIn("odoobot", (root.display_name or "").lower())
