// Physical Inventory (stock.quant mode inventaris): isi jumlah hasil hitung per produk dan lokasi, lalu terapkan
// untuk membuat penyesuaian stok. Penyesuaian dinilai pada pergerakan stok dan dijurnal ke akun Selisih Persediaan bila lokasi Inventory adjustment punya akun valuasi (D69).
import {
  INPUT, app, call, esc, guarded, pageHeader, registerLookup, runLookup, searchBox, searchRead, selectOptions, toast,
} from "../common.js";

const MODE = { inventory_mode: true };
const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 3 });

let last = { sub: "", query: new URLSearchParams() };
let counts = new Map(); // quant id -> teks hitungan
let draft = null; // { product, location, qty } untuk hitungan baru
let locations = null;
export const leave = () => {
  counts = new Map();
  draft = null;
};
const reload = () => render(last.sub, last.query);

registerLookup("count-product", {
  search: (q) => searchRead("product.product", [["is_storable", "=", true], ...(q ? ["|", ["name", "ilike", q], ["default_code", "ilike", q]] : [])], ["display_name", "uom_id", "tracking"], { limit: 10, order: "name" }),
  sub: (r) => (r.tracking === "lot" ? "Lot" : r.tracking === "serial" ? "Nomor seri" : r.uom_id?.[1] ?? ""),
  isChosen: (input) => draft?.product?.display_name === input.value,
  choose: (input, item) => {
    const changed = isTracked(draft.product) !== isTracked(item);
    draft.product = item;
    input.value = item.display_name;
    if (changed) reload(); // kolom lot hanya untuk produk berlacak
  },
});

const isTracked = (product) => Boolean(product?.tracking) && product.tracking !== "none";

export async function render(sub, query) {
  last = { sub, query };
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  locations ??= await searchRead("stock.location", [["usage", "=", "internal"]], ["display_name"], { order: "complete_name" });
  draft ??= { product: null, location: locations[0]?.id ?? null, qty: "", lot: "" };
  const text = query.get("q") ?? "";
  const domain = [["location_id.usage", "=", "internal"], ["product_id.is_storable", "=", true]];
  if (text) domain.push("|", ["product_id.name", "ilike", text], ["product_id.default_code", "ilike", text]);
  const quants = await searchRead(
    "stock.quant", domain,
    ["product_id", "location_id", "lot_id", "quantity", "reserved_quantity", "inventory_quantity", "inventory_quantity_set", "inventory_diff_quantity", "product_uom_id", "value"],
    { order: "product_id, location_id", limit: 300, context: MODE },
  );
  for (const q of quants) if (q.inventory_quantity_set && !counts.has(q.id)) counts.set(q.id, String(q.inventory_quantity));
  const rows = quants
    .map((q) => {
      const typed = counts.get(q.id) ?? "";
      const diff = typed === "" ? null : Number(typed) - q.quantity;
      return `<tr class="align-top">
        <td class="py-2 px-4 text-sm">${esc(q.product_id[1])}</td><td class="py-2 px-4 text-sm">${esc(q.location_id[1])}</td><td class="py-2 px-4 text-sm">${esc(q.lot_id?.[1] ?? "")}</td>
        <td class="py-2 px-4 text-sm text-right tabular-nums">${nf.format(q.quantity)} ${esc(q.product_uom_id?.[1] ?? "")}</td>
        <td class="py-2 px-4 w-36"><input type="number" step="any" min="0" data-count="${q.id}" data-onhand="${q.quantity}" value="${esc(typed)}" placeholder="dihitung" class="${INPUT} text-right" aria-label="Hitungan ${esc(q.product_id[1])}"></td>
        <td class="py-2 px-4 text-sm text-right tabular-nums ${diff === null ? "" : diff < 0 ? "text-rose-700" : diff > 0 ? "text-emerald-700" : ""}" id="diff-${q.id}">${diff === null ? "" : nf.format(diff)}</td>
        <td class="py-2 px-4 text-sm text-right"><button type="button" data-action="apply-count" data-id="${q.id}" class="px-3 py-1 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Terapkan</button></td></tr>`;
    })
    .join("");
  app.innerHTML =
    pageHeader(
      "Physical Inventory",
      `${searchBox(text, "Cari produk")}
       <button data-action="apply-all" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Terapkan Semua yang Dihitung</button>`,
    ) +
    `<div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto">
      <table class="w-full text-left" data-list="on"><thead class="bg-gray-50 border-b border-gray-200"><tr>${["Produk", "Lokasi", "Lot/Serial", "Tercatat", "Hasil Hitung", "Selisih", ""]
        .map((h, i) => `<th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase ${[3, 4, 5].includes(i) ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>
        <tbody class="divide-y divide-gray-100">${rows || '<tr><td colspan="7" class="py-10 text-center text-sm text-gray-500">Belum ada stok yang bisa dihitung. Tambahkan hitungan baru di bawah.</td></tr>'}</tbody></table>
    </div>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 p-4">
      <div class="text-sm font-semibold mb-3">Hitungan baru (produk belum tercatat di lokasi)</div>
      <form data-form="new-count" class="flex flex-wrap items-end gap-3">
        <label class="text-xs font-medium text-gray-500 uppercase">Produk<input data-lookup="count-product" autocomplete="off" role="combobox" aria-autocomplete="list" value="${esc(draft.product?.display_name ?? "")}" placeholder="Cari produk yang dilacak stoknya..." class="${INPUT} mt-1 w-72"></label>
        ${isTracked(draft.product) ? `<label class="text-xs font-medium text-gray-500 uppercase">${draft.product.tracking === "serial" ? "Nomor Seri" : "Lot"}<input data-new="lot" value="${esc(draft.lot)}" placeholder="Nomor ${draft.product.tracking === "serial" ? "seri" : "lot"}" class="${INPUT} mt-1 w-44"></label>` : ""}
        <label class="text-xs font-medium text-gray-500 uppercase">Lokasi<select data-new="location" class="${INPUT} mt-1 w-56">${selectOptions(locations, draft.location)}</select></label>
        <label class="text-xs font-medium text-gray-500 uppercase">Jumlah<input type="number" min="0" step="any" data-new="qty" value="${esc(draft.qty)}" class="${INPUT} mt-1 w-32 text-right"></label>
        <button type="submit" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Tambah dan Terapkan</button>
      </form></section>
    <p class="text-xs text-gray-500 mt-3">Terapkan membuat pergerakan penyesuaian ke atau dari lokasi Inventory Loss dan mengubah stok. Nilai penyesuaian tercatat pada pergerakan stok; lihat selisihnya terhadap buku besar di Laporan Stok.</p>`;
}

async function apply(ids) {
  const entries = ids.filter((id) => counts.get(id) !== undefined && counts.get(id) !== "");
  if (!entries.length) throw new Error("Isi hasil hitung lebih dulu.");
  for (const id of entries) {
    const qty = Number(counts.get(id));
    if (!(qty >= 0)) throw new Error("Hasil hitung tidak boleh negatif.");
    await call("stock.quant", "write", { ids: [id], vals: { inventory_quantity: qty }, context: MODE });
  }
  await call("stock.quant", "action_apply_inventory", { ids: entries, context: MODE });
  for (const id of entries) counts.delete(id);
  return entries.length;
}

export async function onClick(event, el) {
  const { action } = el.dataset;
  if (action === "apply-count") {
    const done = await guarded(el, () => apply([Number(el.dataset.id)]));
    if (done) {
      toast("Penyesuaian stok diterapkan.");
      reload();
    }
  } else if (action === "apply-all") {
    const done = await guarded(el, () => apply([...counts.keys()]));
    if (done) {
      toast(`${done} penyesuaian stok diterapkan.`);
      reload();
    }
  }
}

export function onInput(event, el) {
  if (el.dataset.count) {
    counts.set(Number(el.dataset.count), el.value);
    const diff = el.value === "" ? "" : Number(el.value) - Number(el.dataset.onhand);
    const cell = document.getElementById(`diff-${el.dataset.count}`);
    if (cell) cell.textContent = diff === "" || Number.isNaN(diff) ? "" : nf.format(diff);
  } else if (el.dataset.new && draft) draft[el.dataset.new] = el.dataset.new === "location" ? Number(el.value) : el.value;
  else if (el.dataset.lookup === "count-product" && draft) {
    draft.product = null;
    runLookup(el, 250);
  }
}

export async function onSubmit(event, formEl, kind) {
  if (kind !== "new-count") return;
  const done = await guarded(null, async () => {
    if (!draft.product) throw new Error("Pilih produk dari kotak saran.");
    const qty = Number(draft.qty);
    if (!(qty > 0)) throw new Error("Isi jumlah lebih dari 0.");
    const vals = { product_id: draft.product.id, location_id: draft.location, inventory_quantity: qty };
    if (isTracked(draft.product)) {
      const name = draft.lot.trim();
      if (!name) throw new Error(`Isi ${draft.product.tracking === "serial" ? "nomor seri" : "nomor lot"} untuk produk ini.`);
      if (draft.product.tracking === "serial" && qty !== 1) throw new Error("Satu nomor seri hanya untuk satu unit.");
      const [found] = await searchRead("stock.lot", [["product_id", "=", draft.product.id], ["name", "=", name]], ["id"], { limit: 1 });
      vals.lot_id = found ? found.id : (await call("stock.lot", "create", { vals_list: [{ name, product_id: draft.product.id }] }))[0];
    }
    const [id] = await call("stock.quant", "create", { vals_list: [vals], context: MODE });
    await call("stock.quant", "action_apply_inventory", { ids: [id], context: MODE });
    return true;
  });
  if (done) {
    draft = null;
    toast("Hitungan baru diterapkan.");
    reload();
  }
}
