// Struktur menu Nusara: sama dengan sidebar prototipe (index.html, menuData). Menu yang punya `route`
// sudah terhubung ke Odoo; `odoo` mencatat model Odoo tujuannya (docs/MODULE_MAP.md) untuk halaman
// yang belum dibangun.
export const MENU = [
  {
    title: "Purchase Request", icon: "fas fa-file-signature",
    items: [
      { title: "Dashboard" },
      { title: "Master", items: [{ title: "Product Master", route: "product?state=purchase" }] },
      { title: "Purchase Request", route: "pr" },
      { title: "Report", items: [{ title: "Purchase Request Line", odoo: "purchase.request.line" }, { title: "Purchase Request Analisis", odoo: "purchase.request.line" }] },
      { title: "Setting" },
    ],
  },
  {
    title: "Purchase", icon: "fas fa-shopping-cart",
    items: [
      { title: "Dashboard" },
      { title: "Master", items: [{ title: "Vendor Master", route: "vendor" }, { title: "Vendor Price list", route: "pricelist" }, { title: "Product Master", route: "product?state=purchase" }] },
      { title: "Request for Quotation", route: "po?state=rfq" },
      { title: "Purchase Order", route: "po?state=purchase" },
      { title: "Create Vendor Bill", route: "bill?state=draft" },
      { title: "Report", items: [{ title: "Purchase Order line", odoo: "purchase.order.line" }, { title: "Purchase Order Analisis", odoo: "purchase.report" }] },
      { title: "Setting" },
    ],
  },
  {
    title: "Inventory", icon: "fas fa-boxes",
    items: [
      { title: "Dashboard" },
      {
        title: "Master",
        items: [
          { title: "Product Master", route: "product?state=all" }, { title: "Product Category", route: "category" },
          { title: "Reorder Level", route: "orderpoint" }, { title: "Put away Rules", route: "putaway" },
          { title: "Unit of Measurement Master", route: "uom" }, { title: "Lot & Serial Number Master", route: "lot" },
          { title: "Warehouse & Location Master", route: "warehouse" },
        ],
      },
      {
        title: "Operation",
        items: [
          { title: "Material Request", route: "transfer?state=draft" }, { title: "Good Receive", route: "receipt" }, { title: "Return GR", route: "delivery?returns=1" },
          { title: "Delivery Order", route: "delivery" }, { title: "Return DO", route: "receipt?returns=1" }, { title: "Internal Transfer", route: "transfer" },
          { title: "Physical Inventory", route: "count" }, { title: "Replenishment", route: "replenish" },
          { title: "Scrap", route: "scrap" }, { title: "Inventory Loss", route: "moves?kind=loss" },
        ],
      },
      {
        title: "Report",
        items: [{ title: "Stock", route: "stock/report" }, { title: "Location", route: "stock/location" }, { title: "Move History", route: "moves" }, { title: "Move Analisis", odoo: "stock.report" }],
      },
      { title: "Setting" },
    ],
  },
  {
    title: "Manufacture", icon: "fas fa-industry",
    items: [
      { title: "Dashboard" },
      { title: "Master", items: [{ title: "Bill of Material", route: "bom" }, { title: "WorkCenter/workStation", route: "workcenter" }] },
      { title: "Schedule Production", route: "schedule" },
      { title: "Manufacturing Order", route: "mo" },
      { title: "Reporting", items: [{ title: "Production Analisis", route: "production" }] },
      { title: "Setting" },
    ],
  },
  {
    title: "CRM", icon: "fas fa-handshake",
    items: [
      { title: "Dashboard" },
      { title: "Master", items: [{ title: "Master Customer", route: "customer" }, { title: "Master Product/Service", route: "product?state=sale" }] },
      { title: "Leads", route: "lead" },
      { title: "Opportunity", route: "opportunity" },
      { title: "Reporting", items: [{ title: "Forecast", route: "crmreport/forecast" }, { title: "Pipeline", route: "crmreport/pipeline" }, { title: "Leads", route: "crmreport/leads" }, { title: "Activities", route: "crmreport/activities" }] },
      { title: "Setting", route: "crmsetting" },
    ],
  },
  {
    title: "POS", icon: "fas fa-cash-register",
    items: [
      { title: "Dashboard" },
      { title: "Master", items: [{ title: "Product Master", route: "product?state=sale" }, { title: "Customers Master", route: "customer" }] },
      { title: "POS Station", route: "posconfig" },
      { title: "Kasir", route: "kasir" },
      { title: "POS Order", route: "posorder" },
      { title: "POS Session", route: "possession" },
      { title: "Promotion & Loyalty", odoo: "loyalty.program" },
      { title: "Report", items: [{ title: "POS Order Report", odoo: "report.pos.order" }, { title: "Session Details", odoo: "pos.session" }, { title: "Sales Details", odoo: "report.pos.order" }] },
      { title: "Setting" },
    ],
  },
  {
    title: "Sales", icon: "fas fa-chart-line",
    items: [
      { title: "Dashboard" },
      {
        title: "Master",
        items: [{ title: "Product Master", route: "product?state=sale" }, { title: "Customers Master", route: "customer" }, { title: "Promotion & Loyalty", odoo: "loyalty.program" }, { title: "Pricelis Master", route: "salespricelist" }],
      },
      { title: "Quotations", route: "sale?state=quotation" },
      { title: "Sales Orders", route: "sale?state=sale" },
      { title: "Create Customer Invoice", route: "invoice?state=draft" },
      {
        title: "Report",
        items: [{ title: "Sales Order line", odoo: "sale.report" }, { title: "Sales Order Analisis", odoo: "sale.report" }, { title: "Sales Person", odoo: "sale.report" }, { title: "Product", odoo: "sale.report" }, { title: "Commissions" }],
      },
      { title: "Setting" },
    ],
  },
  {
    title: "Accounting", icon: "fas fa-calculator",
    items: [
      { title: "Dashboard" },
      {
        title: "Master",
        items: [
          { title: "Chart of Account", odoo: "account.account" }, { title: "Customer Master", route: "customer" }, { title: "Vendor Master", route: "vendor" },
          { title: "Product Master", route: "product?state=all" }, { title: "Product Category", route: "category" }, { title: "Tax Master", odoo: "account.tax" },
          { title: "Currencies", odoo: "res.currency" }, { title: "Jurnal", odoo: "account.journal" }, { title: "Asset Model", odoo: "account.asset" },
          { title: "Budget Plan Master", odoo: "account.budget" }, { title: "Analitic Account", odoo: "account.analytic.account" },
        ],
      },
      { title: "Customers", items: [{ title: "Customer Invoice", route: "invoice" }, { title: "Credit Note", route: "creditnote" }, { title: "Customer Payment", route: "payment?type=inbound" }] },
      { title: "Vendors", items: [{ title: "Vendor Bills", route: "bill" }, { title: "Debit Note", route: "debitnote" }, { title: "Vendor Payment", route: "payment?type=outbound" }] },
      { title: "Jurnal Entry", route: "journal" },
      { title: "Asset", odoo: "account.asset" },
      { title: "Budget", odoo: "account.budget" },
      { title: "Bank Transaction", route: "bank" },
      {
        title: "Reporting",
        items: [
          { title: "Balance Sheet", route: "report/neraca" }, { title: "Profit and Loss", route: "report/laba-rugi" },
          { title: "Cash Flow Statement", route: "report/arus-kas" }, { title: "General Ledger", route: "ledger/general" },
          { title: "Trial Balance", route: "report/neraca-saldo" }, { title: "Partner Ledger", route: "ledger/partner" },
          { title: "Aged Receivable", route: "aging/receivable" }, { title: "Aged Payable", route: "aging/payable" }, { title: "Tax Report", route: "acctreport/tax" },
          { title: "Invoice Analysis", route: "acctreport/invoice" }, { title: "Executive Summary", route: "report/ringkasan" }, { title: "Analytic Report", route: "acctreport/analytic" }, { title: "Budget Report" },
        ],
      },
      { title: "Setting" },
    ],
  },
  { title: "General Setting", icon: "fas fa-cog", items: [{ title: "Company Setting", odoo: "res.company" }, { title: "Users & Access", odoo: "res.users" }] },
];

/** Beri setiap simpul kunci berbasis indeks ("0", "0.1", "0.1.0"), dan hitung `mod` dari route. */
function annotate(items, prefix = "") {
  items.forEach((item, i) => {
    item.key = prefix ? `${prefix}.${i}` : String(i);
    if (item.route) item.mod = item.route.split("?")[0].split("/")[0];
    if (item.items) annotate(item.items, item.key);
  });
}
annotate(MENU);

export function flatten(items = MENU, trail = []) {
  return items.flatMap((item) => {
    const path = [...trail, item.title];
    return item.items ? flatten(item.items, path) : [{ ...item, path }];
  });
}
export const LEAVES = flatten();
export const findLeaf = (key) => LEAVES.find((l) => l.key === key) ?? null;
