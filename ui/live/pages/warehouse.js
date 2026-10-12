// Warehouse Master (stock.warehouse) dan fitur gudang. Fitur Storage Locations, Multi-Step Routes, dan Lots & Serial
// Numbers diaktifkan lewat pengaturan Odoo (res.config.settings). Gudang kedua dan seterusnya dibuat di sini lengkap
// dengan langkah penerimaan dan pengiriman, serta "disuplai dari" gudang lain (rute suplai lewat lokasi transit, D42).
import {
  INPUT, app, badge, call, cell, ctx, esc, fieldBlock, filterSelect, guarded, pageHeader, readOne, referenceWarehouses, resetReferences, rowLink, searchRead,
  table, toast, button,
} from "../common.js";

const RECEPTION = { one_step: "Terima dan simpan (1 langkah)", two_steps: "Terima lalu simpan (2 langkah)", three_steps: "Terima, kendali mutu, lalu simpan (3 langkah)" };
const DELIVERY = { ship_only: "Kirim (1 langkah)", pick_ship: "Ambil lalu kirim (2 langkah)", pick_pack_ship: "Ambil, kemas, lalu kirim (3 langkah)" };
/** Dokumen yang terbentuk per penerimaan atau pengiriman menurut langkahnya (nama tipe operasi Odoo: asal -> tujuan). */
const RECEPTION_FLOW = {
  one_step: ["Receipts: Pemasok -> Stock"],
  two_steps: ["Receipts: Pemasok -> Input", "Storage: Input -> Stock"],
  three_steps: ["Receipts: Pemasok -> Input", "Quality Control: Input -> Quality Control", "Storage: Quality Control -> Stock"],
};
const DELIVERY_FLOW = {
  ship_only: ["Delivery Orders: Stock -> Pelanggan"],
  pick_ship: ["Pick: Stock -> Output", "Delivery Orders: Output -> Pelanggan"],
  pick_pack_ship: ["Pick: Stock -> Packing Zone", "Pack: Packing Zone -> Output", "Delivery Orders: Output -> Pelanggan"],
};
const FEATURES = [
  { setting: "group_stock_multi_locations", group: "stock.group_stock_multi_locations", label: "Storage Locations", about: "Lokasi di dalam gudang dan transfer internal antar lokasi." },
  { setting: "group_stock_adv_location", group: "stock.group_adv_location", label: "Multi-Step Routes", about: "Penerimaan dan pengiriman lebih dari 1 langkah, serta rute suplai antar gudang." },
  { setting: "group_stock_production_lot", group: "stock.group_production_lot", label: "Lots & Serial Numbers", about: "Melacak lot atau nomor seri produk." },
];
const FILTERS = [["", "Gudang aktif"], ["archived", "Diarsipkan"]];

let form = null; // { id, values, initial }
let features = null; // { setting: boolean }
let last = { sub: "", query: new URLSearchParams() };
export const leave = () => {
  form = null;
  features = null;
};
const reload = () => render(last.sub, last.query);

export async function render(sub, query) {
  last = { sub, query };
  if (sub === "") return renderList(query);
  return renderForm(sub === "new" ? null : Number(sub));
}

async function loadFeatures() {
  const entries = await Promise.all(FEATURES.map(async (f) => [f.setting, Boolean(await call("res.users", "has_group", { ids: [ctx.user.id], group_ext_id: f.group }))]));
  features = Object.fromEntries(entries);
}

async function renderList(query) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const archived = query.get("state") === "archived";
  const [rows, all] = await Promise.all([
    searchRead("stock.warehouse", [["active", "=", !archived]], ["name", "code", "reception_steps", "delivery_steps", "lot_stock_id", "resupply_wh_ids"], { order: "name", context: { active_test: false } }),
    searchRead("stock.warehouse", [], ["display_name"], { context: { active_test: false } }),
    features ? null : loadFeatures(),
  ]);
  const names = new Map(all.map((w) => [w.id, w.display_name]));
  const body = rows
    .map((r) =>
      rowLink(`#/warehouse/${r.id}`, [
        cell(r.name, { strong: true }), cell(r.code), cell(r.lot_stock_id?.[1] ?? "-"), cell(RECEPTION[r.reception_steps] ?? r.reception_steps), cell(DELIVERY[r.delivery_steps] ?? r.delivery_steps),
        cell(r.resupply_wh_ids.map((id) => names.get(id) ?? id).join(", ") || "-"),
      ]),
    )
    .join("");
  const toggles = FEATURES.map(
    (f) => `<label class="flex items-start gap-3 text-sm"><input type="checkbox" data-feature="${f.setting}" ${features[f.setting] ? "checked" : ""} class="mt-1 rounded border-gray-300 text-indigo-600">
      <span><span class="font-medium text-gray-900">${esc(f.label)}</span><span class="block text-gray-500">${esc(f.about)}</span></span></label>`,
  ).join("");
  app.innerHTML =
    pageHeader(
      "Warehouse & Location Master",
      `${filterSelect(FILTERS, archived ? "archived" : "")}
       <a href="#/location" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50"><i class="fas fa-location-dot mr-2"></i>Lokasi</a>
       <a href="#/warehouse/new" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"><i class="fas fa-plus mr-2"></i>Gudang Baru</a>`,
    ) +
    `<section class="bg-white rounded-xl shadow-sm border border-gray-200 p-5 mb-4"><div class="text-sm font-semibold mb-3">Fitur gudang</div>
       <div class="grid md:grid-cols-3 gap-4">${toggles}</div>
       <div class="mt-4"><button data-action="apply-features" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Terapkan Fitur</button></div>
       <p class="text-xs text-gray-500 mt-3">Mode multi-gudang (pemilih gudang di PO, Sales Order, dan MO serta laporan Stok per Gudang) aktif otomatis begitu ada lebih dari satu gudang aktif.</p></section>` +
    table([{ label: "Gudang" }, { label: "Kode" }, { label: "Lokasi Stok" }, { label: "Penerimaan" }, { label: "Pengiriman" }, { label: "Disuplai dari" }], body, archived ? "Tidak ada gudang yang diarsipkan." : "Belum ada gudang.");
}

const WH_FIELDS = ["name", "code", "reception_steps", "delivery_steps", "lot_stock_id", "view_location_id", "active", "resupply_wh_ids", "resupply_route_ids", "route_ids"];

async function renderForm(id) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  let wh = null;
  const [others] = await Promise.all([referenceWarehouses(), features ? null : loadFeatures()]);
  if (id) {
    wh = await readOne("stock.warehouse", id, WH_FIELDS);
    if (!wh) {
      app.innerHTML = '<p class="text-sm text-rose-600">Gudang tidak ditemukan.</p>';
      return;
    }
  }
  if (!form || form.id !== (wh?.id ?? null)) {
    const values = wh
      ? { name: wh.name, code: wh.code, reception_steps: wh.reception_steps, delivery_steps: wh.delivery_steps, resupply: [...wh.resupply_wh_ids] }
      : { name: "", code: "", reception_steps: "one_step", delivery_steps: "ship_only", resupply: [] };
    form = { id: wh?.id ?? null, values, initial: wh ? { ...values, resupply: [...values.resupply] } : null };
  }
  const v = form.values;
  const archived = wh && !wh.active;
  const select = (key, options) => `<select data-wh="${key}" class="${INPUT}" ${archived ? "disabled" : ""}>${Object.entries(options).map(([k, label]) => `<option value="${k}" ${k === v[key] ? "selected" : ""}>${esc(label)}</option>`).join("")}</select>`;
  const suppliers = others.filter((w) => w.id !== form.id);
  const supplyBox = suppliers.length
    ? suppliers.map((w) => `<label class="flex items-center gap-2 text-sm"><input type="checkbox" data-supplier="${w.id}" ${v.resupply.includes(w.id) ? "checked" : ""} ${archived ? "disabled" : ""} class="rounded border-gray-300 text-indigo-600"><span>${esc(w.display_name)} <span class="text-gray-500">(${esc(w.code)})</span></span></label>`).join("")
    : '<p class="text-sm text-gray-500">Belum ada gudang lain. Buat gudang kedua lebih dulu agar bisa saling menyuplai.</p>';
  const needAdv = (v.reception_steps !== "one_step" || v.delivery_steps !== "ship_only") && !features.group_stock_adv_location;
  const detail = wh ? await warehouseDetail(wh) : "";
  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/warehouse" class="hover:text-indigo-600">Warehouse & Location Master</a> / ${esc(wh?.name ?? "Baru")}</div>
    <div class="flex flex-wrap items-center gap-3 mb-3"><h1 class="text-2xl font-bold text-gray-900">${esc(wh?.name ?? "Gudang Baru")}</h1>${archived ? badge({ x: ["Diarsipkan", "muted"] }, "x") : ""}</div>
    ${wh ? `<p class="text-sm text-gray-600 mb-3">Lokasi stok: <b>${esc(wh.lot_stock_id[1])}</b> · <a href="#/location?warehouse=${wh.id}" class="text-indigo-700 hover:underline">lihat lokasi gudang ini</a> · <a href="#/stock/warehouse" class="text-indigo-700 hover:underline">stok per gudang</a></p>` : ""}
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-2 gap-x-8 gap-y-4">
      ${fieldBlock("Nama Gudang", `<input data-wh="name" value="${esc(v.name)}" ${archived ? "disabled" : ""} class="${INPUT}">`)}
      ${fieldBlock("Kode Singkat (unik, maks 5 huruf)", `<input data-wh="code" maxlength="5" value="${esc(v.code)}" ${archived ? "disabled" : ""} class="${INPUT}">`)}
      ${fieldBlock("Penerimaan Barang", select("reception_steps", RECEPTION))}
      ${fieldBlock("Pengiriman Barang", select("delivery_steps", DELIVERY))}
      <div class="md:col-span-2" id="wh-flow">${whFlow()}</div>
      <div class="md:col-span-2">${fieldBlock("Disuplai dari (gudang yang mengirim stok ke gudang ini lewat lokasi transit)", `<div class="mt-1 grid sm:grid-cols-2 gap-2">${supplyBox}</div>`)}
        <p class="text-xs text-gray-500 mt-2">Menyimpan pilihan ini membuat rute suplai di Odoo. Pakai rute itu di Reorder Level agar kekurangan stok gudang ini diisi lewat transfer antar gudang (keluar dari gudang pemasok, lalu diterima di sini).</p></div>
    </section>
    ${needAdv ? '<p class="mt-3 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">Penerimaan atau pengiriman lebih dari 1 langkah membutuhkan <b>Multi-Step Routes</b>. Aktifkan di Fitur gudang pada daftar gudang, lalu kembali ke sini.</p>' : ""}
    ${archived ? "" : `<div class="flex flex-wrap gap-2 mt-4"><button data-action="save" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Simpan</button>
      <a href="#/warehouse" data-action="discard" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Buang</a>
      ${wh ? button("archive", "Arsipkan", "danger", { id: wh.id }) : ""}</div>`}
    ${archived ? `<div class="mt-4">${button("unarchive", "Aktifkan Kembali", "primary", { id: wh.id })}</div>` : ""}
    ${detail}`;
}

/** Ringkasan dokumen per langkah menurut pilihan di formulir (diperbarui saat langkah diganti). */
function whFlow() {
  const v = form.values;
  const flow = (title, list) => `<div><div class="text-xs font-semibold text-gray-600 uppercase mb-1">${esc(title)}: ${list.length} dokumen per transaksi</div><ol class="list-decimal list-inside text-sm text-gray-700 space-y-0.5">${list.map((x) => `<li>${esc(x)}</li>`).join("")}</ol></div>`;
  return `<div class="grid md:grid-cols-2 gap-4 bg-gray-50 border border-gray-200 rounded-lg px-4 py-3">${flow("Penerimaan", RECEPTION_FLOW[v.reception_steps] ?? [])}${flow("Pengiriman", DELIVERY_FLOW[v.delivery_steps] ?? [])}</div>`;
}

/** Operasi dan rute yang benar-benar terbentuk di Odoo untuk gudang yang sudah tersimpan. */
async function warehouseDetail(wh) {
  const routeIds = [...new Set([...wh.route_ids, ...wh.resupply_route_ids])];
  const [types, routes] = await Promise.all([
    searchRead("stock.picking.type", [["warehouse_id", "=", wh.id]], ["display_name", "code", "default_location_src_id", "default_location_dest_id"], { order: "sequence, id" }),
    routeIds.length ? searchRead("stock.route", [["id", "in", routeIds]], ["display_name", "supplier_wh_id"], { order: "sequence, id" }) : [],
  ]);
  const CODE = { incoming: "Penerimaan", outgoing: "Pengiriman", internal: "Transfer internal", mrp_operation: "Produksi" };
  const typeRows = types
    .map((t) => `<tr><td class="py-2 px-4 text-sm">${esc(t.display_name)}</td><td class="py-2 px-4 text-sm">${esc(CODE[t.code] ?? t.code)}</td><td class="py-2 px-4 text-sm">${esc(t.default_location_src_id?.[1] ?? "-")} -> ${esc(t.default_location_dest_id?.[1] ?? "-")}</td></tr>`)
    .join("");
  const routeItems = routes
    .map((r) => `<li>${esc(r.display_name)}${r.supplier_wh_id ? ` <span class="text-xs px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700">suplai dari ${esc(r.supplier_wh_id[1])}</span>` : ""}</li>`)
    .join("");
  return `<section class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 overflow-x-auto">
      <div class="px-4 py-3 border-b border-gray-200 text-sm font-semibold">Operasi yang terbentuk</div>
      <table class="w-full text-left"><thead class="bg-gray-50"><tr>${["Tipe Operasi", "Jenis", "Dari -> Ke"].map((h) => `<th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase">${h}</th>`).join("")}</tr></thead><tbody class="divide-y divide-gray-100">${typeRows}</tbody></table></section>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 p-4"><div class="text-sm font-semibold mb-2">Rute</div>
      ${routeItems ? `<ul class="list-disc list-inside text-sm text-gray-700 space-y-0.5">${routeItems}</ul>` : '<p class="text-sm text-gray-500">Belum ada rute khusus.</p>'}
      <p class="text-xs text-gray-500 mt-2">Rute "Supply Product from ..." dipilih pada Reorder Level; Odoo membuat transfer keluar dari gudang pemasok ke lokasi transit, lalu penerimaan di gudang ini.</p></section>`;
}

async function codeTaken(code, exceptId) {
  const rows = await searchRead("stock.warehouse", [["code", "=ilike", code]], ["display_name"], { context: { active_test: false } });
  return rows.find((r) => r.id !== exceptId) ?? null;
}

async function persist() {
  const v = form.values;
  if (!v.name.trim()) throw new Error("Nama gudang wajib diisi.");
  if (!v.code.trim()) throw new Error("Kode singkat wajib diisi.");
  if ((v.reception_steps !== "one_step" || v.delivery_steps !== "ship_only") && !features.group_stock_adv_location) {
    throw new Error("Penerimaan atau pengiriman lebih dari 1 langkah membutuhkan Multi-Step Routes. Aktifkan dulu di Fitur gudang.");
  }
  if (!form.id || v.code.trim().toLowerCase() !== form.initial.code.toLowerCase()) {
    const clash = await codeTaken(v.code.trim(), form.id);
    if (clash) throw new Error(`Kode "${v.code.trim()}" sudah dipakai gudang ${clash.display_name}. Pilih kode lain.`);
  }
  const supplyCommand = [[6, 0, v.resupply]];
  if (!form.id) {
    const [id] = await call("stock.warehouse", "create", {
      vals_list: [{ name: v.name.trim(), code: v.code.trim(), reception_steps: v.reception_steps, delivery_steps: v.delivery_steps, ...(v.resupply.length ? { resupply_wh_ids: supplyCommand } : {}) }],
    });
    return id;
  }
  const vals = {};
  for (const key of ["name", "code", "reception_steps", "delivery_steps"]) if (v[key] !== form.initial[key]) vals[key] = key === "name" || key === "code" ? v[key].trim() : v[key];
  if ([...v.resupply].sort().join() !== [...form.initial.resupply].sort().join()) vals.resupply_wh_ids = supplyCommand;
  if (Object.keys(vals).length) await call("stock.warehouse", "write", { ids: [form.id], vals });
  return form.id;
}

/** Penonaktifan aman: tolak bila masih ada stok, operasi berjalan, atau ini gudang aktif terakhir. */
async function archiveWarehouse(id) {
  const active = await referenceWarehouses();
  if (active.length <= 1) throw new Error("Gudang aktif terakhir tidak boleh diarsipkan.");
  const [stock, open] = await Promise.all([
    searchRead("stock.quant", [["location_id.warehouse_id", "=", id], ["location_id.usage", "=", "internal"], ["quantity", "!=", 0]], ["product_id", "quantity"], { limit: 200 }),
    searchRead("stock.picking", [["picking_type_id.warehouse_id", "=", id], ["state", "not in", ["done", "cancel"]]], ["name"], { limit: 5 }),
  ]);
  if (stock.length) {
    const total = stock.reduce((s, q) => s + q.quantity, 0);
    throw new Error(`Gudang masih berisi stok (${stock.length} baris, total ${new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 }).format(total)} unit). Pindahkan atau sesuaikan stok sampai nol lebih dulu.`);
  }
  if (open.length) throw new Error(`Masih ada transfer yang belum selesai: ${open.map((p) => p.name).join(", ")}. Selesaikan atau batalkan lebih dulu.`);
  try {
    await call("stock.warehouse", "write", { ids: [id], vals: { active: false } });
  } catch (error) {
    if (/ongoing operations/i.test(error.message)) throw new Error(`Gudang masih punya operasi berjalan (penerimaan, pengiriman, transfer, atau produksi yang belum selesai). Selesaikan atau batalkan lebih dulu. (${error.message})`);
    throw error;
  }
  return true;
}

export async function onClick(event, el) {
  const { action } = el.dataset;
  if (action === "discard") form = null;
  else if (action === "save") {
    const saved = await guarded(el, persist);
    if (saved) {
      const wasNew = !form.id;
      form = null;
      resetReferences();
      toast(wasNew ? "Gudang dibuat." : "Perubahan disimpan.");
      if (wasNew) location.hash = `#/warehouse/${saved}`;
      else reload();
    }
  } else if (action === "archive") {
    if (!window.confirm("Arsipkan gudang ini? Lokasi, tipe operasi, dan rutenya ikut dinonaktifkan.")) return;
    const ok = await guarded(el, () => archiveWarehouse(Number(el.dataset.id)));
    if (ok) {
      form = null;
      resetReferences();
      toast("Gudang diarsipkan.");
      location.hash = "#/warehouse";
    }
  } else if (action === "unarchive") {
    const ok = await guarded(el, () => call("stock.warehouse", "write", { ids: [Number(el.dataset.id)], vals: { active: true } }));
    if (ok !== undefined) {
      form = null;
      resetReferences();
      toast("Gudang diaktifkan kembali.");
      reload();
    }
  } else if (action === "apply-features") {
    const vals = Object.fromEntries(FEATURES.map((f) => [f.setting, Boolean(document.querySelector(`[data-feature="${f.setting}"]`)?.checked)]));
    const ok = await guarded(el, async () => {
      const [id] = await call("res.config.settings", "create", { vals_list: [vals] });
      await call("res.config.settings", "execute", { ids: [id] });
      return true;
    });
    if (ok) {
      features = null;
      resetReferences(); // hasGroup() di halaman lain menyimpan hasil per sesi
      toast("Fitur gudang diterapkan.");
      reload();
    }
  }
}

export function onInput(event, el) {
  if (form && el.dataset.wh) form.values[el.dataset.wh] = el.value;
  if (form && el.dataset.wh && (el.dataset.wh === "reception_steps" || el.dataset.wh === "delivery_steps")) document.querySelector("#wh-flow").innerHTML = whFlow();
}

export function onChange(event, el) {
  if (form && el.dataset.supplier) {
    const id = Number(el.dataset.supplier);
    form.values.resupply = el.checked ? [...new Set([...form.values.resupply, id])] : form.values.resupply.filter((x) => x !== id);
  }
}
