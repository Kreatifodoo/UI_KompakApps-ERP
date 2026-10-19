// Replenishment: produk yang prakiraan stoknya di bawah minimum atau negatif karena permintaan (Sales Order, Manufacturing Order),
// dengan jumlah yang perlu dipesan. Saat halaman dibuka, Odoo membuatkan aturan manual untuk produk bertuntutan tanpa aturan min/maks
// (action_open_orderpoints). Rute dan pemicu dipilih per baris; "Pesan" menjalankan pengisian ulang Odoo: RFQ (Beli), Manufacturing Order
// (Produksi), atau transfer antar gudang (rute suplai). Pemicu Otomatis dijalankan penjadwal Odoo tanpa klik (D47).
import { INPUT, app, call, cell, esc, guarded, pageHeader, searchRead, table, toast, button } from "../common.js";
import { blockOverStock, stockAt, stockText } from "../stockqty.js";
import { effectiveKind, friendlyReplenishError, loadRoutes, productSupport, routeWarning, routesFor } from "../routes.js";

const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 3 });
const TRIGGERS = { manual: "Manual", auto: "Otomatis" };
const FIELDS = [
  "name", "product_id", "product_tmpl_id", "warehouse_id", "location_id", "product_min_qty", "product_max_qty", "qty_on_hand", "qty_forecast", "qty_to_order",
  "trigger", "route_id", "effective_route_id", "product_uom",
];
const DOC_TYPES = {
  po: { label: "RFQ", model: "purchase.order", list: "#/po", one: "#/po/" },
  mo: { label: "MO", model: "mrp.production", list: "#/mo", one: "#/mo/" },
  picking: { label: "Transfer", model: "stock.picking", list: "#/transfer", one: null },
};

let last = { sub: "", query: new URLSearchParams() };
let orders = new Map(); // id aturan -> jumlah pesan yang diedit
let rows = []; // aturan yang sedang ditampil
let routes = [];
let supply = new Map(); // id aturan -> { available, onhand, place } stok di gudang sumber untuk rute suplai antar gudang (D70)
let summary = null; // hasil pengisian ulang terakhir: { docs: [{ type, id, name }], failed: [{ product, message }] }
export const leave = () => {
  orders = new Map();
  rows = [];
  routes = [];
  supply = new Map();
  summary = null;
};
const reload = () => render(last.sub, last.query);

/** Buka halaman: minta Odoo membuat aturan manual untuk produk yang prakiraannya negatif, lalu gambar tabel. */
export async function render(sub, query) {
  last = { sub, query };
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  try {
    await call("stock.warehouse.orderpoint", "action_open_orderpoints");
  } catch (error) {
    toast(`Aturan dari permintaan belum bisa dibuat otomatis: ${error.message}`, "error");
  }
  await draw();
}

async function draw() {
  [rows, routes] = await Promise.all([
    searchRead("stock.warehouse.orderpoint", [["qty_to_order", ">", 0]], FIELDS, { order: "id", limit: 200 }),
    routes.length ? routes : loadRoutes(),
  ]);
  const [support] = await Promise.all([productSupport(rows.map((r) => r.product_tmpl_id[0])), loadSupply()]);
  const body = rows.map((r) => rowHtml(r, support)).join("");
  app.innerHTML =
    pageHeader(
      "Replenishment",
      `<button data-action="order-all" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Pesan Semua</button>
       <button data-action="refresh" class="px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50" aria-label="Muat ulang"><i class="fas fa-rotate"></i></button>`,
    ) +
    summaryHtml() +
    table(
      [{ label: "Produk" }, { label: "Lokasi" }, { label: "Rute" }, { label: "Pemicu" }, { label: "Tersedia", right: true }, { label: "Prakiraan", right: true }, { label: "Min / Maks", right: true }, { label: "Jumlah Pesan", right: true }, { label: "" }],
      body,
      "Tidak ada produk di bawah stok minimum atau kekurangan karena permintaan. Atur aturan di Reorder Level.",
    ) +
    `<div class="text-xs text-gray-500 mt-3 space-y-1">
       <p>Produk yang stoknya kurang karena Sales Order atau Manufacturing Order muncul di sini sebagai aturan manual walau belum punya aturan min/maks (kolom Min / Maks kosong).</p>
       <p><b>Rute</b>: Beli membuat RFQ ke pemasok produk (harga dari Vendor Price list; RFQ pemasok yang sama digabung), Produksi membuat Manufacturing Order dari BoM, suplai antar gudang membuat transfer (keluar dari gudang pemasok, lalu diterima di gudang ini). Rute kosong mengikuti pengaturan produk.</p>
       <p><b>Pemicu Otomatis</b>: pesanan dibuat sendiri oleh penjadwal Odoo (satu kali sehari) tanpa klik Pesan; Pesan di sini menjalankannya sekarang. Jumlah aturan otomatis dihitung Odoo (maksimum dikurangi prakiraan) sehingga tidak bisa diubah. Pemicu Manual menunggu Pesan.</p>
     </div>`;
}

/** Stok di gudang sumber untuk baris yang rutenya suplai antar gudang: yang diminta dari gudang lain harus ada di sana. */
async function loadSupply() {
  supply = new Map();
  const wanted = rows.map((r) => ({ r, route: routes.find((x) => x.id === (r.route_id?.[0] || r.effective_route_id?.[0])) })).filter((x) => x.route?.kind === "resupply" && x.route.supplier_wh_id);
  if (!wanted.length) return;
  const warehouses = await searchRead("stock.warehouse", [["id", "in", [...new Set(wanted.map((x) => x.route.supplier_wh_id[0]))]]], ["lot_stock_id"]);
  const places = new Map(warehouses.map((w) => [w.id, w.lot_stock_id]));
  const bySource = new Map();
  for (const { r, route } of wanted) {
    const place = places.get(route.supplier_wh_id[0]);
    if (place) bySource.set(place[0], [...(bySource.get(place[0]) ?? []), { r, place }]);
  }
  await Promise.all([...bySource].map(async ([locationId, list]) => {
    const stock = await stockAt(list.map((x) => x.r.product_id[0]), locationId);
    for (const { r, place } of list) supply.set(r.id, { ...(stock.get(r.product_id[0]) ?? { onhand: 0, available: 0 }), place: place[1] });
  }));
}

/** Petunjuk stok gudang sumber di bawah jumlah pesan; merah bila jumlah melebihi stok tersedia di sana. */
function supplyLine(r, qty) {
  const info = supply.get(r.id);
  if (!info) return "";
  const over = Number(qty) > info.available + 1e-9;
  return `<div class="text-xs mt-1 ${over ? "text-rose-600" : "text-gray-500"}" id="supply-${r.id}">${esc(stockText(info, r.product_uom?.[1], info.place))}${over ? " · melebihi stok tersedia" : ""}</div>`;
}

function rowHtml(r, support) {
  const kind = effectiveKind(routes, r.route_id?.[0], r.effective_route_id?.[0]);
  const warning = routeWarning(kind, support, r.product_tmpl_id[0]);
  const auto = r.trigger === "auto";
  const value = auto ? r.qty_to_order : (orders.get(r.id) ?? r.qty_to_order);
  const effective = r.effective_route_id ? (routes.find((x) => x.id === r.effective_route_id[0])?.short ?? r.effective_route_id[1]) : "belum ada rute";
  const options = routesFor(routes, r.warehouse_id[0], r.route_id?.[0])
    .map((x) => `<option value="${x.id}" ${x.id === r.route_id?.[0] ? "selected" : ""}>${esc(x.label)}</option>`)
    .join("");
  const unruled = !r.product_min_qty && !r.product_max_qty;
  return `<tr class="align-top">
    <td class="py-3 px-4 text-sm font-medium text-indigo-700">${esc(r.product_id[1])}${warning ? `<div class="mt-1 text-xs font-normal text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1 max-w-xs" data-warning="${r.id}">${esc(warning)}</div>` : ""}</td>
    ${cell(r.location_id[1])}
    <td class="py-2 px-4 min-w-[13rem]"><select data-route="${r.id}" class="${INPUT}" aria-label="Rute ${esc(r.product_id[1])}"><option value="">${esc(`Otomatis: ${effective}`)}</option>${options}</select></td>
    <td class="py-2 px-4 min-w-[7.5rem]"><select data-trigger="${r.id}" class="${INPUT}" aria-label="Pemicu ${esc(r.product_id[1])}">${Object.entries(TRIGGERS).map(([k, label]) => `<option value="${k}" ${k === r.trigger ? "selected" : ""}>${label}</option>`).join("")}</select></td>
    ${cell(nf.format(r.qty_on_hand), { right: true })}${cell(nf.format(r.qty_forecast), { right: true })}
    ${cell(unruled ? "Tanpa aturan" : `${nf.format(r.product_min_qty)} / ${nf.format(r.product_max_qty)}`, { right: true })}
    <td class="py-2 px-4 w-36"><input type="number" min="0" step="any" data-order="${r.id}" data-suggested="${r.qty_to_order}" value="${esc(value)}" ${auto ? 'readonly title="Jumlah aturan otomatis dihitung Odoo"' : ""} class="${INPUT} text-right ${auto ? "bg-gray-50 text-gray-500" : ""}" aria-label="Jumlah pesan ${esc(r.product_id[1])}">${supplyLine(r, value)}</td>
    <td class="py-2 px-4 text-sm text-right">${button("order", "Pesan", "plain", { id: r.id })}</td></tr>`;
}

const docLink = (d) => {
  const type = DOC_TYPES[d.type];
  return `<a class="underline" href="${type.one ? `${type.one}${d.id}` : `${type.list}?ids=${d.id}`}">${esc(d.name)}</a>`;
};
function summaryHtml() {
  if (!summary) return "";
  const done = summary.docs.length ? `<p class="text-sm text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 mb-3">Dokumen dibuat: ${summary.docs.map((d) => `${DOC_TYPES[d.type].label} ${docLink(d)}`).join(", ")}.</p>` : "";
  const failed = summary.failed.length
    ? `<div class="text-sm text-rose-900 bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 mb-3"><p class="font-medium">Tidak berhasil dipesan:</p><ul class="list-disc ml-5">${summary.failed.map((f) => `<li><b>${esc(f.product)}</b>: ${esc(f.message)}</li>`).join("")}</ul></div>`
    : "";
  return done + failed;
}

/** Jalankan pengisian ulang satu aturan (satu panggilan per aturan agar Odoo menyebut dokumen yang dibuat), kembalikan dokumen atau galat. */
async function orderOne(r) {
  const edited = orders.get(r.id);
  const source = supply.get(r.id);
  if (source && (await blockOverStock())) {
    const qty = r.trigger !== "auto" && edited !== undefined && edited !== "" ? Number(edited) : r.qty_to_order;
    if (qty > source.available + 1e-9) {
      return { failed: { product: r.product_id[1], message: `Jumlah ${nf.format(qty)} melebihi stok tersedia di ${source.place} (${nf.format(source.available)}). Kurangi jumlah, atau matikan "Blokir jumlah melebihi stok" di Inventory Setting.` } };
    }
  }
  if (r.trigger !== "auto" && edited !== undefined && edited !== "") {
    if (!(Number(edited) >= 0)) return { failed: { product: r.product_id[1], message: "Jumlah pesan tidak boleh negatif." } };
    if (Number(edited) !== r.qty_to_order) await call("stock.warehouse.orderpoint", "write", { ids: [r.id], vals: { qty_to_order: Number(edited) } });
  }
  // transfer antar gudang dikenali dari asal dokumen (nama aturan) dan nomor id yang baru
  const [{ id: lastPicking = 0 } = {}] = await searchRead("stock.picking", [], ["id"], { order: "id desc", limit: 1 });
  let result;
  try {
    result = await call("stock.warehouse.orderpoint", "action_replenish", { ids: [r.id] });
  } catch (error) {
    return { failed: { product: r.product_id[1], message: friendlyReplenishError(error.message) } };
  }
  const labels = (result?.params?.links ?? []).map((l) => l.label);
  const docs = [];
  for (const [type, { model }] of Object.entries(DOC_TYPES)) {
    const found = labels.length ? await searchRead(model, [["name", "in", labels]], ["name"], { order: "id" }) : [];
    docs.push(...found.map((d) => ({ type, id: d.id, name: d.name })));
  }
  const pickings = await searchRead("stock.picking", [["id", ">", lastPicking], ["origin", "=", r.name]], ["name"], { order: "id" });
  docs.push(...pickings.map((d) => ({ type: "picking", id: d.id, name: d.name })));
  orders.delete(r.id);
  if (!docs.length) return { failed: { product: r.product_id[1], message: "Tidak ada dokumen yang terbentuk (periksa rute, pemasok, atau BoM produk)." } };
  return { docs };
}

async function orderRows(targets) {
  if (!targets.length) throw new Error("Tidak ada yang dipesan.");
  const docs = [];
  const failed = [];
  for (const r of targets) {
    const done = await orderOne(r);
    if (done.failed) failed.push(done.failed);
    for (const d of done.docs ?? []) if (!docs.some((x) => x.type === d.type && x.id === d.id)) docs.push(d);
  }
  return { docs, failed };
}

/** Satu jenis dokumen tanpa galat langsung dibuka (satu dokumen atau daftarnya); selain itu hasil ditampilkan di halaman ini. */
function openResult({ docs, failed }) {
  const types = new Set(docs.map((d) => d.type));
  if (failed.length || types.size !== 1) return false;
  const [type] = types;
  const { list, one } = DOC_TYPES[type];
  location.hash = docs.length === 1 && one ? `${one}${docs[0].id}` : `${list}?ids=${docs.map((d) => d.id).join(",")}`;
  return true;
}

export async function onClick(event, el) {
  const { action } = el.dataset;
  if (action === "refresh") {
    summary = null;
    reload();
  } else if (action === "order" || action === "order-all") {
    const targets = action === "order" ? rows.filter((r) => r.id === Number(el.dataset.id)) : rows;
    const done = await guarded(el, () => orderRows(targets));
    if (done === undefined) return;
    const parts = [];
    if (done.docs.length) parts.push(`${done.docs.length} dokumen dibuat (${done.docs.map((d) => d.name).join(", ")})`);
    if (done.failed.length) parts.push(`${done.failed.length} gagal`);
    toast(`${parts.join("; ")}.`, done.failed.length && !done.docs.length ? "error" : "ok");
    summary = done;
    if (openResult(done)) summary = null;
    else await reload();
  }
}

/** Rute dan pemicu langsung tersimpan per baris, hanya bila nilainya berubah (D10). */
export async function onChange(event, el) {
  const id = Number(el.dataset.route || el.dataset.trigger);
  const row = rows.find((r) => r.id === id);
  if (!row || (el.dataset.route === undefined && el.dataset.trigger === undefined)) return;
  const vals = el.dataset.route !== undefined ? { route_id: Number(el.value) || false } : { trigger: el.value };
  const same = "route_id" in vals ? (row.route_id?.[0] ?? false) === vals.route_id : row.trigger === vals.trigger;
  if (same) return;
  const saved = await guarded(el, () => call("stock.warehouse.orderpoint", "write", { ids: [id], vals }));
  if (saved === undefined) {
    await draw();
    return;
  }
  toast("route_id" in vals ? "Rute disimpan." : `Pemicu ${TRIGGERS[vals.trigger].toLowerCase()} disimpan.`);
  await draw();
}

export function onInput(event, el) {
  if (!el.dataset.order) return;
  const id = Number(el.dataset.order);
  orders.set(id, el.value);
  const row = rows.find((r) => r.id === id);
  const box = document.getElementById(`supply-${id}`);
  if (row && box) box.outerHTML = supplyLine(row, el.value);
}
