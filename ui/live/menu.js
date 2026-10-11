// Struktur menu Nusara: sama dengan sidebar prototipe (index.html, menuData). Menu yang punya `route`
// sudah terhubung ke Odoo; `odoo` mencatat model Odoo tujuannya (docs/MODULE_MAP.md) untuk halaman
// yang belum dibangun.
export const MENU = [
  {
    title: "Purchase Request", icon: "fas fa-file-signature",
    items: [
      { title: "Dashboard", route: "dashboard/pr" },
      { title: "Master", items: [{ title: "Product Master", route: "product?state=purchase" }] },
      { title: "Purchase Request", route: "pr" },
      { title: "Report", items: [{ title: "Purchase Request Line", route: "analysis/prline" }, { title: "Purchase Request Analisis", route: "analysis/pranalysis" }] },
      { title: "Setting", route: "modsetting/pr" },
    ],
  },
  {
    title: "Purchase", icon: "fas fa-shopping-cart",
    items: [
      { title: "Dashboard", route: "dashboard/purchase" },
      { title: "Master", items: [{ title: "Vendor Master", route: "vendor" }, { title: "Vendor Price list", route: "pricelist" }, { title: "Product Master", route: "product?state=purchase" }] },
      { title: "Request for Quotation", route: "po?state=rfq" },
      { title: "Purchase Order", route: "po?state=purchase" },
      { title: "Create Vendor Bill", route: "bill?state=draft" },
      { title: "Report", items: [{ title: "Purchase Order line", route: "analysis/poline" }, { title: "Purchase Order Analisis", route: "analysis/poanalysis" }] },
      { title: "Setting", route: "modsetting/purchase" },
    ],
  },
  {
    title: "Inventory", icon: "fas fa-boxes",
    items: [
      { title: "Dashboard", route: "dashboard/inventory" },
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
        items: [{ title: "Stock", route: "stock/report" }, { title: "Location", route: "stock/location" }, { title: "Move History", route: "moves" }, { title: "Move Analisis", route: "analysis/moveanalysis" }],
      },
      { title: "Setting", route: "modsetting/inventory" },
    ],
  },
  {
    title: "Manufacture", icon: "fas fa-industry",
    items: [
      { title: "Dashboard", route: "dashboard/manufacture" },
      { title: "Master", items: [{ title: "Bill of Material", route: "bom" }, { title: "WorkCenter/workStation", route: "workcenter" }] },
      { title: "Schedule Production", route: "schedule" },
      { title: "Manufacturing Order", route: "mo" },
      { title: "Reporting", items: [{ title: "Production Analisis", route: "production" }] },
      { title: "Setting", route: "modsetting/manufacture" },
    ],
  },
  {
    title: "CRM", icon: "fas fa-handshake",
    items: [
      { title: "Dashboard", route: "dashboard/crm" },
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
      { title: "Dashboard", route: "dashboard/pos" },
      { title: "Master", items: [{ title: "Product Master", route: "product?state=sale" }, { title: "Customers Master", route: "customer" }] },
      { title: "POS Station", route: "posconfig" },
      { title: "Kasir", route: "kasir" },
      { title: "POS Order", route: "posorder" },
      { title: "POS Session", route: "possession" },
      { title: "Promotion & Loyalty", odoo: "loyalty.program" },
      { title: "Report", items: [{ title: "POS Order Report", route: "analysis/posreport" }, { title: "Session Details", route: "possession" }, { title: "Sales Details", route: "analysis/possales" }] },
      { title: "Setting", route: "modsetting/pos" },
    ],
  },
  {
    title: "Sales", icon: "fas fa-chart-line",
    items: [
      { title: "Dashboard", route: "dashboard/sales" },
      {
        title: "Master",
        items: [{ title: "Product Master", route: "product?state=sale" }, { title: "Customers Master", route: "customer" }, { title: "Promotion & Loyalty", odoo: "loyalty.program" }, { title: "Pricelis Master", route: "salespricelist" }],
      },
      { title: "Quotations", route: "sale?state=quotation" },
      { title: "Sales Orders", route: "sale?state=sale" },
      { title: "Create Customer Invoice", route: "invoice?state=draft" },
      {
        title: "Report",
        items: [{ title: "Sales Order line", route: "analysis/soline" }, { title: "Sales Order Analisis", route: "analysis/soanalysis" }, { title: "Sales Person", route: "analysis/salesperson" }, { title: "Product", route: "analysis/salesproduct" }, { title: "Commissions" }],
      },
      { title: "Setting", route: "modsetting/sales" },
    ],
  },
  {
    title: "Accounting", icon: "fas fa-calculator",
    items: [
      { title: "Dashboard", route: "dashboard/accounting" },
      {
        title: "Master",
        items: [
          { title: "Chart of Account", route: "account" }, { title: "Customer Master", route: "customer" }, { title: "Vendor Master", route: "vendor" },
          { title: "Product Master", route: "product?state=all" }, { title: "Product Category", route: "category" }, { title: "Tax Master", route: "tax" },
          { title: "Currencies", route: "currency" }, { title: "Jurnal", route: "journalmaster" }, { title: "Asset Model", route: "assetprofile" },
          { title: "Budget Plan Master", odoo: "account.budget" }, { title: "Analitic Account", route: "analytic" },
        ],
      },
      { title: "Customers", items: [{ title: "Customer Invoice", route: "invoice" }, { title: "Credit Note", route: "creditnote" }, { title: "Customer Payment", route: "payment?type=inbound" }] },
      { title: "Vendors", items: [{ title: "Vendor Bills", route: "bill" }, { title: "Debit Note", route: "debitnote" }, { title: "Vendor Payment", route: "payment?type=outbound" }] },
      { title: "Jurnal Entry", route: "journal" },
      { title: "Asset", route: "asset" },
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
      { title: "Setting", route: "modsetting/accounting" },
    ],
  },
  { title: "General Setting", icon: "fas fa-cog", items: [{ title: "Company Setting", route: "company" }, { title: "Users & Access", route: "users" }, { title: "Import Data", route: "dataimport" }] },
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
