// Put away Rules (stock.putaway.rule): menentukan ke lokasi mana barang disimpan saat diterima, per produk atau
// per kategori produk. Aturan dengan urutan terkecil yang cocok dipakai lebih dulu.
import {
  INPUT, app, call, cell, esc, fieldBlock, guarded, pageHeader, readOne, referenceCategories, registerLookup, rowLink, runLookup, searchRead, selectOptions, table,
  toast, button,
} from "../common.js";

let form = null; // { id, product, category, from, to, sequence }
let locations = null;
let last = { sub: "", query: new URLSearchParams() };
export const leave = () => {
  form = null;
};
const reload = () => render(last.sub, last.query);

registerLookup("putaway-product", {
  search: (q) => searchRead("product.product", q ? ["|", ["name", "ilike", q], ["default_code", "ilike", q]] : [], ["display_name"], { limit: 10, order: "name" }),
  isChosen: (input) => form?.product?.display_name === input.value,
  choose: (input, item) => {
    form.product = item;
    input.value = item.display_name;
  },
});

export async function render(sub, query) {
  last = { sub, query };
  locations ??= await searchRead("stock.location", [["usage", "in", ["internal", "view"]]], ["display_name"], { order: "complete_name" });
  if (sub === "") return renderList();
  return renderForm(sub === "new" ? null : Number(sub));
}

async function renderList() {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const rows = await searchRead("stock.putaway.rule", [], ["sequence", "product_id", "category_id", "location_in_id", "location_out_id"], { order: "sequence, id", limit: 200 });
  const body = rows
    .map((r) => rowLink(`#/putaway/${r.id}`, [cell(r.sequence, { right: true }), cell(r.product_id?.[1] || r.category_id?.[1] || "-", { strong: true }), cell(r.product_id ? "Produk" : "Kategori"), cell(r.location_in_id[1]), cell(r.location_out_id[1])]))
    .join("");
  app.innerHTML =
    pageHeader("Put away Rules", '<a href="#/putaway/new" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"><i class="fas fa-plus mr-2"></i>Aturan Baru</a>') +
    table([{ label: "Urutan", right: true }, { label: "Produk atau Kategori" }, { label: "Berlaku untuk" }, { label: "Saat masuk ke" }, { label: "Simpan di" }], body, "Belum ada aturan penyimpanan. Tanpa aturan, barang disimpan di lokasi tujuan penerimaan.");
}

async function renderForm(id) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const categories = await referenceCategories();
  let rule = null;
  if (id) {
    rule = await readOne("stock.putaway.rule", id, ["sequence", "product_id", "category_id", "location_in_id", "location_out_id"]);
    if (!rule) {
      app.innerHTML = '<p class="text-sm text-rose-600">Aturan tidak ditemukan.</p>';
      return;
    }
  }
  if (!form || form.id !== (rule?.id ?? null)) {
    form = rule
      ? { id: rule.id, product: rule.product_id ? { id: rule.product_id[0], display_name: rule.product_id[1] } : null, category: rule.category_id?.[0] ?? null, from: rule.location_in_id[0], to: rule.location_out_id[0], sequence: rule.sequence }
      : { id: null, product: null, category: null, from: locations[0]?.id ?? null, to: locations[0]?.id ?? null, sequence: 10 };
  }
  const f = form;
  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/putaway" class="hover:text-indigo-600">Put away Rules</a> / ${rule ? `#${rule.id}` : "Baru"}</div>
    <div class="flex flex-wrap gap-2 mb-3">${rule ? button("delete", "Hapus", "danger", { id: rule.id }) : ""}</div>
    <h1 class="text-2xl font-bold text-gray-900 mb-3">${rule ? "Aturan Penyimpanan" : "Aturan Baru"}</h1>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-2 gap-x-8 gap-y-4">
      ${fieldBlock("Produk (kosongkan bila per kategori)", `<input data-lookup="putaway-product" autocomplete="off" role="combobox" aria-autocomplete="list" value="${esc(f.product?.display_name ?? "")}" placeholder="Cari produk..." class="${INPUT}">`)}
      ${fieldBlock("Kategori Produk", `<select data-pa="category" class="${INPUT}">${selectOptions(categories, f.category, "-")}</select>`)}
      ${fieldBlock("Saat Masuk ke Lokasi", `<select data-pa="from" class="${INPUT}">${selectOptions(locations, f.from)}</select>`)}
      ${fieldBlock("Simpan di Lokasi", `<select data-pa="to" class="${INPUT}">${selectOptions(locations, f.to)}</select>`)}
      ${fieldBlock("Urutan", `<input type="number" step="1" data-pa="sequence" value="${esc(f.sequence)}" class="${INPUT} text-right">`)}
    </section>
    <div class="flex gap-2 mt-4"><button data-action="save" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Simpan</button>
      <a href="#/putaway" data-action="discard" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Buang</a></div>`;
}

async function persist() {
  const f = form;
  if (!f.product && !f.category) throw new Error("Pilih produk atau kategori produk.");
  if (f.product && f.category) throw new Error("Isi produk atau kategori, jangan keduanya.");
  const vals = { product_id: f.product?.id ?? false, category_id: f.category || false, location_in_id: f.from, location_out_id: f.to, sequence: Number(f.sequence) || 0 };
  if (f.id) {
    await call("stock.putaway.rule", "write", { ids: [f.id], vals });
    return f.id;
  }
  const [id] = await call("stock.putaway.rule", "create", { vals_list: [vals] });
  return id;
}

export async function onClick(event, el) {
  const { action } = el.dataset;
  if (action === "discard") form = null;
  else if (action === "save") {
    const saved = await guarded(el, persist);
    if (saved) {
      const wasNew = !form.id;
      form = null;
      toast(wasNew ? "Aturan dibuat." : "Perubahan disimpan.");
      if (wasNew) location.hash = `#/putaway/${saved}`;
      else reload();
    }
  } else if (action === "delete") {
    if (!window.confirm("Hapus aturan penyimpanan ini?")) return;
    const ok = await guarded(el, () => call("stock.putaway.rule", "unlink", { ids: [Number(el.dataset.id)] }));
    if (ok !== undefined) {
      form = null;
      toast("Aturan dihapus.");
      location.hash = "#/putaway";
    }
  }
}

export function onInput(event, el) {
  if (!form) return;
  if (el.dataset.pa) form[el.dataset.pa] = el.dataset.pa === "sequence" ? el.value : Number(el.value) || null;
  else if (el.dataset.lookup === "putaway-product") {
    form.product = null;
    runLookup(el, 250);
  }
}
