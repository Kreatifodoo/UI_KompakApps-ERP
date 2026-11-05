# ruff: noqa: F821
"""Data contoh studi kasus COGM periodik (Q70): satu perusahaan demo per kasus, untuk kasus yang belum punya data di "PROLINE Periodik (Demo)".

Panduan modul COGM memuat 14 studi kasus. Kasus 1, 4, 5, 6, 8, dan 9 sudah ada datanya di perusahaan "PROLINE Periodik (Demo)" (`seed_cogm_demo.py`); kasus 3
(pabrik berhenti) dan 13 (penjualan bertanggal mundur) sengaja tidak dibuatkan contoh. Skrip ini membuat enam perusahaan demo, masing-masing berisi satu kasus
supaya buku besar, saldo awal, dan stoknya tidak saling mengganggu (pemeriksaan "akun persediaan tidak bergerak" dan saldo awal diambil dari buku besar
perusahaan itu):

    Studi Kasus 02 - Akun Biaya Salah Tempat (Demo)          kertas kerja Merah: akun 51400001 bergerak Rp 7.000.000 tetapi belum dipetakan
    Studi Kasus 07 - Retur Pembelian Bahan Baku (Demo)       kertas kerja Hijau: biaya rata-rata tertimbang setelah retur 10 unit
    Studi Kasus 10 - Terjual Setelah COGM Dieksekusi (Demo)  bulan sebelumnya Terposting, bulan lalu Hijau dengan penyesuaian HPP NEGATIF
    Studi Kasus 11 - HPP Periodik Murni (Demo)               kertas kerja Hijau: penjualan tanpa jurnal HPP, seluruh HPP dijurnal saat Execute
    Studi Kasus 12 - Barang Jadi Tanpa Produksi (Demo)       kertas kerja Hijau: barang jadi berstok awal (punya BoM) tanpa produksi bulan ini
    Studi Kasus 14 - Biaya Terlewat Setelah Execute (Demo)   kertas kerja Terposting + tagihan draf Rp 5.000.000 yang belum dibukukan

Semua memakai bulan lalu (kasus 10 juga bulan sebelumnya), akun COGM standar `kompakapps_setup_cogm()`, dan persediaan periodik. Aman dijalankan ulang:
kasus yang perusahaannya sudah ada dilewati. Dijalankan lewat `odoo shell` (variabel `env` disediakan shell) pada database yang sudah memasang kompakapps_base:

    docker compose run --rm -T odoo odoo shell -d kompakapps --no-http < scripts/seed_cogm_cases.py
"""

from datetime import date, datetime, time, timedelta

from odoo import Command

BASE_ENV = env
first_this_month = date.today().replace(day=1)
last_to = first_this_month - timedelta(days=1)  # bulan lalu
last_from = last_to.replace(day=1)
prev_to = last_from - timedelta(days=1)  # bulan sebelumnya
prev_from = prev_to.replace(day=1)
before_to = prev_from - timedelta(days=1)  # akhir dua bulan lalu (saldo awal kasus 10)


def at(day, hour=3):
    """Waktu (UTC) pada tanggal tertentu; jam 03.00 UTC = 10.00 WIB."""
    return datetime.combine(day, time(hour, 0))


def plus(day, days):
    return day + timedelta(days=days)


class Demo:
    """Satu perusahaan demo periodik (akun COGM standar) beserta fungsi bantu untuk membuat transaksinya."""

    def __init__(self, name):
        company = BASE_ENV["res.company"].create({"name": name})
        BASE_ENV.ref("base.user_admin").write({"company_ids": [Command.link(company.id)]})
        company.kompakapps_setup_indonesia()
        company.kompakapps_setup_warehouse()
        company.write({"inventory_valuation": "periodic", "anglo_saxon_accounting": False})  # skema 2: tanpa jurnal per transaksi
        company.kompakapps_setup_cogm()
        self.env = BASE_ENV(context={**BASE_ENV.context, "allowed_company_ids": [company.id]})
        self.company = self.env["res.company"].browse(company.id)
        self.config = self.env["kompakapps.cogm.config"].search([("company_id", "=", company.id)])
        self.raw_acc, self.fg_acc, self.cogs_acc = self.config.raw_account_id, self.config.fg_account_id, self.config.cogs_account_id
        self.purchases, self.returns = self.account("51000020"), self.account("51000022")
        self.labor, self.indirect, self.power = self.account("51200010"), self.account("51300010"), self.account("51300020")
        self.depreciation, self.maintenance, self.supplies = self.account("51300030"), self.account("51300040"), self.account("51300050")
        self.payable = self.first_account("liability_current")
        self.accumulated = self.first_account("asset_fixed", "Accumulated") or self.payable
        self.equity = self.first_account("equity")
        self.misc = self.env["account.journal"].search([("company_id", "=", company.id), ("type", "=", "general"), ("code", "=", "MISC")], limit=1)
        self.category = self.env["product.category"].create({"name": f"Persediaan Periodik ({name})"})
        self.category.with_company(self.company).write({"property_valuation": "periodic", "property_cost_method": "standard", "property_account_expense_categ_id": self.purchases.id})
        warehouse = self.env["stock.warehouse"].search([("company_id", "=", company.id)], limit=1)
        self.stock_loc = warehouse.lot_stock_id
        self.production_loc = self.env["stock.location"].search([("usage", "=", "production"), ("company_id", "=", company.id)], limit=1)
        self.customer = self.env["res.partner"].create({"name": "PT Laboratorium Pelanggan Demo", "is_company": True, "customer_rank": 1, "company_id": company.id})
        self.vendors = {
            key: self.env["res.partner"].create({"name": label, "is_company": True, "supplier_rank": 1, "company_id": company.id})
            for key, label in (("bahan", "PT Kimia Medika Nusantara"), ("listrik", "PLN Unit Pabrik"), ("umum", "CV Jasa Pabrik Sejahtera"))
        }

    # ---- akun dan produk ----
    def account(self, code):
        return self.env["account.account"].with_company(self.company).search([("code", "=", code), ("company_ids", "in", self.company.id)], limit=1)

    def first_account(self, account_type, name=None):
        domain = [("account_type", "=", account_type), ("company_ids", "in", self.company.id)]
        found = self.env["account.account"].with_company(self.company).search(domain + ([("name", "ilike", name)] if name else []), limit=1)
        return found or self.env["account.account"].with_company(self.company).search(domain, limit=1)

    def new_account(self, code, name, account_type="expense"):
        return self.env["account.account"].with_company(self.company).create({"code": code, "name": name, "account_type": account_type, "company_ids": [Command.link(self.company.id)]})

    def product(self, code, name, cost, storable=True):
        return self.env["product.product"].with_company(self.company).create(
            {
                "name": name, "default_code": code, "type": "consu", "is_storable": storable, "categ_id": self.category.id, "company_id": self.company.id,
                "taxes_id": [Command.clear()], "supplier_taxes_id": [Command.clear()], "standard_price": float(cost),
            }
        )

    # ---- stok (tanpa jurnal; persediaan periodik) ----
    def stamp(self, moves, when):
        moves.write({"date": when})
        moves.move_line_ids.write({"date": when})

    def adjust_stock(self, product, qty, when):
        """Samakan stok sistem dengan jumlah tertentu (stok awal atau hasil produksi masuk gudang)."""
        domain = [("product_id", "=", product.id), ("is_inventory", "=", True), ("company_id", "=", self.company.id)]
        known = self.env["stock.move"].search(domain).ids
        self.env["stock.quant"].with_context(inventory_mode=True).create({"product_id": product.id, "location_id": self.stock_loc.id, "inventory_quantity": qty}).action_apply_inventory()
        self.stamp(self.env["stock.move"].search([*domain, ("id", "not in", known)]), when)

    def _move_out(self, product, qty, destination, when):
        move = self.env["stock.move"].create(
            {
                "product_id": product.id, "product_uom_qty": qty, "product_uom": product.uom_id.id, "location_id": self.stock_loc.id,
                "location_dest_id": destination.id, "company_id": self.company.id,
            }
        )
        move._action_confirm()
        move._action_assign()
        move.write({"quantity": qty, "picked": True})
        move._action_done()
        self.stamp(move, when)

    def consume(self, product, qty, when):
        """Pemakaian bahan ke produksi: kartu stok berkurang, tanpa jurnal."""
        self._move_out(product, qty, self.production_loc, when)

    def deliver(self, product, qty, when):
        self._move_out(product, qty, self.env.ref("stock.stock_location_customers"), when)

    def return_to_vendor(self, product, qty, when):
        self._move_out(product, qty, self.env.ref("stock.stock_location_suppliers"), when)

    def produce(self, product, qty, when):
        """Hasil produksi masuk gudang barang jadi."""
        self.adjust_stock(product, product.qty_available + qty, when)

    # ---- transaksi akuntansi ----
    def journal(self, day, ref, lines):
        self.env["account.move"].create(
            {"move_type": "entry", "journal_id": self.misc.id, "date": day, "ref": ref, "line_ids": [Command.create({"account_id": a.id, "debit": d, "credit": c, "name": ref}) for a, d, c in lines]}
        ).action_post()

    def opening(self, day, raw=0.0, fg=0.0):
        """Saldo awal persediaan bahan baku dan barang jadi di buku besar (lawannya modal)."""
        lines = [(account, amount, 0.0) for account, amount in ((self.raw_acc, raw), (self.fg_acc, fg)) if amount]
        if lines:
            self.journal(day, "Saldo awal persediaan", [*lines, (self.equity, 0.0, raw + fg)])

    def purchase(self, vendor, when, lines):
        """PO, penerimaan barang, lalu tagihan terposting (Dr Pembelian). lines = [(produk, jumlah, harga satuan)]."""
        order = self.env["purchase.order"].create(
            {
                "partner_id": vendor.id, "date_order": when, "company_id": self.company.id,
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
        self.stamp(picking.move_ids, when)
        action = order.action_create_invoice()
        bill = self.env["account.move"].browse(action["res_id"]) if action.get("res_id") else order.invoice_ids
        bill.write({"invoice_date": when.date(), "date": when.date(), "ref": f"INV-{order.name}"})
        bill.action_post()
        return bill

    def purchase_return(self, vendor, day, product, qty, price):
        """Retur pembelian: barang dikirim kembali ke pemasok dan nota kredit pada akun Retur Pembelian, dengan produk (mengurangi jumlah dan nilai pembelian)."""
        self.return_to_vendor(product, qty, at(day))
        note = self.env["account.move"].create(
            {
                "move_type": "in_refund", "partner_id": vendor.id, "invoice_date": day, "date": day, "company_id": self.company.id, "ref": f"Retur {product.default_code}",
                "invoice_line_ids": [Command.create({"product_id": product.id, "quantity": qty, "price_unit": price, "account_id": self.returns.id, "tax_ids": [Command.clear()]})],
            }
        )
        note.action_post()
        return note

    def expense_bill(self, vendor, day, account, amount, label, post=True):
        bill = self.env["account.move"].create(
            {
                "move_type": "in_invoice", "partner_id": vendor.id, "invoice_date": day, "date": day, "company_id": self.company.id, "ref": label,
                "invoice_line_ids": [Command.create({"name": label, "account_id": account.id, "quantity": 1.0, "price_unit": amount, "tax_ids": [Command.clear()]})],
            }
        )
        if post:
            bill.action_post()
        return bill

    def costs(self, first, last, labor=0.0, indirect=0.0, power=0.0, depreciation=0.0, maintenance=0.0):
        """Biaya produksi satu bulan: upah dan overhead pabrik (tagihan listrik, sisanya jurnal akhir bulan)."""
        for account, counter, amount, label in (
            (self.labor, self.payable, labor, "Upah tenaga kerja langsung"),
            (self.indirect, self.payable, indirect, "Tenaga kerja tidak langsung pabrik"),
            (self.depreciation, self.accumulated, depreciation, "Penyusutan mesin dan peralatan pabrik"),
            (self.maintenance, self.payable, maintenance, "Perawatan mesin pabrik"),
        ):
            if amount:
                self.journal(last, label, [(account, amount, 0.0), (counter, 0.0, amount)])
        if power:
            self.expense_bill(self.vendors["listrik"], plus(first, 19), self.power, power, "Tagihan listrik pabrik")

    def sell(self, product, qty, day, price, provisional_unit=None):
        """Pengiriman dan faktur penjualan; bila `provisional_unit` diisi, HPP sementara (Dr HPP, Cr Inventory COGM) dibukukan juga."""
        self.deliver(product, qty, at(day))
        self.env["account.move"].create(
            {
                "move_type": "out_invoice", "partner_id": self.customer.id, "invoice_date": day, "date": day, "company_id": self.company.id,
                "invoice_line_ids": [Command.create({"product_id": product.id, "quantity": qty, "price_unit": price, "tax_ids": [Command.clear()]})],
            }
        ).action_post()
        if provisional_unit is not None:
            amount = qty * provisional_unit
            self.env["account.move"].create(
                {
                    "move_type": "entry", "journal_id": self.misc.id, "date": day, "ref": f"HPP sementara {product.default_code}",
                    "line_ids": [
                        Command.create({"account_id": self.cogs_acc.id, "debit": amount, "credit": 0.0, "product_id": product.id, "name": f"HPP sementara {product.name}"}),
                        Command.create({"account_id": self.fg_acc.id, "debit": 0.0, "credit": amount, "product_id": product.id, "name": f"HPP sementara {product.name}"}),
                    ],
                }
            ).action_post()

    # ---- kertas kerja ----
    def worksheet(self, first, last, counts, outputs, note):
        """Kertas kerja dengan hasil opname bahan baku `counts` = [(produk, jumlah fisik)] dan qty diproduksi `outputs` = [(produk, qty)]."""
        sheet = self.env["kompakapps.cogm.worksheet"].create({"company_id": self.company.id, "date_from": first, "date_to": last, "note": note})
        sheet.write(
            {
                "opname_ids": [Command.create({"product_id": p.id, "qty": float(q)}) for p, q in counts],
                "output_ids": [Command.create({"product_id": p.id, "qty": float(q)}) for p, q in outputs],
            }
        )
        sheet.action_pull()
        return sheet


def errors(result):
    return [check["key"] for check in result["checks"] if check["status"] == "error"]


def exists(name):
    return bool(BASE_ENV["res.company"].search([("name", "=", name)]))


def money(amount):
    return f"{amount:,.2f}"


report = []


def case02():
    name = "Studi Kasus 02 - Akun Biaya Salah Tempat (Demo)"
    if exists(name):
        return report.append(f"{name}: sudah ada, dilewati.")
    d = Demo(name)
    raw = d.product("BB-K02", "Bahan Baku Kasus 2", 50000)
    fg = d.product("FG-K02", "Kit Kasus 2 (Demo)", 0.0, storable=False)
    d.adjust_stock(raw, 100.0, at(before_to))
    d.opening(before_to, raw=5_000_000.0)
    d.purchase(d.vendors["bahan"], at(plus(last_from, 4)), [(raw, 800.0, 50000.0)])
    d.consume(raw, 800.0, at(plus(last_from, 13)))
    d.costs(last_from, last_to, labor=30_000_000.0, indirect=6_000_000.0, power=15_000_000.0, depreciation=4_000_000.0)
    stray = d.new_account("51400001", "Biaya Pabrik Lain-lain")  # akun baru, sengaja belum dipetakan
    d.expense_bill(d.vendors["umum"], plus(last_from, 21), stray, 7_000_000.0, "Sewa alat bantu pabrik (dibukukan ke akun baru)")
    sheet = d.worksheet(
        last_from, last_to, [(raw, 100.0)], [(fg, 2000.0)],
        "KASUS 2 - Akun biaya salah tempat. Tagihan sewa alat bantu Rp 7.000.000 dibukukan ke akun baru Biaya Pabrik Lain-lain (51400001) yang belum dipetakan, "
        "sehingga Control Balance MERAH pada \"Semua akun biaya produksi terklasifikasi\". Coba: buka Pengaturan COGM, petakan akun itu sebagai Overhead, kembali ke "
        "sini, Tarik dari Buku Besar, lalu Periksa: Hijau, COGM naik Rp 7.000.000 dan HPP per unit naik Rp 3.500 (2.000 unit). Dipetakan sebagai Bukan Biaya Produksi, "
        "COGM tidak berubah.",
    )
    result = sheet.action_check()
    assert errors(result) == ["unmapped"], result
    assert abs(sheet.cogm - 95_000_000.0) < 0.01 and abs(sheet.unit_cogm - 47_500.0) < 0.01, (sheet.cogm, sheet.unit_cogm)
    report.append(f"{name}: {sheet.name} {last_from}..{last_to} COGM {money(sheet.cogm)}, HPP/unit {money(sheet.unit_cogm)}, Control Balance {result['state']} ({errors(result)})")
    BASE_ENV.cr.commit()


def case07():
    name = "Studi Kasus 07 - Retur Pembelian Bahan Baku (Demo)"
    if exists(name):
        return report.append(f"{name}: sudah ada, dilewati.")
    d = Demo(name)
    raw = d.product("BB-K07", "Reagen Kasus 7", 10000)
    fg = d.product("FG-K07", "Kit Kasus 7 (Demo)", 0.0, storable=False)
    d.adjust_stock(raw, 100.0, at(before_to))
    d.opening(before_to, raw=1_000_000.0)
    d.purchase(d.vendors["bahan"], at(plus(last_from, 4)), [(raw, 50.0, 12000.0)])
    d.purchase(d.vendors["bahan"], at(plus(last_from, 11)), [(raw, 50.0, 14000.0)])
    d.purchase_return(d.vendors["bahan"], plus(last_from, 14), raw, 10.0, 14000.0)
    d.consume(raw, 130.0, at(plus(last_from, 19)))  # 100 + 100 - 10 - 130 = 60
    d.costs(last_from, last_to, labor=1_500_000.0, power=600_000.0)
    sheet = d.worksheet(
        last_from, last_to, [(raw, 60.0)], [(fg, 500.0)],
        "KASUS 7 - Retur pembelian. Stok awal 100 @ Rp 10.000; beli 50 @ Rp 12.000 dan 50 @ Rp 14.000; retur 10 @ Rp 14.000 (nota kredit pada akun Retur Pembelian, "
        "dengan produk). Pembelian bersih 90 unit senilai Rp 1.160.000, jadi biaya rata-rata = (1.000.000 + 1.160.000) / 190 = Rp 11.368,42. Buka \"Rincian biaya "
        "rata-rata\" pada baris opname. Biaya itu menjadi biaya produk saat Execute.",
    )
    line = sheet.opname_ids
    assert line.cost_source == "average" and abs(line.unit_cost - 11368.42) < 0.005, (line.cost_source, line.unit_cost)
    assert abs(line.purchase_qty - 90.0) < 1e-6 and abs(line.purchase_value - 1_160_000.0) < 0.01, (line.purchase_qty, line.purchase_value)
    result = sheet.action_check()
    assert result["state"] == "green", [c for c in result["checks"] if c["status"] == "error"]
    report.append(f"{name}: {sheet.name} {last_from}..{last_to} COGM {money(sheet.cogm)}, biaya rata-rata {money(line.unit_cost)}, Control Balance {result['state']}")
    BASE_ENV.cr.commit()


def case10():
    name = "Studi Kasus 10 - Terjual Setelah COGM Dieksekusi (Demo)"
    if exists(name):
        return report.append(f"{name}: sudah ada, dilewati.")
    d = Demo(name)
    raw = d.product("BB-K10", "Bahan Baku Kasus 10", 50000)
    fg = d.product("FG-K10", "Kit Kasus 10 (Demo)", 0.0)
    d.adjust_stock(raw, 100.0, at(before_to))
    d.opening(before_to, raw=5_000_000.0)

    # Bulan sebelumnya: 1.000 kit diproduksi (biaya Rp 100.000), 600 terjual dengan HPP sementara Rp 90.000; dieksekusi, biaya produk menjadi Rp 100.000.
    d.purchase(d.vendors["bahan"], at(plus(prev_from, 4)), [(raw, 900.0, 50000.0)])
    d.consume(raw, 900.0, at(plus(prev_from, 13)))
    d.costs(prev_from, prev_to, labor=30_000_000.0, power=15_000_000.0, depreciation=6_000_000.0, maintenance=4_000_000.0)
    d.produce(fg, 1000.0, at(plus(prev_from, 11)))
    d.sell(fg, 600.0, plus(prev_from, 17), 150000.0, provisional_unit=90000.0)
    first = d.worksheet(
        prev_from, prev_to, [(raw, 100.0)], [(fg, 1000.0)],
        "KASUS 10 (bulan pertama) - sudah dieksekusi. 1.000 kit diproduksi dengan COGM Rp 100.000.000 (Rp 100.000 per kit); 600 terjual dengan HPP sementara "
        "Rp 90.000, jadi penyesuaian HPP Rp 6.000.000. Biaya produk kit menjadi Rp 100.000, itulah biaya yang dipakai saat menjual bulan berikutnya.",
    )
    result = first.action_check()
    assert result["state"] == "green", [c for c in result["checks"] if c["status"] == "error"]
    assert abs(first.cogm - 100_000_000.0) < 0.01, first.cogm
    first.action_post()
    assert first.state == "posted" and abs(fg.standard_price - 100_000.0) < 0.01, (first.state, fg.standard_price)
    assert abs(first.fg_adjustment - 6_000_000.0) < 0.01, first.fg_adjustment

    # Bulan lalu: stok awal 400 kit @ Rp 100.000; produksi 1.000 kit lebih murah (Rp 90.000); 800 terjual dengan HPP sementara memakai biaya produk Rp 100.000.
    d.purchase(d.vendors["bahan"], at(plus(last_from, 4)), [(raw, 800.0, 50000.0)])
    d.consume(raw, 800.0, at(plus(last_from, 13)))
    d.costs(last_from, last_to, labor=28_000_000.0, power=14_000_000.0, depreciation=6_000_000.0, maintenance=2_000_000.0)
    d.produce(fg, 1000.0, at(plus(last_from, 11)))
    d.sell(fg, 800.0, plus(last_from, 17), 150000.0, provisional_unit=fg.standard_price)
    second = d.worksheet(
        last_from, last_to, [(raw, 100.0)], [(fg, 1000.0)],
        "KASUS 10 (bulan kedua) - barang yang terjual SETELAH COGM bulan sebelumnya dieksekusi. Stok awal 400 kit @ Rp 100.000 (hasil Execute); produksi 1.000 kit "
        "dengan COGM Rp 90.000.000 (Rp 90.000 per kit); 800 kit terjual dengan HPP sementara memakai biaya produk saat itu, Rp 100.000. Biaya rata-rata bulan ini "
        "(400 x 100.000 + 90.000.000) / 1.400 = Rp 92.857,14 lebih rendah, sehingga HPP aktual lebih kecil dari HPP sementara: penyesuaian HPP NEGATIF "
        "(jurnal berbalik: Dr Inventory COGM, Cr HPP). HPP aktual Rp 74.285.716 dibanding sementara Rp 80.000.000 = penyesuaian HPP minus Rp 5.714.284; "
        "nilai 600 kit stok akhir turun Rp 4.285.716 (dari Rp 100.000 ke Rp 92.857,14 per kit). Bulan pertama yang sudah Terposting tidak berubah.",
    )
    result = second.action_check()
    assert result["state"] == "green", [c for c in result["checks"] if c["status"] == "error"]
    assert second.fg_adjustment < 0, second.fg_adjustment
    fg_line = second.fg_ids
    report.append(
        f"{name}: {first.name} {prev_from}..{prev_to} COGM {money(first.cogm)} (Terposting, penyesuaian HPP {money(first.fg_adjustment)}); "
        f"{second.name} {last_from}..{last_to} COGM {money(second.cogm)} (draft Hijau), biaya rata-rata {money(fg_line.unit_cost)}, HPP aktual {money(second.fg_cogs)}, "
        f"sementara {money(second.fg_provisional)}, penyesuaian {money(second.fg_adjustment)}, penyesuaian stok akhir {money(fg_line.stock_adjustment)}"
    )
    BASE_ENV.cr.commit()


def case11():
    name = "Studi Kasus 11 - HPP Periodik Murni (Demo)"
    if exists(name):
        return report.append(f"{name}: sudah ada, dilewati.")
    d = Demo(name)
    raw = d.product("BB-K11", "Bahan Baku Kasus 11", 40000)
    fg = d.product("FG-K11", "Kit Kasus 11 (Demo)", 0.0)
    d.adjust_stock(raw, 50.0, at(before_to))
    d.opening(before_to, raw=2_000_000.0)
    d.purchase(d.vendors["bahan"], at(plus(last_from, 4)), [(raw, 450.0, 40000.0)])
    d.consume(raw, 450.0, at(plus(last_from, 13)))
    d.costs(last_from, last_to, labor=25_000_000.0, power=10_000_000.0, depreciation=5_000_000.0, maintenance=3_000_000.0)
    d.produce(fg, 1000.0, at(plus(last_from, 11)))
    d.sell(fg, 400.0, plus(last_from, 17), 150000.0)  # hanya pengiriman dan faktur: tidak ada jurnal HPP saat penjualan
    sheet = d.worksheet(
        last_from, last_to, [(raw, 50.0)], [(fg, 1000.0)],
        "KASUS 11 - Periodik murni. 1.000 kit diproduksi dengan COGM Rp 61.000.000 (Rp 61.000 per kit); 400 terjual, stok akhir 600. Penjualan hanya mencatat "
        "faktur dan pengiriman, TANPA jurnal HPP. HPP sementara nol, jadi seluruh HPP aktual 400 x 61.000 = Rp 24.400.000 dijurnal sebagai penyesuaian saat Execute "
        "(Dr HPP, Cr Inventory COGM). Setelah Execute, saldo Inventory COGM Rp 36.600.000 = 600 x 61.000.",
    )
    result = sheet.action_check()
    assert result["state"] == "green", [c for c in result["checks"] if c["status"] == "error"]
    assert abs(sheet.cogm - 61_000_000.0) < 0.01 and abs(sheet.fg_provisional) < 0.01, (sheet.cogm, sheet.fg_provisional)
    assert abs(sheet.fg_cogs - 24_400_000.0) < 0.01 and abs(sheet.fg_adjustment - 24_400_000.0) < 0.01, (sheet.fg_cogs, sheet.fg_adjustment)
    report.append(f"{name}: {sheet.name} {last_from}..{last_to} COGM {money(sheet.cogm)}, HPP aktual {money(sheet.fg_cogs)}, sementara {money(sheet.fg_provisional)}, penyesuaian {money(sheet.fg_adjustment)} (draft Hijau)")
    BASE_ENV.cr.commit()


def case12():
    name = "Studi Kasus 12 - Barang Jadi Tanpa Produksi (Demo)"
    if exists(name):
        return report.append(f"{name}: sudah ada, dilewati.")
    d = Demo(name)
    part = d.product("BB-K12", "Komponen Kasus 12", 100000)
    fg = d.product("FG-K12", "Kit Lama Kasus 12 (Demo)", 80000)
    d.env["mrp.bom"].create(
        {
            "product_tmpl_id": fg.product_tmpl_id.id, "product_qty": 1.0, "type": "normal", "company_id": d.company.id,
            "bom_line_ids": [Command.create({"product_id": part.id, "product_qty": 1.0})],
        }
    )
    d.adjust_stock(part, 10.0, at(before_to))
    d.adjust_stock(fg, 200.0, at(before_to))
    d.opening(before_to, raw=1_000_000.0, fg=16_000_000.0)
    d.sell(fg, 150.0, plus(last_from, 17), 130000.0, provisional_unit=80000.0)
    sheet = d.worksheet(
        last_from, last_to, [(part, 10.0)], [],
        "KASUS 12 - Barang jadi lama punya stok awal tetapi tidak diproduksi bulan ini. Stok awal 200 unit @ Rp 80.000 (barang punya BoM, jadi muncul otomatis di "
        "bagian HPP Penjualan), terjual 150, stok akhir 50. Tanpa produksi, biaya rata-rata tetap Rp 80.000: HPP aktual 150 x 80.000 = Rp 12.000.000 dan stok "
        "akhir Rp 4.000.000. HPP sementara yang dibukukan juga Rp 80.000 per unit, jadi penyesuaian nol.",
    )
    result = sheet.action_check()
    assert result["state"] == "green", [c for c in result["checks"] if c["status"] == "error"]
    assert fg in sheet.fg_ids.product_id, "barang jadi lama harus muncul otomatis"
    assert abs(sheet.fg_cogs - 12_000_000.0) < 0.01 and abs(sheet.fg_adjustment) < 0.01 and abs(sheet.fg_ending_value - 4_000_000.0) < 0.01, (sheet.fg_cogs, sheet.fg_adjustment, sheet.fg_ending_value)
    report.append(f"{name}: {sheet.name} {last_from}..{last_to} COGM {money(sheet.cogm)}, HPP aktual {money(sheet.fg_cogs)}, sementara {money(sheet.fg_provisional)}, penyesuaian {money(sheet.fg_adjustment)} (draft Hijau)")
    BASE_ENV.cr.commit()


def case14():
    name = "Studi Kasus 14 - Biaya Terlewat Setelah Execute (Demo)"
    if exists(name):
        return report.append(f"{name}: sudah ada, dilewati.")
    d = Demo(name)
    raw = d.product("BB-K14", "Bahan Baku Kasus 14", 50000)
    fg = d.product("FG-K14", "Kit Kasus 14 (Demo)", 0.0, storable=False)
    d.adjust_stock(raw, 100.0, at(before_to))
    d.opening(before_to, raw=5_000_000.0)
    d.purchase(d.vendors["bahan"], at(plus(last_from, 4)), [(raw, 800.0, 50000.0)])
    d.consume(raw, 800.0, at(plus(last_from, 13)))
    d.costs(last_from, last_to, labor=30_000_000.0, indirect=6_000_000.0, power=15_000_000.0, depreciation=4_000_000.0)
    missed = d.expense_bill(d.vendors["umum"], plus(last_from, 26), d.supplies, 5_000_000.0, "Bahan penolong pabrik (belum diposting)", post=False)
    sheet = d.worksheet(
        last_from, last_to, [(raw, 100.0)], [(fg, 2000.0)],
        "KASUS 14 - Biaya terlewat setelah Execute. Kertas kerja ini sudah dieksekusi: COGM Rp 95.000.000, HPP per unit Rp 47.500 (2.000 unit). Sesudahnya "
        "ditemukan tagihan bahan penolong Rp 5.000.000 bertanggal bulan ini yang masih DRAF. Coba: posting tagihan itu (Accounting > Vendor Bills), lalu Reverse "
        "kertas kerja ini (jurnal pembalik pada tanggal yang sama, kertas kerja kembali draft), Tarik dari Buku Besar, Periksa, Execute lagi: COGM naik Rp 5.000.000 "
        "menjadi Rp 100.000.000 dan HPP per unit naik Rp 2.500 menjadi Rp 50.000. Jurnal asli, pembalik, dan jurnal baru tercatat sebagai jejak audit.",
    )
    result = sheet.action_check()
    assert result["state"] == "green", [c for c in result["checks"] if c["status"] == "error"]
    assert any(c["key"] == "drafts" and c["status"] == "warn" for c in result["checks"]), "tagihan draf harus tampil sebagai peringatan"
    assert abs(sheet.cogm - 95_000_000.0) < 0.01, sheet.cogm
    sheet.action_post()
    assert sheet.state == "posted" and missed.state == "draft"
    report.append(f"{name}: {sheet.name} {last_from}..{last_to} COGM {money(sheet.cogm)} (Terposting, jurnal {sheet.move_id.name}); tagihan {missed.ref} {money(missed.amount_total)} masih draf")
    BASE_ENV.cr.commit()


for run in (case02, case07, case10, case11, case12, case14):
    run()
BASE_ENV.cr.commit()
print("Data contoh studi kasus COGM:")
for line in report:
    print("  " + line)
