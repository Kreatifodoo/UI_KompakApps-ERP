// Product Category (product.category). Kategori menentukan pencatatan akuntansi produknya: metode biaya
// (standar/FIFO/rata-rata), valuasi persediaan (periodik/perpetual), akun pendapatan, beban, persediaan,
// dan selisih harga. Nilai ini yang menentukan akun yang didebit saat tagihan vendor diposting. Bila akun Barang Diterima dan Barang Terkirim Belum Ditagih
// terisi (metode biaya FIFO atau rata-rata), setiap penerimaan dan pengiriman juga dijurnal saat terjadi dengan akun kategori ini (D69).
import {
  ACCOUNT_TYPE_LABELS, INPUT, app, call, cell, changedValues, closeLookup, esc, fieldBlock, fieldValue, guarded, pageHeader, readOne, REMOVAL_HELP,
  referenceCategories, referenceJournals, referenceRemovals, removalNote, removalSelect, registerLookup, resetReferences, rowLink, runLookup,
  searchAccounts, searchBox, searchRead, selectOptions, statTiles, table, toast, button, attachmentsPendingHtml, chatterHtml, loadMessages,
} from "../common.js";
import { loadRouteChoices, routeBoxHtml, routeWarningsHtml } from "../routerules.js";

const COSTING = { standard: "Harga Standar", fifo: "FIFO", average: "Rata-rata Tertimbang (AVCO)" };
const VALUATION = { periodic: "Periodik (saat tutup periode)", real_time: "Perpetual (saat ditagih)" };
const ACCOUNT_FIELDS = {
  property_account_income_categ_id: { label: "Akun Pendapatan", types: ["income", "income_other"] },
  property_account_expense_categ_id: { label: "Akun Beban", types: ["expense", "expense_direct_cost", "expense_other"] },
  property_stock_valuation_account_id: { label: "Akun Persediaan (Valuasi Stok)", types: ["asset_current", "asset_non_current"] },
  kompakapps_stock_input_account_id: { label: "Akun Barang Diterima Belum Ditagih", types: ["liability_current", "liability_non_current", "asset_current"] },
  kompakapps_stock_output_account_id: { label: "Akun Barang Terkirim Belum Ditagih", types: ["asset_current", "liability_current"] },
  property_price_difference_account_id: { label: "Akun Selisih Harga", types: ["expense", "expense_direct_cost", "expense_other", "income_other"] },
};
const READ_FIELDS = [
  "name", "parent_id", "property_cost_method", "property_valuation", "property_stock_journal", "removal_strategy_id", "product_count", "route_ids", ...Object.keys(ACCOUNT_FIELDS),
];

const REMOVAL_NONE = "Tanpa pilihan, strategi mengikuti pengaturan lokasi gudang, dan bila kosong memakai FIFO. Pilihan di kategori mengalahkan pengaturan lokasi.";
let removalsCache = [];
let form = null; // { id, values, initial, pending: Set }
let last = { sub: "", query: new URLSearchParams() };

export const leave = () => {
  form = null;
};
const reload = () => render(last.sub, last.query);

const asRef = (value) => (Array.isArray(value) ? { id: value[0], display_name: value[1] } : null);
const normalize = (record) => ({
  name: record.name || "",
  parent_id: record.parent_id?.[0] ?? null,
  property_cost_method: record.property_cost_method || "standard",
  property_valuation: record.property_valuation || "periodic",
  property_stock_journal: record.property_stock_journal?.[0] ?? null,
  removal_strategy_id: record.removal_strategy_id?.[0] ?? null,
  route_ids: [...(record.route_ids ?? [])].sort((a, b) => a - b),
  ...Object.fromEntries(Object.keys(ACCOUNT_FIELDS).map((key) => [key, asRef(record[key])])),
});
const flat = (values) => ({ ...values, ...Object.fromEntries(Object.keys(ACCOUNT_FIELDS).map((key) => [key, values[key]?.id ?? null])) });

registerLookup("cat-account", {
  search: (q, input) => searchAccounts(q, ACCOUNT_FIELDS[input.dataset.key].types),
  sub: (r) => ACCOUNT_TYPE_LABELS[r.account_type] ?? "",
  isChosen: (input) => form?.values[input.dataset.key]?.display_name === input.value,
  choose: (input, item) => {
    form.values[input.dataset.key] = item;
    form.pending.delete(input.dataset.key);
    input.value = item.display_name;
    const note = document.querySelector("#journal-note");
    if (note) note.innerHTML = journalNote(form.values);
  },
});

export async function render(sub, query) {
  last = { sub, query };
  if (sub === "") return renderList(query);
  return renderForm(sub === "new" ? null : Number(sub));
}

async function renderList(query) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const text = query.get("q") ?? "";
  const rows = await searchRead(
    "product.category",
    text ? [["complete_name", "ilike", text]] : [],
    ["display_name", "property_cost_method", "property_valuation", "property_stock_valuation_account_id", "property_account_expense_categ_id", "product_count"],
    { order: "complete_name", limit: 100 },
  );
  const body = rows
    .map((r) =>
      rowLink(`#/category/${r.id}`, [
        cell(r.display_name, { strong: true }),
        cell(COSTING[r.property_cost_method] ?? r.property_cost_method),
        cell(VALUATION[r.property_valuation] ?? r.property_valuation),
        cell(r.property_stock_valuation_account_id?.[1] ?? "-"),
        cell(r.property_account_expense_categ_id?.[1] ?? "-"),
        cell(r.product_count, { right: true }),
      ]),
    )
    .join("");
  app.innerHTML =
    pageHeader(
      "Product Category",
      `${searchBox(text, "Cari kategori")}
       <button data-action="refresh" class="px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50" aria-label="Muat ulang"><i class="fas fa-rotate"></i></button>
       <a href="#/category/new" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"><i class="fas fa-plus mr-2"></i>Kategori Baru</a>`,
    ) +
    table(
      [{ label: "Kategori" }, { label: "Metode Biaya" }, { label: "Valuasi" }, { label: "Akun Persediaan" }, { label: "Akun Beban" }, { label: "Produk", right: true }],
      body,
      "Belum ada kategori produk.",
    );
}

/** Penjelasan jurnal yang tercipta menurut valuasi yang dipilih: inilah yang membuat pengaturan ini penting. */
function journalNote(v) {
  const name = (key, fallback) => esc(v[key]?.display_name ?? fallback);
  const stock = name("property_stock_valuation_account_id", "akun Persediaan");
  const expense = name("property_account_expense_categ_id", "akun Beban");
  const input = v.kompakapps_stock_input_account_id?.display_name;
  const output = v.kompakapps_stock_output_account_id?.display_name;
  if (v.property_valuation !== "real_time") {
    return `<b>Periodik:</b> tagihan vendor atas barang stok langsung mendebit <b>${expense}</b>. Persediaan baru disesuaikan lewat jurnal saat tutup periode.`;
  }
  if (v.property_cost_method !== "standard" && input && output) {
    return `<b>Perpetual, dijurnal pada setiap transaksi:</b> penerimaan Dr <b>${stock}</b>, Cr <b>${esc(input)}</b>; tagihan vendor Dr <b>${esc(input)}</b>, Cr Hutang Usaha. Pengiriman Dr <b>${esc(output)}</b>, Cr <b>${stock}</b>; faktur pelanggan Dr <b>${expense}</b> (HPP), Cr <b>${esc(output)}</b>. Stok opname, scrap, dan produksi memakai akun pada lokasi virtualnya. Jurnalnya masuk ke Jurnal Stok kategori ini.`;
  }
  return `<b>Perpetual saat ditagih:</b> tagihan vendor atas barang stok mendebit <b>${stock}</b>, bukan akun beban; faktur pelanggan mencatat HPP (Dr ${expense}, Cr ${stock}). Penerimaan dan pengiriman barang belum dijurnal. Untuk menjurnalnya saat terjadi, pilih metode FIFO atau rata-rata dan isi Akun Barang Diterima dan Barang Terkirim Belum Ditagih.`;
}

/** Rute yang bisa dipasang pada kategori dan rute turunan induknya (D81). */
async function routeContext(v) {
  const parent = v.parent_id ? await readOne("product.category", v.parent_id, ["total_route_ids"]) : null;
  const inherited = parent?.total_route_ids ?? [];
  return { choices: await loadRouteChoices("product_categ_selectable", v.route_ids, inherited), inherited };
}

async function renderForm(id) {
  closeLookup();
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const [categories, journals, removals] = await Promise.all([referenceCategories(), referenceJournals("general"), referenceRemovals()]);
  let category = null;
  if (id) {
    category = await readOne("product.category", id, READ_FIELDS);
    if (!category) {
      app.innerHTML = '<p class="text-sm text-rose-600">Kategori tidak ditemukan.</p>';
      return;
    }
  }
  if (!form || form.id !== (category?.id ?? null)) {
    const values = category ? normalize(category) : normalize({});
    form = { id: category?.id ?? null, values, initial: category ? flat(values) : null, pending: new Set() };
  }
  removalsCache = removals;
  const v = form.values;
  form.routeCtx = await routeContext(v);
  const accountInput = (key) =>
    fieldBlock(
      ACCOUNT_FIELDS[key].label,
      `<input data-lookup="cat-account" data-key="${key}" autocomplete="off" role="combobox" aria-autocomplete="list" value="${esc(v[key]?.display_name ?? "")}" placeholder="Cari kode atau nama akun..." class="${INPUT}">`,
    );
  const select = (key, options) =>
    `<select data-value="${key}" class="${INPUT}">${Object.entries(options).map(([k, label]) => `<option value="${k}" ${k === v[key] ? "selected" : ""}>${esc(label)}</option>`).join("")}</select>`;
  const title = category ? esc(category.name) : "Kategori Baru";

  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/category" class="hover:text-indigo-600">Product Category</a> / ${title}</div>
    ${category ? `<div class="flex flex-wrap gap-2 mb-4">${statTiles([{ count: category.product_count, label: "Produk", icon: "fa-box", href: `#/product?state=all&category=${category.id}` }])}</div>` : ""}
    <h1 class="text-2xl font-bold text-gray-900 mb-3">${title}</h1>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-2 gap-x-8 gap-y-4">
      ${fieldBlock("Nama Kategori", `<input data-value="name" value="${esc(v.name)}" class="${INPUT}">`)}
      ${fieldBlock("Kategori Induk", `<select data-value="parent_id" data-kind="id" class="${INPUT}">${selectOptions(categories.filter((c) => c.id !== form.id), v.parent_id, "-")}</select>`)}
      <div class="md:col-span-2 border-t border-gray-100 pt-4 text-sm font-semibold text-gray-700">Valuasi Persediaan</div>
      ${fieldBlock("Metode Biaya", select("property_cost_method", COSTING))}
      ${fieldBlock("Valuasi Persediaan", select("property_valuation", VALUATION))}
      <p class="md:col-span-2 text-sm text-sky-900 bg-sky-50 border border-sky-200 rounded-lg px-4 py-3" id="journal-note">${journalNote(v)}</p>
      <div class="md:col-span-2 border-t border-gray-100 pt-4 text-sm font-semibold text-gray-700">Pengeluaran Stok</div>
      ${fieldBlock("Strategi Pengeluaran", removalSelect(removals, v.removal_strategy_id, 'data-value="removal_strategy_id"', "Ikuti lokasi (bawaan: FIFO)"))}
      ${removalNote(removals, v.removal_strategy_id, "Tanpa pilihan, strategi mengikuti pengaturan lokasi gudang, dan bila kosong memakai FIFO. Pilihan di kategori mengalahkan pengaturan lokasi.")}
      <div class="md:col-span-2 border-t border-gray-100 pt-4 text-sm font-semibold text-gray-700">Akun</div>
      ${accountInput("property_account_income_categ_id")}
      ${accountInput("property_account_expense_categ_id")}
      ${accountInput("property_stock_valuation_account_id")}
      ${accountInput("kompakapps_stock_input_account_id")}
      ${accountInput("kompakapps_stock_output_account_id")}
      ${fieldBlock("Jurnal Stok", `<select data-value="property_stock_journal" data-kind="id" class="${INPUT}">${selectOptions(journals, v.property_stock_journal, "-")}</select>`)}
      ${accountInput("property_price_difference_account_id")}
      <div class="md:col-span-2 border-t border-gray-100 pt-4 text-sm font-semibold text-gray-700">Rute</div>
      <div class="md:col-span-2" id="route-box">${routeBoxHtml(form.routeCtx.choices, v.route_ids, { inherited: form.routeCtx.inherited, emptyHint: 'Belum ada rute yang dapat dipilih pada kategori. Buat atau aktifkan di <a href="#/route" class="underline">Routes</a> (centang "Kategori Produk").' })}
        <p class="text-xs text-gray-500 mt-2">Rute kategori berlaku untuk semua produk di kategori ini (dan subkategorinya) yang tidak punya rute sendiri, dan mengalahkan rute bawaan gudang. Kelola rute di <a href="#/route" class="underline">Routes</a>.</p>
        <div id="route-warn" class="space-y-2 mt-3">${routeWarningsHtml(form.routeCtx.choices, v.route_ids, { scope: "kategori" })}</div></div>
    </section>
    <div class="flex flex-wrap gap-2 mt-4">
      <button data-action="save" data-id="${category?.id ?? ""}" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Simpan</button>
      <a href="#/category" data-action="discard" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Buang</a>
      ${category && !category.product_count ? button("delete", "Hapus", "danger", { id: category.id }) : ""}
    </div>
    ${category ? chatterHtml("product.category", category.id) : attachmentsPendingHtml()}`;
  if (category) loadMessages("product.category", category.id);
}

async function persist() {
  const v = form.values;
  if (!String(v.name).trim()) throw new Error("Nama kategori wajib diisi.");
  if (form.pending.size) throw new Error("Pilih akun dari kotak saran, atau kosongkan isiannya.");
  if (v.property_valuation === "real_time" && !v.property_stock_valuation_account_id) {
    throw new Error("Valuasi perpetual membutuhkan Akun Persediaan.");
  }
  const current = flat(v);
  const keys = Object.keys(current);
  const toOdoo = (value, key) => (key === "route_ids" ? [[6, 0, value]] : value === "" || value === null ? false : value);
  if (!form.id) {
    const vals = Object.fromEntries(keys.filter((k) => current[k] !== null && current[k] !== "" && !(k === "route_ids" && !current[k].length)).map((k) => [k, k === "route_ids" ? toOdoo(current[k], k) : current[k]]));
    const [newId] = await call("product.category", "create", { vals_list: [vals] });
    return newId;
  }
  const changed = changedValues(current, form.initial, keys);
  const vals = Object.fromEntries(Object.entries(changed).map(([k, value]) => [k, toOdoo(value, k)]));
  if (Object.keys(vals).length) await call("product.category", "write", { ids: [form.id], vals });
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
      resetReferences(); // daftar kategori di form produk harus ikut berubah
      toast(wasNew ? "Kategori dibuat." : "Perubahan disimpan.");
      if (wasNew) location.hash = `#/category/${saved}`;
      else reload();
    }
  } else if (action === "delete") {
    if (!window.confirm("Hapus kategori ini?")) return;
    const ok = await guarded(el, () => call("product.category", "unlink", { ids: [id] }));
    if (ok !== undefined) {
      form = null;
      resetReferences();
      toast("Kategori dihapus.");
      location.hash = "#/category";
    }
  }
}

export function onInput(event, el) {
  if (!form) return;
  if (el.dataset.routeBox) {
    const id = Number(el.dataset.routeBox);
    form.values.route_ids = (el.checked ? [...new Set([...form.values.route_ids, id])] : form.values.route_ids.filter((x) => x !== id)).sort((a, b) => a - b);
    document.querySelector("#route-warn").innerHTML = routeWarningsHtml(form.routeCtx.choices, form.values.route_ids, { scope: "kategori" });
    return;
  }
  if (el.dataset.lookup === "cat-account") {
    const key = el.dataset.key;
    form.values[key] = null;
    if (el.value.trim()) form.pending.add(key);
    else form.pending.delete(key);
    runLookup(el, 250);
  } else if (el.dataset.value) form.values[el.dataset.value] = fieldValue(el);
}

export function onChange(event, el) {
  if (!form || !el.dataset.value) return;
  form.values[el.dataset.value] = fieldValue(el);
  const note = document.querySelector("#journal-note");
  if (note) note.innerHTML = journalNote(form.values);
  if (el.dataset.value === "removal_strategy_id") {
    const hit = removalsCache.find((r) => r.id === form.values.removal_strategy_id);
    document.querySelector("#removal-note").textContent = hit ? REMOVAL_HELP[hit.method] ?? "" : REMOVAL_NONE;
  }
}
