// Umur piutang dan umur hutang (account.move.line yang belum direkonsiliasi), per mitra dan per kelompok umur.
// Umur dihitung dari tanggal jatuh tempo terhadap tanggal laporan; sisa tagihan sudah memperhitungkan pembayaran
// sebagian (amount_residual). Klik baris mitra untuk melihat dokumennya.
import { INPUT, app, dateText, esc, openModal, pageHeader, searchRead } from "../common.js";

const KINDS = {
  receivable: { title: "Umur Piutang", account: "asset_receivable", partner: "Pelanggan", sign: 1, doc: "Faktur", route: "invoice" },
  payable: { title: "Umur Hutang", account: "liability_payable", partner: "Pemasok", sign: -1, doc: "Tagihan", route: "bill" },
};
const BUCKETS = [
  ["Belum jatuh tempo", (d) => d <= 0],
  ["1–30 hari", (d) => d >= 1 && d <= 30],
  ["31–60 hari", (d) => d >= 31 && d <= 60],
  ["61–90 hari", (d) => d >= 61 && d <= 90],
  ["Lebih dari 90 hari", (d) => d > 90],
];

const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 });
const num = (v) => (Math.round(v) === 0 ? "0" : v < 0 ? `(${nf.format(Math.abs(v))})` : nf.format(v));
const day = (text) => {
  const [y, m, d] = text.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
};
const todayText = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

let last = { sub: "", query: new URLSearchParams() };
let groups = new Map(); // partner id -> { name, lines, buckets }
export const leave = () => {
  groups = new Map();
};

export async function render(sub, query) {
  last = { sub, query };
  const kind = KINDS[sub];
  if (!kind) {
    app.innerHTML = '<p class="text-sm text-rose-600">Laporan tidak ditemukan.</p>';
    return;
  }
  app.innerHTML = '<p class="text-sm text-gray-500">Menghitung umur...</p>';
  const asof = query.get("asof") || todayText();
  const lines = await searchRead(
    "account.move.line",
    [
      ["parent_state", "=", "posted"], ["account_id.account_type", "=", kind.account], ["reconciled", "=", false], ["amount_residual", "!=", 0],
      ["partner_id", "!=", false], ["date", "<=", asof],
    ],
    ["partner_id", "move_id", "name", "date", "date_maturity", "amount_residual", "currency_id"],
    { order: "date, id", limit: 3000 },
  );
  groups = new Map();
  const totals = BUCKETS.map(() => 0);
  for (const line of lines) {
    const amount = line.amount_residual * kind.sign;
    const days = day(asof) - day(line.date_maturity || line.date);
    const bucket = BUCKETS.findIndex(([, test]) => test(days));
    const [pid, pname] = line.partner_id;
    if (!groups.has(pid)) groups.set(pid, { name: pname, lines: [], buckets: BUCKETS.map(() => 0) });
    const group = groups.get(pid);
    group.buckets[bucket] += amount;
    group.lines.push({ ...line, amount, days });
    totals[bucket] += amount;
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].buckets.reduce((s, v) => s + v, 0) - a[1].buckets.reduce((s, v) => s + v, 0));
  const rows = ordered
    .map(([pid, g]) => {
      const total = g.buckets.reduce((s, v) => s + v, 0);
      return `<tr class="hover:bg-gray-50 cursor-pointer" data-action="aging-open" data-partner="${pid}">
        <td class="py-2 px-4 text-sm font-medium text-indigo-700">${esc(g.name)}</td>
        ${g.buckets.map((v) => `<td class="py-2 px-4 text-sm text-right tabular-nums">${v ? num(v) : ""}</td>`).join("")}
        <td class="py-2 px-4 text-sm text-right tabular-nums font-semibold">${num(total)}</td></tr>`;
    })
    .join("");
  const grand = totals.reduce((s, v) => s + v, 0);
  app.innerHTML =
    pageHeader(
      kind.title,
      `<form data-form="asof" class="flex flex-wrap items-end gap-3">
         <label class="text-xs font-medium text-gray-500 uppercase">Per tanggal<input type="date" data-asof value="${esc(asof)}" class="${INPUT} mt-1 w-44"></label>
         <button type="submit" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Tampilkan</button>
       </form>`,
    ) +
    `<div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto">
      <table class="w-full text-left"><thead class="bg-gray-50 border-b border-gray-200"><tr>
        <th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase">${kind.partner}</th>
        ${BUCKETS.map(([label]) => `<th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase text-right">${label}</th>`).join("")}
        <th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase text-right">Total</th></tr></thead>
        <tbody class="divide-y divide-gray-100">${rows || `<tr><td colspan="7" class="py-10 text-center text-sm text-gray-500">Tidak ada ${kind.doc.toLowerCase()} terbuka pada tanggal ini.</td></tr>`}</tbody>
        <tfoot class="bg-gray-50 font-semibold"><tr><td class="py-2 px-4 text-sm">Total</td>${totals.map((v) => `<td class="py-2 px-4 text-sm text-right tabular-nums">${num(v)}</td>`).join("")}<td class="py-2 px-4 text-sm text-right tabular-nums">${num(grand)}</td></tr></tfoot></table>
    </div>
    <p class="text-xs text-gray-500 mt-3">Hanya entri terposting yang belum direkonsiliasi penuh. Kelompok umur menurut jatuh tempo; nota kredit dan pembayaran di muka mengurangi total mitra. ${lines.length >= 3000 ? "Dibatasi 3.000 item jurnal." : ""}</p>`;
}

function openPartner(button, id) {
  const kind = KINDS[last.sub];
  const group = groups.get(id);
  if (!group) return;
  const rows = group.lines
    .map(
      (l) => `<tr><td class="py-2 px-3 text-sm"><a href="#/${kind.route}/${l.move_id[0]}" data-action="modal-close" class="text-indigo-700 hover:underline">${esc(l.move_id[1])}</a></td>
        <td class="py-2 px-3 text-sm whitespace-nowrap">${esc(dateText(l.date))}</td><td class="py-2 px-3 text-sm whitespace-nowrap">${l.date_maturity ? esc(dateText(l.date_maturity)) : "-"}</td>
        <td class="py-2 px-3 text-sm text-right">${l.days > 0 ? l.days : "-"}</td><td class="py-2 px-3 text-sm text-right tabular-nums">${num(l.amount)}</td></tr>`,
    )
    .join("");
  openModal(
    group.name,
    `<div class="overflow-x-auto max-h-[60vh] overflow-y-auto"><table class="w-full text-left"><thead class="bg-gray-50"><tr>${[kind.doc, "Tanggal", "Jatuh Tempo", "Hari", "Sisa"]
      .map((h, i) => `<th class="py-2 px-3 text-xs font-semibold text-gray-600 uppercase ${i > 2 ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>
      <tbody class="divide-y divide-gray-100">${rows}</tbody></table></div>`,
    '<button data-action="modal-close" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Tutup</button>',
    null,
    { wide: true },
  );
}

export async function onClick(event, el) {
  if (el.dataset.action === "aging-open") openPartner(el, Number(el.dataset.partner));
}

export function onSubmit(event, form, kind) {
  if (kind !== "asof") return;
  const asof = document.querySelector("[data-asof]").value;
  const target = `#/aging/${last.sub}${asof ? `?asof=${asof}` : ""}`;
  if (location.hash === target) render(last.sub, new URLSearchParams(asof ? { asof } : {}));
  else location.hash = target;
}
