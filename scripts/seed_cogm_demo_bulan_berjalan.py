# ruff: noqa: F821
"""Transaksi bulan berjalan untuk "PROLINE Periodik (Demo)" (Q72): BoM, Manufacturing Order, Sales Order, dan produk master baru.

Kertas kerja COGM September dan Oktober di perusahaan itu sudah Terposting atau menjadi dasar angka panduan, jadi periode tersebut tidak disentuh. Skrip ini hanya
menambah dokumen bertanggal dari tanggal 1 bulan ini sampai kemarin (periode yang belum ditutup, tanpa kertas kerja):

* BoM untuk Kit Kolesterol dan Kit Glukosa (komponen per 100 kit, karena kuantitas BoM hanya mendukung dua desimal) dan satu barang jadi baru, Kit Trigliserida;
* produk master baru: Reagen Glukosa, Enzim Glucose Oxidase, Reagen Trigliserida, dan Buffer Tris, serta delapan pelanggan baru;
* pembelian bahan (PO, penerimaan, tagihan), Manufacturing Order selesai per 100 kit, serta Sales Order yang dikonfirmasi, dikirim, dan difakturkan dengan HPP
  sementara pada biaya produk saat itu. Saldo Inventory COGM bulan berjalan sementara negatif oleh HPP sementara, sampai kertas kerja bulan itu dieksekusi.

Hanya dokumen dengan tanggal bulan berjalan yang dibuat, jadi hitung fisik, stok akhir periode, dan buku besar pada kertas kerja sebelumnya tidak berubah. Aman
dijalankan ulang: bila BoM kit sudah ada, tidak ada yang diubah. Dijalankan lewat `odoo shell` pada database yang sudah memasang kompakapps_base dan perusahaan demo:

    docker compose run --rm -T odoo odoo shell -d kompakapps --no-http < scripts/seed_cogm_demo_bulan_berjalan.py
"""

import math
import random
from datetime import date, datetime, time, timedelta

from odoo import Command

NAME = "PROLINE Periodik (Demo)"
company = env["res.company"].search([("name", "=", NAME)])
if not company:
    print(f"{NAME} belum ada; jalankan seed_cogm_demo.py lebih dulu.")
    raise SystemExit(0)
env = env(context={**env.context, "allowed_company_ids": [company.id]})
company = env["res.company"].browse(company.id)
today = date.today()
first = today.replace(day=1)
last = today - timedelta(days=1)
if last < first:
    print("Hari ini tanggal 1: belum ada hari berjalan yang bisa diisi.")
    raise SystemExit(0)
if env["mrp.bom"].search_count([("company_id", "=", company.id)]):
    print(f"{NAME}: BoM sudah ada; tidak ada yang diubah.")
    raise SystemExit(0)

rnd = random.Random(20261106)
Product = env["product.product"].with_company(company)
by_code = {p.default_code: p for p in Product.search([("company_id", "=", company.id)])}
for code in ("RM-REG-KOL", "RM-ENZ-CHO", "RM-BTL-50", "RM-LBL-KIT", "RM-BUF-FOS", "FG-KIT-KOL", "FG-KIT-GLU"):
    assert code in by_code, f"produk {code} tidak ditemukan; jalankan seed_cogm_demo.py lebih dulu"
config = env["kompakapps.cogm.config"].search([("company_id", "=", company.id)])
cogs_acc, fg_acc = config.cogs_account_id, config.fg_account_id
category = by_code["FG-KIT-KOL"].categ_id
misc = env["account.journal"].search([("company_id", "=", company.id), ("type", "=", "general"), ("code", "=", "MISC")], limit=1)
warehouse = env["stock.warehouse"].search([("company_id", "=", company.id)], limit=1)
vendors = {key: env["res.partner"].search([("company_id", "=", company.id), ("name", "=", name)], limit=1) for key, name in (("kimia", "PT Kimia Medika Nusantara"), ("kemasan", "CV Kemasan Sejahtera"))}
assert all(vendors.values())


def at(day, hour=3):
    return datetime.combine(day, time(hour, 0))


def stamp(moves, when):
    moves.write({"date": when})
    moves.move_line_ids.write({"date": when})


def new_product(code, name, cost, uom="uom.product_uom_unit"):
    record = Product.create(
        {
            "name": name, "default_code": code, "type": "consu", "is_storable": True, "categ_id": category.id, "company_id": company.id, "uom_id": env.ref(uom).id,
            "taxes_id": [Command.clear()], "supplier_taxes_id": [Command.clear()], "standard_price": float(cost),
        }
    )
    by_code[code] = record
    return record


# ---- produk master baru ----
new_product("RM-REG-GLU", "Reagen Glukosa Konsentrat", 780000, "uom.product_uom_litre")
new_product("RM-ENZ-GOD", "Enzim Glucose Oxidase (vial)", 1900000)
new_product("RM-REG-TRI", "Reagen Trigliserida Konsentrat", 1050000, "uom.product_uom_litre")
new_product("RM-BUF-TRS", "Buffer Tris (kg)", 420000, "uom.product_uom_kgm")
new_product("FG-KIT-TRI", "Kit Reagen Trigliserida 4 x 50 ml (Demo)", 98000)
PRICE = {"FG-KIT-KOL": 150000.0, "FG-KIT-GLU": 140000.0, "FG-KIT-TRI": 165000.0}
SUPPLIER = {"RM-REG-KOL": "kimia", "RM-ENZ-CHO": "kimia", "RM-BUF-FOS": "kimia", "RM-REG-GLU": "kimia", "RM-ENZ-GOD": "kimia", "RM-REG-TRI": "kimia", "RM-BUF-TRS": "kimia", "RM-BTL-50": "kemasan", "RM-LBL-KIT": "kemasan"}
# komponen per 100 kit
BOM = {
    "FG-KIT-KOL": (("RM-REG-KOL", 2.6), ("RM-ENZ-CHO", 0.3), ("RM-BUF-FOS", 1.8), ("RM-BTL-50", 300), ("RM-LBL-KIT", 300)),
    "FG-KIT-GLU": (("RM-REG-GLU", 2.4), ("RM-ENZ-GOD", 0.3), ("RM-BUF-FOS", 1.8), ("RM-BTL-50", 300), ("RM-LBL-KIT", 300)),
    "FG-KIT-TRI": (("RM-REG-TRI", 2.6), ("RM-ENZ-CHO", 0.2), ("RM-BUF-TRS", 1.8), ("RM-BTL-50", 300), ("RM-LBL-KIT", 300)),
}
boms = {
    code: env["mrp.bom"].create(
        {
            "product_tmpl_id": by_code[code].product_tmpl_id.id, "product_qty": 100.0, "type": "normal", "company_id": company.id,
            "bom_line_ids": [Command.create({"product_id": by_code[raw].id, "product_qty": qty}) for raw, qty in lines],
        }
    )
    for code, lines in BOM.items()
}
CUSTOMERS = [
    ("Lab Klinik Sentra Diagnostik", 0.06), ("Klinik Medika Prima", 0.03), ("RS Harapan Sehat", 0.05), ("PT Mitra Alkes Distribusi", 0.10),
    ("RSUD Kabupaten Sukamaju", 0.04), ("Lab Klinik Bunda Sejahtera", 0.02), ("PT Graha Medika Niaga", 0.09), ("Klinik Pratama Sehat Sentosa", 0.0),
]
customers = [(env["res.partner"].create({"name": label, "is_company": True, "customer_rank": 1, "company_id": company.id}), discount) for label, discount in CUSTOMERS]
customers.append((env["res.partner"].search([("company_id", "=", company.id), ("name", "=", "PT Laboratorium Pelanggan Demo")], limit=1), 0.0))
stats = {"po": 0, "mo": 0, "so": 0}


def ship(picking, when):
    picking.action_assign()
    for move in picking.move_ids:
        move.write({"quantity": move.product_uom_qty, "picked": True})
    picking.button_validate()
    picking.write({"date_done": when, "scheduled_date": when})
    stamp(picking.move_ids, when)


def purchase(vendor, when, lines):
    order = env["purchase.order"].create(
        {
            "partner_id": vendor.id, "date_order": when, "company_id": company.id,
            "order_line": [Command.create({"product_id": p.id, "product_qty": q, "price_unit": price, "tax_ids": [Command.clear()]}) for p, q, price in lines],
        }
    )
    order.button_confirm()
    ship(order.picking_ids, when)
    action = order.action_create_invoice()
    bill = env["account.move"].browse(action["res_id"]) if action.get("res_id") else order.invoice_ids
    bill.write({"invoice_date": when.date(), "date": when.date(), "ref": f"INV-{order.name}"})
    bill.action_post()
    stats["po"] += 1


def manufacture(code, qty, day):
    when = at(day)
    order = env["mrp.production"].create({"product_id": by_code[code].id, "product_qty": float(qty), "bom_id": boms[code].id, "date_start": when, "company_id": company.id})
    order.action_confirm()
    order.qty_producing = float(qty)
    for move in order.move_raw_ids:
        move.write({"quantity": move.product_uom_qty, "picked": True})
    order.button_mark_done()
    stamp(order.move_raw_ids | order.move_finished_ids, when)
    order.write({"date_finished": when})
    assert order.state == "done", (order.name, order.state)
    stats["mo"] += 1


def sell(customer, discount, day, lines):
    order = env["sale.order"].create(
        {
            "partner_id": customer.id, "date_order": at(day, 4), "company_id": company.id,
            "order_line": [
                Command.create({"product_id": by_code[code].id, "product_uom_qty": float(q), "price_unit": round(PRICE[code] * (1 - discount), -2), "tax_ids": [Command.clear()]})
                for code, q in lines
            ],
        }
    )
    order.action_confirm()
    order.write({"date_order": at(day, 4)})  # konfirmasi menimpa tanggal pesanan dengan waktu sekarang
    ship(order.picking_ids.filtered(lambda p: p.state not in ("done", "cancel")), at(day, 5))
    invoice = order._create_invoices()
    invoice.write({"invoice_date": day, "date": day})
    invoice.action_post()
    provisional = []
    for code, q in lines:  # HPP sementara pada biaya produk saat ini, bertanda produk
        product = by_code[code]
        amount = product.standard_price * q
        provisional += [
            Command.create({"account_id": cogs_acc.id, "debit": amount, "credit": 0.0, "product_id": product.id, "name": f"HPP sementara {product.name}"}),
            Command.create({"account_id": fg_acc.id, "debit": 0.0, "credit": amount, "product_id": product.id, "name": f"HPP sementara {product.name}"}),
        ]
    env["account.move"].create({"move_type": "entry", "journal_id": misc.id, "date": day, "ref": f"HPP sementara {order.name}", "line_ids": provisional}).action_post()
    stats["so"] += 1


# ---- rencana: produksi sebanding dengan hari yang sudah berjalan (kit per hari), pembelian menutup kebutuhan plus cadangan 30% ----
span = (last - first).days + 1
PER_DAY = {"FG-KIT-KOL": 100, "FG-KIT-GLU": 80, "FG-KIT-TRI": 60}
produce = {code: max(100, int(round(per_day * span / 100.0)) * 100) for code, per_day in PER_DAY.items()}
need = {}
for code, qty in produce.items():
    for raw, per_100 in BOM[code]:
        need[raw] = need.get(raw, 0.0) + qty / 100.0 * per_100
buy_total = {}
for raw, wanted in need.items():
    product = by_code[raw]
    step = 100 if product.standard_price < 10000 else 1
    buy_total[raw] = (math.ceil(max(0.0, wanted * 1.3 - product.qty_available) / step) * step, step)
for part, (offset, share) in enumerate(((0, 0.6), (min(2, span - 1), 0.4))):  # dua tahap pembelian
    for supplier, vendor in vendors.items():
        lines = []
        for raw, (total, step) in buy_total.items():
            qty = math.ceil(total * share / step) * step
            if SUPPLIER[raw] == supplier and qty:
                lines.append((by_code[raw], float(qty), round(by_code[raw].standard_price * 1.03, 2)))
        if lines:
            purchase(vendor, at(first + timedelta(days=offset + part)), lines)
batches = []
for position, (code, qty) in enumerate(produce.items()):
    sizes = [100] * (qty // 100)
    for number in range(len(sizes)):
        batches.append((min(position + int(number * span / max(len(sizes), 1)), span - 1), code))
for offset, code in sorted(batches):
    manufacture(code, 100, first + timedelta(days=offset))

# penjualan: pesanan kecil banyak (20 sampai 60 kit) sebesar sebagian stok barang jadi yang ada
chunks = []
for code, share in (("FG-KIT-KOL", 0.30), ("FG-KIT-GLU", 0.30), ("FG-KIT-TRI", 0.35)):
    target = int(by_code[code].qty_available * share / 10) * 10
    left = target
    while left >= 20:
        qty = min(left, rnd.choice((20, 30, 40, 60)))
        chunks.append((code, qty))
        left -= qty
rnd.shuffle(chunks)
orders = []
while chunks:
    group = [chunks.pop()]
    while chunks and len(group) < 3 and rnd.random() < 0.5:
        candidate = next((c for c in chunks if c[0] not in {g[0] for g in group}), None)
        if not candidate:
            break
        chunks.remove(candidate)
        group.append(candidate)
    orders.append(group)
days = sorted(first + timedelta(days=rnd.randint(1 if span > 1 else 0, span - 1)) for _ in orders)
for day, group in zip(days, orders):
    customer, discount = rnd.choice(customers)
    sell(customer, discount, day, group)

env.cr.commit()
print(f"{NAME}: transaksi {first}..{last} ditambahkan: {stats}")
print("  stok sekarang:", {code: p.qty_available for code, p in sorted(by_code.items())})
