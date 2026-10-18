// Vendor Price list (product.supplierinfo). Form mengikuti form Odoo: pemasok, nama dan kode produk di
// pemasok, lead time, jumlah minimum, harga satuan, mata uang, diskon, dan masa berlaku. Harga di sini
// menentukan harga otomatis pada baris RFQ.
import {
  PRODUCT_PAGE, searchProducts,
  INPUT, app, call, cell, changedValues, ctx, dateText, esc, fieldBlock, fieldValue, guarded, money, pageHeader, readOne, referenceCurrencies,
  registerLookup, rowLink, runLookup, searchBox, searchRead, selectOptions, table, toast, button, closeLookup,
} from "../common.js";

const FIELDS = ["partner_id", "product_tmpl_id", "product_name", "product_code", "min_qty", "price", "discount", "currency_id", "date_start", "date_end", "delay"];
const VALUE_KEYS = ["product_name", "product_code", "min_qty", "price", "discount", "currency_id", "date_start", "date_end", "delay"];

let form = null; // { id, vendor, product, values, initial }
let last = { sub: "", query: new URLSearchParams() };

export const leave = () => {
  form = null;
};
const reload = () => render(last.sub, last.query);

registerLookup("pl-vendor", {
  search: (q) => searchRead("res.partner", q ? [["name", "ilike", q]] : [], ["display_name"], { limit: 10, order: "name" }),
  isChosen: (input) => form?.vendor?.display_name === input.value,
  choose: (input, item) => {
    form.vendor = item;
    input.value = item.display_name;
  },
});
registerLookup("pl-product", {
  pageSize: PRODUCT_PAGE,
  search: (q, _input, page) => searchProducts(q, page, { model: "product.template", domain: [["purchase_ok", "=", true]], fields: ["display_name", "uom_id"] }),
  sub: (r) => r.uom_id?.[1] ?? "",
  isChosen: (input) => form?.product?.display_name === input.value,
  choose: (input, item) => {
    form.product = item;
    input.value = item.display_name;
  },
});

export async function render(sub, query) {
  last = { sub, query };
  if (sub === "") return renderList(query);
  return renderForm(sub === "new" ? null : Number(sub), query);
}

async function renderList(query) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const text = query.get("q") ?? "";
  const partner = Number(query.get("partner")) || null;
  const product = Number(query.get("product")) || null;
  const domain = [];
  if (partner) domain.push(["partner_id", "=", partner]);
  if (product) domain.push(["product_tmpl_id", "=", product]);
  if (text) domain.push("|", "|", ["partner_id.name", "ilike", text], ["product_tmpl_id.name", "ilike", text], ["product_code", "ilike", text]);
  const rows = await searchRead("product.supplierinfo", domain, [...FIELDS], { order: "id desc", limit: 100 });
  const body = rows
    .map((r) =>
      rowLink(`#/pricelist/${r.id}`, [
        cell(r.partner_id?.[1] ?? "", { strong: true }),
        cell(r.product_tmpl_id?.[1] ?? ""),
        cell(r.product_code || "-"),
        cell(r.min_qty, { right: true }),
        cell(money(r.price, r.currency_id?.[1]), { right: true }),
        cell(r.discount ? `${r.discount}%` : "-", { right: true }),
        cell(r.date_start || r.date_end ? `${r.date_start ? dateText(r.date_start) : "…"} – ${r.date_end ? dateText(r.date_end) : "…"}` : "Selalu"),
        cell(`${r.delay} hari`, { right: true }),
      ]),
    )
    .join("");
  const filterNote = partner || product
    ? `<p class="text-sm text-gray-500 mb-3">Difilter ${partner ? "per pemasok" : "per produk"}. <a href="#/pricelist" class="text-indigo-600 hover:underline">Tampilkan semua</a></p>`
    : "";
  const newLink = `#/pricelist/new${product ? `?product=${product}` : partner ? `?partner=${partner}` : ""}`;
  app.innerHTML =
    pageHeader(
      "Vendor Price list",
      `${searchBox(text, "Cari pemasok, produk, kode")}
       <button data-action="refresh" class="px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50" aria-label="Muat ulang"><i class="fas fa-rotate"></i></button>
       <a href="${newLink}" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"><i class="fas fa-plus mr-2"></i>Harga Baru</a>`,
    ) +
    filterNote +
    table(
      [{ label: "Pemasok" }, { label: "Produk" }, { label: "Kode Pemasok" }, { label: "Jml Min", right: true }, { label: "Harga Satuan", right: true }, { label: "Diskon", right: true }, { label: "Berlaku" }, { label: "Lead Time", right: true }],
      body,
      "Belum ada harga vendor. Harga di sini dipakai otomatis saat RFQ dibuat.",
    );
}

async function renderForm(id, query) {
  closeLookup();
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const currencies = await referenceCurrencies();
  let record = null;
  if (id) {
    record = await readOne("product.supplierinfo", id, FIELDS);
    if (!record) {
      app.innerHTML = '<p class="text-sm text-rose-600">Harga vendor tidak ditemukan.</p>';
      return;
    }
  }
  if (!form || form.id !== (record?.id ?? null)) {
    if (record) {
      const values = {
        product_name: record.product_name || "", product_code: record.product_code || "", min_qty: record.min_qty, price: record.price,
        discount: record.discount, currency_id: record.currency_id?.[0] ?? null, date_start: record.date_start || "", date_end: record.date_end || "", delay: record.delay,
      };
      form = {
        id: record.id,
        vendor: { id: record.partner_id[0], display_name: record.partner_id[1] },
        product: { id: record.product_tmpl_id[0], display_name: record.product_tmpl_id[1] },
        values, initial: { ...values, partner_id: record.partner_id[0], product_tmpl_id: record.product_tmpl_id[0] },
      };
    } else {
      // Isian awal dari konteks: dibuka dari halaman produk atau pemasok.
      const presetProduct = Number(query?.get("product")) || null;
      const presetVendor = Number(query?.get("partner")) || null;
      const [product, vendor] = await Promise.all([
        presetProduct ? readOne("product.template", presetProduct, ["display_name"]) : null,
        presetVendor ? readOne("res.partner", presetVendor, ["display_name"]) : null,
      ]);
      form = {
        id: null,
        vendor: vendor ? { id: vendor.id, display_name: vendor.display_name } : null,
        product: product ? { id: product.id, display_name: product.display_name } : null,
        values: {
          product_name: "", product_code: "", min_qty: 1, price: 0, discount: 0, currency_id: ctx.company.currency_id?.[0] ?? null,
          date_start: "", date_end: "", delay: 1,
        },
        initial: null,
      };
    }
  }
  const v = form.values;
  const input = (key, type = "text", extra = "") => `<input type="${type}" data-value="${key}" ${type === "number" ? 'data-kind="number" step="any" min="0"' : ""} value="${esc(v[key])}" ${extra} class="${INPUT}">`;
  const links = record
    ? `<div class="mb-3 flex flex-wrap gap-3 text-sm">
         <a href="#/vendor/${record.partner_id[0]}" class="text-indigo-600 hover:underline">Buka pemasok</a>
         <a href="#/product/${record.product_tmpl_id[0]}" class="text-indigo-600 hover:underline">Buka produk</a>
         <a href="#/pricelist?product=${record.product_tmpl_id[0]}" class="text-indigo-600 hover:underline">Semua harga produk ini</a></div>`
    : "";

  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/pricelist" class="hover:text-indigo-600">Vendor Price list</a> / ${record ? esc(`${record.partner_id[1]} · ${record.product_tmpl_id[1]}`) : "Baru"}</div>
    <h1 class="text-2xl font-bold text-gray-900 mb-3">${record ? "Harga Vendor" : "Harga Vendor Baru"}</h1>
    ${links}
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-2 gap-x-8 gap-y-4">
      <div class="md:col-span-2 text-sm font-semibold text-gray-700">Pemasok</div>
      ${fieldBlock("Pemasok", `<input data-lookup="pl-vendor" autocomplete="off" role="combobox" aria-autocomplete="list" value="${esc(form.vendor?.display_name ?? "")}" placeholder="Cari atau pilih pemasok..." class="${INPUT}">`)}
      ${fieldBlock("Produk", `<input data-lookup="pl-product" autocomplete="off" role="combobox" aria-autocomplete="list" value="${esc(form.product?.display_name ?? "")}" placeholder="Cari atau pilih produk..." class="${INPUT}">`)}
      ${fieldBlock("Nama Produk di Pemasok", input("product_name"))}
      ${fieldBlock("Kode Produk di Pemasok", input("product_code"))}
      ${fieldBlock("Lead Time (hari)", input("delay", "number"))}
      <div class="md:col-span-2 border-t border-gray-100 pt-4 text-sm font-semibold text-gray-700">Harga</div>
      ${fieldBlock("Jumlah Minimum", input("min_qty", "number"))}
      ${fieldBlock("Harga Satuan", input("price", "number"))}
      ${fieldBlock("Mata Uang", `<select data-value="currency_id" data-kind="id" class="${INPUT}">${selectOptions(currencies, v.currency_id)}</select>`)}
      ${fieldBlock("Diskon (%)", input("discount", "number"))}
      ${fieldBlock("Mulai Berlaku", input("date_start", "date"))}
      ${fieldBlock("Berakhir", input("date_end", "date"))}
    </section>
    <div class="flex flex-wrap gap-2 mt-4">
      <button data-action="save" data-id="${record?.id ?? ""}" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Simpan</button>
      <a href="#/pricelist" data-action="discard" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Buang</a>
      ${record ? button("delete", "Hapus", "danger", { id: record.id }) : ""}
    </div>`;
}

async function persist() {
  if (!form.vendor) throw new Error("Pilih pemasok dari kotak saran.");
  if (!form.product) throw new Error("Pilih produk dari kotak saran.");
  const v = form.values;
  if (!(Number(v.min_qty) >= 0)) throw new Error("Jumlah minimum tidak boleh negatif.");
  if (!(Number(v.price) >= 0)) throw new Error("Harga satuan tidak boleh negatif.");
  if (!Number.isInteger(Number(v.delay)) || Number(v.delay) < 0) throw new Error("Lead time harus bilangan bulat, 0 atau lebih.");
  const toOdoo = (key, value) => (value === "" || value === null ? false : value);
  if (!form.id) {
    const vals = { partner_id: form.vendor.id, product_tmpl_id: form.product.id };
    for (const key of VALUE_KEYS) if (v[key] !== "" && v[key] !== null) vals[key] = v[key];
    const [newId] = await call("product.supplierinfo", "create", { vals_list: [vals] });
    return newId;
  }
  const current = { ...v, partner_id: form.vendor.id, product_tmpl_id: form.product.id };
  const changed = changedValues(current, form.initial, [...VALUE_KEYS, "partner_id", "product_tmpl_id"]);
  const vals = Object.fromEntries(Object.entries(changed).map(([k, value]) => [k, toOdoo(k, value)]));
  if (Object.keys(vals).length) await call("product.supplierinfo", "write", { ids: [form.id], vals });
  return form.id;
}

export async function onClick(event, el) {
  const { action } = el.dataset;
  const id = Number(el.dataset.id) || null;
  if (action === "refresh") reload();
  else if (action === "discard") form = null;
  else if (action === "save") {
    const saved = await guarded(el, persist);
    if (saved) {
      const wasNew = !form.id;
      form = null;
      toast(wasNew ? "Harga vendor dibuat." : "Perubahan disimpan.");
      if (wasNew) location.hash = `#/pricelist/${saved}`;
      else reload();
    }
  } else if (action === "delete") {
    if (!window.confirm("Hapus harga vendor ini? RFQ berikutnya tidak lagi memakai harga ini.")) return;
    const ok = await guarded(el, () => call("product.supplierinfo", "unlink", { ids: [id] }));
    if (ok !== undefined) {
      form = null;
      toast("Harga vendor dihapus.");
      location.hash = "#/pricelist";
    }
  }
}

export function onInput(event, el) {
  if (!form) return;
  if (el.dataset.value) form.values[el.dataset.value] = fieldValue(el);
  else if (el.dataset.lookup === "pl-vendor") {
    form.vendor = null;
    runLookup(el, 250);
  } else if (el.dataset.lookup === "pl-product") {
    form.product = null;
    runLookup(el, 250);
  }
}

export function onChange(event, el) {
  if (form && el.dataset.value) form.values[el.dataset.value] = fieldValue(el);
}
