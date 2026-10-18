# ruff: noqa: F821
"""Tambahan data presales PROLINE: akun analitik pada semua transaksi, lebih banyak transaksi manufacturing, dan beberapa BoM per produk.

Jalankan SETELAH seed_presales.py (butuh data PROLINE dan pajak dari setup_tax_id.py) lewat `odoo shell`. Aman dijalankan ulang (berhenti bila
produk PRL-STRIP-5P sudah ada). Tujuannya agar laporan keuangan (Laba Rugi, Neraca Saldo, Buku Besar, Analytic Report) bisa disaring per akun analitik.

    docker compose run --rm -T --no-deps odoo odoo shell -d kompakapps --no-http < scripts/seed_presales_extra.py

Dua rencana analitik dibuat: "Departemen" (Penjualan Instrumen, Penjualan Reagen dan Strip, Pembelian dan Gudang, Produksi, Pemasaran) dan
"Lini Produk" (Instrumen, Reagen dan Kit, Strip dan Tes Cepat, Jasa). Setiap baris transaksi memakai satu akun dari masing-masing rencana.
"""
import datetime
from odoo import Command, fields

admin = env.ref("base.user_admin")
env = env(user=admin)
company = env.company
today = fields.Date.today()
Product = env["product.product"]
if Product.search([("default_code", "=", "PRL-STRIP-5P")], limit=1) or not Product.search([("default_code", "=", "PRL-XI800")], limit=1):
    print("PRESALES_EXTRA_SKIP: data tambahan sudah ada, atau seed_presales.py belum dijalankan")
    raise SystemExit(0)


def day(back):
    return today - datetime.timedelta(days=back)


def at(back, hour=10):
    return datetime.datetime.combine(day(back), datetime.time(hour, 0))


def code(c):
    return Product.search([("default_code", "=", c)], limit=1)


def partner(name):
    return env["res.partner"].search([("name", "=", name)], limit=1)


# ---------- akun analitik ----------
Plan = env["account.analytic.plan"]
Analytic = env["account.analytic.account"]
plan_dep = Plan.search([("name", "=", "Departemen")], limit=1) or Plan.create({"name": "Departemen"})
plan_line = Plan.search([("name", "=", "Lini Produk")], limit=1) or Plan.create({"name": "Lini Produk"})


def acc(name, plan):
    return Analytic.search([("name", "=", name), ("plan_id", "=", plan.id)], limit=1) or Analytic.create({"name": name, "plan_id": plan.id, "company_id": company.id})


D_INST, D_REAG, D_BELI, D_PROD, D_MKT = (acc(n, plan_dep) for n in ("Penjualan Instrumen", "Penjualan Reagen dan Strip", "Pembelian dan Gudang", "Produksi", "Pemasaran"))
L_INST, L_REAG, L_STRIP, L_JASA = (acc(n, plan_line) for n in ("Instrumen", "Reagen dan Kit", "Strip dan Tes Cepat", "Jasa"))
LINE_OF = {
    "PRL-XI800": L_INST, "PRL-UA120": L_INST, "PRL-UA240": L_INST, "PRL-KONTROL-KK": L_REAG, "PRL-GLU-KIT": L_REAG, "PRL-RDT-DENGUE": L_STRIP,
    "PRL-STRIP-100": L_STRIP, "PRL-JASA-INST": L_JASA, "PRL-JASA-KAL": L_JASA, "PRL-C-STRIP": L_STRIP, "PRL-C-BOTOL": L_STRIP, "PRL-C-DUS-STRIP": L_STRIP,
    "PRL-C-VIAL": L_REAG, "PRL-C-DUS-KIT": L_REAG, "PRL-C-GLU-BULK": L_REAG,
}


def dist(department, line):
    return {f"{department.id},{line.id}": 100.0}


def sales_dept(product):
    return D_INST if product.default_code in ("PRL-XI800", "PRL-UA120", "PRL-UA240", "PRL-JASA-INST") else D_REAG


def analytic_for(product, kind):
    line = LINE_OF.get(product.default_code, L_REAG)
    department = {"sale": sales_dept(product), "purchase": D_BELI, "production": D_PROD}[kind]
    return dist(department, line)


# ---------- produk, komponen, dan BoM tambahan ----------
goods = env.ref("product.product_category_goods")
sale_tax = env["account.tax"].search([("type_tax_use", "=", "sale"), ("name", "=", "VAT Out 11%"), ("company_id", "=", company.id)], limit=1)
buy_tax = env["account.tax"].search([("type_tax_use", "=", "purchase"), ("name", "=", "VAT In 11%"), ("company_id", "=", company.id)], limit=1)
v_pack, v_reag = partner("PT Kemasan Laboratorium Nusantara"), partner("CV Bahan Reagen Prima")


def product(c, name, price, cost, vendor=None):
    p = Product.create({
        "name": name, "default_code": c, "type": "consu", "is_storable": True, "categ_id": goods.id, "list_price": price, "standard_price": cost,
        "taxes_id": [Command.set(sale_tax.ids)], "supplier_taxes_id": [Command.set(buy_tax.ids)], "sale_ok": price > 0, "purchase_ok": True,
    })
    if vendor:
        env["product.supplierinfo"].create({"partner_id": vendor.id, "product_tmpl_id": p.product_tmpl_id.id, "price": cost, "min_qty": 1.0, "delay": 7})
    return p


strip5 = product("PRL-STRIP-5P", "PROLINE Urine Strip 5 Parameter (botol 100 strip)", 135_000, 72_000)
kreatinin = product("PRL-KRE-KIT", "PROLINE Reagen Kreatinin Kimia Klinik (kit 4 x 50 mL)", 465_000, 78_000)
paket = product("PRL-PAKET-URINALISIS", "PROLINE Paket Laboratorium Urinalisis (UA120, 10 botol strip, kontrol)", 48_500_000, 0)
c_sheet5 = product("PRL-C-STRIP5", "Strip reaksi urin 5 parameter (lembar)", 0, 650, v_pack)
c_botol_eko = product("PRL-C-BOTOL-EKO", "Botol strip 100 tes (ekonomis)", 0, 3_200, v_pack)
c_bulk_kre = product("PRL-C-KRE-BULK", "Reagen kreatinin curah (liter)", 0, 205_000, v_reag)
for key, p in (("PRL-STRIP-5P", strip5), ("PRL-KRE-KIT", kreatinin), ("PRL-PAKET-URINALISIS", paket), ("PRL-C-STRIP5", c_sheet5), ("PRL-C-BOTOL-EKO", c_botol_eko), ("PRL-C-KRE-BULK", c_bulk_kre)):
    LINE_OF[key] = {"PRL-STRIP-5P": L_STRIP, "PRL-KRE-KIT": L_REAG, "PRL-PAKET-URINALISIS": L_INST, "PRL-C-STRIP5": L_STRIP, "PRL-C-BOTOL-EKO": L_STRIP, "PRL-C-KRE-BULK": L_REAG}[key]
Bom = env["mrp.bom"]
strip100, glukosa, ua120, kontrol = code("PRL-STRIP-100"), code("PRL-GLU-KIT"), code("PRL-UA120"), code("PRL-KONTROL-KK")
c_sheet, c_botol, c_dus_strip, c_vial, c_dus_kit = code("PRL-C-STRIP"), code("PRL-C-BOTOL"), code("PRL-C-DUS-STRIP"), code("PRL-C-VIAL"), code("PRL-C-DUS-KIT")
bom_std = Bom.search([("product_tmpl_id", "=", strip100.product_tmpl_id.id)], limit=1)
bom_std.write({"code": "STD", "sequence": 1})
bom_eko = Bom.create({"product_tmpl_id": strip100.product_tmpl_id.id, "product_qty": 1, "type": "normal", "code": "EKO", "sequence": 2, "bom_line_ids": [
    Command.create({"product_id": c_sheet.id, "product_qty": 95}), Command.create({"product_id": c_botol_eko.id, "product_qty": 1}), Command.create({"product_id": c_dus_strip.id, "product_qty": 1})]})
bom_strip5 = Bom.create({"product_tmpl_id": strip5.product_tmpl_id.id, "product_qty": 1, "type": "normal", "code": "STD", "bom_line_ids": [
    Command.create({"product_id": c_sheet5.id, "product_qty": 100}), Command.create({"product_id": c_botol.id, "product_qty": 1}), Command.create({"product_id": c_dus_strip.id, "product_qty": 1})]})
bom_kre = Bom.create({"product_tmpl_id": kreatinin.product_tmpl_id.id, "product_qty": 1, "type": "normal", "code": "STD", "bom_line_ids": [
    Command.create({"product_id": c_bulk_kre.id, "product_qty": 0.2}), Command.create({"product_id": c_vial.id, "product_qty": 4}), Command.create({"product_id": c_dus_kit.id, "product_qty": 1})]})
bom_paket = Bom.create({"product_tmpl_id": paket.product_tmpl_id.id, "product_qty": 1, "type": "normal", "code": "PKT", "bom_line_ids": [
    Command.create({"product_id": ua120.id, "product_qty": 1}), Command.create({"product_id": strip100.id, "product_qty": 10}), Command.create({"product_id": kontrol.id, "product_qty": 1})]})
bom_glu = Bom.search([("product_tmpl_id", "=", glukosa.product_tmpl_id.id)], limit=1)
bom_glu.write({"code": "STD"})

# ---------- pembelian komponen baru (PO, receive, tagihan) ----------


def validate(picking, when):
    picking.action_assign()
    for move in picking.move_ids:
        move.write({"quantity": move.product_uom_qty, "picked": True})
    picking.button_validate()
    picking.write({"date_done": when})
    picking.move_ids.write({"date": when})
    picking.move_ids.move_line_ids.write({"date": when})


def buy(vendor, back, lines, ref):
    po = env["purchase.order"].create({"partner_id": vendor.id, "date_order": at(back), "order_line": [Command.create({"product_id": p.id, "product_qty": q, "price_unit": p.standard_price}) for p, q in lines]})
    po.button_confirm()
    validate(po.picking_ids.filtered(lambda x: x.state not in ("done", "cancel")), at(back - 1))
    action = po.action_create_invoice()
    inv = env["account.move"].browse(action["res_id"]) if action.get("res_id") else env["account.move"].search([("invoice_origin", "=", po.name)], limit=1)
    inv.write({"invoice_date": day(back - 1), "ref": ref})
    inv.action_post()
    return po, inv


po5, bill5 = buy(v_pack, 6, [(c_sheet5, 20_000), (c_botol_eko, 400), (c_botol, 300), (c_dus_strip, 500)], "KLN-2026-1203")
po6, bill6 = buy(v_reag, 6, [(c_bulk_kre, 30)], "BRP/10/0091")
# ---------- manufacturing tambahan ----------


def mo(prod, bom, qty, back, finish=True):
    rec = env["mrp.production"].create({"product_id": prod.id, "product_qty": qty, "bom_id": bom.id, "date_start": at(back)})
    rec.action_confirm()
    if finish:
        rec.qty_producing = qty
        for move in rec.move_raw_ids:
            move.write({"quantity": move.product_uom_qty, "picked": True})
        rec.button_mark_done()
    return rec


mo_a = mo(strip5, bom_strip5, 150, 5)
mo_b = mo(kreatinin, bom_kre, 30, 4)
mo_c = mo(strip100, bom_eko, 100, 3)
mo_d = mo(paket, bom_paket, 2, 2)
mo_e = mo(glukosa, bom_glu, 100, 0, finish=False)
mo_f = env["mrp.production"].create({"product_id": kreatinin.id, "product_qty": 50, "bom_id": bom_kre.id, "date_start": at(-2)})
# ---------- akun analitik pada semua transaksi ----------
for request in env["purchase.request"].search([("origin", "in", ["Rencana stok Q4 2026", "Kebutuhan produksi strip dan kit"])]):
    for line in request.line_ids:
        line.analytic_distribution = analytic_for(line.product_id, "purchase")
prl = [p.id for p in Product.search([("default_code", "like", "PRL-%")])]
for line in env["purchase.order.line"].search([("product_id", "in", prl)]):
    line.analytic_distribution = analytic_for(line.product_id, "purchase")
for line in env["sale.order.line"].search([("product_id", "in", prl)]):
    line.analytic_distribution = analytic_for(line.product_id, "sale")
moves = env["account.move"].search([("move_type", "in", ["out_invoice", "in_invoice"]), ("invoice_line_ids.product_id", "in", prl)])
for move in moves:
    kind = "sale" if move.move_type == "out_invoice" else "purchase"
    for line in move.invoice_line_ids.filtered("product_id"):
        line.analytic_distribution = analytic_for(line.product_id, kind)
for production in env["mrp.production"].search([("product_id", "in", prl)]):
    if "analytic_distribution" in production._fields:
        production.analytic_distribution = analytic_for(production.product_id, "production")
# beberapa jurnal manual (biaya pemasaran dan produksi) dengan analitik
misc = env["account.journal"].search([("type", "=", "general"), ("company_id", "=", company.id)], limit=1)
bank = env["account.journal"].search([("type", "=", "bank"), ("company_id", "=", company.id)], limit=1)
expense = env["account.account"].search([("account_type", "=", "expense"), ("company_ids", "in", company.id)], limit=2, order="code")


def journal(back, ref, amount, expense_account, department, line_acc):
    entry = env["account.move"].create({
        "move_type": "entry", "journal_id": misc.id, "date": day(back), "ref": ref,
        "line_ids": [
            Command.create({"account_id": expense_account.id, "name": ref, "debit": amount, "credit": 0.0, "analytic_distribution": dist(department, line_acc)}),
            Command.create({"account_id": bank.default_account_id.id, "name": ref, "debit": 0.0, "credit": amount}),
        ],
    })
    entry.action_post()
    return entry


je1 = journal(4, "Biaya pameran alat kesehatan Jakarta", 12_500_000, expense[0], D_MKT, L_INST)
je2 = journal(3, "Biaya pemeliharaan lini produksi strip", 6_750_000, expense[-1], D_PROD, L_STRIP)
je3 = journal(2, "Biaya promosi reagen kimia klinik", 4_200_000, expense[0], D_MKT, L_REAG)
env.cr.commit()
print("PRESALES_EXTRA_OK", mo_a.name, mo_b.name, mo_c.name, mo_d.name, mo_e.name, mo_f.name, je1.name, je2.name, je3.name, bill5.name, bill6.name)
