// Lot & Serial Number Master (stock.lot). Satu lot adalah satu nomor batch (atau satu nomor seri) milik satu produk.
// Detail menampilkan stok per lokasi dan riwayat pergerakan (penelusuran dari penerimaan sampai pengiriman), serta
// tanggal kedaluwarsa bila produk memakainya (modul product_expiry).
import {
  PRODUCT_PAGE, searchProducts,
  INPUT, app, badge, call, cell, changedValues, dateText, dateTimeText, esc, fieldBlock, filterSelect, fromInputDateTime, guarded, hasGroup,
  pageHeader, parseOdooDate, plain, readOne, readonlyValue, registerLookup, rowLink, runLookup, searchBox, searchRead, statTiles, table, toast,
  toInputDateTime, chatterHtml, loadMessages,
} from "../common.js";

const FILTERS = [["stock", "Ada stok"], ["all", "Semua lot"], ["expired", "Sudah kedaluwarsa"], ["alert", "Perlu perhatian"]];
const TRACKING = { lot: "Lot", serial: "Nomor seri" };
const MOVE_ROUTE = { incoming: "receipt", outgoing: "delivery", internal: "transfer" };
const DATE_KEYS = ["expiration_date", "use_date", "removal_date", "alert_date"];
const DATE_LABELS = { expiration_date: "Kedaluwarsa", use_date: "Terbaik Sebelum", removal_date: "Ditarik dari Stok", alert_date: "Peringatan" };
const FIELDS = ["name", "product_id", "ref", "note", "product_qty", "product_uom_id", "location_id", "delivery_count", "delivery_ids", "purchase_order_count", "purchase_order_ids", "sale_order_count", "sale_order_ids", ...DATE_KEYS];
const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 3 });
const EXPIRY = { expired: ["Kedaluwarsa", "danger"], alert: ["Perlu perhatian", "warning"] };

let form = null; // { id, values, initial, product }
let last = { sub: "", query: new URLSearchParams() };
export const leave = () => {
  form = null;
};
const reload = () => render(last.sub, last.query);

registerLookup("lot-product", {
  pageSize: PRODUCT_PAGE,
  search: (q, _input, page) =>
    searchProducts(q, page, { domain: [["is_storable", "=", true], ["tracking", "!=", "none"]], fields: ["display_name", "tracking", "uom_id", "use_expiration_date"] }),
  sub: (r) => TRACKING[r.tracking] ?? "",
  isChosen: (input) => form?.product?.display_name === input.value,
  choose: (input, item) => {
    form.product = item;
    input.value = item.display_name;
    reload(); // bagian tanggal kedaluwarsa bergantung pada produk
  },
});

/** Kedaluwarsa menurut tanggal lot: lewat tanggal = kedaluwarsa; alert_date terlewati = perlu perhatian. Lot tanpa stok tidak ditandai. */
function expiryState(lot) {
  if (!(lot.product_qty > 0)) return null;
  const now = new Date();
  if (lot.expiration_date && parseOdooDate(lot.expiration_date) < now) return "expired";
  if (lot.alert_date && parseOdooDate(lot.alert_date) < now) return "alert";
  return null;
}

export async function render(sub, query) {
  last = { sub, query };
  if (sub === "") return renderList(query);
  return renderForm(sub === "new" ? null : Number(sub));
}

const disabledNote = (on) =>
  on
    ? ""
    : `<p class="mb-4 text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">Fitur Lots & Serial Numbers belum aktif, jadi produk belum bisa dilacak per lot.
       Aktifkan di <a href="#/warehouse" class="underline">Warehouse & Location Master</a> (bagian Fitur gudang).</p>`;

async function renderList(query) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const filter = query.get("state") || "stock";
  const text = query.get("q") ?? "";
  const domain = [];
  const now = new Date();
  const nowText = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")} ${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}:00`;
  if (filter === "stock") domain.push(["product_qty", ">", 0]);
  else if (filter === "expired") domain.push(["expiration_date", "<", nowText], ["product_qty", ">", 0]);
  else if (filter === "alert") domain.push(["alert_date", "<", nowText], ["expiration_date", ">=", nowText], ["product_qty", ">", 0]);
  if (text) domain.push("|", "|", ["name", "ilike", text], ["ref", "ilike", text], ["product_id.name", "ilike", text]);
  const [rows, enabled] = await Promise.all([
    searchRead("stock.lot", domain, ["name", "product_id", "ref", "product_qty", "product_uom_id", "location_id", "expiration_date", "alert_date"], { order: "expiration_date, id desc", limit: 100 }),
    hasGroup("stock.group_production_lot"),
  ]);
  const body = rows
    .map((r) => {
      const state = expiryState(r);
      return rowLink(`#/lot/${r.id}`, [
        cell(r.name, { strong: true }),
        cell(r.product_id[1]),
        cell(r.ref || "-"),
        cell(`${nf.format(r.product_qty)} ${r.product_uom_id?.[1] ?? ""}`, { right: true }),
        cell(r.expiration_date ? dateText(r.expiration_date) : "-"),
        cell(state ? badge(EXPIRY, state) : "", { raw: true }),
      ]);
    })
    .join("");
  app.innerHTML =
    pageHeader(
      "Lot & Serial Number Master",
      `${searchBox(text, "Cari lot, produk, referensi")}${filterSelect(FILTERS, filter)}
       <a href="#/lot/new" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"><i class="fas fa-plus mr-2"></i>Lot Baru</a>`,
    ) +
    disabledNote(enabled) +
    table(
      [{ label: "Lot/Serial" }, { label: "Produk" }, { label: "Referensi" }, { label: "Stok", right: true }, { label: "Kedaluwarsa" }, { label: "Status" }],
      body,
      "Tidak ada lot yang cocok. Lot tercipta otomatis saat barang diterima dengan nomor lot, atau buat manual.",
    ) +
    `<p class="text-xs text-gray-500 mt-3">Atur pelacakan per produk (lot atau nomor seri) di <a href="#/product" class="underline">Product Master</a>. Nomor lot dimasukkan saat penerimaan barang.</p>`;
}

/** Stok per lokasi dan riwayat pergerakan lot. */
async function loadTrace(lotId) {
  const [quants, moveLines] = await Promise.all([
    searchRead("stock.quant", [["lot_id", "=", lotId], ["location_id.usage", "=", "internal"], ["quantity", "!=", 0]], ["location_id", "quantity", "reserved_quantity", "product_uom_id"], { order: "location_id" }),
    searchRead(
      "stock.move.line", [["lot_id", "=", lotId], ["state", "=", "done"]],
      ["date", "reference", "picking_id", "picking_code", "location_id", "location_dest_id", "quantity", "product_uom_id"], { order: "date, id", limit: 200 },
    ),
  ]);
  const partners = new Map();
  const pickingIds = [...new Set(moveLines.map((m) => m.picking_id?.[0]).filter(Boolean))];
  if (pickingIds.length) {
    for (const p of await searchRead("stock.picking", [["id", "in", pickingIds]], ["partner_id"])) partners.set(p.id, p.partner_id?.[1] ?? "");
  }
  return { quants, moveLines, partners };
}

function traceHtml({ quants, moveLines, partners }) {
  const onhand = quants
    .map((q) => `<tr><td class="py-2 px-4 text-sm">${esc(q.location_id[1])}</td><td class="py-2 px-4 text-sm text-right tabular-nums">${nf.format(q.quantity)} ${esc(q.product_uom_id?.[1] ?? "")}</td>
      <td class="py-2 px-4 text-sm text-right tabular-nums">${nf.format(q.reserved_quantity)}</td></tr>`)
    .join("");
  const history = moveLines
    .map((m) => {
      const route = MOVE_ROUTE[m.picking_code];
      const link = m.picking_id && route ? `<a href="#/${route}/${m.picking_id[0]}" class="text-indigo-700 hover:underline">${esc(m.reference || m.picking_id[1])}</a>` : esc(m.reference || "-");
      return `<tr><td class="py-2 px-4 text-sm">${esc(dateTimeText(m.date))}</td><td class="py-2 px-4 text-sm">${link}</td>
        <td class="py-2 px-4 text-sm">${esc(partners.get(m.picking_id?.[0]) ?? "")}</td>
        <td class="py-2 px-4 text-sm">${esc(m.location_id[1])} <i class="fas fa-arrow-right text-gray-400 mx-1"></i> ${esc(m.location_dest_id[1])}</td>
        <td class="py-2 px-4 text-sm text-right tabular-nums">${nf.format(m.quantity)} ${esc(m.product_uom_id?.[1] ?? "")}</td></tr>`;
    })
    .join("");
  const head = (labels, right = []) => `<thead class="bg-gray-50"><tr>${labels.map((h, i) => `<th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase ${right.includes(i) ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>`;
  return `<section class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 overflow-x-auto">
      <div class="px-4 py-3 border-b border-gray-200 text-sm font-semibold">Stok per Lokasi</div>
      <table class="w-full text-left">${head(["Lokasi", "Jumlah", "Dipesan"], [1, 2])}<tbody class="divide-y divide-gray-100">${onhand || '<tr><td colspan="3" class="py-6 text-center text-sm text-gray-500">Tidak ada stok lot ini di gudang.</td></tr>'}</tbody></table></section>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 overflow-x-auto">
      <div class="px-4 py-3 border-b border-gray-200 text-sm font-semibold">Riwayat Pergerakan (penelusuran)</div>
      <table class="w-full text-left">${head(["Tanggal", "Dokumen", "Mitra", "Pergerakan", "Jumlah"], [4])}<tbody class="divide-y divide-gray-100">${history || '<tr><td colspan="5" class="py-6 text-center text-sm text-gray-500">Belum ada pergerakan yang selesai.</td></tr>'}</tbody></table></section>`;
}

const normalize = (record) => ({
  name: record.name || "",
  ref: record.ref || "",
  note: plain(record.note),
  ...Object.fromEntries(DATE_KEYS.map((k) => [k, record[k] ? toInputDateTime(record[k]) : ""])),
});

async function renderForm(id) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  let lot = null;
  let trace = null;
  if (id) {
    lot = await readOne("stock.lot", id, FIELDS);
    if (!lot) {
      app.innerHTML = '<p class="text-sm text-rose-600">Lot tidak ditemukan.</p>';
      return;
    }
    trace = await loadTrace(id);
  }
  const enabled = await hasGroup("stock.group_production_lot");
  if (!form || form.id !== (lot?.id ?? null)) {
    const values = lot ? normalize(lot) : { name: "", ref: "", note: "", ...Object.fromEntries(DATE_KEYS.map((k) => [k, ""])) };
    form = { id: lot?.id ?? null, values, initial: lot ? { ...values } : null, product: null };
  }
  let product = form.product;
  if (lot && !product) {
    [product] = await searchRead("product.product", [["id", "=", lot.product_id[0]]], ["display_name", "tracking", "uom_id", "use_expiration_date"], { limit: 1 });
    form.product = product;
  }
  const v = form.values;
  const usesExpiry = Boolean(product?.use_expiration_date);
  const state = lot ? expiryState(lot) : null;
  const dates = usesExpiry
    ? `<div class="md:col-span-2 border-t border-gray-100 pt-4 text-sm font-semibold text-gray-700">Tanggal Kedaluwarsa</div>
       ${DATE_KEYS.map((k) => fieldBlock(DATE_LABELS[k], `<input type="datetime-local" data-lot="${k}" value="${esc(v[k])}" class="${INPUT}">`)).join("")}
       <p class="md:col-span-2 text-xs text-gray-500">Dikosongkan, Odoo menghitung tanggal dari pengaturan produk saat lot dibuat. Barang yang melewati tanggal penarikan diambil terakhir (FEFO).</p>`
    : "";
  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/lot" class="hover:text-indigo-600">Lot & Serial Number Master</a> / ${esc(lot?.name ?? "Baru")}</div>
    ${lot ? `<div class="flex flex-wrap gap-2 mb-4">${statTiles([
      { count: lot.product_qty, label: "Stok Tersedia", icon: "fa-boxes" },
      { count: lot.purchase_order_count, label: "Pembelian", icon: "fa-shopping-cart", href: `#/po?ids=${lot.purchase_order_ids.join(",")}` },
      { count: lot.sale_order_count, label: "Penjualan", icon: "fa-cart-shopping", href: `#/sale?ids=${lot.sale_order_ids.join(",")}` },
      { count: lot.delivery_count, label: "Pengiriman", icon: "fa-truck", href: `#/delivery?ids=${lot.delivery_ids.join(",")}` },
    ])}</div>` : ""}
    <div class="mb-3 flex items-center gap-3"><h1 class="text-2xl font-bold text-gray-900">${esc(lot?.name ?? "Lot Baru")}</h1>${state ? badge(EXPIRY, state) : ""}</div>
    ${disabledNote(enabled)}
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-2 gap-x-8 gap-y-4">
      ${fieldBlock("Lot/Serial", `<input data-lot="name" value="${esc(v.name)}" class="${INPUT}">`)}
      ${fieldBlock("Produk", lot
        ? readonlyValue(`${lot.product_id[1]}${product ? ` (${TRACKING[product.tracking] ?? product.tracking})` : ""}`)
        : `<input data-lookup="lot-product" autocomplete="off" role="combobox" aria-autocomplete="list" value="${esc(form.product?.display_name ?? "")}" placeholder="Cari produk yang dilacak lot atau seri..." class="${INPUT}">`)}
      ${fieldBlock("Referensi Internal", `<input data-lot="ref" value="${esc(v.ref)}" placeholder="mis. nomor batch pemasok" class="${INPUT}">`)}
      ${lot ? fieldBlock("Lokasi Terakhir", readonlyValue(lot.location_id?.[1] ?? "-")) : ""}
      <div class="md:col-span-2">${fieldBlock("Catatan", `<textarea data-lot="note" rows="2" class="${INPUT}">${esc(v.note)}</textarea>`)}</div>
      ${dates}
    </section>
    <div class="flex gap-2 mt-4">
      <button data-action="save" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Simpan</button>
      <a href="#/lot" data-action="discard" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Buang</a>
    </div>
    ${trace ? traceHtml(trace) : '<p class="mt-6 text-sm text-gray-500">Simpan lot terlebih dahulu untuk melihat stok dan riwayat pergerakannya.</p>'}
    ${lot ? chatterHtml("stock.lot", lot.id) : ""}`;
  if (lot) loadMessages("stock.lot", lot.id);
}

async function persist() {
  const v = form.values;
  if (!String(v.name).trim()) throw new Error("Nomor lot atau seri wajib diisi.");
  const dateVals = (keys) => Object.fromEntries(keys.map((k) => [k, v[k] ? fromInputDateTime(v[k]) : false]));
  const note = String(v.note).trim() ? `<p>${esc(v.note.trim())}</p>` : false;
  if (!form.id) {
    if (!form.product) throw new Error("Pilih produk dari kotak saran.");
    const vals = { name: v.name.trim(), product_id: form.product.id, ref: v.ref.trim() || false, note };
    if (form.product.use_expiration_date) for (const k of DATE_KEYS) if (v[k]) vals[k] = fromInputDateTime(v[k]);
    const [id] = await call("stock.lot", "create", { vals_list: [vals] });
    return id;
  }
  const changed = changedValues(v, form.initial, Object.keys(v));
  const vals = {};
  if ("name" in changed) vals.name = v.name.trim();
  if ("ref" in changed) vals.ref = v.ref.trim() || false;
  if ("note" in changed) vals.note = note;
  Object.assign(vals, dateVals(DATE_KEYS.filter((k) => k in changed)));
  if (Object.keys(vals).length) await call("stock.lot", "write", { ids: [form.id], vals });
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
      toast(wasNew ? "Lot dibuat." : "Perubahan disimpan.");
      if (wasNew) location.hash = `#/lot/${saved}`;
      else reload();
    }
  }
}

export function onInput(event, el) {
  if (!form) return;
  if (el.dataset.lot) form.values[el.dataset.lot] = el.value;
  else if (el.dataset.lookup === "lot-product") {
    form.product = null;
    runLookup(el, 250);
  }
}
