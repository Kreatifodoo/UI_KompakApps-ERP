# ruff: noqa: F821
"""Data presales bertema PROLINE (produk diagnostik: instrumen, reagen, strip urin, tes cepat) untuk demo seluruh alur KompakApps.

Dijalankan lewat `odoo shell` (variabel `env` disediakan oleh shell). Database harus sudah memasang kompakapps_base dan menjalankan seed_demo.py
(setup Indonesia). Aman dijalankan ulang: bila produk PRL-XI800 sudah ada, skrip berhenti tanpa mengubah apa pun.

    docker compose run --rm -T --no-deps odoo odoo shell -d kompakapps --no-http < scripts/seed_presales.py

Alur yang dibuat (tanggal relatif terhadap hari ini): Purchase Request -> Purchase Order -> Goods Receive -> Vendor Bill -> Payment;
transfer internal antar rak; Manufacturing (BoM strip urin dan reagen glukosa, MO selesai dan MO berjalan); CRM (peluang berbagai tahap,
aktivitas, quotation); Sales Order -> Delivery Order -> Customer Invoice -> Receipt (lunas, sebagian, dan belum dibayar).
Nama perusahaan dan harga adalah contoh rekaan untuk demo, bukan data nyata.
"""
import datetime
from odoo import Command, fields

admin = env.ref("base.user_admin")
env = env(user=admin)
company = env.company
today = fields.Date.today()
if env["product.product"].search([("default_code", "=", "PRL-XI800")], limit=1):
    print("PRESALES_SKIP: data PROLINE sudah ada")
    raise SystemExit(0)


def day(back):
    return today - datetime.timedelta(days=back)


def at(back, hour=10):
    return datetime.datetime.combine(day(back), datetime.time(hour, 0))


# fitur yang dibutuhkan demo: lokasi penyimpanan (transfer antar rak), Leads di CRM, grup manajer Purchase Request
admin.group_ids = [Command.link(env.ref("purchase_request.group_purchase_request_manager").id)]
needs = {}
if not admin.has_group("stock.group_stock_multi_locations"):
    needs["group_stock_multi_locations"] = True
if not admin.has_group("crm.group_use_lead"):
    needs["group_use_lead"] = True
if needs:
    env["res.config.settings"].create(needs).execute()
    env = env(user=admin)
wh = env["stock.warehouse"].search([("company_id", "=", company.id)], limit=1)
stock_loc = wh.lot_stock_id
bank = env["account.journal"].search([("type", "=", "bank"), ("company_id", "=", company.id)], limit=1)
goods = env.ref("product.product_category_goods")
Tax = env["account.tax"]
sale_tax = Tax.search([("type_tax_use", "=", "sale"), ("name", "=", "VAT Out 11%"), ("company_id", "=", company.id)], limit=1)
buy_tax = Tax.search([("type_tax_use", "=", "purchase"), ("name", "=", "VAT In 11%"), ("company_id", "=", company.id)], limit=1)
pph23 = Tax.search([("type_tax_use", "=", "purchase"), ("name", "=", "PPh 23 -2%"), ("company_id", "=", company.id)], limit=1)
if not (sale_tax and buy_tax and pph23):
    print("PRESALES_SKIP: jalankan scripts/setup_tax_id.py lebih dulu (VAT Out 11%, VAT In 11%, PPh 23 -2%)")
    raise SystemExit(0)
Partner = env["res.partner"]


def partner(name, city, street, kind):
    vals = {"name": name, "is_company": True, "city": city, "street": street, "country_id": env.ref("base.id").id, "email": f"kontak@{name.split()[-1].lower()}.example"}
    vals["supplier_rank" if kind == "vendor" else "customer_rank"] = 1
    return Partner.create(vals)


v_inst = partner("PT Sinar Medika Instrumen", "Jakarta", "Jl. Pulogadung No. 21", "vendor")
v_pack = partner("PT Kemasan Laboratorium Nusantara", "Tangerang", "Kawasan Industri Jatake Blok C-7", "vendor")
v_reag = partner("CV Bahan Reagen Prima", "Bandung", "Jl. Soekarno-Hatta No. 310", "vendor")
v_kal = partner("CV Teknisi Kalibrasi Mandiri", "Jakarta", "Jl. Tebet Barat Dalam No. 9", "vendor")
c_harapan = partner("RS Harapan Sehat Jakarta", "Jakarta", "Jl. Cikini Raya No. 14", "customer")
c_sentosa = partner("Laboratorium Klinik Sentosa Bandung", "Bandung", "Jl. Dipatiukur No. 88", "customer")
c_bunda = partner("Klinik Pratama Bunda Surabaya", "Surabaya", "Jl. Darmo Permai III No. 5", "customer")
c_semarang = partner("RSUD Kota Semarang", "Semarang", "Jl. Pandanaran No. 100", "customer")
Product = env["product.product"]


def product(code, name, price, cost, vendor=None, vendor_price=None):
    p = Product.create({
        "name": name, "default_code": code, "type": "consu", "is_storable": True, "categ_id": goods.id,
        "list_price": price, "standard_price": cost, "taxes_id": [Command.set(sale_tax.ids)], "supplier_taxes_id": [Command.set(buy_tax.ids)],
        "sale_ok": price > 0, "purchase_ok": True,
    })
    if vendor:
        env["product.supplierinfo"].create({"partner_id": vendor.id, "product_tmpl_id": p.product_tmpl_id.id, "price": vendor_price or cost, "min_qty": 1.0, "delay": 7})
    return p


jasa_install = Product.create({"name": "Jasa Instalasi dan Pelatihan Instrumen", "default_code": "PRL-JASA-INST", "type": "service", "invoice_policy": "order", "categ_id": goods.id, "list_price": 7_500_000, "standard_price": 0, "taxes_id": [Command.set(sale_tax.ids)], "sale_ok": True, "purchase_ok": False})
jasa_kalibrasi = Product.create({"name": "Jasa kalibrasi dan pemeliharaan instrumen", "default_code": "PRL-JASA-KAL", "type": "service", "categ_id": goods.id, "list_price": 0, "standard_price": 4_500_000, "supplier_taxes_id": [Command.set((buy_tax | pph23).ids)], "sale_ok": False, "purchase_ok": True})
xi800 = product("PRL-XI800", "PROLINE Xi800 Automatic Chemiluminescence Analyzer", 485_000_000, 372_000_000, v_inst)
ua120 = product("PRL-UA120", "PROLINE UA120 Urine Analyzer", 38_500_000, 27_500_000, v_inst)
ua240 = product("PRL-UA240", "PROLINE UA240 Urine Analyzer", 62_000_000, 44_000_000, v_inst)
rdt = product("PRL-RDT-DENGUE", "PROLINE Rapid Test Dengue NS1 (25 tes)", 975_000, 640_000, v_inst)
kontrol = product("PRL-KONTROL-KK", "PROLINE Kontrol Kimia Klinik Level 1 dan 2 (set)", 1_850_000, 1_240_000, v_inst)
strip = product("PRL-STRIP-100", "PROLINE Urine Strip 10 Parameter (botol 100 strip)", 185_000, 97_000)
glukosa = product("PRL-GLU-KIT", "PROLINE Reagen Glukosa Kimia Klinik (kit 4 x 50 mL)", 425_000, 70_000)
c_sheet = product("PRL-C-STRIP", "Strip reaksi urin 10 parameter (lembar)", 0, 900, v_pack)
c_botol = product("PRL-C-BOTOL", "Botol strip 100 tes", 0, 4_500, v_pack)
c_dus_strip = product("PRL-C-DUS-STRIP", "Kotak kemasan strip", 0, 2_500, v_pack)
c_vial = product("PRL-C-VIAL", "Vial reagen 50 mL", 0, 6_500, v_pack)
c_dus_kit = product("PRL-C-DUS-KIT", "Kotak kit reagen", 0, 8_000, v_pack)
c_bulk = product("PRL-C-GLU-BULK", "Reagen glukosa curah (liter)", 0, 180_000, v_reag)


def set_dates(picking, when):
    picking.write({"date_done": when})
    picking.move_ids.write({"date": when})
    picking.move_ids.move_line_ids.write({"date": when})


def validate(picking, when):
    picking.action_assign()
    for move in picking.move_ids:
        move.write({"quantity": move.product_uom_qty, "picked": True})
    picking.button_validate()
    set_dates(picking, when)


def receive(po, when):
    validate(po.picking_ids.filtered(lambda p: p.state not in ("done", "cancel")), when)


def bill(po, invoice_day, ref):
    action = po.action_create_invoice()
    inv = env["account.move"].browse(action["res_id"]) if action.get("res_id") else env["account.move"].search([("invoice_origin", "=", po.name)], limit=1)
    inv.write({"invoice_date": day(invoice_day), "ref": ref})
    inv.action_post()
    return inv


def pay(move, when, amount=None):
    vals = {"journal_id": bank.id, "payment_date": when}
    if amount:
        vals["amount"] = amount
    wizard = env["account.payment.register"].with_context(active_model="account.move", active_ids=move.ids).create(vals)
    return wizard.action_create_payments()


def po_from_request(request, vendor):
    request.button_to_approve()
    request.button_approved()
    wizard = env["purchase.request.line.make.purchase.order"].with_context(active_model="purchase.request.line", active_ids=request.line_ids.ids).create({"supplier_id": vendor.id})
    result = wizard.make_purchase_order()
    return env["purchase.order"].browse(sorted(set(result["domain"][0][2])))


def request(back, origin, note, lines):
    return env["purchase.request"].create({
        "requested_by": admin.id, "origin": origin, "description": note, "date_start": day(back),
        "line_ids": [Command.create({"product_id": p.id, "product_qty": q, "product_uom_id": p.uom_id.id, "date_required": day(back - 5), "name": p.display_name}) for p, q in lines],
    })


# 1. Purchase Request -> Purchase Order -> Goods Receive -> Vendor Bill -> Payment (instrumen dan reagen dari PT Sinar Medika Instrumen)
pr1 = request(9, "Rencana stok Q4 2026", "Instrumen dan tes cepat untuk pesanan rumah sakit dan laboratorium Q4", [(xi800, 2), (ua120, 6), (ua240, 3), (rdt, 40), (kontrol, 10)])
po1 = po_from_request(pr1, v_inst)
po1.write({"date_order": at(8)})
po1.button_confirm()
receive(po1, at(7))
bill1 = bill(po1, 6, "SMI/INV/2026/0412")
pay(bill1, day(3))
# 2. PR bahan kemasan -> PO -> receive -> bill -> bayar (PT Kemasan Laboratorium Nusantara)
pr2 = request(10, "Kebutuhan produksi strip dan kit", "Lembar strip, botol, kotak, dan vial untuk produksi Oktober", [(c_sheet, 40_000), (c_botol, 600), (c_dus_strip, 600), (c_vial, 800), (c_dus_kit, 300)])
po2 = po_from_request(pr2, v_pack)
po2.write({"date_order": at(9)})
po2.button_confirm()
receive(po2, at(7))
bill2 = bill(po2, 6, "KLN-2026-1187")
pay(bill2, day(2))
# 3. PO langsung reagen curah (tagihan belum dibayar) dan satu RFQ draf
po3 = env["purchase.order"].create({"partner_id": v_reag.id, "date_order": at(8), "order_line": [Command.create({"product_id": c_bulk.id, "product_qty": 60, "price_unit": 180_000})]})
po3.button_confirm()
receive(po3, at(6))
bill(po3, 5, "BRP/10/0087")
bill_kal = env["account.move"].create({"move_type": "in_invoice", "partner_id": v_kal.id, "invoice_date": day(4), "ref": "TKM-2026-031", "invoice_line_ids": [Command.create({"product_id": jasa_kalibrasi.id, "quantity": 1, "price_unit": 4_500_000, "tax_ids": [Command.set((buy_tax | pph23).ids)]})]})
bill_kal.action_post()
pay(bill_kal, day(1))
po4 = env["purchase.order"].create({"partner_id": v_inst.id, "date_order": at(1), "order_line": [Command.create({"product_id": xi800.id, "product_qty": 1, "price_unit": 372_000_000})]})
# 4. Inventory transfer antar rak
rack_inst = env["stock.location"].create({"name": "Rak Instrumen", "location_id": stock_loc.id, "usage": "internal"})
rack_bahan = env["stock.location"].create({"name": "Rak Bahan Baku", "location_id": stock_loc.id, "usage": "internal"})
rack_reagen = env["stock.location"].create({"name": "Rak Reagen dan Kit", "location_id": stock_loc.id, "usage": "internal"})
internal = wh.int_type_id
internal.active = True


def transfer(dest, lines, when=None):
    picking = env["stock.picking"].create({
        "picking_type_id": internal.id, "location_id": stock_loc.id, "location_dest_id": dest.id,
        "move_ids": [Command.create({"product_id": p.id, "product_uom_qty": q, "location_id": stock_loc.id, "location_dest_id": dest.id}) for p, q in lines],
    })
    picking.action_confirm()
    if when:
        validate(picking, when)
    return picking


transfer(rack_inst, [(xi800, 2), (ua120, 6), (ua240, 3)], at(6))
transfer(rack_bahan, [(c_sheet, 20_000), (c_vial, 400), (c_bulk, 30)], at(5))
transfer(rack_reagen, [(kontrol, 10), (rdt, 40)])
# 5. Manufacturing
bom_strip = env["mrp.bom"].create({"product_tmpl_id": strip.product_tmpl_id.id, "product_qty": 1, "type": "normal", "bom_line_ids": [
    Command.create({"product_id": c_sheet.id, "product_qty": 100}), Command.create({"product_id": c_botol.id, "product_qty": 1}), Command.create({"product_id": c_dus_strip.id, "product_qty": 1})]})
bom_glu = env["mrp.bom"].create({"product_tmpl_id": glukosa.product_tmpl_id.id, "product_qty": 1, "type": "normal", "bom_line_ids": [
    Command.create({"product_id": c_bulk.id, "product_qty": 0.2}), Command.create({"product_id": c_vial.id, "product_qty": 4}), Command.create({"product_id": c_dus_kit.id, "product_qty": 1})]})


def produce(prod, bom, qty, when):
    mo = env["mrp.production"].create({"product_id": prod.id, "product_qty": qty, "bom_id": bom.id, "date_start": when})
    mo.action_confirm()
    mo.qty_producing = qty
    for move in mo.move_raw_ids:
        move.write({"quantity": move.product_uom_qty, "picked": True})
    mo.button_mark_done()
    return mo


mo1 = produce(strip, bom_strip, 200, at(5))
mo2 = produce(glukosa, bom_glu, 60, at(4))
mo3 = env["mrp.production"].create({"product_id": strip.id, "product_qty": 300, "bom_id": bom_strip.id, "date_start": at(0)})
mo3.action_confirm()
# 6. CRM
stages = env["crm.stage"].search([], order="sequence, id")
stage_new, stage_q, stage_p = stages[0], stages[min(1, len(stages) - 1)], stages[min(2, len(stages) - 1)]
Lead = env["crm.lead"]


def opportunity(name, partner_rec, revenue, stage, deadline_days):
    return Lead.create({"name": name, "partner_id": partner_rec.id, "type": "opportunity", "expected_revenue": revenue, "stage_id": stage.id, "user_id": admin.id,
                        "date_deadline": day(-deadline_days), "contact_name": "Bagian Pengadaan", "description": "Presales PROLINE"})


opp_xi = opportunity("RS Harapan Sehat: Xi800 Immunoassay Analyzer", c_harapan, 485_000_000, stage_p, 21)
opp_sentosa = opportunity("Lab Sentosa: UA240 dan suplai strip berkelanjutan", c_sentosa, 105_000_000, stage_p, 3)
opp_bunda = opportunity("Klinik Bunda: tes cepat Dengue musim hujan", c_bunda, 12_500_000, stage_q, 10)
opp_smg = opportunity("RSUD Semarang: tender instrumen urinalisis (UA120 x4)", c_semarang, 154_000_000, stage_q, 30)
for opp, chance in ((opp_xi, 40.0), (opp_bunda, 25.0), (opp_smg, 30.0)):
    opp.write({"probability": chance})
opp_xi.activity_schedule("mail.mail_activity_data_meeting", date_deadline=day(-1), summary="Presentasi PROLINE Xi800 ke tim laboratorium RS Harapan Sehat", user_id=admin.id)
opp_bunda.activity_schedule("mail.mail_activity_data_call", date_deadline=day(-2), summary="Telepon kepala klinik: konfirmasi kebutuhan tes Dengue", user_id=admin.id)
opp_smg.activity_schedule("mail.mail_activity_data_todo", date_deadline=day(-7), summary="Siapkan dokumen penawaran dan brosur UA120", user_id=admin.id)
if admin.has_group("crm.group_use_lead"):
    Lead.create({"name": "Permintaan informasi Xi800 dari situs web", "type": "lead", "contact_name": "dr. Rina Kusuma", "partner_name": "Laboratorium Klinik Cendana", "email_from": "rina@cendana.example", "user_id": admin.id})
    Lead.create({"name": "Pameran alat kesehatan: minat strip urin dalam jumlah besar", "type": "lead", "contact_name": "Bpk. Hendra", "partner_name": "Apotek dan Lab Mitra Sehat", "email_from": "hendra@mitrasehat.example", "user_id": admin.id})


# 7. Sales Order -> Delivery Order -> Customer Invoice -> Receipt
def order(partner_rec, back, lines, opp=None):
    vals = {"partner_id": partner_rec.id, "date_order": at(back), "order_line": [Command.create({"product_id": p.id, "product_uom_qty": q, "price_unit": p.list_price}) for p, q in lines]}
    if opp:
        vals["opportunity_id"] = opp.id
    return env["sale.order"].create(vals)


def deliver(so, when):
    validate(so.picking_ids.filtered(lambda p: p.state not in ("done", "cancel")), when)


def invoice(so, back):
    inv = so._create_invoices()
    inv.write({"invoice_date": day(back)})
    inv.action_post()
    return inv


so1 = order(c_sentosa, 5, [(ua240, 1), (strip, 30), (kontrol, 2), (jasa_install, 1)], opp_sentosa)
so1.action_confirm()
deliver(so1, at(4))
inv1 = invoice(so1, 4)
pay(inv1, day(1))
opp_sentosa.action_set_won()
so2 = order(c_harapan, 3, [(ua120, 2), (strip, 50), (glukosa, 20)])
so2.action_confirm()
deliver(so2, at(2))
inv2 = invoice(so2, 2)
pay(inv2, day(0), round(inv2.amount_total / 2, 0))
so3 = order(c_bunda, 1, [(rdt, 10), (strip, 10)])
so3.action_confirm()
quotation = order(c_harapan, 0, [(xi800, 1)], opp_xi)
quotation.write({"validity_date": day(-30)})
print("PRESALES_OK", pr1.name, pr2.name, po1.name, po2.name, po3.name, po4.name, mo1.name, mo2.name, mo3.name, so1.name, so2.name, so3.name, quotation.name, inv1.name, inv2.name)
env.cr.commit()
