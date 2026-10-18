// Bill of Material (mrp.bom). Form mengikuti form BoM Odoo 19: produk jadi, jumlah dan satuan, tipe (produksi atau kit),
// komponen, produk sampingan (bila fiturnya aktif), dan operasi per work center (bila Work Orders aktif). Kartu biaya
// memakai laporan struktur BoM Odoo: biaya komponen ditambah biaya operasi.
import {
  INPUT, app, badge, call, cell, changedValues, chatterHtml, closeLookup, esc, fieldBlock, fieldValue, filterSelect, guarded, hasGroup, loadMessages,
  money, pageHeader, readOne, readonlyValue, referenceUoms, registerLookup, rowLink, runLookup, searchBox, searchRead, selectOptions, statTiles, table,
  toast, button,
} from "../common.js";
import { compareAction, compareBadge, compareChange, renderCompare } from "./bomcompare.js";

const TYPES = { normal: "Produksi (manufacture)", phantom: "Kit" };
const CONSUMPTION = { flexible: "Boleh", warning: "Boleh dengan peringatan", strict: "Diblokir" };
const FILTERS = [["active", "Aktif"], ["archived", "Diarsipkan"], ["all", "Semua"]];
const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 3 });

let form = null; // { id, values, initial, product, lines, byproducts, ops, removed: { lines, byproducts, ops } }
let last = { sub: "", query: new URLSearchParams() };
let features = null; // { byproducts, routings }
export const leave = () => {
  form = null;
  features = null;
};
const reload = () => render(last.sub, last.query);

const SECTIONS = {
  lines: { model: "mrp.bom.line", key: "bom_line_ids", lookup: "bom-line-product", title: "Komponen" },
  byproducts: { model: "mrp.bom.byproduct", key: "byproduct_ids", lookup: "bom-byproduct-product", title: "Produk Sampingan" },
};

const productSearch = (extra) => (q) =>
  searchRead("product.product", [["type", "=", "consu"], ...extra, ...(q ? ["|", ["name", "ilike", q], ["default_code", "ilike", q]] : [])], ["display_name", "uom_id"], {
    limit: 10, order: "name",
  });

registerLookup("bom-product", {
  search: (q) =>
    searchRead("product.template", [["type", "=", "consu"], ...(q ? ["|", ["name", "ilike", q], ["default_code", "ilike", q]] : [])], ["display_name", "uom_id"], {
      limit: 10, order: "name",
    }),
  sub: (r) => r.uom_id?.[1] ?? "",
  isChosen: (input) => form?.product?.display_name === input.value,
  choose: (input, item) => {
    form.product = item;
    form.values.uomId = item.uom_id[0];
    input.value = item.display_name;
    repaintHeaderUnit();
  },
});
for (const [name, section] of Object.entries(SECTIONS)) {
  registerLookup(section.lookup, {
    search: productSearch([]),
    sub: (r) => r.uom_id?.[1] ?? "",
    isChosen: (input) => {
      const row = form?.[name][Number(input.dataset.row)];
      return Boolean(row?.product) && row.text === input.value;
    },
    choose: (input, item) => {
      const row = form[name][Number(input.dataset.row)];
      Object.assign(row, { product: item, text: item.display_name, uomId: item.uom_id[0] });
      paintSection(name);
      document.querySelector(`[data-section="${name}"][data-row="${input.dataset.row}"][data-field="qty"]`)?.focus();
    },
  });
}

function repaintHeaderUnit() {
  const select = document.querySelector('[data-bom="uomId"]');
  if (select) select.value = String(form.values.uomId);
}

async function loadFeatures() {
  const [byproducts, routings] = await Promise.all([hasGroup("mrp.group_mrp_byproducts"), hasGroup("mrp.group_mrp_routings")]);
  features = { byproducts, routings };
}

export async function render(sub, query) {
  last = { sub, query };
  if (sub === "") return renderList(query);
  if (sub === "compare") return renderCompare(query);
  return renderForm(sub === "new" ? null : Number(sub), query);
}

async function renderList(query) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const filter = query.get("state") || "active";
  const text = query.get("q") ?? "";
  const product = Number(query.get("product")) || null;
  const domain = [];
  if (filter === "archived") domain.push(["active", "=", false]);
  if (product) domain.push(["product_tmpl_id", "=", product]);
  if (text) domain.push("|", "|", ["product_tmpl_id.name", "ilike", text], ["code", "ilike", text], ["bom_line_ids.product_id.name", "ilike", text]);
  const rows = await searchRead("mrp.bom", domain, ["code", "product_tmpl_id", "product_qty", "product_uom_id", "type", "bom_line_ids", "operation_ids", "active"], {
    order: "product_tmpl_id, sequence, id", limit: 100, context: { active_test: filter === "active" },
  });
  const perProduct = new Map();
  rows.forEach((r) => perProduct.set(r.product_tmpl_id[0], (perProduct.get(r.product_tmpl_id[0]) ?? 0) + 1));
  const body = rows
    .map((r) =>
      rowLink(`#/bom/${r.id}`, [
        cell(`${esc(r.product_tmpl_id[1])} ${compareBadge(perProduct.get(r.product_tmpl_id[0]), r.product_tmpl_id[0])}`, { strong: true, raw: true }),
        cell(r.code || "-"),
        cell(TYPES[r.type] ?? r.type),
        cell(`${nf.format(r.product_qty)} ${r.product_uom_id?.[1] ?? ""}`, { right: true }),
        cell(String(r.bom_line_ids.length), { right: true }),
        cell(String(r.operation_ids.length), { right: true }),
        cell(r.active ? "" : badge({ archived: ["Diarsipkan", "muted"] }, "archived"), { raw: true }),
      ]),
    )
    .join("");
  app.innerHTML =
    pageHeader(
      "Bill of Material",
      `${searchBox(text, "Cari produk, kode, komponen")}${filterSelect(FILTERS, filter)}
       ${product && rows.length > 1 ? `<a href="#/bom/compare?product=${product}" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50"><i class="fas fa-code-compare mr-2"></i>Bandingkan ${rows.length} BoM</a>` : ""}
       <a href="#/bom/new" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"><i class="fas fa-plus mr-2"></i>BoM Baru</a>`,
    ) +
    table(
      [{ label: "Produk Jadi" }, { label: "Kode" }, { label: "Tipe" }, { label: "Jumlah", right: true }, { label: "Komponen", right: true }, { label: "Operasi", right: true }, { label: "" }],
      body,
      "Belum ada BoM. Buat dengan tombol BoM Baru.",
    );
}

const emptyRow = (name) => (name === "byproducts" ? { id: null, product: null, text: "", qty: 1, uomId: null, share: 0 } : { id: null, product: null, text: "", qty: 1, uomId: null });
const emptyOp = () => ({ id: null, name: "", wcId: null, minutes: 60 });

function uomSelect(uoms, row, name, i) {
  return `<select data-section="${name}" data-row="${i}" data-field="uomId" class="${INPUT}" aria-label="Satuan">${selectOptions(uoms, row.uomId, "-")}</select>`;
}

let uomList = [];
let centers = [];

function sectionTable(name) {
  const rows = form[name]
    .map(
      (r, i) => `<tr class="align-top">
        <td class="py-2 pr-2 min-w-48"><input data-lookup="${SECTIONS[name].lookup}" autocomplete="off" role="combobox" aria-autocomplete="list" data-section="${name}" data-row="${i}" data-field="text" value="${esc(r.text)}" placeholder="Cari produk..." class="${INPUT}"></td>
        <td class="py-2 px-2 w-28"><input type="number" min="0" step="any" data-section="${name}" data-row="${i}" data-field="qty" value="${esc(r.qty)}" class="${INPUT} text-right" aria-label="Jumlah"></td>
        <td class="py-2 px-2 w-36">${uomSelect(uomList, r, name, i)}</td>
        ${name === "byproducts" ? `<td class="py-2 px-2 w-28"><input type="number" min="0" max="100" step="any" data-section="${name}" data-row="${i}" data-field="share" value="${esc(r.share)}" class="${INPUT} text-right" aria-label="Porsi biaya (%)"></td>` : ""}
        <td class="py-2 pl-2 w-10 text-center"><button type="button" data-action="remove-row" data-section="${name}" data-row="${i}" class="text-gray-400 hover:text-rose-600 mt-2" aria-label="Hapus baris"><i class="fas fa-trash-alt"></i></button></td></tr>`,
    )
    .join("");
  const heads = name === "byproducts" ? ["Produk", "Jumlah", "Satuan", "Porsi Biaya (%)", ""] : ["Komponen", "Jumlah", "Satuan", ""];
  return `<table class="w-full text-left"><thead><tr>${heads.map((h, i) => `<th class="pb-2 px-2 text-xs font-semibold text-gray-600 uppercase ${i === 1 || (name === "byproducts" && i === 3) ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>
    <tbody>${rows}</tbody></table>
    <button type="button" data-action="add-row" data-section="${name}" class="mt-1 text-sm text-indigo-600 font-medium hover:text-indigo-800"><i class="fas fa-plus mr-1"></i>Tambah baris</button>`;
}

function opsTable() {
  const rows = form.ops
    .map(
      (o, i) => `<tr class="align-top">
        <td class="py-2 pr-2 min-w-40"><input data-section="ops" data-row="${i}" data-field="name" value="${esc(o.name)}" placeholder="mis. Panggang" class="${INPUT}" aria-label="Nama operasi"></td>
        <td class="py-2 px-2 min-w-48"><select data-section="ops" data-row="${i}" data-field="wcId" class="${INPUT}" aria-label="Work center">${selectOptions(centers, o.wcId, "Pilih work center...")}</select></td>
        <td class="py-2 px-2 w-32"><input type="number" min="0" step="any" data-section="ops" data-row="${i}" data-field="minutes" value="${esc(o.minutes)}" class="${INPUT} text-right" aria-label="Durasi (menit)"></td>
        <td class="py-2 pl-2 w-10 text-center"><button type="button" data-action="remove-row" data-section="ops" data-row="${i}" class="text-gray-400 hover:text-rose-600 mt-2" aria-label="Hapus operasi"><i class="fas fa-trash-alt"></i></button></td></tr>`,
    )
    .join("");
  return `<table class="w-full text-left"><thead><tr>${["Operasi", "Work Center", "Durasi per Siklus (menit)", ""].map((h, i) => `<th class="pb-2 px-2 text-xs font-semibold text-gray-600 uppercase ${i === 2 ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>
    <tbody>${rows}</tbody></table>
    <button type="button" data-action="add-row" data-section="ops" class="mt-1 text-sm text-indigo-600 font-medium hover:text-indigo-800"><i class="fas fa-plus mr-1"></i>Tambah operasi</button>`;
}

function paintSection(name) {
  const box = document.querySelector(`#box-${name}`);
  if (box) box.innerHTML = name === "ops" ? opsTable() : sectionTable(name);
}

/** Kartu biaya dari laporan struktur BoM Odoo (komponen, operasi, total, dan per unit). */
async function costCard(bom) {
  try {
    const { lines: report } = await call("report.mrp.report_bom_structure", "get_html", { bom_id: bom.id, searchQty: bom.product_qty, searchVariant: false });
    const components = (report.components ?? []).reduce((sum, c) => sum + (c.bom_cost || 0), 0);
    const operations = report.operations_cost || 0;
    const total = report.bom_cost || 0;
    const card = (label, value, hint = "") =>
      `<div class="bg-white rounded-xl border border-gray-200 shadow-sm p-4"><div class="text-xs font-medium text-gray-500 uppercase">${label}</div><div class="text-xl font-semibold mt-1">${esc(value)}</div>${hint ? `<div class="text-xs text-gray-500 mt-1">${esc(hint)}</div>` : ""}</div>`;
    return `<div class="grid md:grid-cols-4 gap-4 mb-4">
      ${card(`Biaya komponen (${nf.format(bom.product_qty)} unit)`, money(components))}
      ${card("Biaya operasi", money(operations), report.operations_time ? `${nf.format(report.operations_time)} menit` : "tanpa operasi")}
      ${card("Total biaya BoM", money(total), components + operations - total > 0.5 ? `sudah dikurangi porsi produk sampingan ${money(components + operations - total)}` : "")}
      ${card("Biaya per unit", money(bom.product_qty ? total / bom.product_qty : 0), "biaya komponen saat ini, bukan biaya valuasi")}</div>`;
  } catch {
    return "";
  }
}

const normalize = (bom) => ({
  type: bom.type || "normal", qty: bom.product_qty ?? 1, uomId: bom.product_uom_id?.[0] ?? null, code: bom.code || "", consumption: bom.consumption || "warning", delay: bom.produce_delay ?? 0,
});

async function renderForm(id, query) {
  closeLookup();
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const [uoms, wcs] = await Promise.all([referenceUoms(), searchRead("mrp.workcenter", [], ["display_name"], { order: "sequence, name" }), features ? null : loadFeatures()]);
  uomList = uoms;
  centers = wcs;
  let bom = null;
  if (id) {
    bom = await readOne("mrp.bom", id, ["code", "type", "product_tmpl_id", "product_qty", "product_uom_id", "consumption", "produce_delay", "active", "bom_line_ids", "byproduct_ids", "operation_ids"]);
    if (!bom) {
      app.innerHTML = '<p class="text-sm text-rose-600">BoM tidak ditemukan.</p>';
      return;
    }
  }
  if (!form || form.id !== (bom?.id ?? null)) {
    if (bom) {
      const [lines, byproducts, ops, product] = await Promise.all([
        bom.bom_line_ids.length ? searchRead("mrp.bom.line", [["id", "in", bom.bom_line_ids]], ["product_id", "product_qty", "product_uom_id"], { order: "sequence, id" }) : [],
        bom.byproduct_ids.length ? searchRead("mrp.bom.byproduct", [["id", "in", bom.byproduct_ids]], ["product_id", "product_qty", "product_uom_id", "cost_share"], { order: "sequence, id" }) : [],
        bom.operation_ids.length ? searchRead("mrp.routing.workcenter", [["id", "in", bom.operation_ids]], ["name", "workcenter_id", "time_cycle_manual", "time_mode"], { order: "sequence, id" }) : [],
        searchRead("product.template", [["id", "=", bom.product_tmpl_id[0]]], ["display_name", "uom_id"], { limit: 1 }),
      ]);
      const rowOf = (r) => ({ id: r.id, product: { id: r.product_id[0], display_name: r.product_id[1] }, text: r.product_id[1], qty: r.product_qty, uomId: r.product_uom_id[0] });
      const values = normalize(bom);
      form = {
        id: bom.id, values, initial: { ...values }, product: product[0],
        lines: bom.bom_line_ids.length ? lines.map(rowOf) : [emptyRow("lines")],
        byproducts: byproducts.map((r) => ({ ...rowOf(r), share: r.cost_share })),
        ops: ops.map((o) => ({ id: o.id, name: o.name, wcId: o.workcenter_id[0], minutes: o.time_cycle_manual })),
        removed: { lines: [], byproducts: [], ops: [] },
        initialRows: { lines: lines.map((r) => ({ id: r.id, p: r.product_id[0], q: r.product_qty, u: r.product_uom_id[0] })), byproducts: byproducts.map((r) => ({ id: r.id, p: r.product_id[0], q: r.product_qty, u: r.product_uom_id[0], s: r.cost_share })), ops: ops.map((o) => ({ id: o.id, n: o.name, w: o.workcenter_id[0], m: o.time_cycle_manual })) },
      };
    } else {
      const wanted = Number(query?.get("product")) || null;
      const product = wanted ? (await searchRead("product.template", [["id", "=", wanted]], ["display_name", "uom_id"], { limit: 1 }))[0] ?? null : null;
      const values = { type: "normal", qty: 1, uomId: product?.uom_id?.[0] ?? uoms[0]?.id ?? null, code: "", consumption: "warning", delay: 0 };
      form = { id: null, values, initial: null, product, lines: [emptyRow("lines")], byproducts: [], ops: [], removed: { lines: [], byproducts: [], ops: [] }, initialRows: { lines: [], byproducts: [], ops: [] } };
    }
  }
  const v = form.values;
  const cost = bom ? await costCard(bom) : "";
  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/bom" class="hover:text-indigo-600">Bill of Material</a> / ${esc(form.product?.display_name ?? "Baru")}</div>
    <div class="flex flex-wrap items-center gap-2 mb-3">
      ${bom ? button("new-mo", "Buat Manufacturing Order", "primary", { id: bom.id }) + button("toggle-active", bom.active ? "Arsipkan" : "Aktifkan Kembali", bom.active ? "danger" : "primary", { id: bom.id }) : ""}
    </div>
    ${bom ? `<div class="flex flex-wrap gap-2 mb-4">${statTiles([
      { count: bom.bom_line_ids.length, label: "Komponen", icon: "fa-cubes", target: "box-lines" },
      { count: bom.operation_ids.length, label: "Operasi", icon: "fa-gears", target: "box-ops" },
    ])}</div>` : ""}
    <h1 class="text-2xl font-bold text-gray-900 mb-3">${esc(form.product?.display_name ?? "BoM Baru")}${bom && !bom.active ? ' <span class="ml-2 align-middle px-2 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-600">Diarsipkan</span>' : ""}</h1>
    ${cost}
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-2 gap-x-8 gap-y-4">
      ${fieldBlock("Produk Jadi", bom
        ? readonlyValue(bom.product_tmpl_id[1])
        : `<input data-lookup="bom-product" autocomplete="off" role="combobox" aria-autocomplete="list" value="${esc(form.product?.display_name ?? "")}" placeholder="Cari produk..." class="${INPUT}">`)}
      ${fieldBlock("Tipe BoM", `<select data-bom="type" class="${INPUT}">${Object.entries(TYPES).map(([k, label]) => `<option value="${k}" ${k === v.type ? "selected" : ""}>${esc(label)}</option>`).join("")}</select>`)}
      ${fieldBlock("Jumlah", `<input type="number" min="0" step="any" data-bom="qty" data-kind="number" value="${esc(v.qty)}" class="${INPUT} text-right">`)}
      ${fieldBlock("Satuan", `<select data-bom="uomId" data-kind="id" class="${INPUT}">${selectOptions(uoms, v.uomId, "-")}</select>`)}
      ${fieldBlock("Referensi", `<input data-bom="code" value="${esc(v.code)}" class="${INPUT}">`)}
      ${fieldBlock("Konsumsi Fleksibel", `<select data-bom="consumption" class="${INPUT}">${Object.entries(CONSUMPTION).map(([k, label]) => `<option value="${k}" ${k === v.consumption ? "selected" : ""}>${esc(label)}</option>`).join("")}</select>`)}
      ${fieldBlock("Lead Time Produksi (hari)", `<input type="number" min="0" step="1" data-bom="delay" data-kind="number" value="${esc(v.delay)}" class="${INPUT} text-right">`)}
    </section>
    <section id="box-lines-section" class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 p-4 overflow-x-auto"><div class="text-sm font-semibold mb-2">Komponen</div><div id="box-lines">${sectionTable("lines")}</div></section>
    ${features.byproducts ? `<section class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 p-4 overflow-x-auto"><div class="text-sm font-semibold mb-2">Produk Sampingan</div><div id="box-byproducts">${sectionTable("byproducts")}</div></section>` : ""}
    ${features.routings
      ? `<section class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 p-4 overflow-x-auto"><div class="text-sm font-semibold mb-2">Operasi</div><div id="box-ops">${opsTable()}</div></section>`
      : `<p class="mt-4 text-sm text-sky-900 bg-sky-50 border border-sky-200 rounded-lg px-4 py-3">Operasi dan work order belum aktif. Aktifkan di <a href="#/workcenter" class="underline">WorkCenter</a> (bagian Fitur manufaktur).</p>`}
    <div class="flex gap-2 mt-4">
      <button data-action="save" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Simpan</button>
      <a href="#/bom" data-action="discard" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Buang</a>
    </div>
    ${bom ? chatterHtml("mrp.bom", bom.id) : ""}`;
  if (bom) loadMessages("mrp.bom", bom.id);
}

/** Perintah one2many dari baris form: buat, ubah yang berbeda, hapus yang dibuang. */
function commands(name) {
  const rows = form[name].filter((r) => (name === "ops" ? r.name.trim() || r.wcId : r.product));
  const initial = new Map(form.initialRows[name].map((r) => [r.id, r]));
  const out = [];
  for (const r of rows) {
    const qty = Number(r.qty);
    if (name !== "ops") {
      if (!(qty > 0)) throw new Error(`Jumlah ${r.text || "komponen"} harus lebih dari 0.`);
      if (!r.uomId) throw new Error(`Pilih satuan untuk ${r.text}.`);
    }
    let vals;
    if (name === "ops") {
      if (!r.name.trim()) throw new Error("Isi nama operasi.");
      if (!r.wcId) throw new Error(`Pilih work center untuk operasi ${r.name}.`);
      if (!(Number(r.minutes) >= 0)) throw new Error("Durasi operasi tidak boleh negatif.");
      vals = { name: r.name.trim(), workcenter_id: r.wcId, time_mode: "manual", time_cycle_manual: Number(r.minutes) };
    } else {
      vals = { product_id: r.product.id, product_qty: qty, product_uom_id: r.uomId, ...(name === "byproducts" ? { cost_share: Number(r.share) || 0 } : {}) };
    }
    if (!r.id) out.push([0, 0, vals]);
    else {
      const before = initial.get(r.id);
      const same = name === "ops"
        ? before.n === vals.name && before.w === vals.workcenter_id && before.m === vals.time_cycle_manual
        : before.p === vals.product_id && before.q === vals.product_qty && before.u === vals.product_uom_id && (name !== "byproducts" || before.s === vals.cost_share);
      if (!same) out.push([1, r.id, vals]);
    }
  }
  for (const rid of form.removed[name]) out.push([2, rid, 0]);
  return out;
}

async function persist() {
  const v = form.values;
  if (!form.id && !form.product) throw new Error("Pilih produk jadi dari kotak saran.");
  if (!(Number(v.qty) > 0)) throw new Error("Jumlah BoM harus lebih dari 0.");
  if (!v.uomId) throw new Error("Pilih satuan BoM.");
  if (!form.lines.some((r) => r.product)) throw new Error("Tambahkan minimal satu komponen.");
  const header = { type: v.type, product_qty: Number(v.qty), product_uom_id: v.uomId, code: v.code.trim() || false, consumption: v.consumption, produce_delay: Number(v.delay) || 0 };
  const rels = { bom_line_ids: commands("lines") };
  if (features.byproducts) rels.byproduct_ids = commands("byproducts");
  if (features.routings) rels.operation_ids = commands("ops");
  if (!form.id) {
    const create = Object.fromEntries(Object.entries(rels).filter(([, c]) => c.length));
    const [newId] = await call("mrp.bom", "create", { vals_list: [{ product_tmpl_id: form.product.id, ...header, ...create }] });
    return newId;
  }
  const changed = changedValues(v, form.initial, Object.keys(v));
  const vals = {};
  const map = { type: "type", qty: "product_qty", uomId: "product_uom_id", code: "code", consumption: "consumption", delay: "produce_delay" };
  for (const key of Object.keys(changed)) vals[map[key]] = header[map[key]];
  for (const [key, list] of Object.entries(rels)) if (list.length) vals[key] = list;
  if (Object.keys(vals).length) await call("mrp.bom", "write", { ids: [form.id], vals });
  return form.id;
}

export async function onClick(event, el) {
  const { action } = el.dataset;
  const id = Number(el.dataset.id) || null;
  if (compareAction(action, el)) return;
  if (action === "refresh") reload();
  else if (action === "discard") form = null;
  else if (action === "add-row") {
    const name = el.dataset.section;
    form[name].push(name === "ops" ? emptyOp() : emptyRow(name));
    paintSection(name);
  } else if (action === "remove-row") {
    const name = el.dataset.section;
    const [removed] = form[name].splice(Number(el.dataset.row), 1);
    if (removed?.id) form.removed[name].push(removed.id);
    if (!form[name].length && name === "lines") form[name].push(emptyRow(name));
    paintSection(name);
  } else if (action === "new-mo") location.hash = `#/mo/new?bom=${id}`;
  else if (action === "save") {
    const saved = await guarded(el, persist);
    if (saved) {
      const wasNew = !form.id;
      form = null;
      toast(wasNew ? "BoM dibuat." : "Perubahan disimpan.");
      if (wasNew) location.hash = `#/bom/${saved}`;
      else reload();
    }
  } else if (action === "toggle-active") {
    const archiving = el.textContent.trim() === "Arsipkan";
    if (archiving && !window.confirm("Arsipkan BoM ini? Manufacturing Order yang sudah ada tidak berubah.")) return;
    const ok = await guarded(el, () => call("mrp.bom", archiving ? "action_archive" : "action_unarchive", { ids: [id] }));
    if (ok !== undefined) {
      form = null;
      toast(archiving ? "BoM diarsipkan." : "BoM diaktifkan kembali.");
      reload();
    }
  }
}

export function onChange(event, el) {
  compareChange(el, reload);
}

export function onInput(event, el) {
  if (!form) return;
  if (el.dataset.bom) form.values[el.dataset.bom] = fieldValue(el);
  else if (el.dataset.section) {
    const row = form[el.dataset.section][Number(el.dataset.row)];
    const field = el.dataset.field;
    if (field === "uomId" || field === "wcId") row[field] = el.value ? Number(el.value) : null;
    else row[field] = el.value;
    if (field === "text") {
      row.product = null;
      runLookup(el, 250);
    }
  } else if (el.dataset.lookup === "bom-product") {
    form.product = null;
    runLookup(el, 250);
  }
}
