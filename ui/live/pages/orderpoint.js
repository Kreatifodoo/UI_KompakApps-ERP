// Reorder Level (stock.warehouse.orderpoint): aturan stok minimum dan maksimum per produk dan lokasi, dasar
// Replenishment. Dipakai juga sebagai kerangka halaman Replenishment (replenish.js).
import {
  INPUT, app, badge, call, cell, esc, fieldBlock, guarded, pageHeader, readOne, registerLookup, rowLink, runLookup, searchBox, searchRead,
  selectOptions, table, toast, button,
} from "../common.js";

const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 3 });
const TRIGGERS = { auto: "Otomatis (jadwal)", manual: "Manual" };
const FIELDS = [
  "product_id", "warehouse_id", "location_id", "product_min_qty", "product_max_qty", "qty_on_hand", "qty_forecast", "qty_to_order", "trigger", "route_id",
  "supplier_id", "product_uom",
];

let form = null; // { id, product, warehouse, location, min, max, trigger, route }
let refs = null;
let last = { sub: "", query: new URLSearchParams() };
export const leave = () => {
  form = null;
  refs = null; // gudang dan rute bisa berubah di halaman lain (D42)
};
const reload = () => render(last.sub, last.query);

registerLookup("op-product", {
  search: (q) => searchRead("product.product", [["is_storable", "=", true], ...(q ? ["|", ["name", "ilike", q], ["default_code", "ilike", q]] : [])], ["display_name", "uom_id"], { limit: 10, order: "name" }),
  sub: (r) => r.uom_id?.[1] ?? "",
  isChosen: (input) => form?.product?.display_name === input.value,
  choose: (input, item) => {
    form.product = item;
    input.value = item.display_name;
  },
});

async function references() {
  refs ??= {
    warehouses: await searchRead("stock.warehouse", [], ["display_name", "lot_stock_id"], { order: "name" }),
    locations: await searchRead("stock.location", [["usage", "=", "internal"]], ["display_name"], { order: "complete_name" }),
    routes: await searchRead("stock.route", [["product_selectable", "=", true]], ["display_name", "supplied_wh_id"], { order: "sequence, name" }),
  };
  return refs;
}

export async function render(sub, query) {
  last = { sub, query };
  if (sub === "") return renderList(query);
  return renderForm(sub === "new" ? null : Number(sub));
}

async function renderList(query) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const text = query.get("q") ?? "";
  const domain = text ? [["product_id.name", "ilike", text]] : [];
  const rows = await searchRead("stock.warehouse.orderpoint", domain, FIELDS, { order: "id desc", limit: 200 });
  const body = rows
    .map((r) =>
      rowLink(`#/orderpoint/${r.id}`, [
        cell(r.product_id[1], { strong: true }), cell(r.location_id[1]), cell(r.route_id?.[1] ?? "-"),
        cell(nf.format(r.product_min_qty), { right: true }), cell(nf.format(r.product_max_qty), { right: true }),
        cell(nf.format(r.qty_on_hand), { right: true }), cell(nf.format(r.qty_forecast), { right: true }),
        cell(r.qty_to_order > 0 ? badge({ x: [nf.format(r.qty_to_order), "warning"] }, "x") : "-", { raw: true }), cell(TRIGGERS[r.trigger] ?? r.trigger),
      ]),
    )
    .join("");
  app.innerHTML =
    pageHeader(
      "Reorder Level",
      `${searchBox(text, "Cari produk")}
       <a href="#/orderpoint/new" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"><i class="fas fa-plus mr-2"></i>Aturan Baru</a>`,
    ) +
    table(
      [{ label: "Produk" }, { label: "Lokasi" }, { label: "Rute" }, { label: "Min", right: true }, { label: "Maks", right: true }, { label: "Tersedia", right: true }, { label: "Prakiraan", right: true }, { label: "Perlu Dipesan", right: true }, { label: "Pemicu" }],
      body,
      "Belum ada aturan stok minimum. Tambahkan aturan agar pengisian ulang bisa dipicu.",
    ) +
    '<p class="text-xs text-gray-500 mt-3">Prakiraan = stok tersedia ditambah pesanan masuk dikurangi pesanan keluar. Pengisian ulang dijalankan dari menu Replenishment.</p>';
}

async function renderForm(id) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const r = await references();
  let op = null;
  if (id) {
    op = await readOne("stock.warehouse.orderpoint", id, FIELDS);
    if (!op) {
      app.innerHTML = '<p class="text-sm text-rose-600">Aturan tidak ditemukan.</p>';
      return;
    }
  }
  if (!form || form.id !== (op?.id ?? null)) {
    form = op
      ? { id: op.id, product: { id: op.product_id[0], display_name: op.product_id[1] }, warehouse: op.warehouse_id[0], location: op.location_id[0], min: op.product_min_qty, max: op.product_max_qty, trigger: op.trigger, route: op.route_id?.[0] ?? null }
      : { id: null, product: null, warehouse: r.warehouses[0]?.id ?? null, location: r.warehouses[0]?.lot_stock_id?.[0] ?? r.locations[0]?.id ?? null, min: "", max: "", trigger: "manual", route: null };
  }
  const f = form;
  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/orderpoint" class="hover:text-indigo-600">Reorder Level</a> / ${esc(op?.product_id[1] ?? "Baru")}</div>
    <div class="flex flex-wrap gap-2 mb-3">${op ? button("delete", "Hapus", "danger", { id: op.id }) : ""}</div>
    <h1 class="text-2xl font-bold text-gray-900 mb-3">${esc(op?.product_id[1] ?? "Aturan Stok Baru")}</h1>
    ${op ? `<div class="flex flex-wrap gap-3 mb-4 text-sm text-gray-700"><span>Tersedia <b>${nf.format(op.qty_on_hand)}</b></span><span>Prakiraan <b>${nf.format(op.qty_forecast)}</b></span><span>Perlu dipesan <b>${nf.format(op.qty_to_order)}</b></span></div>` : ""}
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-2 gap-x-8 gap-y-4">
      ${fieldBlock("Produk", `<input data-lookup="op-product" autocomplete="off" role="combobox" aria-autocomplete="list" value="${esc(f.product?.display_name ?? "")}" placeholder="Cari produk yang dilacak stoknya..." class="${INPUT}">`)}
      ${fieldBlock("Gudang", `<select data-op="warehouse" class="${INPUT}">${selectOptions(r.warehouses, f.warehouse)}</select>`)}
      ${fieldBlock("Lokasi", `<select data-op="location" class="${INPUT}">${selectOptions(r.locations, f.location)}</select>`)}
      ${fieldBlock("Pemicu", `<select data-op="trigger" class="${INPUT}">${Object.entries(TRIGGERS).map(([k, label]) => `<option value="${k}" ${k === f.trigger ? "selected" : ""}>${esc(label)}</option>`).join("")}</select>`)}
      ${fieldBlock("Stok Minimum", `<input type="number" min="0" step="any" data-op="min" value="${esc(f.min)}" class="${INPUT} text-right">`)}
      ${fieldBlock("Stok Maksimum", `<input type="number" min="0" step="any" data-op="max" value="${esc(f.max)}" class="${INPUT} text-right">`)}
      ${fieldBlock("Rute (opsional)", `<select data-op="route" class="${INPUT}">${selectOptions(routesFor(r, f.warehouse, f.route), f.route, "Otomatis dari produk (beli dari pemasok)")}</select>`)}
    </section>
    ${supplyNote(r, f)}
    <p class="text-xs text-gray-500 mt-3">Bila prakiraan stok turun di bawah minimum, jumlah yang dipesan = maksimum dikurangi prakiraan. Pemasok dan harga diambil dari Vendor Price list produk.</p>
    <div class="flex gap-2 mt-4"><button data-action="save" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Simpan</button>
      <a href="#/orderpoint" data-action="discard" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Buang</a></div>`;
}

/** Rute suplai antar gudang hanya berlaku untuk gudang yang disuplai; rute yang sedang terpilih tetap tampil agar tidak hilang diam-diam. */
const routesFor = (r, warehouse, selected) => r.routes.filter((x) => !x.supplied_wh_id || x.supplied_wh_id[0] === warehouse || x.id === selected);
const supplyNote = (r, f) => {
  const route = r.routes.find((x) => x.id === f.route);
  return route?.supplied_wh_id
    ? `<p class="mt-3 text-sm text-sky-900 bg-sky-50 border border-sky-200 rounded-lg px-4 py-3">Rute suplai antar gudang: kekurangan stok dipenuhi lewat transfer dari gudang pemasok (keluar ke lokasi transit, lalu diterima di gudang ini), bukan lewat RFQ. Dokumennya dibuka di <a href="#/transfer?scope=transit" class="underline">Transfer Antar Gudang</a>.</p>`
    : "";
};

async function persist() {
  const f = form;
  if (!f.product) throw new Error("Pilih produk dari kotak saran.");
  const min = Number(f.min);
  const max = Number(f.max);
  if (!(min >= 0) || !(max >= 0)) throw new Error("Stok minimum dan maksimum tidak boleh negatif.");
  if (max < min) throw new Error("Stok maksimum tidak boleh lebih kecil dari minimum.");
  const vals = { product_id: f.product.id, warehouse_id: f.warehouse, location_id: f.location, product_min_qty: min, product_max_qty: max, trigger: f.trigger, route_id: f.route || false };
  if (f.id) {
    await call("stock.warehouse.orderpoint", "write", { ids: [f.id], vals });
    return f.id;
  }
  const [id] = await call("stock.warehouse.orderpoint", "create", { vals_list: [vals] });
  return id;
}

/** Ganti gudang -> lokasi bawaan gudang itu dan rute yang tidak berlaku dilepas; ganti rute -> catatan suplai diperbarui. */
async function changed(what) {
  const r = await references();
  if (what === "warehouse") {
    form.location = r.warehouses.find((w) => w.id === form.warehouse)?.lot_stock_id?.[0] ?? form.location;
    if (!routesFor(r, form.warehouse, null).some((x) => x.id === form.route)) form.route = null;
  }
  await renderForm(form.id);
}

export async function onClick(event, el) {
  const { action } = el.dataset;
  const id = Number(el.dataset.id) || null;
  if (action === "discard") form = null;
  else if (action === "save") {
    const saved = await guarded(el, persist);
    if (saved) {
      const wasNew = !form.id;
      form = null;
      toast(wasNew ? "Aturan dibuat." : "Perubahan disimpan.");
      if (wasNew) location.hash = `#/orderpoint/${saved}`;
      else reload();
    }
  } else if (action === "delete") {
    if (!window.confirm("Hapus aturan stok ini?")) return;
    const ok = await guarded(el, () => call("stock.warehouse.orderpoint", "unlink", { ids: [id] }));
    if (ok !== undefined) {
      form = null;
      toast("Aturan dihapus.");
      location.hash = "#/orderpoint";
    }
  }
}

export function onInput(event, el) {
  if (!form) return;
  if (el.dataset.op) {
    form[el.dataset.op] = ["warehouse", "location", "route"].includes(el.dataset.op) ? Number(el.value) || null : el.value;
    if (el.dataset.op === "warehouse" || el.dataset.op === "route") changed(el.dataset.op);
  }
  else if (el.dataset.lookup === "op-product") {
    form.product = null;
    runLookup(el, 250);
  }
}
