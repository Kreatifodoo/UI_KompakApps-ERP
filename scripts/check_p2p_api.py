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
import base64
import datetime
import io
import json
import os
import sys
import urllib.error
import urllib.request
import zipfile
from xml.sax.saxutils import escape


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
    check_multi_warehouse(api)
    check_stock_picker(api)
    check_lots(api, vendor)
    check_removal_strategy(api, vendor)
    check_manufacturing(api)
    check_crm(api)
    check_pos(api, product)
    check_sales_pricelist(api, product)
    check_account_reports(api)
    check_dashboards(api)
    check_accounting_masters(api)
    check_analysis_reports(api)
    check_settings_and_users(api)
    check_data_import(api)
    check_data_import_xlsx(api)
    check_print_documents(api)
    check_auditlog(api)
    check_budget(api)
    check_analytic_lines(api, product, vendor)
    check_line_taxes(api, product, vendor)
    check_loyalty(api, product)
    check_analysis_drill(api)

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


def check_multi_warehouse(api):
    """Gudang kedua (penerimaan 2 langkah, pengiriman 2 langkah, disuplai gudang utama), PO ke gudang itu, suplai antar gudang lewat transit,
    stok per gudang, SO dan MO dari gudang itu (halaman Warehouse Master, Reorder Level, Replenishment, Transfer, Stok per Gudang, PO, SO, MO; D42)."""
    import random

    step("Multi-gudang: gudang kedua, PO ke gudang itu, suplai antar gudang, stok per gudang, SO dan MO dari gudang itu")
    tag = f"{random.randint(0, 99999):05d}"
    code = f"M{tag[:4]}"  # kode gudang unik per jalan agar gudang uji yang diarsipkan tidak bentrok
    api.call("res.config.settings", "execute", ids=api.call("res.config.settings", "create", vals_list=[{"group_stock_multi_locations": True, "group_stock_adv_location": True}]))
    uid = api.call("res.users", "context_get")["uid"]
    has = lambda group: bool(api.call("res.users", "has_group", ids=[uid], group_ext_id=group))  # noqa: E731
    check(has("stock.group_adv_location"), "fitur Multi-Step Routes aktif lewat pengaturan (sakelar di Warehouse Master)")
    wh1 = api.search("stock.warehouse", [], ["id", "lot_stock_id", "in_type_id", "out_type_id", "int_type_id"], order="id", limit=1)[0]
    goods = api.search("product.category", [["name", "=", "Goods"]], ["id"], limit=1)
    base = {"type": "consu", "is_storable": True, "categ_id": goods[0]["id"] if goods else False}

    def new_product(name, cost=5_000.0, price=10_000.0):
        [tmpl] = api.call("product.template", "create", vals_list=[{**base, "name": f"{name} {tag}", "standard_price": cost, "list_price": price}])
        info = api.read("product.template", tmpl, ["product_variant_id", "uom_id"])
        return {"tmpl": tmpl, "id": info["product_variant_id"][0], "uom": info["uom_id"][0]}

    item = new_product("Barang Multi Gudang")
    mode = {"inventory_mode": True}

    def set_stock(product, location, quantity):
        found = api.search("stock.quant", [["product_id", "=", product], ["location_id", "=", location]], ["id"])
        if found:
            quant = found[0]["id"]
            api.call("stock.quant", "write", ids=[quant], vals={"inventory_quantity": quantity}, context=mode)
        else:
            [quant] = api.call("stock.quant", "create", vals_list=[{"product_id": product, "location_id": location, "inventory_quantity": quantity}], context=mode)
        api.call("stock.quant", "action_apply_inventory", ids=[quant], context=mode)

    def amounts(product, warehouse=None):
        row = api.call("product.product", "read", ids=[product], fields=["qty_available", "incoming_qty", "outgoing_qty", "virtual_available"], context={"warehouse_id": warehouse} if warehouse else {})[0]
        return row["qty_available"], row["incoming_qty"], row["outgoing_qty"], row["virtual_available"]

    def finish(picking, label):
        """Cek ketersediaan, isi jumlah sesuai permintaan, lalu validasi."""
        api.call("stock.picking", "action_assign", ids=[picking])
        for move in api.search("stock.move", [["picking_id", "=", picking]], ["id", "product_uom_qty"]):
            api.call("stock.move", "write", ids=[move["id"]], vals={"quantity": move["product_uom_qty"], "picked": True})
        check(api.call("stock.picking", "button_validate", ids=[picking]) is True, f"{label} divalidasi tanpa dialog")

    def open_pickings():
        return api.search("stock.picking", [["state", "not in", ["done", "cancel"]]], ["id", "name", "picking_type_id", "picking_type_code", "location_id", "location_dest_id", "state", "origin"], order="id")

    # 1. gudang kedua dengan langkah dan "disuplai dari"
    active_before = api.call("stock.warehouse", "search_count", domain=[])
    [wh2_id] = api.call("stock.warehouse", "create", vals_list=[{
        "name": f"Gudang Uji {tag}", "code": code, "reception_steps": "two_steps", "delivery_steps": "pick_ship", "resupply_wh_ids": [[6, 0, [wh1["id"]]]],
    }])
    wh2 = api.read("stock.warehouse", wh2_id, ["lot_stock_id", "view_location_id", "wh_input_stock_loc_id", "wh_output_stock_loc_id", "in_type_id", "out_type_id", "store_type_id", "pick_type_id", "manu_type_id",
                                                  "reception_route_id", "delivery_route_id", "resupply_route_ids", "resupply_wh_ids"])
    check(api.call("stock.warehouse", "search_count", domain=[]) == active_before + 1, "gudang kedua tercipta")
    check(has("stock.group_stock_multi_warehouses"), "mode multi-gudang aktif otomatis setelah gudang kedua")
    try:
        api.call("stock.warehouse", "create", vals_list=[{"name": f"Kembar {tag}", "code": code}])
        check(False, "kode gudang kembar seharusnya ditolak")
    except RuntimeError:
        check(True, "kode gudang harus unik (kode kembar ditolak Odoo)")
    types = {t["id"]: t for t in api.search("stock.picking.type", [["warehouse_id", "=", wh2_id]], ["name", "code", "active", "default_location_src_id", "default_location_dest_id"], context={"active_test": False})}
    check(bool(wh2["reception_route_id"]) and bool(wh2["delivery_route_id"]), "rute penerimaan 2 langkah dan pengiriman 2 langkah terbentuk")
    check(types[wh2["store_type_id"][0]]["active"] and types[wh2["pick_type_id"][0]]["active"], "tipe operasi Storage dan Pick aktif (picking tambahan)")
    check(types[wh2["in_type_id"][0]]["default_location_dest_id"][0] == wh2["wh_input_stock_loc_id"][0], "penerimaan masuk ke lokasi Input, bukan langsung ke Stock")
    [route] = api.search("stock.route", [["id", "in", wh2["resupply_route_ids"]]], ["supplied_wh_id", "supplier_wh_id", "product_selectable"])
    check(route["supplied_wh_id"][0] == wh2_id and route["supplier_wh_id"][0] == wh1["id"] and route["product_selectable"], "rute suplai antar gudang terbentuk (gudang utama -> gudang kedua) dan bisa dipilih di aturan reorder")
    transit = api.search("stock.rule", [["route_id", "=", route["id"]]], ["location_src_id", "location_dest_id", "picking_type_id"], order="id")
    check(len(transit) == 2 and transit[0]["location_dest_id"] == transit[1]["location_src_id"], "rute suplai lewat satu lokasi transit (keluar, lalu terima)")

    # 2. stok awal di gudang utama, PO ke gudang kedua
    set_stock(item["id"], wh1["lot_stock_id"][0], 20.0)
    check(amounts(item["id"], wh1["id"])[0] == 20.0 and amounts(item["id"], wh2_id)[0] == 0.0, "stok awal 20 hanya di gudang utama")
    vendor = api.search("res.partner", [["name", "=", "PT Pemasok Nusantara"]], ["id"], limit=1)[0]["id"]
    [po] = api.call("purchase.order", "create", vals_list=[{
        "partner_id": vendor, "picking_type_id": wh2["in_type_id"][0],
        "order_line": [[0, 0, {"product_id": item["id"], "name": "Uji gudang", "product_qty": 6.0, "product_uom_id": item["uom"], "price_unit": 5_000.0}]],
    }])
    check(api.read("purchase.order", po, ["picking_type_id"])["picking_type_id"][0] == wh2["in_type_id"][0], "PO memilih tipe penerimaan gudang kedua")
    api.call("purchase.order", "button_confirm", ids=[po])
    [receipt] = api.search("stock.picking", [["purchase_id", "=", po]], ["id", "picking_type_id", "location_dest_id"])
    check(receipt["picking_type_id"][0] == wh2["in_type_id"][0] and receipt["location_dest_id"][0] == wh2["wh_input_stock_loc_id"][0], "penerimaan PO berada di gudang kedua (lokasi Input)")
    finish(receipt["id"], "penerimaan PO gudang kedua")
    [storage] = [p for p in open_pickings() if p["picking_type_id"][0] == wh2["store_type_id"][0] and p["origin"] == api.read("purchase.order", po, ["name"])["name"]]
    check(storage["picking_type_code"] == "internal", "langkah kedua (Storage) terbentuk sebagai transfer internal")
    check(amounts(item["id"], wh2_id)[0] == 6.0 and amounts(item["id"], wh1["id"])[0] == 20.0, "stok per gudang: 6 di gudang kedua (masih di Input), gudang utama tetap 20")
    finish(storage["id"], "Storage ke lokasi Stock")
    quants = api.search("stock.quant", [["product_id", "=", item["id"]], ["location_id.usage", "=", "internal"]], ["location_id", "quantity", "warehouse_id"])
    by_wh = {}
    for q in quants:
        by_wh[q["warehouse_id"][0] if q["warehouse_id"] else 0] = by_wh.get(q["warehouse_id"][0] if q["warehouse_id"] else 0, 0.0) + q["quantity"]
    check(by_wh == {wh1["id"]: 20.0, wh2_id: 6.0}, f"kelompok quant per gudang: {by_wh}")
    check(any(q["location_id"][0] == wh2["lot_stock_id"][0] and q["quantity"] == 6.0 for q in quants), "6 unit tersimpan di Stock gudang kedua")

    # 3. PR dengan tipe penerimaan gudang kedua terbawa ke RFQ
    [pr] = api.call("purchase.request", "create", vals_list=[{
        "description": "Uji gudang kedua", "picking_type_id": wh2["in_type_id"][0],
        "line_ids": [[0, 0, {"product_id": item["id"], "product_uom_id": item["uom"], "product_qty": 1.0, "name": "Uji gudang"}]],
    }])
    api.call("purchase.request", "button_to_approve", ids=[pr])
    api.call("purchase.request", "button_approved", ids=[pr])
    pr_lines = [r["id"] for r in api.search("purchase.request.line", [["request_id", "=", pr]], ["id"])]
    pr_ctx = {"active_model": "purchase.request.line", "active_ids": pr_lines, "active_id": pr_lines[0]}
    wizard = api.call("purchase.request.line.make.purchase.order", "create", vals_list=[{"supplier_id": vendor}], context=pr_ctx)
    api.call("purchase.request.line.make.purchase.order", "make_purchase_order", ids=wizard, context=pr_ctx)
    rfq = api.search("purchase.order", [["order_line.purchase_request_lines.request_id", "=", pr]], ["id", "picking_type_id", "state"])[0]
    check(rfq["picking_type_id"][0] == wh2["in_type_id"][0], "tipe penerimaan PR (gudang kedua) terbawa ke RFQ")
    api.call("purchase.order", "button_cancel", ids=[rfq["id"]])

    # 4. suplai gudang utama -> gudang kedua lewat aturan reorder dan transit
    before_all = amounts(item["id"])[0]
    [rule] = api.call("stock.warehouse.orderpoint", "create", vals_list=[{
        "product_id": item["id"], "warehouse_id": wh2_id, "location_id": wh2["lot_stock_id"][0], "product_min_qty": 10.0, "product_max_qty": 10.0, "trigger": "manual", "route_id": route["id"],
    }])
    check(api.read("stock.warehouse.orderpoint", rule, ["qty_to_order"])["qty_to_order"] == 4.0, "aturan reorder gudang kedua (min 10, ada 6) meminta 4 unit")
    last_picking = api.search("stock.picking", [], ["id"], order="id desc", limit=1)[0]["id"]
    notice = api.call("stock.warehouse.orderpoint", "action_replenish", ids=[rule])
    rule_name = api.read("stock.warehouse.orderpoint", rule, ["name"])["name"]
    made = api.search("stock.picking", [["id", ">", last_picking], ["origin", "=", rule_name]], ["id", "name", "picking_type_id", "picking_type_code", "location_id", "location_dest_id"], order="id")
    check(len(made) == 2, f"suplai antar gudang membuat 2 dokumen (keluar, lalu terima): {[p['name'] for p in made]}")
    out, incoming = made[0], made[1]
    check(out["picking_type_code"] == "outgoing" and out["location_id"][0] == wh1["lot_stock_id"][0], "langkah 1: keluar dari Stock gudang utama")
    check(incoming["picking_type_code"] == "incoming" and incoming["location_id"] == out["location_dest_id"], "langkah 2: diterima dari lokasi transit yang sama di gudang kedua")
    check(incoming["name"] in [link["label"] for link in notice["params"]["links"]], "pemberitahuan pengisian ulang menyebut dokumen penerimaan di gudang kedua")
    interwh = api.search("stock.picking", [["picking_type_code", "in", ["incoming", "outgoing", "internal"]], "|", ["location_id.usage", "=", "transit"], ["location_dest_id.usage", "=", "transit"], ["id", ">", last_picking]], ["id"])
    check({p["id"] for p in interwh} == {out["id"], incoming["id"]}, "filter Antar Gudang (lokasi transit) menemukan kedua dokumen")
    mv_in = api.search("stock.move", [["picking_id", "=", incoming["id"]]], ["move_orig_ids"])[0]
    check(bool(mv_in["move_orig_ids"]), "penerimaan terkait ke pengiriman asal (rangkaian operasi)")
    finish(out["id"], "pengiriman keluar gudang utama")
    check(amounts(item["id"], wh1["id"])[0] == 16.0 and amounts(item["id"])[0] == before_all - 4.0, "setelah keluar: gudang utama 16, 4 unit sedang di transit (tidak masuk gudang mana pun)")
    transit_qty = sum(q["quantity"] for q in api.search("stock.quant", [["product_id", "=", item["id"]], ["location_id.usage", "=", "transit"]], ["quantity"]))
    check(transit_qty == 4.0, "4 unit tercatat di lokasi transit")
    finish(incoming["id"], "penerimaan di gudang kedua")
    [store2] = [p for p in open_pickings() if p["picking_type_id"][0] == wh2["store_type_id"][0]]
    finish(store2["id"], "Storage suplai antar gudang")
    check((amounts(item["id"], wh1["id"])[0], amounts(item["id"], wh2_id)[0], amounts(item["id"])[0]) == (16.0, 10.0, before_all), "suplai selesai: gudang utama 16, gudang kedua 10, total tidak berubah")
    api.call("stock.warehouse.orderpoint", "unlink", ids=[rule])

    # 5. transfer langsung antar gudang (satu dokumen, tanpa transit)
    [direct] = api.call("stock.picking", "create", vals_list=[{
        "picking_type_id": wh1["int_type_id"][0], "location_id": wh1["lot_stock_id"][0], "location_dest_id": wh2["lot_stock_id"][0],
        "move_ids": [[0, 0, {"product_id": item["id"], "product_uom_qty": 1.0, "location_id": wh1["lot_stock_id"][0], "location_dest_id": wh2["lot_stock_id"][0]}]],
    }])
    api.call("stock.picking", "action_confirm", ids=[direct])
    finish(direct, "transfer langsung antar gudang")
    check((amounts(item["id"], wh1["id"])[0], amounts(item["id"], wh2_id)[0]) == (15.0, 11.0), "transfer langsung memindahkan 1 unit: gudang utama 15, gudang kedua 11")

    # 6. SO dari gudang kedua mengurangi stok gudang itu saja
    customer = api.search("res.partner", [["name", "=", "PT Pelanggan Nusantara"]], ["id"], limit=1)[0]["id"]
    [so] = api.call("sale.order", "create", vals_list=[{"partner_id": customer, "warehouse_id": wh2_id, "order_line": [[0, 0, {"product_id": item["id"], "product_uom_qty": 3.0}]]}])
    check(api.read("sale.order", so, ["warehouse_id"])["warehouse_id"][0] == wh2_id, "SO memilih gudang pengiriman kedua")
    api.call("sale.order", "action_confirm", ids=[so])
    [pick] = api.search("stock.picking", [["sale_id", "=", so]], ["id", "picking_type_id", "picking_type_code", "location_id"])
    check(pick["picking_type_code"] == "internal" and pick["picking_type_id"][0] == wh2["pick_type_id"][0] and pick["location_id"][0] == wh2["lot_stock_id"][0], "pengiriman 2 langkah: Pick dari Stock gudang kedua lebih dulu")
    finish(pick["id"], "Pick gudang kedua")
    [delivery] = api.search("stock.picking", [["sale_id", "=", so], ["picking_type_code", "=", "outgoing"]], ["id", "picking_type_id"])
    check(delivery["picking_type_id"][0] == wh2["out_type_id"][0], "setelah Pick selesai, Delivery gudang kedua terbentuk")
    finish(delivery["id"], "Delivery gudang kedua")
    check((amounts(item["id"], wh1["id"])[0], amounts(item["id"], wh2_id)[0], amounts(item["id"])[0]) == (15.0, 8.0, 23.0), "SO dari gudang kedua: gudang kedua 11 -> 8, gudang utama tetap 15, total 23")
    both = amounts(item["id"], wh1["id"])[0] + amounts(item["id"], wh2_id)[0]
    check(both == amounts(item["id"])[0], "jumlah per gudang sama dengan stok keseluruhan")

    # 7. MO dari gudang kedua memakai lokasi gudang itu
    comp = new_product("Komponen Multi Gudang")
    set_stock(comp["id"], wh2["lot_stock_id"][0], 10.0)
    [bom] = api.call("mrp.bom", "create", vals_list=[{
        "product_tmpl_id": item["tmpl"], "product_qty": 1.0, "product_uom_id": item["uom"], "code": f"BOM-MW-{tag}",
        "bom_line_ids": [[0, 0, {"product_id": comp["id"], "product_qty": 2.0, "product_uom_id": comp["uom"]}]],
    }])
    [mo] = api.call("mrp.production", "create", vals_list=[{"product_id": item["id"], "bom_id": bom, "product_qty": 2.0, "picking_type_id": wh2["manu_type_id"][0]}])
    info = api.read("mrp.production", mo, ["picking_type_id", "location_src_id", "location_dest_id"])
    check(info["picking_type_id"][0] == wh2["manu_type_id"][0] and info["location_src_id"][0] == wh2["lot_stock_id"][0] and info["location_dest_id"][0] == wh2["lot_stock_id"][0], "MO memakai tipe produksi dan lokasi gudang kedua")
    api.call("mrp.production", "action_confirm", ids=[mo])
    raw = api.search("stock.move", [["raw_material_production_id", "=", mo]], ["location_id", "state"])[0]
    check(raw["location_id"][0] == wh2["lot_stock_id"][0] and raw["state"] == "assigned", "komponen MO dicadangkan dari Stock gudang kedua")
    api.call("mrp.production", "action_cancel", ids=[mo])

    # 8. arsip aman: kosongkan stok gudang kedua, lalu arsipkan (gudang uji tidak menumpuk sebagai aktif)
    for q in api.search("stock.quant", [["location_id.warehouse_id", "=", wh2_id], ["location_id.usage", "=", "internal"], ["quantity", "!=", 0]], ["id", "product_id", "location_id"]):
        set_stock(q["product_id"][0], q["location_id"][0], 0.0)
    left = api.search("stock.quant", [["location_id.warehouse_id", "=", wh2_id], ["location_id.usage", "=", "internal"], ["quantity", "!=", 0]], ["id"])
    check(not left, "stok gudang kedua dikosongkan sebelum diarsipkan")
    stray = [p["name"] for p in open_pickings() if p["picking_type_id"][0] in types]
    check(not stray, f"tidak ada operasi berjalan di gudang kedua: {stray}")
    api.call("stock.warehouse", "write", ids=[wh2_id], vals={"active": False})
    check(api.call("stock.warehouse", "search_count", domain=[]) == active_before, "gudang uji diarsipkan: jumlah gudang aktif kembali")
    check(not api.search("stock.warehouse", [["id", "=", wh2_id]], ["id"]) and bool(api.search("stock.warehouse", [["id", "=", wh2_id]], ["id"], context={"active_test": False})), "gudang uji hanya tampak pada filter diarsipkan")


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


def check_removal_strategy(api, vendor):
    """Strategi pengeluaran stok (D43): kategori dan lokasi memilih FIFO/LIFO/FEFO; reservasi pengiriman mengikuti strategi."""
    step("Strategi pengeluaran: FIFO, LIFO, FEFO pada kategori dan lokasi")
    tag = datetime.datetime.now().strftime("%H%M%S")
    api.call("res.config.settings", "execute", ids=api.call("res.config.settings", "create", vals_list=[{"group_stock_production_lot": True}]))
    customer = api.search("res.partner", [["name", "=", "PT Pelanggan Nusantara"]], ["id"], limit=1)[0]["id"]
    stock_location = api.search("stock.warehouse", [], ["lot_stock_id"], limit=1)[0]["lot_stock_id"][0]
    methods = {r["method"]: r["id"] for r in api.search("product.removal", [], ["method"])}
    check({"fifo", "lifo", "fefo", "closest", "least_packages"} <= set(methods), "product.removal menyediakan fifo, lifo, fefo, closest, least_packages")
    fields = api.call("product.category", "fields_get", attributes=["relation"])
    check(fields["removal_strategy_id"]["relation"] == "product.removal", "kategori punya removal_strategy_id ke product.removal")
    check("removal_strategy_id" in api.call("stock.location", "fields_get", attributes=["type"]), "lokasi punya removal_strategy_id")

    [category] = api.call("product.category", "create", vals_list=[{"name": f"Kategori Pengeluaran {tag}", "removal_strategy_id": methods["fifo"]}])
    [tmpl] = api.call("product.template", "create", vals_list=[{
        "name": f"Susu Pengeluaran {tag}", "type": "consu", "is_storable": True, "tracking": "lot", "categ_id": category, "standard_price": 50_000.0, "list_price": 80_000.0,
        "use_expiration_date": True, "expiration_time": 365, "use_time": 300, "removal_time": 60, "alert_time": 30,
    }])
    api.call("product.supplierinfo", "create", vals_list=[{"partner_id": vendor["id"], "product_tmpl_id": tmpl, "min_qty": 1.0, "price": 50_000.0}])
    product = api.read("product.template", tmpl, ["product_variant_id", "uom_id"])
    pv, uom = product["product_variant_id"][0], product["uom_id"][0]
    today = datetime.datetime.now()

    def stamp(days):
        return (today + datetime.timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")

    def receive(lot, days, qty=5.0):
        [po] = api.call("purchase.order", "create", vals_list=[{"partner_id": vendor["id"], "order_line": [[0, 0, {"product_id": pv, "product_qty": qty, "product_uom_id": uom}]]}])
        api.call("purchase.order", "button_confirm", ids=[po])
        picking = api.search("stock.picking", [["purchase_id", "=", po]], ["id"])[0]["id"]
        line = api.search("stock.move.line", [["picking_id", "=", picking]], ["id"])[0]["id"]
        api.call("stock.move.line", "write", ids=[line], vals={"lot_name": lot, "quantity": qty, "picked": True, "expiration_date": stamp(days)})
        result = api.call("stock.picking", "button_validate", ids=[picking])
        if result is not True:  # lot yang melewati masa peringatan meminta konfirmasi (wizard kedaluwarsa)
            [wizard] = api.call(result["res_model"], "create", vals_list=[{}], context=result["context"])
            api.call(result["res_model"], "process", ids=[wizard], context=result["context"])
        return api.search("stock.lot", [["name", "=", lot], ["product_id", "=", pv]], ["id"])[0]["id"]

    def reserve():
        """Satu SO 2 unit; kembalikan nama lot yang dipesan pada pengiriman, lalu batalkan pesanan agar stok bebas."""
        [so] = api.call("sale.order", "create", vals_list=[{"partner_id": customer, "order_line": [[0, 0, {"product_id": pv, "product_uom_qty": 2.0}]]}])
        api.call("sale.order", "action_confirm", ids=[so])
        delivery = api.search("stock.picking", [["sale_id", "=", so]], ["id", "state"])[0]
        lots = sorted({r["lot_id"][1] for r in api.search("stock.move.line", [["picking_id", "=", delivery["id"]]], ["lot_id"]) if r["lot_id"]})
        api.call("stock.picking", "do_unreserve", ids=[delivery["id"]])
        api.call("stock.picking", "action_cancel", ids=[delivery["id"]])
        return lots, delivery["state"]

    lot_a = receive(f"A-{tag}", 300)
    receive(f"B-{tag}", 100)
    lots, state = reserve()
    check(state == "assigned" and lots == [f"A-{tag}"], f"kategori FIFO: pengiriman memesan lot A (masuk lebih dulu): {lots}")
    api.call("product.category", "write", ids=[category], vals={"removal_strategy_id": methods["lifo"]})
    lots, _ = reserve()
    check(lots == [f"B-{tag}"], f"kategori LIFO: pengiriman memesan lot B (masuk terakhir): {lots}")
    api.call("product.category", "write", ids=[category], vals={"removal_strategy_id": methods["fefo"]})
    lots, _ = reserve()
    check(lots == [f"B-{tag}"], f"kategori FEFO: pengiriman baru memesan lot B (kedaluwarsa paling dekat): {lots}")
    api.call("product.category", "write", ids=[category], vals={"removal_strategy_id": methods["fifo"]})
    lots, _ = reserve()
    check(lots == [f"A-{tag}"], f"kembali ke FIFO: memesan lot A lagi: {lots}")

    # Strategi di lokasi: kategori kosong -> lokasi menentukan; kategori terisi mengalahkan lokasi.
    original = api.read("stock.location", stock_location, ["removal_strategy_id"])["removal_strategy_id"]
    api.call("product.category", "write", ids=[category], vals={"removal_strategy_id": False})
    api.call("stock.location", "write", ids=[stock_location], vals={"removal_strategy_id": methods["fefo"]})
    lots, _ = reserve()
    check(lots == [f"B-{tag}"], f"kategori kosong, lokasi FEFO: memesan lot B: {lots}")
    api.call("product.category", "write", ids=[category], vals={"removal_strategy_id": methods["fifo"]})
    lots, _ = reserve()
    check(lots == [f"A-{tag}"], f"kategori FIFO mengalahkan lokasi FEFO: memesan lot A: {lots}")

    # Lot yang lewat tanggal penarikan: laporkan perilaku FEFO yang sebenarnya.
    api.call("product.category", "write", ids=[category], vals={"removal_strategy_id": methods["fefo"]})
    receive(f"C-{tag}", 90)  # kedaluwarsa 90 hari, tanggal penarikan 30 hari lagi
    lots, _ = reserve()
    check(lots == [f"C-{tag}"], f"FEFO: lot C (kedaluwarsa 90 hari) paling dekat dan dipesan: {lots}")
    lot_c = api.search("stock.lot", [["name", "=", f"C-{tag}"], ["product_id", "=", pv]], ["id"])[0]["id"]
    api.call("stock.lot", "write", ids=[lot_c], vals={"expiration_date": stamp(-5)})
    lots, _ = reserve()
    check(lots == [f"C-{tag}"], f"temuan: lot yang tanggal kedaluwarsanya lewat tetapi tanggal penarikannya belum lewat masih dipesan FEFO: {lots}")
    api.call("stock.lot", "write", ids=[lot_c], vals={"removal_date": stamp(-1)})
    lots, _ = reserve()
    check(lots == [f"B-{tag}"], f"lot lewat tanggal penarikan tidak dipesan (FEFO memilih lot B): {lots}")
    api.call("product.category", "write", ids=[category], vals={"removal_strategy_id": methods["fifo"]})
    lots, _ = reserve()
    check(f"C-{tag}" not in lots, f"lot lewat tanggal penarikan juga dilewati pada FIFO: {lots}")
    free = api.call("product.product", "read", ids=[pv], fields=["free_qty"], context={"location": stock_location})[0]["free_qty"]
    check(free == 10.0, f"stok bebas tidak menghitung lot lewat tanggal penarikan (10 dari 15): {free}")
    api.call("stock.location", "write", ids=[stock_location], vals={"removal_strategy_id": original[0] if original else False})
    check(lot_a > 0, "uji strategi pengeluaran selesai, strategi lokasi dikembalikan")


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
    # Data laporan lead dibuat di sini agar pemeriksaan tidak bergantung pada sisa data dari jalan sebelumnya (database baru kosong).
    api.call("crm.lead", "create", vals_list=[{"name": f"Lead laporan {tag}", "type": "lead", "partner_name": f"CV Laporan {tag}"}])
    [report_lead] = api.call("crm.lead", "create", vals_list=[{"name": f"Lead konversi {tag}", "type": "lead", "partner_name": f"CV Konversi {tag}"}])
    api.call("crm.lead", "convert_opportunity", ids=[report_lead], partner=False)
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

def check_sales_pricelist(api, product):
    """Daftar harga penjualan: aturan produk dan kategori dengan jumlah minimum, dipakai harga baris Sales Order (halaman Pricelist Master penjualan)."""
    step("Daftar harga penjualan: aturan kategori dan produk, harga pada Sales Order")
    tag = datetime.datetime.now().strftime("%H%M%S")
    api.call("res.config.settings", "execute", ids=api.call("res.config.settings", "create", vals_list=[{"group_product_pricelist": True}]))
    info = api.read("product.product", product["id"], ["product_tmpl_id", "categ_id", "lst_price"])
    categ = info["categ_id"][0]
    list_price = info["lst_price"]
    customer = api.search("res.partner", [["name", "=", "PT Pelanggan Nusantara"]], ["id"], limit=1)[0]["id"]
    currency = api.search("res.currency", [["name", "=", "IDR"]], ["id"], limit=1)[0]["id"]
    [pricelist] = api.call("product.pricelist", "create", vals_list=[{
        "name": f"Grosir Regresi {tag}", "currency_id": currency,
        "item_ids": [
            [0, 0, {"applied_on": "2_product_category", "categ_id": categ, "min_quantity": 1.0, "compute_price": "percentage", "percent_price": 10.0}],
            [0, 0, {"applied_on": "1_product", "product_tmpl_id": info["product_tmpl_id"][0], "min_quantity": 3.0, "compute_price": "percentage", "percent_price": 20.0}],
        ],
    }])
    check(len(api.read("product.pricelist", pricelist, ["item_ids"])["item_ids"]) == 2, "daftar harga tersimpan dengan dua aturan")

    def price_for(qty):
        [order] = api.call("sale.order", "create", vals_list=[{"partner_id": customer, "pricelist_id": pricelist, "order_line": [[0, 0, {"product_id": product["id"], "product_uom_qty": qty}]]}])
        return api.search("sale.order.line", [["order_id", "=", order]], ["price_unit"])[0]["price_unit"]

    check(abs(price_for(1.0) - list_price * 0.9) < 0.01, "jumlah 1: aturan kategori (diskon 10%) dipakai")
    check(abs(price_for(3.0) - list_price * 0.8) < 0.01, "jumlah 3: aturan produk yang lebih spesifik (diskon 20%) dipakai")
    item = api.search("product.pricelist.item", [["pricelist_id", "=", pricelist], ["applied_on", "=", "2_product_category"]], ["id"])[0]["id"]
    api.call("product.pricelist", "write", ids=[pricelist], vals={"item_ids": [[1, item, {"percent_price": 15.0}]]})
    check(abs(price_for(1.0) - list_price * 0.85) < 0.01, "aturan yang diubah langsung berlaku pada Sales Order baru")
    api.call("product.pricelist", "action_archive", ids=[pricelist])
    check(api.read("product.pricelist", pricelist, ["active"])["active"] is False, "daftar harga bisa diarsipkan")


def check_account_reports(api):
    """Kueri laporan Tax Report, Invoice Analysis, dan Analytic Report (halaman laporan akuntansi)."""
    step("Laporan akuntansi: pajak, analisis faktur, analitik")
    today = datetime.date.today().isoformat()
    year = f"{datetime.date.today().year}-01-01"
    rows = api.call("account.move.line", "formatted_read_group", domain=[["parent_state", "=", "posted"], ["tax_line_id", "!=", False], ["date", ">=", year], ["date", "<=", today]], groupby=["tax_line_id"], aggregates=["__count", "balance:sum", "tax_base_amount:sum"])
    check(bool(rows) and all("tax_base_amount:sum" in r for r in rows), "tax report: pajak dikelompokkan dengan dasar pengenaan pajak")
    taxes = {t["id"]: t["type_tax_use"] for t in api.search("account.tax", [["id", "in", [r["tax_line_id"][0] for r in rows]]], ["type_tax_use"], context={"active_test": False})}
    output = sum(-r["balance:sum"] for r in rows if taxes.get(r["tax_line_id"][0]) == "sale")
    check(output > 0, f"tax report: PPN keluaran dari penjualan bernilai positif ({output:,.0f})")
    types = api.call("account.invoice.report", "formatted_read_group", domain=[["state", "=", "posted"], ["invoice_date", ">=", year], ["invoice_date", "<=", today]], groupby=["move_type"], aggregates=["__count", "price_subtotal:sum"])
    check({t["move_type"] for t in types} >= {"out_invoice", "in_invoice"}, "invoice analysis: penjualan dan pembelian terpisah per jenis dokumen")
    for dimension in ("invoice_date:month", "commercial_partner_id", "product_id", "product_categ_id", "invoice_user_id"):
        api.call("account.invoice.report", "formatted_read_group", domain=[["state", "=", "posted"], ["move_type", "in", ["out_invoice", "out_refund"]]], groupby=[dimension], aggregates=["__count", "price_subtotal:sum", "price_total:sum", "quantity:sum"])
    check(True, "invoice analysis: lima dimensi pengelompokan diterima Odoo")
    api.call("account.analytic.line", "formatted_read_group", domain=[["date", ">=", year], ["amount", ">", 0]], groupby=["account_id"], aggregates=["__count", "amount:sum"])
    check(isinstance(api.search("account.analytic.account", [], ["name", "code", "plan_id"], context={"active_test": False}), list), "analytic report: kueri akun dan baris analitik diterima Odoo")


def check_dashboards(api):
    """Kueri yang dipakai dashboard tiap modul: hitungan, jumlah, dan deret bulanan atau harian (menu Dashboard)."""
    step("Dashboard modul: kueri hitungan, jumlah, dan deret waktu")
    today = datetime.date.today()
    now_text = datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    month_start = f"{today.year}-{today.month:02d}-01 00:00:00"
    six_months = f"{(today.replace(day=1) - datetime.timedelta(days=150)).strftime('%Y-%m')}-01"

    def grouped(model, domain, groupby, aggregates, **extra):
        return api.call(model, "formatted_read_group", domain=domain, groupby=groupby, aggregates=aggregates, **extra)

    grouped("purchase.request", [], ["state"], ["__count"])
    grouped("purchase.request", [["date_start", ">=", six_months]], ["date_start:month"], ["__count"])
    check(True, "purchase request: hitungan per status dan per bulan diterima Odoo")
    rfq = grouped("purchase.order", [["state", "in", ["draft", "sent", "to approve"]]], [], ["__count", "amount_total:sum"])
    api.call("purchase.order", "search_count", domain=[["state", "=", "purchase"], ["receipt_status", "in", ["pending", "partial"]]])
    api.call("purchase.order", "search_count", domain=[["invoice_status", "=", "to invoice"]])
    grouped("purchase.order", [["state", "in", ["purchase", "done"]], ["date_order", ">=", f"{six_months} 00:00:00"]], ["date_order:month"], ["amount_untaxed:sum"])
    check(isinstance(rfq, list), "purchase: RFQ, PO berjalan, belum diterima, belum ditagih, dan pembelian per bulan diterima Odoo")
    grouped("sale.order", [["state", "in", ["draft", "sent"]]], [], ["__count", "amount_total:sum"])
    api.call("sale.order", "search_count", domain=[["state", "=", "sale"], ["delivery_status", "in", ["pending", "started", "partial"]]])
    grouped("sale.order", [["state", "in", ["sale", "done"]]], ["partner_id"], ["amount_untaxed:sum"])
    check(True, "sales: quotation, perlu dikirim, dan pelanggan terbesar diterima Odoo")
    api.call("stock.picking", "search_count", domain=[["state", "in", ["assigned", "confirmed", "waiting"]], ["scheduled_date", "<", now_text]])
    api.call("stock.quant", "search_count", domain=[["location_id.usage", "=", "internal"], ["quantity", "<", 0]])
    value = grouped("stock.quant", [["location_id.usage", "=", "internal"]], [], ["value:sum"])
    grouped("stock.move.line", [["state", "=", "done"], ["date", ">=", f"{six_months} 00:00:00"], ["location_id.usage", "!=", "internal"], ["location_dest_id.usage", "=", "internal"], ["location_id.usage", "!=", "inventory"]], ["date:month"], ["quantity:sum"])
    api.search("stock.warehouse.orderpoint", [["trigger", "=", "manual"]], ["qty_to_order"], limit=50)
    check(bool(value), "inventory: nilai stok, stok minus, terlambat, dan barang masuk per bulan diterima Odoo")
    grouped("mrp.production", [], ["state"], ["__count"])
    grouped("mrp.production", [["state", "=", "done"], ["date_finished", ">=", month_start]], [], ["product_qty:sum"])
    grouped("mrp.production", [["state", "=", "done"], ["date_finished", ">=", f"{six_months} 00:00:00"]], ["date_finished:month"], ["product_qty:sum"])
    check(True, "manufacture: MO per status, produksi bulan ini, dan per bulan diterima Odoo")
    grouped("crm.lead", [["type", "=", "opportunity"], ["active", "=", True], ["won_status", "=", "pending"]], ["stage_id"], ["__count", "expected_revenue:sum"])
    grouped("crm.lead", [["type", "=", "opportunity"], ["won_status", "=", "won"], ["date_closed", ">=", f"{six_months} 00:00:00"]], ["date_closed:month"], ["expected_revenue:sum"])
    api.call("mail.activity", "search_count", domain=[["res_model", "=", "crm.lead"], ["date_deadline", "<", today.isoformat()]])
    check(True, "crm: pipeline per tahap, menang per bulan, dan aktivitas lewat tenggat diterima Odoo")
    grouped("pos.order", [["state", "in", ["paid", "done", "invoiced"]], ["date_order", ">=", f"{six_months} 00:00:00"]], ["date_order:day"], ["amount_total:sum"])
    grouped("pos.payment", [["payment_date", ">=", month_start]], ["payment_method_id"], ["amount:sum"])
    api.search("pos.session", [["state", "in", ["opened", "opening_control"]]], ["name", "config_id", "user_id", "order_count"], limit=10)
    check(True, "pos: penjualan harian, pembayaran per metode, dan sesi berjalan diterima Odoo")
    liquidity = grouped("account.move.line", [["parent_state", "=", "posted"], ["account_id.account_type", "=", "asset_cash"]], ["account_id"], ["balance:sum"])
    grouped("account.move.line", [["parent_state", "=", "posted"], ["account_id.account_type", "=", "asset_receivable"], ["reconciled", "=", False], ["date_maturity", "<", today.isoformat()]], [], ["amount_residual:sum"])
    grouped("account.move.line", [["parent_state", "=", "posted"], ["account_id.account_type", "in", ["income", "income_other"]], ["date", ">=", six_months]], ["date:month"], ["balance:sum"])
    grouped("account.move.line", [["parent_state", "=", "posted"], ["account_id.account_type", "in", ["expense", "expense_depreciation", "expense_direct_cost"]], ["date", ">=", six_months]], ["date:month"], ["balance:sum"])
    api.call("account.move", "search_count", domain=[["state", "=", "draft"], ["move_type", "in", ["out_invoice", "in_invoice", "out_refund", "in_refund"]]])
    check(bool(liquidity), "accounting: kas dan bank, piutang jatuh tempo, serta pendapatan dan biaya per bulan diterima Odoo")


def check_accounting_masters(api):
    """Master akuntansi: akun, pajak dengan akun pajak, mata uang dan kurs, analitik, jurnal, model aset, dan siklus aset (halaman master Accounting)."""
    step("Master akuntansi: akun, pajak, kurs, analitik, jurnal, aset")
    tag = datetime.datetime.now().strftime("%H%M%S")
    company = api.search("res.company", [], ["id"], limit=1)[0]["id"]
    [account] = api.call("account.account", "create", vals_list=[{"code": f"9{tag}", "name": f"Akun regresi {tag}", "account_type": "income", "company_ids": [[6, 0, [company]]]}])
    check(api.read("account.account", account, ["account_type", "company_ids"])["company_ids"] == [company], "akun baru tersimpan untuk perusahaan")
    api.call("account.account", "write", ids=[account], vals={"name": f"Akun regresi {tag} (ubah)", "reconcile": False})
    api.call("account.account", "action_archive", ids=[account])
    check(api.read("account.account", account, ["active"])["active"] is False, "akun bisa diarsipkan")

    group = api.search("account.tax.group", [], ["id"], limit=1)[0]["id"]
    vat_account = api.search("account.account", [["account_type", "in", ["liability_current", "asset_current"]]], ["id"], limit=1)[0]["id"]
    [tax] = api.call("account.tax", "create", vals_list=[{"name": f"PPN regresi {tag}", "type_tax_use": "sale", "amount_type": "percent", "amount": 5.0, "invoice_label": "PPN 5%", "tax_group_id": group}])
    info = api.read("account.tax", tax, ["invoice_repartition_line_ids", "refund_repartition_line_ids"])
    tax_lines = api.search("account.tax.repartition.line", [["id", "in", info["invoice_repartition_line_ids"] + info["refund_repartition_line_ids"]], ["repartition_type", "=", "tax"]], ["id"])
    check(len(tax_lines) == 2, "pajak baru membuat baris pajak untuk faktur dan nota kredit")
    api.call("account.tax.repartition.line", "write", ids=[row["id"] for row in tax_lines], vals={"account_id": vat_account})
    check(all(row["account_id"][0] == vat_account for row in api.search("account.tax.repartition.line", [["id", "in", [x["id"] for x in tax_lines]]], ["account_id"])), "akun pajak ditulis ke kedua baris pajak")

    usd = api.search("res.currency", [["name", "=", "USD"]], ["id"], context={"active_test": False})[0]["id"]
    api.call("res.currency", "write", ids=[usd], vals={"active": True})
    [rate] = api.call("res.currency.rate", "create", vals_list=[{"name": (datetime.date(2000, 1, 1) + datetime.timedelta(days=int(tag) % 9000)).isoformat(), "inverse_company_rate": 16_250.0, "currency_id": usd}])
    check(abs(api.read("res.currency.rate", rate, ["inverse_company_rate"])["inverse_company_rate"] - 16_250.0) < 0.001, "kurs 1 USD = 16.250 IDR tersimpan")
    api.call("res.currency.rate", "write", ids=[rate], vals={"inverse_company_rate": 16_300.0})
    check(abs(api.read("res.currency.rate", rate, ["inverse_company_rate"])["inverse_company_rate"] - 16_300.0) < 0.001, "kurs bisa diubah")

    [plan] = api.call("account.analytic.plan", "create", vals_list=[{"name": f"Plan regresi {tag}"}])
    [analytic] = api.call("account.analytic.account", "create", vals_list=[{"name": f"Proyek regresi {tag}", "code": f"P{tag}", "plan_id": plan}])
    check(api.read("account.analytic.account", analytic, ["plan_id"])["plan_id"][0] == plan, "akun analitik terhubung ke plan")

    [journal] = api.call("account.journal", "create", vals_list=[{"name": f"Kas regresi {tag}", "code": f"R{tag[-4:]}", "type": "cash"}])
    check(bool(api.read("account.journal", journal, ["default_account_id"])["default_account_id"]), "jurnal kas baru otomatis membuat akun bawaannya")

    general = api.search("account.journal", [["type", "=", "general"]], ["id"], limit=1)[0]["id"]
    fixed = api.search("account.account", [["account_type", "=", "asset_fixed"]], ["id"], order="code", limit=2)
    depreciation = api.search("account.account", [["account_type", "=", "expense_depreciation"]], ["id"], limit=1)
    expense = depreciation or api.search("account.account", [["account_type", "=", "expense"]], ["id"], limit=1)
    [profile] = api.call("account.asset.profile", "create", vals_list=[{
        "name": f"Model regresi {tag}", "journal_id": general, "account_asset_id": fixed[0]["id"], "account_depreciation_id": fixed[-1]["id"],
        "account_expense_depreciation_id": expense[0]["id"], "method": "linear", "method_time": "number", "method_number": 4, "method_period": "month",
    }])
    [asset] = api.call("account.asset", "create", vals_list=[{"name": f"Aset regresi {tag}", "profile_id": profile, "purchase_value": 4_000_000.0, "date_start": "2026-01-01"}])
    inherited = api.read("account.asset", asset, ["state", "method_number", "method_period"])
    check(inherited["state"] == "draft" and inherited["method_number"] == 4 and inherited["method_period"] == "month", "aset baru mewarisi metode dari model aset")
    api.call("account.asset", "validate", ids=[asset])
    lines = api.search("account.asset.line", [["asset_id", "=", asset], ["type", "=", "depreciate"]], ["amount", "move_id"], order="line_date")
    check(len(lines) == 4 and all(row["amount"] == 1_000_000.0 for row in lines), "konfirmasi membuat 4 baris penyusutan bulanan @ 1.000.000")
    moves_before = api.call("account.move", "search_count", domain=[])
    api.call("account.asset.line", "create_move", ids=[lines[0]["id"]])
    posted = api.read("account.asset", asset, ["value_depreciated", "value_residual"])
    check(api.call("account.move", "search_count", domain=[]) == moves_before + 1 and posted["value_depreciated"] == 1_000_000.0, "posting satu baris membuat jurnal dan mengurangi nilai buku")
    for line in lines[1:]:
        api.call("account.asset.line", "create_move", ids=[line["id"]])
    check(api.read("account.asset", asset, ["state", "value_residual"]) == {"id": asset, "state": "close", "value_residual": 0.0}, "semua penyusutan diposting: aset selesai dan nilai sisa nol")


def check_analysis_reports(api):
    """Semua dimensi dan ukuran laporan analisis (menu Report di Purchase Request, Purchase, Inventory, Sales, POS) diterima Odoo."""
    step("Laporan analisis: dimensi dan ukuran per model")
    year = f"{datetime.date.today().year}-01-01 00:00:00"
    sale_measures = ["__count", "product_uom_qty:sum", "qty_delivered:sum", "qty_invoiced:sum", "price_subtotal:sum", "price_total:sum"]
    pos_measures = ["__count", "product_qty:sum", "total_discount:sum", "price_total:sum", "margin:sum"]
    specs = [
        ("purchase.request.line", [["date_required", ">=", year[:10]]], ["date_required:month", "product_id", "requested_by", "request_state"], ["__count", "product_qty:sum", "estimated_cost:sum"]),
        ("purchase.report", [["state", "in", ["purchase", "done"]], ["date_order", ">=", year]], ["date_order:month", "partner_id", "product_id", "category_id", "user_id"],
         ["__count", "qty_ordered:sum", "qty_received:sum", "qty_billed:sum", "untaxed_total:sum", "price_total:sum"]),
        ("stock.move.line", [["state", "=", "done"], ["date", ">=", year]], ["date:month", "product_id", "product_category_name", "picking_partner_id", "location_id", "location_dest_id", "lot_id"], ["__count", "quantity:sum"]),
        ("sale.report", [["state", "in", ["sale", "done"]], ["date", ">=", year]], ["date:month", "partner_id", "product_id", "categ_id", "user_id", "team_id"], sale_measures),
        ("report.pos.order", [["state", "in", ["paid", "done", "invoiced"]], ["date", ">=", year]], ["date:day", "date:month", "product_id", "product_categ_id", "user_id", "config_id", "partner_id", "session_id"], pos_measures),
    ]
    for model, domain, dimensions, measures in specs:
        for dimension in dimensions:
            api.call(model, "formatted_read_group", domain=domain, groupby=[dimension], aggregates=measures)
        check(True, f"{model}: {len(dimensions)} dimensi dengan {len(measures)} ukuran diterima Odoo")
    purchase = api.call("purchase.report", "formatted_read_group", domain=[["state", "in", ["purchase", "done"]], ["date_order", ">=", year]], groupby=[], aggregates=["__count", "untaxed_total:sum", "qty_ordered:sum"])[0]
    lines = api.search("purchase.order.line", [["order_id.state", "in", ["purchase", "done"]], ["date_order", ">=", year]], ["price_subtotal", "product_qty"])
    check(len(lines) == purchase["__count"] and abs(sum(row["price_subtotal"] for row in lines) - purchase["untaxed_total:sum"]) < 0.01, "Purchase Order Analisis sama dengan jumlah baris Purchase Order Line (baris, nilai, dan jumlah)")
    api.search("sale.order.line", [["order_id.date_order", ">=", year]], ["order_id", "order_partner_id", "product_id", "product_uom_qty", "qty_delivered", "qty_invoiced", "price_unit", "discount", "price_subtotal", "state"], limit=50)
    api.search("purchase.request.line", [["date_required", ">=", year[:10]]], ["request_id", "product_id", "product_qty", "purchased_qty", "estimated_cost", "request_state"], limit=50)
    check(True, "baris Sales Order dan Purchase Request Line terbaca dengan kolom laporan")


def compare_range(start, end, mode):
    """Rentang pembanding seperti di ui/live/pages/analysis.js: "prev" = selama sama tepat sebelum awal, "year" = setahun lalu (29 Februari menjadi 28)."""
    first, last = datetime.date.fromisoformat(start), datetime.date.fromisoformat(end)
    if mode == "year":
        def back(day):
            try:
                return day.replace(year=day.year - 1)
            except ValueError:
                return day.replace(year=day.year - 1, day=28)
        return back(first).isoformat(), back(last).isoformat()
    stop = first - datetime.timedelta(days=1)
    return (stop - datetime.timedelta(days=(last - first).days)).isoformat(), stop.isoformat()


def check_analysis_drill(api):
    """Drill-down dan perbandingan periode di laporan analisis (D37): angka kelompok, pembanding, dan baris rincian dihitung ulang dari dokumen."""
    step("Analisis: drill-down dan perbandingan periode (dihitung ulang dari baris dokumen)")
    tag = datetime.datetime.now().strftime("%H%M%S")
    base = api.search("product.product", [["name", "=", "Bahan Baku Nusara"]], ["uom_id", "categ_id"], limit=1)[0]
    vendors = {n: api.call("res.partner", "create", vals_list=[{"name": f"Vendor Drill {n} {tag}", "is_company": True, "supplier_rank": 1}])[0] for n in "ABC"}
    customers = {n: api.call("res.partner", "create", vals_list=[{"name": f"Pelanggan Drill {n} {tag}", "is_company": True, "customer_rank": 1}])[0] for n in "AB"}
    [product] = api.call("product.product", "create", vals_list=[{
        "name": f"Produk Drill {tag}", "type": "consu", "is_storable": True, "categ_id": base["categ_id"][0], "standard_price": 50_000.0, "list_price": 150_000.0,
    }])
    cur = ("2024-03-01", "2024-04-30")
    year, prev = compare_range(*cur, "year"), compare_range(*cur, "prev")
    check(year == ("2023-03-01", "2023-04-30") and prev == ("2023-12-31", "2024-02-29"), f"rentang pembanding: tahun lalu {year}, periode sebelumnya {prev}")
    check(compare_range("2024-02-29", "2024-02-29", "year") == ("2023-02-28", "2023-02-28"), "29 Februari setahun lalu menjadi 28 Februari")

    # Pembelian (vendor, tanggal, jumlah; harga 100.000) dan penjualan (pelanggan, tanggal, jumlah; harga 150.000) pada tiga periode.
    purchases = [("A", "2024-03-10", 5), ("A", "2024-04-05", 2), ("B", "2024-03-20", 3), ("A", "2023-03-15", 4), ("C", "2023-04-02", 1), ("A", "2024-02-10", 1), ("B", "2024-01-15", 6)]
    sales = [("A", "2024-03-12", 2), ("B", "2024-04-08", 1), ("A", "2024-04-20", 3), ("A", "2023-03-05", 1)]
    purchase_ids, sale_ids, pickings = [], [], {}
    for who, when, qty in purchases:
        [order_id] = api.call("purchase.order", "create", vals_list=[{
            "partner_id": vendors[who], "order_line": [[0, 0, {"product_id": product, "name": "Drill", "product_qty": float(qty), "product_uom_id": base["uom_id"][0]}]],
        }])
        line = api.search("purchase.order.line", [["order_id", "=", order_id]], ["id"])[0]
        api.call("purchase.order.line", "write", ids=[line["id"]], vals={"price_unit": 100_000.0})
        api.call("purchase.order", "button_confirm", ids=[order_id])
        api.call("purchase.order", "write", ids=[order_id], vals={"date_order": f"{when} 10:00:00"})
        purchase_ids.append(order_id)
        if (who, when) in (("A", "2024-03-10"), ("B", "2024-03-20"), ("A", "2023-03-15")):  # tiga penerimaan penuh, tanggalnya dimundurkan
            picking = api.search("stock.picking", [["purchase_id", "=", order_id]], ["id"])[0]["id"]
            move = api.search("stock.move", [["picking_id", "=", picking]], ["id"])[0]["id"]
            api.call("stock.move", "write", ids=[move], vals={"quantity": float(qty), "picked": True})
            api.call("stock.picking", "button_validate", ids=[picking])
            api.call("stock.move.line", "write", ids=[m["id"] for m in api.search("stock.move.line", [["picking_id", "=", picking]], ["id"])], vals={"date": f"{when} 12:00:00"})
            pickings[picking] = qty
    for who, when, qty in sales:
        [order_id] = api.call("sale.order", "create", vals_list=[{"partner_id": customers[who], "order_line": [[0, 0, {"product_id": product, "product_uom_qty": float(qty)}]]}])
        line = api.search("sale.order.line", [["order_id", "=", order_id]], ["id"])[0]
        api.call("sale.order.line", "write", ids=[line["id"]], vals={"price_unit": 150_000.0})
        api.call("sale.order", "action_confirm", ids=[order_id])
        api.call("sale.order", "write", ids=[order_id], vals={"date_order": f"{when} 10:00:00"})
        sale_ids.append(order_id)

    def span(period):
        return [f"{period[0]} 00:00:00", f"{period[1]} 23:59:59"]

    def groups(model, domain, by, aggregates):
        rows = api.call(model, "formatted_read_group", domain=domain, groupby=[by], aggregates=aggregates)
        return {(r[by][0] if isinstance(r[by], list) else r[by]): r for r in rows}

    def pdomain(period):
        return [["product_id", "=", product], ["state", "in", ["purchase", "done"]], ["date_order", ">=", span(period)[0]], ["date_order", "<=", span(period)[1]]]

    def expected(plan, period, price):
        total = {}
        for who, when, qty in plan:
            if period[0] <= when <= period[1]:
                total[who] = total.get(who, 0.0) + qty * price
        return total

    measures = ["__count", "untaxed_total:sum", "qty_ordered:sum"]
    for name, period in (("periode ini", cur), ("tahun lalu", year), ("periode sebelumnya", prev)):
        got = groups("purchase.report", pdomain(period), "partner_id", measures)
        mine = {who: got[vid]["untaxed_total:sum"] for who, vid in vendors.items() if vid in got}
        check(mine == expected(purchases, period, 100_000.0) and set(got) <= set(vendors.values()), f"Purchase Order Analisis per vendor, {name}: {mine}")
        lines = api.search("purchase.order.line", [["product_id", "=", product], ["order_id.state", "in", ["purchase", "done"]], ["date_order", ">=", span(period)[0]], ["date_order", "<=", span(period)[1]]], ["price_subtotal", "product_qty"])
        total = api.call("purchase.report", "formatted_read_group", domain=pdomain(period), groupby=[], aggregates=measures)[0]
        check(total["__count"] == len(lines) and total["untaxed_total:sum"] == sum(x["price_subtotal"] for x in lines) and total["qty_ordered:sum"] == sum(x["product_qty"] for x in lines), f"total {name} sama dengan jumlah baris Purchase Order Line ({len(lines)} baris)")

    # Selisih dan persen per vendor (periode ini dibanding tahun lalu): A 700.000 vs 400.000, B 300.000 vs 0 (baru), C 0 vs 100.000.
    now_a, then_a = expected(purchases, cur, 100_000.0), expected(purchases, year, 100_000.0)
    diffs = {who: (now_a.get(who, 0.0) - then_a.get(who, 0.0), (now_a.get(who, 0.0) - then_a.get(who, 0.0)) / then_a[who] * 100 if then_a.get(who) else None) for who in "ABC"}
    check(diffs == {"A": (300_000.0, 75.0), "B": (300_000.0, None), "C": (-100_000.0, -100.0)}, f"selisih dan persen per vendor terhadap tahun lalu: {diffs}")

    # Bulan: bucket dipasangkan menurut urutan dari awal rentang.
    def months(period):
        got = groups("purchase.report", pdomain(period), "date_order:month", ["untaxed_total:sum"])
        return {key[:7]: row["untaxed_total:sum"] for key, row in got.items()}
    check(months(cur) == {"2024-03": 800_000.0, "2024-04": 200_000.0}, "bulan periode ini: Mar 800.000, Apr 200.000")
    check(months(year) == {"2023-03": 400_000.0, "2023-04": 100_000.0}, "bulan tahun lalu: Mar 400.000, Apr 100.000 (pasangan Mar dan Apr periode ini)")
    check(months(prev) == {"2024-01": 600_000.0, "2024-02": 100_000.0}, "bulan periode sebelumnya: Jan 600.000 dan Feb 100.000 (Des kosong)")

    # Drill-down: baris rincian = baris kelompok (sama banyak, sama jumlah), tertaut ke dokumen yang benar.
    for by in ("partner_id", "date_order:month"):
        for key, group in groups("purchase.report", pdomain(cur), by, measures).items():
            rows = api.search("purchase.report", pdomain(cur) + group["__extra_domain"], ["order_id", "partner_id", "untaxed_total", "date_order"])
            check(len(rows) == group["__count"] and sum(r["untaxed_total"] for r in rows) == group["untaxed_total:sum"], f"drill PO per {by} ({key}): {len(rows)} baris, jumlah sama dengan kelompok")
            check(all(r["order_id"][0] in purchase_ids for r in rows), f"drill PO per {by} ({key}): setiap baris tertaut ke PO yang dibuat uji ini")
            if by == "partner_id":
                check(all(r["partner_id"][0] == key for r in rows), f"drill PO per vendor ({key}): semua baris milik vendor itu")
            else:
                check(all(r["date_order"][:7] == key[:7] for r in rows), f"drill PO bulan {key[:7]}: semua baris jatuh pada bulan itu")

    # Sales Order Analisis (sale.report) terhadap Sales Order Line, dan rincian bertaut ke Sales Order.
    def sdomain(period):
        return [["product_id", "=", product], ["state", "in", ["sale", "done"]], ["date", ">=", span(period)[0]], ["date", "<=", span(period)[1]]]
    for name, period in (("periode ini", cur), ("tahun lalu", year)):
        got = groups("sale.report", sdomain(period), "partner_id", ["__count", "price_subtotal:sum", "product_uom_qty:sum"])
        mine = {who: got[cid]["price_subtotal:sum"] for who, cid in customers.items() if cid in got}
        check(mine == expected(sales, period, 150_000.0), f"Sales Order Analisis per pelanggan, {name}: {mine}")
        lines = api.search("sale.order.line", [["product_id", "=", product], ["state", "in", ["sale", "done"]], ["order_id.date_order", ">=", span(period)[0]], ["order_id.date_order", "<=", span(period)[1]]], ["price_subtotal"])
        total = api.call("sale.report", "formatted_read_group", domain=sdomain(period), groupby=[], aggregates=["__count", "price_subtotal:sum"])[0]
        check(total["__count"] == len(lines) and total["price_subtotal:sum"] == sum(x["price_subtotal"] for x in lines), f"total penjualan {name} sama dengan Sales Order Line ({len(lines)} baris)")
    for key, group in groups("sale.report", sdomain(cur), "partner_id", ["__count", "price_subtotal:sum"]).items():
        rows = api.search("sale.report", sdomain(cur) + group["__extra_domain"], ["name", "order_reference", "price_subtotal"])
        refs = {int(r["order_reference"].split(",")[1]) for r in rows if r["order_reference"].startswith("sale.order,")}
        check(len(rows) == group["__count"] and refs <= set(sale_ids) and sum(r["price_subtotal"] for r in rows) == group["price_subtotal:sum"], f"drill penjualan per pelanggan ({key}): {len(rows)} baris tertaut ke Sales Order")

    # Move Analisis: jumlah masuk per bulan dan rincian tertaut ke penerimaan.
    def mdomain(period):
        return [["product_id", "=", product], ["state", "=", "done"], ["date", ">=", span(period)[0]], ["date", "<=", span(period)[1]]]
    got = groups("stock.move.line", mdomain(cur), "date:month", ["__count", "quantity:sum"])
    check({k[:7]: v["quantity:sum"] for k, v in got.items()} == {"2024-03": 8.0}, "Move Analisis periode ini: Mar 2024 menerima 8 (5 dan 3)")
    got = groups("stock.move.line", mdomain(year), "date:month", ["__count", "quantity:sum"])
    check({k[:7]: v["quantity:sum"] for k, v in got.items()} == {"2023-03": 4.0}, "Move Analisis tahun lalu: Mar 2023 menerima 4")
    group = groups("stock.move.line", mdomain(cur), "product_id", ["__count", "quantity:sum"])[product]
    rows = api.search("stock.move.line", mdomain(cur) + group["__extra_domain"], ["picking_id", "picking_code", "quantity"])
    check(len(rows) == group["__count"] == 2 and {r["picking_id"][0] for r in rows} <= set(pickings) and all(r["picking_code"] == "incoming" for r in rows), "drill Move Analisis: 2 baris tertaut ke penerimaan yang membuatnya")


def check_settings_and_users(api):
    """Pengaturan per modul, kunci periode, data perusahaan, dan pengguna dengan peran (halaman Setting, Company Setting, Users & Access)."""
    step("Pengaturan modul, perusahaan, dan pengguna")
    tag = datetime.datetime.now().strftime("%H%M%S")

    def settings(**vals):
        [sid] = api.call("res.config.settings", "create", vals_list=[vals])
        return sid

    current = api.call("res.config.settings", "read", ids=[settings()], fields=["quotation_validity_days", "po_order_approval", "po_double_validation_amount", "tax_calculation_rounding_method", "fiscalyear_last_day"])[0]
    check(current["quotation_validity_days"] >= 0 and current["tax_calculation_rounding_method"] in ("round_per_line", "round_globally"), "nilai pengaturan saat ini terbaca lewat create lalu read")
    new_days = current["quotation_validity_days"] + 3
    api.call("res.config.settings", "execute", ids=[settings(quotation_validity_days=new_days)])
    check(api.read("res.company", 1, ["quotation_validity_days"])["quotation_validity_days"] == new_days, "pengaturan diterapkan ke perusahaan lewat execute")
    api.call("res.config.settings", "execute", ids=[settings(quotation_validity_days=current["quotation_validity_days"])])
    check(api.read("res.company", 1, ["quotation_validity_days"])["quotation_validity_days"] == current["quotation_validity_days"], "pengaturan dikembalikan")

    api.call("res.config.settings", "execute", ids=[settings(po_order_approval=True, po_double_validation_amount=7_500_000.0)])
    approval = api.read("res.company", 1, ["po_double_validation", "po_double_validation_amount"])
    check(approval["po_double_validation"] == "two_step" and approval["po_double_validation_amount"] == 7_500_000.0, "persetujuan PO aktif dengan nominal batas")
    api.call("res.config.settings", "execute", ids=[settings(po_order_approval=current["po_order_approval"], po_double_validation_amount=current["po_double_validation_amount"])])
    check(api.read("res.company", 1, ["po_double_validation"])["po_double_validation"] == ("two_step" if current["po_order_approval"] else "one_step"), "persetujuan PO dikembalikan")

    original = api.read("res.company", 1, ["sale_lock_date", "phone", "street", "report_footer"])
    api.call("res.company", "write", ids=[1], vals={"sale_lock_date": "2020-01-31", "phone": f"021-{tag}", "street": f"Jl. Regresi {tag}", "report_footer": "<p>Footer regresi</p>"})
    written = api.read("res.company", 1, ["sale_lock_date", "phone", "street"])
    check(written["sale_lock_date"] == "2020-01-31" and written["phone"] == f"021-{tag}", "kunci penjualan dan data perusahaan tersimpan")
    api.call("res.company", "write", ids=[1], vals={"sale_lock_date": original["sale_lock_date"], "phone": original["phone"], "street": original["street"], "report_footer": original["report_footer"]})
    check(api.read("res.company", 1, ["sale_lock_date"])["sale_lock_date"] == original["sale_lock_date"], "kunci periode dibuka kembali")
    try:
        api.call("res.company", "write", ids=[1], vals={"vat": "0123456789012345"})
        check(False, "NPWP tidak valid seharusnya ditolak")
    except RuntimeError as error:
        check("NPWP" in str(error), "NPWP yang tidak valid ditolak Odoo dengan pesan yang jelas")

    group_ids = {}
    for xml in ("purchase.group_purchase_user", "purchase.group_purchase_manager", "stock.group_stock_user", "account.group_account_invoice", "account.group_account_manager"):
        module, name = xml.split(".")
        group_ids[xml] = api.search("ir.model.data", [["model", "=", "res.groups"], ["module", "=", module], ["name", "=", name]], ["res_id"])[0]["res_id"]
    [user] = api.call("res.users", "create", vals_list=[{"name": f"Pengguna regresi {tag}", "login": f"regresi{tag}@example.test", "email": f"regresi{tag}@example.test"}])
    api.call("res.users", "write", ids=[user], vals={"group_ids": [[4, group_ids["purchase.group_purchase_manager"]], [4, group_ids["stock.group_stock_user"]], [4, group_ids["account.group_account_invoice"]]]})
    held = set(api.read("res.users", user, ["all_group_ids"])["all_group_ids"])
    check(group_ids["purchase.group_purchase_manager"] in held and group_ids["purchase.group_purchase_user"] in held, "peran manajer pembelian membawa peran pengguna (tersirat)")
    check(api.read("res.users", user, ["share"])["share"] is False, "pengguna baru adalah pengguna internal")
    api.call("res.users", "write", ids=[user], vals={"group_ids": [[4, group_ids["purchase.group_purchase_user"]], [3, group_ids["purchase.group_purchase_manager"]], [3, group_ids["stock.group_stock_user"]], [4, group_ids["account.group_account_manager"]]]})
    held = set(api.read("res.users", user, ["all_group_ids"])["all_group_ids"])
    check(group_ids["purchase.group_purchase_manager"] not in held and group_ids["purchase.group_purchase_user"] in held and group_ids["stock.group_stock_user"] not in held and group_ids["account.group_account_manager"] in held,
          "peran diturunkan (pengguna ditautkan lebih dulu), dicabut, dan dinaikkan")
    api.call("res.users", "action_archive", ids=[user])
    check(api.read("res.users", user, ["active"])["active"] is False, "pengguna bisa diarsipkan")


def import_csv(api, model, csv, dryrun, context=None):
    """Impor CSV lewat base_import seperti halaman Import Data: baca berkas, petakan kolom dari pencocokan otomatis, lalu jalankan."""
    [rid] = api.call("base_import.import", "create", vals_list=[{"res_model": model, "file": csv, "file_type": "text/csv", "file_name": "regresi.csv"}])
    options = {"quoting": '"', "separator": ",", "encoding": "utf-8", "has_headers": True, "date_format": "", "datetime_format": ""}
    preview = api.call("base_import.import", "parse_preview", ids=[rid], options=options)
    fields = ["/".join(preview["matches"].get(str(i)) or []) or False for i in range(len(preview["headers"]))]
    params = {"ids": [rid], "fields": fields, "columns": preview["headers"], "options": preview["options"], "dryrun": dryrun}
    if context:
        params["context"] = context
    return fields, api.call("base_import.import", "execute_import", **params)


def check_data_import(api):
    """Halaman Import Data: kolom dipetakan otomatis, uji tanpa simpan tidak menyimpan, galat membatalkan semuanya, impor memasukkan data."""
    step("Impor data CSV (produk, stok awal, jurnal)")
    tag = datetime.datetime.now().strftime("%H%M%S")
    header = "name,default_code,categ_id,type,is_storable,list_price,standard_price\n"
    good = header + f"Impor Regresi A {tag},IMP-A-{tag},Goods,consu,1,15000,7000\nImpor Regresi B {tag},IMP-B-{tag},Goods,consu,1,2500,1000\n"
    count = lambda: api.call("product.template", "search_count", domain=[["default_code", "in", [f"IMP-A-{tag}", f"IMP-B-{tag}"]]])  # noqa: E731

    fields, bad = import_csv(api, "product.template", good.replace("2500", "abc"), dryrun=True)
    check(fields == ["name", "default_code", "categ_id", "type", "is_storable", "list_price", "standard_price"], "kolom CSV dipetakan otomatis ke field produk")
    check(not bad.get("ids") and any(m["type"] == "error" and m.get("field_path") == ["list_price"] for m in bad["messages"]), "angka tidak valid ditolak dengan galat pada kolomnya")
    _, dry = import_csv(api, "product.template", good, dryrun=True)
    check(len(dry["ids"]) == 2 and not dry["messages"] and count() == 0, "uji tanpa simpan lulus dan tidak menyimpan produk")
    _, real = import_csv(api, "product.template", good, dryrun=False)
    products = api.call("product.template", "read", ids=real["ids"], fields=["name", "list_price", "standard_price", "categ_id", "is_storable"])
    check(count() == 2 and sorted(p["list_price"] for p in products) == [2500, 15000] and all(p["is_storable"] and p["categ_id"][1] == "Goods" for p in products), "impor menyimpan produk dengan harga dan kategori yang benar")

    _, stock = import_csv(api, "stock.quant", f"product_id,location_id,inventory_quantity\nIMP-A-{tag},WH/Stock,40\n", dryrun=False, context={"inventory_mode": True})
    api.call("stock.quant", "action_apply_inventory", ids=stock["ids"])
    onhand = api.search("stock.quant", [["product_id.default_code", "=", f"IMP-A-{tag}"], ["location_id.complete_name", "=", "WH/Stock"]], ["quantity"])
    check(onhand and onhand[0]["quantity"] == 40, "stok awal diimpor lalu diterapkan sebagai penyesuaian persediaan")

    account = api.search("account.account", [["account_type", "=", "asset_cash"]], ["code"], limit=1)[0]["code"]
    equity = api.search("account.account", [["account_type", "=", "equity"]], ["code"], limit=1)[0]["code"]
    lines = "ref,date,journal_id,line_ids/account_id,line_ids/name,line_ids/debit,line_ids/credit\n"
    _, unbalanced = import_csv(api, "account.move", lines + f"Saldo Tak Seimbang {tag},2026-01-01,Miscellaneous Operations,{account},Kas,1000,0\n,,,{equity},Modal,0,900\n", dryrun=True)
    check(not unbalanced.get("ids") and any(m["type"] == "error" and "not balanced" in m["message"] for m in unbalanced["messages"]), "jurnal tak seimbang ditolak saat uji impor")
    _, journal = import_csv(api, "account.move", lines + f"Saldo Regresi {tag},2026-01-01,Miscellaneous Operations,{account},Kas,250000,0\n,,,{equity},Modal,0,250000\n", dryrun=False)
    move = api.read("account.move", journal["ids"][0], ["state", "amount_total", "ref"])
    check(len(journal["ids"]) == 1 and move["state"] == "draft" and move["amount_total"] == 250000, "jurnal banyak baris yang seimbang diimpor sebagai draf")
    api.call("account.move", "unlink", ids=journal["ids"])


XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def make_xlsx(sheets):
    """Berkas .xlsx minimal tanpa pustaka. sheets = [(nama lembar, [[sel]])]; sel str = teks, int atau float = angka, datetime.date = tanggal."""
    names = [name for name, _ in sheets]
    ns_main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    ns_rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    ns_pkg = "http://schemas.openxmlformats.org/package/2006/relationships"
    content_types = (
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        + "".join(f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' for i in range(1, len(names) + 1))
        + "</Types>"
    )
    styles = (
        f'<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="{ns_main}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>'
    )

    def cell(row, col, value):
        ref = f"{chr(65 + col)}{row}"
        if isinstance(value, datetime.date):
            return f'<c r="{ref}" s="1"><v>{(value - datetime.date(1899, 12, 30)).days}</v></c>'
        if isinstance(value, (int, float)):
            return f'<c r="{ref}"><v>{value}</v></c>'
        return f'<c r="{ref}" t="inlineStr"><is><t>{escape(str(value))}</t></is></c>'

    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", f'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="{ns_pkg}"><Relationship Id="rId1" Type="{ns_rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        z.writestr("xl/workbook.xml", f'<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="{ns_main}" xmlns:r="{ns_rel}"><sheets>' + "".join(f'<sheet name="{escape(n)}" sheetId="{i}" r:id="rId{i}"/>' for i, n in enumerate(names, 1)) + "</sheets></workbook>")
        z.writestr("xl/_rels/workbook.xml.rels", f'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="{ns_pkg}">' + "".join(f'<Relationship Id="rId{i}" Type="{ns_rel}/worksheet" Target="worksheets/sheet{i}.xml"/>' for i in range(1, len(names) + 1)) + f'<Relationship Id="rId{len(names) + 1}" Type="{ns_rel}/styles" Target="styles.xml"/></Relationships>')
        z.writestr("xl/styles.xml", styles)
        for i, (_, rows) in enumerate(sheets, 1):
            body = "".join(f'<row r="{r}">' + "".join(cell(r, c, v) for c, v in enumerate(row) if v is not None) + "</row>" for r, row in enumerate(rows, 1))
            z.writestr(f"xl/worksheets/sheet{i}.xml", f'<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="{ns_main}"><sheetData>{body}</sheetData></worksheet>')
    return out.getvalue()


def import_xlsx(api, model, content, dryrun, sheet=None, context=None):
    """Impor .xlsx seperti halaman Import Data: unggah base64 lewat nusara_create_from_file, baca lembar, petakan kolom, lalu jalankan."""
    upload = api.call("base_import.import", "nusara_create_from_file", res_model=model, file_name="regresi.xlsx", file_type=XLSX_TYPE, data=base64.b64encode(content).decode())
    options = {"quoting": '"', "separator": ",", "has_headers": True, "date_format": "", "datetime_format": ""}
    if sheet:
        options["sheet"] = sheet
    preview = api.call("base_import.import", "parse_preview", ids=[upload["id"]], options=options)
    if preview.get("error"):
        return upload, preview, None
    fields = ["/".join(preview["matches"].get(str(i)) or []) or False for i in range(len(preview["headers"]))]
    params = {"ids": [upload["id"]], "fields": fields, "columns": preview["headers"], "options": preview["options"], "dryrun": dryrun}
    if context:
        params["context"] = context
    return upload, preview, api.call("base_import.import", "execute_import", **params)


def check_data_import_xlsx(api):
    """Impor Excel (D36): berkas biner dikirim sebagai base64 lewat nusara_create_from_file, daftar lembar kembali, lembar dipilih, angka desimal, teks khusus, dan tanggal sel terbaca."""
    step("Impor data Excel (.xlsx): lembar, angka, teks khusus, tanggal")
    tag = datetime.datetime.now().strftime("%H%M%S")
    products = [
        ["name", "default_code", "categ_id", "type", "is_storable", "list_price", "standard_price"],
        [f'Impor Xlsx A & Co <1> {tag}', f"XL-A-{tag}", "Goods", "consu", 1, 15000, 7000.5],
        [f'Impor Xlsx "B", Tbk {tag}', f"XL-B-{tag}", "Goods", "consu", 1, 2500.25, 1000],
    ]
    book = make_xlsx([("Catatan", [["Lembar pertama hanya catatan"]]), ("Produk", products)])
    codes = [f"XL-A-{tag}", f"XL-B-{tag}"]
    count = lambda: api.call("product.template", "search_count", domain=[["default_code", "in", codes]])  # noqa: E731

    upload, first, _ = import_xlsx(api, "product.template", book, dryrun=True)
    check(upload["sheets"] == ["Catatan", "Produk"], "daftar lembar Excel dikembalikan saat unggah")
    check(bool(first.get("error")), "lembar pertama yang kosong dilaporkan sebagai galat (pengguna diminta memilih lembar lain)")
    _, preview, dry = import_xlsx(api, "product.template", book, dryrun=True, sheet="Produk")
    check(preview["headers"] == products[0] and len(dry["ids"]) == 2 and not dry["messages"] and count() == 0, "lembar Produk terbaca, uji tanpa simpan lulus dan tidak menyimpan produk")
    _, _, real = import_xlsx(api, "product.template", book, dryrun=False, sheet="Produk")
    rows = api.call("product.template", "read", ids=real["ids"], fields=["name", "list_price", "standard_price", "categ_id"])
    by_code = {r["name"]: r for r in rows}
    check(count() == 2 and by_code[f'Impor Xlsx "B", Tbk {tag}']["list_price"] == 2500.25 and by_code[f'Impor Xlsx A & Co <1> {tag}']["standard_price"] == 7000.5, "angka desimal dan nama dengan tanda kutip, koma, &, dan < terbaca benar")
    check(all(r["categ_id"][1] == "Goods" for r in rows), "kategori dicocokkan dengan nama")

    account = api.search("account.account", [["account_type", "=", "asset_cash"]], ["code"], limit=1)[0]["code"]
    equity = api.search("account.account", [["account_type", "=", "equity"]], ["code"], limit=1)[0]["code"]
    header = ["ref", "date", "journal_id", "line_ids/account_id", "line_ids/name", "line_ids/debit", "line_ids/credit"]
    journal = make_xlsx([("Jurnal", [header,
        [f"Saldo Xlsx {tag}", datetime.date(2026, 3, 5), "Miscellaneous Operations", account, "Kas", 250000, 0],
        [None, None, None, equity, "Modal", 0, 250000]])])
    _, _, moves = import_xlsx(api, "account.move", journal, dryrun=False)
    move = api.read("account.move", moves["ids"][0], ["state", "amount_total", "date"])
    check(len(moves["ids"]) == 1 and move["date"] == "2026-03-05" and move["amount_total"] == 250000 and move["state"] == "draft", "sel tanggal Excel menjadi tanggal jurnal yang benar (2026-03-05) dan baris kedua dilanjutkan")
    api.call("account.move", "unlink", ids=moves["ids"])

    check(fails_with(lambda: api.call("base_import.import", "nusara_create_from_file", res_model="product.template", file_name="x.xlsx", file_type=XLSX_TYPE, data="bukan base64!!"), "base64"), "isi yang bukan base64 ditolak dengan pesan jelas")
    _, broken, _ = import_xlsx(api, "product.template", b"ini bukan berkas excel", dryrun=True)
    check(bool(broken.get("error")), "berkas yang bukan Excel dilaporkan sebagai galat baca")


def check_print_documents(api):
    """Field yang dibaca halaman cetak (ui/live/print.js) harus ada dan terbaca untuk dokumen nyata, agar cetak tidak rusak diam-diam saat Odoo diperbarui."""
    step("Data cetak dokumen (PO, SO, faktur, surat jalan, pembayaran, PR, struk POS, Perintah Produksi)")
    docs = {
        "purchase.order": ([["state", "=", "purchase"]], ["name", "state", "partner_id", "date_order", "date_planned", "partner_ref", "payment_term_id", "user_id", "currency_id", "amount_untaxed", "amount_tax", "amount_total", "note"]),
        "purchase.order.line": ([], ["display_type", "name", "product_qty", "product_uom_id", "price_unit", "tax_ids", "price_subtotal"]),
        "sale.order": ([["state", "=", "sale"]], ["name", "state", "partner_id", "partner_invoice_id", "partner_shipping_id", "date_order", "validity_date", "client_order_ref", "payment_term_id", "user_id", "pricelist_id", "currency_id", "amount_untaxed", "amount_tax", "amount_total", "note"]),
        "sale.order.line": ([], ["display_type", "name", "product_uom_qty", "product_uom_id", "price_unit", "discount", "tax_ids", "price_subtotal"]),
        "account.move": ([["move_type", "=", "out_invoice"], ["state", "=", "posted"]], ["name", "state", "move_type", "partner_id", "invoice_date", "date", "invoice_date_due", "invoice_payment_term_id", "ref", "invoice_origin", "invoice_user_id", "currency_id", "amount_untaxed", "amount_tax", "amount_total", "amount_residual", "narration", "payment_reference"]),
        "account.move.line": ([["display_type", "=", "product"]], ["display_type", "name", "quantity", "product_uom_id", "price_unit", "discount", "tax_ids", "price_subtotal"]),
        "stock.picking": ([["state", "=", "done"]], ["name", "state", "picking_type_code", "partner_id", "scheduled_date", "date_done", "origin", "location_id", "location_dest_id", "note"]),
        "stock.move": ([["picking_id", "!=", False]], ["product_id", "description_picking", "product_uom_qty", "quantity", "product_uom"]),
        "stock.move.line": ([["lot_id", "!=", False]], ["move_id", "lot_id", "quantity"]),
        "account.payment": ([["state", "in", ["paid", "in_process"]]], ["name", "state", "payment_type", "partner_id", "amount", "currency_id", "date", "journal_id", "payment_method_line_id", "memo", "reconciled_invoice_ids", "reconciled_bill_ids"]),
        "purchase.request": ([], ["name", "state", "requested_by", "assigned_to", "date_start", "origin", "description"]),
        "purchase.request.line": ([], ["name", "product_id", "product_qty", "product_uom_id", "date_required", "estimated_cost"]),
        "pos.order": ([], ["name", "pos_reference", "state", "session_id", "config_id", "date_order", "partner_id", "user_id", "amount_total", "amount_tax", "currency_id", "lines", "payment_ids"]),
        "pos.order.line": ([], ["full_product_name", "qty", "price_unit", "discount", "tax_ids", "price_subtotal", "price_subtotal_incl"]),
        "pos.payment": ([], ["payment_method_id", "amount", "is_change"]),
        "mrp.production": ([], ["name", "state", "product_id", "product_qty", "product_uom_id", "bom_id", "origin", "user_id", "date_start", "date_finished", "date_deadline", "picking_type_id", "location_src_id", "location_dest_id", "move_raw_ids", "workorder_ids"]),
        "mrp.workorder": ([], ["name", "workcenter_id", "duration_expected", "state", "date_start", "date_finished"]),
        "res.company": ([], ["name", "street", "street2", "city", "zip", "state_id", "country_id", "phone", "email", "website", "vat", "company_registry", "report_header", "report_footer", "logo", "uses_default_logo"]),
        "res.partner": ([], ["name", "street", "street2", "city", "zip", "state_id", "country_id", "vat", "phone", "email"]),
    }
    for model, (domain, fields) in docs.items():
        rows = api.call(model, "search_read", domain=domain, fields=fields, limit=1, order="id desc")
        check(rows and set(fields) <= set(rows[0]), f"{model}: {len(fields)} field cetak terbaca")


def check_auditlog(api):
    """Audit Log: aturan diaktifkan lewat set_to_confirmed, perubahan lewat JSON-2 tercatat dengan nilai lama dan baru, dan aturan bisa dinonaktifkan."""
    step("Audit Log (auditlog)")
    tag = datetime.datetime.now().strftime("%H%M%S")
    [model] = api.search("ir.model", [["model", "=", "res.partner"]], ["id"])
    rule = api.search("auditlog.rule", [["model_id", "=", model["id"]]], ["state"])
    if rule:
        rule_id, was = rule[0]["id"], rule[0]["state"]
    else:
        [rule_id] = api.call("auditlog.rule", "create", vals_list=[{"name": "Audit Kontak", "model_id": model["id"], "log_create": True, "log_write": True, "log_unlink": True, "log_type": "full"}])
        was = "draft"
    api.call("auditlog.rule", "set_to_confirmed", ids=[rule_id])
    check(api.read("auditlog.rule", rule_id, ["state"])["state"] == "confirmed", "aturan audit aktif lewat set_to_confirmed")

    [pid] = api.call("res.partner", "create", vals_list=[{"name": f"Audit Regresi {tag}"}])
    api.call("res.partner", "write", ids=[pid], vals={"name": f"Audit Regresi {tag} B", "phone": f"021-{tag}"})
    logs = api.search("auditlog.log", [["model_id", "=", model["id"]], ["res_id", "=", pid]], ["method", "user_id", "line_ids"], order="id")
    check([entry["method"] for entry in logs] == ["create", "write"] and all(entry["user_id"] for entry in logs), "buat dan ubah kontak tercatat dengan penggunanya")
    lines = api.search("auditlog.log.line", [["log_id", "=", logs[1]["id"]]], ["field_name", "old_value_text", "new_value_text"])
    by_field = {line["field_name"]: line for line in lines}
    check(by_field["name"]["old_value_text"] == f"Audit Regresi {tag}" and by_field["name"]["new_value_text"] == f"Audit Regresi {tag} B", "rincian ubah memuat nilai lama dan baru nama")
    check(not by_field["phone"]["old_value_text"] and by_field["phone"]["new_value_text"] == f"021-{tag}", "rincian ubah memuat telepon dari kosong menjadi terisi")
    api.call("res.partner", "unlink", ids=[pid])
    check(api.search("auditlog.log", [["model_id", "=", model["id"]], ["res_id", "=", pid], ["method", "=", "unlink"]], ["id"]), "penghapusan kontak tercatat")

    cron = api.call("ir.cron", "search_read", domain=[["model_id.model", "=", "auditlog.autovacuum"]], fields=["active"], context={"active_test": False})
    check(len(cron) == 1, "cron penghapusan log lama tersedia")
    if was == "draft":
        api.call("auditlog.rule", "set_to_draft", ids=[rule_id])
        check(api.read("auditlog.rule", rule_id, ["state"])["state"] == "draft", "aturan audit bisa dinonaktifkan lewat set_to_draft")


def budget_report(api, plan_id, template, date_from, date_to, analytic_id=None, moves="posted", drill=()):
    """Laporan anggaran vs realisasi lewat instance MIS sementara (seperti ui/live/pages/budgetreport.js).

    Mengembalikan ({label atau kode akun: (anggaran, realisasi)}, {(kode akun, kolom): hasil drilldown}).
    """
    [key] = api.search("ir.model.data", [["module", "=", "nusara_base"], ["name", "=", template]], ["res_id"], limit=1)
    [instance] = api.call("mis.report.instance", "create", vals_list=[{
        "name": "Anggaran vs Realisasi (regresi)", "report_id": key["res_id"], "temporary": True, "target_move": moves,
        "analytic_domain": json.dumps([["analytic_distribution", "in", [analytic_id]]]) if analytic_id else "[]",
        "period_ids": [
            [0, 0, {"name": "Anggaran", "sequence": 1, "mode": "fix", "manual_date_from": date_from, "manual_date_to": date_to, "source": "mis_budget_by_account", "source_mis_budget_by_account_id": plan_id}],
            [0, 0, {"name": "Realisasi", "sequence": 2, "mode": "fix", "manual_date_from": date_from, "manual_date_to": date_to}],
        ],
    }])
    values, drills = {}, {}
    try:
        result = api.call("mis.report.instance", "compute", ids=[instance])
        for row in result["body"]:
            head = row["label"].split(" ")[0]
            values[head if head.isdigit() else row["label"]] = tuple(cell.get("val") or 0.0 for cell in row["cells"])
            for code, column in drill:
                cell = row["cells"][column]
                if head == code and cell.get("drilldown_arg"):
                    drills[(code, column)] = api.call("mis.report.instance", "drilldown", ids=[instance], arg=cell["drilldown_arg"])
    finally:
        api.call("mis.report.instance", "unlink", ids=[instance])
    return values, drills


def check_budget(api):
    """Anggaran per akun (OCA mis_builder_budget, D31): rencana, baris, status, dan anggaran vs realisasi dari jurnal nyata."""
    step("Budget: rencana anggaran, baris, status, dan anggaran vs realisasi")
    tag = datetime.datetime.now().strftime("%H%M%S")
    year = datetime.date.today().year
    first, last = f"{year}-01-01", f"{year}-12-31"

    def month_range(month):
        start = datetime.date(year, month, 1)
        end = (datetime.date(year + month // 12, month % 12 + 1, 1) - datetime.timedelta(days=1))
        return start.isoformat(), end.isoformat()

    codes = {row["code"]: row["id"] for row in api.search("account.account", [["code", "in", ["41000010", "63110080", "11120001"]]], ["code"])}
    revenue, expense, bank = codes["41000010"], codes["63110080"], codes["11120001"]
    analytic_plan = (api.search("account.analytic.plan", [], ["id"], limit=1) or [{"id": api.call("account.analytic.plan", "create", vals_list=[{"name": "Proyek Regresi"}])[0]}])[0]["id"]
    [analytic, other] = api.call("account.analytic.account", "create", vals_list=[
        {"name": f"Proyek Anggaran {tag}", "plan_id": analytic_plan}, {"name": f"Proyek Lain {tag}", "plan_id": analytic_plan},
    ])
    dist = {str(analytic): 100}

    # Rencana (Budget Plan Master) dan baris anggaran bulanan seperti dialog Tambah Baris di UI.
    [plan] = api.call("mis.budget.by.account", "create", vals_list=[{"name": f"Anggaran Regresi {tag}", "date_from": first, "date_to": last}])
    record = api.read("mis.budget.by.account", plan, ["state", "active", "company_id", "item_ids"])
    check(record["state"] == "draft" and record["active"] and not record["item_ids"], "rencana anggaran baru berstatus draft, aktif, dan kosong")
    company = record["company_id"][0] if record["company_id"] else 1
    items = []
    for month in range(1, 13):
        start, end = month_range(month)
        base = {"budget_id": plan, "company_id": company, "date_from": start, "date_to": end, "analytic_distribution": dist}
        items.append({**base, "account_id": revenue, "credit": 1_000_000.0})
        items.append({**base, "account_id": expense, "debit": 300_000.0})
    api.call("mis.budget.by.account.item", "create", vals_list=items)
    rows = api.search("mis.budget.by.account.item", [["budget_id", "=", plan]], ["account_id", "debit", "credit", "balance", "date_from", "date_to", "analytic_distribution"], order="date_from, id")
    check(len(rows) == 24 and len(api.read("mis.budget.by.account", plan, ["item_ids"])["item_ids"]) == 24, "24 baris anggaran (pendapatan dan listrik, 12 bulan) tersimpan")
    check(sum(r["credit"] for r in rows) == 12_000_000.0 and sum(r["debit"] for r in rows) == 3_600_000.0, "pendapatan tersimpan sebagai kredit 12.000.000 dan biaya sebagai debit 3.600.000")
    check(all(r["analytic_distribution"] == dist for r in rows) and rows[0]["balance"] in (-1_000_000.0, 300_000.0), "baris membawa distribusi analitik dan saldo bertanda (kredit negatif)")
    totals = api.call("mis.budget.by.account.item", "formatted_read_group", domain=[["budget_id", "in", [plan]]], groupby=["budget_id", "account_id"], aggregates=["balance:sum", "__count"])
    by_account = {g["account_id"][0]: (g["balance:sum"], g["__count"]) for g in totals}
    check(by_account == {revenue: (-12_000_000.0, 12), expense: (3_600_000.0, 12)}, "total per akun (daftar Budget) cocok: pendapatan 12 baris, biaya 12 baris")

    # Aturan tumpang tindih: satu akun hanya boleh punya satu angka per periode kecuali rencana mengizinkan.
    [tight] = api.call("mis.budget.by.account", "create", vals_list=[{"name": f"Tanpa Tumpang Tindih {tag}", "date_from": first, "date_to": last}])
    one = {"budget_id": tight, "company_id": company, "account_id": expense, "date_from": first, "date_to": month_range(1)[1], "debit": 100.0}
    api.call("mis.budget.by.account.item", "create", vals_list=[one])
    try:
        api.call("mis.budget.by.account.item", "create", vals_list=[{**one, "date_from": f"{year}-01-15", "date_to": f"{year}-02-15"}])
        rejected = False
    except RuntimeError:
        rejected = True
    check(rejected, "baris yang tumpang tindih pada akun yang sama ditolak Odoo")
    api.call("mis.budget.by.account", "write", ids=[tight], vals={"allow_items_overlap": True})
    api.call("mis.budget.by.account.item", "create", vals_list=[{**one, "date_from": f"{year}-01-15", "date_to": f"{year}-02-15"}])
    check(api.call("mis.budget.by.account.item", "search_count", domain=[["budget_id", "=", tight]]) == 2, "dengan izin tumpang tindih, baris kedua diterima")
    try:
        api.call("mis.budget.by.account.item", "create", vals_list=[{**one, "date_from": f"{year - 1}-12-01", "date_to": f"{year - 1}-12-31"}])
        outside = False
    except RuntimeError:
        outside = True
    check(outside, "baris di luar periode rencana ditolak Odoo")

    # Ubah satu baris (sisi dan jumlah ditulis bersamaan) dan hapus satu baris, seperti Ubah dan Hapus di UI.
    january_expense = next(r["id"] for r in rows if r["account_id"][0] == expense and r["date_from"] == first)
    api.call("mis.budget.by.account.item", "write", ids=[january_expense], vals={"debit": 400_000.0, "credit": 0.0})
    check(api.read("mis.budget.by.account.item", january_expense, ["debit", "credit", "balance"])["balance"] == 400_000.0, "ubah baris: jumlah dan saldo diperbarui")
    december_revenue = next(r["id"] for r in rows if r["account_id"][0] == revenue and r["date_to"] == last)
    api.call("mis.budget.by.account.item", "unlink", ids=[december_revenue])
    check(api.call("mis.budget.by.account.item", "search_count", domain=[["budget_id", "=", plan]]) == 23, "hapus baris: tersisa 23 baris")

    # Alur status: konfirmasi, kembali ke draft, batal, kembali, konfirmasi.
    for method, expected in (("action_confirm", "confirmed"), ("action_draft", "draft"), ("action_cancel", "cancelled"), ("action_draft", "draft"), ("action_confirm", "confirmed")):
        api.call("mis.budget.by.account", method, ids=[plan])
        check(api.read("mis.budget.by.account", plan, ["state"])["state"] == expected, f"status rencana: {method} menjadi {expected}")

    # Realisasi: jurnal nyata dengan analitik. Pendapatan 1.000.000 (Jan) + 1.500.000 (Feb); listrik 350.000 + 250.000; Maret 800.000 di luar jendela.
    journal = api.search("account.journal", [["type", "=", "general"]], ["id"], limit=1)[0]["id"]

    def entry(date, account, debit, credit, label, post=True):
        [move] = api.call("account.move", "create", vals_list=[{
            "move_type": "entry", "date": date, "journal_id": journal, "ref": f"{label} {tag}",
            "line_ids": [
                [0, 0, {"account_id": account, "debit": debit, "credit": credit, "name": label, "analytic_distribution": dist}],
                [0, 0, {"account_id": bank, "debit": credit, "credit": debit, "name": label}],
            ],
        }])
        if post:
            api.call("account.move", "action_post", ids=[move])
        return move

    entry(f"{year}-01-15", revenue, 0.0, 1_000_000.0, "Penjualan Jan")
    entry(f"{year}-02-10", revenue, 0.0, 1_500_000.0, "Penjualan Feb")
    entry(f"{year}-01-20", expense, 350_000.0, 0.0, "Listrik Jan")
    entry(f"{year}-02-18", expense, 250_000.0, 0.0, "Listrik Feb")
    entry(f"{year}-03-05", revenue, 0.0, 800_000.0, "Penjualan Mar")
    entry(f"{year}-02-20", revenue, 0.0, 777_000.0, "Penjualan draft", post=False)

    # Hitungan terpisah dari mesin MIS: item jurnal per akun, dan anggaran dibagi per hari.
    def actual(code_id, date_from, date_to, posted=True):
        domain = [["analytic_distribution", "in", [analytic]], ["account_id", "=", code_id], ["date", ">=", date_from], ["date", "<=", date_to]]
        if posted:
            domain.append(["parent_state", "=", "posted"])
        return sum(line["balance"] for line in api.search("account.move.line", domain, ["balance"]))

    def prorated(code_id, date_from, date_to):
        total = 0.0
        d_from, d_to = datetime.date.fromisoformat(date_from), datetime.date.fromisoformat(date_to)
        for item in api.search("mis.budget.by.account.item", [["budget_id", "=", plan], ["account_id", "=", code_id]], ["balance", "date_from", "date_to"]):
            start, end = max(datetime.date.fromisoformat(item["date_from"]), d_from), min(datetime.date.fromisoformat(item["date_to"]), d_to)
            if start <= end:
                length = (datetime.date.fromisoformat(item["date_to"]) - datetime.date.fromisoformat(item["date_from"])).days + 1
                total += item["balance"] * ((end - start).days + 1) / length
        return total

    window = (f"{year}-01-01", f"{year}-02-28")
    values, drills = budget_report(api, plan, "mis_anggaran", *window, analytic_id=analytic, drill=[("41000010", 0), ("41000010", 1)])
    check(values["Pendapatan"] == (2_000_000.0, 2_500_000.0) and values["41000010"] == (2_000_000.0, 2_500_000.0), "Jan-Feb: pendapatan anggaran 2.000.000, realisasi 2.500.000 (draft dan Maret tidak dihitung)")
    check(values["Beban"] == (700_000.0, 600_000.0) and values["63110080"] == (700_000.0, 600_000.0), "Jan-Feb: listrik anggaran 700.000 (400.000 + 300.000), realisasi 600.000")
    check(values["LABA (RUGI) BERSIH"] == (1_300_000.0, 1_900_000.0), "Jan-Feb: laba (rugi) anggaran 1.300.000, realisasi 1.900.000")
    check(abs(values["41000010"][1] + actual(revenue, *window)) < 0.01 and abs(values["63110080"][1] - actual(expense, *window)) < 0.01, "realisasi laporan sama dengan jumlah item jurnal terpisah")
    check(abs(values["41000010"][0] + prorated(revenue, *window)) < 0.01 and abs(values["63110080"][0] - prorated(expense, *window)) < 0.01, "anggaran laporan sama dengan hitungan baris anggaran terpisah")
    budget_cost, actual_cost = values["Beban"]
    check(actual_cost - budget_cost == -100_000.0 and abs(actual_cost / budget_cost * 100 - 85.714285) < 0.0001, "selisih (realisasi - anggaran) -100.000 dan pencapaian 85,7% untuk biaya")
    budget_revenue, actual_revenue = values["Pendapatan"]
    check(actual_revenue - budget_revenue == 500_000.0 and actual_revenue / budget_revenue == 1.25, "selisih +500.000 dan pencapaian 125% untuk pendapatan")

    items_drill, lines_drill = drills.get(("41000010", 0)), drills.get(("41000010", 1))
    check(bool(items_drill) and items_drill["res_model"] == "mis.budget.by.account.item", "drilldown sel anggaran menuju baris anggaran")
    if items_drill:
        budget_items = api.search(items_drill["res_model"], items_drill["domain"], ["credit", "debit"])
        check(len(budget_items) == 2 and sum(i["credit"] for i in budget_items) == 2_000_000.0, "drilldown anggaran: 2 baris (Jan dan Feb) berjumlah 2.000.000")
    check(bool(lines_drill) and lines_drill["res_model"] == "account.move.line", "drilldown sel realisasi menuju item jurnal")
    if lines_drill:
        journal_lines = api.search(lines_drill["res_model"], lines_drill["domain"], ["credit", "debit"], context={"active_test": False})
        check(len(journal_lines) == 2 and sum(i["credit"] for i in journal_lines) == 2_500_000.0, "drilldown realisasi: 2 item jurnal berjumlah 2.500.000")

    everything, _ = budget_report(api, plan, "mis_anggaran", *window, analytic_id=analytic, moves="all")
    check(everything["41000010"] == (2_000_000.0, 2_500_000.0 + 777_000.0), "dengan entri draft, realisasi bertambah 777.000 (anggaran tetap)")
    elsewhere, _ = budget_report(api, plan, "mis_anggaran", *window, analytic_id=other)
    check(elsewhere.get("41000010", (0.0, 0.0)) == (0.0, 0.0) and elsewhere.get("63110080", (0.0, 0.0)) == (0.0, 0.0), "filter analitik lain: anggaran dan realisasi akun itu nol")
    unfiltered, _ = budget_report(api, plan, "mis_anggaran", *window)
    check(unfiltered["41000010"][0] == 2_000_000.0 and unfiltered["41000010"][1] >= 2_500_000.0, "tanpa filter analitik: anggaran sama, realisasi mencakup seluruh jurnal")
    half, _ = budget_report(api, plan, "mis_anggaran", f"{year}-01-01", f"{year}-01-15", analytic_id=analytic)
    check(abs(half["41000010"][0] - 1_000_000.0 * 15 / 31) < 0.01, "periode laporan separuh bulan: anggaran dibagi per hari (15/31 dari 1.000.000)")
    full, _ = budget_report(api, plan, "mis_anggaran", first, last, analytic_id=analytic)
    check(full["41000010"] == (11_000_000.0, 3_300_000.0), "setahun: anggaran pendapatan 11.000.000 (11 baris), realisasi 3.300.000 (Jan, Feb, Mar)")
    pnl, _ = budget_report(api, plan, "mis_laba_rugi", *window, analytic_id=analytic)
    check(pnl["Penjualan"] == (2_000_000.0, 2_500_000.0) and pnl["Beban Umum dan Kantor"] == (700_000.0, 600_000.0), "tampilan Laba Rugi: anggaran per akun diturunkan ke baris KPI yang sama")
    check(pnl["LABA BERSIH"] == (1_300_000.0, 1_900_000.0), "tampilan Laba Rugi: laba bersih anggaran dan realisasi sama dengan tampilan per akun")

    # Arsip dan duplikasi.
    copied = api.call("mis.budget.by.account", "copy", ids=[plan])
    copy_id = copied[0] if isinstance(copied, list) else copied
    clone = api.read("mis.budget.by.account", copy_id, ["state", "item_ids", "name"])
    check(clone["state"] == "draft" and len(clone["item_ids"]) == 23, "duplikasi: draft dengan 23 baris yang sama")
    api.call("mis.budget.by.account", "action_archive", ids=[copy_id])
    check(not api.read("mis.budget.by.account", copy_id, ["active"])["active"], "rencana diarsipkan")
    api.call("mis.budget.by.account", "action_unarchive", ids=[copy_id])
    check(api.read("mis.budget.by.account", copy_id, ["active"])["active"], "rencana diaktifkan kembali")
    template = api.search("ir.model.data", [["module", "=", "nusara_base"], ["name", "=", "mis_anggaran"]], ["res_id"])
    kpis = api.search("mis.report.kpi", [["report_id", "=", template[0]["res_id"]]], ["description", "auto_expand_accounts"], order="sequence")
    check([k["description"] for k in kpis] == ["Pendapatan", "Harga Pokok", "Beban", "LABA (RUGI) BERSIH"] and [k["auto_expand_accounts"] for k in kpis] == [True, True, True, False], "template Anggaran per Akun: 4 baris, tiga diperluas per akun (label dipakai UI)")


def canonical_distribution(dist):
    """Bentuk baku distribusi analitik: urutan kunci dan urutan id dalam kunci tidak berarti."""
    return sorted((",".join(sorted(key.split(","), key=int)), float(value)) for key, value in (dist or {}).items())


def check_analytic_lines(api, product, vendor):
    """Akun analitik pada baris transaksi (D39): PO, tagihan, SO, faktur, PR, jurnal manual, dan anggaran terkonfirmasi."""
    step("Analitik pada baris: PO -> tagihan -> jurnal, SO -> faktur, PR, round trip, dan anggaran")
    tag = datetime.datetime.now().strftime("%H%M%S")
    today = datetime.date.today().isoformat()
    uom = product["uom_id"][0]
    plan_a = (api.search("account.analytic.plan", [["parent_id", "=", False]], ["id"], limit=1) or [{"id": api.call("account.analytic.plan", "create", vals_list=[{"name": "Proyek Regresi"}])[0]}])[0]["id"]
    [plan_d] = api.call("account.analytic.plan", "create", vals_list=[{"name": f"Departemen {tag}"}])
    [acc_a, acc_b] = api.call("account.analytic.account", "create", vals_list=[
        {"name": f"Proyek A {tag}", "plan_id": plan_a}, {"name": f"Proyek B {tag}", "plan_id": plan_a},
    ])
    [acc_d] = api.call("account.analytic.account", "create", vals_list=[{"name": f"Dept Produksi {tag}", "plan_id": plan_d}])
    roots = {row["id"]: row["root_plan_id"][0] for row in api.search("account.analytic.account", [["id", "in", [acc_a, acc_b, acc_d]]], ["root_plan_id"])}
    check(roots[acc_a] == plan_a and roots[acc_b] == plan_a and roots[acc_d] == plan_d, "akun analitik terkelompok menurut rencana akar (dua rencana)")
    # Dua baris distribusi: baris pertama menggabungkan akun dari dua rencana (kunci dengan koma), baris kedua satu akun.
    dist = {f"{acc_a},{acc_d}": 60.0, str(acc_b): 40.0}

    def deliver(domain, model_field):
        for picking in api.search("stock.picking", [[model_field, "=", domain], ["state", "not in", ["done", "cancel"]]], ["id"]):
            for move in api.search("stock.move", [["picking_id", "=", picking["id"]]], ["id", "product_uom_qty"]):
                api.call("stock.move", "write", ids=[move["id"]], vals={"quantity": move["product_uom_qty"], "picked": True})
            api.call("stock.picking", "button_validate", ids=[picking["id"]])

    [po_id] = api.call("purchase.order", "create", vals_list=[{
        "partner_id": vendor["id"],
        "order_line": [[0, 0, {"product_id": product["id"], "product_qty": 5.0, "product_uom_id": uom, "name": "Uji analitik", "analytic_distribution": dist}]],
    }])
    line = api.search("purchase.order.line", [["order_id", "=", po_id]], ["id", "analytic_distribution", "price_subtotal"])[0]
    check(canonical_distribution(line["analytic_distribution"]) == canonical_distribution(dist), "baris RFQ menyimpan distribusi dua rencana dan dua baris persen")
    api.call("purchase.order.line", "write", ids=[line["id"]], vals={"analytic_distribution": line["analytic_distribution"]})
    again = api.read("purchase.order.line", line["id"], ["analytic_distribution"])["analytic_distribution"]
    check(canonical_distribution(again) == canonical_distribution(dist), "baca ulang lalu tulis ulang distribusi tidak merusaknya")
    api.call("purchase.order", "button_confirm", ids=[po_id])
    deliver(po_id, "purchase_id")
    api.call("purchase.order", "action_create_invoice", ids=[po_id])
    bill_id = api.read("purchase.order", po_id, ["invoice_ids"])["invoice_ids"][-1]
    bill_line = api.search("account.move.line", [["move_id", "=", bill_id], ["display_type", "=", "product"]], ["id", "analytic_distribution", "price_subtotal"])[0]
    check(canonical_distribution(bill_line["analytic_distribution"]) == canonical_distribution(dist), "distribusi baris PO terbawa ke baris tagihan")
    # Distribusi diubah pada baris tagihan draft (seperti UI), lalu diposting.
    api.call("account.move.line", "write", ids=[bill_line["id"]], vals={"analytic_distribution": {str(acc_a): 50.0, str(acc_b): 50.0}})
    api.call("account.move", "write", ids=[bill_id], vals={"invoice_date": today, "ref": f"ANL-{tag}"})
    api.call("account.move", "action_post", ids=[bill_id])
    total = bill_line["price_subtotal"]
    rows = api.search("account.analytic.line", [["move_line_id.move_id", "=", bill_id]], ["account_id", "amount"])
    by_account = {r["account_id"][0]: r["amount"] for r in rows}
    check(by_account == {acc_a: -total / 2, acc_b: -total / 2}, f"tagihan terposting membuat baris analitik per akun (2 x {total / 2:,.0f}, biaya bertanda negatif)")

    # Distribusi kosong (false, seperti dikosongkan di UI) tersimpan sebagai kosong.
    [po2] = api.call("purchase.order", "create", vals_list=[{
        "partner_id": vendor["id"], "order_line": [[0, 0, {"product_id": product["id"], "product_qty": 1.0, "product_uom_id": uom, "name": "Tanpa analitik", "analytic_distribution": False}]],
    }])
    check(not api.search("purchase.order.line", [["order_id", "=", po2]], ["analytic_distribution"])[0]["analytic_distribution"], "distribusi kosong (false) disimpan sebagai kosong")

    # Sales Order -> faktur: pendapatan terbawa ke akun analitik.
    [customer] = api.call("res.partner", "create", vals_list=[{"name": f"Pelanggan Analitik {tag}", "customer_rank": 1}])
    [so_id] = api.call("sale.order", "create", vals_list=[{
        "partner_id": customer, "order_line": [[0, 0, {"product_id": product["id"], "product_uom_qty": 1.0, "analytic_distribution": {str(acc_a): 100.0}}]],
    }])
    so_line = api.search("sale.order.line", [["order_id", "=", so_id]], ["analytic_distribution"])[0]
    check(canonical_distribution(so_line["analytic_distribution"]) == [(str(acc_a), 100.0)], "baris SO menyimpan distribusi")
    api.call("sale.order", "action_confirm", ids=[so_id])
    deliver(so_id, "sale_id")
    context = {"active_model": "sale.order", "active_ids": [so_id], "active_id": so_id}
    wizard = api.call("sale.advance.payment.inv", "create", vals_list=[{}], context=context)
    invoice_id = api.call("sale.advance.payment.inv", "create_invoices", ids=wizard, context=context)["res_id"]
    inv_line = api.search("account.move.line", [["move_id", "=", invoice_id], ["display_type", "=", "product"]], ["analytic_distribution", "price_subtotal"])[0]
    check(canonical_distribution(inv_line["analytic_distribution"]) == [(str(acc_a), 100.0)], "distribusi baris SO terbawa ke baris faktur")
    api.call("account.move", "action_post", ids=[invoice_id])
    income = api.search("account.analytic.line", [["move_line_id.move_id", "=", invoice_id], ["general_account_id.account_type", "in", ["income", "income_other"]]], ["account_id", "amount"])
    check([(r["account_id"][0], r["amount"]) for r in income] == [(acc_a, inv_line["price_subtotal"])], f"faktur terposting: pendapatan {inv_line['price_subtotal']:,.0f} masuk baris analitik akun A (bertanda positif)")

    # Purchase Request: distribusi disimpan pada baris dan dapat diubah.
    [pr_id] = api.call("purchase.request", "create", vals_list=[{
        "description": f"PR analitik {tag}",
        "line_ids": [[0, 0, {"product_id": product["id"], "product_uom_id": uom, "product_qty": 2.0, "name": "Baris PR", "analytic_distribution": {str(acc_b): 100.0}}]],
    }])
    pr_line = api.search("purchase.request.line", [["request_id", "=", pr_id]], ["id", "analytic_distribution"])[0]
    check(canonical_distribution(pr_line["analytic_distribution"]) == [(str(acc_b), 100.0)], "baris Purchase Request menyimpan distribusi")
    api.call("purchase.request.line", "write", ids=[pr_line["id"]], vals={"analytic_distribution": dist})
    check(canonical_distribution(api.read("purchase.request.line", pr_line["id"], ["analytic_distribution"])["analytic_distribution"]) == canonical_distribution(dist), "distribusi baris PR dapat diubah ke dua rencana")

    # Jurnal manual dan anggaran terkonfirmasi: realisasi dari baris analitik, sama dengan yang ditampilkan dialog UI.
    year = datetime.date.today().year
    codes = {row["code"]: row["id"] for row in api.search("account.account", [["code", "in", ["63110080", "11120001"]]], ["code"])}
    journal = api.search("account.journal", [["type", "=", "general"]], ["id"], limit=1)[0]["id"]
    [move_id] = api.call("account.move", "create", vals_list=[{
        "move_type": "entry", "journal_id": journal, "date": today,
        "line_ids": [
            [0, 0, {"account_id": codes["63110080"], "name": "Beban uji analitik", "debit": 250_000.0, "analytic_distribution": {f"{acc_a},{acc_d}": 100.0}}],
            [0, 0, {"account_id": codes["11120001"], "name": "Kas uji analitik", "credit": 250_000.0}],
        ],
    }])
    api.call("account.move", "action_post", ids=[move_id])
    manual = api.search("account.analytic.line", [["move_line_id.move_id", "=", move_id]], ["account_id", "amount"])
    check([(r["account_id"][0], r["amount"]) for r in manual] == [(acc_a, -250_000.0)], "jurnal manual: kunci gabungan dua rencana menjadi satu baris analitik (akun rencana utama)")
    [plan] = api.call("mis.budget.by.account", "create", vals_list=[{"name": f"Anggaran Analitik {tag}", "date_from": f"{year}-01-01", "date_to": f"{year}-12-31"}])
    company = api.read("mis.budget.by.account", plan, ["company_id"])["company_id"][0]
    base = {"budget_id": plan, "company_id": company, "account_id": codes["63110080"]}
    api.call("mis.budget.by.account.item", "create", vals_list=[
        {**base, "date_from": f"{year}-01-01", "date_to": f"{year}-06-30", "debit": 1_000_000.0, "analytic_distribution": {str(acc_a): 100.0}},
        {**base, "date_from": f"{year}-07-01", "date_to": f"{year}-12-31", "debit": 400_000.0, "analytic_distribution": {f"{acc_a},{acc_d}": 100.0}},
    ])
    confirmed = [["budget_id.state", "=", "confirmed"], ["budget_id", "=", plan]]
    check(not api.search("mis.budget.by.account.item", [["analytic_distribution", "in", [acc_a]], *confirmed], ["id"]), "rencana draft tidak dihitung sebagai anggaran terkonfirmasi")
    api.call("mis.budget.by.account", "action_confirm", ids=[plan])
    hit_a = api.search("mis.budget.by.account.item", [["analytic_distribution", "in", [acc_a]], *confirmed], ["debit"])
    hit_d = api.search("mis.budget.by.account.item", [["analytic_distribution", "in", [acc_d]], *confirmed], ["debit"])
    check(sum(r["debit"] for r in hit_a) == 1_400_000.0 and sum(r["debit"] for r in hit_d) == 400_000.0, "anggaran terkonfirmasi ditemukan per akun, termasuk kunci gabungan (A: 1.400.000, D: 400.000)")
    actual = api.call("account.analytic.line", "formatted_read_group", domain=[["account_id", "=", acc_a], ["general_account_id", "in", [codes["63110080"]]], ["date", ">=", f"{year}-01-01"], ["date", "<=", f"{year}-12-31"]], groupby=[], aggregates=["amount:sum"])[0]
    check(-actual["amount:sum"] == 250_000.0, "realisasi dari baris analitik akun A pada akun anggaran = 250.000 (sisa 1.150.000)")


def check_line_taxes(api, product, vendor):
    """Pajak baris yang dipilih manual dan lebih dari satu (D40): PO -> tagihan -> jurnal, SO -> faktur, ubah pajak pada baris draf."""
    step("Pajak baris manual multi: PO dua pajak -> tagihan -> jurnal, SO -> faktur, ubah pajak baris draf")
    tag = datetime.datetime.now().strftime("%H%M%S")
    today = datetime.date.today().isoformat()
    uom = product["uom_id"][0]

    def mk_tax(name, amount, use):
        return api.call("account.tax", "create", vals_list=[{"name": f"{name} {tag}", "amount": amount, "amount_type": "percent", "type_tax_use": use}])[0]

    p_ppn, p_pph = mk_tax("PPN Masukan Uji", 11.0, "purchase"), mk_tax("PPh 23 Uji", -2.0, "purchase")
    s_ppn, s_other = mk_tax("PPN Keluaran Uji", 11.0, "sale"), mk_tax("PPN Khusus Uji", 12.0, "sale")
    listed = {r["id"] for r in api.search("account.tax", [["type_tax_use", "=", "purchase"], ["active", "=", True], ["id", "in", [p_ppn, p_pph, s_ppn]]], ["id"])}
    check(listed == {p_ppn, p_pph}, "daftar pajak difilter menurut jenis dokumen (purchase tidak memuat pajak sale)")

    def balanced(move_id):
        rows = api.search("account.move.line", [["move_id", "=", move_id]], ["debit", "credit", "tax_line_id", "display_type"])
        return abs(sum(r["debit"] for r in rows) - sum(r["credit"] for r in rows)) < 0.005, [r for r in rows if r["tax_line_id"]]

    def deliver(model_field, doc_id):
        for picking in api.search("stock.picking", [[model_field, "=", doc_id], ["state", "not in", ["done", "cancel"]]], ["id"]):
            for move in api.search("stock.move", [["picking_id", "=", picking["id"]]], ["id", "product_uom_qty"]):
                api.call("stock.move", "write", ids=[move["id"]], vals={"quantity": move["product_uom_qty"], "picked": True})
            api.call("stock.picking", "button_validate", ids=[picking["id"]])

    # PO: dua pajak (PPN dan PPh negatif) pada satu baris.
    [po_id] = api.call("purchase.order", "create", vals_list=[{
        "partner_id": vendor["id"],
        "order_line": [[0, 0, {"product_id": product["id"], "product_qty": 5.0, "product_uom_id": uom, "name": "Uji pajak", "price_unit": 100_000.0, "tax_ids": [[6, 0, [p_ppn, p_pph]]]}]],
    }])
    line = api.search("purchase.order.line", [["order_id", "=", po_id]], ["id", "tax_ids", "price_subtotal"])[0]
    check(sorted(line["tax_ids"]) == sorted([p_ppn, p_pph]), "baris PO menyimpan dua pajak manual")
    po = api.read("purchase.order", po_id, ["amount_untaxed", "amount_tax", "amount_total"])
    expect = round(line["price_subtotal"] * 0.09, 2)
    check(abs(po["amount_tax"] - expect) < 0.01 and abs(po["amount_total"] - (po["amount_untaxed"] + expect)) < 0.01, f"PO: amount_tax = 11% - 2% dari {line['price_subtotal']:,.0f} = {expect:,.0f}")
    # Mengubah jumlah tidak menimpa pilihan pajak manual.
    api.call("purchase.order.line", "write", ids=[line["id"]], vals={"product_qty": 6.0})
    check(sorted(api.read("purchase.order.line", line["id"], ["tax_ids"])["tax_ids"]) == sorted([p_ppn, p_pph]), "mengubah jumlah tidak menimpa pajak manual")
    api.call("purchase.order", "button_confirm", ids=[po_id])
    deliver("purchase_id", po_id)
    api.call("purchase.order", "action_create_invoice", ids=[po_id])
    bill_id = api.read("purchase.order", po_id, ["invoice_ids"])["invoice_ids"][-1]
    bill_line = api.search("account.move.line", [["move_id", "=", bill_id], ["display_type", "=", "product"]], ["id", "tax_ids", "price_subtotal"])[0]
    check(sorted(bill_line["tax_ids"]) == sorted([p_ppn, p_pph]), "tagihan dari PO membawa kedua pajak")
    sub = bill_line["price_subtotal"]
    bill = api.read("account.move", bill_id, ["amount_tax"])
    check(abs(bill["amount_tax"] - round(sub * 0.09, 2)) < 0.01, f"tagihan: amount_tax {bill['amount_tax']:,.0f} = 9% dari {sub:,.0f}")
    # Pajak baris tagihan draf diganti (hanya PPN): baris pajak jurnal dibuat ulang dengan benar.
    api.call("account.move.line", "write", ids=[bill_line["id"]], vals={"tax_ids": [[6, 0, [p_ppn]]]})
    bill = api.read("account.move", bill_id, ["amount_tax"])
    ok, tax_rows = balanced(bill_id)
    check(abs(bill["amount_tax"] - round(sub * 0.11, 2)) < 0.01 and {r["tax_line_id"][0] for r in tax_rows} == {p_ppn}, "ubah pajak baris tagihan draf: hanya baris pajak PPN yang tersisa, amount_tax = 11%")
    api.call("account.move.line", "write", ids=[bill_line["id"]], vals={"tax_ids": [[6, 0, [p_ppn, p_pph]]]})
    api.call("account.move", "write", ids=[bill_id], vals={"invoice_date": today, "ref": f"TAX-{tag}"})
    api.call("account.move", "action_post", ids=[bill_id])
    ok, tax_rows = balanced(bill_id)
    check(ok and {r["tax_line_id"][0] for r in tax_rows} == {p_ppn, p_pph}, "tagihan terposting seimbang dan memuat baris pajak untuk kedua pajak")

    # Catatan: Odoo tidak menolak pajak berjenis salah di baris (diuji: tagihan terposting); pencegahannya ada di pemilih UI yang memfilter type_tax_use.

    # SO: pajak bawaan produk diganti manual (dua pajak jual), faktur membawa hal yang sama.
    [customer] = api.call("res.partner", "create", vals_list=[{"name": f"Pelanggan Pajak {tag}", "customer_rank": 1}])
    [so_id] = api.call("sale.order", "create", vals_list=[{
        "partner_id": customer,
        "order_line": [[0, 0, {"product_id": product["id"], "product_uom_qty": 2.0, "price_unit": 50_000.0, "tax_ids": [[6, 0, [s_ppn, s_other]]]}]],
    }])
    so_line = api.search("sale.order.line", [["order_id", "=", so_id]], ["id", "tax_ids", "price_subtotal"])[0]
    check(sorted(so_line["tax_ids"]) == sorted([s_ppn, s_other]), "baris SO menyimpan dua pajak manual")
    so = api.read("sale.order", so_id, ["amount_tax"])
    check(abs(so["amount_tax"] - round(so_line["price_subtotal"] * 0.23, 2)) < 0.01, f"SO: amount_tax = 23% dari {so_line['price_subtotal']:,.0f}")
    api.call("sale.order", "action_confirm", ids=[so_id])
    deliver("sale_id", so_id)
    context = {"active_model": "sale.order", "active_ids": [so_id], "active_id": so_id}
    wizard = api.call("sale.advance.payment.inv", "create", vals_list=[{}], context=context)
    invoice_id = api.call("sale.advance.payment.inv", "create_invoices", ids=wizard, context=context)["res_id"]
    inv_line = api.search("account.move.line", [["move_id", "=", invoice_id], ["display_type", "=", "product"]], ["id", "tax_ids", "price_subtotal"])[0]
    check(sorted(inv_line["tax_ids"]) == sorted([s_ppn, s_other]), "faktur dari SO membawa pajak manual yang sama")
    api.call("account.move.line", "write", ids=[inv_line["id"]], vals={"tax_ids": [[6, 0, [s_other]]]})
    inv = api.read("account.move", invoice_id, ["amount_tax"])
    check(abs(inv["amount_tax"] - round(inv_line["price_subtotal"] * 0.12, 2)) < 0.01, "ubah pajak baris faktur draf: amount_tax = 12%")
    api.call("account.move", "action_post", ids=[invoice_id])
    ok, tax_rows = balanced(invoice_id)
    check(ok and {r["tax_line_id"][0] for r in tax_rows} == {s_other}, "faktur terposting seimbang dengan baris pajak yang tepat")


def fails_with(call, *needles):
    """True bila panggilan API gagal dan pesannya memuat salah satu kata kunci (huruf kecil)."""
    try:
        call()
    except RuntimeError as error:
        return any(needle.lower() in str(error).lower() for needle in needles)
    return False


def check_loyalty(api, product):
    """Promotion & Loyalty (D30): program dan aturan, kode promo dan hadiah di Sales Order lewat wizard publik, promosi otomatis, kupon, kartu loyalti, dan kasir POS."""
    step("Promotion & Loyalty: program, kode promo, hadiah di Sales Order, kupon, kartu loyalti, kasir POS")
    tag = datetime.datetime.now().strftime("%H%M%S")
    created = []  # program yang dibuat; diarsipkan di akhir agar pemeriksaan lain tidak terpengaruh promosi otomatis
    info = api.read("product.product", product["id"], ["lst_price", "taxes_id", "product_tmpl_id"])
    unit = info["lst_price"]
    [customer] = api.call("res.partner", "create", vals_list=[{"name": f"Pelanggan Promo {tag}", "is_company": True, "customer_rank": 1}])

    def defaults(program_type):
        fields = ["program_type", "applies_on", "trigger", "portal_visible", "portal_point_name"]
        return api.call("loyalty.program", "default_get", fields=fields, context={"default_program_type": program_type})

    def new_program(name, program_type, rules, rewards, **extra):
        base = {key: value for key, value in defaults(program_type).items() if key in ("trigger", "applies_on", "portal_visible", "portal_point_name")}
        vals = {"name": f"{name} {tag}", "program_type": program_type, "sale_ok": True, "pos_ok": False, **base, **extra,
                "rule_ids": [[0, 0, r] for r in rules], "reward_ids": [[0, 0, r] for r in rewards]}
        [program_id] = api.call("loyalty.program", "create", vals_list=[vals])
        created.append(program_id)
        return program_id

    def order(qty, partner=customer):
        [so] = api.call("sale.order", "create", vals_list=[{"partner_id": partner, "order_line": [[0, 0, {"product_id": product["id"], "product_uom_qty": qty}]]}])
        return so

    def context(so):
        return {"active_model": "sale.order", "active_ids": [so], "active_id": so}

    def apply_code(so, code):
        wizard = api.call("sale.loyalty.coupon.wizard", "create", vals_list=[{"order_id": so, "coupon_code": code}], context=context(so))
        return api.call("sale.loyalty.coupon.wizard", "action_apply", ids=wizard, context=context(so))

    def claimable(so):
        wizard = api.call("sale.loyalty.reward.wizard", "create", vals_list=[{"order_id": so}], context=context(so))
        return api.call("sale.loyalty.reward.wizard", "read", ids=wizard, fields=["reward_ids"], context=context(so))[0]["reward_ids"]

    def claim(so, reward):
        wizard = api.call("sale.loyalty.reward.wizard", "create", vals_list=[{"order_id": so, "selected_reward_id": reward}], context=context(so))
        return api.call("sale.loyalty.reward.wizard", "action_apply", ids=wizard, context=context(so))

    def reward_lines(so):
        return api.search("sale.order.line", [["order_id", "=", so], ["reward_id", "!=", False]], ["name", "price_unit", "price_subtotal", "product_uom_qty", "discount", "points_cost", "reward_id", "coupon_id"])

    def total(so):
        return api.read("sale.order", so, ["amount_untaxed", "amount_total", "state", "reward_amount"])

    def balanced(move_id):
        return balanced_move(api, move_id)

    def invoice_of(so):
        api.call("sale.order", "action_confirm", ids=[so])
        wizard = api.call("sale.advance.payment.inv", "create", vals_list=[{}], context=context(so))
        invoice_id = api.call("sale.advance.payment.inv", "create_invoices", ids=wizard, context=context(so))["res_id"]
        api.call("account.move", "action_post", ids=[invoice_id])
        return invoice_id

    # Nilai bawaan tipe program dari default_get (UI memakainya untuk mengisi form baru).
    check(defaults("promo_code")["trigger"] == "with_code" and defaults("promotion")["trigger"] == "auto", "default_get memberi pemicu menurut tipe program (kode promo: dengan kode, promosi: otomatis)")
    check(defaults("loyalty")["applies_on"] == "both" and defaults("next_order_coupons")["applies_on"] == "future", "default_get memberi masa berlaku poin menurut tipe (kartu loyalti: kedua, kupon berikutnya: mendatang)")
    check("trigger" not in api.call("loyalty.program", "default_get", fields=["applies_on", "trigger"], context={"default_program_type": "promo_code"}), "default_get tanpa program_type di daftar field tidak mengisi nilai bawaan tipe (UI memintanya)")
    bare = api.call("loyalty.program", "create", vals_list=[{
        "name": f"Tanpa pemicu {tag}", "program_type": "promo_code", "sale_ok": False, "pos_ok": False,
        "rule_ids": [[0, 0, {"mode": "with_code", "code": f"TANPA{tag}", "minimum_qty": 0}]], "reward_ids": [[0, 0, {"discount": 10, "discount_mode": "percent"}]],
    }])[0]
    created.append(bare)
    check(api.read("loyalty.program", bare, ["trigger"])["trigger"] is False, "program via API tanpa trigger eksplisit tidak punya trigger (UI mengirim nilai bawaan tipe)")

    # Kode promo: kode memicu aturan, hadiah dipilih lewat wizard hadiah.
    code = f"HEMAT{tag}"
    promo = new_program("Kode Hemat", "promo_code", [{"mode": "with_code", "code": code, "minimum_qty": 0}],
                        [{"reward_type": "discount", "discount_mode": "percent", "discount": 10, "discount_applicability": "order", "required_points": 1, "description": "10% untuk seluruh pesanan"}])
    check(api.read("loyalty.program", promo, ["trigger", "sale_ok", "pos_ok"]) == {"id": promo, "trigger": "with_code", "sale_ok": True, "pos_ok": False}, "program kode promo tersimpan dengan pemicu dan tempat berlaku")
    reward = api.search("loyalty.reward", [["program_id", "=", promo]], ["description", "discount_line_product_id"])[0]
    check(reward["description"] == "10% untuk seluruh pesanan" and bool(reward["discount_line_product_id"]), "hadiah punya deskripsi Indonesia dan produk baris diskon")
    so = order(2.0)
    check(fails_with(lambda: apply_code(so, "TIDAKADA"), "invalid"), "kode yang tidak ada ditolak (This code is invalid)")
    action = apply_code(so, code)
    check(action["res_model"] == "sale.loyalty.reward.wizard" and action["context"]["default_reward_ids"] == [reward["id"]], "kode promo membuka wizard hadiah dengan hadiah programnya")
    check(not reward_lines(so) and claimable(so) == [reward["id"]], "kode saja belum menambah baris; hadiah bisa diklaim")
    check(claim(so, reward["id"]) is True, "hadiah diterapkan lewat wizard hadiah")
    lines = reward_lines(so)
    check(len(lines) == 1 and abs(lines[0]["price_unit"] + unit * 2 * 0.1) < 0.01 and lines[0]["points_cost"] == 1.0, f"baris hadiah diskon 10% bernilai {unit * 2 * 0.1:,.0f}")
    check(abs(total(so)["amount_untaxed"] - unit * 2 * 0.9) < 0.01 and abs(total(so)["reward_amount"] + unit * 2 * 0.1) < 0.01, "total SO turun sebesar diskon")
    check(fails_with(lambda: apply_code(so, code), "already applied"), "kode yang sama dua kali pada satu pesanan ditolak")
    invoice = invoice_of(so)
    inv = api.read("account.move", invoice, ["amount_total", "amount_untaxed", "state"])
    check(inv["state"] == "posted" and inv["amount_total"] == total(so)["amount_total"] and balanced(invoice), "faktur dari SO berhadiah terposting, totalnya sama dengan SO, dan jurnalnya seimbang")
    check(api.read("loyalty.program", promo, ["order_count", "total_order_count"]) == {"id": promo, "order_count": 1, "total_order_count": 1}, "pemakaian program terhitung dari baris hadiah")

    # Ubah program: aturan, hadiah (deskripsi ditulis sebagai langkah kedua), lalu arsipkan.
    rule_id = api.search("loyalty.rule", [["program_id", "=", promo]], ["id"])[0]["id"]
    api.call("loyalty.program", "write", ids=[promo], vals={"rule_ids": [[1, rule_id, {"minimum_amount": 500_000.0}]], "reward_ids": [[1, reward["id"], {"discount": 20.0}]]})
    api.call("loyalty.reward", "write", ids=[reward["id"]], vals={"description": "20% untuk seluruh pesanan"})
    edited = api.read("loyalty.reward", reward["id"], ["discount", "description"])
    check(edited["discount"] == 20.0 and edited["description"] == "20% untuk seluruh pesanan", "hadiah diubah dan deskripsi Indonesia bertahan (ditulis sebagai langkah kedua)")
    so = order(1.0)
    check(fails_with(lambda: apply_code(so, code), "minimum", "eligible"), "syarat belanja minimum aturan diperiksa saat kode dipakai")
    api.call("loyalty.program", "action_archive", ids=[promo])
    check(api.read("loyalty.program", promo, ["active"])["active"] is False, "program diarsipkan")
    check(fails_with(lambda: apply_code(order(2.0), code), "invalid"), "kode program yang diarsipkan tidak berlaku lagi")
    api.call("loyalty.program", "action_unarchive", ids=[promo])
    check(api.read("loyalty.program", promo, ["active"])["active"] is True, "program yang diarsipkan bisa diaktifkan kembali")

    # Promosi otomatis mengikuti isi pesanan; tombol Hadiah memperbarui.
    auto = new_program("Otomatis 15", "promotion", [{"reward_point_mode": "order", "reward_point_amount": 1, "minimum_amount": unit * 1.5, "minimum_amount_tax_mode": "excl", "minimum_qty": 0}],
                       [{"reward_type": "discount", "discount_mode": "percent", "discount": 15, "discount_applicability": "order", "required_points": 1}])
    so = order(2.0)
    check(not reward_lines(so), "promosi otomatis tidak terpasang sebelum tombol Hadiah ditekan")
    check(api.call("sale.order", "action_open_reward_wizard", ids=[so]) is True and len(reward_lines(so)) == 1, "tombol Hadiah memasang satu promosi otomatis tanpa dialog")
    check(abs(reward_lines(so)[0]["price_unit"] + unit * 2 * 0.15) < 0.01, "diskon otomatis 15% dihitung atas pesanan")
    api.call("sale.order.line", "write", ids=[row["id"] for row in api.search("sale.order.line", [["order_id", "=", so], ["reward_id", "=", False]], ["id"])], vals={"product_uom_qty": 1.0})
    api.call("sale.order", "action_open_reward_wizard", ids=[so])
    check(not reward_lines(so), "jumlah dikurangi di bawah syarat: pembaruan menghapus hadiah otomatis")
    api.call("sale.order.line", "write", ids=[row["id"] for row in api.search("sale.order.line", [["order_id", "=", so], ["reward_id", "=", False]], ["id"])], vals={"product_uom_qty": 3.0})
    api.call("sale.order", "action_open_reward_wizard", ids=[so])
    remove = reward_lines(so)
    check(len(remove) == 1 and api.call("sale.order.line", "unlink", ids=[remove[0]["id"]]) is True and not reward_lines(so), "baris hadiah pada quotation draft bisa dihapus")
    api.call("sale.order", "action_confirm", ids=[so])
    api.call("sale.order", "action_open_reward_wizard", ids=[so])
    confirmed = reward_lines(so)
    check(bool(confirmed) and fails_with(lambda: api.call("sale.order.line", "unlink", ids=[confirmed[0]["id"]]), "confirmed"), "baris hadiah pada pesanan terkonfirmasi tidak bisa dihapus (set jumlah ke 0)")
    api.call("loyalty.program", "action_archive", ids=[auto])

    # Beli X gratis Y.
    free = new_program("Beli 3 Gratis 1", "buy_x_get_y", [{"reward_point_mode": "unit", "reward_point_amount": 1, "product_ids": [[6, 0, [product["id"]]]], "minimum_qty": 3}],
                       [{"reward_type": "product", "reward_product_id": product["id"], "reward_product_qty": 1, "required_points": 3, "description": "Produk gratis"}])
    so = order(3.0)
    check(api.call("sale.order", "action_open_reward_wizard", ids=[so]) is True, "promosi beli X gratis Y terpasang otomatis")
    line = reward_lines(so)
    check(len(line) == 1 and line[0]["product_uom_qty"] == 1.0 and line[0]["discount"] == 100.0 and line[0]["price_subtotal"] == 0.0, "satu unit gratis (diskon 100%) ditambahkan sebagai baris hadiah")
    check(abs(total(so)["amount_untaxed"] - unit * 3) < 0.01, "total tetap membayar 3 unit")
    api.call("loyalty.program", "action_archive", ids=[free])

    # Kupon: dibuat massal lewat wizard, sekali pakai, saldo bisa diubah.
    coupons = new_program("Kupon Rp25.000", "coupons", [], [{"reward_type": "discount", "discount_mode": "per_order", "discount": 25000.0, "discount_applicability": "order", "required_points": 1}])
    generate_context = {"active_id": coupons, "default_program_id": coupons}
    wizard = api.call("loyalty.generate.wizard", "create", vals_list=[{"program_id": coupons, "mode": "anonymous", "coupon_qty": 2, "points_granted": 1, "description": "Uji regresi"}], context=generate_context)
    made = api.call("loyalty.generate.wizard", "generate_coupons", ids=wizard, context=generate_context)
    cards = api.search("loyalty.card", [["id", "in", made]], ["code", "points"])
    check(len(cards) == 2 and all(c["points"] == 1.0 for c in cards) and api.read("loyalty.program", coupons, ["coupon_count"])["coupon_count"] == 2, "wizard membuat dua kupon bernilai 1 poin")
    so = order(2.0)
    action = apply_code(so, cards[0]["code"])
    claim(so, action["context"]["default_reward_ids"][0])
    check(abs(total(so)["amount_total"] - (unit * 2 * 1.11 - 25000.0)) < 0.5, "kupon Rp25.000 (termasuk pajak) mengurangi total pesanan")
    invoice = invoice_of(so)
    check(api.read("loyalty.card", cards[0]["id"], ["points"])["points"] == 0.0 and balanced(invoice), "kupon habis terpakai setelah pesanan dikonfirmasi dan jurnal faktur seimbang")
    check(fails_with(lambda: apply_code(order(2.0), cards[0]["code"]), "already been used"), "kupon yang sudah terpakai ditolak")
    balance = api.call("loyalty.card.update.balance", "create", vals_list=[{"card_id": cards[1]["id"], "new_balance": 3.0, "description": "Koreksi regresi"}])
    api.call("loyalty.card.update.balance", "action_update_card_point", ids=balance)
    history = api.search("loyalty.history", [["card_id", "=", cards[1]["id"]]], ["description", "issued", "used"])
    check(api.read("loyalty.card", cards[1]["id"], ["points"])["points"] == 3.0 and any(h["description"] == "Koreksi regresi" and h["issued"] == 2.0 for h in history), "ubah saldo kupon tercatat di riwayat")
    api.call("loyalty.card", "action_archive", ids=[cards[1]["id"]])
    check(fails_with(lambda: apply_code(order(2.0), cards[1]["code"]), "invalid"), "kupon yang diarsipkan tidak bisa dipakai")

    # Kartu loyalti: poin terkumpul per pelanggan dan dipakai pada pesanan berikutnya.
    loyalty = new_program("Kartu Loyalti", "loyalty", [{"reward_point_mode": "money", "reward_point_amount": 0.001}],
                          [{"reward_type": "discount", "discount_mode": "per_order", "discount": 10000.0, "discount_applicability": "order", "required_points": 100}],
                          portal_point_name="Poin")
    so = order(2.0, partner=customer)
    api.call("sale.order", "action_open_reward_wizard", ids=[so])
    api.call("sale.order", "action_confirm", ids=[so])
    card = api.search("loyalty.card", [["program_id", "=", loyalty]], ["partner_id", "points"])
    gross = round(unit * 2 * 1.11)
    check(len(card) == 1 and card[0]["partner_id"][0] == customer, "kartu loyalti pelanggan terbit saat pesanan dikonfirmasi")
    check(abs(card[0]["points"] - (gross * 0.001 - 100)) < 1.0, f"poin kartu = {gross * 0.001:,.1f} diterima dikurangi 100 dipakai")
    second = order(1.0, partner=customer)
    api.call("sale.order", "action_open_reward_wizard", ids=[second])
    check(api.read("sale.order", second, ["applied_coupon_ids"])["applied_coupon_ids"] == [card[0]["id"]], "kartu pelanggan dimuat otomatis pada pesanan berikutnya")
    api.call("loyalty.program", "action_archive", ids=[loyalty])

    check_loyalty_pos(api, product, info, tag, created)
    api.call("loyalty.program", "action_archive", ids=created)
    check(not api.search("loyalty.program", [["id", "in", created], ["active", "=", True]], ["id"]), "program uji diarsipkan agar tidak memengaruhi pemeriksaan lain")


def check_loyalty_pos(api, product, info, tag, created):
    """Program POS: berlaku per stasiun dan pesanan kasir dengan baris hadiah (kasir menghitung promosi di UI, server menyimpan baris hadiah)."""
    unit, taxes = info["lst_price"], info["taxes_id"]
    api.call("product.template", "write", ids=[info["product_tmpl_id"][0]], vals={"available_in_pos": True})
    discount = api.call("loyalty.program", "create", vals_list=[{
        "name": f"POS Diskon 10% {tag}", "program_type": "promotion", "trigger": "auto", "applies_on": "current", "portal_visible": False, "sale_ok": False, "pos_ok": True,
        "rule_ids": [[0, 0, {"reward_point_mode": "order", "reward_point_amount": 1, "minimum_amount": 100_000.0, "minimum_amount_tax_mode": "excl", "minimum_qty": 0}]],
        "reward_ids": [[0, 0, {"reward_type": "discount", "discount_mode": "percent", "discount": 10, "discount_applicability": "order", "required_points": 1, "description": "10% untuk seluruh pesanan"}]],
    }])[0]
    free = api.call("loyalty.program", "create", vals_list=[{
        "name": f"POS Beli 3 Gratis 1 {tag}", "program_type": "buy_x_get_y", "trigger": "auto", "applies_on": "current", "portal_visible": False, "sale_ok": False, "pos_ok": True,
        "rule_ids": [[0, 0, {"reward_point_mode": "unit", "reward_point_amount": 1, "product_ids": [[6, 0, [product["id"]]]], "minimum_qty": 3}]],
        "reward_ids": [[0, 0, {"reward_type": "product", "reward_product_id": product["id"], "reward_product_qty": 1, "required_points": 3, "description": "Produk gratis"}]],
    }])[0]
    created.extend([discount, free])
    [cash_journal] = api.call("account.journal", "create", vals_list=[{"name": f"Kas Promo {tag}", "type": "cash", "code": f"P{tag[-4:]}"}])
    cash = api.call("pos.payment.method", "create", vals_list=[{"name": f"Tunai Promo {tag}", "journal_id": cash_journal}])[0]
    [config] = api.call("pos.config", "create", vals_list=[{"name": f"Kasir Promo {tag}", "payment_method_ids": [[6, 0, [cash]]], "cash_control": True}])
    user = api.search("res.users", [["login", "!=", False]], ["id"], limit=1)[0]["id"]
    today = datetime.date.today().isoformat()
    pos_programs = {p["id"] for p in api.search("loyalty.program", [
        ["pos_ok", "=", True], "|", ["pos_config_ids", "=", config], ["pos_config_ids", "=", False],
        "|", ["date_from", "=", False], ["date_from", "<=", today], "|", ["date_to", "=", False], ["date_to", ">=", today]], ["id"])}
    check({discount, free} <= pos_programs, "program POS tanpa pembatasan stasiun berlaku di stasiun mana pun (domain yang sama dengan pos.config._get_program_ids)")
    sales_only = api.call("loyalty.program", "create", vals_list=[{"name": f"Hanya Sales {tag}", "program_type": "promotion", "sale_ok": True, "pos_ok": False, "reward_ids": [[0, 0, {"discount": 5}]]}])[0]
    created.append(sales_only)
    check(sales_only not in {p["id"] for p in api.search("loyalty.program", [["pos_ok", "=", True]], ["id"])}, "program yang hanya untuk Sales Order tidak muncul di POS")

    [session] = api.call("pos.session", "create", vals_list=[{"config_id": config, "user_id": user}])
    api.call("pos.session", "set_opening_control", ids=[session], cashbox_value=100_000.0, notes="Modal awal")
    discount_excl = round(unit * 3 * 0.1, 2)
    excl = round(unit * 3 - discount_excl, 2)
    total = api.call("account.tax", "compute_all", ids=taxes, price_unit=excl, quantity=1)["total_included"] if taxes else excl
    now = datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    discount_product = api.read("loyalty.reward", api.search("loyalty.reward", [["program_id", "=", discount]], ["id"])[0]["id"], ["discount_line_product_id"])["discount_line_product_id"][0]
    reward_ids = {p: api.search("loyalty.reward", [["program_id", "=", p]], ["id"])[0]["id"] for p in (discount, free)}

    def line(uuid, product_id, qty, price, disc, extra=None):
        subtotal = 0.0 if disc == 100.0 else round(qty * price, 2)
        return [0, 0, {"uuid": uuid, "product_id": product_id, "qty": qty, "price_unit": price, "discount": disc, "tax_ids": [[6, 0, taxes]], "price_subtotal": subtotal,
                       "price_subtotal_incl": subtotal, "full_product_name": "Baris", "name": "Baris", **(extra or {})}]

    payload = {
        "name": f"Order P-{tag}", "uuid": f"promo-{tag}", "session_id": session, "config_id": config, "user_id": user, "sequence_number": 1, "date_order": now,
        "amount_tax": total - excl, "amount_total": total, "amount_paid": total, "amount_return": 0.0, "partner_id": False, "to_invoice": False, "pricelist_id": False, "fiscal_position_id": False,
        "lines": [
            line(f"l1-{tag}", product["id"], 3.0, unit, 0.0),
            line(f"l2-{tag}", discount_product, 1.0, -discount_excl, 0.0, {"is_reward_line": True, "reward_id": reward_ids[discount], "reward_identifier_code": f"a{tag}", "points_cost": 1.0}),
            line(f"l3-{tag}", product["id"], 1.0, unit, 100.0, {"is_reward_line": True, "reward_id": reward_ids[free], "reward_identifier_code": f"b{tag}", "points_cost": 3.0}),
        ],
        "payment_ids": [[0, 0, {"payment_method_id": cash, "amount": total, "name": now}]],
    }
    created_order = api.call("pos.order", "sync_from_ui", orders=[payload])["pos.order"][0]
    check(created_order["state"] == "paid" and abs(created_order["amount_total"] - total) < 0.005, "pesanan kasir dengan baris hadiah tersimpan dan dibayar")
    rewards = api.search("pos.order.line", [["order_id", "=", created_order["id"]], ["is_reward_line", "=", True]], ["reward_id", "points_cost"])
    check({r["reward_id"][0] for r in rewards} == set(reward_ids.values()), "baris hadiah menyimpan reward_id dan poin yang dipakai")
    counts = {p["id"]: (p["pos_order_count"], p["total_order_count"]) for p in api.search("loyalty.program", [["id", "in", [discount, free]]], ["pos_order_count", "total_order_count"])}
    check(counts == {discount: (1, 1), free: (1, 1)}, "pemakaian program POS terhitung dari baris hadiah")
    data = api.call("pos.session", "get_closing_control_data", ids=[session])
    expected = data["default_cash_details"]["amount"]
    check(abs(expected - (100_000.0 + total)) < 0.01, "kas diharapkan = kas awal + total pesanan berhadiah")
    api.call("pos.session", "post_closing_cash_details", ids=[session], counted_cash=expected)
    api.call("pos.session", "update_closing_control_state_session", ids=[session], notes="Penutupan promo")
    closed = api.call("pos.session", "close_session_from_ui", ids=[session], bank_payment_method_diff_pairs=[])
    info_session = api.read("pos.session", session, ["state", "move_id", "statement_line_ids"])
    check(closed.get("successful") is True and info_session["state"] == "closed", "sesi dengan pesanan berhadiah ditutup tanpa meminta penyeimbangan (total memakai pembulatan pajak perusahaan)")
    statement_moves = [r["move_id"][0] for r in api.search("account.bank.statement.line", [["id", "in", info_session["statement_line_ids"]]], ["move_id"])]
    items = api.search("account.move.line", [["move_id", "=", info_session["move_id"][0]]], ["debit", "credit"])
    check(items and abs(sum(i["debit"] for i in items) - sum(i["credit"] for i in items)) < 0.005 and all(balanced_move(api, mid) for mid in statement_moves), "jurnal penutupan sesi berhadiah seimbang")


def balanced_move(api, move_id):
    items = api.search("account.move.line", [["move_id", "=", move_id]], ["debit", "credit"])
    return abs(sum(i["debit"] for i in items) - sum(i["credit"] for i in items)) < 0.005


def check_stock_picker(api):
    """Pemilih produk form Transfer (ui/live/stockqty.js): on hand dan tersedia di lokasi asal, termasuk sublokasi, sama dengan hitungan langsung dari quant."""
    step("Stok tersedia di pemilih produk (Transfer Internal)")
    quants = api.search("stock.quant", [["location_id.usage", "=", "internal"], ["quantity", ">", 0]], ["product_id", "location_id", "quantity", "reserved_quantity"], limit=500)
    by_location = {}
    for q in quants:
        by_location.setdefault(q["location_id"][0], []).append(q)
    check(bool(by_location), "ada stok di lokasi internal untuk diuji")
    if not by_location:
        return
    location = max(by_location, key=lambda k: len(by_location[k]))
    products = sorted({q["product_id"][0] for q in by_location[location]})[:5]
    rows = api.call("stock.quant", "formatted_read_group", domain=[["location_id", "child_of", location], ["product_id", "in", products]], groupby=["product_id"], aggregates=["quantity:sum", "reserved_quantity:sum"])
    got = {r["product_id"][0]: (round(r["quantity:sum"], 3), round(r["quantity:sum"] - r["reserved_quantity:sum"], 3)) for r in rows}
    expected = {}
    for q in api.search("stock.quant", [["location_id", "child_of", location], ["product_id", "in", products]], ["product_id", "quantity", "reserved_quantity"], limit=500):
        on_hand, available = expected.get(q["product_id"][0], (0, 0))
        expected[q["product_id"][0]] = (round(on_hand + q["quantity"], 3), round(available + q["quantity"] - q["reserved_quantity"], 3))
    check(got == expected, f"on hand dan tersedia per produk ({len(expected)} produk) sama dengan hitungan quant langsung")
    other = api.call("stock.quant", "formatted_read_group", domain=[["location_id", "child_of", location], ["product_id", "=", -1]], groupby=["product_id"], aggregates=["quantity:sum"])
    check(other == [], "produk tanpa stok di lokasi itu tidak muncul (dianggap 0)")


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
    check(abs(balance["Selisih aset dan liabilitas + ekuitas (harus 0)"] or 0) < 0.005, "neraca: aset sama dengan liabilitas + ekuitas")
    check(balance["Laba (Rugi) Tahun Berjalan"] == pnl["LABA BERSIH"], "neraca: laba berjalan sama dengan laba bersih laporan laba rugi")
    cash, _ = mis_values(api, "Arus Kas", start, end)
    check(abs(cash["Selisih saldo kas (harus 0)"] or 0) < 0.005, "arus kas: kenaikan kas cocok dengan saldo kas dan bank")
    check(cash["Laba (Rugi) Bersih"] == pnl["LABA BERSIH"], "arus kas: berangkat dari laba bersih yang sama")
    _, trial = mis_values(api, "Neraca Saldo", start, end)
    total = trial["body"][0]["cells"]
    check(abs(total[1]["val"] - total[2]["val"]) < 0.005 and total[1]["val"] > 0, "neraca saldo: total debit sama dengan total kredit")
    ledger = api.call("account.move.line", "formatted_read_group", domain=[["parent_state", "=", "posted"], ["date", ">=", start], ["date", "<=", end]], groupby=[], aggregates=["debit:sum", "credit:sum"])[0]
    check(abs(ledger["debit:sum"] - total[1]["val"]) < 0.005, "neraca saldo: total debit sama dengan buku besar")


def bill_total(api, bill_id):
    return api.read("account.move", bill_id, ["amount_total"])["amount_total"]


if __name__ == "__main__":
    main()
