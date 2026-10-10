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
