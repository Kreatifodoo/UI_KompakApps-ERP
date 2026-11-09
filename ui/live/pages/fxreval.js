// Revaluasi Mata Uang (kompakapps.fx.revaluation): selisih kurs yang BELUM terealisasi pada piutang, hutang, dan kas bank bermata uang asing (Q80, D105).
// Sistem menilai kembali saldo terbuka pada kurs tanggal laporan, menjurnal selisihnya, dan membalik jurnal itu otomatis pada hari berikutnya.
//   #/fxreval          daftar revaluasi
//   #/fxreval/new      revaluasi baru (pilih tanggal)
//   #/fxreval/<id>     revaluasi: baris per akun, mitra, dan mata uang; hitung ulang, posting, batalkan
import { INPUT, app, badge, button, call, cell, chatterHtml, dateText, esc, filterSelect, guarded, hasGroup, loadMessages, money, pageHeader, readOne, rowLink, searchRead, statusbar, table, toast } from "../common.js";

const MODEL = "kompakapps.fx.revaluation";
const STATE = { draft: ["Draft", "muted"], posted: ["Diposting", "success"], cancel: ["Dibatalkan", "danger"] };
const KIND = { receivable: "Piutang", payable: "Hutang", liquidity: "Kas dan Bank" };
const rate = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 4 });
const foreign = new Intl.NumberFormat("id-ID", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const moveName = (move) => (move ? move[1].split(" (")[0] : "-");
const signed = (n) => (n > 0 ? `+${money(n)}` : money(n));
const tone = (n) => (n > 0 ? "text-emerald-700" : n < 0 ? "text-rose-700" : "text-gray-500");

let last = { sub: "", query: new URLSearchParams() };
let draftDate = null;
export const leave = () => {
  draftDate = null;
};

export async function render(sub, query) {
  last = { sub, query };
  if (sub === "") return renderList(query);
  if (sub === "new") return renderNew();
  return renderForm(Number(sub));
}

const monthEnd = () => {
  const now = new Date();
  const day = new Date(now.getFullYear(), now.getMonth(), 0); // akhir bulan lalu
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
};

/* ---------- Daftar ---------- */

async function renderList(query) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const filter = query.get("state") ?? "";
  const rows = await searchRead(MODEL, filter ? [["state", "=", filter]] : [], ["name", "date", "reverse_date", "state", "total_gain", "total_loss", "total_net", "move_id"], { order: "date desc, id desc", limit: 200 });
  const options = [["", "Semua status"], ...Object.entries(STATE).map(([key, value]) => [key, value[0]])];
  const body = rows
    .map((r) =>
      rowLink(`#/fxreval/${r.id}`, [
        cell(r.name, { strong: true }),
        cell(dateText(r.date)),
        cell(dateText(r.reverse_date)),
        cell(badge(STATE, r.state), { raw: true }),
        cell(money(r.total_gain), { right: true }),
        cell(money(r.total_loss), { right: true }),
        cell(signed(r.total_net), { right: true }),
        cell(moveName(r.move_id)),
      ]),
    )
    .join("");
  app.innerHTML =
    pageHeader(
      "Currency Revaluation",
      `${filterSelect(options, filter)}
       <a href="#/fxreport" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50"><i class="fas fa-chart-column mr-2"></i>Laporan Selisih Kurs</a>
       <a href="#/fxreval/new" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"><i class="fas fa-plus mr-2"></i>Revaluasi Baru</a>`,
    ) +
    `<p class="text-sm text-gray-600 mb-3 max-w-4xl">Menilai kembali piutang, hutang, dan kas bank bermata uang asing yang masih terbuka pada <b>kurs tanggal laporan</b>. Selisihnya dijurnal sebagai <b>untung atau rugi kurs belum terealisasi</b>, lalu jurnal itu dibalik otomatis hari berikutnya. Selisih yang <b>sudah terealisasi</b> (saat faktur dan pembayaran dilunasi) dicatat Odoo ke jurnal Exchange Difference dan muncul di laporan selisih kurs.</p>` +
    table(
      [{ label: "Nomor" }, { label: "Tanggal" }, { label: "Pembalik" }, { label: "Status" }, { label: "Untung", right: true }, { label: "Rugi", right: true }, { label: "Bersih", right: true }, { label: "Jurnal" }],
      body,
      "Belum ada revaluasi. Buat dengan tombol Revaluasi Baru pada akhir bulan.",
    );
}

/* ---------- Baru ---------- */

async function renderNew() {
  draftDate ??= monthEnd();
  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/fxreval" class="hover:text-indigo-600">Currency Revaluation</a> / Baru</div>
    <h1 class="text-2xl font-bold text-gray-900 mb-4">Revaluasi Mata Uang Baru</h1>
    <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-5 max-w-xl">
      <label class="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1" for="fx-date">Tanggal revaluasi</label>
      <input id="fx-date" type="date" value="${esc(draftDate)}" class="${INPUT}">
      <p class="text-xs text-gray-500 mt-2">Biasanya hari terakhir bulan. Kurs yang dipakai adalah kurs pada tanggal ini; jurnal pembalik dibuat pada hari berikutnya.</p>
      <div class="flex gap-2 mt-4">${button("fx-create", "Buat dan Hitung", "primary")}<a href="#/fxreval" class="px-4 py-2 rounded-lg text-sm bg-white border border-gray-300 hover:bg-gray-50">Batal</a></div>
    </div>`;
}

/* ---------- Formulir ---------- */

async function renderForm(id) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const [rec, lines, accountant] = await Promise.all([
    readOne(MODEL, id, ["name", "date", "reverse_date", "state", "total_gain", "total_loss", "total_net", "move_id", "reverse_move_id", "gain_account_id", "loss_account_id", "journal_id", "note"]),
    searchRead("kompakapps.fx.revaluation.line", [["revaluation_id", "=", id]], ["kind", "account_id", "partner_id", "currency_id", "foreign_balance", "rate", "booked_balance", "revalued_balance", "adjustment"], { order: "id", limit: 500 }),
    hasGroup("account.group_account_user"),
  ]);
  if (!rec) {
    app.innerHTML = '<p class="text-sm text-rose-600">Revaluasi tidak ditemukan.</p>';
    return;
  }
  const draft = rec.state === "draft";
  const buttons = [];
  if (draft && accountant) {
    buttons.push(button("fx-compute", "Hitung Ulang", "plain", { id }));
    buttons.push(`<button data-action="fx-post" data-id="${id}" ${lines.length ? "" : "disabled"} class="px-4 py-2 rounded-lg text-sm font-medium ${lines.length ? "bg-emerald-600 text-white hover:bg-emerald-700" : "bg-gray-200 text-gray-400"}">Posting Jurnal</button>`);
  }
  if (rec.state !== "cancel" && accountant) buttons.push(button("fx-cancel", rec.state === "posted" ? "Batalkan Jurnal" : "Batalkan", "danger", { id }));
  if (rec.state === "cancel" && accountant) buttons.push(button("fx-draft", "Kembalikan ke Draft", "plain", { id }));
  if (rec.move_id) buttons.push(`<a href="#/journal/${rec.move_id[0]}" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Lihat Jurnal</a>`);
  if (rec.reverse_move_id) buttons.push(`<a href="#/journal/${rec.reverse_move_id[0]}" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Lihat Pembalik</a>`);
  const tile = (label, value, cls = "") => `<div class="bg-white rounded-xl border border-gray-200 shadow-sm p-4"><div class="text-xs font-medium text-gray-500 uppercase">${esc(label)}</div><div class="text-xl font-semibold mt-1 ${cls}">${value}</div></div>`;
  const body = lines
    .map(
      (r) => `<tr class="border-b border-gray-100">
        <td class="py-2 px-3 text-sm">${esc(KIND[r.kind] ?? r.kind)}</td>
        <td class="py-2 px-3 text-sm">${esc(r.account_id?.[1] ?? "-")}</td>
        <td class="py-2 px-3 text-sm">${esc(r.partner_id?.[1] ?? "-")}</td>
        <td class="py-2 px-3 text-sm">${esc(r.currency_id?.[1] ?? "")}</td>
        <td class="py-2 px-3 text-sm text-right">${foreign.format(r.foreign_balance)}</td>
        <td class="py-2 px-3 text-sm text-right">${rate.format(r.rate)}</td>
        <td class="py-2 px-3 text-sm text-right">${money(r.booked_balance)}</td>
        <td class="py-2 px-3 text-sm text-right">${money(r.revalued_balance)}</td>
        <td class="py-2 px-3 text-sm text-right font-medium ${tone(r.adjustment)}">${signed(r.adjustment)}</td></tr>`,
    )
    .join("");
  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/fxreval" class="hover:text-indigo-600">Currency Revaluation</a> / ${esc(rec.name)}</div>
    <div class="flex flex-wrap items-center gap-2 mb-3">${buttons.join("")}<div class="ml-auto">${statusbar(["draft", "posted"], STATE, rec.state)}</div></div>
    <h1 class="text-2xl font-bold text-gray-900 mb-1">${esc(rec.name)}</h1>
    <p class="text-sm text-gray-500 mb-4">Per ${esc(dateText(rec.date))} · pembalik otomatis ${esc(dateText(rec.reverse_date))} · jurnal ${esc(rec.journal_id?.[1] ?? "-")} · untung ke ${esc(rec.gain_account_id?.[1] ?? "-")}, rugi ke ${esc(rec.loss_account_id?.[1] ?? "-")}</p>
    ${rec.state === "posted" ? `<div class="rounded-xl border border-emerald-300 bg-emerald-50 px-5 py-3 mb-4 text-sm text-emerald-900"><b>Jurnal revaluasi sudah diposting</b> dan dibalik otomatis pada ${esc(dateText(rec.reverse_date))}. Penilaian berikutnya mulai dari nilai buku asli.</div>` : ""}
    <div class="grid md:grid-cols-3 gap-4 mb-4">${tile("Keuntungan belum terealisasi", money(rec.total_gain), "text-emerald-700")}${tile("Kerugian belum terealisasi", money(rec.total_loss), "text-rose-700")}${tile("Bersih", signed(rec.total_net), tone(rec.total_net))}</div>
    <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto"><table class="w-full text-left" data-list="off"><thead class="bg-gray-50 border-b border-gray-200"><tr>
      ${["Jenis", "Akun", "Mitra", "Valas", "Saldo valas", "Kurs", "Saldo buku", "Saldo revaluasi", "Selisih"].map((h, i) => `<th class="py-3 px-3 text-xs font-semibold text-gray-600 uppercase ${i >= 4 ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>
      <tbody>${body || `<tr><td colspan="9" class="py-8 text-center text-sm text-gray-500">Tidak ada selisih: belum ada piutang, hutang, atau kas bank bermata uang asing yang kursnya berubah sejak dibukukan.</td></tr>`}</tbody></table></div>
    <p class="text-xs text-gray-500 mt-2">Saldo buku = nilai rupiah saat ini per tanggal revaluasi (pelunasan sebagian setelah tanggal itu dikembalikan). Saldo revaluasi = saldo valas pada kurs tanggal revaluasi. Selisih positif pada piutang atau kas = untung; pada hutang, kenaikan kurs menjadi rugi.</p>
    ${chatterHtml(MODEL, id)}`;
  loadMessages(MODEL, id);
}

/* ---------- Tindakan ---------- */

export async function onClick(event, el) {
  const { action } = el.dataset;
  if (!action?.startsWith("fx-")) return;
  if (action === "fx-create") {
    const date = document.getElementById("fx-date")?.value;
    if (!date) {
      toast("Isi tanggal revaluasi.");
      return;
    }
    const id = await guarded(el, async () => {
      const [created] = await call(MODEL, "create", { vals_list: [{ date }] });
      await call(MODEL, "action_compute", { ids: [created] });
      return created;
    });
    if (id) {
      draftDate = null;
      toast("Revaluasi dibuat dan dihitung.");
      location.hash = `#/fxreval/${id}`;
    }
    return;
  }
  const id = Number(el.dataset.id);
  const run = {
    "fx-compute": ["action_compute", "Dihitung ulang.", null],
    "fx-post": ["action_post", "Jurnal revaluasi dan pembaliknya diposting.", "Posting jurnal revaluasi? Dibuat dua jurnal: revaluasi pada tanggal laporan dan pembaliknya pada hari berikutnya."],
    "fx-cancel": ["action_cancel", "Revaluasi dibatalkan.", "Batalkan revaluasi ini? Jurnal dan pembaliknya (bila ada) dibatalkan."],
    "fx-draft": ["action_draft", "Dikembalikan ke draft.", null],
  }[action];
  if (!run) return;
  const [method, done, ask] = run;
  if (ask && !window.confirm(ask)) return;
  const ok = await guarded(el, () => call(MODEL, method, { ids: [id] }).then(() => true));
  if (ok) {
    toast(done);
    await render(last.sub, last.query);
  }
}
