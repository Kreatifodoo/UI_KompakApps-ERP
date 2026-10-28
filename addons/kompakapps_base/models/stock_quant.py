from odoo import api, models


class StockQuant(models.Model):
    _inherit = "stock.quant"

    @api.model_create_multi
    def create(self, vals_list):
        quants = super().create(vals_list)
        if quants and not self.env.su:
            # Mode inventaris (penghitungan fisik dan penyesuaian langsung) membuat quant sebagai superuser sehingga aturan record terlewati.
            # Periksa hasilnya dengan hak pengguna agar Cakupan data Inventory per gudang (D87, Q9 irisan 3) tidak bisa dilangkahi;
            # galat membatalkan seluruh transaksi, termasuk penyesuaian yang sempat diterapkan.
            rule = self.env["ir.rule"]
            domain = rule._compute_domain(self._name, "create")
            if domain:
                recs = quants.sudo().with_context(active_test=False)
                forbidden = recs - recs.filtered_domain(domain)
                if forbidden:
                    raise rule._make_access_error("create", forbidden)
        return quants
