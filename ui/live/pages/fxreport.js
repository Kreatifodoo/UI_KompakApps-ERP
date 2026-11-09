// Laporan Selisih Kurs (Q80, D105): selisih kurs TEREALISASI (jurnal Exchange Difference saat faktur dan pembayaran valas dilunasi) dan
// BELUM TEREALISASI (jurnal revaluasi akhir bulan beserta pembaliknya), per bulan, dengan kurs terakhir tiap mata uang.
//   #/fxreport?from=YYYY-MM-DD&to=YYYY-MM-DD
import { INPUT, app, badge, button, call, cell, dateText, esc, money, pageHeader, rowLink, table } from "../common.js";

const MODEL = "kompakapps.fx.revaluation";
const STATE = { draft: ["Draft", "muted"], posted: ["Diposting", "success"], cancel: ["Dibatalkan", "danger"] };
const rate = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 4 });
const signed = (n) => (n > 0 ? `+${money(n)}` : money(n));
const tone = (n) => (n > 0 ? "text-emerald-700" : n < 0 ? "text-rose-700" : "text-gray-500");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const monthLabel = (key) => `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const leave = () => {};

export async function render(sub, query) {
  const now = new Date();
  const from = query.get("from") || `${now.getFullYear()}-01-01`;
  const to = query.get("to") || iso(now);
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const summary = await call(MODEL, "kompakapps_fx_summary", { date_from: from, date_to: to });
  const total = (key) => summary.months.reduce((sum, row) => sum + row[key], 0);
  const realizedGain = total("realized_gain");
  const realizedLoss = total("realized_loss");
  const net = realizedGain - realizedLoss + total("unrealized_gain") - total("unrealized_loss"); // dampak laba rugi periode: revaluasi dan pembaliknya saling meniadakan
  const latest = [...summary.revaluations].filter((r) => r.state === "posted").sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  const unrealizedGain = latest?.gain ?? 0;
  const unrealizedLoss = latest?.loss ?? 0;
  const tile = (label, value, cls = "") => `<div class="bg-white rounded-xl border border-gray-200 shadow-sm p-4"><div class="text-xs font-medium text-gray-500 uppercase">${esc(label)}</div><div class="text-xl font-semibold mt-1 ${cls}">${value}</div></div>`;
  const months = summary.months
    .map((r) => {
      const monthNet = r.realized_gain - r.realized_loss + r.unrealized_gain - r.unrealized_loss;
      return `<tr class="border-b border-gray-100"><td class="py-2 px-3 text-sm font-medium">${esc(monthLabel(r.month))}</td>
        <td class="py-2 px-3 text-sm text-right">${money(r.realized_gain)}</td><td class="py-2 px-3 text-sm text-right">${money(r.realized_loss)}</td>
        <td class="py-2 px-3 text-sm text-right">${money(r.unrealized_gain)}</td><td class="py-2 px-3 text-sm text-right">${money(r.unrealized_loss)}</td>
        <td class="py-2 px-3 text-sm text-right font-medium ${tone(monthNet)}">${signed(monthNet)}</td></tr>`;
    })
    .join("");
  const revaluations = summary.revaluations
    .map((r) => rowLink(`#/fxreval/${r.id}`, [cell(r.name, { strong: true }), cell(dateText(r.date)), cell(badge(STATE, r.state), { raw: true }), cell(money(r.gain), { right: true }), cell(money(r.loss), { right: true }), cell(signed(r.net), { right: true })]))
    .join("");
  const rates = summary.rates.map((r) => `<tr class="border-b border-gray-100"><td class="py-2 px-3 text-sm font-medium">${esc(r.currency)}</td><td class="py-2 px-3 text-sm text-right">${rate.format(r.rate)}</td><td class="py-2 px-3 text-sm">${esc(dateText(r.date))}</td></tr>`).join("");
  app.innerHTML =
    pageHeader(
      "Laporan Selisih Kurs",
      `<label class="text-xs text-gray-500">Dari <input id="fx-from" type="date" value="${esc(from)}" class="${INPUT} !w-40 inline-block ml-1"></label>
       <label class="text-xs text-gray-500">Sampai <input id="fx-to" type="date" value="${esc(to)}" class="${INPUT} !w-40 inline-block ml-1"></label>
       ${button("fxr-show", "Tampilkan", "primary")}
       <a href="#/fxreval" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50"><i class="fas fa-rotate mr-2"></i>Currency Revaluation</a>`,
    ) +
    `<div class="grid md:grid-cols-5 gap-4 mb-4">${tile("Untung terealisasi", money(realizedGain), "text-emerald-700")}${tile("Rugi terealisasi", money(realizedLoss), "text-rose-700")}${tile("Untung belum terealisasi (revaluasi terakhir)", money(unrealizedGain), "text-emerald-700")}${tile("Rugi belum terealisasi (revaluasi terakhir)", money(unrealizedLoss), "text-rose-700")}${tile("Dampak laba rugi periode", signed(net), tone(net))}</div>
    <p class="text-xs text-gray-500 -mt-2 mb-4">${latest ? `Revaluasi terakhir yang diposting: ${esc(latest.name)} per ${esc(dateText(latest.date))}. ` : ""}Jurnal revaluasi dibalik otomatis hari berikutnya, jadi dampak laba rugi satu periode penuh hanya terdiri dari selisih kurs terealisasi dan posisi revaluasi yang belum dibalik pada akhir periode.</p>
    <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto mb-4"><div class="px-5 py-3 border-b border-gray-200 font-semibold text-gray-900">Per bulan <span class="text-xs font-normal text-gray-500">terealisasi: jurnal Exchange Difference; belum terealisasi: jurnal revaluasi (bulan berikutnya memuat pembaliknya)</span></div>
      <table class="w-full text-left" data-list="off"><thead class="bg-gray-50 border-b border-gray-200"><tr>${["Bulan", "Untung terealisasi", "Rugi terealisasi", "Untung belum terealisasi", "Rugi belum terealisasi", "Bersih"].map((h, i) => `<th class="py-3 px-3 text-xs font-semibold text-gray-600 uppercase ${i ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>
      <tbody>${months || `<tr><td colspan="6" class="py-8 text-center text-sm text-gray-500">Belum ada selisih kurs pada periode ini.</td></tr>`}</tbody></table></div>
    <div class="grid md:grid-cols-2 gap-4">
      <div><div class="text-sm font-semibold text-gray-900 mb-2">Revaluasi pada periode</div>${table([{ label: "Nomor" }, { label: "Tanggal" }, { label: "Status" }, { label: "Untung", right: true }, { label: "Rugi", right: true }, { label: "Bersih", right: true }], revaluations, "Belum ada revaluasi pada periode ini.")}</div>
      <div><div class="text-sm font-semibold text-gray-900 mb-2">Kurs terakhir (${esc(summary.currency)} per 1 mata uang asing)</div><div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto"><table class="w-full text-left" data-list="off"><thead class="bg-gray-50 border-b border-gray-200"><tr><th class="py-3 px-3 text-xs font-semibold text-gray-600 uppercase">Mata uang</th><th class="py-3 px-3 text-xs font-semibold text-gray-600 uppercase text-right">Kurs</th><th class="py-3 px-3 text-xs font-semibold text-gray-600 uppercase">Per tanggal</th></tr></thead><tbody>${rates || '<tr><td colspan="3" class="py-6 text-center text-sm text-gray-500">Belum ada kurs.</td></tr>'}</tbody></table></div></div>
    </div>`;
}

export async function onClick(event, el) {
  if (el.dataset.action !== "fxr-show") return;
  const from = document.getElementById("fx-from")?.value;
  const to = document.getElementById("fx-to")?.value;
  location.hash = `#/fxreport?from=${from}&to=${to}`;
}
