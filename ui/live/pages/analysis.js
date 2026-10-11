// Laporan analisis untuk menu Report di modul Purchase Request, Purchase, Inventory, Sales, dan POS. Satu mesin melayani dua bentuk:
// "kelompok" (ringkasan per dimensi dengan ukuran dan batang, pada rentang tanggal) dan "baris" (daftar baris dokumen dengan filter
// dan pencarian). Tiap laporan hanya konfigurasi model, dimensi, ukuran, dan kolom. Semua bisa diunduh sebagai CSV.
import { INPUT, app, call, dateText, dateTimeText, esc, filterSelect, money, pageHeader, searchBox, searchRead } from "../common.js";

const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 });
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const pad = (n) => String(n).padStart(2, "0");
const todayText = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const yearStart = () => `${new Date().getFullYear()}-01-01`;
const num = (v) => nf.format(v ?? 0);
const FORMATS = { money: (v) => money(v), num };

const SELECTION_LABELS = {
  state: { draft: "Draft", sent: "Terkirim", "to approve": "Menunggu persetujuan", purchase: "Dikonfirmasi", sale: "Dikonfirmasi", done: "Selesai", cancel: "Dibatalkan", paid: "Dibayar", invoiced: "Difaktur" },
  request_state: { draft: "Draft", to_approve: "Menunggu persetujuan", approved: "Disetujui", in_progress: "Dalam proses", done: "Selesai", rejected: "Ditolak" },
};

/* ---------- Konfigurasi laporan ---------- */

const GROUP = (cfg) => ({ mode: "group", ...cfg });
const LINES = (cfg) => ({ mode: "lines", ...cfg });

const PURCHASE_DIMS = {
  month: { label: "Bulan", by: "date_order:month" }, partner_id: { label: "Vendor", by: "partner_id" }, product_id: { label: "Produk", by: "product_id" },
  category_id: { label: "Kategori Produk", by: "category_id" }, user_id: { label: "Pembeli", by: "user_id" },
};
const SALES_MEASURES = [
  { agg: "__count", label: "Baris", fmt: "num" }, { agg: "product_uom_qty:sum", label: "Dipesan", fmt: "num" }, { agg: "qty_delivered:sum", label: "Dikirim", fmt: "num" },
  { agg: "qty_invoiced:sum", label: "Difaktur", fmt: "num" }, { agg: "price_subtotal:sum", label: "Sebelum Pajak", fmt: "money", bar: true }, { agg: "price_total:sum", label: "Termasuk Pajak", fmt: "money" },
];
const SALES_DIMS = {
  month: { label: "Bulan", by: "date:month" }, partner_id: { label: "Pelanggan", by: "partner_id" }, product_id: { label: "Produk", by: "product_id" }, categ_id: { label: "Kategori Produk", by: "categ_id" },
  user_id: { label: "Salesperson", by: "user_id" }, team_id: { label: "Tim Sales", by: "team_id" },
};
const POS_MEASURES = [
  { agg: "__count", label: "Baris", fmt: "num" }, { agg: "product_qty:sum", label: "Jumlah", fmt: "num" }, { agg: "total_discount:sum", label: "Diskon", fmt: "money" },
  { agg: "price_total:sum", label: "Total", fmt: "money", bar: true }, { agg: "margin:sum", label: "Margin", fmt: "money" },
];
const POS_DIMS = {
  day: { label: "Hari", by: "date:day" }, month: { label: "Bulan", by: "date:month" }, product_id: { label: "Produk", by: "product_id" }, product_categ_id: { label: "Kategori Produk", by: "product_categ_id" },
  user_id: { label: "Kasir", by: "user_id" }, config_id: { label: "Stasiun", by: "config_id" }, partner_id: { label: "Pelanggan", by: "partner_id" }, session_id: { label: "Sesi", by: "session_id" },
};

export const REPORTS = {
  prline: LINES({
    title: "Purchase Request Line", model: "purchase.request.line", dateField: "date_required", datetime: false, order: "date_required desc, id desc",
    fields: ["request_id", "product_id", "name", "product_qty", "product_uom_id", "date_required", "requested_by", "purchased_qty", "estimated_cost", "request_state"],
    search: ["name", "product_id.name", "request_id.name"], state: { field: "request_state", options: Object.entries(SELECTION_LABELS.request_state) },
    columns: [
      { label: "PR", value: (r) => `<a href="#/pr/${r.request_id[0]}" class="text-indigo-700 hover:underline">${esc(r.request_id[1])}</a>`, raw: true },
      { label: "Produk", value: (r) => esc(r.product_id?.[1] || r.name), raw: true }, { label: "Jumlah", value: (r) => `${num(r.product_qty)} ${esc(r.product_uom_id?.[1] ?? "")}`, right: true, raw: true },
      { label: "Dibutuhkan", value: (r) => esc(r.date_required ? dateText(r.date_required) : "-"), raw: true }, { label: "Pemohon", value: (r) => esc(r.requested_by?.[1] ?? "-"), raw: true },
      { label: "Sudah Dibeli", value: (r) => num(r.purchased_qty), right: true }, { label: "Estimasi", value: (r) => money(r.estimated_cost), right: true },
      { label: "Status", value: (r) => esc(SELECTION_LABELS.request_state[r.request_state] ?? r.request_state), raw: true },
    ],
  }),
  pranalysis: GROUP({
    title: "Purchase Request Analisis", model: "purchase.request.line", dateField: "date_required", datetime: false, base: [],
    dims: { month: { label: "Bulan Dibutuhkan", by: "date_required:month" }, product_id: { label: "Produk", by: "product_id" }, requested_by: { label: "Pemohon", by: "requested_by" }, request_state: { label: "Status", by: "request_state" } },
    dim: "month",
    measures: [{ agg: "__count", label: "Baris", fmt: "num" }, { agg: "product_qty:sum", label: "Jumlah Diminta", fmt: "num" }, { agg: "estimated_cost:sum", label: "Estimasi Biaya", fmt: "money", bar: true }],
    note: "Berdasarkan tanggal dibutuhkan pada baris Purchase Request. Jumlah yang sudah dibeli per baris ada di Purchase Request Line (tidak bisa dijumlahkan di Odoo).",
  }),
  poline: LINES({
    title: "Purchase Order Line", model: "purchase.order.line", dateField: "date_order", datetime: true, order: "date_order desc, id desc",
    fields: ["order_id", "partner_id", "product_id", "name", "product_qty", "qty_received", "qty_invoiced", "price_unit", "price_subtotal", "state", "date_order"],
    search: ["name", "product_id.name", "order_id.name", "partner_id.name"], state: { field: "state", options: [["draft", "Draft"], ["sent", "Terkirim"], ["purchase", "Dikonfirmasi"], ["done", "Terkunci"], ["cancel", "Dibatalkan"]] },
    columns: [
      { label: "PO", value: (r) => `<a href="#/po/${r.order_id[0]}" class="text-indigo-700 hover:underline">${esc(r.order_id[1])}</a>`, raw: true }, { label: "Vendor", value: (r) => esc(r.partner_id?.[1] ?? "-"), raw: true },
      { label: "Produk", value: (r) => esc(r.product_id?.[1] || r.name), raw: true }, { label: "Dipesan", value: (r) => num(r.product_qty), right: true }, { label: "Diterima", value: (r) => num(r.qty_received), right: true },
      { label: "Ditagih", value: (r) => num(r.qty_invoiced), right: true }, { label: "Harga", value: (r) => money(r.price_unit), right: true }, { label: "Subtotal", value: (r) => money(r.price_subtotal), right: true },
    ],
  }),
  poanalysis: GROUP({
    title: "Purchase Order Analisis", model: "purchase.report", dateField: "date_order", datetime: true, base: [["state", "in", ["purchase", "done"]]], dims: PURCHASE_DIMS, dim: "month",
    measures: [
      { agg: "__count", label: "Baris", fmt: "num" }, { agg: "qty_ordered:sum", label: "Dipesan", fmt: "num" }, { agg: "qty_received:sum", label: "Diterima", fmt: "num" }, { agg: "qty_billed:sum", label: "Ditagih", fmt: "num" },
      { agg: "untaxed_total:sum", label: "Sebelum Pajak", fmt: "money", bar: true }, { agg: "price_total:sum", label: "Termasuk Pajak", fmt: "money" },
    ],
    note: "Hanya Purchase Order yang sudah dikonfirmasi.",
  }),
  moveanalysis: GROUP({
    title: "Move Analisis", model: "stock.move.line", dateField: "date", datetime: true, base: [["state", "=", "done"]],
    dims: { month: { label: "Bulan", by: "date:month" }, product_id: { label: "Produk", by: "product_id" }, product_category_name: { label: "Kategori Produk", by: "product_category_name" }, picking_partner_id: { label: "Mitra", by: "picking_partner_id" }, location_id: { label: "Dari Lokasi", by: "location_id" }, location_dest_id: { label: "Ke Lokasi", by: "location_dest_id" }, lot_id: { label: "Lot/Serial", by: "lot_id" } },
    dim: "month", measures: [{ agg: "__count", label: "Baris", fmt: "num" }, { agg: "quantity:sum", label: "Jumlah", fmt: "num", bar: true }],
    filter: { key: "dir", label: "Semua arah", options: [["in", "Masuk ke gudang"], ["out", "Keluar dari gudang"], ["adjust", "Penyesuaian dan scrap"]], domain: (v) =>
      v === "in" ? [["location_id.usage", "!=", "internal"], ["location_dest_id.usage", "=", "internal"], ["location_id.usage", "!=", "inventory"]]
        : v === "out" ? [["location_id.usage", "=", "internal"], ["location_dest_id.usage", "!=", "internal"], ["location_dest_id.usage", "!=", "inventory"]]
          : ["|", ["location_id.usage", "=", "inventory"], ["location_dest_id.usage", "=", "inventory"]] },
    note: "Pergerakan stok yang sudah selesai.",
  }),
  soline: LINES({
    title: "Sales Order Line", model: "sale.order.line", dateField: "order_id.date_order", datetime: true, order: "id desc",
    fields: ["order_id", "order_partner_id", "product_id", "name", "product_uom_qty", "qty_delivered", "qty_invoiced", "price_unit", "discount", "price_subtotal", "state"],
    search: ["name", "product_id.name", "order_id.name", "order_partner_id.name"], state: { field: "state", options: [["draft", "Draft"], ["sent", "Terkirim"], ["sale", "Dikonfirmasi"], ["cancel", "Dibatalkan"]] },
    columns: [
      { label: "SO", value: (r) => `<a href="#/sale/${r.order_id[0]}" class="text-indigo-700 hover:underline">${esc(r.order_id[1])}</a>`, raw: true }, { label: "Pelanggan", value: (r) => esc(r.order_partner_id?.[1] ?? "-"), raw: true },
      { label: "Produk", value: (r) => esc(r.product_id?.[1] || r.name), raw: true }, { label: "Dipesan", value: (r) => num(r.product_uom_qty), right: true }, { label: "Dikirim", value: (r) => num(r.qty_delivered), right: true },
      { label: "Difaktur", value: (r) => num(r.qty_invoiced), right: true }, { label: "Harga", value: (r) => money(r.price_unit), right: true }, { label: "Diskon", value: (r) => (r.discount ? `${num(r.discount)}%` : "-"), right: true },
      { label: "Subtotal", value: (r) => money(r.price_subtotal), right: true },
    ],
  }),
  soanalysis: GROUP({ title: "Sales Order Analisis", model: "sale.report", dateField: "date", datetime: true, base: [["state", "in", ["sale", "done"]]], dims: SALES_DIMS, dim: "month", measures: SALES_MEASURES, note: "Sales Order yang sudah dikonfirmasi, ditambah penjualan kasir POS: Odoo menggabungkan keduanya pada laporan penjualan. Baris Sales Order saja ada di Sales Order Line." }),
  salesperson: GROUP({
    title: "Sales Person", model: "sale.report", dateField: "date", datetime: true, base: [["state", "in", ["sale", "done"]]], dims: { user_id: SALES_DIMS.user_id, team_id: SALES_DIMS.team_id, month: SALES_DIMS.month }, dim: "user_id",
    measures: SALES_MEASURES, note: "Penjualan per salesperson dan tim, termasuk penjualan kasir POS. Komisi tidak dihitung di Odoo Community.",
  }),
  salesproduct: GROUP({
    title: "Penjualan per Produk", model: "sale.report", dateField: "date", datetime: true, base: [["state", "in", ["sale", "done"]]], dims: { product_id: SALES_DIMS.product_id, categ_id: SALES_DIMS.categ_id, month: SALES_DIMS.month }, dim: "product_id",
    measures: SALES_MEASURES, note: "Penjualan per produk dan kategori dari Sales Order yang sudah dikonfirmasi, termasuk penjualan kasir POS.",
  }),
  posreport: GROUP({
    title: "POS Order Report", model: "report.pos.order", dateField: "date", datetime: true, base: [["state", "in", ["paid", "done", "invoiced"]]], dims: POS_DIMS, dim: "day", measures: POS_MEASURES,
    note: "Dari pesanan POS yang sudah dibayar; jurnal penjualan tercipta saat sesi ditutup.",
  }),
  possales: GROUP({
    title: "Sales Details", model: "report.pos.order", dateField: "date", datetime: true, base: [["state", "in", ["paid", "done", "invoiced"]]], dims: { product_id: POS_DIMS.product_id, product_categ_id: POS_DIMS.product_categ_id, config_id: POS_DIMS.config_id, user_id: POS_DIMS.user_id }, dim: "product_id",
    measures: POS_MEASURES, note: "Penjualan kasir per produk, kategori, stasiun, atau kasir.",
  }),
};

/* ---------- Drill-down: kolom baris rincian untuk laporan kelompok ---------- */
// Rincian dibaca dari model yang sama dengan ringkasannya (domain yang sama ditambah `__extra_domain` kelompok dari Odoo), jadi jumlah
// baris rincian selalu sama dengan angka kelompoknya. Setiap baris menautkan ke dokumennya.

const docLink = (href, text) => `<a href="${esc(href)}" class="text-indigo-700 hover:underline">${esc(text)}</a>`;
const stamp = (v) => (v ? dateText(v) : "-");
const cellText = (get) => (r) => get(r) || "-";

const PURCHASE_DRILL = {
  fields: ["order_id", "partner_id", "product_id", "category_id", "qty_ordered", "qty_received", "qty_billed", "untaxed_total", "price_total", "date_order"],
  order: "date_order desc, id desc",
  columns: [
    { label: "PO", value: (r) => docLink(`#/po/${r.order_id[0]}`, r.order_id[1]), raw: true }, { label: "Tanggal", value: (r) => stamp(r.date_order) },
    { label: "Vendor", value: cellText((r) => r.partner_id?.[1]) }, { label: "Produk", value: cellText((r) => r.product_id?.[1]) },
    { label: "Dipesan", value: (r) => num(r.qty_ordered), right: true }, { label: "Diterima", value: (r) => num(r.qty_received), right: true }, { label: "Ditagih", value: (r) => num(r.qty_billed), right: true },
    { label: "Sebelum Pajak", value: (r) => money(r.untaxed_total), right: true }, { label: "Termasuk Pajak", value: (r) => money(r.price_total), right: true },
  ],
};
const orderLink = (r) => {
  const [model, id] = String(r.order_reference || "").split(",");
  const route = model === "sale.order" ? "sale" : model === "pos.order" ? "posorder" : "";
  return route && id ? docLink(`#/${route}/${id}`, r.name || "-") : esc(r.name || "-");
};
const SALES_DRILL = {
  fields: ["name", "order_reference", "date", "partner_id", "product_id", "product_uom_qty", "qty_delivered", "qty_invoiced", "price_subtotal", "price_total"],
  order: "date desc, id desc",
  columns: [
    { label: "Pesanan", value: orderLink, raw: true }, { label: "Tanggal", value: (r) => stamp(r.date) }, { label: "Pelanggan", value: cellText((r) => r.partner_id?.[1]) }, { label: "Produk", value: cellText((r) => r.product_id?.[1]) },
    { label: "Dipesan", value: (r) => num(r.product_uom_qty), right: true }, { label: "Dikirim", value: (r) => num(r.qty_delivered), right: true }, { label: "Difaktur", value: (r) => num(r.qty_invoiced), right: true },
    { label: "Sebelum Pajak", value: (r) => money(r.price_subtotal), right: true }, { label: "Termasuk Pajak", value: (r) => money(r.price_total), right: true },
  ],
};
const POS_DRILL = {
  fields: ["order_id", "date", "partner_id", "product_id", "product_qty", "total_discount", "price_total", "margin"],
  order: "date desc, id desc",
  columns: [
    { label: "Pesanan POS", value: (r) => (r.order_id ? docLink(`#/posorder/${r.order_id[0]}`, r.order_id[1]) : "-"), raw: true }, { label: "Tanggal", value: (r) => stamp(r.date) },
    { label: "Pelanggan", value: cellText((r) => r.partner_id?.[1]) }, { label: "Produk", value: cellText((r) => r.product_id?.[1]) }, { label: "Jumlah", value: (r) => num(r.product_qty), right: true },
    { label: "Diskon", value: (r) => money(r.total_discount), right: true }, { label: "Total", value: (r) => money(r.price_total), right: true }, { label: "Margin", value: (r) => money(r.margin), right: true },
  ],
};
const PICKING_PAGES = { incoming: "receipt", outgoing: "delivery", internal: "transfer" };
const MOVE_DRILL = {
  fields: ["date", "reference", "product_id", "lot_id", "location_id", "location_dest_id", "quantity", "product_uom_id", "picking_id", "picking_code", "production_id", "move_id"],
  order: "date desc, id desc",
  // Dokumen sumber: transfer (penerimaan, pengiriman, internal) atau Manufacturing Order (juga untuk bahan baku, yang tertaut lewat pergerakan stoknya).
  async prepare(rows) {
    const pending = rows.filter((r) => !(r.picking_id && PICKING_PAGES[r.picking_code]) && !r.production_id && r.move_id).map((r) => r.move_id[0]);
    const moves = pending.length ? await searchRead("stock.move", [["id", "in", [...new Set(pending)]]], ["production_id", "raw_material_production_id"]) : [];
    const orders = new Map(moves.map((m) => [m.id, m.production_id || m.raw_material_production_id || null]));
    for (const r of rows) {
      const order = r.production_id || orders.get(r.move_id?.[0]);
      if (r.picking_id && PICKING_PAGES[r.picking_code]) r.doc = { href: `#/${PICKING_PAGES[r.picking_code]}/${r.picking_id[0]}`, text: r.picking_id[1] };
      else if (order) r.doc = { href: `#/mo/${order[0]}`, text: order[1] };
    }
  },
  columns: [
    { label: "Tanggal", value: (r) => (r.date ? dateTimeText(r.date) : "-") },
    { label: "Dokumen", value: (r) => (r.doc ? docLink(r.doc.href, r.doc.text) : esc(r.reference || "-")), raw: true },
    { label: "Produk", value: cellText((r) => r.product_id?.[1]) }, { label: "Lot/Serial", value: (r) => r.lot_id?.[1] ?? "" }, { label: "Dari", value: cellText((r) => r.location_id?.[1]) }, { label: "Ke", value: cellText((r) => r.location_dest_id?.[1]) },
    { label: "Jumlah", value: (r) => `${num(r.quantity)} ${r.product_uom_id?.[1] ?? ""}`, right: true },
  ],
};
REPORTS.pranalysis.drill = { fields: REPORTS.prline.fields, order: REPORTS.prline.order, columns: REPORTS.prline.columns };
REPORTS.poanalysis.drill = PURCHASE_DRILL;
REPORTS.moveanalysis.drill = MOVE_DRILL;
for (const key of ["soanalysis", "salesperson", "salesproduct"]) REPORTS[key].drill = SALES_DRILL;
for (const key of ["posreport", "possales"]) REPORTS[key].drill = POS_DRILL;

/* ---------- Periode pembanding ---------- */

export const COMPARISONS = { prev: "Periode sebelumnya", year: "Tahun lalu" };
const DRILL_LIMIT = 300;
const pf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 });

// Aritmetika tanggal dalam UTC (tanpa zona waktu), untuk rentang pembanding dan penyelarasan bucket bulan atau hari.
const dayNumber = (value) => {
  const [y, m, d] = value.slice(0, 10).split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
};
const dayText = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
const monthNumber = (value) => {
  const [y, m] = value.slice(0, 7).split("-").map(Number);
  return y * 12 + m - 1;
};
const monthText = (n) => `${Math.floor(n / 12)}-${pad((n % 12) + 1)}-01`;
const shiftYear = (value, years) => {
  const [y, m, d] = value.slice(0, 10).split("-").map(Number);
  const lastDay = new Date(Date.UTC(y + years, m, 0)).getUTCDate();
  return `${y + years}-${pad(m)}-${pad(Math.min(d, lastDay))}`;
};

/** Rentang pembanding: "prev" = rentang selama sama tepat sebelum `from`; "year" = rentang yang sama setahun lalu. */
export function compareRange(from, to, mode) {
  if (mode === "year") return { from: shiftYear(from, -1), to: shiftYear(to, -1) };
  const days = dayNumber(to) - dayNumber(from) + 1;
  if (mode !== "prev" || days < 1) return null;
  const end = dayNumber(from) - 1;
  return { from: dayText(end - days + 1), to: dayText(end) };
}

/** Selisih dan persen terhadap pembanding; persen kosong (null) bila pembanding nol. */
export function delta(now, before) {
  const diff = Math.round((now - before) * 100) / 100;
  return { diff, pct: before ? Math.round((diff / Math.abs(before)) * 10000) / 100 : null };
}
const signed = (value, body) => (value > 0 ? `+${body}` : value < 0 ? `-${body}` : body);
const tone = (value) => (value > 0 ? "text-emerald-700" : value < 0 ? "text-rose-700" : "text-gray-500");
const pctText = (pct, now) => (pct === null ? (now ? "baru" : "-") : signed(pct, `${pf.format(Math.abs(pct))}%`));

/* ---------- Mesin ---------- */

let last = { sub: "prline", query: new URLSearchParams() };
let exportRows = [];
let exportName = "";
export const leave = () => {
  exportRows = [];
};

const monthLabel = (key) => `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
const dayLabel = (key) => dateText(key.slice(0, 10));
const utc = (value, end) => `${value} ${end ? "23:59:59" : "00:00:00"}`;
const timeUnit = (by) => (by.endsWith(":month") ? "month" : by.endsWith(":day") ? "day" : "");
/** Kunci kelompok yang stabil dan aman di URL: id relasi, nilai pilihan, tanggal bucket, atau "false" bila kosong. */
const groupKey = (by, value) => (Array.isArray(value) ? (timeUnit(by) ? String(value[0]).slice(0, 10) : String(value[0])) : value === false || value == null ? "false" : String(value));

export async function render(sub, query) {
  const key = REPORTS[sub] ? sub : "prline";
  last = { sub: key, query };
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat laporan...</p>';
  const cfg = REPORTS[key];
  const from = query.get("from") ?? yearStart();
  const to = query.get("to") ?? todayText();
  exportName = "";
  const view = cfg.mode !== "group" ? renderLines : cfg.drill && query.get("d") !== null ? renderDrill : renderGroup;
  const body = await view(cfg, query, from, to);
  const dates = `<label class="text-xs font-medium text-gray-500 uppercase">Dari<input type="date" data-an="from" value="${esc(from)}" class="${INPUT} mt-1 w-40"></label>
    <label class="text-xs font-medium text-gray-500 uppercase">Sampai<input type="date" data-an="to" value="${esc(to)}" class="${INPUT} mt-1 w-40"></label>`;
  app.innerHTML = pageHeader(cfg.title, `${body.controls ?? ""}${dates}<button type="button" data-action="csv" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50"><i class="fas fa-download mr-2"></i>Unduh CSV</button>`) + body.html;
}

const dateDomain = (cfg, from, to) => [[cfg.dateField, ">=", cfg.datetime === false ? from : utc(from)], [cfg.dateField, "<=", cfg.datetime === false ? to : utc(to, true)]];

/** Dimensi terpilih dan domain dasar (status, filter) sebuah laporan kelompok. */
function groupSetup(cfg, query) {
  const dimKey = cfg.dims[query.get("by")] ? query.get("by") : cfg.dim;
  const filter = cfg.filter && query.get(cfg.filter.key) ? cfg.filter.domain(query.get(cfg.filter.key)) : [];
  return { dimKey, dim: cfg.dims[dimKey], base: [...cfg.base, ...filter] };
}
const readGroups = (cfg, dim, base, from, to, aggregates) => call(cfg.model, "formatted_read_group", { domain: [...base, ...dateDomain(cfg, from, to)], groupby: [dim.by], aggregates });
const readMeta = async (cfg, dim) => {
  const field = dim.by.split(":")[0];
  return (await call(cfg.model, "fields_get", { allfields: [field], attributes: ["type", "selection"] }))[field];
};
function labeler(dim, meta) {
  const selection = new Map((meta?.selection ?? []).map(([k, l]) => [k, l]));
  return (v) => {
    if (Array.isArray(v)) return dim.by.endsWith(":month") ? monthLabel(String(v[0])) : dim.by.endsWith(":day") ? dayLabel(String(v[0])) : v[1];
    if (typeof v === "string" && v) return SELECTION_LABELS[dim.by]?.[v] ?? selection.get(v) ?? v;
    return "Tanpa data";
  };
}
/** Alamat laporan ini dengan parameter yang sama; `extra` menimpa (null menghapus). */
function hashWith(query, from, to, dimKey, extra) {
  const params = new URLSearchParams(query);
  params.set("by", dimKey);
  params.set("from", from);
  params.set("to", to);
  for (const [k, v] of Object.entries(extra)) {
    if (v === null) params.delete(k);
    else params.set(k, v);
  }
  return `#/analysis/${last.sub}?${params}`;
}
const statCard = (label, value, extra = "") => `<div class="bg-white rounded-xl border border-gray-200 shadow-sm p-4"><div class="text-xs font-medium text-gray-500 uppercase">${esc(label)}</div><div class="text-xl font-semibold mt-1">${esc(value)}</div>${extra}</div>`;

async function renderGroup(cfg, query, from, to) {
  const { dimKey, dim, base } = groupSetup(cfg, query);
  const aggregates = cfg.measures.map((m) => m.agg);
  const mode = COMPARISONS[query.get("cmp")] ? query.get("cmp") : "";
  const range = mode ? compareRange(from, to, mode) : null;
  const [rows, priorRows, meta] = await Promise.all([
    readGroups(cfg, dim, base, from, to, aggregates), range ? readGroups(cfg, dim, base, range.from, range.to, aggregates) : [], readMeta(cfg, dim),
  ]);
  const labelOf = labeler(dim, meta);
  const unit = timeUnit(dim.by);
  const entry = (r) => ({ id: groupKey(dim.by, r[dim.by]), label: labelOf(r[dim.by]), values: aggregates.map((a) => r[a] ?? 0) });
  const barIndex = Math.max(0, cfg.measures.findIndex((m) => m.bar));
  const cmParam = query.get("cm") ?? "";
  const cm = /^\d+$/.test(cmParam) && cfg.measures[Number(cmParam)] ? Number(cmParam) : barIndex;
  const list = rows.map((r) => ({ ...entry(r), current: true }));
  let priorTotals = null;
  if (range) {
    // Bucket waktu dipasangkan menurut urutan dari awal rentang masing-masing; dimensi lain menurut nilainya (id atau pilihan).
    const prior = priorRows.map(entry);
    priorTotals = cfg.measures.map((_, i) => prior.reduce((s, e) => s + e.values[i], 0));
    const [number, bucketText, labelFor] = unit === "month" ? [monthNumber, monthText, monthLabel] : [dayNumber, dayText, dayLabel];
    const startNow = unit ? number(from) : 0;
    const startPrior = unit ? number(range.from) : 0;
    const buckets = unit ? number(to) - startNow + 1 : 0;
    const slot = (e, start) => (unit ? String(number(e.id) - start) : e.id);
    const slots = new Map(list.map((e) => [slot(e, startNow), e]));
    for (const p of prior) {
      const s = slot(p, startPrior);
      let e = slots.get(s);
      if (!e) {
        // Bucket pembanding tanpa pasangan: di dalam rentang ini dipasang pada bucketnya (nilai 0), di luar rentang ditandai tersendiri dan ditaruh paling bawah.
        const id = unit ? bucketText(startNow + Number(s)) : p.id;
        const outside = unit && Number(s) >= buckets;
        e = { id, label: outside ? `${p.label} (pembanding)` : unit ? labelFor(id) : p.label, values: cfg.measures.map(() => 0), current: false, outside };
        slots.set(s, e);
        list.push(e);
      }
      e.prior = p.values;
      if (unit && !e.outside) e.priorLabel = p.label;
    }
  }
  list.sort((a, b) => (a.outside ? 1 : 0) - (b.outside ? 1 : 0) || (unit ? (a.id < b.id ? 1 : -1) : b.values[barIndex] - a.values[barIndex] || (b.prior?.[barIndex] ?? 0) - (a.prior?.[barIndex] ?? 0)));
  const max = Math.max(1, ...list.map((r) => Math.abs(r.values[barIndex])));
  const totals = cfg.measures.map((_, i) => list.reduce((s, r) => s + r.values[i], 0));
  const cmpMeasure = cfg.measures[cm];
  const cmpCells = (now, before, bold = "") => {
    const { diff, pct } = delta(now, before);
    const classes = `py-2 px-4 text-sm text-right tabular-nums ${bold}`;
    return `<td class="${classes} text-gray-600">${esc(FORMATS[cmpMeasure.fmt](before))}</td><td class="${classes} ${tone(diff)}">${esc(signed(diff, FORMATS[cmpMeasure.fmt](Math.abs(diff))))}</td><td class="${classes} ${tone(diff)}">${esc(pctText(pct, now))}</td>`;
  };
  const head = [dim.label, ...cfg.measures.map((m) => m.label)];
  const compareHead = range ? [`${cmpMeasure.label} (pembanding)`, "Selisih", "Persen"] : [];
  exportRows = [
    [...head, ...compareHead],
    ...list.map((r) => {
      if (!range) return [r.label, ...r.values];
      const { diff, pct } = delta(r.values[cm], r.prior?.[cm] ?? 0);
      return [r.label, ...r.values, r.prior?.[cm] ?? 0, diff, pct ?? ""];
    }),
  ];
  const labelCell = (r) => {
    const link = cfg.drill && r.current ? `<a href="${esc(hashWith(query, from, to, dimKey, { d: r.id }))}" class="text-indigo-700 hover:underline" title="Lihat baris rincian">${esc(r.label)}</a>` : esc(r.label);
    return link + (r.priorLabel ? `<div class="text-xs text-gray-400">vs ${esc(r.priorLabel)}</div>` : "");
  };
  const rowsHtml = list
    .map(
      (r) => `<tr><td class="py-2 px-4 text-sm">${labelCell(r)}</td>${r.values
        .map((v, i) => `<td class="py-2 px-4 text-sm text-right tabular-nums">${esc(FORMATS[cfg.measures[i].fmt](v))}</td>`)
        .join("")}${range ? cmpCells(r.values[cm], r.prior?.[cm] ?? 0) : ""}<td class="py-2 px-4 w-1/6"><div class="h-3 bg-gray-100 rounded"><div class="h-3 ${r.values[barIndex] < 0 ? "bg-rose-400" : "bg-indigo-500"} rounded" style="width:${Math.round((Math.abs(r.values[barIndex]) / max) * 100)}%"></div></div></td></tr>`,
    )
    .join("");
  const cards = cfg.measures
    .slice(0, 4)
    .map((m, i) => {
      if (!range) return statCard(m.label, FORMATS[m.fmt](totals[i]));
      const { diff, pct } = delta(totals[i], priorTotals[i]);
      return statCard(m.label, FORMATS[m.fmt](totals[i]), `<div class="text-xs mt-1 ${tone(diff)}">${esc(signed(diff, FORMATS[m.fmt](Math.abs(diff))))} (${esc(pctText(pct, totals[i]))}) <span class="text-gray-500">dari ${esc(FORMATS[m.fmt](priorTotals[i]))}</span></div>`);
    })
    .join("");
  const dimSelect = `<select data-an="by" class="${INPUT} w-48" aria-label="Kelompokkan menurut">${Object.entries(cfg.dims).map(([k, d]) => `<option value="${esc(k)}" ${k === dimKey ? "selected" : ""}>${esc(d.label)}</option>`).join("")}</select>`;
  const filterSelectHtml = cfg.filter
    ? `<select data-an="${esc(cfg.filter.key)}" class="${INPUT} w-52" aria-label="${esc(cfg.filter.label)}"><option value="">${esc(cfg.filter.label)}</option>${cfg.filter.options.map(([k, l]) => `<option value="${esc(k)}" ${query.get(cfg.filter.key) === k ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`
    : "";
  const compareSelect = `<select data-an="cmp" class="${INPUT} w-56" aria-label="Bandingkan dengan"><option value="">Tanpa perbandingan</option>${Object.entries(COMPARISONS).map(([k, l]) => `<option value="${k}" ${k === mode ? "selected" : ""}>Bandingkan: ${esc(l)}</option>`).join("")}</select>`;
  const measureSelect = range
    ? `<select data-an="cm" class="${INPUT} w-48" aria-label="Ukuran pembanding">${cfg.measures.map((m, i) => `<option value="${i}" ${i === cm ? "selected" : ""}>Ukuran: ${esc(m.label)}</option>`).join("")}</select>`
    : "";
  const compareNote = range
    ? `<p class="mt-3 text-xs text-gray-500">Pembanding: ${esc(COMPARISONS[mode])}, ${esc(dateText(range.from))} sampai ${esc(dateText(range.to))}. Selisih dan persen dihitung dari ukuran terpilih (periode ini dikurangi pembanding; "baru" bila pembanding nol).${unit ? " Bucket waktu dipasangkan menurut urutan dari awal rentang." : ""}</p>`
    : mode
      ? '<p class="mt-3 text-xs text-gray-500">Rentang tanggal tidak valid untuk perbandingan.</p>'
      : "";
  return {
    controls: `${dimSelect}${filterSelectHtml}${compareSelect}${measureSelect}`,
    html: `<div class="grid md:grid-cols-4 gap-4 mb-4">${cards}</div>
      <section class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto"><div class="px-4 py-3 border-b border-gray-200 text-sm font-semibold">Per ${esc(dim.label)} <span class="font-normal text-gray-500">· ${list.length} baris${cfg.drill ? " · klik nama untuk melihat rincian" : ""}</span></div>
        <table class="w-full text-left"><thead class="bg-gray-50"><tr>${[...head, ...compareHead].map((h, i) => `<th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase ${i ? "text-right" : ""}">${esc(h)}</th>`).join("")}<th></th></tr></thead>
          <tbody class="divide-y divide-gray-100">${rowsHtml || `<tr><td colspan="${head.length + compareHead.length + 1}" class="py-8 text-center text-sm text-gray-500">Tidak ada data pada rentang ini.</td></tr>`}</tbody>
          ${list.length ? `<tfoot class="bg-gray-50"><tr><td class="py-2 px-4 text-sm font-semibold">Total</td>${totals.map((v, i) => `<td class="py-2 px-4 text-sm text-right tabular-nums font-semibold">${esc(FORMATS[cfg.measures[i].fmt](v))}</td>`).join("")}${range ? cmpCells(totals[cm], priorTotals[cm], "font-semibold") : ""}<td></td></tr></tfoot>` : ""}</table></section>
      ${compareNote}${cfg.note ? `<p class="mt-3 text-xs text-gray-500">${esc(cfg.note)}</p>` : ""}`,
  };
}

const plain = (html) => String(html).replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const detailExport = (columns, rows) => [columns.map((c) => c.label), ...rows.map((r) => columns.map((c) => plain(c.value(r))))];
const detailTable = (columns, rows, heading, empty) => {
  const body = rows.map((r) => `<tr>${columns.map((c) => `<td class="py-2 px-4 text-sm ${c.right ? "text-right tabular-nums" : ""}">${c.raw ? c.value(r) : esc(c.value(r))}</td>`).join("")}</tr>`).join("");
  return `<section class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto"><div class="px-4 py-3 border-b border-gray-200 text-sm font-semibold">${heading}</div>
    <table class="w-full text-left"><thead class="bg-gray-50"><tr>${columns.map((c) => `<th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase ${c.right ? "text-right" : ""}">${esc(c.label)}</th>`).join("")}</tr></thead>
      <tbody class="divide-y divide-gray-100">${body || `<tr><td colspan="${columns.length}" class="py-8 text-center text-sm text-gray-500">${esc(empty)}</td></tr>`}</tbody></table></section>`;
};

/** Baris rincian satu kelompok ringkasan (query `d` = kunci kelompok pada dimensi `by`). */
async function renderDrill(cfg, query, from, to) {
  const { dimKey, dim, base } = groupSetup(cfg, query);
  const aggregates = [...new Set([...cfg.measures.map((m) => m.agg), "__count"])];
  const [groups, meta] = await Promise.all([readGroups(cfg, dim, base, from, to, aggregates), readMeta(cfg, dim)]);
  const group = groups.find((g) => groupKey(dim.by, g[dim.by]) === query.get("d"));
  const back = `<a href="${esc(hashWith(query, from, to, dimKey, { d: null }))}" class="inline-flex items-center text-sm text-indigo-700 hover:underline mb-3"><i class="fas fa-arrow-left mr-2"></i>Kembali ke ringkasan per ${esc(dim.label)}</a>`;
  if (!group) {
    exportRows = [];
    return { html: `${back}<section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 text-sm text-gray-500">Kelompok ini tidak ada pada rentang tanggal tersebut.</section>` };
  }
  const label = labeler(dim, meta)(group[dim.by]);
  const rows = await searchRead(cfg.model, [...base, ...dateDomain(cfg, from, to), ...group.__extra_domain], cfg.drill.fields, { order: cfg.drill.order, limit: DRILL_LIMIT });
  await cfg.drill.prepare?.(rows);
  exportRows = detailExport(cfg.drill.columns, rows);
  exportName = "-rincian";
  const total = group.__count ?? rows.length;
  const cards = cfg.measures.slice(0, 4).map((m) => statCard(m.label, FORMATS[m.fmt](group[m.agg] ?? 0))).join("");
  return {
    html: `${back}<p class="mb-3 text-sm text-gray-600">${esc(dim.label)}: <strong class="text-gray-900">${esc(label)}</strong> <span class="text-gray-500">· ${esc(dateText(from))} sampai ${esc(dateText(to))}</span></p>
      <div class="grid md:grid-cols-4 gap-4 mb-4">${cards}</div>
      ${detailTable(cfg.drill.columns, rows, `${rows.length} baris${total > rows.length ? ` dari ${total} (${DRILL_LIMIT} terbaru; persempit dengan tanggal)` : ""}`, "Tidak ada baris.")}
      ${cfg.note ? `<p class="mt-3 text-xs text-gray-500">${esc(cfg.note)}</p>` : ""}`,
  };
}

async function renderLines(cfg, query, from, to) {
  const q = query.get("q") ?? "";
  const state = query.get("state") ?? "";
  const domain = [...dateDomain(cfg, from, to)];
  if (state && cfg.state) domain.push([cfg.state.field, "=", state]);
  if (q && cfg.search?.length) domain.push(...Array(cfg.search.length - 1).fill("|"), ...cfg.search.map((s) => [s, "ilike", q]));
  const rows = await searchRead(cfg.model, domain, cfg.fields, { order: cfg.order, limit: 300 });
  exportRows = detailExport(cfg.columns, rows);
  return {
    controls: `${searchBox(q, "Cari...")}${cfg.state ? filterSelect([["", "Semua status"], ...cfg.state.options], state) : ""}`,
    html: detailTable(cfg.columns, rows, `${rows.length} baris${rows.length >= 300 ? " (300 terbaru; persempit dengan tanggal atau pencarian)" : ""}`, "Tidak ada baris pada rentang ini."),
  };
}

export function onClick(event, el) {
  if (el.dataset.action !== "csv") return;
  const csv = exportRows.map((row) => row.map((v) => (typeof v === "number" ? String(v) : `"${String(v ?? "").replaceAll('"', '""')}"`)).join(",")).join("\r\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" }));
  link.download = `${last.sub}${exportName}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

export function onChange(event, el) {
  const key = el.dataset.an;
  if (!key) return;
  const params = new URLSearchParams(last.query);
  if (el.value) params.set(key, el.value);
  else params.delete(key);
  const qs = params.toString();
  location.hash = `#/analysis/${last.sub}${qs ? `?${qs}` : ""}`;
}
