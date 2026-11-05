# ruff: noqa: F821
"""Data contoh COGM periodik (skema 2, Q64, D92): perusahaan terpisah "PROLINE Periodik (Demo)".

Persediaan pada perusahaan ini TIDAK dijurnal per transaksi (periodik): pembelian bahan masuk ke akun Pembelian, tenaga kerja dan overhead ke akun biayanya,
dan nilai persediaan baru disesuaikan lewat jurnal COGM setelah stock opname. Perusahaan terpisah dipakai supaya laporan perusahaan utama (yang memakai
jurnal perpetual, skema 1) tidak tercampur. Isinya dua bulan terakhir:

* bulan sebelum bulan lalu: kertas kerja COGM sudah dieksekusi (Terposting, Control Balance Hijau), dengan satu selisih opname yang dijelaskan; saat Execute
  stok sistem disamakan dengan hasil opname (tanpa penyesuaian manual) dan biaya produk diperbarui ke rata-rata tertimbang;
* bulan lalu, dua kertas kerja dari buku besar yang sama: satu **Hijau dan belum dieksekusi** (tombol Execute aktif) dan satu **Merah** karena salah ketik
  pada hasil opname (260 seharusnya 20). Perbaiki angkanya pada yang Merah, simpan, lalu periksa: Hijau. Bila yang Hijau dieksekusi lebih dulu, yang lain
  menjadi Merah karena periodenya sudah terposting. Harga beli bulan lalu naik (3 sampai 6 persen) sehingga biaya rata-rata tertimbang berbeda dari biaya
  produk; Execute memperbarui biaya produk dan menyesuaikan stok, Reverse mengembalikannya.

Dijalankan lewat `odoo shell` (variabel `env` disediakan shell); database harus sudah memasang kompakapps_base. Aman dijalankan ulang: bila perusahaannya sudah
ada, tidak ada yang diubah.

    docker compose run --rm -T odoo odoo shell -d kompakapps --no-http < scripts/seed_cogm_demo.py
"""

from datetime import date, datetime, time, timedelta

from odoo import Command

NAME = "PROLINE Periodik (Demo)"
if env["res.company"].search([("name", "=", NAME)]):
    print(f"{NAME} sudah ada; tidak ada yang diubah.")
    raise SystemExit(0)

first_this_month = date.today().replace(day=1)
m2_to = first_this_month - timedelta(days=1)  # bulan lalu (draft Merah)
m2_from = m2_to.replace(day=1)
m1_to = m2_from - timedelta(days=1)  # bulan sebelumnya (dieksekusi)
m1_from = m1_to.replace(day=1)
opening_day = m1_from - timedelta(days=1)


def at(day, hour=3):
    """Waktu (UTC) pada tanggal tertentu; jam 03.00 UTC = 10.00 WIB."""
    return datetime.combine(day, time(hour, 0))


company = env["res.company"].create({"name": NAME})
env.ref("base.user_admin").write({"company_ids": [Command.link(company.id)]})
company.kompakapps_setup_indonesia()
company.kompakapps_setup_warehouse()
company.write({"inventory_valuation": "periodic", "anglo_saxon_accounting": False})  # skema 2: tanpa jurnal per transaksi
company.kompakapps_setup_cogm()
env = env(context={**env.context, "allowed_company_ids": [company.id]})
company = env["res.company"].browse(company.id)


def account(code):
    return env["account.account"].with_company(company).search([("code", "=", code), ("company_ids", "in", company.id)], limit=1)


def first_account(account_type, name=None):
    domain = [("account_type", "=", account_type), ("company_ids", "in", company.id)]
    found = env["account.account"].with_company(company).search(domain + ([("name", "ilike", name)] if name else []), limit=1)
    return found or env["account.account"].with_company(company).search(domain, limit=1)


config = env["kompakapps.cogm.config"].search([("company_id", "=", company.id)])
config.account_ids.filtered(lambda m: m.account_id == account("51300020")).pct = 70.0  # listrik: 70% dipakai pabrik
raw_acc, wip_acc = config.raw_account_id, config.wip_account_id
purchases, freight, returns = account("51000020"), account("51000021"), account("51000022")
labor, indirect, power, depreciation, maintenance, supplies = (account(c) for c in ("51200010", "51300010", "51300020", "51300030", "51300040", "51300050"))
payable_other = first_account("liability_current")
accumulated = first_account("asset_fixed", "Accumulated") or payable_other
equity = first_account("equity")
misc = env["account.journal"].search([("company_id", "=", company.id), ("type", "=", "general"), ("code", "=", "MISC")], limit=1)

# Bahan baku: biaya standar, di bawah kategori berakuntansi periodik yang pembeliannya ke akun Pembelian.
category = env["product.category"].create({"name": "Bahan Baku Produksi (Demo Periodik)"})
category.with_company(company).write({"property_valuation": "periodic", "property_cost_method": "standard", "property_account_expense_categ_id": purchases.id})
RAW = [
    # kode, nama, satuan, biaya, stok awal, beli (bulan 1, bulan 2), pakai (bulan 1, bulan 2), hitung fisik (bulan 1, bulan 2)
    ("RM-REG-KOL", "Reagen Kolesterol Konsentrat", "uom.product_uom_litre", 900000, 40, (60, 50), (55, 52), (45, 43)),
    ("RM-ENZ-CHO", "Enzim Cholesterol Oxidase (vial)", "uom.product_uom_unit", 2400000, 6, (8, 6), (7, 6), (7, 7)),
    ("RM-BTL-50", "Botol Reagen 50 ml", "uom.product_uom_unit", 3500, 4000, (6000, 5000), (7500, 6000), (2480, 1470)),
    ("RM-LBL-KIT", "Label dan Kemasan Kit", "uom.product_uom_unit", 2200, 3500, (5000, 4500), (6800, 5800), (1700, 400)),
    ("RM-BUF-FOS", "Buffer Fosfat (kg)", "uom.product_uom_kgm", 350000, 30, (40, 30), (44, 35), (25, 20)),
]
products = {}
for code, name, uom, cost, *_ in RAW:
    products[code] = env["product.product"].with_company(company).create(
        {
            "name": name, "default_code": code, "type": "consu", "is_storable": True, "categ_id": category.id, "company_id": company.id, "uom_id": env.ref(uom).id,
            "taxes_id": [Command.clear()], "supplier_taxes_id": [Command.clear()], "standard_price": float(cost),
        }
    )

# Kenaikan harga beli per bahan pada bulan kedua (bulan pertama sama dengan biaya produk).
PRICE_UP = {"RM-REG-KOL": 1.05, "RM-ENZ-CHO": 1.03, "RM-BTL-50": 1.0, "RM-LBL-KIT": 1.04, "RM-BUF-FOS": 1.06}
warehouse = env["stock.warehouse"].search([("company_id", "=", company.id)], limit=1)
stock_loc = warehouse.lot_stock_id
production_loc = env["stock.location"].search([("usage", "=", "production"), ("company_id", "=", company.id)], limit=1)
vendors = {
    key: env["res.partner"].create({"name": name, "is_company": True, "supplier_rank": 1, "company_id": company.id})
    for key, name in (("kimia", "PT Kimia Medika Nusantara"), ("kemasan", "CV Kemasan Sejahtera"), ("ekspedisi", "PT Ekspedisi Cepat"), ("listrik", "PLN Unit Pabrik"))
}


def stamp(records_moves, when):
    records_moves.write({"date": when})
    records_moves.move_line_ids.write({"date": when})


def adjust_stock(product, qty, when):
    """Samakan stok sistem dengan jumlah tertentu (stok awal atau penyesuaian hasil opname); tanpa selisih tidak ada pergerakan."""
    known = env["stock.move"].search([("product_id", "=", product.id), ("is_inventory", "=", True), ("company_id", "=", company.id)]).ids
    env["stock.quant"].with_context(inventory_mode=True).create({"product_id": product.id, "location_id": stock_loc.id, "inventory_quantity": qty}).action_apply_inventory()
    stamp(env["stock.move"].search([("product_id", "=", product.id), ("is_inventory", "=", True), ("company_id", "=", company.id), ("id", "not in", known)]), when)


def consume(product, qty, when):
    """Pemakaian bahan ke produksi: kartu stok berkurang, tanpa jurnal (periodik)."""
    move = env["stock.move"].create(
        {
            "product_id": product.id, "product_uom_qty": qty, "product_uom": product.uom_id.id, "location_id": stock_loc.id,
            "location_dest_id": production_loc.id, "company_id": company.id,
        }
    )
    move._action_confirm()
    move._action_assign()
    move.write({"quantity": qty, "picked": True})
    move._action_done()
    stamp(move, when)


def purchase(vendor, when, lines):
    """PO, penerimaan barang, lalu tagihan terposting (Dr Pembelian). lines = [(produk, jumlah, harga satuan)]."""
    order = env["purchase.order"].create(
        {
            "partner_id": vendor.id, "date_order": when, "company_id": company.id,
            "order_line": [Command.create({"product_id": p.id, "product_qty": q, "price_unit": price, "tax_ids": [Command.clear()]}) for p, q, price in lines],
        }
    )
    order.button_confirm()
    picking = order.picking_ids
    picking.action_assign()
    for move in picking.move_ids:
        move.write({"quantity": move.product_uom_qty, "picked": True})
    picking.button_validate()
    picking.write({"date_done": when})
    stamp(picking.move_ids, when)
    action = order.action_create_invoice()
    bill = env["account.move"].browse(action["res_id"]) if action.get("res_id") else order.invoice_ids
    bill.write({"invoice_date": when.date(), "date": when.date(), "ref": f"INV-{order.name}"})
    bill.action_post()
    return bill


def expense_bill(vendor, day, acc, amount, label, move_type="in_invoice"):
    bill = env["account.move"].create(
        {
            "move_type": move_type, "partner_id": vendor.id, "invoice_date": day, "date": day, "company_id": company.id, "ref": label,
            "invoice_line_ids": [Command.create({"name": label, "account_id": acc.id, "quantity": 1.0, "price_unit": amount, "tax_ids": [Command.clear()]})],
        }
    )
    bill.action_post()


def journal(day, ref, lines):
    move = env["account.move"].create(
        {"move_type": "entry", "journal_id": misc.id, "date": day, "ref": ref, "line_ids": [Command.create({"account_id": a.id, "debit": d, "credit": c, "name": ref}) for a, d, c in lines]}
    )
    move.action_post()


# ---- saldo awal (akhir dua bulan lalu) ----
for code, _name, _uom, cost, opening, *_ in RAW:
    adjust_stock(products[code], float(opening), at(opening_day))
opening_raw = float(sum(cost * opening for _c, _n, _u, cost, opening, *_ in RAW))
opening_wip = 12_000_000.0
journal(opening_day, "Saldo awal persediaan", [(raw_acc, opening_raw, 0.0), (wip_acc, opening_wip, 0.0), (equity, 0.0, opening_raw + opening_wip)])


def run_month(index, first, last, spec):
    """Transaksi satu bulan: pembelian, pemakaian, tenaga kerja, dan overhead."""
    receipts = [(products[r[0]], float(r[5][index]), round(r[3] * (PRICE_UP[r[0]] if index else 1.0), 2)) for r in RAW if r[5][index]]
    purchase(vendors["kimia"], at(first + timedelta(days=4)), [r for r in receipts if r[0].default_code in ("RM-REG-KOL", "RM-ENZ-CHO", "RM-BUF-FOS")])
    purchase(vendors["kemasan"], at(first + timedelta(days=9)), [r for r in receipts if r[0].default_code in ("RM-BTL-50", "RM-LBL-KIT")])
    expense_bill(vendors["ekspedisi"], first + timedelta(days=10), freight, spec["freight"], "Ongkos angkut pembelian bahan baku")
    if spec["returns"]:
        expense_bill(vendors["kemasan"], first + timedelta(days=12), returns, spec["returns"], "Retur botol reagen rusak", move_type="in_refund")
    for code, _n, _u, _c, _o, _b, used, _count in RAW:
        consume(products[code], float(used[index]), at(first + timedelta(days=14)))
    journal(last, "Upah tenaga kerja langsung", [(labor, spec["labor"], 0.0), (payable_other, 0.0, spec["labor"])])
    journal(last, "Tenaga kerja tidak langsung pabrik", [(indirect, spec["indirect"], 0.0), (payable_other, 0.0, spec["indirect"])])
    expense_bill(vendors["listrik"], first + timedelta(days=20), power, spec["power"], "Tagihan listrik pabrik dan kantor")
    journal(last, "Penyusutan mesin dan peralatan pabrik", [(depreciation, spec["depreciation"], 0.0), (accumulated, 0.0, spec["depreciation"])])
    journal(last, "Perawatan mesin pabrik", [(maintenance, spec["maintenance"], 0.0), (payable_other, 0.0, spec["maintenance"])])
    journal(last, "Bahan penolong dan perlengkapan pabrik", [(supplies, spec["supplies"], 0.0), (payable_other, 0.0, spec["supplies"])])


def worksheet(first, last, index, wip_lines, note, counts=None):
    """Kertas kerja dengan hasil opname dari RAW; `counts` menimpa jumlah fisik per kode (mis. salah ketik)."""
    sheet = env["kompakapps.cogm.worksheet"].create({"company_id": company.id, "date_from": first, "date_to": last, "note": note})
    explanation = {"RM-BUF-FOS": "Tumpah saat penimbangan, sudah dibuang dan dicatat gudang"} if index == 0 else {}
    counts = counts or {}
    sheet.write(
        {
            "opname_ids": [Command.create({"product_id": products[r[0]].id, "qty": float(counts.get(r[0], r[7][index])), "explanation": explanation.get(r[0], False)}) for r in RAW],
            "wip_ids": [Command.create(line) for line in wip_lines],
        }
    )
    sheet.action_pull()
    return sheet


# ---- bulan pertama: dieksekusi ----
run_month(0, m1_from, m1_to, {"freight": 1_850_000.0, "returns": 2_000_000.0, "labor": 38_500_000.0, "indirect": 9_200_000.0, "power": 14_000_000.0, "depreciation": 6_750_000.0, "maintenance": 3_100_000.0, "supplies": 2_450_000.0})
sheet1 = worksheet(
    m1_from, m1_to, 0,
    [
        {"name": "Batch Kit Kolesterol", "qty": 200.0, "material_cost": 18000.0, "material_pct": 100.0, "conversion_cost": 9000.0, "completion_pct": 60.0},
        {"name": "Batch Kit Glukosa", "qty": 150.0, "material_cost": 15000.0, "material_pct": 100.0, "conversion_cost": 8000.0, "completion_pct": 40.0},
    ],
    "Contoh sudah dieksekusi. Buffer Fosfat selisih 1 kg (di atas toleransi) dijelaskan di kolom Alasan Selisih.",
)
result = sheet1.action_check()
assert result["state"] == "green", [c for c in result["checks"] if c["status"] == "error"]
sheet1.action_post()
for row in RAW:  # Execute sudah menyamakan stok sistem dengan hasil hitung fisik dan memperbarui biaya produk
    product = products[row[0]]
    assert product.qty_available == float(row[7][0]), (product.name, product.qty_available, row[7][0])

# ---- bulan kedua: satu kertas kerja Hijau (siap Execute) dan satu Merah (salah ketik), dari buku besar yang sama ----
run_month(1, m2_from, m2_to, {"freight": 1_600_000.0, "returns": 0.0, "labor": 41_200_000.0, "indirect": 9_600_000.0, "power": 15_300_000.0, "depreciation": 6_750_000.0, "maintenance": 4_900_000.0, "supplies": 2_700_000.0})
wip2 = [
    {"name": "Batch Kit Kolesterol", "qty": 180.0, "material_cost": 18000.0, "material_pct": 100.0, "conversion_cost": 9000.0, "completion_pct": 50.0},
    {"name": "Batch Kit Glukosa", "qty": 120.0, "material_cost": 15000.0, "material_pct": 100.0, "conversion_cost": 8000.0, "completion_pct": 70.0},
]
sheet2 = worksheet(m2_from, m2_to, 1, wip2, "Contoh HIJAU: semua pemeriksaan lolos, tombol Execute Jurnal COGM aktif. Setelah dieksekusi, kertas kerja Merah di periode yang sama ikut Merah karena periodenya sudah terposting.")
sheet3 = worksheet(
    m2_from, m2_to, 1, wip2,
    "Contoh MERAH: Buffer Fosfat tertulis 260 kg padahal stok sistem 20 kg (salah ketik). Control Balance Merah dan Execute terkunci sampai angkanya diperbaiki menjadi 20, disimpan, lalu diperiksa ulang.",
    counts={"RM-BUF-FOS": 260.0},
)
green, red = sheet2.action_check(), sheet3.action_check()
assert green["state"] == "green", [c for c in green["checks"] if c["status"] == "error"]
assert [c["key"] for c in red["checks"] if c["status"] == "error"] == ["variance"], red
env.cr.commit()
print(f"{NAME}: perusahaan id {company.id}")
print(f"  {sheet1.name} {m1_from}..{m1_to}: COGM {sheet1.cogm:,.0f} (Terposting, jurnal {sheet1.move_id.name})")
print(f"  {sheet2.name} {m2_from}..{m2_to}: COGM {sheet2.cogm:,.0f} (draft, Control Balance {green['state']})")
print(f"  {sheet3.name} {m2_from}..{m2_to}: COGM {sheet3.cogm:,.0f} (draft, Control Balance {red['state']}: {[c['key'] for c in red['checks'] if c['status'] == 'error']})")
