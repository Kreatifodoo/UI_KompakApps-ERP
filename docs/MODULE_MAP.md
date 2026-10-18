# Peta Modul: Menu KompakApps ke Odoo

Sumber: `menuData` dan `formMapping` di [index.html](../index.html) (dihitung 2026-10-09).

**Ringkasan prototipe**: 9 modul, 119 menu daun. 48 menu terhubung ke form (39 judul unik, 23 file form). 71 menu hanya menampilkan tabel contoh palsu.

Kolom "Prototipe": **Form** = ada form HTML, **Tabel palsu** = placeholder tanpa desain.

Edisi: **C** = tersedia di Odoo Community, **OCA** = butuh modul Odoo Community Association, **E?** = kemungkinan Enterprise (perlu verifikasi di versi yang dipilih, lihat D3 di [DECISIONS.md](DECISIONS.md)).

## 1. Purchase Request (6 menu)
Odoo inti tidak punya Purchase Request. Pakai OCA `purchase_request`.

| Menu | Odoo | Edisi | Prototipe |
|---|---|---|---|
| Dashboard | Dashboard custom | C | Tabel palsu |
| Master > Product Master | `product.template` | C | Form |
| Purchase Request | `purchase.request` | OCA | Form |
| Report > PR Line, PR Analisis | Laporan `purchase.request.line` | OCA | Tabel palsu |
| Setting | Konfigurasi modul | C | Tabel palsu |

## 2. Purchase (10 menu)

| Menu | Odoo | Edisi | Prototipe |
|---|---|---|---|
| Master > Vendor Master | `res.partner` (supplier) | C | Form |
| Master > Vendor Price list | `product.supplierinfo` | C | Form |
| Request for Quotation | `purchase.order` (state draft/sent) | C | Form (sama dengan PO) |
| Purchase Order | `purchase.order` | C | Form |
| Create Vendor Bill | `account.move` (in_invoice) | C | Form |
| Report > PO line, PO Analisis | `purchase.report` | C | Tabel palsu |

## 3. Inventory (23 menu)

| Menu | Odoo | Edisi | Prototipe |
|---|---|---|---|
| Master > Product Master | `product.template` | C | Form |
| Master > Product Category | `product.category` | C | Tabel palsu |
| Master > Reorder Level | `stock.warehouse.orderpoint` | C | Tabel palsu |
| Master > Put away Rules | `stock.putaway.rule` | C | Tabel palsu |
| Master > UoM | `uom.uom` | C | Form |
| Master > Lot & Serial | `stock.lot` | C | Form |
| Master > Warehouse & Location | `stock.warehouse`, `stock.location` | C | Form |
| Operation > Good Receive, Delivery Order, Return GR, Return DO, Internal Transfer | `stock.picking` (tipe operasi berbeda) | C | Form (1 form untuk semua) |
| Operation > Material Request | `stock.picking` / OCA `stock_request` | C/OCA | Form (sama dengan di atas) |
| Operation > Physical Inventory | `stock.quant` (inventory mode) | C | Form (adjustment) |
| Operation > Scrap | `stock.scrap` | C | Form (adjustment) |
| Operation > Replenishment | `stock.warehouse.orderpoint` | C | Form (adjustment, tidak sesuai) |
| Operation > Inventory Loss | `stock.move` ke lokasi Inventory Loss | C | Form (adjustment) |
| Report > Stock, Location, Move History, Move Analisis | `stock.quant`, `stock.move.line`, `stock.report` | C | Tabel palsu |

## 4. Manufacture (7 menu)

| Menu | Odoo | Edisi | Prototipe |
|---|---|---|---|
| Master > Bill of Material | `mrp.bom` | C | Form |
| Master > WorkCenter | `mrp.workcenter` | C | Form |
| Schedule Production | Planning produksi / Gantt | E? | Tabel palsu |
| Manufacturing Order | `mrp.production` | C | Form |
| Reporting > Production Analisis | `mrp.production` (pivot) | C | Tabel palsu |

Subcontracting (`mrp_subcontracting`) belum ada di menu KompakApps tetapi sudah ada di Kompak; pertimbangkan menambahkannya.

## 5. CRM (10 menu)

| Menu | Odoo | Edisi | Prototipe |
|---|---|---|---|
| Master > Master Customer | `res.partner` | C | Form |
| Master > Master Product/Service | `product.template` | C | Tabel palsu |
| Leads, Opportunity | `crm.lead` (type lead/opportunity) | C | Form (satu form untuk keduanya) |
| Reporting > Forecast, Pipeline, Activities | `crm.lead` (pivot, kanban) | C | Tabel palsu |
| Reporting > Leads | `crm.lead` | C | **Bug**: membuka form Lead, bukan laporan |

## 6. POS (11 menu)

| Menu | Odoo | Edisi | Prototipe |
|---|---|---|---|
| Master > Product, Customers | `product.template`, `res.partner` | C | Form |
| POS Station | `pos.config` | C | Form |
| POS Order | `pos.order` | C | Form (memakai form Session, tidak sesuai) |
| POS Session | `pos.session` | C | Form |
| Promotion & Loyalty | `loyalty.program` | C | Form |
| Report > POS Order Report, Session Details, Sales Details | `report.pos.order` | C | Tabel palsu |

## 7. Sales (14 menu)

| Menu | Odoo | Edisi | Prototipe |
|---|---|---|---|
| Master > Product, Customers, Promotion | lihat di atas | C | Form |
| Master > Pricelis Master | `product.pricelist` | C | Form (salah ketik pada judul menu) |
| Quotations, Sales Orders | `sale.order` (satu model, status berbeda) | C | **Tidak ada form** |
| Create Customer Invoice | `account.move` (out_invoice) | C | Form |
| Report > SO line, SO Analisis, Sales Person, Product, Commissions | `sale.report`; komisi butuh OCA `sale_commission` | C/OCA | Tabel palsu |

## 8. Accounting (36 menu)
Bagian terbesar dan paling berisiko untuk target "enterprise". Verifikasi ketersediaan Asset, Budget, bank sync, dan laporan lengkap sebelum menjanjikan fitur.

| Menu | Odoo | Edisi | Prototipe |
|---|---|---|---|
| Master > Chart of Account | `account.account` | C | Tabel palsu |
| Master > Customer Master | `res.partner` | C | **Bug**: tidak terhubung ke form (kunci `Customer Master` tidak ada di `formMapping`) |
| Master > Vendor Master, Product Master | lihat di atas | C | Form |
| Master > Tax Master | `account.tax` | C | Tabel palsu |
| Master > Currencies | `res.currency` | C | Tabel palsu |
| Master > Jurnal | `account.journal` | C | Tabel palsu |
| Master > Asset Model | `account.asset` | E? / OCA `account_asset_management` | Tabel palsu |
| Master > Budget Plan Master, Budget, Budget Report | `account.budget` / OCA `account_budget_oca` | E? / OCA | Tabel palsu |
| Master > Analitic Account | `account.analytic.account` | C | Tabel palsu |
| Customers > Customer Invoice, Credit Note | `account.move` (out_invoice, out_refund) | C | Form (satu form) |
| Customers > Customer Payment | `account.payment` | C | Form |
| Vendors > Vendor Bills, Vendor Payment | `account.move` (in_invoice), `account.payment` | C | Form |
| Vendors > Debit Note | `account.move` (in_refund) | C | **Tidak ada form** |
| Jurnal Entry | `account.move` (entry) | C | Form |
| Asset | `account.asset` | E? / OCA | Tabel palsu |
| Bank Transaction | `account.bank.statement`, rekonsiliasi | E? / OCA | Tabel palsu |
| Reporting (13 laporan): Balance Sheet, P&L, Cash Flow, General Ledger, Trial Balance, Partner Ledger, Aged Receivable/Payable, Tax Report, Invoice Analysis, Executive Summary, Analytic, Budget | Laporan bawaan Odoo atau OCA `account_financial_report` / MIS Builder | E? / OCA | Tabel palsu |

## 9. General Setting (2 menu)

| Menu | Odoo | Edisi | Prototipe |
|---|---|---|---|
| Company Setting | `res.company`, Settings | C | Tabel palsu |
| Users & Access | `res.users`, `res.groups`, record rules | C | Tabel palsu |

## Bug prototipe yang ditemukan

1. `formMapping` memakai **judul menu saja** sebagai kunci, sehingga judul yang sama di cabang berbeda saling bertabrakan. Contoh nyata: CRM > Reporting > "Leads" membuka form Lead. Perbaikan: gunakan path lengkap sebagai kunci.
2. Accounting > Master > "Customer Master" tidak punya mapping, padahal form-nya ada (`Customer_Master.html`).
3. Quotations, Sales Orders, dan Debit Note tidak punya form sama sekali.
4. Beberapa menu memakai form yang tidak sesuai: Replenishment dan Inventory Loss memakai form Adjustment; POS Order memakai form Session; RFQ memakai form PO; Credit Note memakai form Invoice.
5. Salah ketik dan campuran bahasa: "Analisis", "Analitic", "Jurnal", "Pricelis", "Good Receive".
