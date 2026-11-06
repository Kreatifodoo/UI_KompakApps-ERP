# ruff: noqa: F821
"""Data contoh COGM periodik dengan volume besar (Q71): perusahaan terpisah "PROLINE Manufaktur (Demo)".

Berbeda dari `seed_cogm_demo.py` (produksi dan stok disesuaikan lewat penyesuaian stok) dan `seed_cogm_cases.py` (satu kasus per perusahaan), perusahaan ini berisi
alur dokumen yang lengkap selama tiga bulan terakhir supaya daftar Manufacturing Order, Sales Order, pengiriman, faktur, dan stok terisi banyak:

* produk master baru: 12 bahan baku dan kemasan, 5 barang jadi (kit reagen) beserta BoM, 10 pelanggan, 4 pemasok;
* tiap bulan: pembelian bahan (6 PO, penerimaan barang, tagihan), ongkos angkut, tagihan listrik, upah dan overhead pabrik, Manufacturing Order selesai
  (batch 100 atau 200 kit; komponen terpakai sesuai BoM, barang jadi masuk gudang; qty-nya menjadi pembagi HPP per unit), Sales Order yang dikonfirmasi, dikirim, difakturkan, dan
  sebagian sudah dibayar, serta HPP sementara pada tiap penjualan (Dr HPP, Cr Inventory COGM, bertanda produk);
* kertas kerja COGM tiap bulan dari buku besar: bulan pertama dan kedua sudah dieksekusi (Terposting), bulan lalu Hijau dan siap Execute. Hasil hitung fisik
  mengikuti stok sistem kecuali beberapa selisih kecil yang dijelaskan. Bulan berjalan (sampai kemarin) juga berisi PO, MO, SO, dan faktur, tetapi belum
  ada biaya akhir bulan dan kertas kerja karena periodenya belum selesai (saldo Inventory COGM sementara negatif oleh HPP sementara, seperti pada periodik).

Persediaan perusahaan ini periodik (tanpa jurnal per transaksi stok); pembelian masuk akun Pembelian, dan nilai persediaan baru disesuaikan lewat jurnal COGM.
Aman dijalankan ulang: bila perusahaannya sudah ada, tidak ada yang diubah. `COGM_VOLUME_SCALE` (bawaan 1) memperkecil volume untuk uji cepat.
Dijalankan lewat `odoo shell` (variabel `env` disediakan shell) pada database yang sudah memasang kompakapps_base:

    docker compose run --rm -T odoo odoo shell -d kompakapps --no-http < scripts/seed_cogm_volume.py
"""

import math
import os
import random
from datetime import date, datetime, time, timedelta

from odoo import Command

NAME = "PROLINE Manufaktur (Demo)"
SCALE = float(os.environ.get("COGM_VOLUME_SCALE", "1"))
BASE_ENV = env
if BASE_ENV["res.company"].search([("name", "=", NAME)]):
    print(f"{NAME} sudah ada; tidak ada yang diubah.")
    raise SystemExit(0)

rnd = random.Random(20261106)
today = date.today()
months = []
cursor = today.replace(day=1)
for _ in range(3):  # tiga bulan penuh terakhir, dari yang paling lama
    last_day = cursor - timedelta(days=1)
    first_day = last_day.replace(day=1)
    months.insert(0, (first_day, last_day))
    cursor = first_day
opening_day = months[0][0] - timedelta(days=1)


def at(day, hour=3):
    """Waktu (UTC) pada tanggal tertentu; jam 03.00 UTC = 10.00 WIB."""
    return datetime.combine(day, time(hour, 0))


def plus(day, days):
    return day + timedelta(days=days)


# ---- master data ----
# kode, nama, satuan, biaya (Rp), faktor harga beli per bulan
RAW = [
    ("RM-REG-KOL", "Reagen Kolesterol Konsentrat", "uom.product_uom_litre", 900000, (1.00, 1.04, 1.04)),
    ("RM-REG-GLU", "Reagen Glukosa Konsentrat", "uom.product_uom_litre", 780000, (1.00, 1.00, 1.03)),
    ("RM-REG-TRI", "Reagen Trigliserida Konsentrat", "uom.product_uom_litre", 1050000, (1.00, 1.02, 1.05)),
    ("RM-REG-KRE", "Reagen Kreatinin Konsentrat", "uom.product_uom_litre", 1200000, (1.00, 1.00, 1.06)),
    ("RM-REG-URI", "Reagen Asam Urat Konsentrat", "uom.product_uom_litre", 950000, (1.00, 1.03, 1.03)),
    ("RM-ENZ-CHO", "Enzim Cholesterol Oxidase (vial)", "uom.product_uom_unit", 1000000, (1.00, 1.03, 1.03)),
    ("RM-ENZ-GOD", "Enzim Glucose Oxidase (vial)", "uom.product_uom_unit", 800000, (1.00, 1.00, 1.04)),
    ("RM-BUF-FOS", "Buffer Fosfat (kg)", "uom.product_uom_kgm", 350000, (1.00, 1.05, 1.05)),
    ("RM-BUF-TRS", "Buffer Tris (kg)", "uom.product_uom_kgm", 420000, (1.00, 1.00, 1.02)),
    ("RM-BTL-50", "Botol Reagen 50 ml", "uom.product_uom_unit", 3500, (1.00, 1.00, 1.00)),
    ("RM-LBL-KIT", "Label dan Kemasan Kit", "uom.product_uom_unit", 2200, (1.00, 1.04, 1.04)),
    ("RM-BOX-KIT", "Box Kit Karton", "uom.product_uom_unit", 3000, (1.00, 1.00, 1.05)),
]
SUPPLIER_OF = {
    "RM-REG-KOL": "kimia", "RM-REG-GLU": "kimia", "RM-REG-TRI": "kimia", "RM-REG-KRE": "kimia", "RM-REG-URI": "kimia", "RM-BUF-FOS": "kimia", "RM-BUF-TRS": "kimia",
    "RM-ENZ-CHO": "enzim", "RM-ENZ-GOD": "enzim", "RM-BTL-50": "kemasan", "RM-LBL-KIT": "kemasan", "RM-BOX-KIT": "kemasan",
}
# kode, nama, harga jual, biaya standar awal (perkiraan HPP sementara), stok awal, qty produksi per bulan (dipecah menjadi Manufacturing Order 100 atau 200 kit)
FINISHED = [
    ("FG-KIT-KOL", "Kit Reagen Kolesterol 4 x 50 ml", 150000, 98000, 300, (1200, 1300, 1100)),
    ("FG-KIT-GLU", "Kit Reagen Glukosa 4 x 50 ml", 140000, 95000, 200, (900, 1000, 1000)),
    ("FG-KIT-TRI", "Kit Reagen Trigliserida 4 x 50 ml", 165000, 100000, 150, (600, 700, 700)),
    ("FG-KIT-KRE", "Kit Reagen Kreatinin 4 x 50 ml", 185000, 104000, 100, (400, 500, 500)),
    ("FG-KIT-URI", "Kit Reagen Asam Urat 4 x 50 ml", 155000, 97000, 100, (300, 400, 400)),
]
# komponen per kit (kuantitas BoM hanya mendukung 2 desimal, jadi koefisien berkelipatan 0,01)
BOM = {
    "FG-KIT-KOL": (("RM-REG-KOL", 0.04), ("RM-ENZ-CHO", 0.01), ("RM-BUF-FOS", 0.02), ("RM-BTL-50", 4), ("RM-LBL-KIT", 1), ("RM-BOX-KIT", 1)),
    "FG-KIT-GLU": (("RM-REG-GLU", 0.04), ("RM-ENZ-GOD", 0.01), ("RM-BUF-FOS", 0.02), ("RM-BTL-50", 4), ("RM-LBL-KIT", 1), ("RM-BOX-KIT", 1)),
    "FG-KIT-TRI": (("RM-REG-TRI", 0.04), ("RM-ENZ-CHO", 0.01), ("RM-BUF-TRS", 0.02), ("RM-BTL-50", 4), ("RM-LBL-KIT", 1), ("RM-BOX-KIT", 1)),
    "FG-KIT-KRE": (("RM-REG-KRE", 0.04), ("RM-BUF-TRS", 0.03), ("RM-BTL-50", 4), ("RM-LBL-KIT", 1), ("RM-BOX-KIT", 1)),
    "FG-KIT-URI": (("RM-REG-URI", 0.04), ("RM-ENZ-GOD", 0.01), ("RM-BUF-FOS", 0.02), ("RM-BTL-50", 4), ("RM-LBL-KIT", 1), ("RM-BOX-KIT", 1)),
}
CUSTOMERS = [  # nama, diskon dari harga jual
    ("RS Harapan Sehat", 0.05), ("Klinik Medika Prima", 0.03), ("Lab Klinik Sentra Diagnostik", 0.06), ("PT Mitra Alkes Distribusi", 0.10),
    ("RSUD Kabupaten Sukamaju", 0.04), ("Dinas Kesehatan Kota Sukamaju", 0.08), ("Lab Klinik Bunda Sejahtera", 0.02), ("PT Graha Medika Niaga", 0.09),
    ("Klinik Pratama Sehat Sentosa", 0.0), ("RS Ibu dan Anak Permata", 0.05),
]
VENDORS = {
    "kimia": "PT Kimia Medika Nusantara", "enzim": "PT Enzim Biotek Indonesia", "kemasan": "CV Kemasan Sejahtera", "ekspedisi": "PT Ekspedisi Cepat", "listrik": "PLN Unit Pabrik",
    "umum": "CV Jasa Pabrik Sejahtera",
}
# biaya per bulan (Rp): upah, TK tidak langsung, listrik, penyusutan, perawatan, bahan penolong, ongkos angkut (dua tagihan), retur pembelian
COSTS = [
    {"labor": 62_000_000, "indirect": 14_000_000, "power": 24_500_000, "depreciation": 11_500_000, "maintenance": 5_200_000, "supplies": 3_800_000, "freight": (1_900_000, 2_150_000), "returns": 2_400_000},
    {"labor": 64_500_000, "indirect": 14_400_000, "power": 26_100_000, "depreciation": 11_500_000, "maintenance": 7_900_000, "supplies": 4_300_000, "freight": (2_050_000, 2_300_000), "returns": 0},
    {"labor": 66_200_000, "indirect": 14_800_000, "power": 25_300_000, "depreciation": 11_500_000, "maintenance": 6_100_000, "supplies": 4_700_000, "freight": (2_200_000, 2_450_000), "returns": 0},
]
OPENING_WIP = 12_000_000
# selisih hitung fisik terhadap stok sistem per bulan: {kode: (selisih qty, alasan atau None)}
RAW_VARIANCE = [
    {"RM-BUF-FOS": (-1.0, "Tumpah saat penimbangan, sudah dibuang dan dicatat gudang"), "RM-BTL-50": (-30.0, "Botol pecah saat bongkar muat di gudang")},
    {"RM-ENZ-CHO": (-1.0, "Vial pecah saat penerimaan, berita acara gudang terlampir"), "RM-LBL-KIT": (-40.0, "Label cacat cetak dibuang saat pengemasan")},
    {"RM-BTL-50": (-20.0, "Botol retak ditemukan saat hitung fisik")},
]
FG_VARIANCE = [{"FG-KIT-GLU": (-2.0, "Rusak saat pengemasan")}, {"FG-KIT-KRE": (-1.0, "Kit sampel dipakai pameran")}, {}]
WIP_LINES = [
    [("Batch Kit Kolesterol", 200, 20000, 100, 9500, 60), ("Batch Kit Glukosa", 150, 17000, 100, 8500, 40)],
    [("Batch Kit Trigliserida", 180, 21000, 100, 9000, 50), ("Batch Kit Glukosa", 120, 17500, 100, 8500, 70)],
    [("Batch Kit Kolesterol", 220, 20500, 100, 9500, 55), ("Batch Kit Kreatinin", 100, 24000, 100, 10000, 45)],
]


def scaled(qty, factor=1.0):
    """Qty produksi dibulatkan ke kelipatan 100, setelah skala uji dan faktor sebagian bulan."""
    return max(100, int(round(qty * SCALE * factor / 100.0)) * 100)


class Demo:
    """Perusahaan demo periodik lengkap dengan akun COGM dan fungsi bantu dokumen."""

    def __init__(self, name):
        company = BASE_ENV["res.company"].create({"name": name})
        BASE_ENV.ref("base.user_admin").write({"company_ids": [Command.link(company.id)]})
        company.kompakapps_setup_indonesia()
        company.kompakapps_setup_warehouse()
        company.write({"inventory_valuation": "periodic", "anglo_saxon_accounting": False})
        company.kompakapps_setup_cogm()
        self.env = BASE_ENV(context={**BASE_ENV.context, "allowed_company_ids": [company.id]})
        self.company = self.env["res.company"].browse(company.id)
        self.config = self.env["kompakapps.cogm.config"].search([("company_id", "=", company.id)])
        self.raw_acc, self.wip_acc, self.fg_acc, self.cogs_acc = self.config.raw_account_id, self.config.wip_account_id, self.config.fg_account_id, self.config.cogs_account_id
        self.purchases, self.returns = self.account("51000020"), self.account("51000022")
        self.freight = self.account("51000021")
        self.labor, self.indirect, self.power = self.account("51200010"), self.account("51300010"), self.account("51300020")
        self.depreciation, self.maintenance, self.supplies = self.account("51300030"), self.account("51300040"), self.account("51300050")
        self.config.account_ids.filtered(lambda mapped: mapped.account_id == self.power).pct = 70.0  # listrik: 70% dipakai pabrik
        self.payable = self.first_account("liability_current")
        self.accumulated = self.first_account("asset_fixed", "Accumulated") or self.payable
        self.equity = self.first_account("equity")
        self.misc = self.env["account.journal"].search([("company_id", "=", company.id), ("type", "=", "general"), ("code", "=", "MISC")], limit=1)
        self.bank = self.env["account.journal"].search([("company_id", "=", company.id), ("type", "=", "bank")], limit=1)
        self.category = self.env["product.category"].create({"name": f"Persediaan Periodik ({name})"})
        self.category.with_company(self.company).write({"property_valuation": "periodic", "property_cost_method": "standard", "property_account_expense_categ_id": self.purchases.id})
        warehouse = self.env["stock.warehouse"].search([("company_id", "=", company.id)], limit=1)
        self.stock_loc = warehouse.lot_stock_id
        self.production_loc = self.env["stock.location"].search([("usage", "=", "production"), ("company_id", "=", company.id)], limit=1)
        self.vendors = {key: self.partner(label, supplier=True) for key, label in VENDORS.items()}
        self.customers = [(self.partner(label), discount) for label, discount in CUSTOMERS]
        self.products = {}
        self.stats = {"po": 0, "mo": 0, "so": 0, "invoice": 0, "payment": 0}

    # ---- akun, mitra, produk ----
    def account(self, code):
        return self.env["account.account"].with_company(self.company).search([("code", "=", code), ("company_ids", "in", self.company.id)], limit=1)

    def first_account(self, account_type, name=None):
        domain = [("account_type", "=", account_type), ("company_ids", "in", self.company.id)]
        found = self.env["account.account"].with_company(self.company).search(domain + ([("name", "ilike", name)] if name else []), limit=1)
        return found or self.env["account.account"].with_company(self.company).search(domain, limit=1)

    def partner(self, name, supplier=False):
        vals = {"name": name, "is_company": True, "company_id": self.company.id, "supplier_rank" if supplier else "customer_rank": 1}
        return self.env["res.partner"].create(vals)

    def product(self, code, name, cost, uom="uom.product_uom_unit"):
        record = self.env["product.product"].with_company(self.company).create(
            {
                "name": name, "default_code": code, "type": "consu", "is_storable": True, "categ_id": self.category.id, "company_id": self.company.id,
                "uom_id": self.env.ref(uom).id, "taxes_id": [Command.clear()], "supplier_taxes_id": [Command.clear()], "standard_price": float(cost),
            }
        )
        self.products[code] = record
        return record

    # ---- stok ----
    def stamp(self, moves, when):
        moves.write({"date": when})
        moves.move_line_ids.write({"date": when})

    def adjust_stock(self, product, qty, when):
        domain = [("product_id", "=", product.id), ("is_inventory", "=", True), ("company_id", "=", self.company.id)]
        known = self.env["stock.move"].search(domain).ids
        self.env["stock.quant"].with_context(inventory_mode=True).create({"product_id": product.id, "location_id": self.stock_loc.id, "inventory_quantity": qty}).action_apply_inventory()
        self.stamp(self.env["stock.move"].search([*domain, ("id", "not in", known)]), when)

    def stock(self, product):
        return product.with_company(self.company).qty_available

    def ship(self, picking, when):
        picking.action_assign()
        for move in picking.move_ids:
            move.write({"quantity": move.product_uom_qty, "picked": True})
        picking.button_validate()
        picking.write({"date_done": when, "scheduled_date": when})
        self.stamp(picking.move_ids, when)

    # ---- akuntansi ----
    def journal(self, day, ref, lines):
        self.env["account.move"].create(
            {"move_type": "entry", "journal_id": self.misc.id, "date": day, "ref": ref, "line_ids": [Command.create({"account_id": a.id, "debit": d, "credit": c, "name": ref}) for a, d, c in lines]}
        ).action_post()

    def expense_bill(self, vendor, day, account, amount, label, move_type="in_invoice"):
        self.env["account.move"].create(
            {
                "move_type": move_type, "partner_id": vendor.id, "invoice_date": day, "date": day, "company_id": self.company.id, "ref": label,
                "invoice_line_ids": [Command.create({"name": label, "account_id": account.id, "quantity": 1.0, "price_unit": amount, "tax_ids": [Command.clear()]})],
            }
        ).action_post()

    def purchase(self, vendor, when, lines):
        """PO, penerimaan barang, lalu tagihan terposting (Dr Pembelian). lines = [(produk, jumlah, harga satuan)]."""
        order = self.env["purchase.order"].create(
            {
                "partner_id": vendor.id, "date_order": when, "company_id": self.company.id,
                "order_line": [Command.create({"product_id": p.id, "product_qty": q, "price_unit": price, "tax_ids": [Command.clear()]}) for p, q, price in lines],
            }
        )
        order.button_confirm()
        self.ship(order.picking_ids, when)
        action = order.action_create_invoice()
        bill = self.env["account.move"].browse(action["res_id"]) if action.get("res_id") else order.invoice_ids
        bill.write({"invoice_date": when.date(), "date": when.date(), "ref": f"INV-{order.name}"})
        bill.action_post()
        self.stats["po"] += 1

    def costs(self, first, last, spec):
        for account, counter, amount, label in (
            (self.labor, self.payable, spec["labor"], "Upah tenaga kerja langsung"),
            (self.indirect, self.payable, spec["indirect"], "Tenaga kerja tidak langsung pabrik"),
            (self.depreciation, self.accumulated, spec["depreciation"], "Penyusutan mesin dan peralatan pabrik"),
            (self.maintenance, self.payable, spec["maintenance"], "Perawatan mesin pabrik"),
            (self.supplies, self.payable, spec["supplies"], "Bahan penolong dan perlengkapan pabrik"),
        ):
            self.journal(last, label, [(account, amount, 0.0), (counter, 0.0, amount)])
        self.expense_bill(self.vendors["listrik"], plus(first, 19), self.power, spec["power"], "Tagihan listrik pabrik dan kantor")
        for index, amount in enumerate(spec["freight"]):
            self.expense_bill(self.vendors["ekspedisi"], plus(first, 6 + 10 * index), self.freight, amount, "Ongkos angkut pembelian bahan baku")
        if spec["returns"]:
            self.expense_bill(self.vendors["kemasan"], plus(first, 12), self.returns, spec["returns"], "Retur botol reagen rusak", move_type="in_refund")

    # ---- manufacturing ----
    def manufacture(self, product, bom, qty, day):
        """Manufacturing Order selesai: komponen terpakai sesuai BoM dan barang jadi masuk gudang pada tanggal `day`."""
        when = at(day)
        order = self.env["mrp.production"].create({"product_id": product.id, "product_qty": float(qty), "bom_id": bom.id, "date_start": when, "company_id": self.company.id})
        order.action_confirm()
        order.qty_producing = float(qty)
        for move in order.move_raw_ids:
            move.write({"quantity": move.product_uom_qty, "picked": True})
        order.button_mark_done()
        self.stamp(order.move_raw_ids | order.move_finished_ids, when)
        order.write({"date_finished": when})
        assert order.state == "done", (order.name, order.state)
        self.stats["mo"] += 1
        return order

    # ---- penjualan ----
    def sell(self, customer, discount, day, lines):
        """Sales Order terkonfirmasi, dikirim, difakturkan, dan HPP sementara dibukukan; lines = [(produk, qty)]. Mengembalikan faktur."""
        order = self.env["sale.order"].create(
            {
                "partner_id": customer.id, "date_order": at(day, 4), "company_id": self.company.id,
                "order_line": [
                    Command.create({"product_id": p.id, "product_uom_qty": float(q), "price_unit": round(self.price[p.default_code] * (1 - discount), -2), "tax_ids": [Command.clear()]})
                    for p, q in lines
                ],
            }
        )
        order.action_confirm()
        order.write({"date_order": at(day, 4)})  # konfirmasi menimpa tanggal pesanan dengan waktu sekarang
        self.ship(order.picking_ids.filtered(lambda p: p.state not in ("done", "cancel")), at(day, 5))
        invoice = order._create_invoices()
        invoice.write({"invoice_date": day, "date": day})
        invoice.action_post()
        provisional = []
        for p, q in lines:  # HPP sementara per barang pada biaya produk saat ini; bertanda produk agar kertas kerja menghitungnya per barang jadi
            amount = p.standard_price * q
            provisional += [
                Command.create({"account_id": self.cogs_acc.id, "debit": amount, "credit": 0.0, "product_id": p.id, "name": f"HPP sementara {p.name}"}),
                Command.create({"account_id": self.fg_acc.id, "debit": 0.0, "credit": amount, "product_id": p.id, "name": f"HPP sementara {p.name}"}),
            ]
        self.env["account.move"].create({"move_type": "entry", "journal_id": self.misc.id, "date": day, "ref": f"HPP sementara {order.name}", "line_ids": provisional}).action_post()
        self.stats["so"] += 1
        self.stats["invoice"] += 1
        return invoice

    def pay(self, invoice, when):
        wizard = self.env["account.payment.register"].with_context(active_model="account.move", active_ids=invoice.ids).create({"journal_id": self.bank.id, "payment_date": when})
        wizard.action_create_payments()
        self.stats["payment"] += 1

    # ---- kertas kerja ----
    def worksheet(self, first, last, counts, wips, note):
        sheet = self.env["kompakapps.cogm.worksheet"].create({"company_id": self.company.id, "date_from": first, "date_to": last, "note": note})
        sheet.write(
            {
                "opname_ids": [Command.create({"product_id": p.id, "qty": float(q), "explanation": why or False}) for p, q, why in counts],
                "wip_ids": [Command.create({"name": n, "qty": float(q), "material_cost": float(mc), "material_pct": float(mp), "conversion_cost": float(cc), "completion_pct": float(cp)}) for n, q, mc, mp, cc, cp in wips],
            }
        )
        sheet.action_pull()
        return sheet


def split(total, parts):
    """Bagi `total` (kelipatan 10) menjadi `parts` bagian acak berkelipatan 10."""
    weights = [rnd.uniform(0.5, 1.6) for _ in range(parts)]
    amounts = [max(10, int(total * w / sum(weights) / 10) * 10) for w in weights]
    amounts[-1] = max(10, total - sum(amounts[:-1]))
    return amounts


demo = Demo(NAME)
company = demo.company
demo.price = {code: price for code, _n, price, *_ in FINISHED}
for code, name, uom, cost, _factors in RAW:
    demo.product(code, name, cost, uom)
for code, name, _price, std, *_ in FINISHED:
    demo.product(code, name, std)
boms = {}
for code, name, *_ in FINISHED:
    fg = demo.products[code]
    boms[code] = demo.env["mrp.bom"].create(
        {
            "product_tmpl_id": fg.product_tmpl_id.id, "product_qty": 1.0, "type": "normal", "company_id": company.id,
            "bom_line_ids": [Command.create({"product_id": demo.products[raw].id, "product_qty": qty}) for raw, qty in BOM[code]],
        }
    )


def need_for(index, factor=1.0):
    """Kebutuhan bahan baku bulan `index` (atau sebagian bulannya, `factor`) menurut rencana produksi dan BoM."""
    need = {}
    for code, _n, _p, _s, _o, monthly in FINISHED:
        produced = scaled(monthly[index], factor)
        for raw, per_kit in BOM[code]:
            need[raw] = need.get(raw, 0.0) + produced * per_kit
    return need


# ---- saldo awal: stok bahan baku (separuh kebutuhan bulan pertama), barang jadi, dan WIP ----
opening_raw = 0.0
for code, _name, _uom, cost, _f in RAW:
    qty = float(math.ceil(need_for(0)[code] * 0.5 / (100 if cost < 10000 else 1)) * (100 if cost < 10000 else 1))
    demo.adjust_stock(demo.products[code], qty, at(opening_day))
    opening_raw += qty * cost
opening_fg = 0.0
for code, _name, _price, std, opening_qty, _batches in FINISHED:
    demo.adjust_stock(demo.products[code], float(opening_qty), at(opening_day))
    opening_fg += opening_qty * std
demo.journal(
    opening_day, "Saldo awal persediaan",
    [(demo.raw_acc, opening_raw, 0.0), (demo.fg_acc, opening_fg, 0.0), (demo.wip_acc, OPENING_WIP, 0.0), (demo.equity, 0.0, opening_raw + opening_fg + OPENING_WIP)],
)

sheets = []


def activity(index, first, last, factor=1.0, close=True):
    """Satu bulan transaksi (atau bulan berjalan sampai kemarin bila `close` salah: tanpa biaya akhir bulan dan kertas kerja)."""
    need = need_for(index, factor)
    # pembelian bahan: dua tahap (hari ke-4 dan ke-17); target stok akhir sekitar 40% kebutuhan bulan itu
    plan = {}
    for code, _name, _uom, cost, factors in RAW:
        product = demo.products[code]
        step = 100 if cost < 10000 else 1
        buy = max(0.0, need[code] * 1.4 - demo.stock(product))
        plan[code] = float(math.ceil(buy / step) * step)
    cap = last.day - 1  # hari terakhir (selisih dari tanggal 1) yang boleh dipakai
    for stage, (day_offset, share) in enumerate(((3, 0.6), (16, 0.4)) if close else ((0, 0.7), (1, 0.3))):
        for supplier in ("kimia", "enzim", "kemasan"):
            lines = []
            for code, _name, _uom, cost, factors in RAW:
                if SUPPLIER_OF[code] != supplier or not plan[code]:
                    continue
                step = 100 if cost < 10000 else 1
                qty = math.ceil(plan[code] * share / step) * step
                lines.append((demo.products[code], float(qty), round(cost * factors[index], 2)))
            if lines:
                demo.purchase(demo.vendors[supplier], at(plus(first, min(day_offset + stage, cap))), lines)
    if close:
        demo.costs(first, last, COSTS[index])

    # Manufacturing Order: tiap batch satu MO; hari produksi tersebar sepanjang bulan
    batches = []
    for position, (code, *_rest, monthly) in enumerate(FINISHED):
        sizes, left = [], scaled(monthly[index], factor)
        while left > 0:
            sizes.append(min(left, rnd.choice((100, 200, 200))))
            left -= sizes[-1]
        for number, qty in enumerate(sizes):
            batches.append((min(1 + position + int(number * (24 if close else max(cap - 4, 0)) / len(sizes)), cap), code, qty))
    for day_offset, code, qty in sorted(batches):
        demo.manufacture(demo.products[code], boms[code], qty, plus(first, day_offset))

    # Sales Order: target jual 88 sampai 93 persen dari stok barang jadi yang ada; dipecah menjadi banyak pesanan
    chunks = []
    for code, *_rest in FINISHED:
        available = demo.stock(demo.products[code])
        target = int(available * rnd.uniform(0.88, 0.93) / 10) * 10
        chunks += [(code, qty) for qty in split(target, max(4, round(target / 60)))]
    rnd.shuffle(chunks)
    orders = []
    while chunks:
        group, seen = [chunks.pop()], set()
        seen.add(group[0][0])
        while chunks and len(group) < 3 and rnd.random() < 0.55:
            candidate = next((c for c in chunks if c[0] not in seen), None)
            if not candidate:
                break
            chunks.remove(candidate)
            group.append(candidate)
            seen.add(candidate[0])
        orders.append(group)
    days = sorted(rnd.randint(6, last.day - 3) if close else rnd.randint(min(2, last.day), last.day) for _ in orders)
    for day_number, group in zip(days, orders):
        customer, discount = rnd.choice(demo.customers)
        invoice = demo.sell(customer, discount, first.replace(day=day_number), [(demo.products[code], qty) for code, qty in group])
        due = plus(first.replace(day=day_number), rnd.choice((14, 21, 30)))
        if due <= today - timedelta(days=1) and rnd.random() < 0.85:
            demo.pay(invoice, due)

    # kertas kerja bulan ini: hitung fisik mengikuti stok sistem kecuali selisih kecil yang dijelaskan
    negative = [(code, round(demo.stock(demo.products[code]), 2)) for code, *_rest in RAW if demo.stock(demo.products[code]) < 0]
    assert not negative, f"stok bahan baku negatif pada {first:%Y-%m}: {negative}"
    if not close:
        return
    counts = []
    for code, *_rest in RAW:
        product = demo.products[code]
        delta, why = RAW_VARIANCE[index].get(code, (0.0, None))
        counts.append((product, round(demo.stock(product), 2) + delta, why))
    sheet = demo.worksheet(
        first, last, counts, WIP_LINES[index],
        f"Data volume bulan {first:%B %Y}: Manufacturing Order, Sales Order, pengiriman, faktur, dan pembayaran nyata; qty produksi dari MO selesai. "
        + ("Sudah dieksekusi (Terposting)." if index < 2 else "Hijau dan siap Execute."),
    )
    for code, (delta, why) in FG_VARIANCE[index].items():
        line = sheet.fg_ids.filtered(lambda row: row.product_id == demo.products[code])
        line.write({"qty": line.book_qty + delta, "explanation": why})
    result = sheet.action_check()
    errors = [(c["key"], c["message"]) for c in result["checks"] if c["status"] == "error"]
    assert result["state"] == "green", (sheet.name, errors)
    if index < 2:
        sheet.action_post()
        assert sheet.state == "posted", sheet.name
    sheets.append(sheet)



for index, (first, last) in enumerate(months):
    activity(index, first, last)
if today.day > 1:  # bulan berjalan sampai kemarin: dokumen sudah ada, tetapi belum ada biaya akhir bulan dan kertas kerja (periode belum selesai)
    activity(2, today.replace(day=1), today - timedelta(days=1), factor=(today.day - 1) / 30.0, close=False)

BASE_ENV.cr.commit()
print(f"{NAME}: perusahaan id {company.id}; dokumen: {demo.stats}")
for sheet in sheets:
    print(
        f"  {sheet.name} {sheet.date_from}..{sheet.date_to} {sheet.state}: COGM {sheet.cogm:,.0f}, qty {sheet.qty_produced:g}, HPP/unit {sheet.unit_cogm:,.2f}; "
        f"HPP penjualan {sheet.fg_cogs:,.0f}, sementara {sheet.fg_provisional:,.0f}, penyesuaian {sheet.fg_adjustment:,.0f}"
    )
