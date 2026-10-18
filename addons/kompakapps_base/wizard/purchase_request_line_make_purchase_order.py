from odoo import models


class PurchaseRequestLineMakePurchaseOrder(models.TransientModel):
    _inherit = "purchase.request.line.make.purchase.order"

    def _prepare_purchase_order_line(self, po, item):
        """Bawa harga dari daftar harga vendor ke baris RFQ.

        Wizard OCA (19.0) memaksa price_unit = 0.0 saat membuat baris PO, lalu berharap
        penulisan product_qty memicu hitung ulang harga. Kuantitas yang sama tidak memicu
        apa pun, sehingga harga vendor tidak pernah terisi. Tanpa kunci price_unit, Odoo
        menghitung harga dari product.supplierinfo seperti pada pembuatan baris biasa.
        """
        vals = super()._prepare_purchase_order_line(po, item)
        vals.pop("price_unit", None)
        return vals
