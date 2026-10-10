// Transfer Internal dan Material Request (stock.picking, tipe internal): memindahkan barang antar lokasi gudang.
// Dokumen yang sudah ada memakai kerangka pickings.js; halaman ini menambahkan formulir transfer baru.
// Butuh fitur Storage Locations (aktifkan di Warehouse & Location Master).
import {
  INPUT, app, call, esc, fieldBlock, guarded, pageHeader, registerLookup, runLookup, searchRead, selectOptions, toast,
} from "../common.js";
import { createPickingPage } from "./pickings.js";

const INTERNAL = {
  route: "transfer", code: "internal", returnRoute: null, title: "Transfer Internal", noun: "Transfer", partner: "Kontak", qty: "Jumlah Dipindah", qtyLabel: "dipindah",
  source: null, newHref: "#/transfer/new", newLabel: "Transfer Baru", empty: "Belum ada transfer internal. Buat dengan Transfer Baru.", valuedNote: null,
};
const base = createPickingPage(INTERNAL);

let form = null; // { type, src, dest, lines: [{ product, qty }] }
let refs = null;
export const leave = () => {
  form = null;
  base.leave();
};

registerLookup("transfer-product", {
  search: (q) => searchRead("product.product", [["is_storable", "=", true], ...(q ? ["|", ["name", "ilike", q], ["default_code", "ilike", q]] : [])], ["display_name", "uom_id"], { limit: 10, order: "name" }),
  sub: (r) => r.uom_id?.[1] ?? "",
  isChosen: (input) => form?.lines[Number(input.dataset.line)]?.product?.display_name === input.value,
  choose: (input, item) => {
    form.lines[Number(input.dataset.line)].product = item;
    input.value = item.display_name;
  },
});

async function references() {
  refs ??= {
    types: await searchRead("stock.picking.type", [["code", "=", "internal"]], ["display_name", "default_location_src_id", "default_location_dest_id"], { order: "sequence, id" }),
    locations: await searchRead("stock.location", [["usage", "=", "internal"]], ["display_name"], { order: "complete_name" }),
  };
  return refs;
}

export async function render(sub, query) {
  if (sub === "new") return renderNew();
  return base.render(sub, query);
}

async function renderNew() {
  const r = await references();
  if (!r.types.length) {
    app.innerHTML = `${pageHeader("Transfer Baru")}<p class="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">Transfer internal belum aktif. Aktifkan <b>Storage Locations</b> di <a href="#/warehouse" class="underline">Warehouse &amp; Location Master</a>, lalu buat lokasi tujuan.</p>`;
    return;
  }
  form ??= {
    type: r.types[0].id, src: r.types[0].default_location_src_id?.[0] ?? r.locations[0]?.id, dest: r.locations.find((l) => l.id !== r.types[0].default_location_src_id?.[0])?.id ?? null,
    lines: [{ product: null, qty: "" }],
  };
  const rows = form.lines
    .map(
      (l, i) => `<tr class="align-top">
        <td class="py-2 pr-2 min-w-64"><input data-lookup="transfer-product" data-line="${i}" autocomplete="off" role="combobox" aria-autocomplete="list" value="${esc(l.product?.display_name ?? "")}" placeholder="Cari produk yang dilacak stoknya..." class="${INPUT}"></td>
        <td class="py-2 px-2 w-36"><input type="number" min="0" step="any" data-transfer-line="${i}" value="${esc(l.qty)}" class="${INPUT} text-right"></td>
        <td class="py-2 pl-2 w-10 text-center"><button type="button" data-action="remove-transfer-line" data-line="${i}" class="text-gray-400 hover:text-rose-600 mt-2" aria-label="Hapus baris"><i class="fas fa-trash-alt"></i></button></td></tr>`,
    )
    .join("");
  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/transfer" class="hover:text-indigo-600">Transfer Internal</a> / Baru</div>
    <h1 class="text-2xl font-bold text-gray-900 mb-3">Transfer Baru</h1>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-3 gap-x-8 gap-y-4">
      ${fieldBlock("Tipe Operasi", `<select data-transfer="type" class="${INPUT}">${selectOptions(r.types, form.type)}</select>`)}
      ${fieldBlock("Dari Lokasi", `<select data-transfer="src" class="${INPUT}">${selectOptions(r.locations, form.src)}</select>`)}
      ${fieldBlock("Ke Lokasi", `<select data-transfer="dest" class="${INPUT}">${selectOptions(r.locations, form.dest, "-")}</select>`)}
    </section>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 p-4 overflow-x-auto">
      <div class="text-sm font-semibold mb-3">Barang</div>
      <table class="w-full text-left"><thead><tr>${["Produk", "Jumlah", ""].map((h, i) => `<th class="pb-2 px-2 text-xs font-semibold text-gray-600 uppercase ${i === 1 ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>
      <button type="button" data-action="add-transfer-line" class="mt-1 text-sm text-indigo-600 font-medium hover:text-indigo-800"><i class="fas fa-plus mr-1"></i>Tambah baris</button>
    </section>
    <div class="flex gap-2 mt-4"><button data-action="save-transfer" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Simpan dan Tandai To-Do</button>
      <a href="#/transfer" data-action="discard-transfer" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Buang</a></div>`;
}

async function save() {
  if (!form.dest) throw new Error("Pilih lokasi tujuan.");
  if (form.src === form.dest) throw new Error("Lokasi asal dan tujuan tidak boleh sama.");
  const lines = form.lines.filter((l) => l.product || String(l.qty).trim() !== "");
  if (!lines.length) throw new Error("Tambahkan minimal satu barang.");
  const moves = lines.map((l, i) => {
    if (!l.product) throw new Error(`Baris ${i + 1}: pilih produk dari kotak saran.`);
    const qty = Number(l.qty);
    if (!(qty > 0)) throw new Error(`Baris ${i + 1}: jumlah harus lebih dari 0.`);
    return [0, 0, { product_id: l.product.id, product_uom_qty: qty, location_id: form.src, location_dest_id: form.dest }];
  });
  const [id] = await call("stock.picking", "create", { vals_list: [{ picking_type_id: form.type, location_id: form.src, location_dest_id: form.dest, move_ids: moves }] });
  await call("stock.picking", "action_confirm", { ids: [id] });
  return id;
}

export async function onClick(event, el) {
  const { action } = el.dataset;
  if (action === "discard-transfer") form = null;
  else if (action === "add-transfer-line") {
    form.lines.push({ product: null, qty: "" });
    await renderNew();
  } else if (action === "remove-transfer-line") {
    form.lines.splice(Number(el.dataset.line), 1);
    if (!form.lines.length) form.lines.push({ product: null, qty: "" });
    await renderNew();
  } else if (action === "save-transfer") {
    const id = await guarded(el, save);
    if (id) {
      form = null;
      toast("Transfer dibuat.");
      location.hash = `#/transfer/${id}`;
    }
  } else await base.onClick(event, el);
}

export function onInput(event, el) {
  if (form && el.dataset.transfer) form[el.dataset.transfer] = Number(el.value) || null;
  else if (form && el.dataset.transferLine !== undefined) form.lines[Number(el.dataset.transferLine)].qty = el.value;
  else if (form && el.dataset.lookup === "transfer-product") {
    form.lines[Number(el.dataset.line)].product = null;
    runLookup(el, 250);
  } else base.onInput(event, el);
}
