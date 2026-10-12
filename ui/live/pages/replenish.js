// Replenishment: aturan stok minimum yang prakiraan stoknya di bawah minimum, dengan jumlah yang perlu dipesan.
// "Pesan" menjalankan pengisian ulang Odoo, yang membuat RFQ ke pemasok dari Vendor Price list produk.
import { INPUT, app, call, cell, esc, guarded, pageHeader, searchRead, table, toast, button } from "../common.js";

const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 3 });
let last = { sub: "", query: new URLSearchParams() };
let orders = new Map(); // id aturan -> jumlah pesan yang diedit
export const leave = () => {
  orders = new Map();
};
const reload = () => render(last.sub, last.query);

export async function render(sub, query) {
  last = { sub, query };
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const rows = await searchRead(
    "stock.warehouse.orderpoint", [["qty_to_order", ">", 0]],
    ["product_id", "location_id", "product_min_qty", "product_max_qty", "qty_on_hand", "qty_forecast", "qty_to_order", "trigger", "supplier_id", "product_uom", "route_id"],
    { order: "id", limit: 200 },
  );
  const body = rows
    .map((r) => {
      const value = orders.get(r.id) ?? r.qty_to_order;
      return `<tr class="align-top">${cell(r.product_id[1], { strong: true })}${cell(r.location_id[1])}${cell(r.route_id ? r.route_id[1] : "Beli dari pemasok")}${cell(nf.format(r.qty_on_hand), { right: true })}${cell(nf.format(r.qty_forecast), { right: true })}
        ${cell(`${nf.format(r.product_min_qty)} / ${nf.format(r.product_max_qty)}`, { right: true })}
        <td class="py-2 px-4 w-36"><input type="number" min="0" step="any" data-order="${r.id}" data-suggested="${r.qty_to_order}" value="${esc(value)}" class="${INPUT} text-right" aria-label="Jumlah pesan ${esc(r.product_id[1])}"></td>
        <td class="py-2 px-4 text-sm text-right">${button("order", "Pesan", "plain", { id: r.id })}</td></tr>`;
    })
    .join("");
  app.innerHTML =
    pageHeader(
      "Replenishment",
      `<button data-action="order-all" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Pesan Semua</button>
       <button data-action="refresh" class="px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50" aria-label="Muat ulang"><i class="fas fa-rotate"></i></button>`,
    ) +
    table(
      [{ label: "Produk" }, { label: "Lokasi" }, { label: "Rute" }, { label: "Tersedia", right: true }, { label: "Prakiraan", right: true }, { label: "Min / Maks", right: true }, { label: "Jumlah Pesan", right: true }, { label: "" }],
      body,
      "Tidak ada produk di bawah stok minimum. Atur aturan di Reorder Level.",
    ) +
    '<p class="text-xs text-gray-500 mt-3">Pesan membuat RFQ ke pemasok produk (harga dari Vendor Price list). RFQ dikonfirmasi dan diterima lewat menu Purchase. Aturan dengan rute suplai antar gudang membuat transfer (keluar dari gudang pemasok, lalu diterima di gudang ini) yang dibuka di halaman Transfer Antar Gudang.</p>';
}

async function order(ids) {
  const targets = ids.length ? ids : [];
  if (!targets.length) throw new Error("Tidak ada yang dipesan.");
  for (const id of targets) {
    const edited = orders.get(id);
    if (edited !== undefined && !(Number(edited) >= 0)) throw new Error("Jumlah pesan tidak boleh negatif.");
    if (edited !== undefined) await call("stock.warehouse.orderpoint", "write", { ids: [id], vals: { qty_to_order: Number(edited) } });
  }
  // transfer antar gudang yang dibuat pengisian ulang dikenali dari asal dokumen (nama aturan) dan nomor id yang baru
  const [{ id: lastPicking = 0 } = {}] = await searchRead("stock.picking", [], ["id"], { order: "id desc", limit: 1 });
  const names = (await call("stock.warehouse.orderpoint", "read", { ids: targets, fields: ["name"] })).map((r) => r.name);
  const result = await call("stock.warehouse.orderpoint", "action_replenish", { ids: targets });
  const labels = (result?.params?.links ?? []).map((l) => l.label);
  const pickings = await searchRead("stock.picking", [["id", ">", lastPicking], ["origin", "in", names]], ["id"], { order: "id" });
  for (const id of targets) orders.delete(id);
  return { labels, pickings: pickings.map((p) => p.id) };
}

async function openOrders({ labels, pickings }) {
  const rfqs = labels.length ? await searchRead("purchase.order", [["name", "in", labels]], ["id"], { order: "id" }) : [];
  if (rfqs.length) location.hash = rfqs.length === 1 ? `#/po/${rfqs[0].id}` : `#/po?ids=${rfqs.map((r) => r.id).join(",")}`;
  else if (pickings.length) location.hash = `#/transfer?ids=${pickings.join(",")}`;
}

export async function onClick(event, el) {
  const { action } = el.dataset;
  if (action === "refresh") reload();
  else if (action === "order" || action === "order-all") {
    const ids = action === "order" ? [Number(el.dataset.id)] : [...document.querySelectorAll("[data-order]")].map((i) => Number(i.dataset.order));
    const done = await guarded(el, () => order(ids));
    if (done === undefined) return;
    const { labels, pickings } = done;
    toast(
      pickings.length ? `${pickings.length} transfer antar gudang dibuat (${labels.join(", ") || "lihat daftar"}).` : labels.length ? `RFQ dibuat: ${labels.join(", ")}.` : "Tidak ada RFQ yang dibuat (pemasok belum diatur untuk produk ini).",
    );
    if (labels.length || pickings.length) await openOrders(done);
    else reload();
  }
}

export function onInput(event, el) {
  if (el.dataset.order) orders.set(Number(el.dataset.order), el.value);
}
