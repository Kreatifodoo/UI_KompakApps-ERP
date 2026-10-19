// Kasir (terminal POS): pilih produk, atur jumlah dan diskon, pilih pelanggan, bayar dengan satu atau beberapa metode
// (tunai dengan kembalian), dan cetak struk. Pesanan dikirim ke pos.order lewat sync_from_ui dengan nilai pajak yang
// dihitung server (account.tax.compute_all). Sesi harus sudah dibuka di POS Station.
import {
  INPUT, app, call, closeLookup, closeModal, ctx, esc, guarded, money, openModal, pageHeader, readOne, registerLookup, runLookup, searchRead, toast,
} from "../common.js";
import { evaluate, findCode, loadPrograms } from "../pospromo.js";
import { posReceiptPage, printHtml } from "../print.js";

const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 3 });
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

let state = null; // { config, session, methods, products, search, cart, customer, totals, tick }
let last = { sub: "", query: new URLSearchParams() };
let searchTimer;
let pay = null; // { amounts: Map, invoice: boolean }
export const leave = () => {
  closeLookup();
  clearTimeout(searchTimer);
};
// Keranjang tetap ada selama sesi yang sama saat pengguna berpindah halaman; hilang saat transaksi selesai.

registerLookup("kasir-customer", {
  search: (q) => searchRead("res.partner", q ? [["name", "ilike", q]] : [], ["display_name"], { limit: 8, order: "customer_rank desc, name" }),
  isChosen: (input) => state?.customer?.display_name === input.value,
  choose: (input, item) => {
    state.customer = item;
    input.value = item.display_name;
    paintCart();
  },
});

export async function render(sub, query) {
  last = { sub, query };
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat kasir...</p>';
  const configId = Number(query.get("config")) || null;
  if (!configId) {
    const configs = await searchRead("pos.config", [], ["name", "current_session_state"], { order: "name" });
    app.innerHTML =
      pageHeader("Kasir") +
      (configs.length
        ? `<div class="grid md:grid-cols-3 gap-4">${configs
            .map((c) => `<a href="#/kasir?config=${c.id}" class="block bg-white rounded-xl border border-gray-200 shadow-sm p-5 hover:border-indigo-300"><div class="font-semibold text-gray-900">${esc(c.name)}</div><div class="text-xs text-gray-500 mt-1">${c.current_session_state === "opened" ? "Sesi berjalan" : "Belum ada sesi berjalan"}</div></a>`)
            .join("")}</div>`
        : '<p class="text-sm text-gray-500">Belum ada stasiun POS. Buat di <a href="#/posconfig" class="text-indigo-700 underline">POS Station</a>.</p>');
    return;
  }
  const config = await readOne("pos.config", configId, ["name", "payment_method_ids", "current_session_id", "current_session_state", "pricelist_id"]);
  if (!config) {
    app.innerHTML = '<p class="text-sm text-rose-600">Stasiun POS tidak ditemukan.</p>';
    return;
  }
  if (!config.current_session_id || config.current_session_state !== "opened") {
    app.innerHTML =
      pageHeader(config.name) +
      `<div class="bg-white rounded-xl border border-gray-200 shadow-sm p-8 text-center"><p class="text-sm text-gray-600 mb-4">Belum ada sesi yang berjalan untuk stasiun ini.</p>
        <a href="#/posconfig/${config.id}" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Buka Sesi di POS Station</a></div>`;
    return;
  }
  const methods = await searchRead("pos.payment.method", [["id", "in", config.payment_method_ids]], ["name", "is_cash_count", "type"], { order: "sequence, id" });
  if (!state || state.config.id !== config.id || state.session.id !== config.current_session_id[0]) {
    state = { config, session: { id: config.current_session_id[0], name: config.current_session_id[1] }, methods, products: [], search: "", cart: [], customer: null, totals: { excl: 0, tax: 0, incl: 0 }, tick: 0, codes: [], rewards: [], promoMessages: [] };
  } else Object.assign(state, { config, methods });
  state.promo = await loadPrograms(config).catch(() => ({ programs: [], unsupported: [] })); // promosi tidak boleh menghalangi kasir
  state.rounding = (await readOne("res.company", ctx.company.id, ["tax_calculation_rounding_method"]))?.tax_calculation_rounding_method ?? "round_per_line";
  state.products = await loadProducts("");
  paintAll();
}

const PRODUCT_LIMIT = 60;

/** Produk untuk grid kasir. Tiap kata harus cocok (urutan bebas) dengan kode, nama, atau barcode; `state.productTotal` mencatat jumlah seluruh yang cocok. */
async function loadProducts(text) {
  const domain = [["available_in_pos", "=", true], ["sale_ok", "=", true], ...text.split(/\s+/).filter(Boolean).map((word) => ["display_name", "ilike", word])];
  const items = await searchRead("product.product", domain, ["display_name", "lst_price", "taxes_id", "default_code", "barcode", "uom_id"], { limit: PRODUCT_LIMIT, order: "name" });
  state.productTotal = items.length < PRODUCT_LIMIT ? items.length : await call("product.product", "search_count", { domain });
  return items;
}

function paintAll() {
  app.innerHTML = `
    <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
      <div><h1 class="text-2xl font-bold text-gray-900">Kasir · ${esc(state.config.name)}</h1><div class="text-sm text-gray-500">Sesi ${esc(state.session.name)}</div></div>
      <div class="flex flex-wrap items-center gap-2"><label class="flex items-center gap-2 text-sm text-gray-600" title="Struk 80 mm langsung dikirim ke printer setelah pembayaran"><input type="checkbox" data-kasir="autoprint" ${autoPrint.get() ? "checked" : ""} class="rounded border-gray-300 text-indigo-600">Cetak struk otomatis</label>
        <a href="#/possession/${state.session.id}" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Sesi dan Tutup Kasir</a>
        <a href="#/posorder?session=${state.session.id}" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Pesanan Sesi</a></div></div>
    <div class="grid lg:grid-cols-3 gap-4">
      <section class="lg:col-span-2">
        <input id="kasir-search" data-kasir="search" autocomplete="off" value="${esc(state.search)}" placeholder="Cari produk, kode, atau pindai barcode lalu Enter..." class="${INPUT} mb-3" aria-label="Cari produk">
        <div id="kasir-products" class="grid sm:grid-cols-2 xl:grid-cols-3 gap-3"></div></section>
      <section id="kasir-cart" class="bg-white rounded-xl border border-gray-200 shadow-sm p-4 self-start"></section></div>`;
  paintProducts();
  paintCart();
}

function paintProducts() {
  const box = document.querySelector("#kasir-products");
  if (!box) return;
  box.innerHTML = state.products.length
    ? state.products
        .map(
          (p) => `<button type="button" data-action="add-product" data-id="${p.id}" class="text-left bg-white border border-gray-200 rounded-xl p-3 shadow-sm hover:border-indigo-400 hover:shadow">
            <div class="text-sm font-medium text-gray-900">${esc(p.display_name)}</div>
            <div class="text-xs text-gray-500 mt-0.5">${esc(p.default_code || p.barcode || "")}</div>
            <div class="text-sm font-semibold text-indigo-700 mt-2">${esc(money(p.lst_price))}</div></button>`,
        )
        .join("")
    : `<p class="text-sm text-gray-500 sm:col-span-2 xl:col-span-3">Tidak ada produk. Tandai produk sebagai "Dijual di POS" di <a href="#/product" class="text-indigo-700 underline">Product Master</a>.</p>`;
  if (state.productTotal > state.products.length) {
    box.insertAdjacentHTML("beforeend", `<p class="text-xs text-gray-500 sm:col-span-2 xl:col-span-3">Menampilkan ${state.products.length} dari ${state.productTotal} produk. Ketik kode, nama, atau barcode di kolom cari untuk mempersempit.</p>`);
  }
}

/* ---------- Keranjang dan pajak ---------- */

const unitAfterDiscount = (line) => line.product.lst_price * (1 - (Number(line.discount) || 0) / 100);

async function priceLine(line) {
  const qty = Number(line.qty) || 0;
  const unit = unitAfterDiscount(line);
  if (!line.product.taxes_id.length) {
    const total = r2(unit * qty);
    return { excl: total, incl: total };
  }
  const result = await call("account.tax", "compute_all", { ids: line.product.taxes_id, price_unit: unit, quantity: qty });
  return { excl: r2(result.total_excluded), incl: r2(result.total_included) };
}

async function recompute() {
  const ticket = ++state.tick;
  const priced = await Promise.all(state.cart.map(priceLine));
  if (ticket !== state.tick) return; // perhitungan usang
  state.cart.forEach((line, i) => {
    line.excl = priced[i].excl;
    line.incl = priced[i].incl;
  });
  // Promosi dihitung dari keranjang yang sudah berharga; kegagalan promosi tidak menghalangi penjualan biasa.
  let promo = { items: [], lines: [], messages: [] };
  try {
    promo = await evaluate(state.promo?.programs ?? [], state.cart, state.codes ?? []);
  } catch (error) {
    promo.messages.push(`Promosi tidak dapat dihitung: ${error.message}`);
  }
  if (ticket !== state.tick) return;
  state.rewards = promo.lines;
  state.promoMessages = promo.messages;
  const entries = [
    ...state.cart.map((l) => ({ taxIds: l.product.taxes_id, excl: l.excl, incl: l.incl })),
    ...state.rewards.map((l) => ({ taxIds: l.tax_ids, excl: l.excl, incl: l.incl })),
  ];
  const totals = await orderTotals(entries);
  if (ticket !== state.tick) return;
  state.totals = totals;
  paintTotals();
  paintPromo();
}

/** Total pesanan menurut metode pembulatan pajak perusahaan: per baris, atau global (pajak dihitung atas dasar pengenaan gabungan per jenis pajak, seperti lokalisasi
 * Indonesia). Selisih pembulatan satu sen antara total kasir dan jurnal sesi membuat penutupan sesi meminta penyeimbangan (lihat D30). */
async function orderTotals(entries) {
  const excl = r2(entries.reduce((s, e) => s + e.excl, 0));
  if (state.rounding !== "round_globally") {
    const incl = r2(entries.reduce((s, e) => s + e.incl, 0));
    return { excl, tax: r2(incl - excl), incl };
  }
  const groups = new Map();
  for (const e of entries) {
    const key = [...e.taxIds].sort((a, b) => a - b).join(",");
    const group = groups.get(key) ?? { taxIds: e.taxIds, excl: 0, incl: 0 };
    group.excl += e.excl;
    group.incl += e.incl;
    groups.set(key, group);
  }
  const inclParts = await Promise.all(
    [...groups.values()].map(async (g) => (g.taxIds.length ? r2((await call("account.tax", "compute_all", { ids: g.taxIds, price_unit: r2(g.excl), quantity: 1 })).total_included) : r2(g.incl))),
  );
  const incl = r2(inclParts.reduce((s, v) => s + v, 0));
  return { excl, tax: r2(incl - excl), incl };
}

function paintCart() {
  const box = document.querySelector("#kasir-cart");
  if (!box) return;
  const lines = state.cart
    .map(
      (l, i) => `<div class="py-3 border-b border-gray-100">
        <div class="flex justify-between gap-2"><div class="text-sm font-medium text-gray-900">${esc(l.product.display_name)}</div>
          <button type="button" data-action="line-remove" data-i="${i}" class="text-gray-400 hover:text-rose-600" aria-label="Hapus baris"><i class="fas fa-times"></i></button></div>
        <div class="flex items-center gap-2 mt-2">
          <button type="button" data-action="qty-dec" data-i="${i}" class="w-8 h-8 border border-gray-300 rounded-lg hover:bg-gray-50" aria-label="Kurangi">−</button>
          <input type="number" min="0" step="any" data-kasir-line="${i}" data-f="qty" value="${esc(l.qty)}" class="${INPUT} w-20 text-center" aria-label="Jumlah">
          <button type="button" data-action="qty-inc" data-i="${i}" class="w-8 h-8 border border-gray-300 rounded-lg hover:bg-gray-50" aria-label="Tambah">+</button>
          <span class="text-xs text-gray-500">× ${esc(money(l.product.lst_price))}</span>
          <label class="ml-auto text-xs text-gray-500 flex items-center gap-1">Diskon<input type="number" min="0" max="100" step="any" data-kasir-line="${i}" data-f="discount" value="${esc(l.discount)}" class="${INPUT} w-16 text-right py-1" aria-label="Diskon persen">%</label></div>
        <div class="text-right text-sm font-semibold mt-1" data-line-total="${i}">${esc(money(l.incl ?? 0))}</div></div>`,
    )
    .join("");
  box.innerHTML = `
    <div class="flex items-center justify-between mb-2"><div class="text-sm font-semibold">Keranjang</div>${state.cart.length ? '<button type="button" data-action="cart-clear" class="text-xs text-gray-500 hover:text-rose-600">Kosongkan</button>' : ""}</div>
    <div class="max-h-96 overflow-y-auto">${lines || '<p class="py-8 text-center text-sm text-gray-500">Belum ada barang. Pilih produk di sebelah kiri.</p>'}</div>
    <div id="kasir-promo" class="mt-3"></div>
    <div class="mt-3"><input data-lookup="kasir-customer" autocomplete="off" role="combobox" aria-autocomplete="list" value="${esc(state.customer?.display_name ?? "")}" placeholder="Pelanggan (opsional)" class="${INPUT}" aria-label="Pelanggan"></div>
    <div id="kasir-totals" class="mt-3 text-sm"></div>
    <button type="button" data-action="pay" ${state.cart.length ? "" : "disabled"} class="mt-3 w-full px-4 py-3 bg-indigo-600 text-white rounded-lg text-base font-semibold hover:bg-indigo-700 disabled:opacity-40">Bayar</button>`;
  paintTotals();
  paintPromo();
}

/** Kotak promosi: kode promo yang dimasukkan, baris hadiah yang berlaku, dan pesan syarat yang belum terpenuhi. */
function paintPromo() {
  const box = document.querySelector("#kasir-promo");
  if (!box) return;
  const hasPrograms = Boolean(state.promo?.programs?.length);
  const rewardRows = (state.rewards ?? []).map((r) => `<div class="flex justify-between gap-2 text-sm text-emerald-700"><span><i class="fas fa-tag mr-1"></i>${esc(r.name)}</span><span>${r.discount === 100 ? `Gratis × ${esc(nf.format(r.qty))}` : esc(money(r.incl))}</span></div>`).join("");
  const codes = (state.codes ?? []).map((c, i) => `<span class="inline-flex items-center gap-1 bg-indigo-50 text-indigo-800 rounded-full px-2 py-1 text-xs">${esc(c)}<button type="button" data-action="promo-remove" data-i="${i}" class="text-indigo-400 hover:text-rose-600" aria-label="Hapus kode ${esc(c)}"><i class="fas fa-times"></i></button></span>`).join(" ");
  const notes = (state.promoMessages ?? []).map((m) => `<div class="text-xs text-amber-700">${esc(m)}</div>`).join("");
  const unsupported = state.promo?.unsupported?.length ? `<div class="text-xs text-gray-500">Belum didukung di kasir: ${esc(state.promo.unsupported.join(", "))}.</div>` : "";
  box.innerHTML = `${hasPrograms ? `<div class="flex gap-2"><input data-kasir="promo-code" autocomplete="off" placeholder="Kode promo" class="${INPUT}" aria-label="Kode promo"><button type="button" data-action="promo-apply" class="px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50 whitespace-nowrap">Terapkan</button></div>` : ""}
    ${codes ? `<div class="mt-2 flex flex-wrap gap-1">${codes}</div>` : ""}
    ${rewardRows ? `<div class="mt-2 space-y-1">${rewardRows}</div>` : ""}${notes ? `<div class="mt-1">${notes}</div>` : ""}${unsupported}`;
}

function paintTotals() {
  const box = document.querySelector("#kasir-totals");
  if (!box) return;
  const t = state.totals;
  box.innerHTML = `<div class="flex justify-between text-gray-600"><span>Subtotal</span><span>${esc(money(t.excl))}</span></div>
    <div class="flex justify-between text-gray-600"><span>Pajak</span><span>${esc(money(t.tax))}</span></div>
    <div class="flex justify-between text-lg font-bold text-gray-900 mt-1"><span>Total</span><span>${esc(money(t.incl))}</span></div>`;
  state.cart.forEach((l, i) => {
    const cellEl = document.querySelector(`[data-line-total="${i}"]`);
    if (cellEl) cellEl.textContent = money(l.incl ?? 0);
  });
}

function addProduct(id) {
  const product = state.products.find((p) => p.id === id);
  if (!product) return;
  const existing = state.cart.find((l) => l.product.id === id && !Number(l.discount));
  if (existing) existing.qty = Number(existing.qty) + 1;
  else state.cart.push({ product, qty: 1, discount: 0, excl: 0, incl: 0 });
  paintCart();
  recompute();
}

/* ---------- Pembayaran ---------- */

const cashMethod = () => state.methods.find((m) => m.is_cash_count) ?? null;

function payTotals() {
  const total = state.totals.incl;
  const paid = r2([...pay.amounts.values()].reduce((s, v) => s + (Number(v) || 0), 0));
  const cashPaid = cashMethod() ? Number(pay.amounts.get(cashMethod().id) || 0) : 0;
  const change = paid > total ? r2(paid - total) : 0;
  const due = paid < total ? r2(total - paid) : 0;
  return { total, paid, change, due, ok: due === 0 && change <= cashPaid + 0.001 };
}

function paintPay() {
  const t = payTotals();
  const info = document.querySelector("#pay-info");
  if (info) {
    info.innerHTML = `<div class="flex justify-between"><span>Total</span><b>${esc(money(t.total))}</b></div>
      <div class="flex justify-between"><span>Dibayar</span><span>${esc(money(t.paid))}</span></div>
      ${t.due ? `<div class="flex justify-between text-rose-700"><span>Kurang</span><b>${esc(money(t.due))}</b></div>` : ""}
      ${t.change ? `<div class="flex justify-between text-emerald-700"><span>Kembalian</span><b>${esc(money(t.change))}</b></div>` : ""}
      ${t.change && !t.ok ? '<div class="text-xs text-rose-700 mt-1">Kembalian hanya dari pembayaran tunai.</div>' : ""}`;
  }
  const confirm = document.querySelector('[data-action="pay-confirm"]');
  if (confirm) confirm.disabled = !t.ok;
}

function payDialog() {
  const cash = cashMethod();
  pay = { amounts: new Map(state.methods.map((m) => [m.id, m === cash || (!cash && m === state.methods[0]) ? String(state.totals.incl) : ""])), invoice: false };
  openModal(
    "Pembayaran",
    `<div class="space-y-3">
       ${state.methods
         .map(
           (m) => `<label class="flex items-center gap-3"><span class="w-40 text-sm text-gray-700">${esc(m.name)}${m.is_cash_count ? ' <span class="text-xs text-gray-400">tunai</span>' : ""}</span>
             <input type="number" min="0" step="any" data-pay="${m.id}" value="${esc(pay.amounts.get(m.id))}" class="${INPUT} text-right" aria-label="Jumlah ${esc(m.name)}"></label>`,
         )
         .join("")}
       ${state.customer ? `<label class="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" data-pay-invoice class="rounded border-gray-300 text-indigo-600"> Buat faktur untuk ${esc(state.customer.display_name)}</label>` : ""}
       <div id="pay-info" class="border-t border-gray-100 pt-3 text-sm space-y-1"></div></div>`,
    `<button data-action="modal-close" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Batal</button>
     <button data-action="pay-confirm" class="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40">Selesaikan Pembayaran</button>`,
  );
  paintPay();
}

async function submitOrder(button) {
  const t = payTotals();
  const order = await guarded(button, async () => {
    if (!t.ok) throw new Error("Pembayaran belum cukup.");
    const session = await readOne("pos.session", state.session.id, ["order_count", "state"]);
    if (session.state !== "opened") throw new Error("Sesi sudah tidak berjalan. Buka sesi baru di POS Station.");
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    const uuid = crypto.randomUUID();
    const payments = [];
    for (const m of state.methods) {
      const amount = Number(pay.amounts.get(m.id) || 0);
      if (amount > 0) payments.push([0, 0, { payment_method_id: m.id, amount, name: now }]);
    }
    if (t.change > 0) payments.push([0, 0, { payment_method_id: cashMethod().id, amount: -t.change, name: now, is_change: true }]);
    const payload = {
      name: `Order ${uuid.slice(0, 8)}`, uuid, session_id: state.session.id, config_id: state.config.id, user_id: ctx.user.id, sequence_number: session.order_count + 1, date_order: now,
      amount_tax: state.totals.tax, amount_total: state.totals.incl, amount_paid: state.totals.incl, amount_return: 0, partner_id: state.customer?.id ?? false,
      to_invoice: Boolean(pay.invoice && state.customer), pricelist_id: state.config.pricelist_id?.[0] ?? false, fiscal_position_id: false,
      lines: state.cart.map((l) => [0, 0, {
        uuid: crypto.randomUUID(), product_id: l.product.id, qty: Number(l.qty), price_unit: l.product.lst_price, discount: Number(l.discount) || 0, tax_ids: [[6, 0, l.product.taxes_id]],
        price_subtotal: l.excl, price_subtotal_incl: l.incl, full_product_name: l.product.display_name, name: l.product.display_name,
      }]).concat((state.rewards ?? []).map((r) => [0, 0, {
        uuid: crypto.randomUUID(), product_id: r.product_id, qty: r.qty, price_unit: r.price_unit, discount: r.discount, tax_ids: [[6, 0, r.tax_ids]],
        price_subtotal: r.excl, price_subtotal_incl: r.incl, full_product_name: r.name, name: r.name,
        is_reward_line: true, reward_id: r.reward_id, reward_identifier_code: r.identifier, points_cost: r.points_cost,
      }])),
      payment_ids: payments,
    };
    const result = await call("pos.order", "sync_from_ui", { orders: [payload] });
    const created = result["pos.order"]?.[0];
    if (!created) throw new Error("Odoo tidak mengembalikan pesanan. Periksa di POS Order.");
    return { id: created.id, change: t.change, paid: t.paid };
  });
  if (!order) return;
  closeModal();
  state.cart = [];
  state.customer = null;
  state.codes = [];
  state.rewards = [];
  state.promoMessages = [];
  state.totals = { excl: 0, tax: 0, incl: 0 };
  pay = null;
  paintCart();
  toast("Pembayaran selesai.");
  await showReceipt(order.id);
}

/* ---------- Struk ---------- */

/** Pilihan "Cetak struk otomatis" disimpan per peramban (kenyamanan pengguna, bukan data bersama). */
const autoPrint = {
  get() {
    try {
      return localStorage.getItem("kompakapps.kasir.autoprint") === "1";
    } catch {
      return false;
    }
  },
  set(on) {
    try {
      localStorage.setItem("kompakapps.kasir.autoprint", on ? "1" : "0");
    } catch {
      /* penyimpanan peramban boleh gagal; pilihan berlaku sampai halaman dimuat ulang */
    }
  },
};
let receiptPageHtml = ""; // struk 80 mm terakhir untuk tombol Cetak

/** Struk 80 mm pesanan (logo, kop, barang, pembayaran, QR) di pratinjau; dicetak otomatis bila pilihannya aktif. */
async function showReceipt(orderId) {
  receiptPageHtml = await posReceiptPage(orderId);
  openModal(
    "Struk",
    `<iframe id="receipt" title="Struk" class="border border-gray-200 rounded bg-white" style="width:340px;max-width:100%;margin:0 auto;display:block;height:60vh" srcdoc="${esc(receiptPageHtml)}"></iframe>`,
    `<button data-action="receipt-print" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50"><i class="fas fa-print mr-2"></i>Cetak</button>
     <a href="#/posorder/${orderId}" data-action="modal-close" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Lihat Pesanan</a>
     <button data-action="modal-close" class="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700">Transaksi Baru</button>`,
  );
  if (autoPrint.get()) printHtml(receiptPageHtml);
}

/* ---------- Penanganan acara ---------- */

export async function onClick(event, el) {
  const { action } = el.dataset;
  const i = Number(el.dataset.i);
  if (action === "add-product") addProduct(Number(el.dataset.id));
  else if (action === "line-remove") {
    state.cart.splice(i, 1);
    paintCart();
    recompute();
  } else if (action === "qty-inc" || action === "qty-dec") {
    const line = state.cart[i];
    line.qty = Math.max(0, Number(line.qty) + (action === "qty-inc" ? 1 : -1));
    if (line.qty === 0) state.cart.splice(i, 1);
    paintCart();
    recompute();
  } else if (action === "cart-clear") {
    if (!window.confirm("Kosongkan keranjang?")) return;
    state.cart = [];
    state.codes = [];
    state.rewards = [];
    state.promoMessages = [];
    state.totals = { excl: 0, tax: 0, incl: 0 };
    paintCart();
  } else if (action === "pay") {
    await recompute();
    if (!(state.totals.incl > 0)) {
      toast("Keranjang kosong atau total nol.", "error");
      return;
    }
    payDialog();
  } else if (action === "promo-apply") await applyPromoCode();
  else if (action === "promo-remove") {
    state.codes.splice(i, 1);
    await recompute();
  } else if (action === "pay-confirm") await submitOrder(el);
  else if (action === "receipt-print") printHtml(receiptPageHtml);
}

async function applyPromoCode() {
  const input = document.querySelector('[data-kasir="promo-code"]');
  const code = input?.value.trim() ?? "";
  if (!code) return;
  if (!state.cart.length) {
    toast("Tambahkan barang ke keranjang lebih dulu.", "error");
    return;
  }
  const found = findCode(state.promo?.programs ?? [], code);
  if (!found) {
    toast(`Kode "${code}" tidak dikenal atau programnya tidak berlaku di stasiun ini.`, "error");
    return;
  }
  if (state.codes.some((c) => c.toLowerCase() === code.toLowerCase())) {
    toast("Kode promo ini sudah diterapkan.", "error");
    return;
  }
  state.codes.push(found.rule.code);
  await recompute();
  if (!state.rewards.some((r) => r.program?.id === found.program.id)) {
    state.codes = state.codes.filter((c) => c !== found.rule.code);
    const reason = state.promoMessages.find((m) => m.startsWith(`Kode ${found.rule.code}`)) ?? "Syarat program belum terpenuhi.";
    await recompute();
    toast(reason, "error");
    return;
  }
  toast(`Kode ${found.rule.code} diterapkan.`);
}

export function onInput(event, el) {
  if (!state) return;
  if (el.dataset.kasir === "autoprint") autoPrint.set(el.checked);
  else if (el.dataset.kasir === "search") {
    state.search = el.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      state.products = await loadProducts(state.search.trim());
      paintProducts();
    }, 250);
  } else if (el.dataset.kasirLine !== undefined) {
    const line = state.cart[Number(el.dataset.kasirLine)];
    if (!line) return;
    line[el.dataset.f] = el.value;
    recompute();
  } else if (el.dataset.pay !== undefined && pay) {
    pay.amounts.set(Number(el.dataset.pay), el.value);
    paintPay();
  } else if (el.dataset.payInvoice !== undefined && pay) pay.invoice = el.checked;
  else if (el.dataset.lookup === "kasir-customer") {
    state.customer = null;
    runLookup(el, 250);
  }
}

document.addEventListener("keydown", async (event) => {
  // Enter pada kolom cari: tambahkan produk yang cocok persis dengan barcode, atau hasil pertama.
  if (event.key !== "Enter" || event.target.dataset?.kasir !== "search" || !state) return;
  event.preventDefault();
  clearTimeout(searchTimer);
  const text = event.target.value.trim();
  if (!text) return;
  state.products = await loadProducts(text);
  paintProducts();
  const match = state.products.find((p) => p.barcode === text) ?? (state.products.length === 1 ? state.products[0] : null);
  if (match) {
    addProduct(match.id);
    event.target.value = "";
    state.search = "";
    state.products = await loadProducts("");
    paintProducts();
  }
});

document.addEventListener("keydown", async (event) => {
  // Enter pada kolom kode promo menerapkan kode.
  if (event.key !== "Enter" || event.target.dataset?.kasir !== "promo-code" || !state) return;
  event.preventDefault();
  await applyPromoCode();
});
