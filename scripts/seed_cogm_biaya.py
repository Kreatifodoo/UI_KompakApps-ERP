# ruff: noqa: F821
"""Transaksi biaya untuk perusahaan demo COGM (Q73): "PROLINE Manufaktur (Demo)" dan "PROLINE Periodik (Demo)", supaya angka laporan bergerak.

Sebelumnya kedua perusahaan hanya punya biaya produksi yang dipetakan ke COGM sampai bulan lalu, tanpa biaya operasional, tanpa pembayaran, dan tanpa biaya bulan
berjalan. Skrip ini menambah:

* modal kerja di bank pada tanggal saldo awal (Dr Bank, Cr Modal Disetor);
* biaya operasional bulanan di luar COGM (akun 61 sampai 66): gaji dan bonus staf administrasi dan penjualan, sewa, telepon dan internet, BBM, listrik kantor,
  ongkos kirim penjualan, premi asuransi, jasa akuntan, promosi dan iklan, perjalanan dinas dan pameran, perawatan gedung, parkir dan tol, serta biaya bank;
  sebagian sebagai tagihan vendor, sebagian sebagai jurnal bank;
* biaya produksi bulan berjalan sampai kemarin pada akun yang dipetakan ke COGM (upah mingguan, tenaga kerja tidak langsung, ongkos angkut pembelian, gas dan
  air, perawatan mesin, bahan penolong), sehingga kertas kerja bulan itu kelak sudah berisi biaya;
* pelunasan utang upah dan overhead pabrik yang dibukukan sebagai kewajiban pada bulan-bulan sebelumnya, dan pembayaran tagihan vendor yang sudah jatuh tempo.

Hanya akun di luar COGM yang diisi untuk bulan yang sudah ditutup, dan akun COGM hanya diisi untuk bulan berjalan, jadi buku besar yang dipakai kertas kerja
Agustus sampai Oktober tidak berubah. Aman dijalankan ulang: perusahaan yang sudah punya jurnal gaji staf dilewati. Dijalankan lewat `odoo shell`:

    docker compose run --rm -T odoo odoo shell -d kompakapps --no-http < scripts/seed_cogm_biaya.py
"""

import random
from datetime import date, datetime, time, timedelta

from odoo import Command

BASE_ENV = env
rnd = random.Random(20261106)
today = date.today()
yesterday = today - timedelta(days=1)
MARKER = "Gaji karyawan administrasi dan penjualan"


def at(day, hour=3):
    return datetime.combine(day, time(hour, 0))


def closed_months(count):
    """`count` bulan penuh terakhir (paling lama dulu) dan hari terakhir bulan sebelum yang pertama."""
    months, cursor = [], today.replace(day=1)
    for _ in range(count):
        last = cursor - timedelta(days=1)
        first = last.replace(day=1)
        months.insert(0, (first, last))
        cursor = first
    return months, months[0][0] - timedelta(days=1)


# hari, akun, keterangan, jumlah per bulan (skala 1), vendor (kunci), mode: "bill" tagihan vendor, "bank" jurnal bank
OPEX = [
    (1, "65110040", "Sewa kantor dan gudang penjualan", 12_000_000, "sewa", "bill"),
    (3, "63110060", "Tagihan telepon dan internet kantor", 2_450_000, "telkom", "bill"),
    (5, "66110010", "BBM kendaraan operasional", 3_200_000, "spbu", "bill"),
    (7, "65110090", "Ongkos kirim penjualan minggu pertama", 2_200_000, "ekspedisi", "bill"),
    (10, "65110050", "Premi asuransi gedung dan persediaan", 2_100_000, "asuransi", "bill"),
    (14, "65110090", "Ongkos kirim penjualan minggu kedua", 2_450_000, "ekspedisi", "bill"),
    (15, "65110030", "Jasa akuntan dan konsultan pajak", 4_500_000, "akuntan", "bill"),
    (18, "62100010", "Promosi dan iklan digital", 6_800_000, "promosi", "bill"),
    (20, "63110080", "Listrik kantor", 4_100_000, "pln_kantor", "bill"),
    (21, "65110090", "Ongkos kirim penjualan minggu ketiga", 2_300_000, "ekspedisi", "bill"),
    (22, "62100020", "Perjalanan dinas dan pameran", 5_600_000, "perjalanan", "bill"),
    (24, "65110060", "Perawatan gedung kantor", 2_600_000, "jasa", "bill"),
    (25, "66110030", "Parkir dan tol kendaraan operasional", 900_000, None, "bank"),
    (28, "65110090", "Ongkos kirim penjualan minggu keempat", 2_400_000, "ekspedisi", "bill"),
    (99, "61100010", MARKER, 38_500_000, None, "bank"),  # akhir bulan
    (99, "61100020", "Tunjangan dan bonus karyawan", 6_000_000, None, "bank"),
    (99, "65110020", "Biaya administrasi bank", 300_000, None, "bank"),
]
VENDOR_NAMES = {
    "sewa": "PT Sewa Gedung Perkasa", "telkom": "PT Telekomunikasi Mitra", "spbu": "SPBU Mitra Energi", "ekspedisi": "PT Ekspedisi Cepat", "asuransi": "PT Asuransi Aman Sentosa",
    "akuntan": "KAP Mandiri Akuntan", "promosi": "CV Media Promosi Kreatif", "pln_kantor": "PLN Unit Kantor", "perjalanan": "Biro Perjalanan Dinas Nusantara",
    "jasa": "CV Jasa Pabrik Sejahtera", "gas": "PT Gas Industri Utama", "kemasan": "CV Kemasan Sejahtera",
}
# biaya produksi bulan berjalan pada akun yang dipetakan ke COGM: hari, akun, keterangan, jumlah, vendor (None = jurnal bank)
PRODUCTION = [
    (2, "51000021", "Ongkos angkut pembelian bahan baku", 2_100_000, "ekspedisi"),
    (4, "51000021", "Ongkos angkut pembelian bahan baku", 2_350_000, "ekspedisi"),
    (3, "51300020", "Tagihan gas dan air pabrik", 1_150_000, "gas"),
    (4, "51300040", "Perawatan mesin pabrik", 2_900_000, "jasa"),
    (5, "51300050", "Bahan penolong dan perlengkapan pabrik", 1_400_000, "kemasan"),
    (5, "51200010", "Upah mingguan tenaga kerja langsung minggu pertama", 16_800_000, None),
    (5, "51300010", "Upah mingguan tenaga kerja tidak langsung minggu pertama", 3_700_000, None),
]


def setup(name, month_count, scale, capital):
    company = BASE_ENV["res.company"].search([("name", "=", name)])
    if not company:
        print(f"{name}: perusahaan belum ada, dilewati.")
        return
    env = BASE_ENV(context={**BASE_ENV.context, "allowed_company_ids": [company.id]})
    company = env["res.company"].browse(company.id)
    if env["account.move"].search_count([("company_id", "=", company.id), ("ref", "=", MARKER)]):
        print(f"{name}: sudah punya jurnal gaji staf, dilewati.")
        return

    def account(code):
        return env["account.account"].with_company(company).search([("code", "=", code), ("company_ids", "in", company.id)], limit=1)

    def ensure(code, label):
        return account(code) or env["account.account"].with_company(company).create({"code": code, "name": label, "account_type": "expense", "company_ids": [Command.link(company.id)]})

    ensure("62100010", "Biaya Pemasaran dan Promosi")
    ensure("62100020", "Biaya Perjalanan Dinas dan Pameran")
    bank_acc, capital_acc = account("11120001"), account("31100020")
    payable = env["account.account"].with_company(company).search([("account_type", "=", "liability_current"), ("company_ids", "in", company.id)], limit=1)
    misc = env["account.journal"].search([("company_id", "=", company.id), ("type", "=", "general"), ("code", "=", "MISC")], limit=1)
    bank = env["account.journal"].search([("company_id", "=", company.id), ("type", "=", "bank")], limit=1)
    assert bank_acc and capital_acc and payable and misc and bank, name
    vendors = {}
    stats = {"tagihan": 0, "jurnal": 0, "pembayaran": 0}

    def vendor(key):
        if key not in vendors:
            partner = env["res.partner"].search([("company_id", "=", company.id), ("name", "=", VENDOR_NAMES[key])], limit=1)
            vendors[key] = partner or env["res.partner"].create({"name": VENDOR_NAMES[key], "is_company": True, "supplier_rank": 1, "company_id": company.id})
        return vendors[key]

    def journal(day, ref, lines):
        env["account.move"].create(
            {"move_type": "entry", "journal_id": misc.id, "date": day, "ref": ref, "line_ids": [Command.create({"account_id": a.id, "debit": d, "credit": c, "name": ref}) for a, d, c in lines]}
        ).action_post()
        stats["jurnal"] += 1

    def bill(key, day, code, amount, label):
        env["account.move"].create(
            {
                "move_type": "in_invoice", "partner_id": vendor(key).id, "invoice_date": day, "date": day, "company_id": company.id, "ref": label,
                "invoice_line_ids": [Command.create({"name": label, "account_id": account(code).id, "quantity": 1.0, "price_unit": amount, "tax_ids": [Command.clear()]})],
            }
        ).action_post()
        stats["tagihan"] += 1

    def spend(day, code, amount, label):
        journal(day, label, [(account(code), amount, 0.0), (bank_acc, 0.0, amount)])

    def balance(acc, upto):
        lines = env["account.move.line"].sudo().search([("company_id", "=", company.id), ("parent_state", "=", "posted"), ("account_id", "=", acc.id), ("date", "<=", upto)])
        return round(sum(lines.mapped("balance")), 2)

    # modal kerja
    months, opening_day = closed_months(month_count)
    journal(opening_day, "Modal kerja disetor ke bank", [(bank_acc, capital, 0.0), (capital_acc, 0.0, capital)])
    running = (today.replace(day=1), yesterday) if yesterday >= today.replace(day=1) else None
    for first, last in [*months, *([running] if running else [])]:
        is_running = running is not None and first == running[0]
        for day, code, label, amount, key, mode in OPEX:
            date_of = last if day == 99 else first + timedelta(days=day - 1)
            if date_of > last or (is_running and day == 99):
                continue
            value = round(amount * scale * rnd.uniform(0.94, 1.06), -3)
            if mode == "bill":
                bill(key, date_of, code, value, label)
            else:
                spend(date_of, code, value, label)
        if is_running:
            for day, code, label, amount, key in PRODUCTION:
                date_of = first + timedelta(days=day - 1)
                if date_of > last:
                    continue
                value = round(amount * scale * rnd.uniform(0.96, 1.04), -3)
                if key:
                    bill(key, date_of, code, value, label)
                else:
                    spend(date_of, code, value, label)
        else:
            # utang upah dan overhead pabrik bulan itu dilunasi tanggal 5 bulan berikutnya (bila sudah lewat)
            pay_day = last + timedelta(days=5)
            owed = -balance(payable, last)
            if pay_day <= yesterday and owed > 0:
                journal(pay_day, f"Pembayaran upah dan overhead pabrik {last:%B %Y}", [(payable, owed, 0.0), (bank_acc, 0.0, owed)])

    # pembayaran tagihan vendor yang sudah jatuh tempo
    bills = env["account.move"].search(
        [("company_id", "=", company.id), ("move_type", "=", "in_invoice"), ("state", "=", "posted"), ("payment_state", "in", ("not_paid", "partial")), ("invoice_date", "<=", today - timedelta(days=15))],
        order="invoice_date, id",
    )
    for invoice in bills:
        pay_day = invoice.invoice_date + timedelta(days=rnd.choice((14, 21, 30)))
        if pay_day <= yesterday and rnd.random() < 0.85:
            wizard = env["account.payment.register"].with_context(active_model="account.move", active_ids=invoice.ids).create({"journal_id": bank.id, "payment_date": pay_day})
            wizard.action_create_payments()
            stats["pembayaran"] += 1
    BASE_ENV.cr.commit()
    print(f"{name}: {stats}; saldo bank {balance(bank_acc, today):,.0f}, utang upah dan overhead {balance(payable, today):,.0f}")


# nama perusahaan, jumlah bulan tertutup, skala biaya, modal kerja
setup("PROLINE Manufaktur (Demo)", 3, 1.0, 2_000_000_000.0)
setup("PROLINE Periodik (Demo)", 2, 0.6, 1_000_000_000.0)
