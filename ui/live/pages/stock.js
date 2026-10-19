// Laporan Stok (stock.quant): stok per produk dan per lokasi dengan jumlah, terpesan, tersedia, dan nilai (biaya
// rata-rata). Kartu atas membandingkan nilai stok dengan saldo akun Persediaan di buku besar: Sistem tidak membuat
// jurnal untuk penyesuaian stok dan scrap pada valuasi perpetual, jadi selisihnya perlu dipantau.
import { app, call, esc, filterSelect, money, pageHeader, searchBox, searchRead } from "../common.js";

const MODES = {
  report: { title: "Stok per Produk", group: (q) => `p${q.product_id[0]}`, label: (q) => q.product_id[1], sub: (q) => q.product_categ_id?.[1] ?? "", detail: "location" },
  location: { title: "Stok per Lokasi", group: (q) => `l${q.location_id[0]}`, label: (q) => q.location_id[1], sub: () => "", detail: "product" },
  warehouse: { title: "Stok per Gudang" },
};
const MODE_LABEL = { report: "Per produk", location: "Per lokasi", warehouse: "Per gudang" };
const FILTERS = [["", "Semua stok"], ["available", "Ada stok tersedia"], ["reserved", "Ada yang terpesan"], ["negative", "Stok minus"]];
const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 });

let last = { sub: "report", query: new URLSearchParams() };
export const leave = () => {};

async function glBalance() {
  const categories = await searchRead("product.category", [], ["property_stock_valuation_account_id"]);
  const ids = [...new Set(categories.map((c) => c.property_stock_valuation_account_id?.[0]).filter(Boolean))];
  if (!ids.length) return { balance: 0, accounts: [] };
  const [group] = await call("account.move.line", "formatted_read_group", {
    domain: [["account_id", "in", ids], ["parent_state", "=", "posted"]], groupby: [], aggregates: ["balance:sum"],
  });
  return { balance: group?.["balance:sum"] || 0 };
}

export async function render(sub, query) {
  const mode = MODES[sub] ? sub : "report";
  last = { sub: mode, query };
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat stok...</p>';
  if (mode === "warehouse") return renderWarehouse(query);
  const filter = query.get("state") ?? "";
  const text = query.get("q") ?? "";
  const domain = [["location_id.usage", "=", "internal"]];
  if (filter === "available") domain.push(["available_quantity", ">", 0]);
  else if (filter === "reserved") domain.push(["reserved_quantity", ">", 0]);
  else if (filter === "negative") domain.push(["quantity", "<", 0]);
  if (text) domain.push("|", "|", "|", ["product_id.name", "ilike", text], ["product_id.default_code", "ilike", text], ["location_id.complete_name", "ilike", text], ["lot_id.name", "ilike", text]);
  // dari tombol pintas "Stok Tersedia" di halaman produk (id template produk)
  const productId = Number(query.get("product")) || null;
  if (productId) domain.push(["product_id.product_tmpl_id", "=", productId]);
  const [quants, gl, [product]] = await Promise.all([
    searchRead("stock.quant", domain, ["product_id", "location_id", "lot_id", "quantity", "reserved_quantity", "available_quantity", "value", "product_uom_id", "product_categ_id"], {
      order: "product_id, location_id", limit: 1000,
    }),
    glBalance(),
    productId ? searchRead("product.template", [["id", "=", productId]], ["display_name"], { limit: 1 }) : Promise.resolve([]),
  ]);
  const def = MODES[mode];
  const groups = new Map();
  for (const q of quants) {
    const key = def.group(q);
    if (!groups.has(key)) groups.set(key, { label: def.label(q), sub: def.sub(q), qty: 0, reserved: 0, available: 0, value: 0, uom: q.product_uom_id?.[1] ?? "", rows: [] });
    const g = groups.get(key);
    g.qty += q.quantity;
    g.reserved += q.reserved_quantity;
    g.available += q.available_quantity;
    g.value += q.value;
    g.rows.push(q);
  }
  const totalValue = quants.reduce((s, q) => s + q.value, 0);
  const difference = totalValue - gl.balance;
  const rows = [...groups.entries()]
    .map(([key, g]) => {
      const detail = g.rows
        .map(
          (q) => `<tr class="bg-gray-50"><td class="py-2 pl-10 pr-4 text-sm text-gray-600" colspan="1">${esc(def.detail === "location" ? q.location_id[1] : q.product_id[1])}${q.lot_id ? ` · <a href="#/lot/${q.lot_id[0]}" class="text-indigo-700 hover:underline">${esc(q.lot_id[1])}</a>` : ""}</td>
            <td class="py-2 px-4 text-sm text-right text-gray-600">${nf.format(q.quantity)}</td><td class="py-2 px-4 text-sm text-right text-gray-600">${nf.format(q.reserved_quantity)}</td>
            <td class="py-2 px-4 text-sm text-right text-gray-600">${nf.format(q.available_quantity)}</td><td class="py-2 px-4 text-sm text-right text-gray-600">${esc(money(q.value))}</td></tr>`,
        )
        .join("");
      return `<tbody class="divide-y divide-gray-100 border-b border-gray-200" data-group="${key}">
        <tr class="hover:bg-gray-50 cursor-pointer" data-action="toggle-group" data-key="${key}"><td class="py-3 px-4 text-sm"><span class="font-medium text-indigo-700">${esc(g.label)}</span>${g.sub ? ` <span class="text-xs text-gray-500">${esc(g.sub)}</span>` : ""}</td>
          <td class="py-3 px-4 text-sm text-right tabular-nums ${g.qty < 0 ? "text-rose-700" : ""}">${nf.format(g.qty)} ${esc(def.detail === "location" ? g.uom : "")}</td><td class="py-3 px-4 text-sm text-right tabular-nums">${nf.format(g.reserved)}</td>
          <td class="py-3 px-4 text-sm text-right tabular-nums">${nf.format(g.available)}</td><td class="py-3 px-4 text-sm text-right tabular-nums font-medium">${esc(money(g.value))}</td></tr>
        <template data-detail="${key}">${detail}</template></tbody>`;
    })
    .join("");
  const card = (label, value, hint = "", tone = "") =>
    `<div class="bg-white rounded-xl border border-gray-200 shadow-sm p-4"><div class="text-xs font-medium text-gray-500 uppercase">${label}</div><div class="text-xl font-semibold mt-1 ${tone}">${value}</div>${hint ? `<div class="text-xs text-gray-500 mt-1">${hint}</div>` : ""}</div>`;
  app.innerHTML =
    pageHeader(
      "Laporan Stok",
      `${searchBox(text, "Cari produk, lokasi, atau lot")}${filterSelect(FILTERS, filter)}
       <div class="inline-flex rounded-lg border border-gray-300 overflow-hidden bg-white text-sm">${Object.entries(MODES)
         .map(([key]) => `<a href="#/stock/${key}" class="px-3 py-2 ${key === mode ? "bg-indigo-600 text-white" : "hover:bg-gray-50"}">${MODE_LABEL[key]}</a>`)
         .join("")}</div>`,
    ) +
    (productId
      ? `<div class="mb-4 flex flex-wrap items-center justify-between gap-2 text-sm bg-indigo-50 border border-indigo-200 text-indigo-900 rounded-lg px-4 py-2"><span>Menampilkan stok produk <b>${esc(product?.display_name ?? `#${productId}`)}</b></span><a href="#/stock/${mode}" class="text-indigo-700 underline">Tampilkan semua produk</a></div>`
      : "") +
    `<div class="grid md:grid-cols-3 gap-4 mb-4">
      ${card("Nilai stok (barang di gudang)", esc(money(totalValue)), `${groups.size} ${mode === "report" ? "produk" : "lokasi"}, biaya rata-rata`)}
      ${card("Saldo akun Persediaan (buku besar)", esc(money(gl.balance)), "jurnal terposting pada akun persediaan")}
      ${card("Selisih stok terhadap buku besar", esc(money(difference)), Math.abs(difference) < 0.5 ? "sama" : "wajar untuk transaksi yang belum dijurnal pada saat terjadinya (sebelum jurnal per transaksi aktif, atau biaya standar); lihat Inventory Valuation per akun", Math.abs(difference) < 0.5 ? "text-emerald-700" : "text-amber-700")}
    </div>
    <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto">
      <table class="w-full text-left"><thead class="bg-gray-50 border-b border-gray-200"><tr>${[def.title, "Jumlah", "Terpesan", "Tersedia", "Nilai"]
        .map((h, i) => `<th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase ${i ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>
        ${rows || '<tbody><tr><td colspan="5" class="py-10 text-center text-sm text-gray-500">Tidak ada stok yang cocok.</td></tr></tbody>'}</table>
    </div>
    <p class="text-xs text-gray-500 mt-3">Klik baris untuk melihat rinciannya. Nilai memakai metode biaya kategori produk; hanya lokasi internal.${quants.length >= 1000 ? " Dibatasi 1.000 baris." : ""}</p>`;
}

/** Stok per gudang (D42): kelompok gudang -> produk -> lokasi. Jumlah, tersedia, dan nilai dari quant; akan masuk, akan keluar, dan
 *  prakiraan dari kuantitas produk berkonteks `warehouse_id` (hitungan Odoo atas penerimaan, pengiriman, dan transfer yang belum selesai). */
async function renderWarehouse(query) {
  const filter = query.get("state") ?? "";
  const text = query.get("q") ?? "";
  const domain = [["location_id.usage", "=", "internal"]];
  if (filter === "available") domain.push(["available_quantity", ">", 0]);
  else if (filter === "reserved") domain.push(["reserved_quantity", ">", 0]);
  else if (filter === "negative") domain.push(["quantity", "<", 0]);
  if (text) domain.push("|", "|", "|", ["product_id.name", "ilike", text], ["product_id.default_code", "ilike", text], ["location_id.complete_name", "ilike", text], ["lot_id.name", "ilike", text]);
  const [quants, transit, warehouses] = await Promise.all([
    searchRead("stock.quant", domain, ["product_id", "location_id", "lot_id", "quantity", "reserved_quantity", "available_quantity", "value", "product_uom_id", "warehouse_id"], { order: "product_id, location_id", limit: 2000 }),
    searchRead("stock.quant", [["location_id.usage", "=", "transit"], ["quantity", "!=", 0]], ["quantity"], { limit: 500 }),
    searchRead("stock.warehouse", [], ["display_name", "code"], { order: "name" }),
  ]);
  const blank = (name, uom) => ({ name, uom, qty: 0, reserved: 0, available: 0, value: 0, incoming: 0, outgoing: 0, forecast: null, rows: [] });
  const groups = new Map(warehouses.map((w) => [w.id, { label: w.display_name, products: new Map() }]));
  const loose = { label: "Di luar gudang", products: new Map() };
  for (const q of quants) {
    if (!q.quantity && !q.reserved_quantity) continue; // sisa quant nol (mis. setelah gudang dikosongkan) tidak perlu tampil
    let g = loose;
    if (q.warehouse_id) {
      if (!groups.has(q.warehouse_id[0])) groups.set(q.warehouse_id[0], { label: q.warehouse_id[1], products: new Map() });
      g = groups.get(q.warehouse_id[0]);
    }
    if (!g.products.has(q.product_id[0])) g.products.set(q.product_id[0], blank(q.product_id[1], q.product_uom_id?.[1] ?? ""));
    const p = g.products.get(q.product_id[0]);
    p.qty += q.quantity;
    p.reserved += q.reserved_quantity;
    p.available += q.available_quantity;
    p.value += q.value;
    p.rows.push(q);
  }
  // pesanan dan transfer yang akan datang, per gudang (satu pembacaan produk per gudang)
  const productDomain = [["is_storable", "=", true], "|", "|", ["qty_available", "!=", 0], ["incoming_qty", "!=", 0], ["outgoing_qty", "!=", 0]];
  if (text) productDomain.push("|", ["name", "ilike", text], ["default_code", "ilike", text]);
  await Promise.all(
    warehouses.map(async (w) => {
      const g = groups.get(w.id);
      const rows = await searchRead("product.product", productDomain, ["display_name", "uom_id", "incoming_qty", "outgoing_qty", "virtual_available"], { context: { warehouse_id: w.id }, limit: 2000 });
      for (const r of rows) {
        let p = g.products.get(r.id);
        if (!p) {
          if (filter) continue; // filter stok hanya menyaring baris yang punya stok
          p = blank(r.display_name, r.uom_id?.[1] ?? "");
          g.products.set(r.id, p);
        }
        p.incoming = r.incoming_qty;
        p.outgoing = r.outgoing_qty;
        p.forecast = r.virtual_available;
      }
    }),
  );
  const forecastOf = (p) => p.forecast ?? p.qty;
  const sum = (g, pick) => [...g.products.values()].reduce((s, p) => s + pick(p), 0);
  const totalQty = quants.reduce((s, q) => s + q.quantity, 0);
  const totalValue = quants.reduce((s, q) => s + q.value, 0);
  const transitQty = transit.reduce((s, q) => s + q.quantity, 0);
  const visible = [...groups.entries()].filter(([id, g]) => g.products.size || warehouses.some((w) => w.id === id));
  if (loose.products.size) visible.push(["x", loose]);
  const cells = (values, extra = "") => values.map((v, i) => `<td class="py-2 px-4 text-sm text-right tabular-nums ${i === 0 ? extra : ""}">${nf.format(v)}</td>`).join("");
  const rows = visible
    .map(([id, g]) => {
      const detail = [...g.products.values()]
        .map(
          (p) => `<tr class="bg-gray-50"><td class="py-2 pl-8 pr-4 text-sm font-medium text-gray-800">${esc(p.name)} <span class="text-xs text-gray-500">${esc(p.uom)}</span></td>
            ${cells([p.qty, p.available, p.incoming, p.outgoing, forecastOf(p)], p.qty < 0 ? "text-rose-700" : "")}<td class="py-2 px-4 text-sm text-right tabular-nums">${esc(money(p.value))}</td></tr>
            ${p.rows.map((q) => `<tr class="bg-gray-50"><td class="py-1 pl-14 pr-4 text-xs text-gray-600">${esc(q.location_id[1])}${q.lot_id ? ` · <a href="#/lot/${q.lot_id[0]}" class="text-indigo-700 hover:underline">${esc(q.lot_id[1])}</a>` : ""}</td>
              <td class="py-1 px-4 text-xs text-right text-gray-600 tabular-nums">${nf.format(q.quantity)}</td><td class="py-1 px-4 text-xs text-right text-gray-600 tabular-nums">${nf.format(q.available_quantity)}</td><td></td><td></td><td></td>
              <td class="py-1 px-4 text-xs text-right text-gray-600 tabular-nums">${esc(money(q.value))}</td></tr>`).join("")}`,
        )
        .join("");
      return `<tbody class="divide-y divide-gray-100 border-b border-gray-200" data-group="w${id}">
        <tr class="hover:bg-gray-50 cursor-pointer" data-action="toggle-group" data-key="w${id}"><td class="py-3 px-4 text-sm"><span class="font-medium text-indigo-700">${esc(g.label)}</span> <span class="text-xs text-gray-500">${g.products.size} produk</span></td>
          ${cells([sum(g, (p) => p.qty), sum(g, (p) => p.available), sum(g, (p) => p.incoming), sum(g, (p) => p.outgoing), sum(g, forecastOf)])}<td class="py-2 px-4 text-sm text-right tabular-nums font-medium">${esc(money(sum(g, (p) => p.value)))}</td></tr>
        <template data-detail="w${id}">${detail}</template></tbody>`;
    })
    .join("");
  const card = (label, value, hint = "") =>
    `<div class="bg-white rounded-xl border border-gray-200 shadow-sm p-4"><div class="text-xs font-medium text-gray-500 uppercase">${label}</div><div class="text-xl font-semibold mt-1">${value}</div>${hint ? `<div class="text-xs text-gray-500 mt-1">${hint}</div>` : ""}</div>`;
  const groupTotal = visible.reduce((s, [, g]) => s + sum(g, (p) => p.qty), 0);
  app.innerHTML =
    pageHeader(
      "Laporan Stok",
      `${searchBox(text, "Cari produk, lokasi, atau lot")}${filterSelect(FILTERS, filter)}
       <div class="inline-flex rounded-lg border border-gray-300 overflow-hidden bg-white text-sm">${Object.keys(MODES)
         .map((key) => `<a href="#/stock/${key}" class="px-3 py-2 ${key === "warehouse" ? "bg-indigo-600 text-white" : "hover:bg-gray-50"}">${MODE_LABEL[key]}</a>`)
         .join("")}</div>`,
    ) +
    `<div class="grid md:grid-cols-3 gap-4 mb-4" id="wh-cards">
      ${card("Total stok semua gudang", esc(nf.format(totalQty)), `${visible.filter(([, g]) => g.products.size).length} gudang berisi stok, nilai ${esc(money(totalValue))}`)}
      ${card("Jumlah per gudang", esc(nf.format(groupTotal)), Math.abs(groupTotal - totalQty) < 0.0005 ? "sama dengan total keseluruhan" : "tidak sama dengan total: periksa lokasi di luar gudang")}
      ${card("Dalam transit antar gudang", esc(nf.format(transitQty)), "sudah keluar dari gudang pemasok tetapi belum diterima; tidak masuk stok gudang mana pun")}
    </div>
    <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto">
      <table class="w-full text-left"><thead class="bg-gray-50 border-b border-gray-200"><tr>${["Gudang / Produk / Lokasi", "Jumlah", "Tersedia", "Akan Masuk", "Akan Keluar", "Prakiraan", "Nilai"]
        .map((h, i) => `<th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase ${i ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>
        ${rows || '<tbody><tr><td colspan="7" class="py-10 text-center text-sm text-gray-500">Tidak ada stok yang cocok.</td></tr></tbody>'}</table>
    </div>
    <p class="text-xs text-gray-500 mt-3">Klik gudang untuk melihat produk dan lokasinya. Tersedia = jumlah dikurangi terpesan. Akan masuk dan akan keluar dihitung Odoo dari penerimaan, pengiriman, dan transfer yang belum selesai; prakiraan = jumlah + masuk - keluar.${quants.length >= 2000 ? " Dibatasi 2.000 baris." : ""}</p>`;
}

export function onClick(event, el) {
  if (el.dataset.action !== "toggle-group") return;
  const body = el.closest("tbody");
  const open = body.querySelector("[data-opened]");
  if (open) {
    body.querySelectorAll("[data-opened]").forEach((row) => row.remove());
    return;
  }
  const template = body.querySelector(`template[data-detail="${el.dataset.key}"]`);
  const holder = document.createElement("tbody");
  holder.innerHTML = template.innerHTML;
  [...holder.rows].forEach((row) => {
    row.dataset.opened = "1";
    body.append(row);
  });
}
