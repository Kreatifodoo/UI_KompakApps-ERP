// Buku Besar (per akun) dan Buku Besar Pembantu / Partner Ledger (per mitra): item jurnal terposting pada rentang
// tanggal, dengan saldo awal dan saldo berjalan. Saldo awal dihitung Odoo (formatted_read_group), bukan dijumlah di browser.
import {
  INPUT, app, call, dateText, esc, pageHeader, registerLookup, runLookup, searchAccounts, searchRead, ACCOUNT_TYPE_LABELS,
} from "../common.js";

const MODES = {
  general: { title: "Buku Besar", subject: "Akun", lookup: "ledger-account", placeholder: "Cari kode atau nama akun...", field: "account_id" },
  partner: { title: "Buku Besar Pembantu (Partner Ledger)", subject: "Mitra", lookup: "ledger-partner", placeholder: "Cari pelanggan atau pemasok...", field: "partner_id" },
};
const LIMIT = 1000;
const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 });
const num = (v) => (Math.round(v) === 0 ? "0" : v < 0 ? `(${nf.format(Math.abs(v))})` : nf.format(v));
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

let chosen = null; // { id, display_name }
let last = { sub: "", query: new URLSearchParams() };
export const leave = () => {
  chosen = null;
};

registerLookup("ledger-account", {
  search: (q) => searchAccounts(q),
  sub: (r) => ACCOUNT_TYPE_LABELS[r.account_type] ?? "",
  isChosen: (input) => chosen?.display_name === input.value,
  choose: (input, item) => {
    chosen = item;
    input.value = item.display_name;
  },
});
registerLookup("ledger-partner", {
  search: (q) => searchRead("res.partner", q ? [["name", "ilike", q]] : [], ["display_name"], { limit: 10, order: "name" }),
  isChosen: (input) => chosen?.display_name === input.value,
  choose: (input, item) => {
    chosen = item;
    input.value = item.display_name;
  },
});

export async function render(sub, query) {
  last = { sub, query };
  const mode = MODES[sub];
  if (!mode) {
    app.innerHTML = '<p class="text-sm text-rose-600">Laporan tidak ditemukan.</p>';
    return;
  }
  const now = new Date();
  const from = query.get("from") || iso(new Date(now.getFullYear(), 0, 1));
  const to = query.get("to") || iso(now);
  const subjectId = Number(query.get("id")) || null;
  if (subjectId && chosen?.id !== subjectId) {
    const [row] = await searchRead(mode.field === "account_id" ? "account.account" : "res.partner", [["id", "=", subjectId]], ["display_name"], { limit: 1 });
    chosen = row ?? null;
  }
  if (!subjectId) chosen = null;

  let body = '<p class="text-sm text-gray-500 mt-4">Pilih akun atau mitra, lalu tekan Tampilkan.</p>';
  if (chosen) {
    const base = [["parent_state", "=", "posted"], [mode.field, "=", chosen.id]];
    if (mode.field === "partner_id") base.push(["account_id.account_type", "in", ["asset_receivable", "liability_payable"]]);
    const [opening] = await call("account.move.line", "formatted_read_group", {
      domain: [...base, ["date", "<", from]], groupby: [], aggregates: ["balance:sum"],
    });
    const start = opening?.["balance:sum"] || 0;
    const lines = await searchRead(
      "account.move.line", [...base, ["date", ">=", from], ["date", "<=", to]],
      ["date", "move_id", "account_id", "partner_id", "name", "debit", "credit"],
      { order: "date, id", limit: LIMIT },
    );
    let running = start;
    const rows = lines
      .map((l) => {
        running += l.debit - l.credit;
        return `<tr><td class="py-2 px-4 text-sm whitespace-nowrap">${esc(dateText(l.date))}</td>
          <td class="py-2 px-4 text-sm"><a href="#/journal/${l.move_id[0]}" class="text-indigo-700 hover:underline">${esc(l.move_id[1])}</a></td>
          <td class="py-2 px-4 text-sm">${esc(mode.field === "partner_id" ? l.account_id[1] : l.partner_id?.[1] ?? "")}</td><td class="py-2 px-4 text-sm">${esc(l.name || "")}</td>
          <td class="py-2 px-4 text-sm text-right tabular-nums">${l.debit ? num(l.debit) : ""}</td><td class="py-2 px-4 text-sm text-right tabular-nums">${l.credit ? num(l.credit) : ""}</td>
          <td class="py-2 px-4 text-sm text-right tabular-nums">${num(running)}</td></tr>`;
      })
      .join("");
    const debit = lines.reduce((s, l) => s + l.debit, 0);
    const credit = lines.reduce((s, l) => s + l.credit, 0);
    body = `<div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto mt-4">
      <table class="w-full text-left"><thead class="bg-gray-50 border-b border-gray-200"><tr>${["Tanggal", "Jurnal", mode.field === "partner_id" ? "Akun" : "Mitra", "Label", "Debit", "Kredit", "Saldo"]
        .map((h, i) => `<th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase ${i > 3 ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>
        <tbody class="divide-y divide-gray-100">
          <tr class="bg-gray-50 font-medium"><td class="py-2 px-4 text-sm" colspan="6">Saldo awal (sebelum ${esc(dateText(from))})</td><td class="py-2 px-4 text-sm text-right tabular-nums">${num(start)}</td></tr>
          ${rows || '<tr><td colspan="7" class="py-8 text-center text-sm text-gray-500">Tidak ada item jurnal pada rentang ini.</td></tr>'}
        </tbody>
        <tfoot class="bg-gray-50 font-semibold"><tr><td class="py-2 px-4 text-sm" colspan="4">Total mutasi${lines.length >= LIMIT ? ` (${LIMIT} baris pertama)` : ""}</td>
          <td class="py-2 px-4 text-sm text-right tabular-nums">${num(debit)}</td><td class="py-2 px-4 text-sm text-right tabular-nums">${num(credit)}</td><td class="py-2 px-4 text-sm text-right tabular-nums">${num(running)}</td></tr></tfoot></table></div>`;
  }
  app.innerHTML =
    pageHeader(mode.title) +
    `<section class="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
      <form data-form="ledger" class="flex flex-wrap items-end gap-3">
        <label class="text-xs font-medium text-gray-500 uppercase">${mode.subject}<input data-lookup="${mode.lookup}" autocomplete="off" role="combobox" aria-autocomplete="list" value="${esc(chosen?.display_name ?? "")}" placeholder="${mode.placeholder}" class="${INPUT} mt-1 w-80"></label>
        <label class="text-xs font-medium text-gray-500 uppercase">Dari<input type="date" data-ledger="from" value="${esc(from)}" class="${INPUT} mt-1 w-44"></label>
        <label class="text-xs font-medium text-gray-500 uppercase">Sampai<input type="date" data-ledger="to" value="${esc(to)}" class="${INPUT} mt-1 w-44"></label>
        <button type="submit" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Tampilkan</button>
      </form></section>${body}
    <p class="text-xs text-gray-500 mt-3">Hanya entri terposting. Saldo = debit dikurangi kredit; untuk hutang dan akun berkarakter kredit, saldo bertanda kurung berarti saldo kredit.</p>`;
}

export function onInput(event, el) {
  if (el.dataset.lookup === MODES[last.sub]?.lookup) {
    chosen = null;
    runLookup(el, 250);
  }
}

export function onSubmit(event, form, kind) {
  if (kind !== "ledger") return;
  if (!chosen) {
    app.querySelector("[data-lookup]")?.focus();
    return;
  }
  const params = new URLSearchParams({ id: chosen.id });
  for (const el of document.querySelectorAll("[data-ledger]")) if (el.value) params.set(el.dataset.ledger, el.value);
  const target = `#/ledger/${last.sub}?${params}`;
  if (location.hash === target) render(last.sub, params);
  else location.hash = target;
}
