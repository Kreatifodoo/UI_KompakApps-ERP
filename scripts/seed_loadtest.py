# ruff: noqa: F821
"""Data besar untuk uji beban dan uji backup: ribuan produk, ratusan mitra, dan ratusan faktur, tagihan,
Sales Order, serta Purchase Order tersebar setahun terakhir (nama berawalan "LT ", mudah dikenali).

Dijalankan lewat `odoo shell` (variabel `env` disediakan oleh shell) pada DATABASE UJI yang sudah diisi
scripts/seed_demo.py. Ukuran lewat variabel lingkungan: SEED_PRODUCTS (bawaan 2000), SEED_PARTNERS (300 per jenis),
SEED_DOCS (600 per jenis dokumen). Aman dijalankan ulang: produk dan mitra yang sudah ada tidak digandakan,
tetapi dokumen selalu ditambah.

    docker compose -p <proyek> run --rm -T --no-deps -e SEED_DOCS=600 odoo odoo shell -d <db-uji> --no-http < scripts/seed_loadtest.py
"""

import datetime
import os
import random
import time

N_PRODUCTS = int(os.environ.get("SEED_PRODUCTS", "2000"))
N_PARTNERS = int(os.environ.get("SEED_PARTNERS", "300"))
N_DOCS = int(os.environ.get("SEED_DOCS", "600"))
rng = random.Random(42)
today = datetime.date.today()
started = time.time()


def say(message):
    print(f"[{time.time() - started:6.0f}s] {message}", flush=True)


def batches(items, size):
    for i in range(0, len(items), size):
        yield items[i : i + size]


goods = env.ref("product.product_category_goods")
existing = env["product.product"].search_count([("name", "=like", "LT Produk %")])
for chunk in batches(list(range(existing, N_PRODUCTS)), 200):
    env["product.product"].create(
        [
            {
                "name": f"LT Produk {i:05d}",
                "type": "consu",
                "is_storable": True,
                "categ_id": goods.id,
                "standard_price": float(rng.randint(10, 500) * 1000),
                "list_price": float(rng.randint(15, 700) * 1000),
            }
            for i in chunk
        ]
    )
    env.cr.commit()
say(f"produk: {env['product.product'].search_count([('name', '=like', 'LT Produk %')])}")

for prefix, flag in (("LT Pelanggan", "customer_rank"), ("LT Pemasok", "supplier_rank")):
    have = env["res.partner"].search_count([("name", "=like", f"{prefix} %")])
    env["res.partner"].create(
        [{"name": f"{prefix} {i:04d}", "is_company": True, flag: 1} for i in range(have, N_PARTNERS)]
    )
    env.cr.commit()
customers = env["res.partner"].search([("name", "=like", "LT Pelanggan %")]).ids
vendors = env["res.partner"].search([("name", "=like", "LT Pemasok %")]).ids
products = env["product.product"].search([("name", "=like", "LT Produk %")])
say(f"mitra: {len(customers)} pelanggan, {len(vendors)} pemasok")


def invoice_lines(price_attr):
    picked = rng.sample(list(products), rng.randint(1, 4))
    return [(0, 0, {"product_id": p.id, "quantity": float(rng.randint(1, 20)), "price_unit": p[price_attr]}) for p in picked]


def random_date():
    return today - datetime.timedelta(days=rng.randint(0, 330))


for kind, move_type, partners, price_attr in (
    ("faktur pelanggan", "out_invoice", customers, "list_price"),
    ("tagihan vendor", "in_invoice", vendors, "standard_price"),
):
    for n in range(1, N_DOCS + 1):
        day = random_date()
        move = env["account.move"].create(
            {
                "move_type": move_type,
                "partner_id": rng.choice(partners),
                "invoice_date": day,
                "invoice_line_ids": invoice_lines(price_attr),
            }
        )
        move.action_post()
        if n % 50 == 0:
            env.cr.commit()
            say(f"{kind}: {n}/{N_DOCS}")
    env.cr.commit()

for n in range(1, N_DOCS + 1):
    order = env["sale.order"].create(
        {
            "partner_id": rng.choice(customers),
            "date_order": datetime.datetime.combine(random_date(), datetime.time(9, 0)),
            "order_line": [(0, 0, {"product_id": p.id, "product_uom_qty": float(rng.randint(1, 10))}) for p in rng.sample(list(products), rng.randint(1, 3))],
        }
    )
    if n % 5 == 0:  # sebagian dikonfirmasi (membuat pengiriman)
        order.action_confirm()
    if n % 50 == 0:
        env.cr.commit()
        say(f"Sales Order: {n}/{N_DOCS}")
env.cr.commit()

for n in range(1, N_DOCS + 1):
    order = env["purchase.order"].create(
        {
            "partner_id": rng.choice(vendors),
            "date_order": datetime.datetime.combine(random_date(), datetime.time(9, 0)),
            "order_line": [(0, 0, {"product_id": p.id, "product_qty": float(rng.randint(1, 30)), "price_unit": p.standard_price}) for p in rng.sample(list(products), rng.randint(1, 3))],
        }
    )
    if n % 2 == 0:
        order.button_confirm()
    if n % 50 == 0:
        env.cr.commit()
        say(f"Purchase Order: {n}/{N_DOCS}")
env.cr.commit()
say(
    "SEED_LOADTEST_OK faktur/tagihan={} SO={} PO={} baris jurnal={}".format(
        env["account.move"].search_count([("state", "=", "posted")]),
        env["sale.order"].search_count([]),
        env["purchase.order"].search_count([]),
        env["account.move.line"].search_count([]),
    )
)
