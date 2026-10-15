# ruff: noqa: F821
"""Katalog dan transaksi presales yang meniru lini produk PROLINE (kimia klinik, hematologi, imunologi, urinalisis, tes cepat, biomolekuler).

Jalankan SETELAH setup_tax_id.py, seed_presales.py, dan seed_presales_extra.py lewat `odoo shell`. Aman dijalankan ulang (berhenti bila produk PRL-BC240 sudah ada).

    docker compose run --rm -T --no-deps odoo odoo shell -d nusara --no-http < scripts/seed_presales_proline.py

Yang dibuat: identitas perusahaan demo (PROLINE (Demo), gudang di Jababeka, Cikarang), kategori produk per lini dengan penarikan FEFO, 24 produk
(instrumen ber-nomor seri; reagen, kontrol, dan tes cepat ber-lot dengan tanggal kedaluwarsa), daftar harga e-Katalog INAPROC dan distributor, tim
penjualan, rak dingin 2-8 C, pelanggan dan pemasok rekaan, lalu transaksi berurutan: CRM, Sales Order (diterima, dikirim sebagian, dan menunggu),
Purchase Request dan Purchase Order dengan penerimaan ber-lot, transfer ke rak dingin, Manufacturing Order kit kolesterol, tagihan, faktur, dan pembayaran,
semuanya dengan akun analitik dan beberapa aktivitas terjadwal. Nama pelanggan, pemasok, harga, dan jumlah adalah rekaan untuk demo; nama produk mengikuti
katalog di proline.co.id. Seluruh isi dikomit di akhir (bila ada galat, tidak ada yang tersimpan).
"""
import datetime
from odoo import Command, fields

admin = env.ref("base.user_admin")
env = env(user=admin)
company = env.company
today = fields.Date.today()
Product = env["product.product"]
if Product.search([("default_code", "=", "PRL-BC240")], limit=1):
    print("PROLINE_SKIP: katalog PROLINE sudah ada")
    raise SystemExit(0)
Tax = env["account.tax"]
sale_tax = Tax.search([("type_tax_use", "=", "sale"), ("name", "=", "VAT Out 11%"), ("company_id", "=", company.id)], limit=1)
buy_tax = Tax.search([("type_tax_use", "=", "purchase"), ("name", "=", "VAT In 11%"), ("company_id", "=", company.id)], limit=1)
pph23_buy = Tax.search([("type_tax_use", "=", "purchase"), ("name", "=", "PPh 23 -2%"), ("company_id", "=", company.id)], limit=1)
pph23_sale = Tax.search([("type_tax_use", "=", "sale"), ("name", "=", "PPh 23 -2% (dipotong pelanggan)"), ("company_id", "=", company.id)], limit=1)
if not (sale_tax and buy_tax and pph23_buy and pph23_sale) or not Product.search([("default_code", "=", "PRL-XI800")], limit=1):
    print("PROLINE_SKIP: jalankan setup_tax_id.py, seed_presales.py, dan seed_presales_extra.py lebih dulu")
    raise SystemExit(0)


def day(back):
    return today - datetime.timedelta(days=back)


def at(back, hour=10):
    return datetime.datetime.combine(day(back), datetime.time(hour, 0))


# ---------- identitas perusahaan demo ----------
id_country = env.ref("base.id")
company.write({"name": "PROLINE (Demo)", "street": "Kawasan Industri Jababeka III", "city": "Cikarang Utara, Bekasi", "zip": "17530", "country_id": id_country.id})
wh = env["stock.warehouse"].search([("company_id", "=", company.id), ("code", "=", "WH")], limit=1)
wh.name = "Gudang Utama Jababeka"
stock_loc = wh.lot_stock_id
cold = env["stock.location"].create({"name": "Rak Dingin 2-8C", "location_id": stock_loc.id, "usage": "internal"})
bank = env["account.journal"].search([("type", "=", "bank"), ("company_id", "=", company.id)], limit=1)

# ---------- kategori produk per lini (mewarisi setelan akuntansi Goods; penarikan stok FEFO) ----------
Categ = env["product.category"]
goods = env.ref("product.product_category_goods")
fefo = env.ref("product_expiry.removal_fefo", raise_if_not_found=False) or env["product.removal"].search([("method", "=", "fefo")], limit=1)
copy_vals = {}
for name, field in Categ._fields.items():
    if name.startswith("property_") and field.company_dependent:
        value = goods[name]
        copy_vals[name] = value.id if hasattr(value, "ids") else value


def categ(name):
    vals = {"name": name, "parent_id": goods.id, **copy_vals}
    if fefo and "removal_strategy_id" in Categ._fields:
        vals["removal_strategy_id"] = fefo.id
    return Categ.create(vals)


C_KIMIA, C_HEMA, C_IMUN, C_URIN, C_RAPID, C_BIO, C_KAL = (
    categ(n) for n in ("Kimia Klinik", "Hematologi", "Imunologi", "Urinalisis", "Tes Cepat", "Biomolekuler", "Kontrol dan Kalibrator")
)
for code, target in (
    ("PRL-XI800", C_IMUN), ("PRL-UA120", C_URIN), ("PRL-UA240", C_URIN), ("PRL-STRIP-100", C_URIN), ("PRL-STRIP-5P", C_URIN), ("PRL-PAKET-URINALISIS", C_URIN),
    ("PRL-RDT-DENGUE", C_RAPID), ("PRL-GLU-KIT", C_KIMIA), ("PRL-KRE-KIT", C_KIMIA), ("PRL-KONTROL-KK", C_KAL),
):
    Product.search([("default_code", "=", code)]).categ_id = target

# ---------- akun analitik: rencana Segmen Produk menambah dua rencana yang sudah ada ----------
Plan = env["account.analytic.plan"]
Analytic = env["account.analytic.account"]


def acc(name, plan):
    return Analytic.search([("name", "=", name), ("plan_id", "=", plan.id)], limit=1) or Analytic.create({"name": name, "plan_id": plan.id, "company_id": company.id})


plan_dep = Plan.search([("name", "=", "Departemen")], limit=1)
plan_line = Plan.search([("name", "=", "Lini Produk")], limit=1)
plan_seg = Plan.search([("name", "=", "Segmen Produk")], limit=1) or Plan.create({"name": "Segmen Produk"})
D_INST, D_REAG, D_BELI, D_PROD, D_MKT = (acc(n, plan_dep) for n in ("Penjualan Instrumen", "Penjualan Reagen dan Strip", "Pembelian dan Gudang", "Produksi", "Pemasaran"))
L_INST, L_REAG, L_STRIP, L_JASA = (acc(n, plan_line) for n in ("Instrumen", "Reagen dan Kit", "Strip dan Tes Cepat", "Jasa"))
SEG = {c.name: acc(c.name, plan_seg) for c in (C_KIMIA, C_HEMA, C_IMUN, C_URIN, C_RAPID, C_BIO, C_KAL)}
SEG["Jasa"] = acc("Jasa dan Layanan", plan_seg)


def dist(kind, product):
    """Distribusi analitik satu baris: departemen, lini produk, dan segmen produk (100% pada masing-masing rencana)."""
    code = product.default_code or ""
    instrument = product.tracking == "serial" or code in ("PRL-XI800", "PRL-UA120", "PRL-UA240")
    service = product.type == "service"
    line = L_JASA if service else L_INST if instrument else L_STRIP if product.categ_id in (C_RAPID, C_URIN) else L_REAG
    department = {"purchase": D_BELI, "production": D_PROD}.get(kind, D_INST if instrument or service else D_REAG)
    segment = SEG["Jasa"] if service else SEG.get(product.categ_id.name, SEG["Kimia Klinik"])
    return {f"{department.id},{line.id},{segment.id}": 100.0}


# ---------- mitra rekaan ----------
Partner = env["res.partner"]


def partner(name, city, street, kind, **extra):
    vals = {"name": name, "is_company": True, "city": city, "street": street, "country_id": id_country.id, "email": f"kontak@{name.split()[-1].lower()}.example", **extra}
    vals["supplier_rank" if kind == "vendor" else "customer_rank"] = 1
    return Partner.create(vals)


def existing(name):
    return Partner.search([("name", "=", name)], limit=1)


pl_ekat = env["product.pricelist"].create({"name": "Harga e-Katalog INAPROC", "item_ids": [Command.create({"applied_on": "3_global", "compute_price": "percentage", "percent_price": 3.0})]})
pl_dist = env["product.pricelist"].create({"name": "Harga Distributor", "item_ids": [Command.create({"applied_on": "3_global", "compute_price": "percentage", "percent_price": 12.0})]})
term_30 = env["account.payment.term"].search([("name", "ilike", "30 Days")], limit=1)
c_krw = partner("RSUD Kabupaten Karawang", "Karawang", "Jl. Galuh Mas Raya No. 1", "customer", property_product_pricelist=pl_ekat.id, property_payment_term_id=term_30.id or False)
c_dinkes = partner("Dinas Kesehatan Kota Bekasi", "Bekasi", "Jl. Ahmad Yani No. 12", "customer", property_product_pricelist=pl_ekat.id, property_payment_term_id=term_30.id or False)
c_uptd = partner("UPTD Laboratorium Kesehatan Daerah Jawa Barat", "Bandung", "Jl. Pasteur No. 25", "customer", property_product_pricelist=pl_ekat.id, property_payment_term_id=term_30.id or False)
c_cikarang = partner("Laboratorium Klinik Cikarang Medika", "Cikarang", "Jl. Raya Industri No. 7", "customer")
c_mitra = partner("PT Mitra Alkes Nusantara", "Jakarta", "Jl. Gunung Sahari Raya No. 33", "customer", property_product_pricelist=pl_dist.id)
c_halal = partner("Laboratorium Uji Halal Pangan Nusantara", "Bogor", "Jl. Raya Tajur No. 18", "customer")
v_imun = partner("PT Agen Instrumen Imunologi Indonesia", "Jakarta", "Jl. Kebon Sirih No. 40", "vendor")
v_hema = partner("PT Importir Hematologi Medika", "Jakarta", "Jl. Pluit Selatan No. 6", "vendor")
v_kimia = partner("PT Distributor Instrumen Kimia Klinik", "Bandung", "Jl. Soekarno-Hatta No. 520", "vendor")
v_bio = partner("PT Biomolekuler Reagen Indonesia", "Jakarta", "Jl. Mampang Prapatan No. 71", "vendor")
v_cold = partner("PT Logistik Rantai Dingin Nusantara", "Cikarang", "Kawasan Industri Jababeka II Blok F-3", "vendor")
v_inst = existing("PT Sinar Medika Instrumen")
v_reag = existing("CV Bahan Reagen Prima")

# ---------- tim penjualan dan tag CRM ----------
team_ekat = env["crm.team"].create({"name": "e-Katalog INAPROC dan Pemerintah", "user_id": admin.id})
team_swasta = env["crm.team"].create({"name": "Laboratorium Swasta dan Distributor", "user_id": admin.id})
Tag = env["crm.tag"]
t_ekat, t_tender, t_tkdn, t_halal = (Tag.create({"name": n}) for n in ("e-Katalog", "Tender", "TKDN", "Halal"))

# ---------- produk ----------


def product(code, name, categ_rec, price, cost, tracking="none", shelf=None, vendor=None, note=None):
    vals = {
        "name": name, "default_code": code, "type": "consu", "is_storable": True, "categ_id": categ_rec.id, "tracking": tracking,
        "list_price": price, "standard_price": cost, "taxes_id": [Command.set(sale_tax.ids)], "supplier_taxes_id": [Command.set(buy_tax.ids)],
        "sale_ok": price > 0, "purchase_ok": True,
    }
    if note:
        vals["description_sale"] = note
    if shelf:
        vals.update({"use_expiration_date": True, "expiration_time": shelf, "use_time": 30, "removal_time": 14, "alert_time": 90})
    p = Product.create(vals)
    if vendor:
        env["product.supplierinfo"].create({"partner_id": vendor.id, "product_tmpl_id": p.product_tmpl_id.id, "price": cost, "min_qty": 1.0, "delay": 14})
    return p


bc240 = product("PRL-BC240", "PROLINE BC240 Plus Chemistry Analyzer (otomatis)", C_KIMIA, 295_000_000, 214_000_000, "serial", vendor=v_kimia)
chem200 = product("PRL-CHEM200", "PROLINE CHEM200 Chemistry Analyzer (semi-otomatis)", C_KIMIA, 68_000_000, 46_000_000, "serial", vendor=v_kimia)
riele = product("PRL-RIELE", "Riele Photometer 5010 V5", C_KIMIA, 24_500_000, 16_000_000, "serial", vendor=v_kimia)
ureum = product("PRL-UREUM-KIT", "PROLINE Reagen Ureum (kit 4 x 50 mL)", C_KIMIA, 395_000, 62_000, "lot", 547, v_kimia)
sgot = product("PRL-SGOT-KIT", "PROLINE Reagen SGOT/AST (kit 4 x 50 mL)", C_KIMIA, 445_000, 70_000, "lot", 547, v_kimia)
sgpt = product("PRL-SGPT-KIT", "PROLINE Reagen SGPT/ALT (kit 4 x 50 mL)", C_KIMIA, 445_000, 70_000, "lot", 547, v_kimia)
kolesterol = product("PRL-KOL-KIT", "PROLINE Reagen Kolesterol Total (kit 4 x 50 mL)", C_KIMIA, 455_000, 72_000, "lot", 547)
kalibrator = product("PRL-KAL-KK", "PROLINE Kalibrator Multiparameter Kimia Klinik (5 x 3 mL)", C_KAL, 2_450_000, 1_600_000, "lot", 730, v_kimia)
dh33 = product("PRL-DH33", "PROLINE DH33 Hematology Analyzer (3-diff)", C_HEMA, 118_000_000, 82_000_000, "serial", vendor=v_hema)
df55 = product("PRL-DF55", "PROLINE DF55 Hematology Analyzer (5-diff)", C_HEMA, 235_000_000, 168_000_000, "serial", vendor=v_hema)
hb_strip = product("PRL-HB-STRIP", "PROLINE Hemoglobin Strip (box 50)", C_HEMA, 785_000, 520_000, "lot", 365, v_hema)
diluent = product("PRL-HEMA-DIL", "PROLINE Diluent Hematologi (20 L)", C_HEMA, 3_250_000, 2_100_000, "lot", 730, v_hema)
lyse = product("PRL-HEMA-LYSE", "PROLINE Lyse Hematologi (500 mL)", C_HEMA, 2_950_000, 1_900_000, "lot", 548, v_hema)
x3i = product("PRL-X3I", "Snibe Maglumi X3i CLIA Analyzer", C_IMUN, 395_000_000, 305_000_000, "serial", vendor=v_imun)
tsh = product("PRL-CLIA-TSH", "Reagen TSH CLIA (100 tes)", C_IMUN, 3_850_000, 2_600_000, "lot", 365, v_imun)
vitd = product("PRL-CLIA-VITD", "Reagen Vitamin D Total CLIA (100 tes)", C_IMUN, 5_200_000, 3_650_000, "lot", 365, v_imun)
fobt = product("PRL-RDT-FOBT", "PROLINE Rapid Test FOBt (25 tes)", C_RAPID, 1_150_000, 720_000, "lot", 548, v_inst)
hivsyp = product("PRL-RDT-HIVSYP", "PROLINE Rapid Test HIV-Syphilis Combo (25 tes)", C_RAPID, 1_850_000, 1_210_000, "lot", 548, v_inst)
covid = product("PRL-RDT-COVID", "BPRO COVID-19 Ag Rapid Test (25 tes)", C_RAPID, 875_000, 540_000, "lot", 548, v_inst, "TKDN 41,27% (sesuai informasi katalog)")
upro = product("PRL-UPRO", "UPRO Porcine Detection Real-Time PCR Kit (48 tes)", C_BIO, 8_750_000, 5_900_000, "lot", 365, v_bio)
kol_bulk = product("PRL-C-KOL-BULK", "Reagen kolesterol curah (liter)", goods, 0, 198_000, vendor=v_reag)
jasa_cold = Product.create({"name": "Jasa pengiriman rantai dingin (2-8 C)", "default_code": "PRL-JASA-COLD", "type": "service", "invoice_policy": "order", "categ_id": goods.id,
                            "list_price": 4_500_000, "standard_price": 3_200_000, "taxes_id": [Command.set(sale_tax.ids)], "supplier_taxes_id": [Command.set((buy_tax | pph23_buy).ids)]})
jasa_inst = Product.search([("default_code", "=", "PRL-JASA-INST")], limit=1)
c_vial = Product.search([("default_code", "=", "PRL-C-VIAL")], limit=1)
c_dus_kit = Product.search([("default_code", "=", "PRL-C-DUS-KIT")], limit=1)
kontrol = Product.search([("default_code", "=", "PRL-KONTROL-KK")], limit=1)
ua120 = Product.search([("default_code", "=", "PRL-UA120")], limit=1)

# ---------- fungsi bantu dokumen ----------


def set_dates(picking, when):
    picking.write({"date_done": when})
    picking.move_ids.write({"date": when})
    picking.move_ids.move_line_ids.write({"date": when})


def receive(po, when, lots=None):
    """Validasi penerimaan PO. lots = {produk: [(nama lot atau nomor seri, jumlah, tanggal kedaluwarsa atau None)]} untuk produk berlacak."""
    picking = po.picking_ids.filtered(lambda p: p.state not in ("done", "cancel"))
    picking.action_assign()
    for move in picking.move_ids:
        plan = (lots or {}).get(move.product_id)
        if move.product_id.tracking == "none" or not plan:
            move.write({"quantity": move.product_uom_qty, "picked": True})
            continue
        move.move_line_ids.unlink()
        for name, qty, expiry in plan:
            vals = {
                "move_id": move.id, "picking_id": picking.id, "product_id": move.product_id.id, "product_uom_id": move.product_uom.id,
                "location_id": move.location_id.id, "location_dest_id": move.location_dest_id.id, "lot_name": name, "quantity": qty, "picked": True,
            }
            if expiry:
                vals["expiration_date"] = expiry
            env["stock.move.line"].create(vals)
    result = picking.button_validate()
    if picking.state != "done":
        raise RuntimeError(f"Penerimaan {picking.name} belum selesai: {result}")
    set_dates(picking, when)
    return picking


def ship(picking, when, limits=None):
    """Validasi pengiriman atau transfer. limits = {produk: jumlah} mengirim sebagian (sisanya menjadi backorder)."""
    picking.action_assign()
    for move in picking.move_ids:
        want = (limits or {}).get(move.product_id)
        if move.product_id.tracking == "none" or not move.move_line_ids:
            move.write({"quantity": want if want is not None else move.product_uom_qty, "picked": True})
            continue
        left = want if want is not None else move.product_uom_qty
        for line in move.move_line_ids:
            take = min(line.quantity, left)
            if take <= 0:
                line.unlink()
            else:
                line.write({"quantity": take, "picked": True})
                left -= take
    result = picking.with_context(skip_backorder=True).button_validate()
    if picking.state != "done":
        raise RuntimeError(f"Transfer {picking.name} belum selesai: {result}")
    set_dates(picking, when)


def bill(po, invoice_day, ref):
    action = po.action_create_invoice()
    inv = env["account.move"].browse(action["res_id"]) if action.get("res_id") else env["account.move"].search([("invoice_origin", "=", po.name)], limit=1)
    inv.write({"invoice_date": day(invoice_day), "invoice_date_due": day(invoice_day - 30), "ref": ref})
    for line in inv.invoice_line_ids.filtered("product_id"):
        line.analytic_distribution = dist("purchase", line.product_id)
    inv.action_post()
    return inv


def pay(move, when, amount=None):
    vals = {"journal_id": bank.id, "payment_date": when}
    if amount:
        vals["amount"] = amount
    wizard = env["account.payment.register"].with_context(active_model="account.move", active_ids=move.ids).create(vals)
    return wizard.action_create_payments()


def po_new(vendor, back, lines, confirm=True):
    po = env["purchase.order"].create({
        "partner_id": vendor.id, "date_order": at(back),
        "order_line": [Command.create({"product_id": p.id, "product_qty": q, "price_unit": p.standard_price, "analytic_distribution": dist("purchase", p)}) for p, q in lines],
    })
    if confirm:
        po.button_confirm()
    return po


def request(back, origin, note, lines):
    return env["purchase.request"].create({
        "requested_by": admin.id, "origin": origin, "description": note, "date_start": day(back),
        "line_ids": [Command.create({"product_id": p.id, "product_qty": q, "product_uom_id": p.uom_id.id, "date_required": day(back - 7), "name": p.display_name,
                                     "analytic_distribution": dist("purchase", p)}) for p, q in lines],
    })


def po_from_request(req, vendor, back):
    req.button_to_approve()
    req.button_approved()
    wizard = env["purchase.request.line.make.purchase.order"].with_context(active_model="purchase.request.line", active_ids=req.line_ids.ids).create({"supplier_id": vendor.id})
    po = env["purchase.order"].browse(sorted(set(wizard.make_purchase_order()["domain"][0][2])))
    po.write({"date_order": at(back)})
    for line in po.order_line:
        line.analytic_distribution = dist("purchase", line.product_id)
    po.button_confirm()
    return po


def expiry(days):
    return datetime.datetime.combine(today + datetime.timedelta(days=days), datetime.time(0, 0))


def lots(code, qty_a, qty_b):
    """Dua lot per reagen: A hampir kedaluwarsa (45 hari lagi, ditarik duluan oleh FEFO) dan B baru (14 bulan lagi)."""
    return [(f"{code}-2509-A", qty_a, expiry(45)), (f"{code}-2610-B", qty_b, expiry(420))]


def serials(prefix, count, first=1):
    return [(f"{prefix}-{first + i:04d}", 1, None) for i in range(count)]


# ---------- 1. Purchase: PR dan PO instrumen dan reagen, penerimaan ber-lot dan ber-nomor seri, tagihan, pembayaran ----------
pr_imun = request(85, "Rencana stok imunologi Q4 2026", "Analyzer CLIA dan reagen untuk pesanan laboratorium swasta", [(x3i, 2), (tsh, 12), (vitd, 8)])
po_imun = po_from_request(pr_imun, v_imun, 84)
receive(po_imun, at(72), {x3i: serials("MGX3I-26", 2, 101), tsh: lots("TSH", 4, 8), vitd: lots("VITD", 3, 5)})
bill_imun = bill(po_imun, 70, "AII/INV/2026/0788")
pay(bill_imun, day(55))
pr_hema = request(82, "Rencana stok hematologi Q4 2026", "Analyzer hematologi dan reagen pendukung", [(dh33, 2), (df55, 1), (hb_strip, 40), (diluent, 12), (lyse, 12)])
po_hema = po_from_request(pr_hema, v_hema, 81)
receive(po_hema, at(70), {dh33: serials("DH33-26", 2, 201), df55: serials("DF55-26", 1, 301), hb_strip: lots("HB", 15, 25), diluent: lots("DIL", 4, 8), lyse: lots("LYS", 4, 8)})
bill_hema = bill(po_hema, 68, "IHM-26-00391")
pay(bill_hema, day(50), round(bill_hema.amount_total / 2, 0))
po_kimia = po_new(v_kimia, 80, [(bc240, 2), (chem200, 1), (riele, 1), (ureum, 80), (sgot, 80), (sgpt, 80), (kalibrator, 12)])
receive(po_kimia, at(68), {bc240: serials("BC240-26", 2, 401), chem200: serials("CHEM200-26", 1, 501), riele: serials("RIELE-26", 1, 601),
                           ureum: lots("UREUM", 25, 55), sgot: lots("SGOT", 25, 55), sgpt: lots("SGPT", 25, 55), kalibrator: lots("KAL", 4, 8)})
bill_kimia = bill(po_kimia, 66, "DIK/26/0215")
po_rapid = po_new(v_inst, 78, [(fobt, 120), (hivsyp, 90), (covid, 150)])
receive(po_rapid, at(66), {fobt: lots("FOBT", 40, 80), hivsyp: lots("HIVSYP", 30, 60), covid: lots("COVID", 50, 100)})
bill_rapid = bill(po_rapid, 64, "SMI/INV/2026/0455")
pay(bill_rapid, day(40))
po_bio = po_new(v_bio, 75, [(upro, 10)])
receive(po_bio, at(63), {upro: lots("UPRO", 4, 6)})
bill_bio = bill(po_bio, 61, "BRI/2026/0112")
po_bulk = po_new(v_reag, 74, [(kol_bulk, 60)])
receive(po_bulk, at(62))
bill(po_bulk, 60, "BRP/10/0142")
bill_cold = env["account.move"].create({"move_type": "in_invoice", "partner_id": v_cold.id, "invoice_date": day(30), "invoice_date_due": day(0), "ref": "LRD-2026-0067", "invoice_line_ids": [
    Command.create({"product_id": jasa_cold.id, "quantity": 1, "price_unit": 3_200_000, "tax_ids": [Command.set((buy_tax | pph23_buy).ids)], "analytic_distribution": dist("purchase", jasa_cold)})]})
bill_cold.action_post()
pay(bill_cold, day(22))
po_rfq = po_new(v_imun, 2, [(x3i, 1), (tsh, 6)], confirm=False)
po_rfq.activity_schedule("mail.mail_activity_data_todo", date_deadline=day(-2), summary="Minta estimasi tiba (ETD) dan harga final ke agen Maglumi", user_id=admin.id)

# ---------- 2. Inventory: pindahkan reagen ke rak dingin ----------
internal = wh.int_type_id
internal.active = True
move_cold = env["stock.picking"].create({
    "picking_type_id": internal.id, "location_id": stock_loc.id, "location_dest_id": cold.id,
    "move_ids": [Command.create({"product_id": p.id, "product_uom_qty": q, "location_id": stock_loc.id, "location_dest_id": cold.id}) for p, q in ((tsh, 12), (vitd, 8), (upro, 10), (kalibrator, 12))],
})
move_cold.action_confirm()
ship(move_cold, at(60))
for product_rec, low, high in ((ureum, 40, 100), (kolesterol, 100, 200), (fobt, 120, 200), (hivsyp, 80, 160), (hb_strip, 20, 60)):
    env["stock.warehouse.orderpoint"].create({"product_id": product_rec.id, "location_id": stock_loc.id, "warehouse_id": wh.id, "product_min_qty": low, "product_max_qty": high, "trigger": "manual"})

# ---------- 3. Manufacturing: kit reagen kolesterol dari reagen curah ----------
bom_kol = env["mrp.bom"].create({"product_tmpl_id": kolesterol.product_tmpl_id.id, "product_qty": 1, "type": "normal", "bom_line_ids": [
    Command.create({"product_id": kol_bulk.id, "product_qty": 0.2}), Command.create({"product_id": c_vial.id, "product_qty": 4}), Command.create({"product_id": c_dus_kit.id, "product_qty": 1})]})
mo_done = env["mrp.production"].create({"product_id": kolesterol.id, "product_qty": 80, "bom_id": bom_kol.id, "date_start": at(55)})
if "analytic_distribution" in mo_done._fields:
    mo_done.analytic_distribution = dist("production", kolesterol)
mo_done.action_confirm()
lot_kol = env["stock.lot"].create({"name": "KOL-2609-A", "product_id": kolesterol.id})
mo_done.lot_producing_ids = [Command.set(lot_kol.ids)]
mo_done.qty_producing = 80
for move in mo_done.move_raw_ids:
    move.write({"quantity": move.product_uom_qty, "picked": True})
mo_done.button_mark_done()
mo_open = env["mrp.production"].create({"product_id": kolesterol.id, "product_qty": 120, "bom_id": bom_kol.id, "date_start": at(0)})
if "analytic_distribution" in mo_open._fields:
    mo_open.analytic_distribution = dist("production", kolesterol)
mo_open.action_confirm()
mo_open.activity_schedule("mail.mail_activity_data_todo", date_deadline=day(-1), summary="Cek ketersediaan vial: 120 kit butuh 480 vial", user_id=admin.id)

# ---------- 4. CRM dan Sales ----------
stages = {s.name: s for s in env["crm.stage"].search([])}
stage_new, stage_q, stage_p = (stages.get(n) or env["crm.stage"].search([], order="sequence, id")[i] for i, n in enumerate(("New", "Qualified", "Proposition")))
Lead = env["crm.lead"]


def opportunity(name, partner_rec, revenue, stage, chance, team, tags, deadline_days, note):
    return Lead.create({"name": name, "partner_id": partner_rec.id, "type": "opportunity", "expected_revenue": revenue, "stage_id": stage.id, "probability": chance, "team_id": team.id,
                        "user_id": admin.id, "date_deadline": day(-deadline_days), "contact_name": "Bagian Pengadaan", "tag_ids": [Command.set([t.id for t in tags])], "description": f"<p>{note}</p>"})


opp_krw = opportunity("RSUD Karawang: paket kimia klinik BC240 Plus lewat e-Katalog", c_krw, 330_000_000, stage_p, 60, team_ekat, [t_ekat, t_tkdn], -50, "Pengadaan analyzer kimia klinik otomatis dan reagen 12 bulan")
opp_dinkes = opportunity("Dinkes Kota Bekasi: tes cepat FOBt, HIV-Syphilis, dan COVID-19 Ag", c_dinkes, 150_000_000, stage_p, 70, team_ekat, [t_ekat, t_tkdn], -15, "Kebutuhan puskesmas, pembelian lewat e-Katalog INAPROC")
opp_uptd = opportunity("UPTD Labkesda Jabar: hematologi DH33 dan reagen (tender)", c_uptd, 148_000_000, stage_q, 35, team_ekat, [t_tender], 25, "Tender pengadaan alat hematologi tiga diff")
opp_cikarang = opportunity("Lab Cikarang Medika: Maglumi X3i dan reagen tiroid", c_cikarang, 440_000_000, stage_q, 30, team_swasta, [], 20, "Ekspansi layanan imunologi, tiroid dan vitamin D")
opp_halal = opportunity("Lab Uji Halal Nusantara: UPRO PCR kit deteksi porcine", c_halal, 87_500_000, stage_new, 15, team_swasta, [t_halal], 40, "Uji cemaran babi pada produk pangan")
opp_mitra = opportunity("PT Mitra Alkes: kontrak distributor reagen 2027", c_mitra, 520_000_000, stage_p, 45, team_swasta, [], 60, "Kontrak tahunan, harga distributor")
opp_krw.activity_schedule("mail.mail_activity_data_meeting", date_deadline=day(-3), summary="Demo BC240 Plus di lab RSUD Karawang", user_id=admin.id)
opp_uptd.activity_schedule("mail.mail_activity_data_todo", date_deadline=day(-9), summary="Lengkapi dokumen tender dan sertifikat TKDN", user_id=admin.id)
opp_cikarang.activity_schedule("mail.mail_activity_data_call", date_deadline=day(0), summary="Telepon kepala lab: konfirmasi jadwal demo X3i", user_id=admin.id)
opp_halal.activity_schedule("mail.mail_activity_data_email", date_deadline=day(-5), summary="Kirim brosur UPRO dan protokol uji", user_id=admin.id)
if admin.has_group("crm.group_use_lead"):
    Lead.create({"name": "Permintaan demo DF55 dari situs web", "type": "lead", "contact_name": "dr. Maya Lestari", "partner_name": "Klinik Utama Harapan Bekasi", "email_from": "maya@harapan.example", "user_id": admin.id, "team_id": team_swasta.id})


def order(partner_rec, back, lines, opp=None, tax_services=False):
    vals = {"partner_id": partner_rec.id, "date_order": at(back), "order_line": []}
    for p, q in lines:
        line = {"product_id": p.id, "product_uom_qty": q, "analytic_distribution": dist("sale", p)}
        if tax_services and p.type == "service":
            line["tax_ids"] = [Command.set((sale_tax | pph23_sale).ids)]
        vals["order_line"].append(Command.create(line))
    if opp:
        vals["opportunity_id"] = opp.id
    return env["sale.order"].create(vals)


def invoice(so, back):
    inv = so._create_invoices()
    inv.write({"invoice_date": day(back)})
    for line in inv.invoice_line_ids.filtered("product_id"):
        line.analytic_distribution = dist("sale", line.product_id)
    inv.action_post()
    return inv


# Karawang: e-Katalog, terkirim, faktur 30 hari yang sebagian sudah dibayar dan sisanya terlambat
so_krw = order(c_krw, 58, [(bc240, 1), (kalibrator, 2), (kontrol, 2), (ureum, 20), (sgot, 20), (sgpt, 20), (jasa_inst, 1), (jasa_cold, 1)], opp_krw, tax_services=True)
so_krw.action_confirm()
ship(so_krw.picking_ids.filtered(lambda p: p.state not in ("done", "cancel")), at(55))
inv_krw = invoice(so_krw, 55)
pay(inv_krw, day(30), round(inv_krw.amount_total / 2, 0))
opp_krw.action_set_won()
inv_krw.activity_schedule("mail.mail_activity_data_call", date_deadline=day(3), summary="Telepon bendahara RSUD Karawang: pelunasan sisa faktur", user_id=admin.id)
# Dinkes Bekasi: tes cepat, kirim sebagian (COVID-19 Ag sisa 20 menjadi backorder), faktur dan lunas
so_dinkes = order(c_dinkes, 14, [(fobt, 40), (hivsyp, 30), (covid, 60)], opp_dinkes)
so_dinkes.action_confirm()
ship(so_dinkes.picking_ids.filtered(lambda p: p.state not in ("done", "cancel")), at(12), {covid: 40})
inv_dinkes = invoice(so_dinkes, 12)
pay(inv_dinkes, day(4))
opp_dinkes.action_set_won()
# UPTD Jabar: penawaran terkirim
so_uptd = order(c_uptd, 6, [(dh33, 1), (hb_strip, 10), (diluent, 2), (lyse, 2), (jasa_inst, 1)], opp_uptd, tax_services=True)
so_uptd.action_quotation_sent()
so_uptd.write({"validity_date": day(-14)})
so_uptd.activity_schedule("mail.mail_activity_data_todo", date_deadline=day(-2), summary="Tindak lanjut penawaran DH33 dengan panitia tender", user_id=admin.id)
# Distributor: SO terkonfirmasi, pengiriman siap divalidasi saat demo
so_mitra = order(c_mitra, 1, [(ureum, 50), (sgot, 30), (tsh, 4)], opp_mitra)
so_mitra.action_confirm()
for pick in so_mitra.picking_ids:
    pick.action_assign()
    pick.activity_schedule("mail.mail_activity_data_todo", date_deadline=day(-1), summary="Jadwalkan kurir rantai dingin untuk pengiriman reagen", user_id=admin.id)
# Lab Cikarang: quotation draf
so_cikarang = order(c_cikarang, 0, [(x3i, 1), (tsh, 10), (vitd, 10), (jasa_inst, 1)], opp_cikarang, tax_services=True)

env.cr.commit()
print(
    "PROLINE_OK", pr_imun.name, pr_hema.name, po_imun.name, po_hema.name, po_kimia.name, po_rapid.name, po_bio.name, po_bulk.name, po_rfq.name, mo_done.name, mo_open.name,
    so_krw.name, so_dinkes.name, so_uptd.name, so_mitra.name, so_cikarang.name, inv_krw.name, inv_dinkes.name, bill_imun.name, bill_hema.name, bill_kimia.name, bill_bio.name,
)
