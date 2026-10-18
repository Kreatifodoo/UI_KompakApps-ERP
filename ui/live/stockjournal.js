// Panel "Jurnal terkait" pada Penerimaan, Pengiriman, dan Manufacturing Order (D56, D69).
// Pada pola jurnal per transaksi (Q49) setiap pergerakan stok yang selesai dijurnal pada saat itu juga (`stock.move.account_move_id`) memakai akun dan
// jurnal dari Product Category: penerimaan Dr Persediaan, Cr Barang Diterima Belum Ditagih; pengiriman Dr Barang Terkirim Belum Ditagih, Cr Persediaan;
// produksi lewat Barang Dalam Proses. Tagihan vendor dan faktur pelanggan lalu membersihkan akun perantara itu. Panel menampilkan jurnal-jurnal itu.
// Dokumen yang tidak dijurnal per transaksi (biaya standar, kasir, atau selesai sebelum pola ini aktif) tetap dijelaskan: nilainya tercatat pada
// pergerakan stok dan jurnal persediaan terbentuk saat tagihan vendor atau faktur pelanggan diposting.
import { esc, money, searchRead } from "./common.js";

const STATE = { posted: ["Terposting", "text-emerald-700"], draft: ["Draf (jurnal belum terbentuk)", "text-amber-700"], cancel: ["Dibatalkan", "text-gray-500"] };
const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 });

async function journalOf(move) {
  const lines = await searchRead("account.move.line", [["move_id", "=", move.id], ["display_type", "in", ["product", "cogs", "tax", "payment_term", "rounding"]]], ["account_id", "debit", "credit", "display_type"], { order: "debit desc, credit desc, id", limit: 40 });
  const [state, tone] = STATE[move.state] ?? [move.state, ""];
  const rows = lines
    .map((l) => `<tr><td class="py-1 pr-4 text-sm">${esc(l.account_id?.[1] ?? "")}${l.display_type === "cogs" ? ' <span class="text-xs text-gray-400">(HPP otomatis)</span>' : ""}</td>
      <td class="py-1 px-3 text-sm text-right tabular-nums">${l.debit ? nf.format(l.debit) : ""}</td><td class="py-1 pl-3 text-sm text-right tabular-nums">${l.credit ? nf.format(l.credit) : ""}</td></tr>`)
    .join("");
  return `<div class="mt-3"><div class="text-sm"><a href="#/journal/${move.id}" class="text-indigo-700 font-medium hover:underline">${esc(move.name && move.name !== "/" ? move.name : "Draf")}</a>
      <span class="${tone} ml-2">${esc(state)}</span>${move.ref ? `<span class="text-gray-500 ml-2">${esc(move.ref)}</span>` : ""}</div>
    ${move.state === "posted" ? `<table class="mt-1 w-full max-w-2xl"><thead><tr><th class="text-left text-xs font-semibold text-gray-500 uppercase">Akun</th><th class="text-right text-xs font-semibold text-gray-500 uppercase px-3">Debit</th><th class="text-right text-xs font-semibold text-gray-500 uppercase pl-3">Kredit</th></tr></thead><tbody>${rows}</tbody></table>` : ""}</div>`;
}

const panel = (title, intro, body) =>
  `<section class="mt-4 bg-white rounded-xl shadow-sm border border-gray-200 p-4"><div class="text-sm font-semibold">${esc(title)}</div>
    <p class="mt-1 text-sm text-gray-600">${intro}</p>${body}</section>`;
const heading = (text) => `<div class="mt-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">${esc(text)}</div>`;
const notice = (html) => `<p class="mt-3 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">${html}</p>`;

/** Jurnal stok milik pergerakan (tanpa duplikat). Pergerakan yang tidak dijurnal per transaksi tidak punya `account_move_id`. */
async function stockEntries(moves) {
  const ids = [...new Set(moves.map((m) => m.account_move_id?.[0]).filter(Boolean))];
  return ids.length ? searchRead("account.move", [["id", "in", ids]], ["name", "state", "ref"], { order: "id" }) : [];
}

/** Jurnal koreksi selisih harga tagihan terhadap harga PO untuk penerimaan ini. */
const priceCorrections = (pk) => searchRead("account.move", [["ref", "like", `Koreksi nilai ${pk.name}`], ["state", "!=", "cancel"]], ["name", "state", "ref"], { order: "id" });

const block = async (title, list) => (list.length ? heading(title) + (await Promise.all(list.map(journalOf))).join("") : "");

/** Jurnal penerimaan sendiri (bila ada), koreksi harga, dan tagihan vendor milik PO penerimaan ini. */
export async function receiptJournals(pk, moves) {
  const value = moves.reduce((s, m) => s + Math.abs(m.value || 0), 0);
  const entries = await stockEntries(moves);
  const intro = entries.length
    ? `Penerimaan ini dijurnal saat barang diterima memakai akun Product Category: Dr Persediaan, Cr Barang Diterima Belum Ditagih (nilai ${money(value)}). Tagihan vendor kemudian mendebit Barang Diterima Belum Ditagih sehingga saldonya habis; bila harga tagihan berbeda dari harga PO, selisihnya dijurnal sebagai koreksi.`
    : `Penerimaan ini tidak dijurnal saat barang diterima (biaya standar, atau diterima sebelum jurnal per transaksi aktif); nilai barang masuk ${money(value)} tercatat pada pergerakan stok. Jurnal persediaan (Dr Persediaan, Cr Hutang Usaha) terbentuk saat tagihan vendor diposting.`;
  const fixes = entries.length ? await priceCorrections(pk) : [];
  let bills = [];
  if (pk.purchase_id) bills = await searchRead("account.move", [["move_type", "=", "in_invoice"], ["state", "!=", "cancel"], ["invoice_line_ids.purchase_line_id.order_id", "=", pk.purchase_id[0]]], ["name", "state"], { order: "id" });
  const billBlock = !pk.purchase_id
    ? notice("Penerimaan ini tidak berasal dari Purchase Order, jadi tidak ada tagihan yang tertaut.")
    : bills.length
      ? await block("Tagihan vendor", bills)
      : notice(`Belum ada tagihan vendor untuk <a href="#/po/${pk.purchase_id[0]}" class="underline">${esc(pk.purchase_id[1])}</a>${entries.length ? ", jadi Barang Diterima Belum Ditagih masih berkredit" : ", jadi jurnal persediaan belum terbentuk"}. Buat tagihan dari halaman PO atau Vendor Bills.`);
  return panel("Jurnal terkait", intro, (await block("Jurnal penerimaan barang", entries)) + (await block("Koreksi selisih harga tagihan", fixes)) + billBlock);
}

/** Jurnal pengiriman sendiri (bila ada) dan faktur pelanggan milik SO pengiriman ini, termasuk baris HPP otomatis. */
export async function deliveryJournals(pk, moves) {
  const value = moves.reduce((s, m) => s + Math.abs(m.value || 0), 0);
  const entries = await stockEntries(moves);
  const intro = entries.length
    ? `Pengiriman ini dijurnal saat barang keluar memakai akun Product Category: Dr Barang Terkirim Belum Ditagih, Cr Persediaan (${money(value)}, biaya rata-rata). Faktur pelanggan kemudian mencatat harga pokok (Dr HPP, Cr Barang Terkirim Belum Ditagih) sehingga saldonya habis.`
    : `Pengiriman ini tidak dijurnal saat barang keluar (biaya standar, kasir, atau dikirim sebelum jurnal per transaksi aktif); nilai barang keluar ${money(value)} (biaya rata-rata) tercatat pada pergerakan stok. Harga pokok (Dr HPP, Cr Persediaan) terbentuk saat faktur pelanggan diposting.`;
  let invoices = [];
  if (pk.sale_id) invoices = await searchRead("account.move", [["move_type", "=", "out_invoice"], ["state", "!=", "cancel"], ["invoice_line_ids.sale_line_ids.order_id", "=", pk.sale_id[0]]], ["name", "state"], { order: "id" });
  const invoiceBlock = !pk.sale_id
    ? notice("Pengiriman ini tidak berasal dari Sales Order, jadi tidak ada faktur yang tertaut.")
    : invoices.length
      ? await block("Faktur pelanggan", invoices)
      : notice(`Belum ada faktur pelanggan untuk <a href="#/sale/${pk.sale_id[0]}" class="underline">${esc(pk.sale_id[1])}</a>, jadi jurnal HPP belum terbentuk${entries.length ? " dan Barang Terkirim Belum Ditagih masih berdebit" : ""}. Buat faktur dari halaman Sales Order atau Customer Invoice.`);
  return panel("Jurnal terkait", intro, (await block("Jurnal pengiriman barang", entries)) + invoiceBlock);
}

/** Jurnal produksi (komponen keluar dan barang jadi masuk lewat Barang Dalam Proses) bila ada, kalau tidak nilai pergerakan dan di mana jurnalnya muncul. */
export async function productionJournals(mo, raw, finished) {
  const cost = raw.reduce((s, m) => s + Math.abs(m.value || 0), 0);
  const out = finished.reduce((s, m) => s + Math.abs(m.value || 0), 0);
  const done = mo.state === "done";
  const entries = done ? await stockEntries([...raw, ...finished]) : [];
  const rows = (list, label) => list.map((m) => `<tr><td class="py-1 pr-4 text-sm">${label} ${esc(m.product_id?.[1] ?? "")}</td><td class="py-1 px-3 text-sm text-right tabular-nums">${m.value ? nf.format(Math.abs(m.value)) : ""}</td></tr>`).join("");
  const table = done
    ? `<table class="mt-3 w-full max-w-2xl"><thead><tr><th class="text-left text-xs font-semibold text-gray-500 uppercase">Pergerakan stok</th><th class="text-right text-xs font-semibold text-gray-500 uppercase px-3">Nilai</th></tr></thead>
       <tbody>${rows(raw, "Komponen keluar:")}${rows(finished, "Barang jadi masuk:")}</tbody></table>
       <p class="mt-2 text-sm"><a href="#/valuation/moves?product=${esc(mo.product_id?.[0] ?? "")}" class="text-indigo-700 underline">Lihat pergerakan bernilai produk ini di Inventory Valuation</a></p>`
    : '<p class="mt-3 text-sm text-gray-500">Nilai muncul setelah produksi diselesaikan.</p>';
  if (entries.length) {
    return panel(
      "Nilai persediaan dan jurnal",
      `Produksi dijurnal lewat akun Barang Dalam Proses pada lokasi Production: komponen yang keluar (${money(cost)}) didebit ke Barang Dalam Proses, lalu barang jadi yang masuk (${money(out)}, termasuk biaya operasi) dikreditkan darinya.`,
      (await block("Jurnal produksi", entries)) + table,
    );
  }
  return panel(
    "Nilai persediaan dan jurnal",
    `Produksi ini tidak dijurnal (akun Barang Dalam Proses pada lokasi Production belum diisi, atau selesai sebelum jurnal per transaksi aktif). Nilai komponen yang keluar (${money(cost)}) dan barang jadi yang masuk (${money(out)}, termasuk biaya operasi) tercatat pada pergerakan stok. Jurnal persediaan terbentuk saat barang jadi dijual (faktur) dan saat komponen dibeli (tagihan vendor).`,
    table,
  );
}
