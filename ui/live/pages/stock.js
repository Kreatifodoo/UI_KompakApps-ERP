// Laporan Stok (stock.quant): stok per produk dan per lokasi dengan jumlah, terpesan, tersedia, dan nilai (biaya
// rata-rata). Kartu atas membandingkan nilai stok dengan saldo akun Persediaan di buku besar: Odoo 19 tidak membuat
// jurnal untuk penyesuaian stok dan scrap pada valuasi perpetual, jadi selisihnya perlu dipantau.
import { app, call, esc, filterSelect, money, pageHeader, searchBox, searchRead } from "../common.js";

const MODES = {
  report: { title: "Stok per Produk", group: (q) => `p${q.product_id[0]}`, label: (q) => q.product_id[1], sub: (q) => q.product_categ_id?.[1] ?? "", detail: "location" },
  location: { title: "Stok per Lokasi", group: (q) => `l${q.location_id[0]}`, label: (q) => q.location_id[1], sub: () => "", detail: "product" },
};
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
  const filter = query.get("state") ?? "";
  const text = query.get("q") ?? "";
  const domain = [["location_id.usage", "=", "internal"]];
  if (filter === "available") domain.push(["available_quantity", ">", 0]);
  else if (filter === "reserved") domain.push(["reserved_quantity", ">", 0]);
  else if (filter === "negative") domain.push(["quantity", "<", 0]);
  if (text) domain.push("|", "|", ["product_id.name", "ilike", text], ["product_id.default_code", "ilike", text], ["location_id.complete_name", "ilike", text]);
  const [quants, gl] = await Promise.all([
    searchRead("stock.quant", domain, ["product_id", "location_id", "lot_id", "quantity", "reserved_quantity", "available_quantity", "value", "product_uom_id", "product_categ_id"], {
      order: "product_id, location_id", limit: 1000,
    }),
    glBalance(),
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
          (q) => `<tr class="bg-gray-50"><td class="py-2 pl-10 pr-4 text-sm text-gray-600" colspan="1">${esc(def.detail === "location" ? q.location_id[1] : q.product_id[1])}${q.lot_id ? ` · ${esc(q.lot_id[1])}` : ""}</td>
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
      `${searchBox(text, "Cari produk atau lokasi")}${filterSelect(FILTERS, filter)}
       <div class="inline-flex rounded-lg border border-gray-300 overflow-hidden bg-white text-sm">${Object.entries(MODES)
         .map(([key, m]) => `<a href="#/stock/${key}" class="px-3 py-2 ${key === mode ? "bg-indigo-600 text-white" : "hover:bg-gray-50"}">${key === "report" ? "Per produk" : "Per lokasi"}</a>`)
         .join("")}</div>`,
    ) +
    `<div class="grid md:grid-cols-3 gap-4 mb-4">
      ${card("Nilai stok (barang di gudang)", esc(money(totalValue)), `${groups.size} ${mode === "report" ? "produk" : "lokasi"}, biaya rata-rata`)}
      ${card("Saldo akun Persediaan (buku besar)", esc(money(gl.balance)), "dijurnal saat tagihan dan faktur diposting")}
      ${card("Selisih stok terhadap buku besar", esc(money(difference)), Math.abs(difference) < 0.5 ? "sama" : "wajar bila ada barang diterima yang belum ditagih, atau penyesuaian stok dan scrap (Odoo 19 tidak menjurnalnya otomatis)", Math.abs(difference) < 0.5 ? "text-emerald-700" : "text-amber-700")}
    </div>
    <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto">
      <table class="w-full text-left"><thead class="bg-gray-50 border-b border-gray-200"><tr>${[def.title, "Jumlah", "Terpesan", "Tersedia", "Nilai"]
        .map((h, i) => `<th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase ${i ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>
        ${rows || '<tbody><tr><td colspan="5" class="py-10 text-center text-sm text-gray-500">Tidak ada stok yang cocok.</td></tr></tbody>'}</table>
    </div>
    <p class="text-xs text-gray-500 mt-3">Klik baris untuk melihat rinciannya. Nilai memakai metode biaya kategori produk; hanya lokasi internal.${quants.length >= 1000 ? " Dibatasi 1.000 baris." : ""}</p>`;
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
