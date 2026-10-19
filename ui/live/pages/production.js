// Production Analysis: ringkasan produksi dari Manufacturing Order yang selesai pada rentang tanggal, per produk dan per
// bulan, dengan nilai barang jadi dan biaya komponen dari pergerakan stok.
import { INPUT, app, esc, money, pageHeader, searchRead, dayBoundary } from "../common.js";

const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 });
const pad = (n) => String(n).padStart(2, "0");
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

let last = { sub: "", query: new URLSearchParams() };
export const leave = () => {};

export async function render(sub, query) {
  last = { sub, query };
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat analisis...</p>';
  const from = query.get("from") ?? "";
  const to = query.get("to") ?? "";
  const range = [];
  if (from) range.push(["date_finished", ">=", dayBoundary(from)]);
  if (to) range.push(["date_finished", "<=", dayBoundary(to, true)]);
  const [done, open, cancelled] = await Promise.all([
    searchRead("mrp.production", [["state", "=", "done"], ...range], ["name", "product_id", "product_qty", "date_finished", "duration"], { order: "date_finished", limit: 1000 }),
    searchRead("mrp.production", [["state", "in", ["draft", "confirmed", "progress", "to_close"]]], ["id"], { limit: 1000 }),
    searchRead("mrp.production", [["state", "=", "cancel"]], ["id"], { limit: 1000 }),
  ]);
  const ids = done.map((m) => m.id);
  const [finished, raw] = ids.length
    ? await Promise.all([
        searchRead("stock.move", [["production_id", "in", ids], ["state", "=", "done"]], ["production_id", "product_id", "value", "quantity", "byproduct_id"], { limit: 5000 }),
        searchRead("stock.move", [["raw_material_production_id", "in", ids], ["state", "=", "done"]], ["raw_material_production_id", "value"], { limit: 5000 }),
      ])
    : [[], []];
  const byProduct = new Map();
  for (const m of done) {
    const key = m.product_id[0];
    if (!byProduct.has(key)) byProduct.set(key, { name: m.product_id[1], orders: 0, qty: 0, value: 0, cost: 0 });
    const g = byProduct.get(key);
    g.orders += 1;
    g.qty += m.product_qty;
  }
  const moProduct = new Map(done.map((m) => [m.id, m.product_id[0]]));
  for (const mv of finished) {
    const key = moProduct.get(mv.production_id[0]);
    if (key && mv.product_id[0] === key) byProduct.get(key).value += Math.abs(mv.value);
  }
  for (const mv of raw) {
    const key = moProduct.get(mv.raw_material_production_id[0]);
    if (key) byProduct.get(key).cost += Math.abs(mv.value);
  }
  const byMonth = new Map();
  for (const m of done) {
    const d = new Date(`${m.date_finished.replace(" ", "T")}Z`);
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    if (!byMonth.has(key)) byMonth.set(key, { label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`, orders: 0, qty: 0 });
    const g = byMonth.get(key);
    g.orders += 1;
    g.qty += m.product_qty;
  }
  const totalQty = done.reduce((s, m) => s + m.product_qty, 0);
  const totalValue = [...byProduct.values()].reduce((s, g) => s + g.value, 0);
  const card = (label, value, hint = "") =>
    `<div class="bg-white rounded-xl border border-gray-200 shadow-sm p-4"><div class="text-xs font-medium text-gray-500 uppercase">${label}</div><div class="text-xl font-semibold mt-1">${esc(value)}</div>${hint ? `<div class="text-xs text-gray-500 mt-1">${esc(hint)}</div>` : ""}</div>`;
  const head = (labels, right = []) => `<thead class="bg-gray-50"><tr>${labels.map((h, i) => `<th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase ${right.includes(i) ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>`;
  const productRows = [...byProduct.entries()]
    .sort((a, b) => b[1].value - a[1].value)
    .map(
      ([id, g]) => `<tr class="hover:bg-gray-50 cursor-pointer" data-action="goto" data-href="#/mo?product=${id}&state=done"><td class="py-2 px-4 text-sm font-medium text-indigo-700">${esc(g.name)}</td>
        <td class="py-2 px-4 text-sm text-right tabular-nums">${g.orders}</td><td class="py-2 px-4 text-sm text-right tabular-nums">${nf.format(g.qty)}</td>
        <td class="py-2 px-4 text-sm text-right tabular-nums">${esc(money(g.cost))}</td><td class="py-2 px-4 text-sm text-right tabular-nums">${esc(money(g.value))}</td>
        <td class="py-2 px-4 text-sm text-right tabular-nums">${esc(money(g.qty ? g.value / g.qty : 0))}</td></tr>`,
    )
    .join("");
  const monthRows = [...byMonth.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([, g]) => `<tr><td class="py-2 px-4 text-sm">${esc(g.label)}</td><td class="py-2 px-4 text-sm text-right tabular-nums">${g.orders}</td><td class="py-2 px-4 text-sm text-right tabular-nums">${nf.format(g.qty)}</td></tr>`)
    .join("");
  app.innerHTML =
    pageHeader(
      "Production Analysis",
      `<label class="text-xs font-medium text-gray-500 uppercase">Dari<input type="date" data-range="from" value="${esc(from)}" class="${INPUT} mt-1 w-40"></label>
       <label class="text-xs font-medium text-gray-500 uppercase">Sampai<input type="date" data-range="to" value="${esc(to)}" max="${today()}" class="${INPUT} mt-1 w-40"></label>`,
    ) +
    `<div class="grid md:grid-cols-4 gap-4 mb-4">
      ${card("MO selesai", String(done.length), from || to ? "pada rentang tanggal" : "semua waktu")}
      ${card("Unit diproduksi", nf.format(totalQty))}
      ${card("Nilai barang jadi", money(totalValue), "dari pergerakan stok")}
      ${card("MO belum selesai", String(open.length), `${cancelled.length} dibatalkan`)}</div>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 mb-4 overflow-x-auto"><div class="px-4 py-3 border-b border-gray-200 text-sm font-semibold">Per Produk</div>
      <table class="w-full text-left">${head(["Produk", "MO", "Unit", "Biaya Komponen", "Nilai Barang Jadi", "Nilai per Unit"], [1, 2, 3, 4, 5])}<tbody class="divide-y divide-gray-100">${productRows || '<tr><td colspan="6" class="py-6 text-center text-sm text-gray-500">Belum ada produksi selesai pada rentang ini.</td></tr>'}</tbody></table></section>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto"><div class="px-4 py-3 border-b border-gray-200 text-sm font-semibold">Per Bulan</div>
      <table class="w-full text-left">${head(["Bulan", "MO", "Unit"], [1, 2])}<tbody class="divide-y divide-gray-100">${monthRows || '<tr><td colspan="3" class="py-6 text-center text-sm text-gray-500">Belum ada data.</td></tr>'}</tbody></table></section>
    <p class="text-xs text-gray-500 mt-3">Berdasarkan tanggal selesai. Nilai diambil dari pergerakan stok, bukan dari jurnal. Nilai barang jadi mencakup biaya operasi work center (durasi dikali biaya per jam) dan dikurangi porsi produk sampingan, sehingga bisa melebihi biaya komponen.${done.length >= 1000 ? " Dibatasi 1.000 MO." : ""}</p>`;
}

export function onChange(event, el) {
  if (!el.dataset.range) return;
  const params = new URLSearchParams(last.query);
  if (el.value) params.set(el.dataset.range, el.value);
  else params.delete(el.dataset.range);
  const qs = params.toString();
  location.hash = `#/production${qs ? `?${qs}` : ""}`;
}
