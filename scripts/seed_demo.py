# ruff: noqa: F821
"""Data contoh untuk mencoba alur Procure-to-Pay di UI Nusara (vendor, produk, harga vendor).

Dijalankan lewat `odoo shell` (variabel `env` disediakan oleh shell). Database harus sudah
memasang nusara_base. Aman dijalankan ulang: data yang sudah ada tidak digandakan.

    docker compose run --rm -T odoo odoo shell -d nusara --no-http < scripts/seed_demo.py

Skrip ini juga menerapkan setup Indonesia (lihat res.company.nusara_setup_indonesia), yang
menolak berjalan bila perusahaan sudah punya transaksi akuntansi, dan valuasi persediaan
perpetual dengan biaya rata-rata (res.company.nusara_setup_inventory_valuation).
"""

company = env["res.company"].browse(1)
company.nusara_setup_indonesia()
company.nusara_setup_inventory_valuation()
goods = env.ref("product.product_category_goods")

tax = env["account.tax"].search(
    [("company_id", "=", company.id), ("type_tax_use", "=", "purchase")], limit=1
)
vendor = env["res.partner"].search([("name", "=", "PT Pemasok Nusantara")], limit=1) or env[
    "res.partner"
].create({"name": "PT Pemasok Nusantara", "is_company": True, "supplier_rank": 1})
product = env["product.product"].search([("name", "=", "Bahan Baku Nusara")], limit=1) or env[
    "product.product"
].create(
    {
        "name": "Bahan Baku Nusara",
        "type": "consu",
        "is_storable": True,
        "categ_id": goods.id,
        "standard_price": 100000.0,
        "list_price": 150000.0,
        "supplier_taxes_id": [(6, 0, tax.ids)],
    }
)
if not product.categ_id:
    product.categ_id = goods
if not env["product.supplierinfo"].search(
    [("partner_id", "=", vendor.id), ("product_tmpl_id", "=", product.product_tmpl_id.id)], limit=1
):
    env["product.supplierinfo"].create(
        {
            "partner_id": vendor.id,
            "product_tmpl_id": product.product_tmpl_id.id,
            "min_qty": 1.0,
            "price": 100000.0,
            "currency_id": company.currency_id.id,
        }
    )

if product.list_price == 1.0:  # bawaan Odoo; beri harga jual contoh agar Sales Order terisi otomatis
    product.list_price = 150000.0
customer = env["res.partner"].search([("name", "=", "PT Pelanggan Nusantara")], limit=1) or env[
    "res.partner"
].create({"name": "PT Pelanggan Nusantara", "is_company": True, "customer_rank": 1})

# Administrator perlu hak manager Purchase Request untuk menyetujui dan menyelesaikan PR.
env.ref("base.user_admin").group_ids = [
    (4, env.ref("purchase_request.group_purchase_request_manager").id)
]
env.cr.commit()
print("SEED_OK", company.currency_id.name, product.display_name, vendor.display_name, customer.display_name)
