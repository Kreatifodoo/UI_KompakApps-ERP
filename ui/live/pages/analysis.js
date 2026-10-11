// Laporan analisis untuk menu Report di modul Purchase Request, Purchase, Inventory, Sales, dan POS. Satu mesin melayani dua bentuk:
// "kelompok" (ringkasan per dimensi dengan ukuran dan batang, pada rentang tanggal) dan "baris" (daftar baris dokumen dengan filter
// dan pencarian). Tiap laporan hanya konfigurasi model, dimensi, ukuran, dan kolom. Semua bisa diunduh sebagai CSV.
import { INPUT, app, call, dateText, esc, filterSelect, money, pageHeader, searchBox, searchRead } from "../common.js";

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
      { label: "Produk", value: (r) => esc(r.product_id?.[1] || r.name) }, { label: "Jumlah", value: (r) => `${num(r.product_qty)} ${esc(r.product_uom_id?.[1] ?? "")}`, right: true, raw: true },
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

/* ---------- Mesin ---------- */

let last = { sub: "prline", query: new URLSearchParams() };
let exportRows = [];
export const leave = () => {
  exportRows = [];
};

const monthLabel = (key) => `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
const dayLabel = (key) => dateText(key.slice(0, 10));
const utc = (text, end) => `${text} ${end ? "23:59:59" : "00:00:00"}`;

export async function render(sub, query) {
  const key = REPORTS[sub] ? sub : "prline";
  last = { sub: key, query };
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat laporan...</p>';
  const cfg = REPORTS[key];
  const from = query.get("from") ?? yearStart();
  const to = query.get("to") ?? todayText();
  const body = await (cfg.mode === "group" ? renderGroup(cfg, query, from, to) : renderLines(cfg, query, from, to));
  const dates = `<label class="text-xs font-medium text-gray-500 uppercase">Dari<input type="date" data-an="from" value="${esc(from)}" class="${INPUT} mt-1 w-40"></label>
    <label class="text-xs font-medium text-gray-500 uppercase">Sampai<input type="date" data-an="to" value="${esc(to)}" class="${INPUT} mt-1 w-40"></label>`;
  app.innerHTML = pageHeader(cfg.title, `${body.controls ?? ""}${dates}<button type="button" data-action="csv" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50"><i class="fas fa-download mr-2"></i>Unduh CSV</button>`) + body.html;
}

const dateDomain = (cfg, from, to) => [[cfg.dateField, ">=", cfg.datetime === false ? from : utc(from)], [cfg.dateField, "<=", cfg.datetime === false ? to : utc(to, true)]];

async function renderGroup(cfg, query, from, to) {
  const dimKey = cfg.dims[query.get("by")] ? query.get("by") : cfg.dim;
  const dim = cfg.dims[dimKey];
  const filter = cfg.filter && query.get(cfg.filter.key) ? cfg.filter.domain(query.get(cfg.filter.key)) : [];
  const domain = [...cfg.base, ...filter, ...dateDomain(cfg, from, to)];
  const aggregates = cfg.measures.map((m) => m.agg);
  const [rows, fields] = await Promise.all([
    call(cfg.model, "formatted_read_group", { domain, groupby: [dim.by], aggregates }),
    call(cfg.model, "fields_get", { allfields: [dim.by.split(":")[0]], attributes: ["type", "selection"] }),
  ]);
  const meta = fields[dim.by.split(":")[0]];
  const selection = new Map((meta?.selection ?? []).map(([k, l]) => [k, l]));
  const labelOf = (r) => {
    const v = r[dim.by];
    if (Array.isArray(v)) return dim.by.endsWith(":month") ? monthLabel(String(v[0])) : dim.by.endsWith(":day") ? dayLabel(String(v[0])) : v[1];
    if (typeof v === "string" && v) return SELECTION_LABELS[dim.by]?.[v] ?? selection.get(v) ?? v;
    return "Tanpa data";
  };
  const isTime = dim.by.includes(":");
  const list = rows.map((r) => ({ key: isTime ? String(r[dim.by]?.[0] ?? "") : "", label: labelOf(r), values: aggregates.map((a) => r[a] ?? 0) }));
  const barIndex = Math.max(0, cfg.measures.findIndex((m) => m.bar));
  list.sort((a, b) => (isTime ? (a.key < b.key ? 1 : -1) : b.values[barIndex] - a.values[barIndex]));
  const max = Math.max(1, ...list.map((r) => Math.abs(r.values[barIndex])));
  const totals = cfg.measures.map((_, i) => list.reduce((s, r) => s + r.values[i], 0));
  exportRows = [[dim.label, ...cfg.measures.map((m) => m.label)], ...list.map((r) => [r.label, ...r.values])];
  const head = [dim.label, ...cfg.measures.map((m) => m.label)];
  const rowsHtml = list
    .map(
      (r) => `<tr><td class="py-2 px-4 text-sm">${esc(r.label)}</td>${r.values
        .map((v, i) => `<td class="py-2 px-4 text-sm text-right tabular-nums">${esc(FORMATS[cfg.measures[i].fmt](v))}</td>`)
        .join("")}<td class="py-2 px-4 w-1/6"><div class="h-3 bg-gray-100 rounded"><div class="h-3 ${r.values[barIndex] < 0 ? "bg-rose-400" : "bg-indigo-500"} rounded" style="width:${Math.round((Math.abs(r.values[barIndex]) / max) * 100)}%"></div></div></td></tr>`,
    )
    .join("");
  const cards = cfg.measures
    .slice(0, 4)
    .map((m, i) => `<div class="bg-white rounded-xl border border-gray-200 shadow-sm p-4"><div class="text-xs font-medium text-gray-500 uppercase">${esc(m.label)}</div><div class="text-xl font-semibold mt-1">${esc(FORMATS[m.fmt](totals[i]))}</div></div>`)
    .join("");
  const dimSelect = `<select data-an="by" class="${INPUT} w-48" aria-label="Kelompokkan menurut">${Object.entries(cfg.dims).map(([k, d]) => `<option value="${esc(k)}" ${k === dimKey ? "selected" : ""}>${esc(d.label)}</option>`).join("")}</select>`;
  const filterSelectHtml = cfg.filter
    ? `<select data-an="${esc(cfg.filter.key)}" class="${INPUT} w-52" aria-label="${esc(cfg.filter.label)}"><option value="">${esc(cfg.filter.label)}</option>${cfg.filter.options.map(([k, l]) => `<option value="${esc(k)}" ${query.get(cfg.filter.key) === k ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`
    : "";
  return {
    controls: `${dimSelect}${filterSelectHtml}`,
    html: `<div class="grid md:grid-cols-4 gap-4 mb-4">${cards}</div>
      <section class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto"><div class="px-4 py-3 border-b border-gray-200 text-sm font-semibold">Per ${esc(dim.label)} <span class="font-normal text-gray-500">· ${list.length} baris</span></div>
        <table class="w-full text-left"><thead class="bg-gray-50"><tr>${head.map((h, i) => `<th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase ${i ? "text-right" : ""}">${esc(h)}</th>`).join("")}<th></th></tr></thead>
          <tbody class="divide-y divide-gray-100">${rowsHtml || `<tr><td colspan="${head.length + 1}" class="py-8 text-center text-sm text-gray-500">Tidak ada data pada rentang ini.</td></tr>`}</tbody>
          ${list.length ? `<tfoot class="bg-gray-50"><tr><td class="py-2 px-4 text-sm font-semibold">Total</td>${totals.map((v, i) => `<td class="py-2 px-4 text-sm text-right tabular-nums font-semibold">${esc(FORMATS[cfg.measures[i].fmt](v))}</td>`).join("")}<td></td></tr></tfoot>` : ""}</table></section>
      ${cfg.note ? `<p class="mt-3 text-xs text-gray-500">${esc(cfg.note)}</p>` : ""}`,
  };
}

async function renderLines(cfg, query, from, to) {
  const text = query.get("q") ?? "";
  const state = query.get("state") ?? "";
  const domain = [...dateDomain(cfg, from, to)];
  if (state && cfg.state) domain.push([cfg.state.field, "=", state]);
  if (text && cfg.search?.length) domain.push(...Array(cfg.search.length - 1).fill("|"), ...cfg.search.map((s) => [s, "ilike", text]));
  const rows = await searchRead(cfg.model, domain, cfg.fields, { order: cfg.order, limit: 300 });
  const plain = (html) => String(html).replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  exportRows = [cfg.columns.map((c) => c.label), ...rows.map((r) => cfg.columns.map((c) => plain(c.value(r))))];
  const body = rows
    .map((r) => `<tr>${cfg.columns.map((c) => `<td class="py-2 px-4 text-sm ${c.right ? "text-right tabular-nums" : ""}">${c.raw ? c.value(r) : esc(c.value(r))}</td>`).join("")}</tr>`)
    .join("");
  return {
    controls: `${searchBox(text, "Cari...")}${cfg.state ? filterSelect([["", "Semua status"], ...cfg.state.options], state) : ""}`,
    html: `<section class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto"><div class="px-4 py-3 border-b border-gray-200 text-sm font-semibold">${rows.length} baris${rows.length >= 300 ? " (300 terbaru; persempit dengan tanggal atau pencarian)" : ""}</div>
      <table class="w-full text-left"><thead class="bg-gray-50"><tr>${cfg.columns.map((c) => `<th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase ${c.right ? "text-right" : ""}">${esc(c.label)}</th>`).join("")}</tr></thead>
        <tbody class="divide-y divide-gray-100">${body || `<tr><td colspan="${cfg.columns.length}" class="py-8 text-center text-sm text-gray-500">Tidak ada baris pada rentang ini.</td></tr>`}</tbody></table></section>`,
  };
}

export function onClick(event, el) {
  if (el.dataset.action !== "csv") return;
  const text = exportRows.map((row) => row.map((v) => (typeof v === "number" ? String(v) : `"${String(v ?? "").replaceAll('"', '""')}"`)).join(",")).join("\r\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([`﻿${text}`], { type: "text/csv;charset=utf-8" }));
  link.download = `${last.sub}.csv`;
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
