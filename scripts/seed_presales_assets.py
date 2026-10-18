# ruff: noqa: F821
"""Data aset tetap untuk demo presales PROLINE: model aset (asset profile), aset dari tagihan vendor, dan satu aset saldo awal.

Jalankan SETELAH setup_tax_id.py (pajak VAT In 11%) lewat `odoo shell`. Aman dijalankan ulang (berhenti bila model "Peralatan Laboratorium" sudah ada).

    docker compose run --rm -T --no-deps odoo odoo shell -d kompakapps --no-http < scripts/seed_presales_assets.py

Dibuat: empat model aset (Peralatan Laboratorium 4 tahun, Kendaraan Operasional 8 tahun, Peralatan Kantor dan Komputer 4 tahun, Renovasi Gudang 10 tahun),
akun aset dan penyusutan untuk peralatan laboratorium, empat tagihan vendor yang membentuk aset (satu belum dibayar), satu aset saldo awal tanpa tagihan,
dan jurnal penyusutan bulanan yang sudah diposting sampai hari ini. Nama perusahaan dan harga adalah contoh rekaan.
"""
import datetime
from odoo import Command, fields

admin = env.ref("base.user_admin")
env = env(user=admin)
company = env.company
today = fields.Date.today()
Profile = env["account.asset.profile"]
if Profile.search([("name", "=", "Peralatan Laboratorium (4 tahun)")], limit=1):
    print("ASSETS_SKIP: model aset demo sudah ada")
    raise SystemExit(0)
buy_tax = env["account.tax"].search([("type_tax_use", "=", "purchase"), ("name", "=", "VAT In 11%"), ("company_id", "=", company.id)], limit=1)
if not buy_tax:
    print("ASSETS_SKIP: jalankan scripts/setup_tax_id.py lebih dulu")
    raise SystemExit(0)


def day(back):
    return today - datetime.timedelta(days=back)


Account = env["account.account"]


def account(code, name=None, kind=None):
    found = Account.search([("code", "=", code), ("company_ids", "in", company.id)], limit=1)
    if found or not name:
        return found
    return Account.create({"code": code, "name": name, "account_type": kind, "company_ids": [Command.link(company.id)]})


lab_asset = account("12210040", "Laboratory Equipment", "asset_fixed")
lab_accum = account("12281040", "Accumulation Laboratory Equipment Depreciation", "asset_fixed")
lab_expense = account("67100040", "Laboratory Equipment Depreciation Expense", "expense_depreciation")
general = env["account.journal"].search([("type", "=", "general"), ("company_id", "=", company.id)], limit=1)
bank = env["account.journal"].search([("type", "=", "bank"), ("company_id", "=", company.id)], limit=1)


def profile(name, asset_acc, accum_acc, expense_acc, months):
    return Profile.create({
        "name": name, "journal_id": general.id, "account_asset_id": asset_acc.id, "account_depreciation_id": accum_acc.id,
        "account_expense_depreciation_id": expense_acc.id, "method": "linear", "method_time": "number", "method_number": months, "method_period": "month", "prorata": False,
    })


p_lab = profile("Peralatan Laboratorium (4 tahun)", lab_asset, lab_accum, lab_expense, 48)
p_car = profile("Kendaraan Operasional (8 tahun)", account("12210020"), account("12281020"), account("67100020"), 96)
p_office = profile("Peralatan Kantor dan Komputer (4 tahun)", account("12210030"), account("12281030"), account("67100030"), 48)
p_reno = profile("Renovasi Gudang (10 tahun)", account("12210010"), account("12281010"), account("67100010"), 120)


def vendor(name, city, street):
    return env["res.partner"].create({"name": name, "is_company": True, "supplier_rank": 1, "city": city, "street": street, "country_id": env.ref("base.id").id})


def asset_bill(vendor_rec, back, ref, label, prof, price, pay_it=True):
    bill = env["account.move"].create({
        "move_type": "in_invoice", "partner_id": vendor_rec.id, "invoice_date": day(back), "date": day(back), "ref": ref,
        "invoice_line_ids": [Command.create({"name": label, "account_id": prof.account_asset_id.id, "quantity": 1, "price_unit": price, "tax_ids": [Command.set(buy_tax.ids)], "asset_profile_id": prof.id})],
    })
    bill.action_post()
    if pay_it:
        wizard = env["account.payment.register"].with_context(active_model="account.move", active_ids=bill.ids).create({"journal_id": bank.id, "payment_date": day(back - 3)})
        wizard.action_create_payments()
    return bill


known = env["account.asset"].search([]).ids
bills = [
    asset_bill(vendor("PT Mega Lab Equipment", "Jakarta", "Jl. Raya Bekasi Km 21"), 150, "MLE-2026-0517", "Autoclave 50 L dan lemari pendingin reagen", p_lab, 85_000_000),
    asset_bill(vendor("PT Astra Dealer Jakarta", "Jakarta", "Jl. Gaya Motor III No. 5"), 120, "ADJ/INV/26/0388", "Daihatsu Gran Max blind van untuk distribusi instrumen", p_car, 245_000_000),
    asset_bill(vendor("PT Kreasi Komputer Utama", "Jakarta", "Jl. Mangga Dua Raya Blok C-12"), 75, "KKU-26-1042", "Laptop tim presales (6 unit) dan printer", p_office, 38_000_000),
    asset_bill(vendor("CV Renovasi Gudang Jaya", "Bekasi", "Jl. Cut Meutia No. 18"), 45, "RGJ/2026/019", "Renovasi ruang gudang berpendingin", p_reno, 120_000_000, pay_it=False),
]
opening = env["account.asset"].create({"name": "Mesin fotokopi dan pemindai kantor (saldo awal)", "profile_id": p_office.id, "purchase_value": 18_000_000.0, "date_start": day(300), "salvage_value": 0.0})
assets = env["account.asset"].search([("id", "not in", known)])
for asset in assets.filtered(lambda a: a.state == "draft"):
    asset.validate()
posted = 0
for asset in assets:
    due = asset.depreciation_line_ids.filtered(lambda line: line.type == "depreciate" and not line.move_id and line.line_date <= today).sorted("line_date")
    for line in due:
        line.create_move()
        posted += 1
env.cr.commit()
print("ASSETS_OK", len(assets), "aset,", posted, "jurnal penyusutan,", ", ".join(f"{a.name[:24]}={a.value_residual:,.0f}" for a in assets))
