from odoo import api, models


class PurchaseOrderLine(models.Model):
    _inherit = "purchase.order.line"

    @api.model_create_multi
    def create(self, vals_list):
        """Pakai harga vendor bertingkat (min_qty) sesuai kuantitas baris yang baru dibuat.

        Baris yang dibuat tanpa price_unit lewat API atau wizard mendapat harga dari tingkat
        kuantitas 1, bukan dari kuantitas barisnya: daftar harga 1 -> Rp250.000 dan 10 -> Rp200.000
        memberi Rp250.000 untuk 12 unit. Penulisan ulang product_qty baru memperbaikinya.
        Klien web Odoo tidak terkena karena onchange mengirim price_unit yang sudah benar.
        Menghitung ulang di sini membuat semua jalur membuat baris memberi harga yang sama.
        """
        automatic = [not values.get("display_type") and "price_unit" not in values for values in vals_list]
        lines = super().create(vals_list)
        for line, is_automatic in zip(lines, automatic, strict=True):
            if is_automatic and line.product_id and line.order_id.state in ("draft", "sent"):
                line._compute_price_unit_and_date_planned_and_name()
        return lines
