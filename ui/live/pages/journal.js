// Jurnal Entry (account.move, semua jenis). Halaman baca-saja untuk memeriksa jurnal yang tercipta pada tiap
// tahap transaksi: tagihan vendor (hutang usaha dan pajak masukan), pembayaran (akun pembayaran tertunda),
// aset (penyusutan), dan valuasi persediaan. Setiap jurnal menunjuk ke dokumen sumbernya.
import {
  app, badge, cell, dateText, esc, fieldBlock, filterSelect, journalHtml, loadJournalItems, money, pageHeader, readOne, readonlyValue, rowLink,
  searchBox, searchRead, statTiles, table,
} from "../common.js";
import { analyticSummary, preloadAnalytic } from "../analyticpick.js";

const STATES = {
  draft: ["Draft", "muted"],
  posted: ["Terposting", "success"],
  cancel: ["Dibatalkan", "danger"],
};
const TYPES = {
  entry: "Jurnal Umum / Pembayaran", in_invoice: "Tagihan Vendor", in_refund: "Nota Debit Vendor", out_invoice: "Faktur Pelanggan",
  out_refund: "Nota Kredit Pelanggan", in_receipt: "Kuitansi Pembelian", out_receipt: "Kuitansi Penjualan",
};
const FILTERS = [["", "Semua jurnal"], ["draft", "Draft"], ["posted", "Terposting"], ["bills", "Tagihan vendor"], ["entries", "Jurnal umum dan pembayaran"]];

let last = { sub: "", query: new URLSearchParams() };

export async function render(sub, query) {
  last = { sub, query };
  if (sub === "") return renderList(query);
  return renderForm(Number(sub));
}

async function renderList(query) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const filter = query.get("state") ?? "";
  const text = query.get("q") ?? "";
  const domain = [];
  if (filter === "draft" || filter === "posted") domain.push(["state", "=", filter]);
  else if (filter === "bills") domain.push(["move_type", "=", "in_invoice"]);
  else if (filter === "entries") domain.push(["move_type", "=", "entry"]);
  if (text) domain.push("|", "|", ["name", "ilike", text], ["ref", "ilike", text], ["partner_id.name", "ilike", text]);
  const rows = await searchRead("account.move", domain, ["name", "date", "journal_id", "ref", "partner_id", "move_type", "amount_total", "currency_id", "state"], {
    order: "date desc, id desc", limit: 100,
  });
  const body = rows
    .map((r) =>
      rowLink(`#/journal/${r.id}`, [
        cell(r.name || "Draft", { strong: true }),
        cell(dateText(r.date)),
        cell(r.journal_id?.[1] ?? ""),
        cell(r.partner_id?.[1] || r.ref || "-"),
        cell(TYPES[r.move_type] ?? r.move_type),
        cell(money(r.amount_total, r.currency_id?.[1]), { right: true }),
        cell(badge(STATES, r.state), { raw: true }),
      ]),
    )
    .join("");
  app.innerHTML =
    pageHeader(
      "Jurnal Entry",
      `${searchBox(text, "Cari nomor, referensi, mitra")}${filterSelect(FILTERS, filter)}
       <button data-action="refresh" class="px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50" aria-label="Muat ulang"><i class="fas fa-rotate"></i></button>`,
    ) +
    table(
      [{ label: "Nomor" }, { label: "Tanggal" }, { label: "Jurnal" }, { label: "Mitra / Referensi" }, { label: "Jenis" }, { label: "Total", right: true }, { label: "Status" }],
      body,
      "Belum ada jurnal. Jurnal tercipta saat tagihan vendor diposting dan saat pembayaran dibuat.",
    );
}

/** Dokumen yang menghasilkan jurnal ini, dicari dari sisi dokumennya karena account.move tidak menyimpannya langsung. */
async function sourceLinks(move) {
  const links = [];
  if (move.move_type === "in_invoice") links.push({ label: `Tagihan Vendor ${move.name}`, href: `#/bill/${move.id}`, icon: "fa-file-invoice" });
  const [payments, stock] = await Promise.all([
    searchRead("account.payment", [["move_id", "=", move.id]], ["name"], { limit: 1 }),
    searchRead("stock.move", [["account_move_id", "=", move.id]], ["picking_id"], { limit: 1 }),
  ]);
  for (const p of payments) links.push({ label: `Pembayaran ${p.name}`, href: `#/payment/${p.id}`, icon: "fa-money-bill" });
  for (const s of stock) if (s.picking_id) links.push({ label: `Penerimaan ${s.picking_id[1]}`, href: `#/receipt/${s.picking_id[0]}`, icon: "fa-boxes" });
  return links;
}

async function renderForm(id) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const move = await readOne("account.move", id, ["name", "state", "move_type", "date", "ref", "partner_id", "journal_id", "currency_id", "amount_total"]);
  if (!move) {
    app.innerHTML = '<p class="text-sm text-rose-600">Jurnal tidak ditemukan.</p>';
    return;
  }
  const [items, links, analytic] = await Promise.all([loadJournalItems(id), sourceLinks(move), analyticItems(id)]);
  const currency = move.currency_id?.[1];
  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/journal" class="hover:text-indigo-600">Jurnal Entry</a> / ${esc(move.name || "Draft")}</div>
    <div class="flex flex-wrap gap-2 mb-4">${statTiles(links.map((l) => ({ count: 1, label: l.label, icon: l.icon, href: l.href })))}</div>
    <div class="mb-3"><h1 class="text-2xl font-bold text-gray-900">${esc(move.name || "Draft")}</h1><div class="mt-2">${badge(STATES, move.state)}</div></div>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-2 gap-x-8 gap-y-4">
      ${fieldBlock("Jenis", readonlyValue(TYPES[move.move_type] ?? move.move_type))}
      ${fieldBlock("Jurnal", readonlyValue(move.journal_id?.[1]))}
      ${fieldBlock("Tanggal", readonlyValue(dateText(move.date)))}
      ${fieldBlock("Referensi", readonlyValue(move.ref))}
      ${fieldBlock("Mitra", readonlyValue(move.partner_id?.[1]))}
      ${fieldBlock("Total", readonlyValue(money(move.amount_total, currency)))}
    </section>
    ${journalHtml(items, currency, { journal: move.journal_id?.[1], state: move.state })}${analyticSection(analytic, currency)}`;
}

/** Item jurnal yang membawa distribusi analitik (dibaca saja di sini; diubah pada baris dokumen sumbernya). */
async function analyticItems(moveId) {
  await preloadAnalytic();
  const items = await searchRead("account.move.line", [["move_id", "=", moveId]], ["account_id", "name", "debit", "credit", "analytic_distribution"], { order: "id" });
  return items.filter((l) => l.analytic_distribution && Object.keys(l.analytic_distribution).length);
}

function analyticSection(items, currency) {
  if (!items.length) return "";
  const rows = items
    .map(
      (l) => `<tr><td class="py-2 px-4 text-sm">${esc(l.account_id?.[1])}</td><td class="py-2 px-4 text-sm">${esc(l.name || "")}</td>
        <td class="py-2 px-4 text-sm">${esc(analyticSummary(l.analytic_distribution))}</td>
        <td class="py-2 px-4 text-sm text-right">${money(l.debit - l.credit, currency)}</td></tr>`,
    )
    .join("");
  return `<section id="analytic-items" class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 overflow-x-auto">
    <div class="px-4 py-3 border-b border-gray-200 text-sm font-semibold">Distribusi Analitik</div>
    <table class="w-full text-left"><thead class="bg-gray-50"><tr>${["Akun", "Label", "Analitik", "Debit - Kredit"]
      .map((h, i) => `<th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase ${i === 3 ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>
      <tbody class="divide-y divide-gray-100">${rows}</tbody></table></section>`;
}

export function onClick(event, el) {
  if (el.dataset.action === "refresh") render(last.sub, last.query);
}
