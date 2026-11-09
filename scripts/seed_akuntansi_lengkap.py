# ruff: noqa: F821
"""Transaksi Accounting yang lengkap untuk "PROLINE Manufaktur (Demo)" (Q79), supaya semua menu Accounting berisi saat demo ke finance.

Perusahaan itu sudah punya faktur penjualan, tagihan vendor, pembayaran, dan jurnal (seed COGM), tetapi menu berikut masih kosong: Credit Note, Debit Note, Asset,
Asset Model, Budget, Bank Transaction, Analytic Account, kurs mata uang, dan Tax Report (semua baris pajak sebelumnya dikosongkan). Skrip ini menambah:

* kurs USD (Agustus sampai November), faktur ekspor jasa dan tagihan vendor dalam USD, sebagian dibayar pada kurs berbeda sehingga selisih kurs terbentuk;
* faktur jasa (instalasi, pelatihan, kalibrasi) dan tagihan vendor dengan PPN, sebagian sudah dibayar, supaya Tax Report dan laporan PPN berisi;
* Credit Note pelanggan (koreksi harga dan potongan volume, sebagian sudah dikompensasikan ke faktur) dan Debit Note vendor;
* aset tetap dari tagihan vendor (renovasi, kendaraan, komputer, furnitur, server, dan satu mesin baru) beserta jurnal penyusutan bulanan;
* anggaran 2026 per akun (pendapatan, HPP, dan biaya operasional per bulan);
* transaksi bank (sebagian sudah direkonsiliasi dengan pembayaran, sebagian menunggu: biaya bank, bunga, setoran pajak, transfer masuk tanpa faktur);
* jurnal umum tambahan (akrual, pembalik, kas kecil, setoran PPN, koreksi klasifikasi);
* akun analitik (departemen dan lini produk) yang dipasang pada faktur, tagihan, dan jurnal sehingga Analytic Report berisi.

Akun COGM (awalan 51), persediaan, dan WIP tidak disentuh pada bulan yang sudah punya kertas kerja: transaksi baru hanya memakai akun pendapatan, biaya operasional,
aset, pajak, dan bank, dan mesin baru baru mulai disusutkan bulan depan. Kertas kerja COGM Agustus sampai Oktober tidak berubah. Aman dijalankan ulang: bila produk jasa JASA-INST
sudah ada, tidak ada yang diubah. Dijalankan lewat `odoo shell`:

    docker compose run --rm -T odoo odoo shell -d kompakapps --no-http < scripts/seed_akuntansi_lengkap.py
"""

import os
import random
from datetime import date, timedelta

from odoo import Command

NAME = os.environ.get("AKUN_COMPANY", "PROLINE Manufaktur (Demo)")
SCALE = float(os.environ.get("AKUN_SCALE", "1"))  # skala nominal: perusahaan yang lebih kecil memakai angka lebih kecil
BASE_ENV = env
company = BASE_ENV["res.company"].search([("name", "=", NAME)])
assert company, f"{NAME} belum ada; jalankan seed_cogm_volume.py lebih dulu"
admin = BASE_ENV.ref("base.user_admin")
env = BASE_ENV(user=admin, context={**BASE_ENV.context, "allowed_company_ids": [company.id]})
company = env["res.company"].browse(company.id)
RETAG_ONLY = os.environ.get("AKUN_RETAG") == "1"  # hanya pasang ulang akun analitik pada semua baris jurnal (aturan penandaan), tanpa transaksi baru
if not RETAG_ONLY and env["product.product"].search_count([("default_code", "=", "JASA-INST"), ("company_id", "=", company.id)]):
    print(f"{NAME}: transaksi Accounting lengkap sudah pernah dibuat, tidak ada yang diubah.")
    raise SystemExit(0)

rnd = random.Random(20261109)
today = date.today()
yesterday = today - timedelta(days=1)
stats = {}


def m(amount):
    """Nominal rupiah dikali skala perusahaan, dibulatkan ke ribuan."""
    return round(amount * SCALE, -3)


def count(key, amount=1):
    stats[key] = stats.get(key, 0) + amount


def when(offset_from_month_start, month_index):
    """Tanggal `offset` hari dari awal bulan `month_index` (0 = tiga bulan lalu, 3 = bulan berjalan); tidak melewati kemarin."""
    cursor = today.replace(day=1)
    for _ in range(3 - month_index):
        cursor = (cursor - timedelta(days=1)).replace(day=1)
    return min(cursor + timedelta(days=offset_from_month_start), yesterday)


Account = env["account.account"]
Partner = env["res.partner"]
Move = env["account.move"]
bank = env["account.journal"].search([("company_id", "=", company.id), ("type", "=", "bank")], limit=1)
misc = env["account.journal"].search([("company_id", "=", company.id), ("type", "=", "general"), ("code", "=", "MISC")], limit=1)
general_journal = misc
usd = env["res.currency"].with_context(active_test=False).search([("name", "=", "USD")])
usd.active = True


def account(code):
    found = Account.search([("code", "=", code), ("company_ids", "in", company.id)], limit=1)
    assert found, code
    return found


def ensure_account(code, name, account_type):
    return Account.search([("code", "=", code), ("company_ids", "in", company.id)], limit=1) or Account.create(
        {"code": code, "name": name, "account_type": account_type, "company_ids": [Command.link(company.id)]}
    )


def partner(name, supplier=False, country="base.id"):
    found = Partner.search([("company_id", "in", [company.id, False]), ("name", "=", name)], limit=1)
    return found or Partner.create(
        {"name": name, "is_company": True, "company_id": company.id, "country_id": env.ref(country).id, "supplier_rank" if supplier else "customer_rank": 1}
    )


def tax(names, use):
    """Pajak pertama yang ada menurut daftar nama (perusahaan utama memakai "VAT Out 11%" dan "VAT In 11%", perusahaan demo COGM memakai pajak bawaan l10n_id)."""
    for name in names:
        found = env["account.tax"].search([("company_id", "=", company.id), ("name", "=", name), ("type_tax_use", "=", use)], limit=1)
        if found:
            return found
    raise AssertionError((names, use))


ensure_account("62100010", "Biaya Pemasaran dan Promosi", "expense")
ensure_account("62100020", "Biaya Perjalanan Dinas dan Pameran", "expense")
ppn_sale, ppn_buy = tax(("12% (Non-Luxury Good)", "VAT Out 11%"), "sale"), tax(("12% (Non-Luxury Good)", "VAT In 11%"), "purchase")
export_tax = tax(("0% EXPORT", "0% EXEMPT", "0%"), "sale")


def pay(move, pay_day, amount=None):
    vals = {"journal_id": bank.id, "payment_date": pay_day}
    if amount:
        vals["amount"] = amount
    env["account.payment.register"].with_context(active_model="account.move", active_ids=move.ids).create(vals).action_create_payments()
    count("pembayaran")


if not RETAG_ONLY:
    # ---- selisih kurs: akun untung dan rugi kurs bila belum diatur ----
    if not company.income_currency_exchange_account_id:
        company.income_currency_exchange_account_id = account("81100030")
    if not company.expense_currency_exchange_account_id:
        company.expense_currency_exchange_account_id = account("91100020")

    # ---- 1. kurs USD (rupiah per dolar) ----
    for day, idr in () if env["res.currency.rate"].search_count([("currency_id", "=", usd.id), ("company_id", "=", company.id)]) else ((date(2026, 7, 15), 16150), (when(0, 0), 16180), (when(0, 1), 16310), (when(0, 2), 16480), (when(19, 2), 16420), (when(2, 3), 16350)):
        env["res.currency.rate"].create({"currency_id": usd.id, "name": day, "rate": 1.0 / idr, "company_id": company.id})
        count("kurs")

    # ---- 2. produk jasa dan mitra ----
    category = env["product.category"].search([("parent_id", "=", False)], order="id", limit=1)


    def service(code, name, price):
        return env["product.product"].create(
            {
                "name": name, "default_code": code, "type": "service", "list_price": price, "categ_id": category.id, "company_id": company.id,
                "taxes_id": [Command.set(ppn_sale.ids)], "supplier_taxes_id": [Command.clear()],
            }
        )


    svc_install = service("JASA-INST", "Jasa Instalasi dan Pelatihan Penggunaan Alat", 12_500_000)
    svc_calibrate = service("JASA-KAL", "Jasa Kalibrasi Alat Laboratorium", 6_800_000)
    svc_export = service("JASA-EKS", "Jasa Pelatihan dan Kalibrasi (Ekspor Jasa)", 2_400)
    customers = Partner.search([("company_id", "in", [company.id, False]), ("customer_rank", ">", 0), ("is_company", "=", True)], order="id", limit=12)
    overseas = [partner("Medika Diagnostics Pte Ltd (Singapura)", country="base.sg"), partner("Klinik Prima Diagnostik Sdn Bhd (Malaysia)", country="base.my")]

    # ---- 3. faktur jasa dengan PPN, dan faktur ekspor jasa dalam USD ----
    service_invoices = []
    for index, (offset, month) in enumerate(((7, 0), (20, 0), (3, 1), (14, 1), (25, 1), (5, 2), (13, 2), (23, 2), (2, 3), (4, 3), (1, 3), (10, 0), (18, 1), (21, 2))):
        product = svc_install if index % 2 == 0 else svc_calibrate
        quantity = rnd.choice((1, 1, 2, 3))
        invoice_day = when(offset, month)
        invoice = Move.create(
            {
                "move_type": "out_invoice", "partner_id": rnd.choice(customers).id, "invoice_date": invoice_day, "date": invoice_day, "company_id": company.id,
                "invoice_line_ids": [Command.create({"product_id": product.id, "quantity": float(quantity), "price_unit": m(product.list_price * rnd.uniform(0.9, 1.15)), "tax_ids": [Command.set(ppn_sale.ids)]})],
            }
        )
        invoice.action_post()
        service_invoices.append(invoice)
        count("faktur jasa PPN")
    for invoice in service_invoices:
        pay_day = invoice.invoice_date + timedelta(days=rnd.choice((12, 20, 28)))
        if pay_day <= yesterday and rnd.random() < 0.65:
            pay(invoice, pay_day)

    export_invoices = []
    for customer, offset, month, amount in ((overseas[0], 11, 0, 2400), (overseas[1], 17, 1, 3100), (overseas[0], 21, 2, 1850)):
        invoice_day = when(offset, month)
        invoice = Move.create(
            {
                "move_type": "out_invoice", "partner_id": customer.id, "invoice_date": invoice_day, "date": invoice_day, "company_id": company.id, "currency_id": usd.id,
                "invoice_line_ids": [Command.create({"product_id": svc_export.id, "quantity": 1.0, "price_unit": float(amount), "tax_ids": [Command.set(export_tax.ids)]})],
            }
        )
        invoice.action_post()
        export_invoices.append(invoice)
        count("faktur USD")
    for invoice in export_invoices[:2]:
        pay(invoice, min(invoice.invoice_date + timedelta(days=24), yesterday))

    # ---- 4. tagihan vendor dengan PPN (jasa dan biaya operasional di luar COGM) ----
    vendor_bills = [
        # bulan, hari, vendor, akun, keterangan, jumlah
        (0, 3, "Kantor Hukum Pratama dan Rekan", "65110030", "Jasa konsultan hukum dan perizinan edar alat kesehatan", 12_500_000),
        (0, 12, "PT Solusi Perangkat Lunak Nusantara", "65110010", "Lisensi dan pemeliharaan software akuntansi", 8_400_000),
        (0, 22, "CV Cipta Kebersihan Mandiri", "65110060", "Jasa kebersihan dan keamanan gedung", 6_300_000),
        (0, 26, "Toko Perlengkapan Kantor Sentral", "63110140", "Pembelian ATK dan perlengkapan kantor", 3_450_000),
        (1, 4, "Kantor Hukum Pratama dan Rekan", "65110030", "Jasa konsultan perpajakan", 9_800_000),
        (1, 11, "PT Media Cetak Sejahtera", "62100010", "Iklan cetak dan majalah profesi kesehatan", 14_200_000),
        (1, 19, "CV Cipta Kebersihan Mandiri", "65110060", "Jasa kebersihan dan keamanan gedung", 6_300_000),
        (1, 27, "PT Pelatihan Mutu Indonesia", "65110010", "Pelatihan dan sertifikasi sistem mutu", 11_000_000),
        (2, 3, "PT Solusi Perangkat Lunak Nusantara", "65110010", "Langganan modul tambahan software", 4_950_000),
        (2, 9, "PT Media Cetak Sejahtera", "62100010", "Iklan pameran alat kesehatan", 18_500_000),
        (2, 17, "CV Cipta Kebersihan Mandiri", "65110060", "Jasa kebersihan dan keamanan gedung", 6_300_000),
        (2, 25, "Toko Perlengkapan Kantor Sentral", "63110140", "Pembelian ATK dan perlengkapan kantor", 2_850_000),
        (3, 1, "CV Cipta Kebersihan Mandiri", "65110060", "Jasa kebersihan dan keamanan gedung", 6_300_000),
        (3, 3, "PT Solusi Perangkat Lunak Nusantara", "65110010", "Lisensi dan pemeliharaan software akuntansi", 8_400_000),
    ]
    bills = []
    for month, offset, vendor_name, code, label, amount in vendor_bills:
        bill_day = when(offset, month)
        bill = Move.create(
            {
                "move_type": "in_invoice", "partner_id": partner(vendor_name, supplier=True).id, "invoice_date": bill_day, "date": bill_day, "company_id": company.id, "ref": label,
                "invoice_line_ids": [Command.create({"name": label, "account_id": account(code).id, "quantity": 1.0, "price_unit": m(amount), "tax_ids": [Command.set(ppn_buy.ids)]})],
            }
        )
        bill.action_post()
        bills.append(bill)
        count("tagihan PPN")
    for bill in bills:
        pay_day = bill.invoice_date + timedelta(days=rnd.choice((14, 21, 30)))
        if pay_day <= yesterday and rnd.random() < 0.7:
            pay(bill, pay_day)

    # tagihan vendor dalam USD (layanan luar negeri, tanpa PPN)
    usd_bills = []
    for month, offset, vendor_name, code, label, amount in (
        (0, 6, "Labsoft Solutions Inc (Amerika Serikat)", "65110010", "Lisensi software LIMS tahunan", 4800),
        (1, 15, "International Quality Certification Ltd (Inggris)", "65110010", "Jasa sertifikasi mutu internasional", 3200),
        (2, 8, "Research Database Services LLC (Amerika Serikat)", "63110140", "Langganan database riset dan jurnal", 1250),
    ):
        bill_day = when(offset, month)
        bill = Move.create(
            {
                "move_type": "in_invoice", "partner_id": partner(vendor_name, supplier=True, country="base.us").id, "invoice_date": bill_day, "date": bill_day, "company_id": company.id,
                "currency_id": usd.id, "ref": label,
                "invoice_line_ids": [Command.create({"name": label, "account_id": account(code).id, "quantity": 1.0, "price_unit": float(amount), "tax_ids": [Command.clear()]})],
            }
        )
        bill.action_post()
        usd_bills.append(bill)
        count("tagihan USD")
    for bill in usd_bills[:2]:
        pay(bill, min(bill.invoice_date + timedelta(days=30), yesterday))

    # ---- 5. Credit Note pelanggan (koreksi harga dan potongan volume) ----
    goods_invoices = Move.search(
        [("company_id", "=", company.id), ("move_type", "=", "out_invoice"), ("state", "=", "posted"), ("currency_id", "=", company.currency_id.id)], order="invoice_date, id"
    ).filtered(lambda inv: inv.invoice_line_ids.filtered(lambda row: row.product_id and row.product_id.type != "service") and inv.amount_total >= 5_000_000)
    unpaid = goods_invoices.filtered(lambda inv: inv.payment_state == "not_paid" and inv.invoice_date < today - timedelta(days=10))
    paid = goods_invoices.filtered(lambda inv: inv.payment_state in ("paid", "in_payment"))
    reasons = ("Potongan volume pembelian", "Koreksi harga sesuai kontrak", "Kit rusak saat pengiriman, kompensasi harga", "Selisih harga e-Katalog")
    picked = list(rnd.sample(list(unpaid), min(7, len(unpaid)))) + list(rnd.sample(list(paid), min(4, len(paid))))
    credit_notes = []
    for number, invoice in enumerate(picked):
        line = invoice.invoice_line_ids.filtered("product_id")[:1]
        note_day = min(max(invoice.invoice_date + timedelta(days=rnd.randint(5, 18)), when(0, 3) - timedelta(days=rnd.randint(1, 20))), yesterday)
        quantity = max(10.0, round(line.quantity * rnd.uniform(0.1, 0.3) / 10) * 10)
        note = Move.create(
            {
                "move_type": "out_refund", "partner_id": invoice.partner_id.id, "invoice_date": note_day, "date": note_day, "company_id": company.id, "reversed_entry_id": invoice.id,
                "ref": reasons[number % len(reasons)],
                "invoice_line_ids": [Command.create({"product_id": line.product_id.id, "name": f"{reasons[number % len(reasons)]}: {line.product_id.name}", "quantity": quantity, "price_unit": line.price_unit, "tax_ids": [Command.clear()]})],
            }
        )
        note.action_post()
        credit_notes.append((note, invoice))
        count("credit note")
    for note, invoice in credit_notes:
        if invoice.payment_state == "not_paid":  # dikompensasikan ke faktur asalnya
            (invoice.line_ids + note.line_ids).filtered(lambda line: line.account_id.account_type == "asset_receivable" and not line.reconciled).reconcile()
            count("credit note dikompensasi")

    # ---- 6. Debit Note vendor (potongan dan koreksi tagihan di luar COGM) ----
    operating_bills = Move.search(
        [("company_id", "=", company.id), ("move_type", "=", "in_invoice"), ("state", "=", "posted"), ("payment_state", "=", "not_paid")], order="invoice_date, id"
    ).filtered(lambda bill: bill.invoice_line_ids[:1].account_id.code and not bill.invoice_line_ids[:1].account_id.code.startswith("51") and not bill.currency_id.name == "USD")
    for number, bill in enumerate(rnd.sample(list(operating_bills), min(6, len(operating_bills)))):
        line = bill.invoice_line_ids[:1]
        note_day = min(bill.invoice_date + timedelta(days=rnd.randint(3, 15)), yesterday)
        note = Move.create(
            {
                "move_type": "in_refund", "partner_id": bill.partner_id.id, "invoice_date": note_day, "date": note_day, "company_id": company.id, "reversed_entry_id": bill.id,
                "ref": ("Potongan harga dan koreksi tagihan", "Kelebihan tagihan dikembalikan", "Diskon pelunasan lebih awal")[number % 3],
                "invoice_line_ids": [Command.create({"name": f"Koreksi tagihan: {line.name or bill.ref}", "account_id": line.account_id.id, "quantity": 1.0, "price_unit": round(line.price_unit * rnd.uniform(0.04, 0.12), -3), "tax_ids": [Command.set(line.tax_ids.ids)]})],
            }
        )
        note.action_post()
        count("debit note")
        (bill.line_ids + note.line_ids).filtered(lambda row: row.account_id.account_type == "liability_payable" and not row.reconciled).reconcile()

    # ---- 7. aset tetap dari tagihan vendor ----
    machine_asset = ensure_account("12210050", "Mesin dan Peralatan Produksi", "asset_fixed")
    machine_accum = ensure_account("12281050", "Akumulasi Penyusutan Mesin dan Peralatan Produksi", "asset_fixed")
    Profile = env["account.asset.profile"]


    def profile(name, asset_acc, accum_acc, expense_acc, months):
        existing = Profile.search([("name", "=", name), ("company_id", "=", company.id)], limit=1)
        if existing:
            return existing
        return Profile.create(
            {
                "name": name, "journal_id": general_journal.id, "account_asset_id": asset_acc.id, "account_depreciation_id": accum_acc.id, "account_expense_depreciation_id": expense_acc.id,
                "method": "linear", "method_time": "number", "method_number": months, "method_period": "month", "prorata": False,
            }
        )


    p_reno = profile("Renovasi Gedung (10 tahun)", account("12210010"), account("12281010"), account("67100010"), 120)
    p_car = profile("Kendaraan Operasional (8 tahun)", account("12210020"), account("12281020"), account("67100020"), 96)
    p_office = profile("Peralatan Kantor dan Komputer (4 tahun)", account("12210030"), account("12281030"), account("67100030"), 48)
    p_machine = profile("Mesin dan Peralatan Produksi (8 tahun)", machine_asset, machine_accum, Account.search([("code", "=", "51300030"), ("company_ids", "in", company.id)], limit=1) or account("67100030"), 96)
    known_assets = env["account.asset"].search([]).ids
    for month, offset, vendor_name, label, prof, price, paid_flag in (
        (0, 3, "CV Renovasi Pabrik Sentosa", "Renovasi ruang produksi dan gudang bahan baku", p_reno, 150_000_000, True),
        (0, 17, "PT Astra Dealer Bekasi", "Mobil boks pengiriman kit reagen", p_car, 230_000_000, True),
        (1, 8, "PT Kreasi Komputer Utama", "Komputer keuangan dan printer (5 unit)", p_office, 42_000_000, True),
        (1, 19, "PT Jaringan Data Andal", "Server dan perangkat jaringan kantor", p_office, 36_000_000, True),
        (2, 4, "PT Mebel Kantor Prima", "Furnitur ruang administrasi dan penjualan", p_office, 28_000_000, False),
        (3, 2, "PT Mesin Industri Presisi", "Mesin filling dan capping reagen otomatis", p_machine, 185_000_000, False),
    ):
        bill_day = when(offset, month)
        asset_bill = Move.create(
            {
                "move_type": "in_invoice", "partner_id": partner(vendor_name, supplier=True).id, "invoice_date": bill_day, "date": bill_day, "company_id": company.id, "ref": label,
                "invoice_line_ids": [
                    Command.create({"name": label, "account_id": prof.account_asset_id.id, "quantity": 1.0, "price_unit": m(price), "tax_ids": [Command.set(ppn_buy.ids)], "asset_profile_id": prof.id})
                ],
            }
        )
        asset_bill.action_post()
        if paid_flag and bill_day + timedelta(days=5) <= yesterday:
            pay(asset_bill, bill_day + timedelta(days=5))
    new_assets = env["account.asset"].search([("id", "not in", known_assets)])
    for asset in new_assets.filtered(lambda rec: rec.state == "draft"):
        asset.validate()
    for asset in new_assets:
        due = asset.depreciation_line_ids.filtered(lambda row: row.type == "depreciate" and not row.move_id and row.line_date <= yesterday).sorted("line_date")
        for row in due:
            row.create_move()
            count("jurnal penyusutan")
    count("aset", len(new_assets))

    # ---- 8. anggaran 2026 per akun ----
    budget_model = env["mis.budget.by.account"]
    year = today.year
    budget = budget_model.search([("company_id", "=", company.id), ("name", "=", f"Anggaran {year}")], limit=1) or budget_model.create(
        {"name": f"Anggaran {year}", "date_from": date(year, 1, 1), "date_to": date(year, 12, 31), "company_id": company.id}
    )
    # akun, debit atau kredit per bulan (Rp): pendapatan, HPP penjualan, dan biaya operasional
    PLAN = [
        ("41000010", "credit", 600_000_000), ("51000010", "debit", 410_000_000), ("61100010", "debit", 38_500_000), ("61100020", "debit", 6_000_000), ("65110040", "debit", 12_000_000),
        ("63110060", "debit", 2_500_000), ("66110010", "debit", 3_300_000), ("65110090", "debit", 9_600_000), ("65110050", "debit", 2_100_000), ("65110030", "debit", 14_000_000),
        ("62100010", "debit", 17_000_000), ("63110080", "debit", 4_200_000), ("62100020", "debit", 5_600_000), ("65110060", "debit", 9_000_000), ("65110010", "debit", 12_000_000),
        ("67100010", "debit", 1_250_000), ("67100020", "debit", 2_400_000), ("67100030", "debit", 1_900_000),
    ]
    for month in range(1, 13) if not budget.item_ids else ():
        first = date(year, month, 1)
        last = (date(year + (month == 12), month % 12 + 1, 1)) - timedelta(days=1)
        growth = 1.0 + 0.012 * month
        for code, side, amount in PLAN:
            budget.write({"item_ids": [Command.create({"account_id": account(code).id, "date_from": first, "date_to": last, side: m(amount * (growth if code == "41000010" else 1.0))})]})
    count("item anggaran", len(budget.item_ids))
    if hasattr(budget, "action_confirm") and budget.state == "draft":
        budget.action_confirm()

    # ---- 9. jurnal umum tambahan ----
    vat_payable, bank_account, petty = account("21221010"), account("11120001"), account("11110010")
    liability = Account.search([("account_type", "=", "liability_current"), ("company_ids", "in", company.id)], limit=1)


    def journal(day, ref, lines):
        lines = [(a, m(d), m(c)) for a, d, c in lines]
        Move.create({"move_type": "entry", "journal_id": misc.id, "date": day, "ref": ref, "company_id": company.id, "line_ids": [Command.create({"account_id": a.id, "debit": d, "credit": c, "name": ref}) for a, d, c in lines]}).action_post()
        count("jurnal umum tambahan")


    journal(when(14, 1), "Setoran PPN masa Agustus", [(vat_payable, 8_650_000.0, 0.0), (bank_account, 0.0, 8_650_000.0)])
    journal(when(14, 2), "Setoran PPN masa September", [(vat_payable, 11_240_000.0, 0.0), (bank_account, 0.0, 11_240_000.0)])
    journal(when(30, 2), "Akrual listrik dan air kantor Oktober", [(account("63110080"), 4_350_000.0, 0.0), (liability, 0.0, 4_350_000.0)])
    journal(when(0, 3), "Pembalik akrual listrik dan air kantor Oktober", [(liability, 4_350_000.0, 0.0), (account("63110080"), 0.0, 4_350_000.0)])
    journal(when(5, 2), "Pencairan kas kecil", [(petty, 5_000_000.0, 0.0), (bank_account, 0.0, 5_000_000.0)])
    journal(when(8, 2), "Pemakaian kas kecil: konsumsi rapat, parkir, dan materai", [(account("63110140"), 1_850_000.0, 0.0), (petty, 0.0, 1_850_000.0)])
    journal(when(20, 2), "Pemakaian kas kecil: transport dan pengiriman dokumen", [(account("66110030"), 1_240_000.0, 0.0), (petty, 0.0, 1_240_000.0)])
    journal(when(25, 2), "Koreksi klasifikasi biaya perawatan gedung", [(account("65110060"), 1_200_000.0, 0.0), (account("63110140"), 0.0, 1_200_000.0)])

    # ---- 10. transaksi bank: sebagian cocok dengan pembayaran, sebagian menunggu rekonsiliasi ----
    StatementLine = env["account.bank.statement.line"]
    payments = env["account.payment"].search(
        [("company_id", "=", company.id), ("journal_id", "=", bank.id), ("state", "in", ("paid", "in_process")), ("date", ">=", today - timedelta(days=45))], order="date, id", limit=36
    )
    matched = 0
    for payment in payments:
        sign = 1.0 if payment.payment_type == "inbound" else -1.0
        line = StatementLine.create(
            {"journal_id": bank.id, "date": min(payment.date + timedelta(days=1), yesterday), "payment_ref": (getattr(payment, "memo", None) or getattr(payment, "ref", None) or payment.name), "partner_id": payment.partner_id.id, "amount": sign * payment.amount}
        )
        suspense = line.move_id.line_ids.filtered(lambda row: row.account_id == bank.suspense_account_id)
        outstanding = payment.move_id.line_ids.filtered(lambda row: row.account_id == payment.outstanding_account_id)
        if suspense and outstanding and matched < 28:
            try:
                with env.cr.savepoint():
                    line.move_id.button_draft()
                    suspense.account_id = outstanding.account_id
                    line.move_id.action_post()
                    (suspense + outstanding).reconcile()
                matched += 1
            except Exception as error:  # rekonsiliasi gagal: transaksi bank tetap ada dan menunggu dicocokkan di layar rekonsiliasi
                count("rekonsiliasi gagal")
                print("   rekonsiliasi dilewati:", str(error)[:90])
    count("transaksi bank cocok", matched)
    print("   rekonsiliasi bank:", matched, "dari", len(payments), "pembayaran")
    count("transaksi bank dari pembayaran", len(payments))
    for index, (month, offset, label, amount, who) in enumerate(
        (
            (1, 28, "Biaya administrasi bank Agustus", -300_000.0, None), (2, 28, "Biaya administrasi bank September", -300_000.0, None),
            (3, 0, "Biaya administrasi bank Oktober", -300_000.0, None), (1, 30, "Bunga giro Agustus", 1_150_000.0, None),
            (2, 30, "Bunga giro September", 1_240_000.0, None), (3, 0, "Bunga giro Oktober", 1_310_000.0, None),
            (2, 15, "Setoran PPh 21 masa September", -6_240_000.0, None), (3, 2, "Setoran PPN masa Oktober", -9_870_000.0, None),
            (3, 1, "Transfer masuk tanpa nomor faktur", 38_500_000.0, customers[0]), (3, 3, "Transfer masuk pelunasan sebagian", 26_250_000.0, customers[1]),
            (3, 4, "Transfer keluar angsuran kendaraan operasional", -4_850_000.0, None), (3, 4, "Penarikan tunai untuk kas kecil", -3_000_000.0, None),
        )
    ):
        StatementLine.create(
            {"journal_id": bank.id, "date": when(offset, month), "payment_ref": label, "amount": m(amount), "partner_id": who.id if who else False}
        )
        count("transaksi bank menunggu")


# ---- 11. akun analitik (departemen dan lini produk) dan pemasangannya ----
Plan = env["account.analytic.plan"]
plan_department, plan_line = Plan.search([("name", "=", "Departemen")], limit=1), Plan.search([("name", "=", "Lini Produk")], limit=1)
assert plan_department and plan_line, "plan analitik Departemen dan Lini Produk belum ada"
Analytic = env["account.analytic.account"]


def analytic(plan, code, name):
    return Analytic.search([("company_id", "=", company.id), ("code", "=", code)], limit=1) or Analytic.create({"name": name, "code": code, "plan_id": plan.id, "company_id": company.id})


dep = {key: analytic(plan_department, code, name) for key, code, name in (("prd", "DEP-PRD", "Produksi"), ("sls", "DEP-SLS", "Penjualan dan Pemasaran"), ("adm", "DEP-ADM", "Administrasi dan Keuangan"), ("log", "DEP-LOG", "Gudang dan Logistik"))}
line_of = {
    code: analytic(plan_line, f"LP-{code[-3:]}", name)
    for code, name in (("FG-KIT-KOL", "Kit Kolesterol"), ("FG-KIT-GLU", "Kit Glukosa"), ("FG-KIT-TRI", "Kit Trigliserida"), ("FG-KIT-KRE", "Kit Kreatinin"), ("FG-KIT-URI", "Kit Asam Urat"))
}
count("akun analitik", len(dep) + len(line_of))
DEPARTMENT_OF = {"65110090": "sls", "62100010": "sls", "62100020": "sls", "66110010": "log", "66110030": "log", "65110050": "adm", "65110030": "adm", "65110040": "adm", "63110060": "adm", "63110080": "adm", "61100010": "adm", "61100020": "adm", "65110060": "adm", "65110010": "adm", "65110020": "adm", "63110140": "adm", "63110120": "adm"}
def distribution(row):
    """Pembagian analitik sebuah baris jurnal. Biaya produksi dan jurnal penutup COGM ke departemen Produksi (sehingga saling meniadakan setelah Execute), HPP penjualan
    menurut lini produk, pendapatan menurut lini produk, dan biaya operasional menurut departemen."""
    code = row.account_id.code or ""
    product_code = row.product_id.default_code or ""
    kind = row.move_id.move_type
    if kind in ("out_invoice", "out_refund"):
        return {f"{line_of[product_code].id},{dep['sls'].id}": 100.0} if product_code in line_of else {str(dep["sls"].id): 100.0}
    if code == "51000010":
        return {f"{line_of[product_code].id},{dep['sls'].id}": 100.0} if product_code in line_of else {str(dep["sls"].id): 100.0}
    if code.startswith("51"):
        return {str(dep["prd"].id): 100.0}
    if code == "61100010":
        return {str(dep["adm"].id): 60.0, str(dep["sls"].id): 40.0}
    if code in DEPARTMENT_OF:
        return {str(dep[DEPARTMENT_OF[code]].id): 100.0}
    return None


tagged = 0
for row in env["account.move.line"].search([("company_id", "=", company.id), ("parent_state", "=", "posted"), ("display_type", "=", "product")]):
    if row.analytic_distribution and not RETAG_ONLY:
        continue  # tag yang sudah ada (mis. dari data presales) tidak ditimpa
    wanted = distribution(row)
    if wanted and row.analytic_distribution != wanted:
        row.analytic_distribution = wanted
        tagged += 1
count("baris diberi akun analitik", tagged)

env.cr.commit()
print(f"{NAME}: transaksi Accounting ditambahkan:")
for key, value in sorted(stats.items()):
    print(f"   {key}: {value}")
