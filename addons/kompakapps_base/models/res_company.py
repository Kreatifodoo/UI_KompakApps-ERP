import logging

from odoo import Command, _, models
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)

# Akun untuk jurnal per transaksi inventori (Q49, D69): (kunci, kode, nama, jenis akun). Akun Barang Diterima memakai "Interim Stock" bawaan l10n_id bila ada.
STOCK_JOURNAL_ACCOUNTS = [
    ("input", "29000000", "Barang Diterima Belum Ditagih", "liability_current"),
    ("output", "11300190", "Barang Terkirim Belum Ditagih", "asset_current"),
    ("wip", "11300200", "Barang Dalam Proses", "asset_current"),
    ("adjustment", "51000030", "Selisih Persediaan (Stock Opname)", "expense_direct_cost"),
    ("scrap", "51000040", "Beban Barang Rusak (Scrap)", "expense_direct_cost"),
]
# Akun persediaan terpisah menurut jenis barang (Q61, D89): bahan baku dan barang jadi (dinilai sebesar harga pokok produksi, COGM).
INVENTORY_SPLIT_ACCOUNTS = {
    "raw": ("11300181", "Inventory Bahan Baku"),
    "finished": ("11300182", "Inventory COGM"),
}


class ResCompany(models.Model):
    _inherit = "res.company"

    def kompakapps_setup_indonesia(self):
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
            company.kompakapps_setup_inventory_valuation()
            company.kompakapps_setup_stock_journals()
        return True

    def kompakapps_setup_warehouse(self):
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

    def kompakapps_setup_inventory_valuation(self):
        """Valuasi persediaan perpetual dengan biaya rata-rata (AVCO) untuk kategori Goods.

        Bawaan Odoo 19 adalah periodik dengan harga standar: tagihan vendor atas barang stok
        langsung mendebit akun beban (COGS) dan persediaan baru disesuaikan saat tutup periode.
        Untuk Indonesia (PSAK 14) persediaan memakai biaya rata-rata yang mengikuti harga beli.
        Pada bawaan Odoo 19 jurnal valuasi muncul saat tagihan vendor atau faktur pelanggan diposting;
        jurnal pada saat penerimaan, pengiriman, opname, scrap, dan produksi diaktifkan terpisah oleh
        `kompakapps_setup_stock_journals`.

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

    def kompakapps_setup_stock_journals(self):
        """Aktifkan jurnal pada transaksi inventori mengikuti Product Category (Q49, D69).

        Membuat akun yang belum ada (Barang Terkirim Belum Ditagih, Barang Dalam Proses, Selisih Persediaan, Scrap; Barang Diterima memakai "Interim Stock"
        bawaan l10n_id), mengisi akun Barang Diterima dan Barang Terkirim pada kategori berbiaya rata-rata atau FIFO yang belum punya (kategori baru ikut
        kategori induk atau Goods), dan memberi akun valuasi pada lokasi virtual: Inventory adjustment (selisih opname), Scrap (lokasi baru), dan Production
        (barang dalam proses). Hanya mengisi yang masih kosong, jadi pilihan yang sudah dibuat pengguna tidak ditimpa. Transaksi lama tidak dijurnal ulang;
        dokumen yang sudah ditagih atau difakturkan dengan pola lama dilewati. Aman dijalankan ulang.
        """
        Account = self.env["account.account"]
        Location = self.env["stock.location"].sudo().with_context(active_test=False)
        for company in self:
            if not (company.anglo_saxon_accounting and company.inventory_valuation == "real_time"):
                continue
            account = {}
            for key, code, name, account_type in STOCK_JOURNAL_ACCOUNTS:
                found = Account.with_company(company).search([("code", "=", code), ("company_ids", "in", company.id)], limit=1)
                if not found:
                    found = Account.with_company(company).create(
                        {"code": code, "name": name, "account_type": account_type, "company_ids": [Command.link(company.id)]}
                    )
                account[key] = found
            categories = self.env["product.category"].with_company(company).search([])
            for category in categories.filtered(lambda c: c.property_cost_method in ("average", "fifo")):
                for field, key in (("kompakapps_stock_input_account_id", "input"), ("kompakapps_stock_output_account_id", "output")):
                    if not category[field]:
                        category[field] = account[key]
            for usage, key in (("inventory", "adjustment"), ("production", "wip")):
                for location in Location.search([("company_id", "=", company.id), ("usage", "=", usage)]):
                    if not location.valuation_account_id:
                        location.valuation_account_id = account[key]
            adjustment = Location.search([("company_id", "=", company.id), ("usage", "=", "inventory")], order="id", limit=1)
            if adjustment and not Location.search_count([("company_id", "=", company.id), ("usage", "=", "inventory"), ("name", "=", "Scrap")]):
                Location.create(
                    {
                        "name": "Scrap",
                        "usage": "inventory",
                        "location_id": adjustment.location_id.id,
                        "company_id": company.id,
                        "valuation_account_id": account["scrap"].id,
                    }
                )
        return True

    def kompakapps_split_inventory_accounts(self, raw_categories, finished_categories, repoint_entries=True):
        """Pisahkan akun persediaan menurut kategori produk (Q61, D89): bahan baku ke "Inventory Bahan Baku", barang jadi ke "Inventory COGM".

        Membuat kedua akun bila belum ada, lalu mengisi Akun Persediaan (valuasi stok) pada kategori yang diberikan; transaksi berikutnya otomatis
        memakainya. Dengan `repoint_entries`, jurnal yang sudah ada (terposting maupun draf) yang memuat produk pada kategori itu dan memakai akun persediaan
        lama kategorinya dipindahkan ke akun baru, memakai kategori produk saat ini. Hanya kolom akun pada baris jurnal (dan baris analitik turunannya) yang
        berubah: debit, kredit, tanggal, dan nomor jurnal tetap, dan kedua akun sejenis (aset lancar) sehingga laporan tetap seimbang. Baris tanpa produk
        (jurnal manual) tidak disentuh. Mengembalikan ringkasan jumlah baris yang dipindahkan. Aman dijalankan ulang.
        """
        Account = self.env["account.account"]
        summary = {}
        for company in self:
            accounts = {}
            for key, (code, name) in INVENTORY_SPLIT_ACCOUNTS.items():
                found = Account.with_company(company).search([("code", "=", code), ("company_ids", "in", company.id)], limit=1)
                accounts[key] = found or Account.with_company(company).create(
                    {"code": code, "name": name, "account_type": "asset_current", "company_ids": [Command.link(company.id)]}
                )
            moved = {"raw": 0, "finished": 0}
            for key, categories in (("raw", raw_categories), ("finished", finished_categories)):
                categories = categories.with_company(company)
                old_accounts = categories.mapped("property_stock_valuation_account_id") - accounts[key]
                categories.write({"property_stock_valuation_account_id": accounts[key].id})
                if not (repoint_entries and old_accounts and categories):
                    continue
                self.env.flush_all()
                self.env.cr.execute(
                    """
                    UPDATE account_move_line l
                       SET account_id = %(new)s
                      FROM product_product p
                      JOIN product_template t ON t.id = p.product_tmpl_id
                     WHERE l.product_id = p.id
                       AND t.categ_id IN %(categories)s
                       AND l.account_id IN %(old)s
                       AND l.company_id = %(company)s
                    RETURNING l.id
                    """,
                    {"new": accounts[key].id, "categories": tuple(categories.ids), "old": tuple(old_accounts.ids), "company": company.id},
                )
                line_ids = [row[0] for row in self.env.cr.fetchall()]
                if line_ids:
                    self.env.cr.execute("UPDATE account_analytic_line SET general_account_id = %s WHERE move_line_id IN %s", (accounts[key].id, tuple(line_ids)))
                moved[key] = len(line_ids)
            self.env.invalidate_all()
            summary[company.id] = moved
        return summary
