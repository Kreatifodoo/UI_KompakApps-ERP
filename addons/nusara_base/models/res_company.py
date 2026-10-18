import logging

from odoo import _, models
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)


class ResCompany(models.Model):
    _inherit = "res.company"

    def nusara_setup_indonesia(self):
        """Terapkan setup dasar Indonesia: negara, mata uang IDR, dan COA l10n_id.

        Dijalankan eksplisit (bukan otomatis saat instalasi modul) karena memuat COA
        baru menghapus COA lama. Karena itu ditolak untuk perusahaan yang sudah punya
        transaksi akuntansi. Aman dijalankan ulang pada perusahaan yang sudah beres.
        """
        country = self.env.ref("base.id")
        idr = self.env.ref("base.IDR")
        for company in self:
            if (
                company.chart_template == "id"
                and company.country_id == country
                and company.currency_id == idr
            ):
                continue
            if company._existing_accounting():
                raise UserError(
                    _(
                        "Perusahaan %s sudah punya transaksi akuntansi. Setup Indonesia "
                        "tidak dijalankan karena akan menghapus COA yang ada.",
                        company.name,
                    )
                )
            idr.sudo().active = True
            company.write({"country_id": country.id, "currency_id": idr.id})
            self.env["account.chart.template"].try_loading("id", company)
            # Price list bawaan (tanpa aturan harga) ikut mata uang perusahaan. Odoo tidak
            # mengubahnya sendiri bila fitur price list belum aktif. Yang sudah punya aturan
            # harga sengaja tidak disentuh.
            self.env["product.pricelist"].sudo().with_context(active_test=False).search(
                [
                    ("company_id", "=", company.id),
                    ("item_ids", "=", False),
                    ("currency_id", "!=", idr.id),
                ]
            ).write({"currency_id": idr.id})
            company.nusara_setup_inventory_valuation()
        return True

    def nusara_setup_warehouse(self):
        """Buat gudang utama (beserta lokasi stok dan tipe operasi) untuk perusahaan yang belum punya.

        Odoo 19 hanya membuat gudang otomatis untuk perusahaan pertama (dan di dalam test). Perusahaan baru dari halaman
        Perusahaan membutuhkannya sebelum bisa menerima, mengirim, atau memproduksi barang. Aman dijalankan ulang.
        """
        warehouses = self.env["stock.warehouse"].sudo().with_context(active_test=False)
        for company in self:
            if warehouses.search_count([("company_id", "=", company.id)]):
                continue
            used = set(warehouses.search([]).mapped("code"))
            initials = "".join(word[0] for word in company.name.split() if word[:1].isalnum()).upper()
            base = (initials or "WH")[:3]
            code, number = base, 1
            while code in used:
                number += 1
                code = f"{base}{number}"
            warehouses.create(
                {
                    "name": f"Gudang Utama {company.name}",
                    "code": code,
                    "company_id": company.id,
                    "partner_id": company.partner_id.id,
                }
            )
        return True

    def nusara_setup_inventory_valuation(self):
        """Valuasi persediaan perpetual dengan biaya rata-rata (AVCO) untuk kategori Goods.

        Bawaan Odoo 19 adalah periodik dengan harga standar: tagihan vendor atas barang stok
        langsung mendebit akun beban (COGS) dan persediaan baru disesuaikan saat tutup periode.
        Untuk Indonesia (PSAK 14) persediaan dicatat saat barang ditagih: tagihan mendebit akun
        Persediaan, dan biaya rata-rata mengikuti harga beli. Odoo 19 tidak membuat jurnal saat
        penerimaan barang; jurnal valuasi muncul saat tagihan vendor diposting.

        Hanya kategori Goods yang diubah (Services dan Expenses tidak menyimpan stok).
        Jurnal yang sudah ada tidak diubah; hanya transaksi berikutnya yang memakai aturan ini.
        Aman dijalankan ulang.
        """
        goods = self.env.ref("product.product_category_goods", raise_if_not_found=False)
        for company in self:
            company.write({"inventory_valuation": "real_time", "anglo_saxon_accounting": True})
            if goods:
                goods.with_company(company).write(
                    {"property_valuation": "real_time", "property_cost_method": "average"}
                )
            valued = self.env["stock.move"].search_count(
                [
                    ("company_id", "=", company.id),
                    ("state", "=", "done"),
                    ("product_id.is_storable", "=", True),
                ]
            )
            if valued:
                _logger.warning(
                    "Perusahaan %s sudah punya %s pergerakan barang stok; jurnal lama tidak diubah.",
                    company.name,
                    valued,
                )
        return True
