// Inventory Valuation (D46): nilai persediaan per tanggal (as of), mutasi periode, rincian pergerakan bernilai, dan ringkasan per akun
// persediaan terhadap buku besar. Odoo 19 tidak lagi punya stock.valuation.layer; nilai tercatat pada stock.move (`value`, `is_in`,
// `is_out`) dan nilai pada tanggal lampau dihitung Odoo dengan memutar ulang pergerakan selesai (konteks `to_date` pada product.product:
// qty_available, avg_cost, total_value). Halaman ini memakai hitungan Odoo itu supaya hasilnya sama dengan laporan Stock Valuation bawaan.
import { INPUT, app, call, dateText, dateTimeText, esc, filterSelect, money, pageHeader, referenceCategories, searchBox, searchRead, today } from "../common.js";
import { printReport } from "../print.js";

const TABS = [["asof", "Per Tanggal"], ["period", "Mutasi Periode"], ["moves", "Rincian Pergerakan"], ["account", "Per Akun Persediaan"]];
const DIRECTIONS = [["", "Semua pergerakan"], ["in", "Masuk"], ["out", "Keluar"], ["adjust", "Penyesuaian dan scrap"]];
const PICKING_PAGES = { incoming: "receipt", outgoing: "delivery", internal: "transfer" };
const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 });
const LIMIT = 2000; // produk per laporan
const MOVE_LIMIT = 500; // baris rincian pergerakan
const EPS = 0.5; // toleransi selisih nilai (rupiah)
const BTN = "px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50";

let last = { sub: "asof", query: new URLSearchParams() };
let report = null; // model tabel tampilan yang sedang terbuka (untuk CSV dan cetak)
export const leave = () => {
  report = null;
};

/* ---------- Tanggal dan konteks ---------- */

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const shift = (text, days) => {
  const [y, m, d] = text.split("-").map(Number);
  return iso(new Date(y, m - 1, d + days));
};
const validDate = (text) => (/^\d{4}-\d{2}-\d{2}$/.test(text ?? "") ? text : "");
/** Tanggal pilihan, tidak melewati hari ini. */
const pickDate = (text, fallback = today()) => {
  const value = validDate(text) || fallback;
  return value > today() ? today() : value;
};
/** Hari ini berarti kondisi saat ini (tanpa `to_date`), seperti laporan Stock Valuation bawaan Odoo dan Laporan Stok; tanggal lampau
 *  dihitung sampai akhir hari itu (UTC, sama dengan laporan analisis lain). */
const dateContext = (date) => (date >= today() ? {} : { to_date: `${date} 23:59:59` });

/* ---------- Data referensi ---------- */

async function loadScopes() {
  const [valued, warehouses, locations] = await Promise.all([
    searchRead("stock.location", [["usage", "in", ["internal", "transit"]]], ["id"], { context: { active_test: false }, limit: 1000 }),
    searchRead("stock.warehouse", [], ["display_name"], { order: "name" }),
    searchRead("stock.location", [["usage", "in", ["internal", "transit"]]], ["complete_name"], { order: "complete_name", limit: 500 }),
  ]);
  return { valuedIds: valued.map((l) => l.id), warehouses, locations };
}

/** Lingkup lokasi: semua lokasi bernilai (internal dan transit, seperti hitungan valuasi Odoo), satu gudang (`w<id>`), atau satu lokasi (`l<id>`). */
function scopeOf(param, scopes) {
  const id = Number(String(param ?? "").slice(1));
  if (param?.startsWith("w")) {
    const w = scopes.warehouses.find((x) => x.id === id);
    if (w) return { all: false, label: `Gudang ${w.display_name}`, context: { warehouse_id: w.id } };
  }
  if (param?.startsWith("l")) {
    const l = scopes.locations.find((x) => x.id === id);
    if (l) return { all: false, label: l.complete_name, context: { location: [l.id] } };
  }
  return { all: true, label: "Semua lokasi", context: { location: scopes.valuedIds, strict: true } };
}

const valuationCategories = () =>
  searchRead("product.category", [], ["display_name", "property_stock_valuation_account_id", "property_valuation", "property_cost_method"], { order: "complete_name", limit: 500 });

/** Saldo buku besar per akun (jurnal terposting sampai tanggal itu). */
async function glBalances(accountIds, date) {
  if (!accountIds.length) return new Map();
  const groups = await call("account.move.line", "formatted_read_group", {
    domain: [["account_id", "in", accountIds], ["parent_state", "=", "posted"], ["date", "<=", date]], groupby: ["account_id"], aggregates: ["balance:sum"],
  });
  return new Map(groups.map((g) => [g.account_id[0], g["balance:sum"] || 0]));
}

/** Filter produk (kategori beserta anak, produk menurut template, pencarian nama atau kode); `prefix` untuk model pergerakan. */
function productDomain(query, prefix = "") {
  const domain = [];
  const categ = Number(query.get("categ")) || null;
  const template = Number(query.get("product")) || null;
  const text = (query.get("q") ?? "").trim();
  if (categ) domain.push([`${prefix}categ_id`, "child_of", categ]);
  if (template) domain.push([`${prefix}product_tmpl_id`, "=", template]);
  if (text) domain.push("|", [`${prefix}name`, "ilike", text], [`${prefix}default_code`, "ilike", text]);
  return domain;
}

/* ---------- Nilai persediaan pada tanggal tertentu ---------- */

/** Jumlah, biaya rata-rata, dan nilai per produk pada tanggal itu. Nilai dan biaya dari hitungan Odoo (seluruh perusahaan); untuk satu
 *  gudang atau lokasi, nilai = jumlah di sana dikali biaya rata-rata, sama dengan cara Odoo menghitung `stock.quant.value`. */
async function valuationRows(date, query, scope) {
  const domain = [["is_storable", "=", true], ...productDomain(query)];
  const context = { active_test: false, ...dateContext(date) };
  const [qtyRows, valueRows] = await Promise.all([
    searchRead("product.product", domain, ["display_name", "default_code", "categ_id", "uom_id", "product_tmpl_id", "qty_available"], { context: { ...context, ...scope.context }, order: "id", limit: LIMIT }),
    searchRead("product.product", domain, ["avg_cost", "total_value"], { context, order: "id", limit: LIMIT }),
  ]);
  const values = new Map(valueRows.map((r) => [r.id, r]));
  return qtyRows.map((r) => {
    const v = values.get(r.id) ?? { avg_cost: 0, total_value: 0 };
    return {
      id: r.id,
      template: r.product_tmpl_id[0],
      name: r.display_name,
      categ: r.categ_id ? { id: r.categ_id[0], name: r.categ_id[1] } : { id: 0, name: "Tanpa kategori" },
      uom: r.uom_id?.[1] ?? "",
      qty: r.qty_available,
      cost: v.avg_cost,
      value: scope.all ? v.total_value : r.qty_available * v.avg_cost,
    };
  });
}

const isZero = (...numbers) => numbers.every((n) => Math.abs(n) < 0.000001);
const byName = (a, b) => a.name.localeCompare(b.name, "id");

/** Kelompok kategori (urut nama) berisi baris produk (urut nama). */
function groupByCategory(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.categ.id)) groups.set(r.categ.id, { id: r.categ.id, name: r.categ.name, rows: [] });
    groups.get(r.categ.id).rows.push(r);
  }
  const list = [...groups.values()].sort(byName);
  for (const g of list) g.rows.sort(byName);
  return list;
}

/** Satuan bersama sekelompok baris, atau "" bila campuran (jumlah antar satuan tidak boleh dijumlahkan). */
const commonUom = (rows) => (rows.length && rows.every((r) => r.uom === rows[0].uom) ? rows[0].uom : "");
const sum = (rows, pick) => rows.reduce((s, r) => s + pick(r), 0);

/* ---------- Model tabel: satu sumber untuk HTML, CSV, dan cetak ---------- */

const fmt = (col, v) => (v === null || v === undefined || v === "" ? "" : col.type === "money" ? money(v) : col.type === "qty" ? nf.format(v) : String(v));
const plainOf = (c) => (c && typeof c === "object" ? c.v : c);
const flatLabel = (c) => (c.group ? `${c.group} ${c.label}` : c.label);
const link = (href, text, cls = "text-indigo-700 hover:underline") => `<a href="${esc(href)}" class="${cls}">${esc(text)}</a>`;

function tableHtml(m) {
  const spans = [];
  for (const c of m.columns) {
    const label = c.group ?? "";
    if (spans.length && spans[spans.length - 1].label === label) spans[spans.length - 1].n += 1;
    else spans.push({ label, n: 1 });
  }
  const th = (c, i) => `<th class="py-2 px-3 text-xs font-semibold text-gray-600 uppercase ${i && c.type !== "text" ? "text-right" : ""}">${esc(c.label)}</th>`;
  const groupHead = m.columns.some((c) => c.group)
    ? `<tr>${spans.map((s) => `<th colspan="${s.n}" class="pt-2 px-3 text-xs font-semibold text-gray-500 uppercase text-center ${s.label ? "border-l border-gray-200" : ""}">${esc(s.label)}</th>`).join("")}</tr>`
    : "";
  const tone = { group: "bg-gray-100 font-semibold", row: "hover:bg-gray-50", total: "bg-gray-50 font-bold border-t-2 border-gray-300" };
  const td = (c, col, i, r) => {
    const cellData = c && typeof c === "object" ? c : { v: c };
    const text = cellData.html ?? esc(fmt(col, cellData.v));
    const numeric = col.type !== "text";
    const negative = numeric && typeof cellData.v === "number" && cellData.v < -0.000001;
    const faint = numeric && cellData.v === 0 && r.kind === "row";
    return `<td class="py-2 px-3 text-sm ${numeric ? "text-right tabular-nums" : ""} ${negative ? "text-rose-700" : faint ? "text-gray-400" : ""} ${i === 0 && r.kind === "row" && m.indent ? "pl-8" : ""}">${text}</td>`;
  };
  const body = m.rows.map((r) => `<tr class="${tone[r.kind]}">${r.cells.map((c, i) => td(c, m.columns[i], i, r)).join("")}</tr>`).join("");
  return `<div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto">
    <table class="w-full text-left"><thead class="bg-gray-50 border-b border-gray-200">${groupHead}<tr>${m.columns.map(th).join("")}</tr></thead>
    <tbody class="divide-y divide-gray-100">${body || `<tr><td colspan="${m.columns.length}" class="py-10 text-center text-sm text-gray-500">${esc(m.empty)}</td></tr>`}</tbody></table></div>`;
}

const csvCell = (v) => (typeof v === "number" ? String(v) : `"${String(v ?? "").replaceAll('"', '""')}"`);
/** CSV datar: baris kelompok (subtotal kategori) dilewati dan kategori menjadi kolom pertama; `m.csv` menggantikannya bila bentuknya lain. */
function csvText(m) {
  const cols = m.columns.filter((c) => !c.skipExport);
  const keep = (r) => r.cells.filter((_, i) => !m.columns[i].skipExport).map((c) => plainOf(c) ?? "");
  const labels = cols.map((c, i) => (i === 0 && m.categoryColumn ? "Produk" : flatLabel(c)));
  const header = m.csv?.header ?? [...(m.categoryColumn ? ["Kategori"] : []), ...labels];
  const rows = m.csv?.rows ?? m.rows.filter((r) => r.kind !== "group").map((r) => [...(m.categoryColumn ? [r.category ?? ""] : []), ...keep(r)]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

function printDoc(m) {
  const cols = m.columns.filter((c) => !c.skipExport);
  const text = (c, col) => (c && typeof c === "object" && c.p !== undefined ? c.p : typeof plainOf(c) === "number" ? fmt(col, plainOf(c)) : String(plainOf(c) ?? ""));
  return {
    title: "Inventory Valuation",
    number: m.subtitle,
    meta: m.meta,
    landscape: cols.length > 6,
    columns: cols.map((c) => [flatLabel(c), c.type === "text" ? "" : "r"]),
    rows: m.rows.map((r) => ({ cells: r.cells.filter((_, i) => !m.columns[i].skipExport).map((c, i) => (r.kind === "group" && i === 0 ? text(c, cols[i]).toUpperCase() : text(c, cols[i]))) })),
    notes: [["Catatan", m.note]],
  };
}

const card = (label, value, hint = "", tone = "") =>
  `<div class="bg-white rounded-xl border border-gray-200 shadow-sm p-4"><div class="text-xs font-medium text-gray-500 uppercase">${esc(label)}</div><div class="text-xl font-semibold mt-1 ${tone}">${value}</div>${hint ? `<div class="text-xs text-gray-500 mt-1">${hint}</div>` : ""}</div>`;
const dateInput = (key, label, value) => `<label class="text-xs font-medium text-gray-500 uppercase">${label}<input type="date" data-vl="${key}" value="${esc(value)}" max="${today()}" class="${INPUT} mt-1 w-40"></label>`;
const selectBox = (key, options) =>
  `<select data-vl="${key}" class="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white max-w-56">${options}</select>`;
const exportButtons = `<button type="button" data-action="csv" class="${BTN}"><i class="fas fa-download mr-2"></i>Unduh CSV</button>
  <button type="button" data-action="print" class="${BTN}"><i class="fas fa-print mr-2"></i>Cetak</button>`;

function categorySelect(categories, selected) {
  return selectBox("categ", `<option value="">Semua kategori</option>${categories.map((c) => `<option value="${c.id}" ${c.id === selected ? "selected" : ""}>${esc(c.display_name)}</option>`).join("")}`);
}
function scopeSelect(scopes, selected) {
  const option = (value, label) => `<option value="${value}" ${value === selected ? "selected" : ""}>${esc(label)}</option>`;
  return selectBox(
    "scope",
    `${option("", "Semua lokasi")}<optgroup label="Gudang">${scopes.warehouses.map((w) => option(`w${w.id}`, w.display_name)).join("")}</optgroup>
     <optgroup label="Lokasi">${scopes.locations.map((l) => option(`l${l.id}`, l.complete_name)).join("")}</optgroup>`,
  );
}

/** Penanda produk bila halaman dibuka dari tombol atau baris yang menyaring satu produk. */
async function productChip(query) {
  const id = Number(query.get("product")) || null;
  if (!id) return "";
  const [p] = await searchRead("product.template", [["id", "=", id]], ["display_name"], { limit: 1 });
  const clear = location.hash.replace(/([?&])product=\d+&?/, "$1").replace(/[?&]$/, "");
  return `<div class="mb-4 flex flex-wrap items-center justify-between gap-2 text-sm bg-indigo-50 border border-indigo-200 text-indigo-900 rounded-lg px-4 py-2"><span>Menampilkan produk <b>${esc(p?.display_name ?? `#${id}`)}</b></span><a href="${esc(clear)}" class="text-indigo-700 underline">Semua produk</a></div>`;
}

/** Tautan penelusuran ke Rincian Pergerakan dari baris produk atau kategori. */
function movesHref(query, { product, categ, from, to }) {
  const p = new URLSearchParams();
  if (product) p.set("product", product);
  else if (categ) p.set("categ", categ);
  if (query.get("q") && !product) p.set("q", query.get("q"));
  p.set("from", from);
  p.set("to", to);
  return `#/valuation/moves?${p}`;
}
const drillLink = (href) => ({ v: "", html: link(href, "Rincian") });

/* ---------- Tampilan 1: per tanggal ---------- */

async function viewAsOf(query) {
  const date = pickDate(query.get("date"));
  const [scopes, categories, accountCategories] = await Promise.all([loadScopes(), referenceCategories(), valuationCategories()]);
  const scope = scopeOf(query.get("scope"), scopes);
  const accountIds = [...new Set(accountCategories.map((c) => c.property_stock_valuation_account_id?.[0]).filter(Boolean))];
  const [all, gl, chip] = await Promise.all([valuationRows(date, query, scope), glBalances(accountIds, date), productChip(query)]);
  const rows = all.filter((r) => !isZero(r.qty, r.value));
  const groups = groupByCategory(rows);
  const total = sum(rows, (r) => r.value);
  const glTotal = [...gl.values()].reduce((s, v) => s + v, 0);
  const filtered = !scope.all || query.get("categ") || query.get("q") || query.get("product");
  const difference = total - glTotal;
  const to = date;
  const tableRows = [];
  for (const g of groups) {
    const uom = commonUom(g.rows);
    tableRows.push({
      kind: "group",
      cells: [{ v: g.name, html: g.id ? link(movesHref(query, { categ: g.id, from: "2000-01-01", to }), g.name, "text-indigo-700 hover:underline") : esc(g.name) }, uom, uom ? sum(g.rows, (r) => r.qty) : "", "", sum(g.rows, (r) => r.value), ""],
    });
    for (const r of g.rows) {
      tableRows.push({ kind: "row", category: g.name, cells: [{ v: r.name, html: link(`#/product/${r.template}`, r.name) }, r.uom, r.qty, r.cost, r.value, drillLink(movesHref(query, { product: r.template, from: "2000-01-01", to }))] });
    }
  }
  const uom = commonUom(rows);
  tableRows.push({ kind: "total", cells: ["Total", uom, uom ? sum(rows, (r) => r.qty) : "", "", total, ""] });
  const m = {
    columns: [
      { label: "Kategori / Produk", type: "text" }, { label: "Satuan", type: "text" }, { label: "Jumlah", type: "qty" }, { label: "Biaya Rata-rata", type: "money" }, { label: "Nilai", type: "money" }, { label: "Penelusuran", type: "text", skipExport: true },
    ],
    rows: tableRows,
    indent: true,
    categoryColumn: true,
    empty: "Tidak ada persediaan bernilai pada tanggal ini.",
    subtitle: `Per ${dateText(date)}`,
    meta: [["Tanggal", dateText(date)], ["Lokasi", scope.label], ["Kategori", categories.find((c) => c.id === Number(query.get("categ")))?.display_name ?? ""], ["Pencarian", query.get("q") ?? ""]],
    note: "Nilai memakai metode biaya kategori produk (hitungan Odoo). Nilai per gudang atau lokasi = jumlah di sana dikali biaya rata-rata seluruh perusahaan.",
    file: `inventory-valuation-per-${date}`,
  };
  const hidden = all.length - rows.length;
  return {
    m,
    controls: `${searchBox(query.get("q") ?? "", "Cari produk atau kode")}${categorySelect(categories, Number(query.get("categ")) || null)}${scopeSelect(scopes, query.get("scope") ?? "")}${dateInput("date", "Per tanggal", date)}${exportButtons}`,
    html:
      chip +
      `<div class="grid md:grid-cols-3 gap-4 mb-4">
        ${card(`Nilai persediaan per ${dateText(date)}`, esc(money(total)), `${rows.length} produk, ${groups.length} kategori; ${esc(scope.label)}`)}
        ${card("Saldo akun Persediaan (buku besar)", esc(money(glTotal)), "jurnal terposting sampai tanggal itu; dijurnal saat tagihan dan faktur diposting")}
        ${card("Selisih terhadap buku besar", filtered ? "-" : esc(money(difference)), filtered ? "filter aktif, tidak dibandingkan" : Math.abs(difference) < EPS ? "sama" : `${link(`#/valuation/account?date=${date}`, "lihat per akun", "text-indigo-700 underline")} (wajar bila ada barang diterima belum ditagih, penyesuaian, atau scrap)`, filtered || Math.abs(difference) < EPS ? (filtered ? "" : "text-emerald-700") : "text-amber-700")}
      </div>` +
      tableHtml(m) +
      `<p class="text-xs text-gray-500 mt-3">${esc(m.note)} Untuk hari ini nilainya sama dengan Laporan Stok. Barang dalam transit antar gudang ikut dihitung pada "Semua lokasi" (masih milik perusahaan).${hidden ? ` ${hidden} produk bernol disembunyikan.` : ""}${all.length >= LIMIT ? ` Dibatasi ${LIMIT} produk.` : ""}</p>`,
  };
}

/* ---------- Tampilan 2: mutasi periode ---------- */

/** Masuk dan keluar bernilai selama periode, per produk: nilai dari stock.move, jumlah dari baris pergerakan (satuan produk). */
async function periodFlows(from, to, query) {
  const range = [["state", "=", "done"], ["date", ">=", `${from} 00:00:00`], ["date", "<=", `${to} 23:59:59`], ...productDomain(query, "product_id.")];
  const group = async (model, flag, aggregate) => {
    const rows = await call(model, "formatted_read_group", { domain: [...range, [flag, "=", true]], groupby: ["product_id"], aggregates: [aggregate] });
    return new Map(rows.map((g) => [g.product_id[0], g[aggregate] || 0]));
  };
  const [inValue, outValue, inQty, outQty] = await Promise.all([
    group("stock.move", "is_in", "value:sum"), group("stock.move", "is_out", "value:sum"),
    group("stock.move.line", "move_id.is_in", "quantity_product_uom:sum"), group("stock.move.line", "move_id.is_out", "quantity_product_uom:sum"),
  ]);
  return { inValue, outValue, inQty, outQty };
}

async function viewPeriod(query) {
  const to = pickDate(query.get("to"));
  let from = pickDate(query.get("from"), `${to.slice(0, 8)}01`);
  if (from > to) from = to;
  const [scopes, categories] = await Promise.all([loadScopes(), referenceCategories()]);
  const everywhere = scopeOf("", scopes);
  const [opening, closing, flows, chip] = await Promise.all([valuationRows(shift(from, -1), query, everywhere), valuationRows(to, query, everywhere), periodFlows(from, to, query), productChip(query)]);
  const open = new Map(opening.map((r) => [r.id, r]));
  const lines = closing
    .map((c) => {
      const o = open.get(c.id);
      const line = { ...c, openQty: o?.qty ?? 0, openValue: o?.value ?? 0, inQty: flows.inQty.get(c.id) ?? 0, inValue: flows.inValue.get(c.id) ?? 0, outQty: flows.outQty.get(c.id) ?? 0, outValue: flows.outValue.get(c.id) ?? 0, closeQty: c.qty, closeValue: c.value };
      line.adjust = line.closeValue - (line.openValue + line.inValue - line.outValue);
      return line;
    })
    .filter((r) => !isZero(r.openQty, r.openValue, r.inQty, r.inValue, r.outQty, r.outValue, r.closeQty, r.closeValue));
  const showAdjust = lines.some((r) => Math.abs(r.adjust) >= EPS);
  const tail = (g, uomOf) => {
    const uom = uomOf(g);
    const q = (pick) => (uom ? sum(g, pick) : "");
    return [
      uom, q((r) => r.openQty), sum(g, (r) => r.openValue), q((r) => r.inQty), sum(g, (r) => r.inValue), q((r) => r.outQty), sum(g, (r) => r.outValue),
      ...(showAdjust ? [sum(g, (r) => r.adjust)] : []), q((r) => r.closeQty), sum(g, (r) => r.closeValue),
    ];
  };
  const tableRows = [];
  for (const g of groupByCategory(lines)) {
    tableRows.push({ kind: "group", cells: [{ v: g.name, html: g.id ? link(movesHref(query, { categ: g.id, from, to }), g.name) : esc(g.name) }, ...tail(g.rows, commonUom), ""] });
    for (const r of g.rows) {
      tableRows.push({
        kind: "row", category: g.name,
        cells: [{ v: r.name, html: link(`#/product/${r.template}`, r.name) }, r.uom, r.openQty, r.openValue, r.inQty, r.inValue, r.outQty, r.outValue, ...(showAdjust ? [r.adjust] : []), r.closeQty, r.closeValue, drillLink(movesHref(query, { product: r.template, from, to }))],
      });
    }
  }
  tableRows.push({ kind: "total", cells: ["Total", ...tail(lines, commonUom), ""] });
  const col = (label, type, group) => ({ label, type, group });
  const m = {
    columns: [
      col("Kategori / Produk", "text"), col("Satuan", "text"), col("Jumlah", "qty", "Saldo Awal"), col("Nilai", "money", "Saldo Awal"), col("Jumlah", "qty", "Masuk"), col("Nilai", "money", "Masuk"),
      col("Jumlah", "qty", "Keluar"), col("Nilai", "money", "Keluar"), ...(showAdjust ? [col("Selisih Nilai", "money", "Koreksi")] : []), col("Jumlah", "qty", "Saldo Akhir"), col("Nilai", "money", "Saldo Akhir"),
      { label: "Penelusuran", type: "text", skipExport: true },
    ],
    rows: tableRows,
    indent: true,
    categoryColumn: true,
    empty: "Tidak ada saldo atau pergerakan bernilai pada periode ini.",
    subtitle: `${dateText(from)} s.d. ${dateText(to)}`,
    meta: [["Periode", `${dateText(from)} s.d. ${dateText(to)}`], ["Kategori", categories.find((c) => c.id === Number(query.get("categ")))?.display_name ?? ""], ["Pencarian", query.get("q") ?? ""]],
    note: "Saldo akhir = saldo awal + masuk - keluar. Masuk dan keluar adalah pergerakan yang melintasi batas perusahaan (penerimaan, pengiriman, produksi, penyesuaian, scrap); transfer antar lokasi internal tidak dihitung.",
    file: `inventory-valuation-mutasi-${from}-${to}`,
  };
  const totalOf = (pick) => sum(lines, pick);
  return {
    m,
    controls: `${searchBox(query.get("q") ?? "", "Cari produk atau kode")}${categorySelect(categories, Number(query.get("categ")) || null)}${dateInput("from", "Dari", from)}${dateInput("to", "Sampai", to)}${exportButtons}`,
    html:
      chip +
      `<div class="grid md:grid-cols-4 gap-4 mb-4">
        ${card("Saldo awal", esc(money(totalOf((r) => r.openValue))), `per ${esc(dateText(shift(from, -1)))}`)}
        ${card("Masuk", esc(money(totalOf((r) => r.inValue))), "penerimaan, produksi, penyesuaian lebih")}
        ${card("Keluar", esc(money(totalOf((r) => r.outValue))), "pengiriman, bahan produksi, penyesuaian kurang, scrap")}
        ${card("Saldo akhir", esc(money(totalOf((r) => r.closeValue))), `per ${esc(dateText(to))}${showAdjust ? `; termasuk koreksi nilai ${esc(money(totalOf((r) => r.adjust)))}` : ""}`)}
      </div>` +
      tableHtml(m) +
      `<p class="text-xs text-gray-500 mt-3">${esc(m.note)} Nilai keluar memakai biaya rata-rata saat pergerakan terjadi.${showAdjust ? ' Kolom "Koreksi" muncul bila saldo akhir berbeda dari saldo awal + masuk - keluar: perubahan biaya manual, pembulatan biaya rata-rata, atau stok minus.' : ""} Bila periode sampai hari ini, saldo akhir sama dengan Laporan Stok.${closing.length >= LIMIT ? ` Dibatasi ${LIMIT} produk.` : ""}</p>`,
  };
}

/* ---------- Tampilan 3: rincian pergerakan bernilai ---------- */

function docOf(m) {
  if (m.picking_id && PICKING_PAGES[m.picking_code]) return { text: m.picking_id[1], href: `#/${PICKING_PAGES[m.picking_code]}/${m.picking_id[0]}` };
  const order = m.production_id || m.raw_material_production_id;
  if (order) return { text: order[1], href: `#/mo/${order[0]}` };
  if (m.scrap_id) return { text: m.scrap_id[1], href: `#/scrap/${m.scrap_id[0]}` };
  return { text: m.reference || (m.is_inventory ? "Penyesuaian stok" : "-"), href: "" };
}

/** Jurnal terkait pergerakan: jurnal valuasi stok sendiri (bila ada) dan tagihan atau faktur terposting dari baris PO atau SO-nya. */
async function relatedJournals(moves) {
  const result = new Map(moves.map((m) => [m.id, m.account_move_id ? [{ id: m.account_move_id[0], name: m.account_move_id[1] }] : []]));
  const attach = (lines, keyOf, field) => {
    const byLine = new Map();
    for (const l of lines) for (const key of keyOf(l)) byLine.set(key, [...(byLine.get(key) ?? []), { id: l.move_id[0], name: l.move_id[1] }]);
    for (const m of moves) {
      const found = byLine.get(m[field]?.[0]) ?? [];
      for (const j of found) if (!result.get(m.id).some((x) => x.id === j.id)) result.get(m.id).push(j);
    }
  };
  const purchaseLines = [...new Set(moves.map((m) => m.purchase_line_id?.[0]).filter(Boolean))];
  const saleLines = [...new Set(moves.map((m) => m.sale_line_id?.[0]).filter(Boolean))];
  try {
    const [bills, invoices] = await Promise.all([
      purchaseLines.length ? searchRead("account.move.line", [["purchase_line_id", "in", purchaseLines], ["parent_state", "=", "posted"]], ["purchase_line_id", "move_id"], { limit: 2000 }) : [],
      saleLines.length ? searchRead("account.move.line", [["sale_line_ids", "in", saleLines], ["parent_state", "=", "posted"]], ["sale_line_ids", "move_id"], { limit: 2000 }) : [],
    ]);
    attach(bills, (l) => [l.purchase_line_id?.[0]].filter(Boolean), "purchase_line_id");
    attach(invoices, (l) => l.sale_line_ids ?? [], "sale_line_id");
  } catch {
    // tautan tagihan atau faktur hanya pelengkap; rincian tetap tampil tanpanya
  }
  return result;
}

async function viewMoves(query) {
  const to = pickDate(query.get("to"));
  let from = validDate(query.get("from")) || `${to.slice(0, 8)}01`;
  if (from > to) from = to;
  const direction = query.get("state") ?? "";
  const categories = await referenceCategories();
  const base = [["state", "=", "done"], ["date", ">=", `${from} 00:00:00`], ["date", "<=", `${to} 23:59:59`], ...productDomain(query, "product_id.")];
  const adjust = ["|", ["location_id.usage", "=", "inventory"], ["location_dest_id.usage", "=", "inventory"]];
  const scoped = direction === "in" ? [["is_in", "=", true]] : direction === "out" ? [["is_out", "=", true]] : ["|", ["is_in", "=", true], ["is_out", "=", true]];
  const domain = [...base, ...scoped, ...(direction === "adjust" ? adjust : [])];
  const totalOf = async (flag) => {
    const [g] = await call("stock.move", "formatted_read_group", { domain: [...domain, [flag, "=", true]], groupby: [], aggregates: ["value:sum", "__count"] });
    return { value: g?.["value:sum"] || 0, count: g?.__count || 0 };
  };
  const [moves, totalIn, totalOut, chip] = await Promise.all([
    searchRead("stock.move", domain, [
      "date", "reference", "picking_id", "picking_code", "production_id", "raw_material_production_id", "scrap_id", "is_inventory", "product_id", "location_id", "location_dest_id", "quantity", "product_uom",
      "value", "is_in", "is_out", "account_move_id", "purchase_line_id", "sale_line_id",
    ], { order: "date desc, id desc", limit: MOVE_LIMIT }),
    totalOf("is_in"), totalOf("is_out"), productChip(query),
  ]);
  const journals = await relatedJournals(moves);
  const tableRows = moves.map((mv) => {
    const sign = mv.is_in ? 1 : -1;
    const doc = docOf(mv);
    const kind = mv.is_in ? "Masuk" : "Keluar";
    const sub = mv.is_inventory ? "penyesuaian" : mv.scrap_id ? "scrap" : "";
    const js = journals.get(mv.id) ?? [];
    return {
      kind: "row",
      cells: [
        { v: mv.date, p: dateTimeText(mv.date), html: esc(dateTimeText(mv.date)) },
        { v: doc.text, html: doc.href ? link(doc.href, doc.text) : esc(doc.text) },
        mv.product_id[1],
        { v: sub ? `${kind} (${sub})` : kind, html: `<span class="${mv.is_in ? "text-emerald-700" : "text-rose-700"}">${esc(kind)}</span>${sub ? ` <span class="text-xs text-gray-500">${esc(sub)}</span>` : ""}` },
        mv.location_id[1],
        mv.location_dest_id[1],
        { v: sign * mv.quantity, p: `${nf.format(sign * mv.quantity)} ${mv.product_uom?.[1] ?? ""}`, html: esc(`${nf.format(sign * mv.quantity)} ${mv.product_uom?.[1] ?? ""}`) },
        mv.quantity ? mv.value / mv.quantity : 0,
        sign * mv.value,
        { v: js.map((j) => j.name).join("; "), html: js.length ? js.slice(0, 2).map((j) => link(`#/journal/${j.id}`, j.name)).join(", ") + (js.length > 2 ? ` +${js.length - 2}` : "") : '<span class="text-gray-400">-</span>' },
      ],
    };
  });
  const net = totalIn.value - totalOut.value;
  const m = {
    columns: [
      { label: "Tanggal", type: "text" }, { label: "Dokumen", type: "text" }, { label: "Produk", type: "text" }, { label: "Jenis", type: "text" }, { label: "Dari", type: "text" }, { label: "Ke", type: "text" },
      { label: "Jumlah", type: "qty" }, { label: "Biaya Satuan", type: "money" }, { label: "Nilai", type: "money" }, { label: "Jurnal", type: "text" },
    ],
    rows: tableRows,
    empty: "Tidak ada pergerakan bernilai pada rentang ini.",
    subtitle: `${dateText(from)} s.d. ${dateText(to)}`,
    meta: [["Periode", `${dateText(from)} s.d. ${dateText(to)}`], ["Jenis", DIRECTIONS.find(([k]) => k === direction)?.[1] ?? ""], ["Kategori", categories.find((c) => c.id === Number(query.get("categ")))?.display_name ?? ""], ["Pencarian", query.get("q") ?? ""]],
    note: `Masuk ${money(totalIn.value)}, keluar ${money(totalOut.value)}, bersih ${money(net)} (${totalIn.count + totalOut.count} pergerakan${moves.length >= MOVE_LIMIT ? `; ${MOVE_LIMIT} terbaru ditampilkan` : ""}).`,
    file: `inventory-valuation-pergerakan-${from}-${to}`,
  };
  return {
    m,
    controls: `${searchBox(query.get("q") ?? "", "Cari produk atau kode")}${categorySelect(categories, Number(query.get("categ")) || null)}${filterSelect(DIRECTIONS, direction)}${dateInput("from", "Dari", from)}${dateInput("to", "Sampai", to)}${exportButtons}`,
    html:
      chip +
      `<div class="grid md:grid-cols-3 gap-4 mb-4">
        ${card("Masuk", esc(money(totalIn.value)), `${totalIn.count} pergerakan`)}
        ${card("Keluar", esc(money(totalOut.value)), `${totalOut.count} pergerakan`)}
        ${card("Bersih", esc(money(net)), `${esc(dateText(from))} s.d. ${esc(dateText(to))}`, net < 0 ? "text-rose-700" : "")}
      </div>` +
      tableHtml(m) +
      `<p class="text-xs text-gray-500 mt-3">Hanya pergerakan selesai yang masuk atau keluar dari persediaan perusahaan (nilai positif = masuk, negatif = keluar). Biaya satuan = nilai pergerakan dibagi jumlahnya. Kolom Jurnal berisi jurnal valuasi pergerakan itu bila ada, atau tagihan dan faktur terposting dari baris PO dan SO-nya; penerimaan, penyesuaian, dan scrap umumnya belum dijurnal (Odoo 19 menjurnal persediaan saat tagihan dan faktur diposting).${moves.length >= MOVE_LIMIT ? ` Menampilkan ${MOVE_LIMIT} terbaru; persempit dengan tanggal atau pencarian (total di atas mencakup semua).` : ""}</p>`,
  };
}

/* ---------- Tampilan 4: per akun persediaan ---------- */

async function viewAccount(query) {
  const date = pickDate(query.get("date"));
  const [scopes, categories] = await Promise.all([loadScopes(), valuationCategories()]);
  const everywhere = scopeOf("", scopes);
  const accountIds = [...new Set(categories.map((c) => c.property_stock_valuation_account_id?.[0]).filter(Boolean))];
  const [rows, gl] = await Promise.all([valuationRows(date, new URLSearchParams(), everywhere), glBalances(accountIds, date)]);
  const valueOf = new Map();
  const countOf = new Map();
  for (const r of rows) {
    valueOf.set(r.categ.id, (valueOf.get(r.categ.id) ?? 0) + r.value);
    if (!isZero(r.qty, r.value)) countOf.set(r.categ.id, (countOf.get(r.categ.id) ?? 0) + 1);
  }
  const accounts = new Map();
  const accountOf = (c) => c.property_stock_valuation_account_id;
  for (const c of categories) {
    const key = accountOf(c)?.[0] ?? 0;
    if (!accounts.has(key)) accounts.set(key, { id: key, name: accountOf(c)?.[1] ?? "Tanpa akun valuasi (valuasi manual atau tanpa akun)", cats: [] });
    accounts.get(key).cats.push(c);
  }
  if (valueOf.has(0)) {
    if (!accounts.has(0)) accounts.set(0, { id: 0, name: "Tanpa akun valuasi (valuasi manual atau tanpa akun)", cats: [] });
    accounts.get(0).cats.push({ id: 0, display_name: "Tanpa kategori", property_valuation: false });
  }
  const METHOD = { real_time: "Perpetual", periodic: "Periodik", manual: "Manual" };
  const tableRows = [];
  const csvRows = [];
  let stockTotal = 0;
  let glTotal = 0;
  let accountRows = 0;
  for (const a of [...accounts.values()].sort((x, y) => x.name.localeCompare(y.name, "id"))) {
    const cats = a.cats.filter((c) => Math.abs(valueOf.get(c.id) ?? 0) >= 0.000001 || countOf.has(c.id));
    const stock = sum(cats, (c) => valueOf.get(c.id) ?? 0);
    const balance = a.id ? gl.get(a.id) ?? 0 : null;
    if (!cats.length && !(balance && Math.abs(balance) >= EPS)) continue;
    stockTotal += stock;
    glTotal += balance ?? 0;
    accountRows += 1;
    tableRows.push({ kind: "group", cells: [a.name, cats.length > 1 ? `${cats.length} kategori` : "", stock, balance ?? "", balance === null ? "" : stock - balance] });
    csvRows.push([a.name, cats.map((c) => c.display_name).join("; "), stock, balance ?? "", balance === null ? "" : stock - balance]);
    for (const c of cats) {
      tableRows.push({
        kind: "row",
        cells: [{ v: c.display_name, html: c.id ? link(`#/valuation/asof?categ=${c.id}&date=${date}`, c.display_name) : esc(c.display_name) }, `${METHOD[c.property_valuation] ?? ""}${c.property_cost_method ? `, biaya ${c.property_cost_method === "average" ? "rata-rata" : c.property_cost_method === "fifo" ? "FIFO" : "standar"}` : ""}`, valueOf.get(c.id) ?? 0, "", ""],
      });
    }
  }
  tableRows.push({ kind: "total", cells: ["Total", "", stockTotal, glTotal, stockTotal - glTotal] });
  csvRows.push(["Total", "", stockTotal, glTotal, stockTotal - glTotal]);
  const m = {
    columns: [{ label: "Akun / Kategori", type: "text" }, { label: "Metode", type: "text" }, { label: "Nilai Stok", type: "money" }, { label: "Saldo Buku Besar", type: "money" }, { label: "Selisih", type: "money" }],
    rows: tableRows,
    csv: { header: ["Akun", "Kategori", "Nilai Stok", "Saldo Buku Besar", "Selisih"], rows: csvRows },
    empty: "Belum ada kategori dengan akun persediaan.",
    subtitle: `Per ${dateText(date)}`,
    meta: [["Tanggal", dateText(date)]],
    note: "Selisih wajar bila ada barang diterima yang belum ditagih (Odoo menjurnal persediaan saat tagihan diposting) atau penyesuaian stok dan scrap (Odoo 19 tidak menjurnalnya otomatis).",
    file: `inventory-valuation-akun-${date}`,
  };
  const difference = stockTotal - glTotal;
  return {
    m,
    controls: `${dateInput("date", "Per tanggal", date)}${exportButtons}`,
    html:
      `<div class="grid md:grid-cols-3 gap-4 mb-4">
        ${card("Nilai stok", esc(money(stockTotal)), `per ${esc(dateText(date))}, ${accountRows} akun`)}
        ${card("Saldo buku besar", esc(money(glTotal)), "jurnal terposting pada akun persediaan sampai tanggal itu")}
        ${card("Selisih", esc(money(difference)), Math.abs(difference) < EPS ? "sama" : "perlu dijelaskan; lihat catatan di bawah", Math.abs(difference) < EPS ? "text-emerald-700" : "text-amber-700")}
      </div>` +
      tableHtml(m) +
      `<div class="text-xs text-gray-600 mt-3 space-y-1">
        <p><b>Mengapa selisih terjadi.</b> (1) Barang yang sudah diterima tetapi belum ditagih sudah masuk nilai stok, sedangkan jurnalnya baru terbentuk saat tagihan vendor diposting. (2) Penyesuaian stok dan scrap hanya tercatat pada nilai pergerakan stok; Odoo 19 tidak membuat jurnalnya pada valuasi perpetual ini. (3) Jurnal manual atau koreksi langsung pada akun persediaan ikut dalam saldo buku besar. (4) Selisih pembulatan biaya rata-rata.</p>
        <p>Telusuri pergerakannya di ${link(`#/valuation/moves?state=adjust&from=2000-01-01&to=${date}`, "Rincian Pergerakan (penyesuaian dan scrap)", "text-indigo-700 underline")}. Klik kategori untuk melihat nilai per produk pada tanggal ini.</p>
      </div>`,
  };
}

const VIEWS = { asof: viewAsOf, period: viewPeriod, moves: viewMoves, account: viewAccount };

/* ---------- Halaman ---------- */

function tabsHtml(active, query) {
  const href = (key) => {
    const p = new URLSearchParams();
    for (const k of ["categ", "q", "product"]) if (query.get(k) && key !== "account") p.set(k, query.get(k));
    if (key === "asof" || key === "account") {
      const date = query.get("date") ?? query.get("to");
      if (date) p.set("date", date);
      if (key === "asof" && query.get("scope")) p.set("scope", query.get("scope"));
    } else {
      if (query.get("from") && query.get("from") !== "2000-01-01") p.set("from", query.get("from"));
      const to = query.get("to") ?? query.get("date");
      if (to) p.set("to", to);
    }
    const qs = p.toString();
    return `#/valuation/${key}${qs ? `?${qs}` : ""}`;
  };
  return `<div class="inline-flex rounded-lg border border-gray-300 overflow-hidden bg-white text-sm mb-4 max-w-full overflow-x-auto">${TABS.map(
    ([key, label]) => `<a href="${esc(href(key))}" class="px-4 py-2 whitespace-nowrap ${key === active ? "bg-indigo-600 text-white" : "hover:bg-gray-50"}">${label}</a>`,
  ).join("")}</div>`;
}

export async function render(sub, query) {
  const tab = VIEWS[sub] ? sub : "asof";
  last = { sub: tab, query };
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat nilai persediaan...</p>';
  const view = await VIEWS[tab](query);
  report = view.m;
  app.innerHTML = pageHeader("Inventory Valuation", view.controls) + tabsHtml(tab, query) + view.html;
}

export async function onClick(event, el) {
  if (!report) return;
  if (el.dataset.action === "csv") {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([`﻿${csvText(report)}`], { type: "text/csv;charset=utf-8" }));
    link.download = `${report.file}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  } else if (el.dataset.action === "print") {
    await printReport(printDoc(report), el);
  }
}

export function onChange(event, el) {
  const key = el.dataset.vl;
  if (!key) return;
  const params = new URLSearchParams(last.query);
  if (el.value) params.set(key, el.value);
  else params.delete(key);
  const qs = params.toString();
  location.hash = `#/valuation/${last.sub}${qs ? `?${qs}` : ""}`;
}
