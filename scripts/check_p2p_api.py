#!/usr/bin/env python3
"""Uji regresi alur Procure-to-Pay dan Order-to-Cash lewat API JSON-2, dengan panggilan yang sama seperti UI Nusara.

Procure-to-Pay: Purchase Request -> RFQ (wizard) -> PO -> penerimaan sebagian + backorder -> penerimaan sisa ->
tagihan vendor -> bayar sebagian -> bayar sisa. Juga menjaga jebakan harga manual PO (lihat
docs/DECISIONS.md, D10). Lalu master data Purchase dan Order-to-Cash: Sales Order -> pengiriman -> faktur
pelanggan -> pembayaran -> nota kredit, termasuk jurnal di tiap tahap.

Skrip ini MENULIS data (PR, PO, SO, tagihan, faktur, pembayaran), jadi hanya jalankan pada database uji.
Butuh data contoh dari scripts/seed_demo.py dan API key milik pengguna uji.

    NUSARA_API_KEY=... python3 scripts/check_p2p_api.py --yes [--url http://127.0.0.1:8080]
"""

import argparse
import datetime
import json
import os
import sys
import urllib.error
import urllib.request


class Api:
    def __init__(self, base, key):
        self.base, self.key = base.rstrip("/"), key

    def call(self, model, method, **params):
        request = urllib.request.Request(
            f"{self.base}/json/2/{model}/{method}",
            data=json.dumps(params).encode(),
            headers={"Content-Type": "application/json; charset=utf-8", "Authorization": f"bearer {self.key}"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            body = error.read().decode()
            try:
                body = json.loads(body).get("message", body)
            except ValueError:
                pass
            raise RuntimeError(f"{model}.{method} -> HTTP {error.code}: {str(body)[:200]}") from None

    def read(self, model, record_id, fields):
        return self.call(model, "read", ids=[record_id], fields=fields)[0]

    def search(self, model, domain, fields, **extra):
        return self.call(model, "search_read", domain=domain, fields=fields, **extra)


failures = []


def check(condition, message):
    print(("  ok    " if condition else "  GAGAL ") + message)
    if not condition:
        failures.append(message)


def step(title):
    print(f"\n== {title}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default=os.environ.get("NUSARA_URL", "http://127.0.0.1:8080"))
    parser.add_argument("--yes", action="store_true", help="konfirmasi bahwa database tujuan adalah database uji")
    args = parser.parse_args()
    key = os.environ.get("NUSARA_API_KEY", "")
    if not key or not args.yes:
        sys.exit("Isi NUSARA_API_KEY dan tambahkan --yes. Skrip ini menulis data; pakai database uji.")
    api = Api(args.url, key)

    product = (api.search("product.product", [["name", "=", "Bahan Baku Nusara"]], ["uom_id", "categ_id"], limit=1) or [None])[0]
    vendor = (api.search("res.partner", [["name", "=", "PT Pemasok Nusantara"]], ["id"], limit=1) or [None])[0]
    if not product or not vendor:
        sys.exit("Data contoh belum ada. Jalankan scripts/seed_demo.py dulu.")
    uom = product["uom_id"][0]

    step("Purchase Request -> RFQ lewat wizard")
    [request_id] = api.call("purchase.request", "create", vals_list=[{
        "description": "Uji regresi P2P",
        "line_ids": [[0, 0, {"product_id": product["id"], "product_uom_id": uom, "product_qty": 10.0, "name": "Bahan Baku Nusara"}]],
    }])
    api.call("purchase.request", "button_to_approve", ids=[request_id])
    api.call("purchase.request", "button_approved", ids=[request_id])
    check(api.read("purchase.request", request_id, ["state"])["state"] == "approved", "PR disetujui")
    line_ids = [r["id"] for r in api.search("purchase.request.line", [["request_id", "=", request_id]], ["id"])]
    context = {"active_model": "purchase.request.line", "active_ids": line_ids, "active_id": line_ids[0]}
    wizard = api.call("purchase.request.line.make.purchase.order", "create", vals_list=[{"supplier_id": vendor["id"]}], context=context)
    api.call("purchase.request.line.make.purchase.order", "make_purchase_order", ids=wizard, context=context)
    order_id = api.search("purchase.order", [["order_line.purchase_request_lines.request_id", "=", request_id]], ["id"])[0]["id"]
    order = api.read("purchase.order", order_id, ["state", "amount_untaxed", "amount_tax", "amount_total", "currency_id"])
    check(order["state"] == "draft", "RFQ berstatus draft")
    check(order["amount_untaxed"] == 1_000_000.0, f"harga vendor terbawa ke RFQ (10 x 100.000): {order['amount_untaxed']}")
    check(order["amount_tax"] > 0 and abs(order["amount_total"] - order["amount_untaxed"] - order["amount_tax"]) < 0.01, "PPN dihitung dan total konsisten")

    step("Harga manual PO tidak tertimpa saat header ditulis ulang (jebakan technical_price_unit)")
    manual_id = api.call("purchase.order", "create", vals_list=[{
        "partner_id": vendor["id"],
        "order_line": [[0, 0, {"product_id": product["id"], "name": "Harga manual", "product_qty": 2.0, "product_uom_id": uom}]],
    }])[0]
    manual_line = api.search("purchase.order.line", [["order_id", "=", manual_id]], ["id", "price_unit"])[0]
    check(manual_line["price_unit"] == 100_000.0, "harga otomatis dari daftar harga vendor")
    api.call("purchase.order.line", "write", ids=[manual_line["id"]], vals={"price_unit": 175_000.0})
    api.call("purchase.order", "write", ids=[manual_id], vals={"partner_id": vendor["id"]})
    after = api.read("purchase.order.line", manual_line["id"], ["price_unit"])
    check(after["price_unit"] == 175_000.0, "harga manual bertahan setelah header ditulis ulang")

    step("Konfirmasi PO dan penerimaan sebagian dengan backorder")
    api.call("purchase.order", "button_confirm", ids=[order_id])
    check(api.read("purchase.order", order_id, ["state"])["state"] == "purchase", "PO dikonfirmasi")
    picking = api.search("stock.picking", [["purchase_id", "=", order_id]], ["id", "state"])[0]
    check(picking["state"] == "assigned", "penerimaan otomatis berstatus Siap")
    move = api.search("stock.move", [["picking_id", "=", picking["id"]]], ["id"])[0]
    api.call("stock.move", "write", ids=[move["id"]], vals={"quantity": 4.0, "picked": True})
    action = api.call("stock.picking", "button_validate", ids=[picking["id"]])
    check(isinstance(action, dict) and action.get("res_model") == "stock.backorder.confirmation", "validasi sebagian meminta konfirmasi backorder")
    wizard = api.call("stock.backorder.confirmation", "create", vals_list=[{}], context=action["context"])
    api.call("stock.backorder.confirmation", "process", ids=wizard, context=action["context"])
    state = api.read("purchase.order", order_id, ["receipt_status", "invoice_status", "incoming_picking_count"])
    check(state["receipt_status"] == "partial" and state["incoming_picking_count"] == 2, "PO diterima sebagian, 2 penerimaan")
    check(state["invoice_status"] == "to invoice", "PO perlu ditagih setelah penerimaan")
    backorder = api.search("stock.picking", [["backorder_id", "=", picking["id"]]], ["id"])[0]
    backorder_move = api.search("stock.move", [["picking_id", "=", backorder["id"]]], ["id", "quantity"])[0]
    check(backorder_move["quantity"] == 6.0, "backorder berisi sisa 6")
    api.call("stock.move", "write", ids=[backorder_move["id"]], vals={"quantity": 6.0, "picked": True})
    check(api.call("stock.picking", "button_validate", ids=[backorder["id"]]) is True, "backorder divalidasi tanpa dialog")
    check(api.read("purchase.order", order_id, ["receipt_status"])["receipt_status"] == "full", "PO diterima penuh")

    step("Tagihan vendor")
    api.call("purchase.order", "action_create_invoice", ids=[order_id])
    bill_id = api.read("purchase.order", order_id, ["invoice_ids"])["invoice_ids"][-1]
    bill = api.read("account.move", bill_id, ["state", "move_type", "amount_total"])
    check(bill["state"] == "draft" and bill["move_type"] == "in_invoice", "tagihan vendor draft terbentuk")
    check(bill["amount_total"] == order["amount_total"], "total tagihan sama dengan total PO")
    try:
        api.call("account.move", "action_post", ids=[bill_id])
        check(False, "konfirmasi tanpa tanggal tagihan seharusnya ditolak")
    except RuntimeError as error:
        check("date is required" in str(error), "konfirmasi tanpa tanggal tagihan ditolak Odoo")
    api.call("account.move", "write", ids=[bill_id], vals={"invoice_date": datetime.date.today().isoformat(), "ref": "INV-REGRESI-001"})
    api.call("account.move", "action_post", ids=[bill_id])
    bill = api.read("account.move", bill_id, ["state", "payment_state", "amount_residual", "amount_total"])
    check(bill["state"] == "posted" and bill["payment_state"] == "not_paid", "tagihan terposting, belum dibayar")

    step("Jurnal tagihan vendor")
    items = api.search("account.move.line", [["move_id", "=", bill_id]], ["account_id", "debit", "credit"])
    check(abs(sum(i["debit"] for i in items) - sum(i["credit"] for i in items)) < 0.005, "jurnal tagihan seimbang")
    payable = [i for i in items if i["credit"]]
    check(len(payable) == 1 and payable[0]["credit"] == bill["amount_total"], "hutang usaha dikredit sebesar total tagihan")
    category = api.read("product.category", product["categ_id"][0], ["property_valuation", "property_stock_valuation_account_id"]) if product["categ_id"] else None
    check(category is not None, "produk contoh punya kategori (tanpa kategori barang stok tidak masuk Persediaan)")
    if category and category["property_valuation"] == "real_time":
        stock_account = category["property_stock_valuation_account_id"][0]
        check(any(i["account_id"][0] == stock_account and i["debit"] == 1_000_000.0 for i in items), "valuasi perpetual: tagihan mendebit akun Persediaan, bukan beban")

    step("Pembayaran sebagian lalu pelunasan lewat wizard Register Payment")
    pay_context = {"active_model": "account.move", "active_ids": [bill_id]}

    def pay(amount):
        wizard_id = api.call("account.payment.register", "create", vals_list=[{}], context=pay_context)
        api.call("account.payment.register", "write", ids=wizard_id, vals={"amount": amount}, context=pay_context)
        return api.call("account.payment.register", "action_create_payments", ids=wizard_id, context=pay_context)

    pay(500_000.0)
    bill = api.read("account.move", bill_id, ["payment_state", "amount_residual"])
    check(bill["payment_state"] == "partial" and bill["amount_residual"] == bill_total(api, bill_id) - 500_000.0, "bayar sebagian: status partial, sisa berkurang")
    pay(bill["amount_residual"])
    bill = api.read("account.move", bill_id, ["payment_state", "amount_residual", "matched_payment_ids"])
    check(bill["payment_state"] == "paid" and bill["amount_residual"] == 0.0, "lunas: status paid, sisa 0")
    check(len(bill["matched_payment_ids"]) == 2, "dua pembayaran terkait tagihan")
    for payment_id in bill["matched_payment_ids"]:
        payment = api.read("account.payment", payment_id, ["amount", "move_id", "destination_account_id", "outstanding_account_id"])
        entry = api.search("account.move.line", [["move_id", "=", payment["move_id"][0]]], ["account_id", "debit", "credit"])
        debit = [e for e in entry if e["debit"]]
        credit = [e for e in entry if e["credit"]]
        check(
            len(debit) == 1 and debit[0]["account_id"][0] == payment["destination_account_id"][0] and debit[0]["debit"] == payment["amount"]
            and len(credit) == 1 and credit[0]["account_id"][0] == payment["outstanding_account_id"][0],
            f"jurnal pembayaran {payment['amount']:,.0f}: debit hutang usaha, kredit akun pembayaran tertunda",
        )

    check_master_data(api)
    check_order_to_cash(api, product)
    check_financial_reports(api)
    check_bank_reconciliation(api)
    check_inventory(api, product)
    check_warehouse_master(api, product)
    check_lots(api, vendor)
    check_manufacturing(api)
    check_crm(api)
    check_pos(api, product)

    print("\n" + ("SEMUA LULUS" if not failures else f"{len(failures)} PEMERIKSAAN GAGAL"))
    sys.exit(1 if failures else 0)


def check_master_data(api):
    """Master data Purchase: vendor, produk, dan harga vendor yang menggerakkan harga RFQ."""
    step("Master data: vendor, produk, dan harga vendor")
    tag = datetime.datetime.now().strftime("%H%M%S")
    [vendor_id] = api.call("res.partner", "create", vals_list=[{
        "name": f"Vendor Regresi {tag}", "is_company": True, "supplier_rank": 1, "email": "regresi@example.com",
    }])
    check(bool(api.search("res.partner", [["supplier_rank", ">", 0], ["id", "=", vendor_id]], ["id"])), "vendor baru muncul di daftar pemasok")
    api.call("res.partner", "write", ids=[vendor_id], vals={"phone": "021-555-0100"})
    vendor = api.read("res.partner", vendor_id, ["email", "phone"])
    check(vendor["phone"] == "021-555-0100" and vendor["email"] == "regresi@example.com", "ubah satu field, field lain utuh")
    api.call("res.partner", "action_archive", ids=[vendor_id])
    check(not api.search("res.partner", [["id", "=", vendor_id]], ["id"]), "vendor diarsipkan hilang dari daftar aktif")
    check(bool(api.search("res.partner", [["id", "=", vendor_id]], ["id"], context={"active_test": False})), "vendor arsip tetap ada")
    api.call("res.partner", "action_unarchive", ids=[vendor_id])
    check(bool(api.search("res.partner", [["id", "=", vendor_id]], ["id"])), "vendor diaktifkan kembali")

    defaults = api.call("product.template", "default_get", fields=["uom_id", "supplier_taxes_id"])
    [tmpl_id] = api.call("product.template", "create", vals_list=[{
        "name": f"Produk Regresi {tag}", "type": "consu", "purchase_ok": True, "sale_ok": True, "uom_id": defaults["uom_id"],
        "list_price": 300_000.0, "standard_price": 200_000.0, "default_code": f"RG-{tag}",
    }])
    tmpl = api.read("product.template", tmpl_id, ["supplier_taxes_id", "product_variant_id", "seller_ids"])
    check(bool(tmpl["supplier_taxes_id"]), "pajak pembelian bawaan perusahaan terpasang bila tidak dikirim")
    api.call("product.template", "write", ids=[tmpl_id], vals={"supplier_taxes_id": [[6, 0, []]]})
    check(api.read("product.template", tmpl_id, ["supplier_taxes_id"])["supplier_taxes_id"] == [], "pajak dikosongkan lewat perintah 6")
    api.call("product.template", "write", ids=[tmpl_id], vals={"supplier_taxes_id": [[6, 0, tmpl["supplier_taxes_id"]]]})
    variant_id = tmpl["product_variant_id"][0]
    check(tmpl["seller_ids"] == [], "produk baru belum punya harga vendor")

    idr = api.search("res.currency", [["name", "=", "IDR"]], ["id"])[0]["id"]

    def rfq_price(qty):
        order_id = api.call("purchase.order", "create", vals_list=[{
            "partner_id": vendor_id,
            "order_line": [[0, 0, {"product_id": variant_id, "product_qty": qty, "product_uom_id": defaults["uom_id"]}]],
        }])[0]
        return api.search("purchase.order.line", [["order_id", "=", order_id]], ["price_unit"])[0]["price_unit"]

    [base_id] = api.call("product.supplierinfo", "create", vals_list=[{
        "partner_id": vendor_id, "product_tmpl_id": tmpl_id, "min_qty": 1.0, "price": 250_000.0, "currency_id": idr, "delay": 3,
    }])
    check(rfq_price(1.0) == 250_000.0, "harga vendor baru otomatis terisi di baris RFQ")
    api.call("product.supplierinfo", "create", vals_list=[{
        "partner_id": vendor_id, "product_tmpl_id": tmpl_id, "min_qty": 10.0, "price": 200_000.0, "currency_id": idr, "delay": 3,
    }])
    check(rfq_price(12.0) == 200_000.0, "harga bertingkat: jumlah >= 10 memakai harga tier")
    api.call("product.supplierinfo", "write", ids=[base_id], vals={"price": 230_000.0})
    check(rfq_price(1.0) == 230_000.0, "perubahan harga vendor berlaku pada RFQ berikutnya")
    check(len(api.read("product.template", tmpl_id, ["seller_ids"])["seller_ids"]) == 2, "produk menampilkan dua harga vendor")
    api.call("product.supplierinfo", "unlink", ids=[base_id])
    check(rfq_price(1.0) != 230_000.0, "harga vendor yang dihapus tidak dipakai lagi")

    api.call("product.template", "action_archive", ids=[tmpl_id])
    check(not api.search("product.template", [["id", "=", tmpl_id]], ["id"]), "produk diarsipkan hilang dari daftar aktif")
    api.call("product.template", "action_unarchive", ids=[tmpl_id])
    check(bool(api.search("product.template", [["id", "=", tmpl_id]], ["id"])), "produk diaktifkan kembali")


def check_order_to_cash(api, product):
    """Sales Order sampai nota kredit atas barang stok yang sudah diterima oleh alur Procure-to-Pay."""
    step("Order-to-Cash: SO, pengiriman, faktur pelanggan, pembayaran, nota kredit")
    tag = datetime.datetime.now().strftime("%H%M%S")
    [customer_id] = api.call("res.partner", "create", vals_list=[{"name": f"Pelanggan Regresi {tag}", "is_company": True, "customer_rank": 1}])
    list_price = api.read("product.product", product["id"], ["lst_price"])["lst_price"]

    def journal_count():
        return api.call("account.move", "search_count", domain=[])

    [so_id] = api.call("sale.order", "create", vals_list=[{
        "partner_id": customer_id, "order_line": [[0, 0, {"product_id": product["id"], "product_uom_qty": 4.0}]],
    }])
    line = api.search("sale.order.line", [["order_id", "=", so_id]], ["price_unit"])[0]
    check(line["price_unit"] == list_price, f"harga baris SO datang dari daftar harga ({list_price:,.0f})")
    # Harga dan diskon manual ditulis sebagai langkah kedua, lalu kuantitas diubah: keduanya harus bertahan.
    api.call("sale.order.line", "write", ids=[line["id"]], vals={"price_unit": 120_000.0, "discount": 10.0})
    api.call("sale.order.line", "write", ids=[line["id"]], vals={"product_uom_qty": 3.0})
    line = api.search("sale.order.line", [["order_id", "=", so_id]], ["price_unit", "discount", "price_subtotal"])[0]
    check(line["price_unit"] == 120_000.0 and line["discount"] == 10.0, "harga dan diskon manual bertahan saat kuantitas diubah")
    check(line["price_subtotal"] == 324_000.0, "subtotal 3 x 120.000 dikurangi diskon 10%")

    before = journal_count()
    api.call("sale.order", "action_confirm", ids=[so_id])
    order = api.read("sale.order", so_id, ["state", "amount_total", "delivery_count"])
    check(order["state"] == "sale" and order["delivery_count"] == 1, "SO dikonfirmasi dan pengiriman terbentuk")
    check(journal_count() == before, "konfirmasi SO tidak membuat jurnal")
    picking = api.search("stock.picking", [["sale_id", "=", so_id]], ["id", "state", "picking_type_code"])[0]
    check(picking["picking_type_code"] == "outgoing" and picking["state"] == "assigned", "pengiriman berstatus Siap (stok tersedia)")
    move = api.search("stock.move", [["picking_id", "=", picking["id"]]], ["id"])[0]
    api.call("stock.move", "write", ids=[move["id"]], vals={"quantity": 3.0, "picked": True})
    check(api.call("stock.picking", "button_validate", ids=[picking["id"]]) is True, "pengiriman divalidasi tanpa dialog")
    check(api.read("sale.order", so_id, ["delivery_status"])["delivery_status"] == "full", "SO terkirim penuh")
    check(journal_count() == before, "pengiriman barang tidak membuat jurnal")

    context = {"active_model": "sale.order", "active_ids": [so_id], "active_id": so_id}
    wizard = api.call("sale.advance.payment.inv", "create", vals_list=[{}], context=context)
    result = api.call("sale.advance.payment.inv", "create_invoices", ids=wizard, context=context)
    invoice_id = result["res_id"]
    invoice = api.read("account.move", invoice_id, ["move_type", "state", "amount_total", "amount_untaxed", "l10n_id_kode_transaksi", "journal_id"])
    check(invoice["move_type"] == "out_invoice" and invoice["state"] == "draft", "faktur pelanggan draft terbentuk")
    check(invoice["amount_total"] == order["amount_total"], "total faktur sama dengan total SO")
    check(bool(invoice["l10n_id_kode_transaksi"]), "kode transaksi faktur pajak terisi dari lokalisasi Indonesia")
    api.call("account.move", "action_post", ids=[invoice_id])
    items = api.search("account.move.line", [["move_id", "=", invoice_id]], ["account_id", "debit", "credit"])
    types = {a["id"]: a["account_type"] for a in api.search("account.account", [["id", "in", [i["account_id"][0] for i in items]]], ["account_type"])}
    check(abs(sum(i["debit"] for i in items) - sum(i["credit"] for i in items)) < 0.005, "jurnal faktur seimbang")
    receivable = [i for i in items if types[i["account_id"][0]] == "asset_receivable"]
    check(len(receivable) == 1 and receivable[0]["debit"] == invoice["amount_total"], "piutang usaha didebit sebesar total faktur")
    income = [i for i in items if types[i["account_id"][0]] in ("income", "income_other")]
    check(sum(i["credit"] for i in income) == 324_000.0, "penjualan dikredit sebesar subtotal")
    cost = [i for i in items if types[i["account_id"][0]] in ("expense", "expense_direct_cost") and i["debit"]]
    stock = [i for i in items if types[i["account_id"][0]] == "asset_current" and i["credit"]]
    if cost and stock:
        check(sum(i["debit"] for i in cost) == sum(i["credit"] for i in stock) > 0, "valuasi perpetual: HPP didebit dan Persediaan dikredit sama besar")
    else:
        check(False, "faktur penjualan barang stok harus menjurnal HPP dan Persediaan (valuasi perpetual)")

    pay_context = {"active_model": "account.move", "active_ids": [invoice_id]}
    pay_wizard = api.call("account.payment.register", "create", vals_list=[{}], context=pay_context)
    api.call("account.payment.register", "action_create_payments", ids=pay_wizard, context=pay_context)
    paid = api.read("account.move", invoice_id, ["payment_state", "amount_residual"])
    check(paid["payment_state"] in ("paid", "in_payment") and paid["amount_residual"] == 0.0, "faktur lunas setelah pembayaran pelanggan")
    payment = api.search("account.payment", [["partner_id", "=", customer_id]], ["payment_type", "amount"])[0]
    check(payment["payment_type"] == "inbound" and payment["amount"] == invoice["amount_total"], "pembayaran masuk sebesar total faktur")

    reverse_context = {"active_model": "account.move", "active_ids": [invoice_id]}
    reversal = api.call("account.move.reversal", "create", vals_list=[{"reason": "Retur regresi", "journal_id": invoice["journal_id"][0], "move_ids": [[6, 0, [invoice_id]]]}], context=reverse_context)
    credit_id = api.call("account.move.reversal", "refund_moves", ids=reversal, context=reverse_context)["res_id"]
    api.call("account.move", "action_post", ids=[credit_id])
    credit = api.read("account.move", credit_id, ["move_type", "state", "amount_total", "reversed_entry_id"])
    check(credit["move_type"] == "out_refund" and credit["state"] == "posted" and credit["amount_total"] == invoice["amount_total"], "nota kredit terposting sebesar faktur")
    check(credit["reversed_entry_id"][0] == invoice_id, "nota kredit menunjuk ke faktur asal")


def check_inventory(api, product):
    """Hitung fisik, scrap, dan aturan stok minimum (sama dengan halaman Physical Inventory, Scrap, Replenishment)."""
    step("Inventaris: hitung fisik, scrap, aturan stok minimum")
    mode = {"inventory_mode": True}
    quant = api.search("stock.quant", [["product_id", "=", product["id"]], ["location_id.usage", "=", "internal"]], ["id", "quantity", "location_id"])[0]
    start = quant["quantity"]

    def on_hand():
        return api.read("stock.quant", quant["id"], ["quantity"])["quantity"]

    journals_before = api.call("account.move", "search_count", domain=[])
    api.call("stock.quant", "write", ids=[quant["id"]], vals={"inventory_quantity": start - 2}, context=mode)
    check(api.read("stock.quant", quant["id"], ["inventory_diff_quantity"], )["inventory_diff_quantity"] == -2.0, "selisih hitungan terbaca sebelum diterapkan")
    api.call("stock.quant", "action_apply_inventory", ids=[quant["id"]], context=mode)
    check(on_hand() == start - 2, "penerapan hitungan fisik mengubah stok")
    adjustment = api.search("stock.move", [["product_id", "=", product["id"]], ["is_inventory", "=", True]], ["value", "state", "account_move_id"], order="id desc", limit=1)[0]
    check(adjustment["state"] == "done" and abs(adjustment["value"]) > 0, "penyesuaian dinilai pada pergerakan stok")
    check(not adjustment["account_move_id"] and api.call("account.move", "search_count", domain=[]) == journals_before, "penyesuaian stok tidak dijurnal otomatis (dipantau di Laporan Stok)")

    scrap_vals = {"product_id": product["id"], "scrap_qty": 1.0, "location_id": quant["location_id"][0], "product_uom_id": product["uom_id"][0]}
    [scrap] = api.call("stock.scrap", "create", vals_list=[scrap_vals])
    check(api.call("stock.scrap", "action_validate", ids=[scrap]) is True, "scrap divalidasi tanpa dialog")
    check(on_hand() == start - 3, "scrap mengurangi stok")
    [too_much] = api.call("stock.scrap", "create", vals_list=[{**scrap_vals, "scrap_qty": 1e6}])
    warn = api.call("stock.scrap", "action_validate", ids=[too_much])
    check(isinstance(warn, dict) and warn.get("res_model") == "stock.warn.insufficient.qty.scrap", "scrap melebihi stok meminta konfirmasi")
    api.call("stock.scrap", "unlink", ids=[too_much])

    warehouse = api.search("stock.warehouse", [], ["id", "lot_stock_id"], limit=1)[0]
    existing = api.search(
        "stock.warehouse.orderpoint", [["product_id", "=", product["id"]], ["location_id", "=", warehouse["lot_stock_id"][0]]],
        ["id", "product_min_qty", "product_max_qty", "trigger", "qty_forecast"],
    )
    if existing:  # aturan sudah ada (database yang dipakai berulang): ubah sementara lalu kembalikan
        rule = existing[0]["id"]
        original = {k: existing[0][k] for k in ("product_min_qty", "product_max_qty", "trigger")}
        forecast = existing[0]["qty_forecast"]
        shortage = {"product_min_qty": forecast + 100, "product_max_qty": forecast + 150, "trigger": "manual"}
        api.call("stock.warehouse.orderpoint", "write", ids=[rule], vals=shortage)
    else:
        shortage = {"product_min_qty": 1000.0, "product_max_qty": 1100.0, "trigger": "manual"}
        [rule] = api.call("stock.warehouse.orderpoint", "create", vals_list=[{
            "product_id": product["id"], "warehouse_id": warehouse["id"], "location_id": warehouse["lot_stock_id"][0], **shortage,
        }])
        original = None
    needed = api.read("stock.warehouse.orderpoint", rule, ["qty_to_order"])
    check(needed["qty_to_order"] > 0, "stok di bawah minimum menghasilkan jumlah yang perlu dipesan")
    notice = api.call("stock.warehouse.orderpoint", "action_replenish", ids=[rule])
    labels = [link["label"] for link in notice.get("params", {}).get("links", [])] if isinstance(notice, dict) else []
    check(bool(labels), "pengisian ulang membuat RFQ dan menyebut nomornya")
    rfq = api.search("purchase.order", [["name", "in", labels]], ["id", "state", "origin"])[0] if labels else None
    check(rfq is not None and rfq["state"] == "draft", "RFQ dari pengisian ulang berstatus draft")
    if original:
        api.call("stock.warehouse.orderpoint", "write", ids=[rule], vals=original)
    else:
        api.call("stock.warehouse.orderpoint", "unlink", ids=[rule])


def check_warehouse_master(api, product):
    """Lokasi, satuan, aturan penyimpanan, dan transfer internal (halaman Warehouse & Location, UoM, Put away, Transfer)."""
    step("Master gudang: lokasi, satuan, aturan penyimpanan, transfer internal")
    tag = datetime.datetime.now().strftime("%H%M%S")
    api.call("res.config.settings", "execute", ids=api.call("res.config.settings", "create", vals_list=[{"group_stock_multi_locations": True, "group_stock_production_lot": True}]))
    check(bool(api.call("res.users", "has_group", ids=[api.search("res.users", [["login", "!=", False]], ["id"], limit=1)[0]["id"]], group_ext_id="stock.group_stock_multi_locations")), "fitur Storage Locations aktif lewat pengaturan")
    warehouse = api.search("stock.warehouse", [], ["id", "lot_stock_id"], limit=1)[0]
    stock_location = warehouse["lot_stock_id"][0]
    [rack] = api.call("stock.location", "create", vals_list=[{"name": f"Rak {tag}", "location_id": stock_location, "usage": "internal"}])
    check(api.read("stock.location", rack, ["complete_name"])["complete_name"].endswith(f"Rak {tag}"), "lokasi baru berada di bawah lokasi induknya")
    [unit] = api.call("uom.uom", "create", vals_list=[{"name": f"Lusin {tag}", "relative_uom_id": product["uom_id"][0], "relative_factor": 12.0}])
    check(api.read("uom.uom", unit, ["factor"])["factor"] == 12.0, "satuan baru berisi 12 satuan acuan")
    [rule] = api.call("stock.putaway.rule", "create", vals_list=[{"product_id": product["id"], "location_in_id": warehouse["lot_stock_id"][0], "location_out_id": rack, "sequence": 99}])
    check(api.read("stock.putaway.rule", rule, ["location_out_id"])["location_out_id"][0] == rack, "aturan penyimpanan tersimpan")
    api.call("stock.putaway.rule", "unlink", ids=[rule])
    internal = api.search("stock.picking.type", [["code", "=", "internal"], ["active", "=", True]], ["id"], limit=1)
    check(bool(internal), "tipe operasi Internal Transfers aktif")
    before = api.search("stock.quant", [["product_id", "=", product["id"]], ["location_id", "=", rack]], ["quantity"])
    start = before[0]["quantity"] if before else 0.0
    [picking] = api.call("stock.picking", "create", vals_list=[{
        "picking_type_id": internal[0]["id"], "location_id": stock_location, "location_dest_id": rack,
        "move_ids": [[0, 0, {"product_id": product["id"], "product_uom_qty": 2.0, "location_id": stock_location, "location_dest_id": rack}]],
    }])
    api.call("stock.picking", "action_confirm", ids=[picking])
    move = api.search("stock.move", [["picking_id", "=", picking]], ["id"])[0]["id"]
    api.call("stock.move", "write", ids=[move], vals={"quantity": 2.0, "picked": True})
    check(api.call("stock.picking", "button_validate", ids=[picking]) is True, "transfer internal divalidasi tanpa dialog")
    after = api.search("stock.quant", [["product_id", "=", product["id"]], ["location_id", "=", rack]], ["quantity"])[0]["quantity"]
    check(after == start + 2.0, "stok berpindah ke lokasi tujuan")


def check_lots(api, vendor):
    """Lot, nomor seri, dan kedaluwarsa: penerimaan, pengiriman, scrap, hitung fisik (halaman Lot, Penerimaan, Pengiriman, Scrap, Physical Inventory)."""
    step("Lot dan nomor seri: penerimaan, pengiriman, kedaluwarsa, scrap, hitung fisik")
    tag = datetime.datetime.now().strftime("%H%M%S")
    api.call("res.config.settings", "execute", ids=api.call("res.config.settings", "create", vals_list=[{"group_stock_production_lot": True}]))
    goods = api.search("product.category", [["name", "=", "Goods"]], ["id"], limit=1)
    customer = api.search("res.partner", [["name", "=", "PT Pelanggan Nusantara"]], ["id"], limit=1)[0]["id"]
    warehouse = api.search("stock.warehouse", [], ["lot_stock_id"], limit=1)[0]
    stock_location = warehouse["lot_stock_id"][0]
    base = {"type": "consu", "is_storable": True, "standard_price": 50_000.0, "list_price": 80_000.0, "categ_id": goods[0]["id"] if goods else False}

    def new_product(name, **extra):
        [tmpl] = api.call("product.template", "create", vals_list=[{**base, "name": f"{name} {tag}", **extra}])
        api.call("product.supplierinfo", "create", vals_list=[{"partner_id": vendor["id"], "product_tmpl_id": tmpl, "min_qty": 1.0, "price": 50_000.0}])
        return api.read("product.template", tmpl, ["product_variant_id", "uom_id", "tracking"])

    def receive(product, qty):
        [po] = api.call("purchase.order", "create", vals_list=[{"partner_id": vendor["id"], "order_line": [[0, 0, {"product_id": product["product_variant_id"][0], "product_qty": qty, "product_uom_id": product["uom_id"][0]}]]}])
        api.call("purchase.order", "button_confirm", ids=[po])
        picking = api.search("stock.picking", [["purchase_id", "=", po]], ["id"])[0]["id"]
        move = api.search("stock.move", [["picking_id", "=", picking]], ["id", "location_id", "location_dest_id", "product_uom"])[0]
        line = api.search("stock.move.line", [["move_id", "=", move["id"]]], ["id"])[0]["id"]
        return po, picking, move, line

    def add_line(picking, move, product, vals):
        [new] = api.call("stock.move.line", "create", vals_list=[{
            "move_id": move["id"], "picking_id": picking, "product_id": product["product_variant_id"][0], "product_uom_id": move["product_uom"][0],
            "location_id": move["location_id"][0], "location_dest_id": move["location_dest_id"][0], "picked": True, **vals,
        }])
        return new

    def lot_qty(name, product):
        found = api.search("stock.lot", [["product_id", "=", product["product_variant_id"][0]], ["name", "=", name]], ["product_qty"])
        return found[0]["product_qty"] if found else None

    product = new_product("Obat Regresi Lot", tracking="lot", use_expiration_date=True, expiration_time=365, use_time=300, removal_time=60, alert_time=30)
    check(product["tracking"] == "lot", "produk berlacak per lot tersimpan")
    pv = product["product_variant_id"][0]

    po, picking, move, line = receive(product, 10.0)
    api.call("stock.move.line", "write", ids=[line], vals={"picked": True})
    try:
        api.call("stock.picking", "button_validate", ids=[picking])
        check(False, "penerimaan barang berlacak tanpa nomor lot seharusnya ditolak")
    except RuntimeError as error:
        check("supply a Lot/Serial" in str(error), "penerimaan tanpa nomor lot ditolak Odoo")
    api.call("stock.move.line", "write", ids=[line], vals={"lot_name": f"A-{tag}", "quantity": 6.0, "picked": True})
    add_line(picking, move, product, {"lot_name": f"B-{tag}", "quantity": 4.0})
    check(api.call("stock.picking", "button_validate", ids=[picking]) is True, "penerimaan dengan dua lot divalidasi tanpa dialog")
    check((lot_qty(f"A-{tag}", product), lot_qty(f"B-{tag}", product)) == (6.0, 4.0), "dua lot terbentuk dengan stok 6 dan 4")
    lot_a = api.search("stock.lot", [["name", "=", f"A-{tag}"], ["product_id", "=", pv]], ["expiration_date", "alert_date", "removal_date", "purchase_order_ids"])[0]
    check(bool(lot_a["expiration_date"]) and lot_a["expiration_date"][:4] >= str(datetime.date.today().year), "tanggal kedaluwarsa lot dihitung dari pengaturan produk")
    check(lot_a["alert_date"] < lot_a["expiration_date"] and lot_a["removal_date"] < lot_a["expiration_date"], "tanggal peringatan dan penarikan sebelum kedaluwarsa")
    check(lot_a["purchase_order_ids"] == [po], "lot terhubung ke PO penerimaan")

    step("Lot: pengiriman memesan lot, pilihan lot diubah, retur membawa lot")
    [so] = api.call("sale.order", "create", vals_list=[{"partner_id": customer, "order_line": [[0, 0, {"product_id": pv, "product_uom_qty": 7.0}]]}])
    api.call("sale.order", "action_confirm", ids=[so])
    delivery = api.search("stock.picking", [["sale_id", "=", so]], ["id", "state"])[0]
    check(delivery["state"] == "assigned", "pengiriman barang berlacak siap (stok lot cukup)")
    dmove = api.search("stock.move", [["picking_id", "=", delivery["id"]]], ["id", "has_tracking", "location_id", "location_dest_id", "product_uom"])[0]
    check(dmove["has_tracking"] == "lot", "pergerakan pengiriman ditandai berlacak lot")
    reserved = api.search("stock.move.line", [["move_id", "=", dmove["id"]]], ["lot_id", "quantity"])
    check(sum(r["quantity"] for r in reserved) == 7.0 and all(r["lot_id"] for r in reserved), "Odoo memesan lot tertentu untuk 7 unit")
    quants = api.search("stock.quant", [["product_id", "=", pv], ["location_id", "child_of", stock_location], ["lot_id", "!=", False], ["quantity", ">", 0]], ["lot_id", "quantity"])
    check({q["lot_id"][1] for q in quants} == {f"A-{tag}", f"B-{tag}"}, "pilihan lot di lokasi asal tersedia untuk dropdown")
    api.call("stock.move.line", "unlink", ids=[r["id"] for r in reserved])
    lot_ids = {q["lot_id"][1]: q["lot_id"][0] for q in quants}
    for name, qty in ((f"A-{tag}", 3.0), (f"B-{tag}", 4.0)):
        add_line(delivery["id"], dmove, product, {"lot_id": lot_ids[name], "quantity": qty})
    check(api.call("stock.picking", "button_validate", ids=[delivery["id"]]) is True, "pengiriman dengan lot pilihan divalidasi")
    check((lot_qty(f"A-{tag}", product), lot_qty(f"B-{tag}", product)) == (3.0, 0.0), "stok per lot setelah pengiriman: A=3, B=0")
    trace = api.search("stock.move.line", [["lot_id", "=", lot_ids[f"B-{tag}"]], ["state", "=", "done"]], ["reference", "picking_code", "location_id", "location_dest_id"], order="date, id")
    check([t["picking_code"] for t in trace] == ["incoming", "outgoing"], "riwayat lot: diterima lalu dikirim")
    lot_doc = api.read("stock.lot", lot_ids[f"B-{tag}"], ["delivery_ids", "purchase_order_ids", "sale_order_ids", "delivery_count"])
    check(lot_doc["delivery_ids"] == [delivery["id"]] and lot_doc["sale_order_ids"] == [so] and lot_doc["purchase_order_ids"] == [po], "lot terhubung ke PO, SO, dan pengiriman")
    context = {"active_model": "stock.picking", "active_ids": [delivery["id"]], "active_id": delivery["id"]}
    [return_wizard] = api.call("stock.return.picking", "create", vals_list=[{}], context=context)
    return_line = api.search("stock.return.picking.line", [["wizard_id", "=", return_wizard]], ["id"], context=context)[0]["id"]
    api.call("stock.return.picking.line", "write", ids=[return_line], vals={"quantity": 2.0}, context=context)
    returned = api.call("stock.return.picking", "action_create_returns", ids=[return_wizard], context=context)["res_id"]
    return_lines = api.search("stock.move.line", [["picking_id", "=", returned]], ["lot_id", "lot_name"])
    check(bool(return_lines) and bool(return_lines[0]["lot_id"] or return_lines[0]["lot_name"]), "retur membawa lot dari pengiriman asal")

    step("Lot: filter halaman Lot, kedaluwarsa, scrap, hitung fisik")
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    check(any(r["name"] == f"A-{tag}" for r in api.search("stock.lot", [["product_qty", ">", 0], ["name", "ilike", tag]], ["name"])), "filter 'ada stok' menemukan lot A")
    check(not api.search("stock.lot", [["expiration_date", "<", now], ["product_qty", ">", 0], ["name", "ilike", tag]], ["name"]), "belum ada lot kedaluwarsa")
    api.call("stock.lot", "write", ids=[lot_ids[f"A-{tag}"]], vals={"expiration_date": "2020-01-01 00:00:00"})
    check(len(api.search("stock.lot", [["expiration_date", "<", now], ["product_qty", ">", 0], ["name", "ilike", tag]], ["name"])) == 1, "lot yang tanggalnya lewat masuk filter kedaluwarsa")
    check(isinstance(api.search("stock.lot", [["alert_date", "<", now], ["expiration_date", ">=", now], ["product_qty", ">", 0]], ["name"]), list), "filter perlu-perhatian diterima Odoo")
    [scrap] = api.call("stock.scrap", "create", vals_list=[{"product_id": pv, "scrap_qty": 1.0, "product_uom_id": product["uom_id"][0], "location_id": stock_location, "lot_id": lot_ids[f"A-{tag}"]}])
    api.call("stock.scrap", "action_validate", ids=[scrap])
    check(api.read("stock.scrap", scrap, ["state"])["state"] == "done" and lot_qty(f"A-{tag}", product) == 2.0, "scrap dengan lot mengurangi stok lot itu")
    [counted] = api.call("stock.lot", "create", vals_list=[{"name": f"C-{tag}", "product_id": pv}])
    [quant] = api.call("stock.quant", "create", vals_list=[{"product_id": pv, "location_id": stock_location, "lot_id": counted, "inventory_quantity": 5.0}], context={"inventory_mode": True})
    api.call("stock.quant", "action_apply_inventory", ids=[quant], context={"inventory_mode": True})
    check(lot_qty(f"C-{tag}", product) == 5.0, "hitung fisik menambah stok lot baru")

    step("Lot: nomor seri satu unit per baris, dan wizard kedaluwarsa")
    serial = new_product("Laptop Regresi Seri", tracking="serial")
    spo, spicking, smove, sline = receive(serial, 2.0)
    api.call("stock.move.line", "write", ids=[sline], vals={"lot_name": f"SN1-{tag}", "quantity": 2.0, "picked": True})
    try:
        api.call("stock.picking", "button_validate", ids=[spicking])
        check(False, "satu nomor seri untuk dua unit seharusnya ditolak")
    except RuntimeError as error:
        check("1.0 items" in str(error) or "serial" in str(error).lower(), "satu nomor seri untuk dua unit ditolak Odoo")
    api.call("stock.move.line", "write", ids=[sline], vals={"quantity": 1.0})
    add_line(spicking, smove, serial, {"lot_name": f"SN2-{tag}", "quantity": 1.0})
    check(api.call("stock.picking", "button_validate", ids=[spicking]) is True, "dua nomor seri divalidasi")
    check(len(api.search("stock.lot", [["product_id", "=", serial["product_variant_id"][0]]], ["id"])) == 2, "dua nomor seri terbentuk")

    near = new_product("Susu Regresi Alert", tracking="lot", use_expiration_date=True, expiration_time=100, use_time=90, removal_time=80, alert_time=70)
    _po, npicking, nmove, nline = receive(near, 3.0)
    api.call("stock.move.line", "write", ids=[nline], vals={"lot_name": f"N-{tag}", "quantity": 3.0, "picked": True, "expiration_date": (datetime.datetime.now() + datetime.timedelta(days=20)).strftime("%Y-%m-%d %H:%M:%S")})
    result = api.call("stock.picking", "button_validate", ids=[npicking])
    check(isinstance(result, dict) and result.get("res_model") == "expiry.picking.confirmation", "lot yang melewati masa peringatan meminta konfirmasi")
    [expiry_wizard] = api.call("expiry.picking.confirmation", "create", vals_list=[{}], context=result["context"])
    check(result["context"].get("expired_lot_name") == f"N-{tag}", "nama lot terbawa di konteks wizard")
    api.call("expiry.picking.confirmation", "process", ids=[expiry_wizard], context=result["context"])
    check(api.read("stock.picking", npicking, ["state"])["state"] == "done", "penerimaan selesai setelah konfirmasi kedaluwarsa")


def check_manufacturing(api):
    """BoM, work center, Manufacturing Order, backorder, konsumsi berlebih, work order, unbuild, scrap (halaman Manufacture)."""
    step("Manufaktur: BoM, MO, backorder, konsumsi berlebih, work order, unbuild, scrap")
    tag = datetime.datetime.now().strftime("%H%M%S")
    api.call("res.config.settings", "execute", ids=api.call("res.config.settings", "create", vals_list=[{"group_mrp_routings": True, "group_mrp_byproducts": True, "group_stock_production_lot": True}]))
    goods = api.search("product.category", [["name", "=", "Goods"]], ["id"], limit=1)
    warehouse = api.search("stock.warehouse", [], ["lot_stock_id"], limit=1)[0]
    stock_location = warehouse["lot_stock_id"][0]
    base = {"type": "consu", "is_storable": True, "categ_id": goods[0]["id"] if goods else False}

    def new_product(name, cost=0.0, stock=0.0, **extra):
        [tmpl] = api.call("product.template", "create", vals_list=[{**base, "name": f"{name} {tag}", "standard_price": cost, **extra}])
        info = api.read("product.template", tmpl, ["product_variant_id", "uom_id"])
        if stock:
            ctx = {"inventory_mode": True}
            [quant] = api.call("stock.quant", "create", vals_list=[{"product_id": info["product_variant_id"][0], "location_id": stock_location, "inventory_quantity": stock}], context=ctx)
            api.call("stock.quant", "action_apply_inventory", ids=[quant], context=ctx)
        return {"tmpl": tmpl, "id": info["product_variant_id"][0], "uom": info["uom_id"][0]}

    def on_hand(product):
        return api.call("product.product", "read", ids=[product["id"]], fields=["qty_available"], context={"location": stock_location})[0]["qty_available"]

    flour = new_product("Tepung Regresi", cost=10_000.0, stock=100.0)
    sugar = new_product("Gula Regresi", cost=5_000.0, stock=100.0)
    cake = new_product("Kue Regresi")
    pulp = new_product("Ampas Regresi")
    [center] = api.call("mrp.workcenter", "create", vals_list=[{"name": f"Oven Regresi {tag}", "code": f"OV{tag}", "costs_hour": 60_000.0, "time_efficiency": 100.0}])
    check(api.read("mrp.workcenter", center, ["costs_hour"])["costs_hour"] == 60_000.0, "work center tersimpan dengan biaya per jam")
    [bom] = api.call("mrp.bom", "create", vals_list=[{
        "product_tmpl_id": cake["tmpl"], "product_qty": 1.0, "product_uom_id": cake["uom"], "code": f"BOM-{tag}",
        "bom_line_ids": [[0, 0, {"product_id": flour["id"], "product_qty": 2.0, "product_uom_id": flour["uom"]}], [0, 0, {"product_id": sugar["id"], "product_qty": 1.0, "product_uom_id": sugar["uom"]}]],
        "byproduct_ids": [[0, 0, {"product_id": pulp["id"], "product_qty": 1.0, "product_uom_id": pulp["uom"], "cost_share": 10.0}]],
        "operation_ids": [[0, 0, {"name": "Panggang", "workcenter_id": center, "time_mode": "manual", "time_cycle_manual": 30.0}]],
    }])
    report = api.call("report.mrp.report_bom_structure", "get_html", bom_id=bom, searchQty=1, searchVariant=False)["lines"]
    components = sum(c["bom_cost"] for c in report["components"])
    check(components == 25_000.0 and report["operations_cost"] == 30_000.0, "kartu biaya BoM: komponen 25.000, operasi 30.000")
    check(abs(report["bom_cost"] - (components + report["operations_cost"]) * 0.9) < 0.01, "total biaya BoM dikurangi porsi produk sampingan 10%")
    check(bool(api.search("product.product", [["type", "=", "consu"], ["product_tmpl_id.bom_ids", "!=", False], ["name", "ilike", f"Kue Regresi {tag}"]], ["id"])), "pencarian produk yang punya BoM dipakai form MO")

    journals = api.call("account.move", "search_count", domain=[])
    [mo] = api.call("mrp.production", "create", vals_list=[{"product_id": cake["id"], "bom_id": bom, "product_qty": 3.0}])
    check(api.read("mrp.production", mo, ["state"])["state"] == "draft", "MO baru berstatus draft")
    api.call("mrp.production", "action_confirm", ids=[mo])
    info = api.read("mrp.production", mo, ["state", "reservation_state", "components_availability_state", "workorder_ids", "move_raw_ids"])
    check(info["state"] == "confirmed" and info["reservation_state"] == "assigned" and info["components_availability_state"] == "available", "MO dikonfirmasi dan komponen dicadangkan")
    raw = {m["product_id"][0]: m for m in api.search("stock.move", [["raw_material_production_id", "=", mo]], ["id", "product_id", "product_uom_qty", "quantity"])}
    check(raw[flour["id"]]["product_uom_qty"] == 6.0 and raw[sugar["id"]]["product_uom_qty"] == 3.0, "kebutuhan komponen mengikuti BoM untuk 3 unit")
    check(len(info["workorder_ids"]) == 1, "operasi BoM menjadi work order")
    workorder = info["workorder_ids"][0]
    api.call("mrp.workorder", "button_start", ids=[workorder])
    check(api.read("mrp.production", mo, ["state"])["state"] == "progress", "work order dimulai: MO berstatus progress")
    api.call("mrp.workorder", "button_finish", ids=[workorder])
    check(api.read("mrp.workorder", workorder, ["state"])["state"] == "done", "work order selesai")

    # Produksi 2 dari 3 unit dengan konsumsi sesuai rencana -> wizard backorder
    api.call("mrp.production", "write", ids=[mo], vals={"qty_producing": 2.0})
    side = api.search("stock.move", [["production_id", "=", mo], ["byproduct_id", "!=", False]], ["id", "product_uom_qty"])[0]
    check(side["product_uom_qty"] == 3.0, "produk sampingan direncanakan 3 unit untuk MO 3 unit")
    api.call("stock.move", "write", ids=[side["id"]], vals={"quantity": 2.0})  # lewat API, onchange qty_producing tidak menyesuaikan produk sampingan
    api.call("stock.move", "write", ids=[raw[flour["id"]]["id"]], vals={"quantity": 4.0, "picked": True})
    api.call("stock.move", "write", ids=[raw[sugar["id"]]["id"]], vals={"quantity": 2.0, "picked": True})
    action = api.call("mrp.production", "button_mark_done", ids=[mo])
    check(isinstance(action, dict) and action.get("res_model") == "mrp.production.backorder", "produksi kurang dari rencana meminta konfirmasi backorder")
    [wizard] = api.call("mrp.production.backorder", "create", vals_list=[{}], context=action["context"])
    result = api.call("mrp.production.backorder", "action_backorder", ids=[wizard], context=action["context"])
    check(api.read("mrp.production", mo, ["state", "qty_produced"])["state"] == "done" and bool(result.get("res_id")), "MO selesai dan backorder dibuat")
    backorder = result["res_id"]
    check(api.read("mrp.production", backorder, ["product_qty"])["product_qty"] == 1.0, "backorder berisi sisa 1 unit")
    check((on_hand(flour), on_hand(sugar), on_hand(cake), on_hand(pulp)) == (96.0, 98.0, 2.0, 2.0), "stok: komponen berkurang, barang jadi dan produk sampingan bertambah")
    cost = api.read("product.product", cake["id"], ["avg_cost"])["avg_cost"]
    minutes = api.read("mrp.workorder", workorder, ["duration"])["duration"]
    expected_cost = (4 * 10_000.0 + 2 * 5_000.0 + minutes / 60 * 60_000.0) * 0.9 / 2
    check(abs(cost - expected_cost) < 0.5, f"biaya barang jadi = (komponen + operasi {minutes:g} menit) dikurangi porsi sampingan 10% ({cost:,.0f} per unit)")
    check(api.call("account.move", "search_count", domain=[]) == journals, "produksi tidak membuat jurnal (valuasi saat penagihan)")

    # Backorder dengan konsumsi berlebih -> peringatan konsumsi
    api.call("mrp.production", "action_assign", ids=[backorder])
    bo_raw = {m["product_id"][0]: m for m in api.search("stock.move", [["raw_material_production_id", "=", backorder]], ["id", "product_id"])}
    api.call("mrp.production", "write", ids=[backorder], vals={"qty_producing": 1.0})
    bo_side = api.search("stock.move", [["production_id", "=", backorder], ["byproduct_id", "!=", False]], ["id"])[0]["id"]
    api.call("stock.move", "write", ids=[bo_side], vals={"quantity": 1.0})
    api.call("stock.move", "write", ids=[bo_raw[flour["id"]]["id"]], vals={"quantity": 3.0, "picked": True})
    api.call("stock.move", "write", ids=[bo_raw[sugar["id"]]["id"]], vals={"quantity": 1.0, "picked": True})
    warning = api.call("mrp.production", "button_mark_done", ids=[backorder])
    check(isinstance(warning, dict) and warning.get("res_model") == "mrp.consumption.warning", "konsumsi lebih dari rencana meminta konfirmasi")
    [warn_wizard] = api.call("mrp.consumption.warning", "create", vals_list=[{}], context=warning["context"])
    api.call("mrp.consumption.warning", "action_confirm", ids=[warn_wizard], context=warning["context"])
    check(api.read("mrp.production", backorder, ["state"])["state"] == "done", "MO selesai setelah konfirmasi konsumsi")
    check(on_hand(flour) == 93.0 and on_hand(cake) == 3.0, "stok mengikuti konsumsi sebenarnya (tepung 93, kue 3)")

    # Unbuild 1 unit dari MO pertama
    produced = api.read("mrp.production", mo, ["location_src_id", "location_dest_id", "product_uom_id"])
    [unbuild] = api.call("mrp.unbuild", "create", vals_list=[{"mo_id": mo, "product_id": cake["id"], "product_qty": 1.0, "product_uom_id": produced["product_uom_id"][0], "location_id": produced["location_dest_id"][0], "location_dest_id": produced["location_src_id"][0]}])
    check(api.call("mrp.unbuild", "action_validate", ids=[unbuild]) is True and on_hand(cake) == 2.0 and on_hand(flour) == 95.0, "unbuild mengembalikan komponen dan mengeluarkan barang jadi")

    # Scrap dari MO terbuka, batalkan MO, dan hapus draft
    [mo2] = api.call("mrp.production", "create", vals_list=[{"product_id": cake["id"], "bom_id": bom, "product_qty": 1.0}])
    api.call("mrp.production", "action_confirm", ids=[mo2])
    [scrap] = api.call("stock.scrap", "create", vals_list=[{"product_id": sugar["id"], "scrap_qty": 1.0, "product_uom_id": sugar["uom"], "production_id": mo2, "location_id": stock_location}])
    api.call("stock.scrap", "action_validate", ids=[scrap])
    check(api.read("stock.scrap", scrap, ["state"])["state"] == "done" and api.read("mrp.production", mo2, ["scrap_count"])["scrap_count"] == 1, "scrap dari MO tercatat pada MO")
    api.call("mrp.production", "action_cancel", ids=[mo2])
    check(api.read("mrp.production", mo2, ["state"])["state"] == "cancel", "MO dibatalkan")
    [mo3] = api.call("mrp.production", "create", vals_list=[{"product_id": cake["id"], "bom_id": bom, "product_qty": 1.0}])
    api.call("mrp.production", "unlink", ids=[mo3])
    check(not api.search("mrp.production", [["id", "=", mo3]], ["id"]), "MO draft bisa dihapus")

    # Barang jadi berlacak lot: nomor lot diisi saat selesai
    syrup = new_product("Sirup Regresi", tracking="lot")
    [lot_bom] = api.call("mrp.bom", "create", vals_list=[{"product_tmpl_id": syrup["tmpl"], "product_qty": 1.0, "product_uom_id": syrup["uom"], "bom_line_ids": [[0, 0, {"product_id": sugar["id"], "product_qty": 1.0, "product_uom_id": sugar["uom"]}]]}])
    [lot_mo] = api.call("mrp.production", "create", vals_list=[{"product_id": syrup["id"], "bom_id": lot_bom, "product_qty": 2.0}])
    api.call("mrp.production", "action_confirm", ids=[lot_mo])
    check(api.read("mrp.production", lot_mo, ["product_tracking"])["product_tracking"] == "lot", "MO barang berlacak lot mengenali pelacakan")
    [lot] = api.call("stock.lot", "create", vals_list=[{"name": f"SRP-{tag}", "product_id": syrup["id"]}])
    api.call("mrp.production", "write", ids=[lot_mo], vals={"lot_producing_ids": [[6, 0, [lot]]], "qty_producing": 2.0})
    lot_raw = api.search("stock.move", [["raw_material_production_id", "=", lot_mo]], ["id"])[0]["id"]
    api.call("stock.move", "write", ids=[lot_raw], vals={"quantity": 2.0, "picked": True})
    check(api.call("mrp.production", "button_mark_done", ids=[lot_mo]) is True, "MO barang berlacak selesai dengan lot yang dipilih")
    check(api.read("stock.lot", lot, ["product_qty"])["product_qty"] == 2.0, "stok lot hasil produksi 2 unit")

    # Kueri halaman Production Analysis dan Schedule
    done = api.search("mrp.production", [["state", "=", "done"], ["product_id", "=", cake["id"]]], ["product_qty", "date_finished", "duration"])
    check(sum(m["product_qty"] for m in done) == 3.0, "analisis produksi: 3 unit kue selesai (2 + 1)")
    finished = api.search("stock.move", [["production_id", "in", [m["id"] for m in api.search("mrp.production", [["state", "=", "done"], ["product_id", "=", cake["id"]]], ["id"])]], ["state", "=", "done"]], ["product_id", "value", "byproduct_id"])
    check(bool(finished) and all(isinstance(m["value"], (int, float)) for m in finished), "nilai pergerakan barang jadi bisa dibaca untuk analisis")
    check(isinstance(api.search("mrp.production", [["state", "in", ["draft", "confirmed", "progress", "to_close"]], ["date_start", "<", "2999-01-01 00:00:00"]], ["name", "date_start", "components_availability_state"], order="date_start, id"), list), "kueri jadwal produksi diterima Odoo")


def check_crm(api):
    """Lead, opportunity, pipeline, menang dan kalah, quotation, dan aktivitas (halaman Leads, Opportunity, CRM Setting)."""
    step("CRM: lead, opportunity, tahap pipeline, menang, kalah, quotation, aktivitas")
    tag = datetime.datetime.now().strftime("%H%M%S")
    api.call("res.config.settings", "execute", ids=api.call("res.config.settings", "create", vals_list=[{"group_use_lead": True}]))
    check(bool(api.call("res.users", "has_group", ids=[api.search("res.users", [["login", "!=", False]], ["id"], limit=1)[0]["id"]], group_ext_id="crm.group_use_lead")), "fitur Leads aktif lewat pengaturan")
    stages = api.search("crm.stage", [], ["name", "is_won"], order="sequence, id")
    check(len(stages) >= 2 and stages[-1]["is_won"], "tahap pipeline tersedia, tahap terakhir bertanda menang")
    [new_stage] = api.call("crm.stage", "create", vals_list=[{"name": f"Negosiasi {tag}", "sequence": 15}])
    [crm_tag] = api.call("crm.tag", "create", vals_list=[{"name": f"Tag {tag}"}])
    [reason] = api.call("crm.lost.reason", "create", vals_list=[{"name": f"Harga {tag}"}])
    check(all((new_stage, crm_tag, reason)), "tahap, tag, dan alasan kalah baru tersimpan")

    [opp] = api.call("crm.lead", "create", vals_list=[{
        "name": f"Peluang regresi {tag}", "type": "opportunity", "partner_name": f"PT Regresi {tag}", "contact_name": "Dewi", "email_from": f"dewi{tag}@regresi.test",
        "expected_revenue": 40_000_000.0, "priority": "2", "date_deadline": "2999-12-31", "tag_ids": [[6, 0, [crm_tag]]],
    }])
    info = api.read("crm.lead", opp, ["stage_id", "won_status", "team_id", "user_id"])
    check(info["stage_id"][0] == stages[0]["id"] and info["won_status"] == "pending", "opportunity baru masuk tahap pertama dan berjalan")
    api.call("crm.lead", "write", ids=[opp], vals={"stage_id": new_stage})
    check(api.read("crm.lead", opp, ["stage_id"])["stage_id"][0] == new_stage, "opportunity dipindah ke tahap lain")
    board = api.search("crm.lead", [["type", "=", "opportunity"], ["active", "=", True]], ["stage_id", "expected_revenue", "probability", "won_status"], order="priority desc, id desc")
    check(any(b["stage_id"][0] == new_stage for b in board), "kueri papan pipeline menemukan opportunity per tahap")

    [partner] = api.call("res.partner", "create", vals_list=[{"name": f"PT Regresi {tag}", "is_company": True, "email": f"dewi{tag}@regresi.test", "customer_rank": 1}])
    api.call("crm.lead", "write", ids=[opp], vals={"partner_id": partner})
    [order] = api.call("sale.order", "create", vals_list=[{"partner_id": partner, "opportunity_id": opp}])
    check(api.read("crm.lead", opp, ["quotation_count", "order_ids"]) == {"id": opp, "quotation_count": 1, "order_ids": [order]}, "quotation terhubung ke opportunity")
    model = api.search("ir.model", [["model", "=", "crm.lead"]], ["id"], limit=1)[0]["id"]
    [activity] = api.call("mail.activity", "create", vals_list=[{"res_model_id": model, "res_id": opp, "activity_type_id": api.search("mail.activity.type", [["name", "=", "Call"]], ["id"], limit=1)[0]["id"], "summary": "Telepon klien", "date_deadline": "2999-01-01", "user_id": api.search("res.users", [["login", "!=", False]], ["id"], limit=1)[0]["id"]}])
    check(len(api.search("mail.activity", [["res_model", "=", "crm.lead"], ["res_id", "=", opp]], ["id"])) == 1, "aktivitas terjadwal muncul pada opportunity")
    api.call("mail.activity", "action_feedback", ids=[activity], feedback="Sudah dihubungi")
    check(not api.search("mail.activity", [["res_model", "=", "crm.lead"], ["res_id", "=", opp]], ["id"]), "aktivitas selesai hilang dari daftar terjadwal")
    api.call("crm.lead", "action_set_won", ids=[opp])
    won = api.read("crm.lead", opp, ["won_status", "probability"])
    check(won["won_status"] == "won" and won["probability"] == 100.0, "opportunity ditandai menang (probabilitas 100%)")
    check(opp in [r["id"] for r in api.search("crm.lead", [["type", "=", "opportunity"], ["won_status", "=", "won"]], ["id"])], "filter Menang menemukannya")

    [lost] = api.call("crm.lead", "create", vals_list=[{"name": f"Peluang kalah {tag}", "type": "opportunity", "expected_revenue": 1_000_000.0}])
    api.call("crm.lead", "action_set_lost", ids=[lost], lost_reason_id=reason)
    info = api.read("crm.lead", lost, ["active", "won_status", "lost_reason_id"])
    check(info["active"] is False and info["won_status"] == "lost" and info["lost_reason_id"][0] == reason, "opportunity kalah diarsipkan dengan alasan")
    check(lost in [r["id"] for r in api.search("crm.lead", [["type", "=", "opportunity"], ["active", "=", False], ["probability", "=", 0]], ["id"], context={"active_test": False})], "filter Kalah menemukannya")
    api.call("crm.lead", "toggle_active", ids=[lost])
    check(api.read("crm.lead", lost, ["active"])["active"] is True, "opportunity kalah bisa dipulihkan")

    [lead] = api.call("crm.lead", "create", vals_list=[{"name": f"Lead regresi {tag}", "type": "lead", "partner_name": f"CV Lead {tag}", "contact_name": "Anton", "email_from": f"anton{tag}@lead.test"}])
    check(api.read("crm.lead", lead, ["type"])["type"] == "lead", "lead baru bertipe lead")
    api.call("crm.lead", "convert_opportunity", ids=[lead], partner=False)
    check(api.read("crm.lead", lead, ["type"])["type"] == "opportunity", "lead dikonversi menjadi opportunity")
    check(api.call("crm.lead", "unlink", ids=[lead]) is True, "lead bisa dihapus")
    api.call("crm.stage", "write", ids=[new_stage], vals={"name": f"Negosiasi akhir {tag}"})
    api.call("crm.lead", "write", ids=[opp], vals={"stage_id": stages[0]["id"]})
    check(api.call("crm.stage", "unlink", ids=[new_stage]) is True, "tahap yang sudah kosong bisa dihapus")

    # Kueri laporan CRM (Forecast, Pipeline, Leads, Activities)
    [forecast_opp] = api.call("crm.lead", "create", vals_list=[{"name": f"Forecast {tag}", "type": "opportunity", "expected_revenue": 12_000_000.0, "date_deadline": "2998-03-10", "probability": 50.0}])
    open_domain = [["type", "=", "opportunity"], ["active", "=", True], ["won_status", "=", "pending"]]
    rows = api.call("crm.lead", "formatted_read_group", domain=open_domain + [["name", "=", f"Forecast {tag}"]], groupby=["date_deadline:month", "stage_id"], aggregates=["__count", "expected_revenue:sum", "prorated_revenue:sum"])
    march = [r for r in rows if r["date_deadline:month"] and r["date_deadline:month"][0].startswith("2998-03")]
    check(len(march) == 1 and march[0]["expected_revenue:sum"] == 12_000_000.0 and march[0]["prorated_revenue:sum"] == 6_000_000.0, "forecast: pendapatan dan nilai berbobot per bulan tenggat dan tahap")
    stage_rows = api.call("crm.lead", "formatted_read_group", domain=open_domain, groupby=["stage_id"], aggregates=["__count", "expected_revenue:sum", "prorated_revenue:sum", "probability:avg"])
    check(bool(stage_rows) and all("probability:avg" in r for r in stage_rows), "pipeline: ringkasan per tahap dengan rata-rata probabilitas")
    sales_rows = api.call("crm.lead", "formatted_read_group", domain=open_domain, groupby=["user_id"], aggregates=["__count", "expected_revenue:sum"])
    check(bool(sales_rows), "pipeline: ringkasan per sales")
    closed = api.call("crm.lead", "formatted_read_group", domain=[["type", "=", "opportunity"], ["won_status", "=", "lost"]], groupby=[], aggregates=["__count", "expected_revenue:sum"], context={"active_test": False})
    check(bool(closed) and closed[0]["__count"] >= 0, "pipeline: total kalah (termasuk yang diarsipkan)")
    origin = ["|", ["type", "=", "lead"], ["date_conversion", "!=", False]]
    by_source = api.call("crm.lead", "formatted_read_group", domain=origin, groupby=["source_id"], aggregates=["__count"], context={"active_test": False})
    converted = api.call("crm.lead", "formatted_read_group", domain=origin + [["date_conversion", "!=", False]], groupby=["user_id"], aggregates=["__count"], context={"active_test": False})
    check(sum(r["__count"] for r in by_source) >= 1 and sum(r["__count"] for r in converted) >= 1, "leads: lead masuk dan dikonversi (termasuk yang sudah menjadi opportunity)")
    monthly = api.call("crm.lead", "formatted_read_group", domain=origin, groupby=["create_date:month"], aggregates=["__count"], context={"active_test": False})
    check(bool(monthly), "leads: kueri per bulan dibuat")
    api.call("mail.activity", "create", vals_list=[{"res_model_id": model, "res_id": forecast_opp, "activity_type_id": 4, "summary": f"Tindak lanjut {tag}", "date_deadline": "2000-01-01", "user_id": api.search("res.users", [["login", "!=", False]], ["id"], limit=1)[0]["id"]}])
    overdue = api.search("mail.activity", [["res_model", "=", "crm.lead"], ["date_deadline", "<", datetime.date.today().isoformat()]], ["res_name", "state", "date_deadline"], order="date_deadline, id")
    check(any(a["res_name"] == f"Forecast {tag}" and a["state"] == "overdue" for a in overdue), "activities: aktivitas lewat tenggat dicari lewat tanggal (state tidak bisa dicari) dan berstatus overdue")
    api.call("crm.lead", "unlink", ids=[forecast_opp])


def check_pos(api, product):
    """POS Station, sesi, penjualan kasir dengan kembalian, pembayaran campuran, faktur, dan jurnal saat sesi ditutup (halaman POS dan Kasir)."""
    step("POS: stasiun, sesi, penjualan kasir, penutupan sesi dan jurnal")
    tag = datetime.datetime.now().strftime("%H%M%S")
    # Metode tunai hanya boleh dipakai satu stasiun (dan satu jurnal kas satu metode tunai), jadi setiap stasiun baru butuh jurnal kas sendiri.
    [cash_journal] = api.call("account.journal", "create", vals_list=[{"name": f"Kas Kasir {tag}", "type": "cash", "code": f"K{tag[-4:]}"}])
    bank_journal = api.search("account.journal", [["type", "=", "bank"]], ["id"], limit=1)[0]["id"]
    customer = api.search("res.partner", [["name", "=", "PT Pelanggan Nusantara"]], ["id"], limit=1)[0]["id"]
    user = api.search("res.users", [["login", "!=", False]], ["id"], limit=1)[0]["id"]

    cash = api.call("pos.payment.method", "create", vals_list=[{"name": f"Tunai Regresi {tag}", "journal_id": cash_journal}])[0]
    bank_found = api.search("pos.payment.method", [["journal_id", "=", bank_journal]], ["id"], limit=1)
    bank = bank_found[0]["id"] if bank_found else api.call("pos.payment.method", "create", vals_list=[{"name": f"Transfer Regresi {tag}", "journal_id": bank_journal}])[0]
    kinds = {m["id"]: m["type"] for m in api.search("pos.payment.method", [["id", "in", [cash, bank]]], ["type"])}
    check(kinds == {cash: "cash", bank: "bank"}, "metode pembayaran tunai dan bank terbentuk dari jurnalnya")
    [config] = api.call("pos.config", "create", vals_list=[{"name": f"Kasir Regresi {tag}", "payment_method_ids": [[6, 0, [cash, bank]]], "cash_control": True}])
    check(api.read("pos.config", config, ["current_session_id"])["current_session_id"] is False, "stasiun baru belum punya sesi")
    template = api.read("product.product", product["id"], ["product_tmpl_id"])["product_tmpl_id"][0]
    api.call("product.template", "write", ids=[template], vals={"available_in_pos": True})
    taxes = api.read("product.product", product["id"], ["taxes_id", "lst_price"])
    check(bool(api.search("product.product", [["available_in_pos", "=", True], ["sale_ok", "=", True], ["id", "=", product["id"]]], ["id"])), "produk yang ditandai Dijual di POS muncul di kasir")

    [session] = api.call("pos.session", "create", vals_list=[{"config_id": config, "user_id": user}])
    api.call("pos.session", "set_opening_control", ids=[session], cashbox_value=100_000.0, notes="Modal awal")
    check(api.read("pos.session", session, ["state"])["state"] == "opened", "sesi dibuka dengan kas awal")

    unit = taxes["lst_price"]

    def price(qty):
        if not taxes["taxes_id"]:
            return {"total_excluded": unit * qty, "total_included": unit * qty}
        return api.call("account.tax", "compute_all", ids=taxes["taxes_id"], price_unit=unit, quantity=qty)

    def make_order(sequence, qty, payments, partner=False, invoice=False):
        computed = price(qty)
        total = computed["total_included"]
        now = datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
        payload = {
            "name": f"Order R-{tag}-{sequence}", "uuid": f"regresi-{tag}-{sequence}", "session_id": session, "config_id": config, "user_id": user, "sequence_number": sequence, "date_order": now,
            "amount_tax": total - computed["total_excluded"], "amount_total": total, "amount_paid": total, "amount_return": 0.0, "partner_id": partner, "to_invoice": invoice,
            "pricelist_id": False, "fiscal_position_id": False,
            "lines": [[0, 0, {"uuid": f"line-{tag}-{sequence}", "product_id": product["id"], "qty": qty, "price_unit": unit, "discount": 0.0, "tax_ids": [[6, 0, taxes["taxes_id"]]],
                              "price_subtotal": computed["total_excluded"], "price_subtotal_incl": total, "full_product_name": "Produk kasir", "name": "Produk kasir"}]],
            "payment_ids": [[0, 0, {"payment_method_id": method, "amount": amount, "name": now, **extra}] for method, amount, extra in payments(total)],
        }
        return total, api.call("pos.order", "sync_from_ui", orders=[payload])["pos.order"][0]

    # Tunai dengan kembalian: uang diterima dan baris kembalian negatif (is_change), seperti yang dikirim kasir.
    def cash_with_change(total):
        tendered = (int(total / 10_000) + 1) * 10_000.0
        return [(cash, tendered, {}), (cash, -(tendered - total), {"is_change": True})]

    total, first = make_order(1, 2.0, cash_with_change)
    check(first["state"] == "paid" and first["amount_total"] == total, "penjualan tunai dengan kembalian: pesanan dibayar sebesar total")
    amounts = sorted(p["amount"] for p in api.search("pos.payment", [["pos_order_id", "=", first["id"]]], ["amount"]))
    check(len(amounts) == 2 and amounts[0] < 0 < amounts[1] and abs(sum(amounts) - total) < 0.01, "pembayaran tunai dan baris kembalian tersimpan")
    check(bool(api.read("pos.order", first["id"], ["picking_ids"])["picking_ids"]), "pesanan membuat pengiriman stok")
    try:
        make_order(2, 1.0, lambda _total: [(cash, 1_000.0, {})])
        check(False, "pembayaran kurang dari total seharusnya ditolak")
    except RuntimeError as error:
        check("not fully paid" in str(error), "pembayaran kurang dari total ditolak Odoo")

    # Pembayaran campuran tunai dan bank, dengan pelanggan dan faktur.
    total2, second = make_order(3, 1.0, lambda total: [(cash, 100_000.0, {}), (bank, total - 100_000.0, {})], customer, True)
    invoice = api.read("pos.order", second["id"], ["account_move", "state"])
    check(second["state"] == "done" and bool(invoice["account_move"]), "pesanan dengan pelanggan dan faktur: faktur terbentuk")
    check(api.read("account.move", invoice["account_move"][0], ["move_type", "state"]) == {"id": invoice["account_move"][0], "move_type": "out_invoice", "state": "posted"}, "faktur POS berstatus posted")

    data = api.call("pos.session", "get_closing_control_data", ids=[session])
    expected = data["default_cash_details"]["amount"]
    check(abs(expected - (100_000.0 + total + 100_000.0)) < 0.01, f"kas diharapkan = kas awal + tunai bersih ({expected:,.0f})")
    api.call("pos.session", "post_closing_cash_details", ids=[session], counted_cash=expected - 2_000.0)
    api.call("pos.session", "update_closing_control_state_session", ids=[session], notes="Penutupan regresi")
    closed = api.call("pos.session", "close_session_from_ui", ids=[session], bank_payment_method_diff_pairs=[])
    info = api.read("pos.session", session, ["state", "move_id", "cash_register_difference", "statement_line_ids", "bank_payment_ids", "order_count"])
    check(closed.get("successful") is True and info["state"] == "closed", "sesi ditutup")
    check(info["cash_register_difference"] == -2_000.0, "selisih hitung kas -2.000 tercatat")
    statement_moves = [r["move_id"][0] for r in api.search("account.bank.statement.line", [["id", "in", info["statement_line_ids"]]], ["move_id"])]
    payment_moves = [r["move_id"][0] for r in api.search("account.payment", [["id", "in", info["bank_payment_ids"]]], ["move_id"])]
    move_ids = {info["move_id"][0], *statement_moves, *payment_moves}
    check(len(move_ids) >= 3, "jurnal sesi: penjualan, pemindahan kas, selisih kas, dan pembayaran bank")
    balanced = True
    for move_id in move_ids:
        items = api.search("account.move.line", [["move_id", "=", move_id]], ["debit", "credit"])
        balanced = balanced and abs(sum(i["debit"] for i in items) - sum(i["credit"] for i in items)) < 0.005
    check(balanced, "semua jurnal sesi seimbang")
    session_items = api.search("account.move.line", [["move_id", "=", info["move_id"][0]]], ["account_id", "debit", "credit"])
    check(any(i["credit"] > 0 for i in session_items) and any(i["debit"] > 0 for i in session_items), "jurnal penjualan sesi memuat penjualan, pajak, dan piutang POS")
    check(len(api.search("pos.order", [["session_id", "=", session]], ["id"])) == info["order_count"], "daftar pesanan sesi sesuai jumlah pesanan")
    groups = api.call("pos.payment", "formatted_read_group", domain=[["session_id", "=", session]], groupby=["payment_method_id"], aggregates=["__count", "amount:sum"])
    check({g["payment_method_id"][0] for g in groups} == {cash, bank}, "ringkasan pembayaran per metode memuat tunai dan bank")

def check_bank_reconciliation(api):
    """Mutasi bank dicocokkan dengan pembayaran tertunda (urutan panggilan yang sama dengan UI), lalu biaya bank ke akun beban."""
    step("Rekonsiliasi bank: pembayaran tertunda ke akun bank, dan biaya bank ke akun beban")
    today = datetime.date.today().isoformat()
    bank = api.search("account.journal", [["type", "=", "bank"]], ["id", "default_account_id"], limit=1)[0]
    payments = api.search(
        "account.payment", [["payment_type", "=", "inbound"], ["is_matched", "=", False], ["state", "in", ["in_process", "paid"]]],
        ["name", "amount", "partner_id", "move_id", "outstanding_account_id"], order="id desc", limit=1,
    )
    check(bool(payments), "ada pembayaran masuk yang belum dicocokkan dengan mutasi bank")
    if not payments:
        return
    payment = payments[0]

    def balance(account_id):
        rows = api.call("account.move.line", "formatted_read_group", domain=[["account_id", "=", account_id], ["parent_state", "=", "posted"]], groupby=[], aggregates=["balance:sum"])
        return rows[0].get("balance:sum") or 0.0

    bank_account = bank["default_account_id"][0]
    outstanding_account = payment["outstanding_account_id"][0]
    bank_before, outstanding_before = balance(bank_account), balance(outstanding_account)
    [statement] = api.call("account.bank.statement", "create", vals_list=[{
        "name": f"Mutasi regresi {payment['name']}", "journal_id": bank["id"],
        "line_ids": [[0, 0, {"journal_id": bank["id"], "date": today, "payment_ref": f"TRF {payment['name']}", "amount": payment["amount"], "partner_id": payment["partner_id"][0]}]],
    }])
    line = api.search("account.bank.statement.line", [["statement_id", "=", statement]], ["id", "journal_id", "amount", "partner_id"])[0]
    api.call("account.bank.statement.line", "clean_reconcile", ids=[line["id"]])
    info = api.read("account.bank.statement.line", line["id"], ["reconcile_data_info"])["reconcile_data_info"]
    check(any(d["kind"] == "suspense" for d in info["data"]), "mutasi baru menyisakan jumlah yang belum dialokasikan")
    outstanding_line = api.search("account.move.line", [["move_id", "=", payment["move_id"][0]], ["account_id", "=", outstanding_account]], ["id"])[0]["id"]
    spec = {"reconcile_data_info": {}, "can_reconcile": {}, "add_account_move_line_id": {}}
    changed = api.call("account.bank.statement.line", "onchange", ids=[line["id"]], field_names=["add_account_move_line_id"], fields_spec=spec, values={
        "reconcile_data_info": info, "add_account_move_line_id": outstanding_line, "journal_id": line["journal_id"][0],
        "partner_id": line["partner_id"][0], "amount": line["amount"], "manual_reference": False,
    })
    info = changed["value"]["reconcile_data_info"]
    check(info["can_reconcile"] and not any(d["kind"] == "suspense" for d in info["data"]), "pembayaran tertunda melunasi mutasi tanpa sisa")
    api.call("account.bank.statement.line", "write", ids=[line["id"]], vals={"reconcile_data_info": info})
    api.call("account.bank.statement.line", "reconcile_bank_line", ids=[line["id"]])
    check(api.read("account.bank.statement.line", line["id"], ["is_reconciled"])["is_reconciled"], "mutasi berstatus sudah direkonsiliasi")
    check(api.read("account.payment", payment["id"], ["is_matched"])["is_matched"], "pembayaran berstatus sudah dicocokkan dengan mutasi bank")
    check(abs(balance(bank_account) - bank_before - payment["amount"]) < 0.005, "saldo akun bank naik sebesar pembayaran")
    check(abs(balance(outstanding_account) - outstanding_before + payment["amount"]) < 0.005, "saldo pembayaran tertunda turun sebesar pembayaran")
    api.call("account.bank.statement.line", "unreconcile_bank_line", ids=[line["id"]])
    check(not api.read("account.payment", payment["id"], ["is_matched"])["is_matched"], "pembatalan rekonsiliasi mengembalikan status pembayaran")

    # Biaya bank tanpa mitra: sisanya dicatat ke akun beban lewat isian manual.
    fee_account = api.search("account.account", [["code", "=", "65110020"]], ["id"])[0]["id"]
    expense_before, bank_before_fee = balance(fee_account), balance(bank_account)
    [fee_statement] = api.call("account.bank.statement", "create", vals_list=[{
        "name": "Biaya bank regresi", "journal_id": bank["id"],
        "line_ids": [[0, 0, {"journal_id": bank["id"], "date": today, "payment_ref": "Biaya admin bank", "amount": -15_000.0}]],
    }])
    fee = api.search("account.bank.statement.line", [["statement_id", "=", fee_statement]], ["id"])[0]["id"]
    api.call("account.bank.statement.line", "clean_reconcile", ids=[fee])
    info = api.read("account.bank.statement.line", fee, ["reconcile_data_info"])["reconcile_data_info"]
    suspense = [d for d in info["data"] if d["kind"] == "suspense"][0]
    changed = api.call("account.bank.statement.line", "onchange", ids=[fee], field_names=["manual_account_id"], fields_spec=spec, values={
        "reconcile_data_info": info, "manual_reference": suspense["reference"], "manual_account_id": fee_account, "manual_name": suspense["name"],
        "manual_amount": suspense["amount"], "manual_partner_id": False, "manual_currency_id": suspense["currency_id"],
        "manual_in_currency_id": suspense.get("line_currency_id"), "manual_in_currency": False, "manual_amount_in_currency": suspense.get("currency_amount"),
        "previous_manual_amount_in_currency": suspense.get("currency_amount"), "manual_kind": "suspense", "manual_original_amount": 0.0,
        "manual_exchange_counterpart": False, "manual_delete": False, "journal_id": bank["id"], "partner_id": False, "amount": -15_000.0, "analytic_distribution": {},
    })
    info = changed["value"]["reconcile_data_info"]
    check(info["can_reconcile"], "biaya bank bisa direkonsiliasi setelah akun beban dipilih")
    api.call("account.bank.statement.line", "write", ids=[fee], vals={"reconcile_data_info": info})
    api.call("account.bank.statement.line", "reconcile_bank_line", ids=[fee])
    check(abs(balance(fee_account) - expense_before - 15_000.0) < 0.005, "biaya bank tercatat di akun beban")
    check(abs(balance(bank_account) - bank_before_fee + 15_000.0) < 0.005, "saldo akun bank berkurang sebesar biaya")


def mis_values(api, name, date_from, date_to):
    """Hitung laporan MIS lewat instance sementara (seperti UI) dan kembalikan {label: nilai kolom pertama}."""
    report = api.search("mis.report", [["name", "=", name]], ["id"])[0]["id"]
    [instance] = api.call("mis.report.instance", "create", vals_list=[{
        "name": f"{name} (regresi)", "report_id": report, "temporary": True, "target_move": "posted",
        "period_ids": [[0, 0, {"name": "Periode", "mode": "fix", "manual_date_from": date_from, "manual_date_to": date_to}]],
    }])
    try:
        result = api.call("mis.report.instance", "compute", ids=[instance])
    finally:
        api.call("mis.report.instance", "unlink", ids=[instance])
    return {row["label"]: row["cells"][0].get("val") for row in result["body"]}, result


def check_financial_reports(api):
    """Laporan keuangan MIS: pemeriksaan bawaan templatnya harus 0 dan angkanya cocok dengan buku besar."""
    step("Laporan keuangan: Laba Rugi, Neraca, Arus Kas, Neraca Saldo")
    today = datetime.date.today()
    start, end = today.replace(month=1, day=1).isoformat(), today.isoformat()
    pnl, _ = mis_values(api, "Laba Rugi", start, end)
    check(not pnl["Akun laba rugi belum terpetakan (harus 0)"], "laba rugi: semua akun laba rugi terpetakan")
    check(pnl["LABA KOTOR"] == pnl["Pendapatan Bersih"] - pnl["Total Harga Pokok"], "laba rugi: laba kotor = pendapatan - harga pokok")
    balance, _ = mis_values(api, "Neraca", start, end)
    check(not balance["Selisih aset dan liabilitas + ekuitas (harus 0)"], "neraca: aset sama dengan liabilitas + ekuitas")
    check(balance["Laba (Rugi) Tahun Berjalan"] == pnl["LABA BERSIH"], "neraca: laba berjalan sama dengan laba bersih laporan laba rugi")
    cash, _ = mis_values(api, "Arus Kas", start, end)
    check(not cash["Selisih saldo kas (harus 0)"], "arus kas: kenaikan kas cocok dengan saldo kas dan bank")
    check(cash["Laba (Rugi) Bersih"] == pnl["LABA BERSIH"], "arus kas: berangkat dari laba bersih yang sama")
    _, trial = mis_values(api, "Neraca Saldo", start, end)
    total = trial["body"][0]["cells"]
    check(total[1]["val"] == total[2]["val"] and total[1]["val"] > 0, "neraca saldo: total debit sama dengan total kredit")
    ledger = api.call("account.move.line", "formatted_read_group", domain=[["parent_state", "=", "posted"], ["date", ">=", start], ["date", "<=", end]], groupby=[], aggregates=["debit:sum", "credit:sum"])[0]
    check(abs(ledger["debit:sum"] - total[1]["val"]) < 0.005, "neraca saldo: total debit sama dengan buku besar")


def bill_total(api, bill_id):
    return api.read("account.move", bill_id, ["amount_total"])["amount_total"]


if __name__ == "__main__":
    main()
