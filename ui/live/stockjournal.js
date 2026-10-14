// Panel "Jurnal terkait" pada Penerimaan, Pengiriman, dan Manufacturing Order. Odoo 19 memakai valuasi perpetual "saat penagihan":
// penerimaan, pengiriman, dan produksi tidak membuat jurnal sendiri. Nilainya tercatat pada pergerakan stok dan jurnal persediaan
// (Dr Persediaan atau Dr HPP) terbentuk saat tagihan vendor dan faktur pelanggan diposting. Panel ini menampilkan jurnal sungguhan itu
// bila sudah ada, dan menjelaskan kapan jurnalnya muncul bila belum.
import { esc, money, searchRead } from "./common.js";

const STATE = { posted: ["Terposting", "text-emerald-700"], draft: ["Draf (jurnal belum terbentuk)", "text-amber-700"], cancel: ["Dibatalkan", "text-gray-500"] };
const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 });

async function journalOf(move) {
  const lines = await searchRead("account.move.line", [["move_id", "=", move.id], ["display_type", "in", ["product", "cogs", "tax", "payment_term", "rounding"]]], ["account_id", "debit", "credit", "display_type"], { order: "debit desc, credit desc, id", limit: 14 });
  const [state, tone] = STATE[move.state] ?? [move.state, ""];
  const rows = lines
    .map((l) => `<tr><td class="py-1 pr-4 text-sm">${esc(l.account_id?.[1] ?? "")}${l.display_type === "cogs" ? ' <span class="text-xs text-gray-400">(HPP otomatis)</span>' : ""}</td>
      <td class="py-1 px-3 text-sm text-right tabular-nums">${l.debit ? nf.format(l.debit) : ""}</td><td class="py-1 pl-3 text-sm text-right tabular-nums">${l.credit ? nf.format(l.credit) : ""}</td></tr>`)
    .join("");
  return `<div class="mt-3"><div class="text-sm"><a href="#/journal/${move.id}" class="text-indigo-700 font-medium hover:underline">${esc(move.name && move.name !== "/" ? move.name : "Draf")}</a>
      <span class="${tone} ml-2">${esc(state)}</span></div>
    ${move.state === "posted" ? `<table class="mt-1 w-full max-w-2xl"><thead><tr><th class="text-left text-xs font-semibold text-gray-500 uppercase">Akun</th><th class="text-right text-xs font-semibold text-gray-500 uppercase px-3">Debit</th><th class="text-right text-xs font-semibold text-gray-500 uppercase pl-3">Kredit</th></tr></thead><tbody>${rows}</tbody></table>` : ""}</div>`;
}

const panel = (title, intro, body) =>
  `<section class="mt-4 bg-white rounded-xl shadow-sm border border-gray-200 p-4"><div class="text-sm font-semibold">${esc(title)}</div>
    <p class="mt-1 text-sm text-gray-600">${intro}</p>${body}</section>`;

/** Jurnal dari tagihan vendor milik PO penerimaan ini. */
export async function receiptJournals(pk, moves) {
  const value = moves.reduce((s, m) => s + Math.abs(m.value || 0), 0);
  const intro = `Penerimaan tidak membuat jurnal; nilai barang masuk ${money(value)} tercatat pada pergerakan stok. Jurnal persediaan (Dr Persediaan, Cr Hutang Usaha) terbentuk saat tagihan vendor diposting.`;
  if (!pk.purchase_id) return panel("Jurnal terkait", `${intro} Penerimaan ini tidak berasal dari Purchase Order, jadi tidak ada tagihan yang tertaut.`, "");
  const bills = await searchRead("account.move", [["move_type", "=", "in_invoice"], ["state", "!=", "cancel"], ["invoice_line_ids.purchase_line_id.order_id", "=", pk.purchase_id[0]]], ["name", "state"], { order: "id" });
  const body = bills.length
    ? (await Promise.all(bills.map(journalOf))).join("")
    : `<p class="mt-3 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">Belum ada tagihan vendor untuk <a href="#/po/${pk.purchase_id[0]}" class="underline">${esc(pk.purchase_id[1])}</a>, jadi jurnal persediaan belum terbentuk. Buat tagihan dari halaman PO atau Vendor Bills.</p>`;
  return panel("Jurnal terkait: tagihan vendor", intro, body);
}

/** Jurnal dari faktur pelanggan milik SO pengiriman ini, termasuk baris HPP otomatis. */
export async function deliveryJournals(pk, moves) {
  const value = moves.reduce((s, m) => s + Math.abs(m.value || 0), 0);
  const intro = `Pengiriman tidak membuat jurnal; nilai barang keluar ${money(value)} (biaya rata-rata) tercatat pada pergerakan stok. Harga pokok (Dr HPP, Cr Persediaan) terbentuk saat faktur pelanggan diposting.`;
  if (!pk.sale_id) return panel("Jurnal terkait", `${intro} Pengiriman ini tidak berasal dari Sales Order, jadi tidak ada faktur yang tertaut.`, "");
  const invoices = await searchRead("account.move", [["move_type", "=", "out_invoice"], ["state", "!=", "cancel"], ["invoice_line_ids.sale_line_ids.order_id", "=", pk.sale_id[0]]], ["name", "state"], { order: "id" });
  const body = invoices.length
    ? (await Promise.all(invoices.map(journalOf))).join("")
    : `<p class="mt-3 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">Belum ada faktur pelanggan untuk <a href="#/sale/${pk.sale_id[0]}" class="underline">${esc(pk.sale_id[1])}</a>, jadi jurnal HPP belum terbentuk. Buat faktur dari halaman Sales Order atau Customer Invoice.</p>`;
  return panel("Jurnal terkait: faktur pelanggan", intro, body);
}

/** Nilai pergerakan produksi, dan di mana jurnalnya muncul. */
export function productionJournals(mo, raw, finished) {
  const cost = raw.reduce((s, m) => s + Math.abs(m.value || 0), 0);
  const out = finished.reduce((s, m) => s + Math.abs(m.value || 0), 0);
  const rows = (list, label) => list.map((m) => `<tr><td class="py-1 pr-4 text-sm">${label} ${esc(m.product_id?.[1] ?? "")}</td><td class="py-1 px-3 text-sm text-right tabular-nums">${m.value ? nf.format(Math.abs(m.value)) : ""}</td></tr>`).join("");
  const done = mo.state === "done";
  return panel(
    "Nilai persediaan dan jurnal",
    `Produksi tidak membuat jurnal. Nilai komponen yang keluar (${money(cost)}) dan barang jadi yang masuk (${money(out)}, termasuk biaya operasi) tercatat pada pergerakan stok, bukan pada buku besar. Jurnal persediaan terbentuk saat barang jadi dijual (faktur: Dr HPP, Cr Persediaan) dan saat komponen dibeli (tagihan vendor).`,
    done
      ? `<table class="mt-3 w-full max-w-2xl"><thead><tr><th class="text-left text-xs font-semibold text-gray-500 uppercase">Pergerakan stok</th><th class="text-right text-xs font-semibold text-gray-500 uppercase px-3">Nilai</th></tr></thead>
         <tbody>${rows(raw, "Komponen keluar:")}${rows(finished, "Barang jadi masuk:")}</tbody></table>
         <p class="mt-2 text-sm"><a href="#/valuation/moves?product=${esc(mo.product_id?.[0] ?? "")}" class="text-indigo-700 underline">Lihat pergerakan bernilai produk ini di Inventory Valuation</a></p>`
      : '<p class="mt-3 text-sm text-gray-500">Nilai muncul setelah produksi diselesaikan.</p>',
  );
}

