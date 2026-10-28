from odoo import fields, models


class ResUsers(models.Model):
    _inherit = "res.users"

    kompakapps_warehouse_ids = fields.Many2many(
        "stock.warehouse",
        "kompakapps_user_warehouse_rel",
        "user_id",
        "warehouse_id",
        string="Gudang yang diizinkan",
        help="Cakupan data Inventory (D87, Q9 irisan 3): pengguna hanya melihat dan memproses transfer, gerakan stok, dan stok on-hand "
        "pada gudang yang dipilih (juga Manajer Inventory). Kosong berarti semua gudang; Administrator selalu melihat semua gudang.",
    )

    @property
    def SELF_READABLE_FIELDS(self):
        # pengguna boleh membaca daftar gudangnya sendiri (catatan cakupan di UI); mengubahnya tetap hak administrator
        return [*super().SELF_READABLE_FIELDS, "kompakapps_warehouse_ids"]

    def _get_invalidation_fields(self):
        # aturan record Inventory per gudang membaca field ini; domain aturan di-cache per pengguna sehingga perubahan harus mengosongkan cache
        return super()._get_invalidation_fields() | {"kompakapps_warehouse_ids"}
