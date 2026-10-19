// Scrap (stock.scrap): membuang barang dari stok. Draft bisa diubah atau dihapus; Validasi memindahkan stok ke
// lokasi Scrap (bawaan; lokasi lain berjenis inventory bisa dipilih). Nilainya dicatat pada pergerakan stok dan dijurnal bila lokasi tujuan
// punya akun valuasi (Dr Beban Barang Rusak, Cr Persediaan, D69). Di bawah Jumlah tampil stok tersedia di lokasi asal (per lot bila produk berlacak);
// jumlah di atas stok ditandai merah, Validasi ditolak, dan Simpan juga ditolak bila "Blokir jumlah melebihi stok" aktif di Inventory Setting (D70).
import {
  PRODUCT_PAGE, searchProducts,
  INPUT, app, badge, call, cell, dateTimeText, esc, fieldBlock, guarded, pageHeader, readOne, readonlyValue, registerLookup, rowLink, runLookup,
  searchBox, searchRead, selectOptions, statusbar, table, toast, button, filterSelect, chatterHtml, loadMessages,
} from "../common.js";
import { blockOverStock, stockAt, stockText } from "../stockqty.js";

const STATES = { draft: ["Draft", "muted"], done: ["Selesai", "success"] };
const FILTERS = [["", "Semua"], ["draft", "Draft"], ["done", "Selesai"]];
const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 3 });

let form = null; // { id, product, qty, location, scrapLocation, origin, lot, stock }
let refs = null;
let last = { sub: "", query: new URLSearchParams() };
export const leave = () => {
  form = null;
};
const reload = () => render(last.sub, last.query);

registerLookup("scrap-product", {
  pageSize: PRODUCT_PAGE,
  search: (q, _input, page) => searchProducts(q, page, { domain: [["is_storable", "=", true]], fields: ["display_name", "uom_id", "tracking"] }),
  sub: (r) => (r.tracking === "lot" ? "Lot" : r.tracking === "serial" ? "Nomor seri" : r.uom_id?.[1] ?? ""),
  isChosen: (input) => form?.product?.display_name === input.value,
  choose: (input, item) => {
    const wasTracked = form.product?.tracking && form.product.tracking !== "none";
    form.product = item;
    form.lot = null;
    form.stock = null;
    input.value = item.display_name;
    if (wasTracked || item.tracking !== "none") reload(); // pilihan lot bergantung pada produk
    else loadStock();
  },
});

const isTracked = (product) => Boolean(product?.tracking) && product.tracking !== "none";

const locationName = () => refs?.internal.find((l) => l.id === form?.location)?.display_name ?? "";

/** Stok tepat di lokasi asal (Odoo memeriksa lokasi itu saja, tanpa sublokasi), per lot bila produk berlacak; null bila produk atau lot belum dipilih. */
async function fetchStock() {
  const f = form;
  if (!f?.product || !f.location || (isTracked(f.product) && !f.lot)) return null;
  const stock = await stockAt([f.product.id], f.location, { lotId: isTracked(f.product) ? f.lot : null, strict: true });
  return stock.get(f.product.id) ?? { onhand: 0, available: 0 };
}

/** Teks stok di bawah Jumlah; merah dan bertanda "melebihi stok tersedia" bila jumlah lebih besar dari stok tersedia. */
function stockLine() {
  const f = form;
  if (!f?.product) return "";
  if (isTracked(f.product) && !f.lot) return '<div class="text-xs mt-1 text-gray-500">Pilih lot atau nomor seri untuk melihat stoknya.</div>';
  if (!f.stock) return "";
  const over = Number(f.qty) > f.stock.available + 1e-9;
  return `<div class="text-xs mt-1 ${over ? "text-rose-600" : "text-gray-500"}">${esc(stockText(f.stock, f.product.uom_id?.[1], locationName()))}${over ? " · melebihi stok tersedia" : ""}</div>`;
}
function paintStock() {
  const box = document.getElementById("scrap-stock");
  if (box) box.innerHTML = stockLine();
}
async function loadStock() {
  if (!form) return;
  const f = form;
  const stock = await fetchStock();
  if (form === f) {
    f.stock = stock;
    paintStock();
  }
}

/** Lot yang punya stok di lokasi asal, untuk dipilih pada produk berlacak. */
async function lotChoices(product, location) {
  const quants = await searchRead(
    "stock.quant", [["product_id", "=", product.id], ["location_id", "child_of", location], ["lot_id", "!=", false], ["quantity", ">", 0]], ["lot_id", "quantity"], { limit: 200 },
  );
  const byLot = new Map();
  for (const q of quants) byLot.set(q.lot_id[0], { id: q.lot_id[0], display_name: `${q.lot_id[1]} (${nf.format((byLot.get(q.lot_id[0])?.qty ?? 0) + q.quantity)} tersedia)`, qty: (byLot.get(q.lot_id[0])?.qty ?? 0) + q.quantity });
  return [...byLot.values()];
}

async function references() {
  refs ??= {
    internal: await searchRead("stock.location", [["usage", "=", "internal"]], ["display_name"], { order: "complete_name" }),
    scrap: await searchRead("stock.location", [["usage", "=", "inventory"]], ["display_name"], { order: "complete_name" }),
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
  const filter = query.get("state") ?? "";
  const text = query.get("q") ?? "";
  const domain = [];
  if (filter) domain.push(["state", "=", filter]);
  if (text) domain.push("|", ["name", "ilike", text], ["product_id.name", "ilike", text]);
  const rows = await searchRead("stock.scrap", domain, ["name", "product_id", "scrap_qty", "product_uom_id", "location_id", "date_done", "state", "origin"], { order: "id desc", limit: 100 });
  const body = rows
    .map((r) =>
      rowLink(`#/scrap/${r.id}`, [
        cell(r.name, { strong: true }), cell(r.product_id[1]), cell(`${nf.format(r.scrap_qty)} ${r.product_uom_id?.[1] ?? ""}`, { right: true }),
        cell(r.location_id[1]), cell(r.date_done ? dateTimeText(r.date_done) : "-"), cell(badge(STATES, r.state), { raw: true }),
      ]),
    )
    .join("");
  app.innerHTML =
    pageHeader(
      "Scrap",
      `${searchBox(text, "Cari nomor atau produk")}${filterSelect(FILTERS, filter)}
       <a href="#/scrap/new" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"><i class="fas fa-plus mr-2"></i>Scrap Baru</a>`,
    ) +
    table([{ label: "Nomor" }, { label: "Produk" }, { label: "Jumlah", right: true }, { label: "Dari Lokasi" }, { label: "Tanggal" }, { label: "Status" }], body, "Belum ada scrap.");
}

async function renderForm(id) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const r = await references();
  let scrap = null;
  if (id) {
    scrap = await readOne("stock.scrap", id, ["name", "state", "product_id", "scrap_qty", "product_uom_id", "location_id", "scrap_location_id", "origin", "date_done", "lot_id"]);
    if (!scrap) {
      app.innerHTML = '<p class="text-sm text-rose-600">Scrap tidak ditemukan.</p>';
      return;
    }
  }
  const editable = !scrap || scrap.state === "draft";
  if (editable && (!form || form.id !== (scrap?.id ?? null))) {
    const [tracking] = scrap ? await searchRead("product.product", [["id", "=", scrap.product_id[0]]], ["tracking"], { limit: 1 }) : [];
    form = scrap
      ? { id: scrap.id, product: { id: scrap.product_id[0], display_name: scrap.product_id[1], uom_id: scrap.product_uom_id, tracking: tracking?.tracking ?? "none" }, qty: scrap.scrap_qty, location: scrap.location_id[0], scrapLocation: scrap.scrap_location_id[0], origin: scrap.origin || "", lot: scrap.lot_id?.[0] ?? null }
      : { id: null, product: null, qty: "", location: r.internal[0]?.id ?? null, scrapLocation: (r.scrap.find((l) => /scrap$/i.test(l.display_name)) ?? r.scrap[0])?.id ?? null, origin: "", lot: null };
  }
  const f = form;
  if (editable) f.stock = await fetchStock();
  const choices = editable && isTracked(f.product) ? await lotChoices(f.product, f.location) : [];
  const fields = editable
    ? `${fieldBlock("Produk", `<input data-lookup="scrap-product" autocomplete="off" role="combobox" aria-autocomplete="list" value="${esc(f.product?.display_name ?? "")}" placeholder="Cari produk yang dilacak stoknya..." class="${INPUT}">`)}
       ${fieldBlock("Jumlah", `<input type="number" min="0" step="any" data-scrap="qty" value="${esc(f.qty)}" class="${INPUT} text-right"><div id="scrap-stock">${stockLine()}</div>`)}
       ${fieldBlock("Dari Lokasi", `<select data-scrap="location" class="${INPUT}">${selectOptions(r.internal, f.location)}</select>`)}
       ${isTracked(f.product) ? fieldBlock(f.product.tracking === "serial" ? "Nomor Seri" : "Lot", `<select data-scrap="lot" class="${INPUT}">${selectOptions(choices, f.lot, "Pilih...")}</select>`) : ""}
       ${fieldBlock("Lokasi Scrap", `<select data-scrap="scrapLocation" class="${INPUT}">${selectOptions(r.scrap, f.scrapLocation)}</select>`)}
       ${fieldBlock("Dokumen Sumber", `<input data-scrap="origin" value="${esc(f.origin)}" class="${INPUT}">`)}`
    : `${fieldBlock("Produk", readonlyValue(scrap.product_id[1]))}${fieldBlock("Jumlah", readonlyValue(`${nf.format(scrap.scrap_qty)} ${scrap.product_uom_id?.[1] ?? ""}`))}
       ${fieldBlock("Dari Lokasi", readonlyValue(scrap.location_id[1]))}${scrap.lot_id ? fieldBlock("Lot/Serial", readonlyValue(scrap.lot_id[1])) : ""}${fieldBlock("Lokasi Scrap", readonlyValue(scrap.scrap_location_id[1]))}
       ${fieldBlock("Dokumen Sumber", readonlyValue(scrap.origin))}${fieldBlock("Tanggal", readonlyValue(scrap.date_done ? dateTimeText(scrap.date_done) : ""))}`;
  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/scrap" class="hover:text-indigo-600">Scrap</a> / ${esc(scrap?.name ?? "Baru")}</div>
    <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-3 mb-3">
      <div class="flex flex-wrap gap-2">${scrap && scrap.state === "draft" ? button("validate", "Validasi", "primary", { id: scrap.id }) + button("delete", "Hapus", "danger", { id: scrap.id }) : ""}</div>
      ${statusbar(["draft", "done"], STATES, scrap?.state ?? "draft")}
    </div>
    <h1 class="text-2xl font-bold text-gray-900 mb-3">${esc(scrap?.name ?? "Scrap Baru")}</h1>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-2 gap-x-8 gap-y-4">${fields}</section>
    ${editable ? `<div class="flex gap-2 mt-4"><button data-action="save" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Simpan</button>
      <a href="#/scrap" data-action="discard" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Buang</a></div>` : `<p class="mt-4 text-sm text-sky-900 bg-sky-50 border border-sky-200 rounded-lg px-4 py-3">Stok sudah berkurang. Nilainya tercatat pada pergerakan stok; <a href="#/moves?kind=loss" class="underline">lihat di Inventory Loss</a>.</p>`}
    ${scrap ? chatterHtml("stock.scrap", scrap.id) : ""}`;
  if (scrap) loadMessages("stock.scrap", scrap.id);
}

/** Jumlah melebihi stok: Validasi selalu ditolak bila di atas on hand lokasi (Odoo juga menolak); Simpan ditolak bila di atas stok tersedia dan opsi blokir aktif. */
async function checkStock(f, qty, validating) {
  const stock = await fetchStock();
  f.stock = stock;
  paintStock();
  if (!stock) return;
  const where = locationName();
  if (validating && qty > stock.onhand + 1e-9) throw new Error(`Jumlah ${nf.format(qty)} melebihi stok di ${where} (on hand ${nf.format(stock.onhand)}). Kurangi jumlah atau lakukan penerimaan lebih dulu.`);
  if (qty > stock.available + 1e-9 && (await blockOverStock())) {
    throw new Error(`Jumlah ${nf.format(qty)} melebihi stok tersedia di ${where} (${nf.format(stock.available)}). Kurangi jumlah, atau matikan "Blokir jumlah melebihi stok" di Inventory Setting.`);
  }
}

async function persist(validating = false) {
  const f = form;
  if (!f.product) throw new Error("Pilih produk dari kotak saran.");
  const qty = Number(f.qty);
  if (!(qty > 0)) throw new Error("Jumlah harus lebih dari 0.");
  if (!f.location || !f.scrapLocation) throw new Error("Pilih lokasi asal dan lokasi scrap.");
  if (isTracked(f.product) && !f.lot) throw new Error(`Pilih ${f.product.tracking === "serial" ? "nomor seri" : "lot"} yang di-scrap.`);
  await checkStock(f, qty, validating);
  const vals = { product_id: f.product.id, scrap_qty: qty, product_uom_id: f.product.uom_id[0], location_id: f.location, scrap_location_id: f.scrapLocation, origin: f.origin || false, lot_id: isTracked(f.product) ? f.lot : false };
  if (f.id) {
    await call("stock.scrap", "write", { ids: [f.id], vals });
    return f.id;
  }
  const [id] = await call("stock.scrap", "create", { vals_list: [vals] });
  return id;
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
      toast(wasNew ? "Scrap dibuat (draft)." : "Perubahan disimpan.");
      if (wasNew) location.hash = `#/scrap/${saved}`;
      else reload();
    }
  } else if (action === "validate") {
    const ok = await guarded(el, async () => {
      if (form?.id === id) await persist(true);
      const result = await call("stock.scrap", "action_validate", { ids: [id] });
      if (result && typeof result === "object") throw new Error("Stok tidak cukup untuk di-scrap. Kurangi jumlah atau lakukan penerimaan lebih dulu.");
      return true;
    });
    if (ok) {
      form = null;
      toast("Scrap divalidasi. Stok berkurang.");
      reload();
    }
  } else if (action === "delete") {
    if (!window.confirm("Hapus scrap ini?")) return;
    const ok = await guarded(el, () => call("stock.scrap", "unlink", { ids: [id] }));
    if (ok !== undefined) {
      form = null;
      toast("Scrap dihapus.");
      location.hash = "#/scrap";
    }
  }
}

export function onInput(event, el) {
  if (!form) return;
  if (el.dataset.scrap) {
    form[el.dataset.scrap] = ["location", "scrapLocation", "lot"].includes(el.dataset.scrap) ? Number(el.value) || null : el.value;
    if (el.dataset.scrap === "qty") paintStock();
  } else if (el.dataset.lookup === "scrap-product") {
    form.product = null;
    runLookup(el, 250);
  }
}

export function onChange(event, el) {
  if (!form) return;
  // Lokasi asal menentukan lot yang punya stok; muat ulang pilihannya.
  if (el.dataset.scrap === "location" && isTracked(form.product)) {
    form.lot = null;
    form.stock = null;
    reload();
  } else if (el.dataset.scrap === "location" || el.dataset.scrap === "lot") loadStock();
}
