# ruff: noqa: F821
"""Transaksi multicurrency dan revaluasi kurs untuk perusahaan demo (Q80): selisih kurs terealisasi dan belum terealisasi.

Menambah pada perusahaan yang dipilih (`MC_COMPANY`, skala nominal `MC_SCALE`; bawaan "PROLINE Manufaktur (Demo)"):

* mata uang EUR dan SGD aktif, serta kurs USD, EUR, dan SGD per pekan sejak awal Agustus sampai kemarin (bergerak naik turun supaya ada untung dan rugi);
* faktur ekspor jasa dalam USD, SGD, dan EUR serta tagihan vendor luar negeri dalam USD, EUR, dan SGD, dengan pelunasan penuh dan sebagian pada kurs yang berbeda
  (selisih kurs TEREALISASI masuk ke jurnal Exchange Difference) dan beberapa yang masih terbuka pada tiap akhir bulan;
* jurnal bank USD (rekening valas) tempat pelunasan faktur USD masuk, sehingga saldo kas bank valas ikut direvaluasi;
* revaluasi akhir bulan (Agustus, September, Oktober) yang sudah diposting beserta pembaliknya, dan satu revaluasi bulan berjalan yang masih draf supaya bisa
  diposting saat demo (selisih kurs BELUM terealisasi).

Hanya akun piutang, hutang, bank, dan selisih kurs yang tersentuh, jadi kertas kerja COGM tidak terpengaruh. Aman dijalankan ulang: bila perusahaan sudah punya
revaluasi, tidak ada yang diubah. Dijalankan lewat `odoo shell`:

    docker compose run --rm -T odoo odoo shell -d kompakapps --no-http < scripts/seed_multicurrency.py
"""

import os
import random
from datetime import date, timedelta

from odoo import Command

NAME = os.environ.get("MC_COMPANY", "PROLINE Manufaktur (Demo)")
SCALE = float(os.environ.get("MC_SCALE", "1"))
BASE_ENV = env
company = BASE_ENV["res.company"].search([("name", "=", NAME)])
assert company, f"{NAME} belum ada"
admin = BASE_ENV.ref("base.user_admin")
env = BASE_ENV(user=admin, context={**BASE_ENV.context, "allowed_company_ids": [company.id]})
company = env["res.company"].browse(company.id)
if env["kompakapps.fx.revaluation"].search_count([("company_id", "=", company.id)]):
    print(f"{NAME}: sudah punya revaluasi kurs, tidak ada yang diubah.")
    raise SystemExit(0)

rnd = random.Random(20261110)
today = date.today()
yesterday = today - timedelta(days=1)
stats = {}


def count(key, amount=1):
    stats[key] = stats.get(key, 0) + amount


def m(amount):
    return round(amount * SCALE, 0)


def month_start(back):
    cursor = today.replace(day=1)
    for _ in range(back):
        cursor = (cursor - timedelta(days=1)).replace(day=1)
    return cursor


def at(back, offset):
    """Tanggal `offset` hari dari awal bulan (back bulan ke belakang), tidak melewati kemarin."""
    return min(month_start(back) + timedelta(days=offset), yesterday)


Account, Partner, Move = env["account.account"], env["res.partner"], env["account.move"]
Currency = env["res.currency"].with_context(active_test=False)
usd, eur, sgd = (Currency.search([("name", "=", code)], limit=1) for code in ("USD", "EUR", "SGD"))
for currency in (usd, eur, sgd):
    currency.active = True

# ---- akun selisih kurs terealisasi (bila belum diatur) ----
if not company.income_currency_exchange_account_id:
    company.income_currency_exchange_account_id = Account.search([("code", "=", "81100030"), ("company_ids", "in", company.id)], limit=1)
if not company.expense_currency_exchange_account_id:
    company.expense_currency_exchange_account_id = Account.search([("code", "=", "91100020"), ("company_ids", "in", company.id)], limit=1)

# ---- 1. kurs per pekan (rupiah per satu mata uang asing), jalan acak di sekitar nilai dasar ----
Rate = env["res.currency.rate"]
for currency, base, step in ((usd, 16300, 90), (eur, 17900, 110), (sgd, 12150, 45)):
    level, day = base, month_start(3)
    known = set(Rate.search([("currency_id", "=", currency.id), ("company_id", "=", company.id)]).mapped("name"))
    while day <= yesterday:
        level = min(max(level + rnd.randint(-step, step), base - 450), base + 450)
        if day not in known:
            Rate.create({"currency_id": currency.id, "name": day, "rate": 1.0 / level, "company_id": company.id})
            count("kurs")
        day += timedelta(days=7)

# ---- 2. mitra, produk jasa, pajak ----


def partner(name, supplier=False, country="base.id"):
    found = Partner.search([("company_id", "in", [company.id, False]), ("name", "=", name)], limit=1)
    return found or Partner.create({"name": name, "is_company": True, "company_id": company.id, "country_id": env.ref(country).id, "supplier_rank" if supplier else "customer_rank": 1})


service = env["product.product"].search([("default_code", "=", "JASA-EKS"), ("company_id", "=", company.id)], limit=1)
if not service:
    category = env["product.category"].search([("parent_id", "=", False)], order="id", limit=1)
    service = env["product.product"].create(
        {"name": "Jasa Pelatihan dan Kalibrasi (Ekspor Jasa)", "default_code": "JASA-EKS", "type": "service", "list_price": 2400.0, "categ_id": category.id, "company_id": company.id, "supplier_taxes_id": [Command.clear()]}
    )
export_tax = next(
    (env["account.tax"].search([("company_id", "=", company.id), ("name", "=", name), ("type_tax_use", "=", "sale")], limit=1) for name in ("0% EXPORT", "0% EXEMPT", "0%") if env["account.tax"].search_count([("company_id", "=", company.id), ("name", "=", name), ("type_tax_use", "=", "sale")])),
    env["account.tax"],
)
customers = {
    "usd": [partner("Medika Diagnostics Pte Ltd (Singapura)", country="base.sg"), partner("Klinik Prima Diagnostik Sdn Bhd (Malaysia)", country="base.my")],
    "sgd": [partner("Asia Pacific Medical Pte Ltd (Singapura)", country="base.sg")],
    "eur": [partner("Laborium Diagnostik GmbH (Jerman)", country="base.de")],
}
vendors = {
    "usd": partner("Labsoft Solutions Inc (Amerika Serikat)", supplier=True, country="base.us"),
    "eur": partner("EuroQuality Certification BV (Belanda)", supplier=True, country="base.nl"),
    "sgd": partner("Singapore Lab Consulting Pte Ltd", supplier=True, country="base.sg"),
}
expense = {code: Account.search([("code", "=", code), ("company_ids", "in", company.id)], limit=1) for code in ("65110010", "65110030", "63110140")}

# ---- 3. jurnal bank USD (rekening valas) ----
bank = env["account.journal"].search([("company_id", "=", company.id), ("type", "=", "bank"), ("currency_id", "=", False)], order="id", limit=1)
usd_account = Account.search([("code", "=", "11120051"), ("company_ids", "in", company.id)], limit=1) or Account.create(
    {"code": "11120051", "name": "Bank USD", "account_type": "asset_cash", "company_ids": [Command.link(company.id)], "currency_id": usd.id}
)
bank_usd = env["account.journal"].search([("company_id", "=", company.id), ("code", "=", "BNKU")], limit=1) or env["account.journal"].create(
    {"name": "Bank USD", "code": "BNKU", "type": "bank", "currency_id": usd.id, "default_account_id": usd_account.id, "company_id": company.id}
)


def pay(move, day, amount=None, journal=None):
    vals = {"journal_id": (journal or bank).id, "payment_date": day}
    if amount:
        vals["amount"] = amount
    env["account.payment.register"].with_context(active_model="account.move", active_ids=move.ids).create(vals).action_create_payments()
    count("pembayaran valas")


def foreign_invoice(customer, currency, day, amount, label):
    taxes = [Command.set(export_tax.ids)] if export_tax else [Command.clear()]
    invoice = Move.create(
        {
            "move_type": "out_invoice", "partner_id": customer.id, "invoice_date": day, "date": day, "company_id": company.id, "currency_id": currency.id, "ref": label,
            "invoice_line_ids": [Command.create({"product_id": service.id, "name": label, "quantity": 1.0, "price_unit": float(amount), "tax_ids": taxes})],
        }
    )
    invoice.action_post()
    count(f"faktur {currency.name}")
    return invoice


def foreign_bill(vendor, currency, day, amount, label, code):
    bill = Move.create(
        {
            "move_type": "in_invoice", "partner_id": vendor.id, "invoice_date": day, "date": day, "company_id": company.id, "currency_id": currency.id, "ref": label,
            "invoice_line_ids": [Command.create({"name": label, "account_id": expense[code].id, "quantity": 1.0, "price_unit": float(amount), "tax_ids": [Command.clear()]})],
        }
    )
    bill.action_post()
    count(f"tagihan {currency.name}")
    return bill


# ---- 4. faktur dan tagihan valas: (bulan ke belakang, hari, mata uang, jumlah, bagian yang dibayar, hari sampai bayar) ----
SALES = [
    (3, 4, "usd", 5200, 1.0, 38), (3, 19, "usd", 3800, 0.6, 33), (3, 11, "sgd", 7800, 1.0, 40), (2, 7, "usd", 6400, 1.0, 29), (2, 21, "usd", 2900, 0.0, 0),
    (2, 14, "sgd", 6100, 0.5, 31), (2, 2, "eur", 4200, 1.0, 45), (1, 5, "usd", 4700, 0.7, 24), (1, 19, "usd", 5500, 0.0, 0), (1, 11, "sgd", 8400, 0.0, 0), (1, 8, "eur", 3600, 0.0, 0),
    (0, 1, "usd", 3300, 0.0, 0),
]
invoices = []
for back, offset, code, amount, share, delay in SALES:
    currency = {"usd": usd, "sgd": sgd, "eur": eur}[code]
    customer = rnd.choice(customers[code])
    invoice = foreign_invoice(customer, currency, at(back, offset), amount, f"Ekspor jasa pelatihan dan kalibrasi {currency.name}")
    invoices.append((invoice, code, share, delay))
for invoice, code, share, delay in invoices:
    pay_day = invoice.invoice_date + timedelta(days=delay)
    if share and pay_day <= yesterday:
        pay(invoice, pay_day, round(invoice.amount_total * share, 2) if share < 1.0 else None, journal=bank_usd if code == "usd" else None)

PURCHASES = [
    (3, 9, "usd", 2900, 1.0, 30, "65110010", "Lisensi software LIMS"), (2, 11, "usd", 3400, 0.0, 0, "65110010", "Lisensi modul tambahan LIMS"), (1, 13, "usd", 2100, 0.0, 0, "63110140", "Langganan database riset"),
    (3, 24, "eur", 5600, 1.0, 34, "65110030", "Jasa audit sistem mutu"), (1, 2, "eur", 4100, 0.0, 0, "65110030", "Jasa sertifikasi mutu tahunan"), (2, 27, "sgd", 3200, 0.5, 26, "65110030", "Jasa konsultasi regulasi regional"),
]
for back, offset, code, amount, share, delay, account_code, label in PURCHASES:
    currency = {"usd": usd, "sgd": sgd, "eur": eur}[code]
    bill = foreign_bill(vendors[code], currency, at(back, offset), amount, label, account_code)
    pay_day = bill.invoice_date + timedelta(days=delay)
    if share and pay_day <= yesterday:
        pay(bill, pay_day, round(bill.amount_total * share, 2) if share < 1.0 else None)

# ---- 5. revaluasi akhir bulan: tiga yang diposting dan satu draf bulan berjalan ----
Revaluation = env["kompakapps.fx.revaluation"]
for back in (3, 2, 1):
    last = month_start(back) + timedelta(days=32)
    last = last.replace(day=1) - timedelta(days=1)
    if last >= today:
        continue
    revaluation = Revaluation.create({"date": last})
    revaluation.action_compute()
    if revaluation.line_ids:
        revaluation.action_post()
        count("revaluasi diposting")
        print(f"   {revaluation.name} per {last}: untung {revaluation.total_gain:,.0f}, rugi {revaluation.total_loss:,.0f}, bersih {revaluation.total_net:,.0f}")
    else:
        revaluation.unlink()
draft = Revaluation.create({"date": yesterday})
draft.action_compute()
count("revaluasi draf", 1 if draft.line_ids else 0)
if not draft.line_ids:
    draft.unlink()
else:
    print(f"   {draft.name} per {yesterday} (draf): untung {draft.total_gain:,.0f}, rugi {draft.total_loss:,.0f}, bersih {draft.total_net:,.0f}")

env.cr.commit()
summary = Revaluation.kompakapps_fx_summary(str(month_start(3)), str(today))
print(f"{NAME}: transaksi multicurrency ditambahkan: {dict(sorted(stats.items()))}")
for row in summary["months"]:
    print(f"   {row['month']}: terealisasi +{row['realized_gain']:,.0f} -{row['realized_loss']:,.0f} | belum terealisasi +{row['unrealized_gain']:,.0f} -{row['unrealized_loss']:,.0f}")
