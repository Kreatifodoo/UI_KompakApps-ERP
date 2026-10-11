// Pricelist Master (product.pricelist) untuk penjualan dan POS. Berbeda dengan Pricelist Master pembelian (harga vendor):
// ini daftar harga jual pelanggan dengan aturan per produk, kategori, atau semua produk, dengan jumlah minimum, periode,
// dan cara hitung (diskon persen, harga tetap, atau rumus dari harga jual atau biaya).
import {
  INPUT, app, badge, button, call, cell, changedValues, chatterHtml, closeLookup, ctx, esc, fieldBlock, filterSelect, fromInputDateTime, guarded, hasGroup, loadMessages, money,
  pageHeader, readOne, referenceCategories, referenceCurrencies, registerLookup, resetReferences, rowLink, runLookup, searchBox, searchRead, selectOptions, statTiles, table,
  toInputDateTime, toast,
} from "../common.js";

const APPLIED = { "3_global": "Semua produk", "2_product_category": "Kategori produk", "1_product": "Produk" };
const COMPUTE = { percentage: "Diskon (%)", fixed: "Harga tetap", formula: "Rumus" };
const BASES = { list_price: "Harga jual", standard_price: "Biaya" };
const FILTERS = [["active", "Aktif"], ["archived", "Diarsipkan"]];
const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 });

let form = null; // { id, values, initial, items, removed }
let categories = [];
let last = { sub: "", query: new URLSearchParams() };
export const leave = () => {
  form = null;
};
const reload = () => render(last.sub, last.query);

registerLookup("sp-product", {
  search: (q) => searchRead("product.template", [["sale_ok", "=", true], ...(q ? ["|", ["name", "ilike", q], ["default_code", "ilike", q]] : [])], ["display_name", "list_price"], { limit: 10, order: "name" }),
  sub: (r) => money(r.list_price),
  isChosen: (input) => {
    const item = form?.items[Number(input.dataset.row)];
    return Boolean(item?.product) && item.productText === input.value;
  },
  choose: (input, product) => {
    const item = form.items[Number(input.dataset.row)];
    Object.assign(item, { product, productText: product.display_name });
    input.value = product.display_name;
  },
});

export async function render(sub, query) {
  last = { sub, query };
  if (sub === "") return renderList(query);
  return renderForm(sub === "new" ? null : Number(sub));
}

async function renderList(query) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const filter = query.get("state") || "active";
  const text = query.get("q") ?? "";
  const domain = filter === "archived" ? [["active", "=", false]] : [];
  if (text) domain.push(["name", "ilike", text]);
  const [rows, enabled] = await Promise.all([
    searchRead("product.pricelist", domain, ["name", "currency_id", "item_ids", "active"], { order: "sequence, name", limit: 100, context: { active_test: filter === "active" } }),
    hasGroup("product.group_product_pricelist"),
  ]);
  const body = rows
    .map((r) =>
      rowLink(`#/salespricelist/${r.id}`, [
        cell(r.name, { strong: true }),
        cell(r.currency_id?.[1] ?? ""),
        cell(String(r.item_ids.length), { right: true }),
        cell(r.active ? "" : badge({ archived: ["Diarsipkan", "muted"] }, "archived"), { raw: true }),
      ]),
    )
    .join("");
  app.innerHTML =
    pageHeader(
      "Pricelist Master (Penjualan)",
      `${searchBox(text, "Cari daftar harga")}${filterSelect(FILTERS, filter)}
       <a href="#/salespricelist/new" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"><i class="fas fa-plus mr-2"></i>Daftar Harga Baru</a>`,
    ) +
    (enabled ? "" : `<div class="mb-4 text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 flex flex-wrap items-center gap-3"><span>Fitur daftar harga belum aktif, jadi Sales Order memakai harga jual produk.</span>
      <button data-action="enable-pricelists" class="px-3 py-1 bg-white border border-amber-300 rounded-lg hover:bg-amber-100">Aktifkan Daftar Harga</button></div>`) +
    table([{ label: "Daftar Harga" }, { label: "Mata Uang" }, { label: "Aturan", right: true }, { label: "" }], body, "Belum ada daftar harga. Buat dengan tombol Daftar Harga Baru.") +
    '<p class="text-xs text-gray-500 mt-3">Harga beli dari vendor diatur di <a href="#/pricelist" class="underline">Pricelist Master pembelian</a>.</p>';
}

const emptyItem = () => ({ id: null, applied: "3_global", categ: null, product: null, productText: "", min: 0, compute: "percentage", percent: 10, fixed: 0, discount: 0, surcharge: 0, base: "list_price", start: "", end: "", initial: null });

const rowKeys = ["applied", "categ", "min", "compute", "percent", "fixed", "discount", "surcharge", "base", "start", "end"];

function itemsTable() {
  const rows = form.items
    .map((it, i) => {
      const target =
        it.applied === "2_product_category"
          ? `<select data-item="${i}" data-f="categ" class="${INPUT}" aria-label="Kategori">${selectOptions(categories, it.categ, "Pilih kategori...")}</select>`
          : it.applied === "1_product"
            ? `<input data-lookup="sp-product" autocomplete="off" role="combobox" aria-autocomplete="list" data-item="${i}" data-row="${i}" data-f="productText" value="${esc(it.productText)}" placeholder="Cari produk..." class="${INPUT}" aria-label="Produk">`
            : '<span class="text-sm text-gray-400">-</span>';
      const value =
        it.compute === "percentage"
          ? `<input type="number" min="0" max="100" step="any" data-item="${i}" data-f="percent" value="${esc(it.percent)}" class="${INPUT} text-right" aria-label="Diskon persen">`
          : it.compute === "fixed"
            ? `<input type="number" min="0" step="any" data-item="${i}" data-f="fixed" value="${esc(it.fixed)}" class="${INPUT} text-right" aria-label="Harga tetap">`
            : `<div class="flex gap-1"><select data-item="${i}" data-f="base" class="${INPUT} w-28" aria-label="Dasar">${Object.entries(BASES).map(([k, l]) => `<option value="${k}" ${k === it.base ? "selected" : ""}>${l}</option>`).join("")}</select>
                <input type="number" step="any" data-item="${i}" data-f="discount" value="${esc(it.discount)}" class="${INPUT} w-20 text-right" placeholder="% diskon" aria-label="Diskon persen">
                <input type="number" step="any" data-item="${i}" data-f="surcharge" value="${esc(it.surcharge)}" class="${INPUT} w-24 text-right" placeholder="tambahan" aria-label="Biaya tambahan"></div>`;
      return `<tr class="align-top">
        <td class="py-2 pr-2 w-40"><select data-item="${i}" data-f="applied" class="${INPUT}" aria-label="Berlaku untuk">${Object.entries(APPLIED).map(([k, l]) => `<option value="${k}" ${k === it.applied ? "selected" : ""}>${l}</option>`).join("")}</select></td>
        <td class="py-2 px-2 min-w-48">${target}</td>
        <td class="py-2 px-2 w-24"><input type="number" min="0" step="any" data-item="${i}" data-f="min" value="${esc(it.min)}" class="${INPUT} text-right" aria-label="Jumlah minimum"></td>
        <td class="py-2 px-2 w-36"><select data-item="${i}" data-f="compute" class="${INPUT}" aria-label="Cara hitung">${Object.entries(COMPUTE).map(([k, l]) => `<option value="${k}" ${k === it.compute ? "selected" : ""}>${l}</option>`).join("")}</select></td>
        <td class="py-2 px-2 min-w-40">${value}</td>
        <td class="py-2 px-2 w-44"><input type="datetime-local" data-item="${i}" data-f="start" value="${esc(it.start)}" class="${INPUT}" aria-label="Mulai"></td>
        <td class="py-2 px-2 w-44"><input type="datetime-local" data-item="${i}" data-f="end" value="${esc(it.end)}" class="${INPUT}" aria-label="Sampai"></td>
        <td class="py-2 pl-2 w-10 text-center"><button type="button" data-action="item-remove" data-i="${i}" class="text-gray-400 hover:text-rose-600 mt-2" aria-label="Hapus aturan"><i class="fas fa-trash-alt"></i></button></td></tr>`;
    })
    .join("");
  return `<table class="w-full text-left"><thead><tr>${["Berlaku untuk", "Target", "Jml Min", "Cara Hitung", "Nilai", "Mulai", "Sampai", ""].map((h, i) => `<th class="pb-2 px-2 text-xs font-semibold text-gray-600 uppercase ${i === 2 ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>
    <tbody>${rows}</tbody></table>
    <button type="button" data-action="item-add" class="mt-1 text-sm text-indigo-600 font-medium hover:text-indigo-800"><i class="fas fa-plus mr-1"></i>Tambah aturan</button>`;
}

const paintItems = () => {
  const box = document.querySelector("#items-box");
  if (box) box.innerHTML = itemsTable();
};

async function renderForm(id) {
  closeLookup();
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const [currencies, cats] = await Promise.all([referenceCurrencies(), referenceCategories()]);
  categories = cats;
  let list = null;
  if (id) {
    list = await readOne("product.pricelist", id, ["name", "currency_id", "active", "item_ids"]);
    if (!list) {
      app.innerHTML = '<p class="text-sm text-rose-600">Daftar harga tidak ditemukan.</p>';
      return;
    }
  }
  if (!form || form.id !== (list?.id ?? null)) {
    let items = [];
    if (list && list.item_ids.length) {
      const rows = await searchRead(
        "product.pricelist.item", [["id", "in", list.item_ids]],
        ["applied_on", "categ_id", "product_tmpl_id", "min_quantity", "compute_price", "percent_price", "fixed_price", "price_discount", "price_surcharge", "base", "date_start", "date_end"], { order: "applied_on desc, id" },
      );
      items = rows.map((r) => {
        const it = {
          id: r.id, applied: r.applied_on in APPLIED ? r.applied_on : "1_product", categ: r.categ_id?.[0] ?? null, product: r.product_tmpl_id ? { id: r.product_tmpl_id[0], display_name: r.product_tmpl_id[1] } : null,
          productText: r.product_tmpl_id?.[1] ?? "", min: r.min_quantity, compute: r.compute_price, percent: r.percent_price, fixed: r.fixed_price, discount: r.price_discount, surcharge: r.price_surcharge,
          base: r.base in BASES ? r.base : "list_price", start: r.date_start ? toInputDateTime(r.date_start) : "", end: r.date_end ? toInputDateTime(r.date_end) : "",
        };
        it.initial = { ...it, product: it.product?.id ?? null };
        return it;
      });
    }
    const values = { name: list?.name ?? "", currency_id: list?.currency_id?.[0] ?? ctx.company?.currency_id?.[0] ?? currencies[0]?.id ?? null };
    form = { id: list?.id ?? null, values, initial: list ? { ...values } : null, items, removed: [] };
  }
  const v = form.values;
  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/salespricelist" class="hover:text-indigo-600">Pricelist Master (Penjualan)</a> / ${esc(list?.name ?? "Baru")}</div>
    <div class="flex flex-wrap items-center gap-2 mb-3">${list ? button("toggle-active", list.active ? "Arsipkan" : "Aktifkan Kembali", list.active ? "danger" : "primary", { id: list.id }) : ""}</div>
    ${list ? `<div class="flex flex-wrap gap-2 mb-4">${statTiles([{ count: list.item_ids.length, label: "Aturan", icon: "fa-tags", target: "items-box" }])}</div>` : ""}
    <h1 class="text-2xl font-bold text-gray-900 mb-3">${esc(list?.name ?? "Daftar Harga Baru")}</h1>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-2 gap-x-8 gap-y-4">
      ${fieldBlock("Nama", `<input data-pl="name" value="${esc(v.name)}" class="${INPUT}">`)}
      ${fieldBlock("Mata Uang", `<select data-pl="currency_id" data-kind="id" class="${INPUT}">${selectOptions(currencies, v.currency_id)}</select>`)}
    </section>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 p-4 overflow-x-auto"><div class="text-sm font-semibold mb-2">Aturan Harga</div>
      <div id="items-box">${itemsTable()}</div>
      <p class="text-xs text-gray-500 mt-2">Aturan yang paling spesifik dan jumlah minimum tertinggi yang terpenuhi dipakai lebih dulu: produk, lalu kategori, lalu semua produk. Kosongkan periode untuk berlaku selamanya.</p></section>
    <div class="flex gap-2 mt-4">
      <button data-action="save" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Simpan</button>
      <a href="#/salespricelist" data-action="discard" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Buang</a>
    </div>
    ${list ? chatterHtml("product.pricelist", list.id) : ""}`;
  if (list) loadMessages("product.pricelist", list.id);
}


function itemVals(it) {
  if (it.applied === "2_product_category" && !it.categ) throw new Error("Pilih kategori untuk aturan berbasis kategori.");
  if (it.applied === "1_product" && !it.product) throw new Error("Pilih produk dari kotak saran untuk aturan berbasis produk.");
  const min = Number(it.min) || 0;
  if (min < 0) throw new Error("Jumlah minimum tidak boleh negatif.");
  const vals = {
    applied_on: it.applied, min_quantity: min, compute_price: it.compute, date_start: it.start ? fromInputDateTime(it.start) : false, date_end: it.end ? fromInputDateTime(it.end) : false,
    categ_id: it.applied === "2_product_category" ? it.categ : false, product_tmpl_id: it.applied === "1_product" ? it.product.id : false,
  };
  if (it.compute === "percentage") {
    const p = Number(it.percent);
    if (!(p >= 0 && p <= 100)) throw new Error("Diskon harus antara 0 dan 100%.");
    vals.percent_price = p;
  } else if (it.compute === "fixed") {
    if (!(Number(it.fixed) >= 0)) throw new Error("Harga tetap tidak boleh negatif.");
    vals.fixed_price = Number(it.fixed);
  } else Object.assign(vals, { base: it.base, price_discount: Number(it.discount) || 0, price_surcharge: Number(it.surcharge) || 0 });
  if (it.start && it.end && it.end < it.start) throw new Error("Tanggal akhir aturan harus setelah tanggal mulai.");
  return vals;
}

async function persist() {
  const v = form.values;
  if (!v.name.trim()) throw new Error("Nama daftar harga wajib diisi.");
  if (!v.currency_id) throw new Error("Pilih mata uang.");
  const commands = [];
  for (const it of form.items) {
    const vals = itemVals(it);
    if (!it.id) commands.push([0, 0, vals]);
    else {
      const now = JSON.stringify(rowKeys.map((k) => it[k]).concat(it.product?.id ?? null));
      const before = JSON.stringify(rowKeys.map((k) => it.initial[k]).concat(it.initial.product));
      if (now !== before) commands.push([1, it.id, vals]);
    }
  }
  for (const rid of form.removed) commands.push([2, rid, 0]);
  if (!form.id) {
    const [id] = await call("product.pricelist", "create", { vals_list: [{ name: v.name.trim(), currency_id: v.currency_id, ...(commands.length ? { item_ids: commands } : {}) }] });
    return id;
  }
  const changed = changedValues(v, form.initial, Object.keys(v));
  const vals = {};
  if ("name" in changed) vals.name = v.name.trim();
  if ("currency_id" in changed) vals.currency_id = v.currency_id;
  if (commands.length) vals.item_ids = commands;
  if (Object.keys(vals).length) await call("product.pricelist", "write", { ids: [form.id], vals });
  return form.id;
}

export async function onClick(event, el) {
  const { action } = el.dataset;
  if (action === "discard") form = null;
  else if (action === "item-add") {
    form.items.push(emptyItem());
    paintItems();
  } else if (action === "item-remove") {
    const [removed] = form.items.splice(Number(el.dataset.i), 1);
    if (removed?.id) form.removed.push(removed.id);
    paintItems();
  } else if (action === "save") {
    const saved = await guarded(el, persist);
    if (saved) {
      const wasNew = !form.id;
      form = null;
      resetReferences();
      toast(wasNew ? "Daftar harga dibuat." : "Perubahan disimpan.");
      if (wasNew) location.hash = `#/salespricelist/${saved}`;
      else reload();
    }
  } else if (action === "toggle-active") {
    const archiving = el.textContent.trim() === "Arsipkan";
    if (archiving && !window.confirm("Arsipkan daftar harga ini?")) return;
    const ok = await guarded(el, () => call("product.pricelist", archiving ? "action_archive" : "action_unarchive", { ids: [Number(el.dataset.id)] }));
    if (ok !== undefined) {
      form = null;
      resetReferences();
      toast(archiving ? "Daftar harga diarsipkan." : "Daftar harga diaktifkan kembali.");
      location.hash = "#/salespricelist";
    }
  } else if (action === "enable-pricelists") {
    const ok = await guarded(el, async () => {
      const [sid] = await call("res.config.settings", "create", { vals_list: [{ group_product_pricelist: true }] });
      await call("res.config.settings", "execute", { ids: [sid] });
      return true;
    });
    if (ok) {
      resetReferences();
      toast("Fitur daftar harga diaktifkan.");
      reload();
    }
  }
}

export function onInput(event, el) {
  if (!form) return;
  if (el.dataset.pl) form.values[el.dataset.pl] = el.dataset.kind === "id" ? (el.value ? Number(el.value) : null) : el.value;
  else if (el.dataset.item !== undefined) {
    const it = form.items[Number(el.dataset.item)];
    const f = el.dataset.f;
    if (f === "categ") it.categ = el.value ? Number(el.value) : null;
    else it[f] = el.value;
    if (f === "productText") {
      it.product = null;
      runLookup(el, 250);
    } else if (f === "applied" || f === "compute") paintItems();
  }
}
