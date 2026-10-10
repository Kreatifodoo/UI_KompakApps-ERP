// Warehouse Master (stock.warehouse) dan fitur gudang. Fitur Storage Locations dan Lots & Serial Numbers diaktifkan
// lewat pengaturan Odoo (res.config.settings); Storage Locations membuka transfer internal, Lots & Serial membuka
// pelacakan lot dan nomor seri pada produk.
import { INPUT, app, call, cell, ctx, esc, fieldBlock, guarded, pageHeader, readOne, resetReferences, rowLink, searchRead, table, toast, button } from "../common.js";

const RECEPTION = { one_step: "Terima dan simpan (1 langkah)", two_steps: "Terima lalu simpan (2 langkah)", three_steps: "Terima, kendali mutu, lalu simpan (3 langkah)" };
const DELIVERY = { ship_only: "Kirim (1 langkah)", pick_ship: "Ambil lalu kirim (2 langkah)", pick_pack_ship: "Ambil, kemas, lalu kirim (3 langkah)" };
const FEATURES = [
  { setting: "group_stock_multi_locations", group: "stock.group_stock_multi_locations", label: "Storage Locations", about: "Lokasi di dalam gudang dan transfer internal antar lokasi." },
  { setting: "group_stock_production_lot", group: "stock.group_production_lot", label: "Lots & Serial Numbers", about: "Melacak lot atau nomor seri produk." },
];

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
  if (sub === "") return renderList();
  return renderForm(sub === "new" ? null : Number(sub));
}

async function loadFeatures() {
  const entries = await Promise.all(FEATURES.map(async (f) => [f.setting, Boolean(await call("res.users", "has_group", { ids: [ctx.user.id], group_ext_id: f.group }))]));
  features = Object.fromEntries(entries);
}

async function renderList() {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const [rows] = await Promise.all([
    searchRead("stock.warehouse", [], ["name", "code", "reception_steps", "delivery_steps", "lot_stock_id", "partner_id"], { order: "name" }),
    features ? null : loadFeatures(),
  ]);
  const body = rows
    .map((r) => rowLink(`#/warehouse/${r.id}`, [cell(r.name, { strong: true }), cell(r.code), cell(r.lot_stock_id?.[1] ?? "-"), cell(RECEPTION[r.reception_steps] ?? r.reception_steps), cell(DELIVERY[r.delivery_steps] ?? r.delivery_steps)]))
    .join("");
  const toggles = FEATURES.map(
    (f) => `<label class="flex items-start gap-3 text-sm"><input type="checkbox" data-feature="${f.setting}" ${features[f.setting] ? "checked" : ""} class="mt-1 rounded border-gray-300 text-indigo-600">
      <span><span class="font-medium text-gray-900">${esc(f.label)}</span><span class="block text-gray-500">${esc(f.about)}</span></span></label>`,
  ).join("");
  app.innerHTML =
    pageHeader(
      "Warehouse & Location Master",
      `<a href="#/location" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50"><i class="fas fa-location-dot mr-2"></i>Lokasi</a>
       <a href="#/warehouse/new" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"><i class="fas fa-plus mr-2"></i>Gudang Baru</a>`,
    ) +
    `<section class="bg-white rounded-xl shadow-sm border border-gray-200 p-5 mb-4"><div class="text-sm font-semibold mb-3">Fitur gudang</div>
       <div class="grid md:grid-cols-2 gap-4">${toggles}</div>
       <div class="mt-4"><button data-action="apply-features" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Terapkan Fitur</button></div></section>` +
    table([{ label: "Gudang" }, { label: "Kode" }, { label: "Lokasi Stok" }, { label: "Penerimaan" }, { label: "Pengiriman" }], body, "Belum ada gudang.");
}

async function renderForm(id) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  let wh = null;
  if (id) {
    wh = await readOne("stock.warehouse", id, ["name", "code", "reception_steps", "delivery_steps", "lot_stock_id", "view_location_id", "active"]);
    if (!wh) {
      app.innerHTML = '<p class="text-sm text-rose-600">Gudang tidak ditemukan.</p>';
      return;
    }
  }
  if (!form || form.id !== (wh?.id ?? null)) {
    const values = wh ? { name: wh.name, code: wh.code, reception_steps: wh.reception_steps, delivery_steps: wh.delivery_steps } : { name: "", code: "", reception_steps: "one_step", delivery_steps: "ship_only" };
    form = { id: wh?.id ?? null, values, initial: wh ? { ...values } : null };
  }
  const v = form.values;
  const select = (key, options) => `<select data-wh="${key}" class="${INPUT}">${Object.entries(options).map(([k, label]) => `<option value="${k}" ${k === v[key] ? "selected" : ""}>${esc(label)}</option>`).join("")}</select>`;
  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/warehouse" class="hover:text-indigo-600">Warehouse & Location Master</a> / ${esc(wh?.name ?? "Baru")}</div>
    <h1 class="text-2xl font-bold text-gray-900 mb-3">${esc(wh?.name ?? "Gudang Baru")}</h1>
    ${wh ? `<p class="text-sm text-gray-600 mb-3">Lokasi stok: <b>${esc(wh.lot_stock_id[1])}</b> · <a href="#/location?warehouse=${wh.id}" class="text-indigo-700 hover:underline">lihat lokasi gudang ini</a></p>` : ""}
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-2 gap-x-8 gap-y-4">
      ${fieldBlock("Nama Gudang", `<input data-wh="name" value="${esc(v.name)}" class="${INPUT}">`)}
      ${fieldBlock("Kode Singkat (maks 5 huruf)", `<input data-wh="code" maxlength="5" value="${esc(v.code)}" class="${INPUT}">`)}
      ${fieldBlock("Penerimaan Barang", select("reception_steps", RECEPTION))}
      ${fieldBlock("Pengiriman Barang", select("delivery_steps", DELIVERY))}
    </section>
    <p class="text-xs text-gray-500 mt-3">Penerimaan dan pengiriman lebih dari 1 langkah membutuhkan Multi-Step Routes di pengaturan Odoo.</p>
    <div class="flex flex-wrap gap-2 mt-4"><button data-action="save" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Simpan</button>
      <a href="#/warehouse" data-action="discard" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Buang</a>
      ${wh ? button("archive", "Arsipkan", "danger", { id: wh.id }) : ""}</div>`;
}

async function persist() {
  const v = form.values;
  if (!v.name.trim()) throw new Error("Nama gudang wajib diisi.");
  if (!v.code.trim()) throw new Error("Kode singkat wajib diisi.");
  if (!form.id) {
    const [id] = await call("stock.warehouse", "create", { vals_list: [{ name: v.name.trim(), code: v.code.trim(), reception_steps: v.reception_steps, delivery_steps: v.delivery_steps }] });
    return id;
  }
  const vals = {};
  for (const key of Object.keys(v)) if (v[key] !== form.initial[key]) vals[key] = key === "name" || key === "code" ? v[key].trim() : v[key];
  if (Object.keys(vals).length) await call("stock.warehouse", "write", { ids: [form.id], vals });
  return form.id;
}

export async function onClick(event, el) {
  const { action } = el.dataset;
  if (action === "discard") form = null;
  else if (action === "save") {
    const saved = await guarded(el, persist);
    if (saved) {
      const wasNew = !form.id;
      form = null;
      toast(wasNew ? "Gudang dibuat." : "Perubahan disimpan.");
      if (wasNew) location.hash = `#/warehouse/${saved}`;
      else reload();
    }
  } else if (action === "archive") {
    if (!window.confirm("Arsipkan gudang ini? Lokasi dan tipe operasinya ikut dinonaktifkan.")) return;
    const ok = await guarded(el, () => call("stock.warehouse", "write", { ids: [Number(el.dataset.id)], vals: { active: false } }));
    if (ok !== undefined) {
      form = null;
      toast("Gudang diarsipkan.");
      location.hash = "#/warehouse";
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
}
