from odoo import models

# Aktivitas terjadwal (mail.activity) hanya bisa dibuat pada model yang memakai mail.activity.mixin. Dokumen inti Odoo (Sales Order,
# Purchase Order, faktur, pengiriman, MO, partner, produk, dan seterusnya) sudah memakainya. Model di bawah ini sudah punya chatter
# (mail.thread) dan dipakai sebagai formulir di UI, tetapi belum bisa dijadwali; mixin ini hanya menambah field hitung (tanpa kolom baru).
# Daftar ini dipakai halaman UI lewat ir.model.is_mail_activity (D59).


class MrpBom(models.Model):
    _name = "mrp.bom"
    _inherit = ["mrp.bom", "mail.activity.mixin"]


class MrpWorkcenter(models.Model):
    _name = "mrp.workcenter"
    _inherit = ["mrp.workcenter", "mail.activity.mixin"]


class StockScrap(models.Model):
    _name = "stock.scrap"
    _inherit = ["stock.scrap", "mail.activity.mixin"]


class AccountAnalyticAccount(models.Model):
    _name = "account.analytic.account"
    _inherit = ["account.analytic.account", "mail.activity.mixin"]


class AccountTax(models.Model):
    _name = "account.tax"
    _inherit = ["account.tax", "mail.activity.mixin"]


class ProductCategory(models.Model):
    _name = "product.category"
    _inherit = ["product.category", "mail.activity.mixin"]


class PosOrder(models.Model):
    _name = "pos.order"
    _inherit = ["pos.order", "mail.activity.mixin"]


class MisBudgetByAccount(models.Model):
    _name = "mis.budget.by.account"
    _inherit = ["mis.budget.by.account", "mail.activity.mixin"]
