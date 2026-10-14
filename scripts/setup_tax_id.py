# ruff: noqa: F821
"""Pajak standar Indonesia untuk Nusara: VAT Out 11% (PPN keluaran), VAT In 11% (PPN masukan), dan PPh 23 -2% (pemotongan).

Dijalankan lewat `odoo shell` pada database yang sudah menjalankan nusara_setup_indonesia (l10n_id terpasang). Aman dijalankan ulang.

    docker compose run --rm -T --no-deps odoo odoo shell -d nusara --no-http < scripts/setup_tax_id.py

Yang dilakukan: mengaktifkan dan menamai ulang pajak 11% bawaan l10n_id (penjualan dan pembelian), membuat PPh 23 -2% untuk pembelian
(dipotong dari vendor, akun Tax Payable PPh 23) dan untuk penjualan (dipotong pelanggan, akun Prepaid Tax PPh 23), menjadikan VAT Out dan
VAT In pajak bawaan perusahaan dan produk, dan mengarsipkan dua pajak "12% (Non-Luxury Good)" (tarif efektif 11% lewat dasar 11/12) yang
membingungkan di daftar pilihan. Dokumen lama yang sudah memakai pajak itu tidak berubah.
"""
company = env.company
Tax = env["account.tax"].with_context(active_test=False)
Account = env["account.account"]


def tax11(use):
    return Tax.search([("type_tax_use", "=", use), ("amount_type", "=", "percent"), ("amount", "=", 11), ("name", "in", ["11%", "VAT Out 11%", "VAT In 11%"]), ("company_id", "=", company.id)], limit=1)


vat_out, vat_in = tax11("sale"), tax11("purchase")
if not vat_out or not vat_in:
    raise SystemExit("Pajak 11% bawaan l10n_id tidak ditemukan; jalankan company.nusara_setup_indonesia() lebih dulu.")
vat_out.write({"name": "VAT Out 11%", "invoice_label": "PPN 11%", "active": True})
vat_in.write({"name": "VAT In 11%", "invoice_label": "PPN 11%", "active": True})
group = env["account.tax.group"].search([("name", "=", "PPh 23")], limit=1) or env["account.tax.group"].create({"name": "PPh 23", "country_id": env.ref("base.id").id})
payable = Account.search([("code", "=", "21210030")], limit=1)
prepaid = Account.search([("code", "=", "11510030")], limit=1)


def pph23(use, name, account, label):
    tax = Tax.search([("type_tax_use", "=", use), ("name", "=", name), ("company_id", "=", company.id)], limit=1)
    if not tax:
        tax = env["account.tax"].create({"name": name, "type_tax_use": use, "amount_type": "percent", "amount": -2.0, "tax_group_id": group.id, "invoice_label": label, "description": label})
    tax.active = True
    for lines in (tax.invoice_repartition_line_ids, tax.refund_repartition_line_ids):
        lines.filtered(lambda r: r.repartition_type == "tax").write({"account_id": account.id})
    return tax


pph_buy = pph23("purchase", "PPh 23 -2%", payable, "PPh 23")
pph_sale = pph23("sale", "PPh 23 -2% (dipotong pelanggan)", prepaid, "PPh 23")
company.write({"account_sale_tax_id": vat_out.id, "account_purchase_tax_id": vat_in.id})
old_sale = Tax.search([("type_tax_use", "=", "sale"), ("name", "=", "12% (Non-Luxury Good)"), ("company_id", "=", company.id)])
old_buy = Tax.search([("type_tax_use", "=", "purchase"), ("name", "=", "12% (Non-Luxury Good)"), ("company_id", "=", company.id)])
templates = env["product.template"].with_context(active_test=False)
for tmpl in templates.search([("taxes_id", "in", old_sale.ids)]):
    tmpl.taxes_id = [(3, t.id) for t in old_sale] + [(4, vat_out.id)]
for tmpl in templates.search([("supplier_taxes_id", "in", old_buy.ids)]):
    tmpl.supplier_taxes_id = [(3, t.id) for t in old_buy] + [(4, vat_in.id)]
(old_sale | old_buy).write({"active": False})
env.cr.commit()
print("TAX_ID_OK", vat_out.name, vat_in.name, pph_buy.name, pph_sale.name)
