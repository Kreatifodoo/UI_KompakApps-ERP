// Manufacturing Order (mrp.production). Alur mengikuti Odoo 19: draft, konfirmasi (komponen dicadangkan), produksi dengan
// jumlah komponen yang dikonsumsi, tandai selesai (wizard backorder dan peringatan konsumsi), work order, scrap, dan
// unbuild. Nilai persediaan tercatat pada pergerakan stok; Odoo tidak membuat jurnal saat produksi.
import {
  INPUT, app, badge, call, cell, chatterHtml, closeLookup, closeModal, ctx, dateTimeText, esc, fieldBlock, filterSelect, fromInputDateTime, guarded,
  loadMessages, money, openModal, pageHeader, readOne, readonlyValue, referenceUsers, referenceWarehouses, registerLookup, rowLink, runLookup, searchBox, searchRead,
  selectOptions, statTiles, statusbar, table, toast, toInputDateTime, actionBar,
} from "../common.js";
import { printButton } from "../print.js";
import { productionJournals } from "../stockjournal.js";

const STATES = {
  draft: ["Draft", "muted"],
  confirmed: ["Dikonfirmasi", "info"],
  progress: ["Diproduksi", "warning"],
  to_close: ["Siap Ditutup", "warning"],
  done: ["Selesai", "success"],
  cancel: ["Dibatalkan", "danger"],
};
const FLOW = ["draft", "confirmed", "progress", "to_close", "done"];
const AVAILABILITY = { available: ["Tersedia", "success"], expected: ["Diharapkan", "info"], late: ["Terlambat", "warning"], unavailable: ["Tidak tersedia", "danger"] };
const WO_STATES = { blocked: ["Menunggu Operasi Lain", "warning"], ready: ["Siap", "info"], progress: ["Berjalan", "warning"], done: ["Selesai", "success"], cancel: ["Dibatalkan", "danger"] };
const OPEN = ["confirmed", "progress", "to_close"];
const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 4 });
const round = (n) => Math.round(n * 10000) / 10000;

let form = null; // MO baru: { id: null, product, bomId, boms, values } ; MO ada: { id, values, initial }
let prod = null; // panel produksi: { qty, consume: Map(id move -> teks), touched: Set, lot, serials }
let moData = null; // MO yang sedang dibuka, untuk dialog
let pendingChoice = null;
let last = { sub: "", query: new URLSearchParams() };
export const leave = () => {
  form = null;
  prod = null;
  moData = null;
};
const reload = () => render(last.sub, last.query);

registerLookup("mo-product", {
  search: (q) =>
    searchRead("product.product", [["type", "=", "consu"], ["product_tmpl_id.bom_ids", "!=", false], ...(q ? ["|", ["name", "ilike", q], ["default_code", "ilike", q]] : [])], ["display_name", "uom_id", "product_tmpl_id"], {
      limit: 10, order: "name",
    }),
  sub: (r) => r.uom_id?.[1] ?? "",
  isChosen: (input) => form?.product?.display_name === input.value,
  choose: async (input, item) => {
    form.product = item;
    input.value = item.display_name;
    await loadBoms();
    reload();
  },
});

async function loadBoms() {
  const product = form.product;
  form.boms = await searchRead("mrp.bom", ["|", ["product_id", "=", product.id], "&", ["product_id", "=", false], ["product_tmpl_id", "=", product.product_tmpl_id[0]]], ["display_name", "code", "product_qty", "product_uom_id", "type"], { order: "sequence, id" });
  form.bomId = form.boms[0]?.id ?? null;
  if (form.boms[0]) form.values.qty = form.boms[0].product_qty;
}

export async function render(sub, query) {
  last = { sub, query };
  if (sub === "") return renderList(query);
  return renderForm(sub === "new" ? null : Number(sub), query);
}

const availabilityBadge = (state) => (state ? badge(AVAILABILITY, state) : "");

async function renderList(query) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const filter = query.get("state") ?? "";
  const text = query.get("q") ?? "";
  const ids = (query.get("ids") ?? "").split(",").map(Number).filter(Boolean);
  const domain = [];
  if (filter) domain.push(["state", "=", filter]);
  if (ids.length) domain.push(["id", "in", ids]);
  if (query.get("bom")) domain.push(["bom_id", "=", Number(query.get("bom"))]);
  if (query.get("group")) domain.push(["production_group_id", "=", Number(query.get("group"))]);
  if (query.get("product")) domain.push(["product_id", "=", Number(query.get("product"))]);
  if (text) domain.push("|", ["name", "ilike", text], ["product_id.name", "ilike", text]);
  const rows = await searchRead("mrp.production", domain, ["name", "product_id", "product_qty", "product_uom_id", "date_start", "user_id", "state", "components_availability_state"], {
    order: "id desc", limit: 100,
  });
  const options = [["", "Semua status"], ...Object.entries(STATES).map(([k, v]) => [k, v[0]])];
  const body = rows
    .map((r) =>
      rowLink(`#/mo/${r.id}`, [
        cell(r.name, { strong: true }),
        cell(r.product_id[1]),
        cell(`${nf.format(r.product_qty)} ${r.product_uom_id?.[1] ?? ""}`, { right: true }),
        cell(dateTimeText(r.date_start)),
        cell(r.user_id?.[1] ?? ""),
        cell(["draft", "confirmed", "progress"].includes(r.state) ? availabilityBadge(r.components_availability_state) : "", { raw: true }),
        cell(badge(STATES, r.state), { raw: true }),
      ]),
    )
    .join("");
  app.innerHTML =
    pageHeader(
      "Manufacturing Order",
      `${searchBox(text, "Cari nomor atau produk")}${filterSelect(options, filter)}
       <button data-action="refresh" class="px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50" aria-label="Muat ulang"><i class="fas fa-rotate"></i></button>
       <a href="#/mo/new" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"><i class="fas fa-plus mr-2"></i>MO Baru</a>`,
    ) +
    table(
      [{ label: "Referensi" }, { label: "Produk" }, { label: "Jumlah", right: true }, { label: "Mulai" }, { label: "Penanggung Jawab" }, { label: "Komponen" }, { label: "Status" }],
      body,
      "Belum ada Manufacturing Order. Buat dengan tombol MO Baru.",
    );
}

/* ---------- MO baru ---------- */

async function renderNew(query) {
  if (!form || form.id !== null) {
    form = { id: null, product: null, bomId: null, boms: [], values: { qty: 1, start: "", deadline: "", user: ctx.user?.id ?? null, origin: "", picking_type_id: null }, prefilled: false };
  }
  const bomParam = Number(query?.get("bom")) || null;
  if (bomParam && !form.prefilled) {
    form.prefilled = true;
    const [bom] = await searchRead("mrp.bom", [["id", "=", bomParam]], ["product_tmpl_id", "product_id"]);
    if (bom) {
      const [product] = await searchRead("product.product", bom.product_id ? [["id", "=", bom.product_id[0]]] : [["product_tmpl_id", "=", bom.product_tmpl_id[0]]], ["display_name", "uom_id", "product_tmpl_id"], { limit: 1 });
      if (product) {
        form.product = product;
        await loadBoms();
        if (form.boms.some((b) => b.id === bomParam)) {
          form.bomId = bomParam;
          form.values.qty = form.boms.find((b) => b.id === bomParam).product_qty;
        }
      }
    }
  }
  const [users, warehouses] = await Promise.all([referenceUsers(), referenceWarehouses()]);
  const v = form.values;
  const bom = form.boms.find((b) => b.id === form.bomId);
  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/mo" class="hover:text-indigo-600">Manufacturing Order</a> / Baru</div>
    <h1 class="text-2xl font-bold text-gray-900 mb-3">MO Baru</h1>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-2 gap-x-8 gap-y-4">
      ${fieldBlock("Produk", `<input data-lookup="mo-product" autocomplete="off" role="combobox" aria-autocomplete="list" value="${esc(form.product?.display_name ?? "")}" placeholder="Cari produk yang punya BoM..." class="${INPUT}">`)}
      ${fieldBlock("Bill of Material", form.product
        ? form.boms.length
          ? `<select data-mo="bomId" data-kind="id" class="${INPUT}">${form.boms.map((b) => `<option value="${b.id}" ${b.id === form.bomId ? "selected" : ""}>${esc(b.display_name)}${b.code ? "" : ""}</option>`).join("")}</select>`
          : readonlyValue("Produk ini belum punya BoM")
        : readonlyValue("Pilih produk lebih dulu"))}
      ${fieldBlock(`Jumlah${bom ? ` (${bom.product_uom_id[1]})` : ""}`, `<input type="number" min="0" step="any" data-mo="qty" value="${esc(v.qty)}" class="${INPUT} text-right">`)}
      ${fieldBlock("Penanggung Jawab", `<select data-mo="user" data-kind="id" class="${INPUT}">${selectOptions(users, v.user, "-")}</select>`)}
      ${fieldBlock("Mulai", `<input type="datetime-local" data-mo="start" value="${esc(v.start)}" class="${INPUT}">`)}
      ${fieldBlock("Batas Waktu", `<input type="datetime-local" data-mo="deadline" value="${esc(v.deadline)}" class="${INPUT}">`)}
      ${fieldBlock("Dokumen Sumber", `<input data-mo="origin" value="${esc(v.origin)}" class="${INPUT}">`)}
      ${warehouses.length > 1 ? fieldBlock("Gudang Produksi", `<select data-mo="picking_type_id" data-kind="id" class="${INPUT}">${selectOptions(warehouses.filter((w) => w.manu_type_id).map((w) => ({ id: w.manu_type_id[0], display_name: w.display_name })), v.picking_type_id, "Otomatis (gudang utama)")}</select>`) : ""}
    </section>
    <p class="text-xs text-gray-500 mt-3">Komponen dan produk sampingan mengikuti BoM; komponen diambil dari lokasi gudang yang dipilih. Kosongkan Mulai untuk memakai waktu sekarang.</p>
    <div class="flex flex-wrap gap-2 mt-4">
      <button data-action="save-new" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Simpan sebagai Draft</button>
      <button data-action="save-confirm" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Simpan dan Konfirmasi</button>
      <a href="#/mo" data-action="discard" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Buang</a>
    </div>`;
}

async function createMo() {
  if (!form.product) throw new Error("Pilih produk dari kotak saran.");
  if (!form.bomId) throw new Error("Produk ini belum punya BoM. Buat BoM lebih dulu.");
  const v = form.values;
  const qty = Number(v.qty);
  if (!(qty > 0)) throw new Error("Jumlah harus lebih dari 0.");
  const vals = { product_id: form.product.id, bom_id: form.bomId, product_qty: qty };
  if (v.user) vals.user_id = v.user;
  if (v.start) vals.date_start = fromInputDateTime(v.start);
  if (v.deadline) vals.date_deadline = fromInputDateTime(v.deadline);
  if (v.origin.trim()) vals.origin = v.origin.trim();
  if (v.picking_type_id) vals.picking_type_id = v.picking_type_id;
  const [id] = await call("mrp.production", "create", { vals_list: [vals] });
  return id;
}

/* ---------- MO yang ada ---------- */

const MO_FIELDS = [
  "name", "state", "reservation_state", "product_id", "product_qty", "qty_produced", "qty_producing", "product_uom_id", "bom_id", "picking_type_id", "location_src_id",
  "location_dest_id", "date_start", "date_finished", "date_deadline", "user_id", "origin", "move_raw_ids", "move_finished_ids", "workorder_ids", "components_availability",
  "components_availability_state", "reserve_visible", "unreserve_visible", "product_tracking", "lot_producing_ids", "scrap_count", "unbuild_count", "mrp_production_backorder_count",
  "production_group_id", "duration_expected", "duration",
];

const BUTTONS = [
  { action: "confirm", label: "Konfirmasi", method: "action_confirm", kind: "primary", show: (m) => m.state === "draft" },
  { action: "assign", label: "Cek Ketersediaan", method: "action_assign", show: (m) => OPEN.includes(m.state) && m.reserve_visible },
  { action: "unreserve", label: "Batalkan Reservasi", method: "do_unreserve", show: (m) => OPEN.includes(m.state) && m.unreserve_visible },
  { action: "scrap", label: "Scrap", method: null, show: (m) => OPEN.includes(m.state) },
  { action: "unbuild", label: "Unbuild", method: null, show: (m) => m.state === "done" },
  { action: "cancel", label: "Batalkan", method: "action_cancel", kind: "danger", show: (m) => ["draft", ...OPEN].includes(m.state) },
  { action: "delete", label: "Hapus", method: "unlink", kind: "danger", show: (m) => ["draft", "cancel"].includes(m.state) },
];
const DONE_MESSAGE = { confirm: "MO dikonfirmasi.", assign: "Ketersediaan diperiksa.", unreserve: "Reservasi dibatalkan.", cancel: "MO dibatalkan.", delete: "MO dihapus." };

async function renderForm(id, query) {
  closeLookup();
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  if (!id) return renderNew(query);
  const mo = await readOne("mrp.production", id, MO_FIELDS);
  if (!mo) {
    app.innerHTML = '<p class="text-sm text-rose-600">Manufacturing Order tidak ditemukan.</p>';
    return;
  }
  moData = mo;
  const [raw, finished, orders, users, moWarehouses] = await Promise.all([
    mo.move_raw_ids.length
      ? searchRead("stock.move", [["id", "in", mo.move_raw_ids]], ["product_id", "product_uom_qty", "quantity", "product_uom", "state", "value", "has_tracking"], { order: "id" })
      : [],
    mo.move_finished_ids.length
      ? searchRead("stock.move", [["id", "in", mo.move_finished_ids]], ["product_id", "product_uom_qty", "quantity", "product_uom", "state", "value", "cost_share", "byproduct_id"], { order: "id" })
      : [],
    mo.workorder_ids.length
      ? searchRead("mrp.workorder", [["id", "in", mo.workorder_ids]], ["name", "workcenter_id", "state", "duration_expected", "duration", "is_user_working"], { order: "sequence, id" })
      : [],
    referenceUsers(),
    referenceWarehouses(),
  ]);
  const trackedMoves = raw.filter((m) => m.has_tracking && m.has_tracking !== "none").map((m) => m.id);
  const lotLines = trackedMoves.length ? await searchRead("stock.move.line", [["move_id", "in", trackedMoves]], ["move_id", "lot_id", "quantity"], { order: "id" }) : [];

  if (!form || form.id !== mo.id) {
    const values = { start: toInputDateTime(mo.date_start), deadline: mo.date_deadline ? toInputDateTime(mo.date_deadline) : "", user: mo.user_id?.[0] ?? null, origin: mo.origin || "", qty: mo.product_qty };
    form = { id: mo.id, values, initial: { ...values } };
  }
  const open = OPEN.includes(mo.state);
  if (!prod || prod.id !== mo.id) {
    const qty = mo.qty_producing > 0 ? mo.qty_producing : mo.product_qty;
    prod = { id: mo.id, qty: String(qty), consume: new Map(), touched: new Set(), lot: "", serials: "" };
  }
  prod.plan = new Map(raw.map((m) => [m.id, m.product_uom_qty]));
  const plan = (m) => round((m.product_uom_qty * (Number(prod.qty) || 0)) / (mo.product_qty || 1));
  for (const m of raw) if (!prod.touched.has(m.id)) prod.consume.set(m.id, String(plan(m)));

  const editableHeader = !["done", "cancel"].includes(mo.state);
  const v = form.values;
  const headerFields = editableHeader
    ? `${fieldBlock("Jumlah Rencana", mo.state === "draft" ? `<input type="number" min="0" step="any" data-mo="qty" value="${esc(v.qty)}" class="${INPUT} text-right">` : readonlyValue(`${nf.format(mo.product_qty)} ${mo.product_uom_id[1]}`))}
       ${fieldBlock("Penanggung Jawab", `<select data-mo="user" data-kind="id" class="${INPUT}">${selectOptions(users, v.user, "-")}</select>`)}
       ${fieldBlock("Mulai", `<input type="datetime-local" data-mo="start" value="${esc(v.start)}" class="${INPUT}">`)}
       ${fieldBlock("Batas Waktu", `<input type="datetime-local" data-mo="deadline" value="${esc(v.deadline)}" class="${INPUT}">`)}
       ${fieldBlock("Dokumen Sumber", `<input data-mo="origin" value="${esc(v.origin)}" class="${INPUT}">`)}`
    : `${fieldBlock("Jumlah", readonlyValue(`${nf.format(mo.product_qty)} ${mo.product_uom_id[1]}`))}
       ${fieldBlock("Penanggung Jawab", readonlyValue(mo.user_id?.[1]))}
       ${fieldBlock("Mulai", readonlyValue(dateTimeText(mo.date_start)))}
       ${fieldBlock(mo.state === "done" ? "Selesai" : "Batas Waktu", readonlyValue(mo.state === "done" ? dateTimeText(mo.date_finished) : mo.date_deadline ? dateTimeText(mo.date_deadline) : ""))}
       ${fieldBlock("Dokumen Sumber", readonlyValue(mo.origin))}`;

  const lotsOf = (m) => lotLines.filter((l) => l.move_id[0] === m.id);
  const rawRows = raw
    .map((m) => {
      const tracked = trackedMoves.includes(m.id);
      const lots = lotsOf(m);
      const consumeCell = open
        ? tracked
          ? `<span class="text-xs text-gray-500">sesuai cadangan lot${lots.length ? `: ${esc(lots.map((l) => `${l.lot_id?.[1] ?? "-"} (${nf.format(l.quantity)})`).join(", "))}` : ""}</span>`
          : `<input type="number" min="0" step="any" data-consume="${m.id}" value="${esc(prod.consume.get(m.id))}" class="${INPUT} text-right" aria-label="Dikonsumsi ${esc(m.product_id[1])}">`
        : mo.state !== "done"
          ? ""
          : `${esc(nf.format(m.quantity))}${tracked && lots.length ? `<div class="text-xs text-gray-500">${esc(lots.map((l) => l.lot_id?.[1] ?? "-").join(", "))}</div>` : ""}`;
      return `<tr class="align-top"><td class="py-2 px-4 text-sm">${esc(m.product_id[1])}${tracked ? ' <span class="ml-1 px-2 py-0.5 rounded-full text-xs bg-indigo-50 text-indigo-700">Lot</span>' : ""}</td>
        <td class="py-2 px-4 text-sm text-right tabular-nums">${esc(nf.format(m.product_uom_qty))}</td>
        <td class="py-2 px-4 text-sm text-right tabular-nums">${open ? esc(nf.format(m.quantity)) : ""}</td>
        <td class="py-2 px-4 text-sm text-right ${open && !tracked ? "w-36" : ""}">${consumeCell}</td>
        <td class="py-2 px-4 text-sm">${esc(m.product_uom[1])}</td>
        ${mo.state === "done" ? `<td class="py-2 px-4 text-sm text-right tabular-nums">${money(Math.abs(m.value))}</td>` : ""}</tr>`;
    })
    .join("");
  const finishedRows = finished
    .map((m) => `<tr><td class="py-2 px-4 text-sm">${esc(m.product_id[1])}${m.byproduct_id ? ` <span class="ml-1 px-2 py-0.5 rounded-full text-xs bg-amber-50 text-amber-700">Sampingan ${esc(nf.format(m.cost_share))}%</span>` : ""}</td>
      <td class="py-2 px-4 text-sm text-right tabular-nums">${esc(nf.format(m.product_uom_qty))}</td>
      <td class="py-2 px-4 text-sm text-right tabular-nums">${mo.state === "done" ? esc(nf.format(m.quantity)) : ""}</td>
      <td class="py-2 px-4 text-sm">${esc(m.product_uom[1])}</td>
      ${mo.state === "done" ? `<td class="py-2 px-4 text-sm text-right tabular-nums">${money(Math.abs(m.value))}</td>` : ""}</tr>`)
    .join("");
  const head = (labels, right = []) => `<thead class="bg-gray-50"><tr>${labels.map((h, i) => `<th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase ${right.includes(i) ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>`;
  const woRows = orders
    .map((w) => {
      const buttons = [];
      if (w.state === "ready") buttons.push(["wo-start", "Mulai", "primary"]);
      if (w.state === "progress") {
        buttons.push(w.is_user_working ? ["wo-pause", "Jeda", "plain"] : ["wo-start", "Lanjut", "primary"]);
        buttons.push(["wo-finish", "Selesai", "primary"]);
      }
      return `<tr><td class="py-2 px-4 text-sm">${esc(w.name)}</td><td class="py-2 px-4 text-sm">${esc(w.workcenter_id[1])}</td>
        <td class="py-2 px-4 text-sm text-right tabular-nums">${esc(nf.format(w.duration_expected))}</td><td class="py-2 px-4 text-sm text-right tabular-nums">${esc(nf.format(w.duration))}</td>
        <td class="py-2 px-4">${badge(WO_STATES, w.state)}</td>
        <td class="py-2 px-4 text-right whitespace-nowrap">${buttons.map(([a, l, k]) => `<button type="button" data-action="${a}" data-id="${w.id}" class="px-3 py-1 rounded-lg text-sm ${k === "primary" ? "bg-indigo-600 text-white hover:bg-indigo-700" : "bg-white border border-gray-300 hover:bg-gray-50"} ml-1">${l}</button>`).join("")}</td></tr>`;
    })
    .join("");

  const componentsLeft = open && mo.reservation_state !== "assigned";
  const valuation = productionJournals(mo, raw, finished);
  const tracking = open && mo.product_tracking !== "none"
    ? `<div class="mt-4 pt-4 border-t border-gray-100">${mo.product_tracking === "serial"
        ? fieldBlock("Nomor Seri Barang Jadi (satu per baris, sebanyak jumlah diproduksi)", `<textarea data-prod="serials" rows="4" class="${INPUT} font-mono">${esc(prod.serials)}</textarea>`)
        : fieldBlock("Nomor Lot Barang Jadi", `<input data-prod="lot" value="${esc(prod.lot)}" placeholder="Kosongkan agar Odoo membuat nomor otomatis" class="${INPUT}">`)}</div>`
    : mo.lot_producing_ids.length && mo.state === "done"
      ? `<p class="mt-3 text-sm text-gray-600">Lot barang jadi: ${mo.lot_producing_ids.length} lot tercatat pada <a href="#/lot" class="text-indigo-700 hover:underline">Lot &amp; Serial Number Master</a>.</p>`
      : "";

  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/mo" class="hover:text-indigo-600">Manufacturing Order</a> / ${esc(mo.name)}</div>
    <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-3 mb-3">
      <div class="flex flex-wrap gap-2">${actionBar(BUTTONS, mo)}${printButton("mrp.production", mo.id)}</div>
      ${statusbar(FLOW, STATES, mo.state)}
    </div>
    <div class="flex flex-wrap gap-2 mb-4">${statTiles([
      { count: orders.length, label: "Work Order", icon: "fa-gears", target: "section-wo" },
      { count: mo.scrap_count, label: "Scrap", icon: "fa-trash-can", href: "#/scrap" },
      { count: mo.unbuild_count, label: "Unbuild", icon: "fa-rotate-left" },
      { count: mo.mrp_production_backorder_count > 1 ? mo.mrp_production_backorder_count : 0, label: "Backorder", icon: "fa-clone", href: `#/mo?group=${mo.production_group_id?.[0]}` },
    ])}</div>
    <div class="mb-3 flex flex-wrap items-center gap-3"><h1 class="text-2xl font-bold text-gray-900">${esc(mo.name)}</h1>${open ? availabilityBadge(mo.components_availability_state) : ""}</div>
    ${componentsLeft ? `<p class="mb-3 text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">Komponen belum lengkap${mo.components_availability ? ` (${esc(AVAILABILITY[mo.components_availability_state]?.[0] ?? mo.components_availability)})` : ""}. Terima atau beli komponen, lalu pilih Cek Ketersediaan. Produksi tetap bisa dicatat dengan jumlah yang tersedia.</p>` : ""}
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-2 gap-x-8 gap-y-4">
      ${fieldBlock("Produk", readonlyValue(mo.product_id[1]))}
      ${fieldBlock("Bill of Material", mo.bom_id ? `<div class="mt-1 py-2 text-sm"><a href="#/bom/${mo.bom_id[0]}" class="text-indigo-700 hover:underline">${esc(mo.bom_id[1])}</a></div>` : readonlyValue("-"))}
      ${headerFields}
      ${moWarehouses.length > 1 ? fieldBlock("Gudang Produksi", readonlyValue(mo.picking_type_id?.[1])) : ""}
      ${fieldBlock("Lokasi Komponen", readonlyValue(mo.location_src_id[1]))}
      ${fieldBlock("Lokasi Barang Jadi", readonlyValue(mo.location_dest_id[1]))}
    </section>
    ${editableHeader ? `<div class="mt-3"><button data-action="save-header" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Simpan Perubahan</button></div>` : ""}
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 overflow-x-auto">
      <div class="px-4 py-3 border-b border-gray-200 text-sm font-semibold">Komponen</div>
      <table class="w-full text-left">${head(["Komponen", "Rencana", open ? "Dicadangkan" : "", open ? "Dikonsumsi" : mo.state === "done" ? "Terpakai" : "", "Satuan", ...(mo.state === "done" ? ["Nilai"] : [])], [1, 2, 3, ...(mo.state === "done" ? [5] : [])])}<tbody class="divide-y divide-gray-100">${rawRows || '<tr><td colspan="5" class="py-6 text-center text-sm text-gray-500">Tidak ada komponen.</td></tr>'}</tbody></table>
    </section>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 overflow-x-auto">
      <div class="px-4 py-3 border-b border-gray-200 text-sm font-semibold">Barang Jadi</div>
      <table class="w-full text-left">${head(["Produk", "Rencana", mo.state === "done" ? "Dihasilkan" : "", "Satuan", ...(mo.state === "done" ? ["Nilai"] : [])], [1, 2, ...(mo.state === "done" ? [4] : [])])}<tbody class="divide-y divide-gray-100">${finishedRows}</tbody></table>
    </section>
    ${orders.length
      ? `<section id="section-wo" class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 overflow-x-auto"><div class="px-4 py-3 border-b border-gray-200 text-sm font-semibold">Work Order</div>
         <table class="w-full text-left">${head(["Operasi", "Work Center", "Rencana (menit)", "Aktual (menit)", "Status", ""], [2, 3])}<tbody class="divide-y divide-gray-100">${woRows}</tbody></table></section>`
      : ""}
    ${open
      ? `<section class="bg-white rounded-xl shadow-sm border border-indigo-200 mt-4 p-6">
          <div class="text-sm font-semibold mb-3">Produksi</div>
          <div class="flex flex-wrap items-end gap-4">
            ${fieldBlock(`Jumlah Diproduksi (${mo.product_uom_id[1]})`, `<input type="number" min="0" step="any" data-prod="qty" value="${esc(prod.qty)}" class="${INPUT} text-right w-40">`)}
            <button data-action="finish" data-id="${mo.id}" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Tandai Selesai</button>
          </div>
          <p class="mt-3 text-xs text-gray-500">Jumlah komponen yang dikonsumsi terisi sesuai BoM untuk jumlah ini dan bisa diubah. Memproduksi kurang dari rencana menawarkan backorder; konsumsi berlebih meminta konfirmasi.</p>
          ${tracking}</section>`
      : ""}
    ${valuation}
    ${chatterHtml("mrp.production", mo.id)}`;
  loadMessages("mrp.production", mo.id);
}

/* ---------- Tindakan ---------- */

function ask(title, bodyHtml, choices) {
  return new Promise((resolve) => {
    openModal(
      title,
      bodyHtml,
      choices.map(([value, label, kind]) => `<button data-action="choice" data-value="${esc(value)}" class="px-4 py-2 rounded-lg text-sm font-medium ${kind === "primary" ? "bg-indigo-600 text-white hover:bg-indigo-700" : "bg-white text-gray-700 border border-gray-300 hover:bg-gray-50"}">${esc(label)}</button>`).join(""),
      () => resolve(null),
    );
    pendingChoice = (value) => {
      resolve(value);
      closeModal();
    };
  });
}

/** Menentukan nomor lot atau seri barang jadi dan mencatatnya pada MO; tanpa isian, Odoo membuat nomor otomatis. */
async function setFinishedLots(mo) {
  if (mo.product_tracking === "none") return;
  const product = mo.product_id[0];
  let names = [];
  if (mo.product_tracking === "serial") {
    names = prod.serials.split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
    if (names.length) {
      if (new Set(names).size !== names.length) throw new Error("Ada nomor seri yang dobel dalam daftar.");
      if (names.length !== Number(prod.qty)) throw new Error(`Isi ${nf.format(Number(prod.qty))} nomor seri (satu per baris) atau kosongkan agar Odoo membuatnya otomatis.`);
    }
  } else if (prod.lot.trim()) names = [prod.lot.trim()];
  if (!names.length) return;
  const ids = [];
  for (const name of names) {
    const [found] = await searchRead("stock.lot", [["product_id", "=", product], ["name", "=", name]], ["id"], { limit: 1 });
    ids.push(found ? found.id : (await call("stock.lot", "create", { vals_list: [{ name, product_id: product }] }))[0]);
  }
  await call("mrp.production", "write", { ids: [mo.id], vals: { lot_producing_ids: [[6, 0, ids]] } });
}

async function finish(button) {
  const mo = moData;
  const result = await guarded(button, async () => {
    const qty = Number(prod.qty);
    if (!(qty > 0)) throw new Error("Isi jumlah yang diproduksi, lebih dari 0.");
    const raw = await searchRead("stock.move", [["id", "in", mo.move_raw_ids]], ["id", "product_id", "has_tracking"]);
    for (const m of raw) {
      if (m.has_tracking && m.has_tracking !== "none") continue;
      const used = Number(prod.consume.get(m.id));
      if (!(used >= 0)) throw new Error(`Jumlah konsumsi ${m.product_id[1]} tidak boleh negatif.`);
    }
    await setFinishedLots(mo);
    await call("mrp.production", "write", { ids: [mo.id], vals: { qty_producing: qty } });
    // Lewat API, perubahan qty_producing tidak mengubah jumlah produk sampingan (onchange hanya jalan di klien web): skalakan sendiri.
    const sideProducts = await searchRead("stock.move", [["id", "in", mo.move_finished_ids], ["byproduct_id", "!=", false]], ["id", "product_uom_qty"]);
    for (const m of sideProducts) await call("stock.move", "write", { ids: [m.id], vals: { quantity: round((m.product_uom_qty * qty) / (mo.product_qty || 1)) } });
    for (const m of raw) {
      if (m.has_tracking && m.has_tracking !== "none") {
        await call("stock.move", "write", { ids: [m.id], vals: { picked: true } });
        continue;
      }
      const used = Number(prod.consume.get(m.id));
      await call("stock.move", "write", { ids: [m.id], vals: { quantity: used, picked: used > 0 } });
    }
    let outcome = await call("mrp.production", "button_mark_done", { ids: [mo.id] });
    // Odoo bisa meminta beberapa langkah berturut-turut (peringatan konsumsi, lalu backorder).
    for (let step = 0; step < 5; step++) {
      if (outcome === true || outcome === false || outcome == null) return { backorder: null };
      const context = outcome.context ?? {};
      if (outcome.res_model === "mrp.production.backorder") {
        const choice = await ask(
          "Buat Backorder?",
          `<p class="text-sm text-gray-700">Jumlah yang diproduksi (${esc(nf.format(qty))}) kurang dari rencana (${esc(nf.format(mo.product_qty))}). Buat backorder untuk sisanya, atau tutup tanpa backorder?</p>`,
          [["cancel", "Batal"], ["none", "Tanpa Backorder"], ["backorder", "Buat Backorder", "primary"]],
        );
        if (!choice || choice === "cancel") return false;
        const [wizard] = await call("mrp.production.backorder", "create", { vals_list: [{}], context });
        outcome = await call("mrp.production.backorder", choice === "backorder" ? "action_backorder" : "action_close_mo", { ids: [wizard], context });
        // Hasilnya tindakan membuka MO (backorder) atau true; produksi sudah tercatat.
        return { backorder: choice === "backorder" ? outcome?.res_id ?? true : null };
      }
      if (outcome.res_model === "mrp.consumption.warning") {
        const [wizard] = await call("mrp.consumption.warning", "create", { vals_list: [{}], context });
        const [info] = await call("mrp.consumption.warning", "read", { ids: [wizard], fields: ["mrp_consumption_warning_line_ids"], context });
        const lines = info.mrp_consumption_warning_line_ids.length
          ? await call("mrp.consumption.warning.line", "read", { ids: info.mrp_consumption_warning_line_ids, fields: ["product_id", "product_consumed_qty_uom", "product_expected_qty_uom", "product_uom_id"], context })
          : [];
        const choice = await ask(
          "Konsumsi Berbeda dari BoM",
          `<p class="text-sm text-gray-700 mb-3">Jumlah komponen yang dikonsumsi berbeda dari yang diharapkan untuk jumlah produksi ini.</p>
           <table class="w-full text-left text-sm"><thead><tr><th class="pb-1 text-xs uppercase text-gray-600">Komponen</th><th class="pb-1 text-xs uppercase text-gray-600 text-right">Diharapkan</th><th class="pb-1 text-xs uppercase text-gray-600 text-right">Dikonsumsi</th></tr></thead><tbody>${lines
             .map((l) => `<tr><td class="py-1">${esc(l.product_id[1])}</td><td class="py-1 text-right tabular-nums">${esc(nf.format(l.product_expected_qty_uom))} ${esc(l.product_uom_id?.[1] ?? "")}</td><td class="py-1 text-right tabular-nums">${esc(nf.format(l.product_consumed_qty_uom))}</td></tr>`)
             .join("")}</tbody></table>`,
          [["cancel", "Batal"], ["reset", "Kembalikan ke Rencana"], ["go", "Lanjutkan", "primary"]],
        );
        if (!choice || choice === "cancel") return false;
        outcome = await call("mrp.consumption.warning", choice === "reset" ? "action_set_qty" : "action_confirm", { ids: [wizard], context });
        continue;
      }
      break;
    }
    throw new Error(`Odoo meminta langkah tambahan ("${outcome.name ?? outcome.res_model}") yang belum didukung UI ini. Selesaikan di Odoo.`);
  });
  if (result) {
    form = null;
    prod = null;
    toast(result.backorder ? "Produksi dicatat, backorder dibuat untuk sisanya." : "Produksi selesai.");
    reload();
  }
}

function scrapDialog() {
  const mo = moData;
  return Promise.all([
    searchRead("stock.move", [["id", "in", mo.move_raw_ids]], ["product_id", "has_tracking", "product_uom"]),
    searchRead("stock.move", [["id", "in", mo.move_finished_ids]], ["product_id", "has_tracking", "product_uom"]),
  ]).then(([raw, finished]) => {
    const options = [
      ...raw.filter((m) => !m.has_tracking || m.has_tracking === "none").map((m) => ({ key: `raw:${m.product_id[0]}`, label: `${m.product_id[1]} (komponen)`, product: m.product_id[0], uom: m.product_uom[0], location: mo.location_src_id[0] })),
      ...finished.filter((m) => !m.has_tracking || m.has_tracking === "none").map((m) => ({ key: `fin:${m.product_id[0]}`, label: `${m.product_id[1]} (barang jadi)`, product: m.product_id[0], uom: m.product_uom[0], location: mo.location_dest_id[0] })),
    ];
    if (!options.length) {
      toast("Produk berlacak lot atau seri di-scrap lewat halaman Scrap.", "error");
      return;
    }
    scrapOptions = options;
    openModal(
      "Scrap dari Manufacturing Order",
      `<form data-form="scrap" class="space-y-3">
         ${fieldBlock("Produk", `<select data-scrap="key" class="${INPUT}">${options.map((o) => `<option value="${esc(o.key)}">${esc(o.label)}</option>`).join("")}</select>`)}
         ${fieldBlock("Jumlah", `<input type="number" min="0" step="any" data-scrap="qty" value="1" class="${INPUT} text-right">`)}
         <p class="text-xs text-gray-500">Scrap memindahkan barang ke lokasi Inventory Loss. Produk berlacak lot atau seri di-scrap lewat halaman Scrap.</p></form>`,
      `<button data-action="modal-close" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Batal</button>
       <button data-action="scrap-confirm" class="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700">Scrap</button>`,
    );
  });
}
let scrapOptions = [];

async function confirmScrap(button) {
  const done = await guarded(button, async () => {
    const choice = scrapOptions.find((o) => o.key === document.querySelector('[data-scrap="key"]').value);
    const qty = Number(document.querySelector('[data-scrap="qty"]').value);
    if (!(qty > 0)) throw new Error("Jumlah scrap harus lebih dari 0.");
    const [scrapId] = await call("stock.scrap", "create", { vals_list: [{ product_id: choice.product, scrap_qty: qty, product_uom_id: choice.uom, production_id: moData.id, location_id: choice.location }] });
    const result = await call("stock.scrap", "action_validate", { ids: [scrapId] });
    if (result && typeof result === "object") throw new Error("Stok tidak cukup untuk di-scrap. Kurangi jumlah atau lakukan penerimaan lebih dulu.");
    return true;
  });
  if (done) {
    closeModal();
    toast("Scrap dicatat.");
    reload();
  }
}

async function unbuildDialog() {
  const mo = moData;
  openModal(
    "Unbuild",
    `<form data-form="unbuild" class="space-y-3">
       ${fieldBlock(`Jumlah yang di-unbuild (${esc(mo.product_uom_id[1])})`, `<input type="number" min="0" step="any" data-unbuild="qty" value="${esc(mo.qty_produced)}" class="${INPUT} text-right">`)}
       <p class="text-xs text-gray-500">Unbuild mengembalikan komponen ke ${esc(mo.location_src_id[1])} dan mengeluarkan barang jadi dari ${esc(mo.location_dest_id[1])}, sesuai konsumsi MO ini.</p></form>`,
    `<button data-action="modal-close" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Batal</button>
     <button data-action="unbuild-confirm" class="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700">Unbuild</button>`,
  );
}

async function confirmUnbuild(button) {
  const mo = moData;
  const done = await guarded(button, async () => {
    const qty = Number(document.querySelector('[data-unbuild="qty"]').value);
    if (!(qty > 0)) throw new Error("Jumlah harus lebih dari 0.");
    if (qty > mo.qty_produced) throw new Error(`Jumlah melebihi yang diproduksi (${nf.format(mo.qty_produced)}).`);
    const vals = { mo_id: mo.id, product_id: mo.product_id[0], product_qty: qty, product_uom_id: mo.product_uom_id[0], location_id: mo.location_dest_id[0], location_dest_id: mo.location_src_id[0] };
    if (mo.product_tracking !== "none") {
      if (mo.lot_producing_ids.length !== 1) throw new Error("Unbuild produk berlacak dengan banyak lot dilakukan di Odoo.");
      vals.lot_id = mo.lot_producing_ids[0];
    }
    const [unbuildId] = await call("mrp.unbuild", "create", { vals_list: [vals] });
    const result = await call("mrp.unbuild", "action_validate", { ids: [unbuildId] });
    if (result && typeof result === "object") throw new Error("Stok barang jadi di gudang tidak cukup untuk di-unbuild.");
    return true;
  });
  if (done) {
    closeModal();
    toast("Unbuild selesai. Komponen kembali ke gudang.");
    reload();
  }
}

async function saveHeader(button) {
  const v = form.values;
  const saved = await guarded(button, async () => {
    const vals = {};
    if (v.qty !== form.initial.qty && moData.state === "draft") {
      if (!(Number(v.qty) > 0)) throw new Error("Jumlah harus lebih dari 0.");
      vals.product_qty = Number(v.qty);
    }
    if (v.user !== form.initial.user) vals.user_id = v.user || false;
    if (v.start !== form.initial.start && v.start) vals.date_start = fromInputDateTime(v.start);
    if (v.deadline !== form.initial.deadline) vals.date_deadline = v.deadline ? fromInputDateTime(v.deadline) : false;
    if (v.origin !== form.initial.origin) vals.origin = v.origin.trim() || false;
    if (Object.keys(vals).length) await call("mrp.production", "write", { ids: [moData.id], vals });
    return true;
  });
  if (saved) {
    form = null;
    prod = null;
    toast("Perubahan disimpan.");
    reload();
  }
}

async function workOrder(button, method, done) {
  const ok = await guarded(button, () => call("mrp.workorder", method, { ids: [Number(button.dataset.id)] }));
  if (ok !== undefined) {
    toast(done);
    form = null;
    prod = null;
    reload();
  }
}

export async function onClick(event, el) {
  const { action } = el.dataset;
  const id = Number(el.dataset.id) || null;
  const def = BUTTONS.find((b) => b.action === action);
  if (action === "refresh") reload();
  else if (action === "discard") form = null;
  else if (action === "choice") pendingChoice?.(el.dataset.value);
  else if (action === "save-new" || action === "save-confirm") {
    const newId = await guarded(el, async () => {
      const created = await createMo();
      if (action === "save-confirm") await call("mrp.production", "action_confirm", { ids: [created] });
      return created;
    });
    if (newId) {
      form = null;
      toast(action === "save-confirm" ? "MO dibuat dan dikonfirmasi." : "MO dibuat (draft).");
      location.hash = `#/mo/${newId}`;
    }
  } else if (action === "save-header") await saveHeader(el);
  else if (action === "finish") await finish(el);
  else if (action === "scrap") await scrapDialog();
  else if (action === "scrap-confirm") await confirmScrap(el);
  else if (action === "unbuild") await unbuildDialog();
  else if (action === "unbuild-confirm") await confirmUnbuild(el);
  else if (action === "wo-start") await workOrder(el, "button_start", "Work order dimulai.");
  else if (action === "wo-pause") await workOrder(el, "button_pending", "Work order dijeda.");
  else if (action === "wo-finish") await workOrder(el, "button_finish", "Work order selesai.");
  else if (action === "cancel" && !window.confirm("Batalkan Manufacturing Order ini?")) {
    /* dibatalkan pengguna */
  } else if (action === "delete" && !window.confirm("Hapus Manufacturing Order ini?")) {
    /* dibatalkan pengguna */
  } else if (def?.method) {
    const ok = await guarded(el, () => call("mrp.production", def.method, { ids: [moData.id] }));
    if (ok !== undefined) {
      form = null;
      prod = null;
      toast(DONE_MESSAGE[action]);
      if (action === "delete") location.hash = "#/mo";
      else reload();
    }
  }
}

export async function onInput(event, el) {
  if (el.dataset.mo && form) {
    const key = el.dataset.mo;
    if (key === "bomId") {
      form.bomId = el.value ? Number(el.value) : null;
      const bom = form.boms.find((b) => b.id === form.bomId);
      if (bom) form.values.qty = bom.product_qty;
      if (form.id === null) reload();
    } else form.values[key] = el.dataset.kind === "id" ? (el.value ? Number(el.value) : null) : el.value;
  } else if (el.dataset.lookup === "mo-product" && form) {
    form.product = null;
    form.boms = [];
    form.bomId = null;
    runLookup(el, 250);
  } else if (el.dataset.prod && prod) {
    prod[el.dataset.prod] = el.value;
    if (el.dataset.prod === "qty") {
      // Jumlah konsumsi mengikuti jumlah produksi untuk baris yang belum diubah pengguna.
      for (const input of document.querySelectorAll("[data-consume]")) {
        const moveId = Number(input.dataset.consume);
        if (prod.touched.has(moveId)) continue;
        const planned = prod.plan.get(moveId);
        if (planned === undefined) continue;
        const value = String(round((planned * (Number(prod.qty) || 0)) / (moData.product_qty || 1)));
        prod.consume.set(moveId, value);
        input.value = value;
      }
    }
  } else if (el.dataset.consume && prod) {
    prod.consume.set(Number(el.dataset.consume), el.value);
    prod.touched.add(Number(el.dataset.consume));
  }
}
