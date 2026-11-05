// Kertas Kerja COGM periodik (kompakapps.cogm.worksheet): skema 2 pada dokumen "Proline - COGM Module" (Q64, D92).
// Sistem mengumpulkan pembelian bahan, tenaga kerja, dan overhead dari buku besar; petugas gudang mengisi hasil opname bahan baku dan estimasi
// penyelesaian WIP; Control Balance (Hijau atau Merah) memeriksa semuanya; jurnal COGM hanya bisa dieksekusi bila Hijau.
//   #/cogm            daftar kertas kerja
//   #/cogm/new        kertas kerja baru (pilih periode)
//   #/cogm/<id>       kertas kerja: data buku besar, formulir opname, kalkulasi, Control Balance
//   #/cogm/setting    pengaturan akun dan pemetaan akun biaya
import {
  PRODUCT_PAGE, searchProducts,
  ACCOUNT_TYPE_LABELS, INPUT, app, badge, button, call, cell, chatterHtml, closeLookup, ctx, dateText, esc, fieldBlock, filterSelect, guarded, hasGroup,
  loadMessages, money, pageHeader, readOne, readonlyValue, registerLookup, rowLink, runLookup, searchAccounts, searchRead, selectOptions, statusbar, table, toast,
} from "../common.js";

const MODEL = "kompakapps.cogm.worksheet";
const STATE = { draft: ["Draft", "muted"], posted: ["Diposting", "success"], cancel: ["Dibatalkan", "danger"] };
const CONTROL = { unchecked: ["Belum diperiksa", "muted"], green: ["Hijau - Seimbang", "success"], red: ["Merah - Ada Selisih", "danger"] };
const SECTION = { rm_opening: "Persediaan Bahan Baku Awal", purchase: "Pembelian Bahan Baku", labor: "Tenaga Kerja Langsung", overhead: "Overhead Pabrik", wip_opening: "Barang Dalam Proses Awal" };
const MAP_SECTIONS = [["purchase", "Pembelian Bahan Baku (bersih)"], ["labor", "Tenaga Kerja Langsung"], ["overhead", "Overhead Pabrik"], ["excluded", "Bukan Biaya Produksi"]];
const CHECK_STYLE = {
  ok: ["fa-circle-check", "text-emerald-600"], error: ["fa-circle-xmark", "text-rose-600"], warn: ["fa-triangle-exclamation", "text-amber-600"], info: ["fa-circle-info", "text-sky-600"],
};
const COST_ACCOUNT_TYPES = ["expense", "expense_direct_cost", "expense_depreciation", "expense_other"];
const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 3 });
const rupiah = (n) => money(n);
const num = (value) => (value === "" || value == null ? 0 : Number(value));
/** Nomor jurnal tanpa referensinya (display_name Odoo memuat referensi dalam kurung). */
const moveName = (move) => (move ? move[1].split(" (")[0] : "-");
const ref = (value) => (Array.isArray(value) ? { id: value[0], display_name: value[1] } : null);

let form = null; // kertas kerja yang sedang dibuka: { id, ws, lines, ops, wips, removed, dirty, check, defaults, canExecute }
let draftNew = null; // isian kertas kerja baru
let cfg = null; // pengaturan yang sedang diedit
let last = { sub: "", query: new URLSearchParams() };
export const leave = () => {
  form = null;
  draftNew = null;
  cfg = null;
};
const reload = () => render(last.sub, last.query);

export async function render(sub, query) {
  last = { sub, query };
  closeLookup();
  if (sub === "") return renderList(query);
  if (sub === "new") return renderNew();
  if (sub === "setting") return renderSetting();
  return renderForm(Number(sub));
}

/* ---------- Daftar ---------- */

async function renderList(query) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const filter = query.get("state") ?? "";
  const [rows, defaults] = await Promise.all([
    searchRead(MODEL, filter ? [["state", "=", filter]] : [], ["name", "date_from", "date_to", "state", "control_state", "cogm", "move_id"], { order: "date_to desc, id desc", limit: 80 }),
    call(MODEL, "kompakapps_defaults", {}),
  ]);
  const options = [["", "Semua status"], ...Object.entries(STATE).map(([key, value]) => [key, value[0]])];
  const body = rows
    .map((r) =>
      rowLink(`#/cogm/${r.id}`, [
        cell(r.name, { strong: true }),
        cell(`${dateText(r.date_from)} s.d. ${dateText(r.date_to)}`),
        cell(badge(STATE, r.state), { raw: true }),
        cell(r.state === "posted" ? badge(CONTROL, "green") : badge(CONTROL, r.control_state), { raw: true }),
        cell(rupiah(r.cogm), { right: true }),
        cell(moveName(r.move_id)),
      ]),
    )
    .join("");
  app.innerHTML =
    pageHeader(
      "Kertas Kerja COGM",
      `${filterSelect(options, filter)}
       <a href="#/cogm/setting" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50"><i class="fas fa-gear mr-2"></i>Pengaturan</a>
       <a href="#/cogm/new" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"><i class="fas fa-plus mr-2"></i>Kertas Kerja Baru</a>`,
    ) +
    (defaults.configured ? "" : notConfigured()) +
    `<p class="text-sm text-gray-600 mb-3 max-w-4xl">Skema periodik: biaya bahan, tenaga kerja, dan overhead dikumpulkan sepanjang bulan; setelah stock opname, kertas kerja menghitung <b>COGM = Bahan Baku Terpakai + Tenaga Kerja + Overhead + WIP Awal - WIP Akhir</b>. Jurnal COGM baru bisa dieksekusi bila Control Balance berstatus Hijau.</p>` +
    table(
      [{ label: "Nomor" }, { label: "Periode" }, { label: "Status" }, { label: "Control Balance" }, { label: "COGM", right: true }, { label: "Jurnal" }],
      body,
      "Belum ada kertas kerja COGM. Buat dengan tombol Kertas Kerja Baru setelah akhir periode.",
    );
}

const notConfigured = () =>
  `<div class="bg-amber-50 border border-amber-200 rounded-xl px-5 py-4 mb-4 text-sm text-amber-900"><b>Pengaturan COGM belum dibuat untuk perusahaan ini.</b>
   Buka <a href="#/cogm/setting" class="underline">Pengaturan</a> lalu pilih Siapkan Bawaan: akun persediaan, jurnal COGM, dan pemetaan akun biaya produksi dibuat otomatis.</div>`;

/* ---------- Baru ---------- */

async function renderNew() {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const defaults = await call(MODEL, "kompakapps_defaults", {});
  draftNew ??= { from: defaults.date_from, to: defaults.date_to, note: "" };
  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/cogm" class="hover:text-indigo-600">Kertas Kerja COGM</a> / Baru</div>
    <h1 class="text-2xl font-bold text-gray-900 mb-3">Kertas Kerja COGM Baru</h1>
    ${defaults.configured ? "" : notConfigured()}
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-2 gap-x-8 gap-y-4 max-w-4xl">
      ${fieldBlock("Dari Tanggal", `<input type="date" data-new="from" value="${esc(draftNew.from)}" class="${INPUT}">`)}
      ${fieldBlock("Sampai Tanggal (tanggal opname dan jurnal)", `<input type="date" data-new="to" value="${esc(draftNew.to)}" class="${INPUT}">`)}
      <div class="md:col-span-2">${fieldBlock("Catatan", `<textarea data-new="note" rows="2" class="${INPUT}">${esc(draftNew.note)}</textarea>`)}</div>
      <p class="md:col-span-2 text-sm text-sky-900 bg-sky-50 border border-sky-200 rounded-lg px-4 py-3">Setelah dibuat, saldo awal persediaan, pembelian bersih, tenaga kerja, dan overhead ditarik otomatis dari buku besar (oleh peran Accounting). Petugas gudang lalu mengisi hasil opname bahan baku dan estimasi WIP.</p>
    </section>
    <div class="flex gap-2 mt-4 max-w-4xl">
      <button data-action="cogm-create" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Buat Kertas Kerja</button>
      <a href="#/cogm" data-action="cogm-discard-new" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Batal</a>
    </div>`;
}

async function createWorksheet() {
  if (!draftNew.from || !draftNew.to) throw new Error("Isi tanggal mulai dan akhir periode.");
  if (draftNew.from > draftNew.to) throw new Error("Tanggal mulai tidak boleh setelah tanggal akhir.");
  const [id] = await call(MODEL, "create", { vals_list: [{ date_from: draftNew.from, date_to: draftNew.to, note: draftNew.note.trim() || false }] });
  try {
    await call(MODEL, "action_pull", { ids: [id] });
  } catch (error) {
    toast(`Kertas kerja dibuat, data buku besar belum ditarik: ${error.message}`, "error");
  }
  return id;
}

/* ---------- Kertas kerja ---------- */

const WS_FIELDS = [
  "name", "company_id", "date_from", "date_to", "state", "note", "pulled_at", "rm_opening", "purchases", "rm_available", "rm_ending", "rm_used", "direct_labor", "overhead",
  "total_cost", "wip_opening", "wip_ending", "cogm", "control_state", "move_id", "post_user_id", "post_date",
];

const opRow = (r) => ({
  id: r.id, product: ref(r.product_id), uom: r.uom_id?.[1] ?? "", storable: r.is_storable, qty: String(r.qty), unitCost: String(r.unit_cost), bookQty: r.book_qty, explanation: r.explanation || "",
});
const wipRow = (r) => ({
  id: r.id, name: r.name, product: ref(r.product_id), qty: String(r.qty), materialCost: String(r.material_cost), materialPct: String(r.material_pct),
  conversionCost: String(r.conversion_cost), completionPct: String(r.completion_pct),
});
const opValue = (r) => Math.round(num(r.qty) * num(r.unitCost));
const wipValue = (r) => Math.round((num(r.qty) * (num(r.materialCost) * num(r.materialPct) + num(r.conversionCost) * num(r.completionPct))) / 100);

async function loadForm(id) {
  const [ws, lines, ops, wips, defaults] = await Promise.all([
    readOne(MODEL, id, WS_FIELDS),
    searchRead("kompakapps.cogm.line", [["worksheet_id", "=", id]], ["section", "account_id", "debit", "credit", "balance", "pct", "amount"], { order: "id" }),
    searchRead("kompakapps.cogm.opname", [["worksheet_id", "=", id]], ["product_id", "uom_id", "is_storable", "qty", "unit_cost", "book_qty", "explanation"], { order: "id" }),
    searchRead("kompakapps.cogm.wip", [["worksheet_id", "=", id]], ["name", "product_id", "qty", "material_cost", "material_pct", "conversion_cost", "completion_pct"], { order: "id" }),
    call(MODEL, "kompakapps_defaults", {}),
  ]);
  if (!ws) return null;
  const check = ws.state === "draft" ? await call(MODEL, "action_check", { ids: [id] }) : null;
  return { id, ws, lines, ops: ops.map(opRow), wips: wips.map(wipRow), removed: { ops: [], wips: [] }, dirty: false, check, defaults, canExecute: defaults.can_execute };
}

async function renderForm(id) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  if (!form || form.id !== id) {
    form = await loadForm(id);
    if (!form) {
      app.innerHTML = '<p class="text-sm text-rose-600">Kertas kerja tidak ditemukan.</p>';
      return;
    }
    snapshotInitial();
  }
  paintForm();
  loadMessages(MODEL, id);
}

function paintForm() {
  const { ws } = form;
  const draft = ws.state === "draft";
  const flow = ["draft", "posted"];
  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/cogm" class="hover:text-indigo-600">Kertas Kerja COGM</a> / ${esc(ws.name)}</div>
    <div class="flex flex-wrap items-center gap-2 mb-3">${headerButtons()}<div class="ml-auto">${statusbar(flow, STATE, ws.state)}</div></div>
    <h1 class="text-2xl font-bold text-gray-900 mb-1">${esc(ws.name)}</h1>
    <p class="text-sm text-gray-500 mb-4">Periode ${esc(dateText(ws.date_from))} s.d. ${esc(dateText(ws.date_to))}${ws.state === "posted" ? ` · dieksekusi ${esc(ws.post_user_id?.[1] ?? "")} pada ${esc(dateText(ws.post_date))}` : ""}</p>
    ${draft ? `<div id="control-box">${controlHtml()}</div>` : postedBanner()}
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-3 gap-x-8 gap-y-4 mt-4">
      ${fieldBlock("Dari Tanggal", draft ? `<input type="date" data-ws="date_from" value="${esc(ws.date_from)}" class="${INPUT}">` : readonlyValue(dateText(ws.date_from)))}
      ${fieldBlock("Sampai Tanggal", draft ? `<input type="date" data-ws="date_to" value="${esc(ws.date_to)}" class="${INPUT}">` : readonlyValue(dateText(ws.date_to)))}
      ${fieldBlock("Jurnal COGM", ws.move_id ? `<a class="py-2 block text-sm font-medium text-indigo-700 hover:underline" href="#/journal/${ws.move_id[0]}">${esc(moveName(ws.move_id))}</a>` : readonlyValue(""))}
      <div class="md:col-span-3">${fieldBlock("Catatan", draft ? `<textarea data-ws="note" rows="2" class="${INPUT}">${esc(ws.note || "")}</textarea>` : readonlyValue(ws.note))}</div>
    </section>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4">
      <div class="px-5 py-3 border-b border-gray-200 flex flex-wrap items-center justify-between gap-2">
        <div class="font-semibold text-gray-900">1. Data dari Buku Besar <span class="text-xs font-normal text-gray-500">otomatis, tanpa entri manual</span></div>
        <div class="text-xs text-gray-500">${ws.pulled_at ? `Ditarik ${esc(dateText(ws.pulled_at))}` : "Belum ditarik"}</div>
      </div>${ledgerHtml()}</section>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4">
      <div class="px-5 py-3 border-b border-gray-200 font-semibold text-gray-900">2. Formulir Opname Bahan Baku <span class="text-xs font-normal text-gray-500">jumlah fisik sisa bahan baku akhir periode</span></div>
      <div id="ops-box">${opsHtml()}</div></section>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4">
      <div class="px-5 py-3 border-b border-gray-200 font-semibold text-gray-900">3. Formulir Opname Barang Dalam Proses (WIP) <span class="text-xs font-normal text-gray-500">estimasi tingkat penyelesaian</span></div>
      <div id="wip-box">${wipsHtml()}</div></section>
    ${draft ? `<div class="flex gap-2 mt-4"><button data-action="cogm-save" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Simpan Kertas Kerja</button><span id="dirty-note" class="text-sm text-amber-700 self-center ${form.dirty ? "" : "hidden"}">Ada perubahan yang belum disimpan</span></div>` : ""}
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4">
      <div class="px-5 py-3 border-b border-gray-200 font-semibold text-gray-900">4. Kalkulasi COGM <span id="preview-note" class="text-xs font-normal text-amber-700">${form.dirty ? "pratinjau, belum disimpan" : ""}</span></div>
      <div id="calc-box">${calcHtml()}</div></section>
    ${chatterHtml(MODEL, ws.id)}`;
}

/* ----- tombol header ----- */

function headerButtons() {
  const { ws, canExecute } = form;
  const out = [];
  if (ws.state === "draft") {
    if (canExecute) out.push(button("cogm-pull", "Tarik dari Buku Besar", "plain"));
    out.push(button("cogm-check", "Periksa Control Balance", "plain"));
    if (canExecute) {
      const green = form.check?.state === "green" && !form.dirty;
      out.push(
        `<button data-action="cogm-post" ${green ? "" : "disabled"} title="${green ? "Eksekusi jurnal COGM" : form.dirty ? "Simpan perubahan lebih dulu" : "Control Balance harus Hijau"}" class="px-4 py-2 rounded-lg text-sm font-medium ${green ? "bg-emerald-600 text-white hover:bg-emerald-700" : "bg-gray-200 text-gray-500 cursor-not-allowed"}">Execute Jurnal COGM</button>`,
      );
    }
    out.push(button("cogm-cancel", "Batalkan Kertas Kerja", "danger"));
  } else if (ws.state === "posted") {
    if (ws.move_id) out.push(`<a href="#/journal/${ws.move_id[0]}" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Lihat Jurnal COGM</a>`);
    if (canExecute) out.push(button("cogm-reverse", "Batalkan Jurnal (Reverse)", "danger"));
  } else if (ws.state === "cancel") out.push(button("cogm-draft", "Kembalikan ke Draft", "plain"));
  return out.join("");
}

const postedBanner = () =>
  `<div class="rounded-xl border border-emerald-300 bg-emerald-50 px-5 py-4 flex items-center gap-4"><span class="inline-flex h-10 w-10 rounded-full bg-emerald-500 text-white items-center justify-center"><i class="fas fa-check"></i></span>
   <div><div class="font-semibold text-emerald-900">Jurnal COGM sudah dieksekusi</div><div class="text-sm text-emerald-900">COGM ${esc(rupiah(form.ws.cogm))} dipindahkan ke persediaan barang jadi. Isi kertas kerja terkunci; batalkan jurnalnya bila perlu koreksi.</div></div></div>`;

/* ----- Control Balance ----- */

function controlHtml() {
  const check = form.check;
  if (!check) return "";
  const green = check.state === "green";
  const rows = check.checks
    .map((c) => {
      const [icon, tone] = CHECK_STYLE[c.status] ?? CHECK_STYLE.info;
      return `<tr class="align-top"><td class="py-2 pl-5 pr-2 w-8"><i class="fas ${icon} ${tone}"></i></td><td class="py-2 pr-4 text-sm font-medium text-gray-900 whitespace-nowrap">${esc(c.title)}</td><td class="py-2 pr-5 text-sm text-gray-600">${esc(c.message)}</td></tr>`;
    })
    .join("");
  return `<section class="rounded-xl border ${green ? "border-emerald-300" : "border-rose-300"} bg-white overflow-hidden">
    <div class="px-5 py-4 flex items-center gap-4 ${green ? "bg-emerald-50" : "bg-rose-50"}">
      <span class="inline-flex h-12 w-12 rounded-full ${green ? "bg-emerald-500" : "bg-rose-500"} text-white items-center justify-center text-xl"><i class="fas ${green ? "fa-check" : "fa-xmark"}"></i></span>
      <div class="flex-1"><div class="text-lg font-bold ${green ? "text-emerald-900" : "text-rose-900"}">Control Balance: ${green ? "HIJAU - Seimbang" : "MERAH - Ada Selisih"}</div>
        <div class="text-sm ${green ? "text-emerald-900" : "text-rose-900"}">${
          green
            ? `Semua pemeriksaan lolos${check.warnings ? `, ${check.warnings} peringatan` : ""}. Jurnal COGM dapat dieksekusi.`
            : `${check.errors} pemeriksaan belum lolos. Jurnal COGM tidak bisa dieksekusi sampai semuanya Hijau.`
        }</div></div>
    </div>
    <table class="w-full text-left"><tbody class="divide-y divide-gray-100">${rows}</tbody></table></section>`;
}

/* ----- data buku besar ----- */

function ledgerHtml() {
  const { ws, lines } = form;
  if (!lines.length) return '<p class="px-5 py-6 text-sm text-gray-500">Belum ada data. Tekan Tarik dari Buku Besar (peran Accounting) untuk mengambil saldo awal, pembelian, tenaga kerja, dan overhead periode ini.</p>';
  const groups = Object.keys(SECTION)
    .map((section) => {
      const rows = lines.filter((l) => l.section === section);
      if (!rows.length) return "";
      const total = rows.reduce((sum, l) => sum + l.amount, 0);
      const body = rows
        .map(
          (l) => `<tr class="text-sm"><td class="py-1.5 px-5 pl-8 text-gray-700">${esc(l.account_id[1])}</td>
            <td class="py-1.5 px-4 text-right tabular-nums text-gray-600">${esc(rupiah(l.balance))}</td>
            <td class="py-1.5 px-4 text-right tabular-nums text-gray-600">${l.pct < 100 ? `${nf.format(l.pct)}%` : ""}</td>
            <td class="py-1.5 px-5 text-right tabular-nums">${esc(rupiah(l.amount))}</td></tr>`,
        )
        .join("");
      return `<tr class="bg-gray-50 text-sm font-semibold"><td class="py-2 px-5">${esc(SECTION[section])}</td><td></td><td></td><td class="py-2 px-5 text-right tabular-nums">${esc(rupiah(total))}</td></tr>${body}`;
    })
    .join("");
  return `<div class="overflow-x-auto"><table class="w-full text-left" data-list="on"><thead class="border-b border-gray-200"><tr>
    <th class="py-2 px-5 text-xs font-semibold text-gray-600 uppercase">Bagian / Akun</th><th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase text-right">Saldo Akun</th>
    <th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase text-right">Porsi Produksi</th><th class="py-2 px-5 text-xs font-semibold text-gray-600 uppercase text-right">Masuk COGM</th></tr></thead>
    <tbody class="divide-y divide-gray-100">${groups}</tbody></table></div>
    <p class="px-5 py-2 text-xs text-gray-500 border-t border-gray-100">Saldo awal: saldo akun persediaan bahan baku dan WIP sebelum ${esc(dateText(ws.date_from))}. Pembelian, tenaga kerja, dan overhead: mutasi terposting pada periode.</p>`;
}

/* ----- opname bahan baku ----- */

const th = (label, right = false) => `<th class="py-2 px-3 text-xs font-semibold text-gray-600 uppercase ${right ? "text-right" : ""}">${esc(label)}</th>`;
const numInput = (attrs, value, extra = "") => `<input type="number" min="0" step="any" ${attrs} value="${esc(value)}" class="${INPUT} text-right ${extra}">`;

function varianceCell(r) {
  if (!r.storable) return '<span class="text-gray-400" title="Produk tidak dilacak stoknya">-</span>';
  const diff = num(r.qty) - r.bookQty;
  const tolerance = (Math.abs(r.bookQty) * (form.defaults.tolerance_pct ?? 0)) / 100;
  const off = Math.abs(diff) > tolerance + 1e-9;
  const tone = !off ? "text-gray-600" : r.explanation.trim() ? "text-amber-700" : "text-rose-700 font-semibold";
  return `<span class="${tone}">${diff > 0 ? "+" : ""}${nf.format(diff)}</span>`;
}

/** Nilai persediaan menurut sistem (stok sistem x biaya per unit); kosong untuk bahan yang tidak dilacak stoknya. */
const bookValue = (r) => (r.storable ? Math.round(r.bookQty * num(r.unitCost)) : null);
/** Selisih nilai = nilai valuasi baru (hasil opname) dikurangi nilai sistem. */
const valueDiff = (r) => (r.storable ? opValue(r) - bookValue(r) : null);
const signed = (n) => `${n > 0 ? "+" : ""}${rupiah(n)}`;

function bookValueCell(r) {
  const value = bookValue(r);
  return value === null ? '<span class="text-gray-400" title="Produk tidak dilacak stoknya, jadi tidak ada nilai sistem">-</span>' : esc(rupiah(value));
}

function valueDiffCell(r) {
  const diff = valueDiff(r);
  if (diff === null) return '<span class="text-gray-400" title="Produk tidak dilacak stoknya">-</span>';
  return `<span class="${diff < 0 ? "text-rose-700" : diff > 0 ? "text-emerald-700" : "text-gray-600"}">${esc(diff === 0 ? rupiah(0) : signed(diff))}</span>`;
}

const sum = (rows, fn) => rows.reduce((total, r) => total + (fn(r) ?? 0), 0);

function opsHtml() {
  const draft = form.ws.state === "draft";
  const rows = form.ops
    .map((r, i) => {
      if (!draft) {
        return `<tr class="text-sm align-top"><td class="py-2 px-3 min-w-56">${esc(r.product?.display_name)}</td><td class="py-2 px-3">${esc(r.uom)}</td><td class="py-2 px-3 text-right tabular-nums">${r.storable ? nf.format(r.bookQty) : "-"}</td>
          <td class="py-2 px-3 text-right tabular-nums">${nf.format(num(r.qty))}</td><td class="py-2 px-3 text-right">${varianceCell(r)}</td><td class="py-2 px-3 text-right tabular-nums">${esc(rupiah(num(r.unitCost)))}</td>
          <td class="py-2 px-3 text-right tabular-nums text-gray-600">${bookValueCell(r)}</td><td class="py-2 px-3 text-right tabular-nums font-medium">${esc(rupiah(opValue(r)))}</td>
          <td class="py-2 px-3 text-right tabular-nums">${valueDiffCell(r)}</td><td class="py-2 px-3 text-gray-600">${esc(r.explanation)}</td></tr>`;
      }
      return `<tr class="text-sm align-top">
        <td class="py-2 px-3 min-w-72"><input data-lookup="cogm-product" data-op="${i}" autocomplete="off" role="combobox" aria-autocomplete="list" value="${esc(r.product?.display_name ?? "")}" placeholder="Cari bahan baku..." class="${INPUT}"></td>
        <td class="py-2 px-3 whitespace-nowrap text-gray-600">${esc(r.uom)}</td>
        <td class="py-2 px-3 text-right tabular-nums text-gray-600" title="Jumlah menurut pergerakan stok sistem pada akhir periode">${r.storable ? nf.format(r.bookQty) : "-"}</td>
        <td class="py-2 px-3 w-36">${numInput(`data-op="${i}" data-field="qty" aria-label="Jumlah fisik"`, r.qty)}</td>
        <td class="py-2 px-3 text-right tabular-nums" id="op-var-${i}">${varianceCell(r)}</td>
        <td class="py-2 px-3 w-44">${numInput(`data-op="${i}" data-field="unitCost" aria-label="Biaya per unit"`, r.unitCost)}</td>
        <td class="py-2 px-3 text-right tabular-nums text-gray-600" id="op-book-${i}" title="Stok sistem x biaya per unit">${bookValueCell(r)}</td>
        <td class="py-2 px-3 text-right tabular-nums font-medium" id="op-value-${i}" title="Jumlah fisik x biaya per unit">${esc(rupiah(opValue(r)))}</td>
        <td class="py-2 px-3 text-right tabular-nums" id="op-diffv-${i}" title="Nilai valuasi baru dikurangi nilai sistem">${valueDiffCell(r)}</td>
        <td class="py-2 px-3 min-w-44"><input data-op="${i}" data-field="explanation" value="${esc(r.explanation)}" placeholder="Wajib bila selisih besar" class="${INPUT}"></td>
        <td class="py-2 px-3"><button data-action="cogm-rm-op" data-i="${i}" class="text-rose-600 hover:text-rose-800" aria-label="Hapus baris"><i class="fas fa-trash"></i></button></td></tr>`;
    })
    .join("");
  const diffTotal = sum(form.ops, valueDiff);
  return `<div class="overflow-x-auto"><table class="w-full text-left" data-list="on"><thead class="border-b border-gray-200"><tr>${th("Bahan Baku")}${th("Satuan")}${th("Stok Sistem", true)}${th("Jumlah Fisik", true)}${th("Selisih Jumlah", true)}${th("Biaya per Unit", true)}${th("Nilai Sistem", true)}${th("Nilai Valuasi Baru", true)}${th("Selisih Nilai", true)}${th("Alasan Selisih")}${draft ? th("") : ""}</tr></thead>
    <tbody class="divide-y divide-gray-100">${rows || `<tr><td colspan="11" class="py-6 text-center text-sm text-gray-500">Belum ada hasil opname. ${draft ? "Tambahkan bahan baku yang dihitung (isi 0 bila habis)." : ""}</td></tr>`}</tbody>
    <tfoot><tr class="border-t border-gray-200 text-sm font-semibold"><td class="py-2 px-3" colspan="6">Persediaan Bahan Baku Akhir (opname)</td>
      <td class="py-2 px-3 text-right tabular-nums text-gray-600" id="op-book-total">${esc(rupiah(sum(form.ops, bookValue)))}</td>
      <td class="py-2 px-3 text-right tabular-nums" id="op-total">${esc(rupiah(sum(form.ops, opValue)))}</td>
      <td class="py-2 px-3 text-right tabular-nums ${diffTotal < 0 ? "text-rose-700" : diffTotal > 0 ? "text-emerald-700" : ""}" id="op-diffv-total">${esc(diffTotal === 0 ? rupiah(0) : signed(diffTotal))}</td>
      <td colspan="${draft ? 2 : 1}"></td></tr></tfoot></table></div>
    <p class="px-5 py-2 text-xs text-gray-500 border-t border-gray-100"><b>Nilai Valuasi Baru</b> = jumlah fisik x biaya per unit: nilai persediaan bahan baku setelah disesuaikan ke hasil opname (menjadi saldo akhir akun persediaan saat jurnal COGM dieksekusi). <b>Nilai Sistem</b> = stok sistem x biaya per unit; <b>Selisih Nilai</b> = nilai baru dikurangi nilai sistem, hanya untuk bahan yang dilacak stoknya (kolom total Nilai Sistem dan Selisih Nilai tidak menghitung bahan yang tidak dilacak).</p>
    ${draft ? `<div class="px-5 pb-3"><button data-action="cogm-add-op" class="px-3 py-1.5 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50"><i class="fas fa-plus mr-2"></i>Tambah Bahan Baku</button>
      <span class="text-xs text-gray-500 ml-3">Satu baris per bahan baku (gabungkan semua lokasi). Selisih terhadap stok sistem di atas toleransi ${nf.format(form.defaults.tolerance_pct ?? 0)}% perlu alasan.</span></div>` : ""}`;
}

/* ----- opname WIP ----- */

function wipsHtml() {
  const draft = form.ws.state === "draft";
  const rows = form.wips
    .map((r, i) => {
      if (!draft) {
        return `<tr class="text-sm"><td class="py-2 px-3">${esc(r.name)}</td><td class="py-2 px-3 text-right tabular-nums">${nf.format(num(r.qty))}</td><td class="py-2 px-3 text-right tabular-nums">${esc(rupiah(num(r.materialCost)))}</td>
          <td class="py-2 px-3 text-right">${nf.format(num(r.materialPct))}%</td><td class="py-2 px-3 text-right tabular-nums">${esc(rupiah(num(r.conversionCost)))}</td><td class="py-2 px-3 text-right">${nf.format(num(r.completionPct))}%</td>
          <td class="py-2 px-3 text-right tabular-nums">${esc(rupiah(wipValue(r)))}</td></tr>`;
      }
      return `<tr class="text-sm align-top">
        <td class="py-2 px-3 min-w-56"><input data-wip="${i}" data-field="name" value="${esc(r.name)}" placeholder="Batch atau barang dalam proses" class="${INPUT}">
          <input data-lookup="cogm-wip-product" data-wip="${i}" autocomplete="off" role="combobox" aria-autocomplete="list" value="${esc(r.product?.display_name ?? "")}" placeholder="Barang jadi (isi biaya dari BoM)" class="${INPUT} mt-1 text-xs"></td>
        <td class="py-2 px-3 w-28">${numInput(`data-wip="${i}" data-field="qty" aria-label="Jumlah"`, r.qty)}</td>
        <td class="py-2 px-3 w-44">${numInput(`data-wip="${i}" data-field="materialCost" aria-label="Biaya bahan per unit"`, r.materialCost)}</td>
        <td class="py-2 px-3 w-24">${numInput(`data-wip="${i}" data-field="materialPct" max="100" aria-label="Bahan terpakai persen"`, r.materialPct)}</td>
        <td class="py-2 px-3 w-44">${numInput(`data-wip="${i}" data-field="conversionCost" aria-label="Biaya konversi per unit"`, r.conversionCost)}</td>
        <td class="py-2 px-3 w-24">${numInput(`data-wip="${i}" data-field="completionPct" max="100" aria-label="Tingkat penyelesaian persen"`, r.completionPct)}</td>
        <td class="py-2 px-3 text-right tabular-nums" id="wip-value-${i}">${esc(rupiah(wipValue(r)))}</td>
        <td class="py-2 px-3"><button data-action="cogm-rm-wip" data-i="${i}" class="text-rose-600 hover:text-rose-800" aria-label="Hapus baris"><i class="fas fa-trash"></i></button></td></tr>`;
    })
    .join("");
  const total = form.wips.reduce((sum, r) => sum + wipValue(r), 0);
  return `<div class="overflow-x-auto"><table class="w-full text-left" data-list="on"><thead class="border-b border-gray-200"><tr>${th("Barang Dalam Proses")}${th("Jumlah", true)}${th("Biaya Bahan / Unit", true)}${th("Bahan Terpakai", true)}${th("Biaya Konversi / Unit", true)}${th("Penyelesaian", true)}${th("Nilai WIP", true)}${draft ? th("") : ""}</tr></thead>
    <tbody class="divide-y divide-gray-100">${rows || `<tr><td colspan="8" class="py-6 text-center text-sm text-gray-500">Tidak ada barang dalam proses pada akhir periode.${draft ? " Tambahkan bila ada batch yang belum selesai." : ""}</td></tr>`}</tbody>
    <tfoot><tr class="border-t border-gray-200 text-sm font-semibold"><td class="py-2 px-3" colspan="6">WIP Akhir (estimasi)</td><td class="py-2 px-3 text-right tabular-nums" id="wip-total">${esc(rupiah(total))}</td>${draft ? "<td></td>" : ""}</tr></tfoot></table></div>
    ${draft ? `<div class="px-5 py-3"><button data-action="cogm-add-wip" class="px-3 py-1.5 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50"><i class="fas fa-plus mr-2"></i>Tambah WIP</button>
      <span class="text-xs text-gray-500 ml-3">Nilai = jumlah x (biaya bahan x bahan terpakai% + biaya konversi x penyelesaian%). Konversi = tenaga kerja dan overhead.</span></div>` : ""}`;
}

/* ----- kalkulasi ----- */

function figures() {
  const { ws } = form;
  const draft = ws.state === "draft";
  const ending = draft ? form.ops.reduce((sum, r) => sum + opValue(r), 0) : ws.rm_ending;
  const wipEnd = draft ? form.wips.reduce((sum, r) => sum + wipValue(r), 0) : ws.wip_ending;
  const available = ws.rm_opening + ws.purchases;
  const used = available - ending;
  const total = used + ws.direct_labor + ws.overhead;
  return { ending, wipEnd, available, used, total, cogm: total + ws.wip_opening - wipEnd };
}

function calcHtml() {
  const { ws } = form;
  const f = figures();
  const row = (sign, label, amount, kind = "") =>
    `<tr class="text-sm ${kind === "sum" ? "font-semibold bg-gray-50" : ""} ${kind === "final" ? "font-bold bg-indigo-50 text-indigo-900" : ""}">
      <td class="py-2 px-5 w-12 text-gray-400">${sign}</td><td class="py-2 pr-4">${esc(label)}</td><td class="py-2 px-5 text-right tabular-nums ${amount < 0 ? "text-rose-700" : ""}">${esc(rupiah(amount))}</td></tr>`;
  return `<table class="w-full text-left"><tbody class="divide-y divide-gray-100">
    ${row("", "Persediaan Bahan Baku Awal", ws.rm_opening)}${row("+", "Pembelian Bersih (setelah retur dan potongan)", ws.purchases)}
    ${row("=", "Bahan Baku Tersedia", f.available, "sum")}${row("-", "Persediaan Bahan Baku Akhir (opname)", f.ending)}
    ${row("=", "Bahan Baku Terpakai", f.used, "sum")}${row("+", "Tenaga Kerja Langsung", ws.direct_labor)}${row("+", "Overhead Pabrik", ws.overhead)}
    ${row("=", "Total Biaya Produksi", f.total, "sum")}${row("+", "Barang Dalam Proses Awal", ws.wip_opening)}${row("-", "Barang Dalam Proses Akhir (estimasi)", f.wipEnd)}
    ${row("=", "Harga Pokok Produksi (COGM)", f.cogm, "final")}</tbody></table>`;
}

function refreshLive() {
  form.ops.forEach((r, i) => {
    const value = document.getElementById(`op-value-${i}`);
    if (value) value.textContent = rupiah(opValue(r));
    const variance = document.getElementById(`op-var-${i}`);
    if (variance) variance.innerHTML = varianceCell(r);
    const book = document.getElementById(`op-book-${i}`);
    if (book) book.innerHTML = bookValueCell(r);
    const diff = document.getElementById(`op-diffv-${i}`);
    if (diff) diff.innerHTML = valueDiffCell(r);
  });
  const bookTotal = document.getElementById("op-book-total");
  if (bookTotal) bookTotal.textContent = rupiah(sum(form.ops, bookValue));
  const diffTotalCell = document.getElementById("op-diffv-total");
  if (diffTotalCell) {
    const diffTotal = sum(form.ops, valueDiff);
    diffTotalCell.textContent = diffTotal === 0 ? rupiah(0) : signed(diffTotal);
    diffTotalCell.className = `py-2 px-3 text-right tabular-nums ${diffTotal < 0 ? "text-rose-700" : diffTotal > 0 ? "text-emerald-700" : ""}`;
  }
  form.wips.forEach((r, i) => {
    const value = document.getElementById(`wip-value-${i}`);
    if (value) value.textContent = rupiah(wipValue(r));
  });
  const opTotal = document.getElementById("op-total");
  if (opTotal) opTotal.textContent = rupiah(form.ops.reduce((sum, r) => sum + opValue(r), 0));
  const wipTotal = document.getElementById("wip-total");
  if (wipTotal) wipTotal.textContent = rupiah(form.wips.reduce((sum, r) => sum + wipValue(r), 0));
  document.getElementById("calc-box").innerHTML = calcHtml();
  document.getElementById("preview-note").textContent = "pratinjau, belum disimpan";
  document.getElementById("control-box")?.classList.add("opacity-50");
  document.getElementById("dirty-note")?.classList.remove("hidden");
  const post = document.querySelector('[data-action="cogm-post"]');
  if (post) {
    post.disabled = true;
    post.title = "Simpan perubahan lebih dulu";
    post.className = "px-4 py-2 rounded-lg text-sm font-medium bg-gray-200 text-gray-500 cursor-not-allowed";
  }
}

/* ----- simpan ----- */

function commands(rows, initial, removed, toVals, same) {
  const before = new Map(initial.map((r) => [r.id, r]));
  const out = [];
  for (const r of rows) {
    const vals = toVals(r);
    if (!r.id) out.push([0, 0, vals]);
    else if (!same(before.get(r.id), r)) out.push([1, r.id, vals]);
  }
  for (const id of removed) out.push([2, id, 0]);
  return out;
}

async function persist() {
  if (!form || form.ws.state !== "draft") return false;
  const { ws } = form;
  const opRows = form.ops.filter((r) => r.product || r.id);
  if (opRows.some((r) => !r.product)) throw new Error("Pilih bahan baku dari kotak saran pada setiap baris opname.");
  for (const r of opRows) if (!(num(r.qty) >= 0) || !(num(r.unitCost) >= 0)) throw new Error(`Jumlah dan biaya ${r.product.display_name} tidak boleh negatif.`);
  const seen = new Set();
  for (const r of opRows) {
    if (seen.has(r.product.id)) throw new Error(`${r.product.display_name} muncul dua kali. Satu baris per bahan baku (gabungkan semua lokasi).`);
    seen.add(r.product.id);
  }
  const wipRows = form.wips.filter((r) => r.name.trim() || r.id);
  for (const r of wipRows) {
    if (!r.name.trim()) throw new Error("Isi nama barang dalam proses pada setiap baris WIP.");
    if (num(r.materialPct) > 100 || num(r.completionPct) > 100) throw new Error(`Persentase WIP ${r.name} tidak boleh lebih dari 100.`);
  }
  const initialOps = form.initialOps ?? [];
  const initialWips = form.initialWips ?? [];
  const opCommands = commands(
    opRows, initialOps, form.removed.ops,
    (r) => ({ product_id: r.product.id, qty: num(r.qty), unit_cost: num(r.unitCost), explanation: r.explanation.trim() || false }),
    (a, b) => a.product?.id === b.product?.id && num(a.qty) === num(b.qty) && num(a.unitCost) === num(b.unitCost) && (a.explanation ?? "") === (b.explanation ?? ""),
  );
  const wipCommands = commands(
    wipRows, initialWips, form.removed.wips,
    (r) => ({
      name: r.name.trim(), product_id: r.product?.id ?? false, qty: num(r.qty), material_cost: num(r.materialCost), material_pct: num(r.materialPct),
      conversion_cost: num(r.conversionCost), completion_pct: num(r.completionPct),
    }),
    (a, b) => ["name", "qty", "materialCost", "materialPct", "conversionCost", "completionPct"].every((k) => String(a[k]) === String(b[k])) && a.product?.id === b.product?.id,
  );
  const vals = {};
  if (form.headerDirty) {
    const header = form.headerValues;
    if (!header.date_from || !header.date_to || header.date_from > header.date_to) throw new Error("Periode tidak valid: tanggal mulai harus sebelum atau sama dengan tanggal akhir.");
    Object.assign(vals, { date_from: header.date_from, date_to: header.date_to, note: header.note.trim() || false });
  }
  if (opCommands.length) vals.opname_ids = opCommands;
  if (wipCommands.length) vals.wip_ids = wipCommands;
  if (Object.keys(vals).length) await call(MODEL, "write", { ids: [ws.id], vals });
  form = null;
  return true;
}

const snapshotInitial = () => {
  form.initialOps = form.ops.map((r) => ({ ...r }));
  form.initialWips = form.wips.map((r) => ({ ...r }));
  form.headerValues = { date_from: form.ws.date_from, date_to: form.ws.date_to, note: form.ws.note || "" };
};
const markDirty = () => {
  form.dirty = true;
  refreshLive();
};

/* ---------- Pengaturan ---------- */

const CFG_FIELDS = ["company_id", "journal_id", "raw_account_id", "wip_account_id", "fg_account_id", "summary_account_id", "scan_prefix", "tolerance_pct", "account_ids"];
const ROLES = [
  ["raw", "Persediaan Bahan Baku", "Saldo awal diambil dari akun ini; saat jurnal COGM dieksekusi akun disesuaikan ke hasil opname."],
  ["wip", "Barang Dalam Proses (WIP)", "Saldo awal WIP diambil dari akun ini; disesuaikan ke estimasi WIP akhir."],
  ["fg", "Persediaan Barang Jadi (Inventory COGM)", "Menerima COGM periode (Debit)."],
  ["summary", "Akun Ikhtisar COGM", "Akun perantara yang berakhir nol; memperlihatkan seluruh unsur COGM dalam satu jurnal."],
];

registerLookup("cogm-cfg-account", {
  search: (q) => searchAccounts(q),
  sub: (r) => ACCOUNT_TYPE_LABELS[r.account_type] ?? "",
  isChosen: (input) => cfg?.accounts[input.dataset.role]?.display_name === input.value,
  choose: (input, item) => {
    cfg.accounts[input.dataset.role] = item;
    input.value = item.display_name;
  },
});
registerLookup("cogm-map-account", {
  search: (q) => searchAccounts(q, COST_ACCOUNT_TYPES),
  sub: (r) => ACCOUNT_TYPE_LABELS[r.account_type] ?? "",
  isChosen: (input) => cfg?.maps[Number(input.dataset.map)]?.account?.display_name === input.value,
  choose: (input, item) => {
    cfg.maps[Number(input.dataset.map)].account = item;
    input.value = item.display_name;
  },
});

async function renderSetting() {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const [rows, journals, canEdit] = await Promise.all([
    searchRead("kompakapps.cogm.config", [["company_id", "=", ctx.company.id]], CFG_FIELDS, { limit: 1 }),
    searchRead("account.journal", [["type", "=", "general"]], ["display_name"], { order: "sequence, code" }),
    hasGroup("account.group_account_manager"),
  ]);
  const config = rows[0];
  if (!config) {
    cfg = null;
    app.innerHTML =
      pageHeader("Pengaturan COGM") +
      `<section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 max-w-3xl"><p class="text-sm text-gray-700">Perusahaan <b>${esc(ctx.company.name)}</b> belum punya pengaturan COGM periodik.</p>
       <p class="text-sm text-gray-600 mt-2">Siapkan Bawaan membuat akun yang belum ada (persediaan bahan baku, barang jadi, WIP, ikhtisar COGM, pembelian, upah langsung, dan overhead pabrik), Jurnal COGM, serta memetakan akun-akun itu ke bagian COGM. Yang sudah ada tidak ditimpa dan perintah ini aman dijalankan ulang.</p>
       <div class="mt-4">${button("cogm-setup", "Siapkan Bawaan", "primary")}</div></section>`;
    return;
  }
  const mappings = config.account_ids.length
    ? await searchRead("kompakapps.cogm.account", [["config_id", "=", config.id]], ["account_id", "section", "pct"], { order: "section, id" })
    : [];
  cfg = {
    id: config.id, canEdit, journals, journal: config.journal_id[0], scan: config.scan_prefix || "", tolerance: String(config.tolerance_pct),
    accounts: { raw: ref(config.raw_account_id), wip: ref(config.wip_account_id), fg: ref(config.fg_account_id), summary: ref(config.summary_account_id) },
    maps: mappings.map((m) => ({ id: m.id, account: ref(m.account_id), section: m.section, pct: String(m.pct) })), initialMaps: mappings.map((m) => ({ id: m.id, account: m.account_id[0], section: m.section, pct: String(m.pct) })), removed: [],
  };
  paintSetting();
}

function paintSetting() {
  const edit = cfg.canEdit;
  const roles = ROLES.map(
    ([key, label, about]) => fieldBlock(label, `<input data-lookup="cogm-cfg-account" data-role="${key}" autocomplete="off" role="combobox" aria-autocomplete="list" value="${esc(cfg.accounts[key]?.display_name ?? "")}" ${edit ? "" : "disabled"} class="${INPUT}"><div class="text-xs text-gray-500 mt-1">${esc(about)}</div>`),
  ).join("");
  const maps = cfg.maps
    .map(
      (m, i) => `<tr class="text-sm align-top"><td class="py-2 px-3 min-w-64"><input data-lookup="cogm-map-account" data-map="${i}" autocomplete="off" role="combobox" aria-autocomplete="list" value="${esc(m.account?.display_name ?? "")}" ${edit ? "" : "disabled"} placeholder="Cari kode atau nama akun..." class="${INPUT}"></td>
        <td class="py-2 px-3 w-64"><select data-map="${i}" data-field="section" ${edit ? "" : "disabled"} class="${INPUT}">${MAP_SECTIONS.map(([k, label]) => `<option value="${k}" ${m.section === k ? "selected" : ""}>${esc(label)}</option>`).join("")}</select></td>
        <td class="py-2 px-3 w-32"><input type="number" min="0" max="100" step="any" data-map="${i}" data-field="pct" value="${esc(m.pct)}" ${edit && m.section !== "excluded" ? "" : "disabled"} class="${INPUT} text-right"></td>
        <td class="py-2 px-3">${edit ? `<button data-action="cogm-map-rm" data-i="${i}" class="text-rose-600 hover:text-rose-800" aria-label="Hapus"><i class="fas fa-trash"></i></button>` : ""}</td></tr>`,
    )
    .join("");
  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/cogm" class="hover:text-indigo-600">Kertas Kerja COGM</a> / Pengaturan</div>
    <h1 class="text-2xl font-bold text-gray-900 mb-3">Pengaturan COGM Periodik</h1>
    ${edit ? "" : '<p class="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-3 max-w-4xl">Pengaturan hanya bisa diubah peran Accounting Advisor. Anda dapat melihatnya.</p>'}
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-2 gap-x-8 gap-y-4 max-w-5xl">
      ${fieldBlock("Jurnal COGM", `<select data-cfg="journal" ${edit ? "" : "disabled"} class="${INPUT}">${selectOptions(cfg.journals, cfg.journal)}</select>`)}
      <div></div>${roles}
      ${fieldBlock("Awalan Kode Akun yang Diperiksa", `<input data-cfg="scan" value="${esc(cfg.scan)}" ${edit ? "" : "disabled"} class="${INPUT}"><div class="text-xs text-gray-500 mt-1">Akun beban berawalan kode ini yang bergerak pada periode tetapi belum diklasifikasikan membuat Control Balance Merah. Pisahkan dengan koma; kosong = tidak diperiksa.</div>`)}
      ${fieldBlock("Toleransi Selisih Opname (%)", `<input type="number" min="0" step="any" data-cfg="tolerance" value="${esc(cfg.tolerance)}" ${edit ? "" : "disabled"} class="${INPUT} text-right"><div class="text-xs text-gray-500 mt-1">Selisih jumlah fisik terhadap stok sistem sampai persentase ini dianggap wajar; di atasnya perlu Alasan Selisih.</div>`)}
    </section>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 max-w-5xl">
      <div class="px-5 py-3 border-b border-gray-200 font-semibold text-gray-900">Pemetaan Akun Biaya Produksi</div>
      <div class="overflow-x-auto"><table class="w-full text-left"><thead class="border-b border-gray-200"><tr>${th("Akun")}${th("Bagian COGM")}${th("Porsi Produksi (%)", true)}${th("")}</tr></thead>
        <tbody class="divide-y divide-gray-100">${maps || '<tr><td colspan="4" class="py-6 text-center text-sm text-gray-500">Belum ada akun yang dipetakan.</td></tr>'}</tbody></table></div>
      ${edit ? '<div class="px-5 py-3"><button data-action="cogm-map-add" class="px-3 py-1.5 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50"><i class="fas fa-plus mr-2"></i>Tambah Akun</button></div>' : ""}
      <p class="px-5 pb-4 text-xs text-gray-500">Porsi produksi: bagian saldo akun yang dibebankan ke produksi, mis. 70 untuk listrik yang dipakai pabrik 70%. "Bukan Biaya Produksi" menandai akun berawalan kode yang diperiksa tetapi sengaja tidak masuk COGM (mis. harga pokok penjualan).</p>
    </section>
    ${edit ? `<div class="flex gap-2 mt-4">${button("cogm-cfg-save", "Simpan Pengaturan", "primary")}${button("cogm-setup", "Lengkapi Bawaan", "plain")}</div>` : ""}`;
}

async function saveSetting() {
  const missing = Object.entries(cfg.accounts).filter(([, account]) => !account).map(([key]) => ROLES.find((r) => r[0] === key)[1]);
  if (missing.length) throw new Error(`Pilih akun untuk: ${missing.join(", ")}.`);
  if (cfg.maps.some((m) => !m.account)) throw new Error("Pilih akun dari kotak saran pada setiap baris pemetaan, atau hapus barisnya.");
  const seen = new Set();
  for (const m of cfg.maps) {
    if (seen.has(m.account.id)) throw new Error(`${m.account.display_name} dipetakan dua kali.`);
    seen.add(m.account.id);
    if (!(num(m.pct) >= 0 && num(m.pct) <= 100)) throw new Error("Porsi produksi harus antara 0 dan 100.");
  }
  const initial = new Map(cfg.initialMaps.map((m) => [m.id, m]));
  const accountCommands = [];
  for (const m of cfg.maps) {
    const vals = { account_id: m.account.id, section: m.section, pct: m.section === "excluded" ? 0 : num(m.pct) };
    if (!m.id) accountCommands.push([0, 0, vals]);
    else {
      const before = initial.get(m.id);
      if (before.account !== vals.account_id || before.section !== vals.section || num(before.pct) !== vals.pct) accountCommands.push([1, m.id, vals]);
    }
  }
  for (const id of cfg.removed) accountCommands.push([2, id, 0]);
  await call("kompakapps.cogm.config", "write", {
    ids: [cfg.id],
    vals: {
      journal_id: cfg.journal, raw_account_id: cfg.accounts.raw.id, wip_account_id: cfg.accounts.wip.id, fg_account_id: cfg.accounts.fg.id, summary_account_id: cfg.accounts.summary.id,
      scan_prefix: cfg.scan.trim() || false, tolerance_pct: num(cfg.tolerance), account_ids: accountCommands,
    },
  });
  return true;
}

/* ---------- Peristiwa ---------- */

registerLookup("cogm-product", {
  pageSize: PRODUCT_PAGE,
  search: (q, _input, page) => searchProducts(q, page, { domain: [["type", "=", "consu"]], fields: ["display_name", "uom_id", "standard_price", "is_storable"] }),
  sub: (r) => r.uom_id?.[1] ?? "",
  isChosen: (input) => Boolean(form?.ops[Number(input.dataset.op)]?.product) && form.ops[Number(input.dataset.op)].product.display_name === input.value,
  choose: async (input, item) => {
    const row = form.ops[Number(input.dataset.op)];
    if (form.ops.some((r) => r !== row && r.product?.id === item.id)) {
      toast(`${item.display_name} sudah ada pada lembar opname.`, "error");
      return;
    }
    const info = (await call(MODEL, "kompakapps_product_info", { product_ids: [item.id], date_to: form.ws.date_to }))[item.id];
    Object.assign(row, { product: { id: item.id, display_name: item.display_name }, uom: item.uom_id?.[1] ?? "", storable: item.is_storable, unitCost: String(info?.unit_cost ?? item.standard_price), bookQty: info?.book_qty ?? 0 });
    form.dirty = true;
    document.getElementById("ops-box").innerHTML = opsHtml();
    refreshLive();
    document.querySelector(`[data-op="${form.ops.indexOf(row)}"][data-field="qty"]`)?.focus();
  },
});
registerLookup("cogm-wip-product", {
  pageSize: PRODUCT_PAGE,
  search: (q, _input, page) => searchProducts(q, page, { domain: [["product_tmpl_id.bom_ids", "!=", false]], fields: ["display_name", "uom_id"] }),
  sub: (r) => r.uom_id?.[1] ?? "",
  isChosen: (input) => Boolean(form?.wips[Number(input.dataset.wip)]?.product) && form.wips[Number(input.dataset.wip)].product.display_name === input.value,
  choose: async (input, item) => {
    const row = form.wips[Number(input.dataset.wip)];
    const [material, conversion] = await call(MODEL, "bom_cost_split", { product_id: item.id });
    Object.assign(row, { product: { id: item.id, display_name: item.display_name }, materialCost: String(material), conversionCost: String(conversion) });
    if (!row.name.trim()) row.name = `WIP ${item.display_name}`;
    form.dirty = true;
    document.getElementById("wip-box").innerHTML = wipsHtml();
    refreshLive();
  },
});

const blankOp = () => ({ id: null, product: null, uom: "", storable: false, qty: "", unitCost: "", bookQty: 0, explanation: "" });
const blankWip = () => ({ id: null, name: "", product: null, qty: "", materialCost: "", materialPct: "100", conversionCost: "", completionPct: "50" });

export async function onClick(event, el) {
  const { action } = el.dataset;
  if (!action?.startsWith("cogm-")) return;
  if (action === "cogm-discard-new") draftNew = null;
  else if (action === "cogm-create") {
    const id = await guarded(el, () => createWorksheet());
    if (id) {
      draftNew = null;
      form = null;
      toast("Kertas kerja dibuat.");
      location.hash = `#/cogm/${id}`;
    }
  } else if (action === "cogm-add-op") {
    form.ops.push(blankOp());
    form.dirty = true;
    document.getElementById("ops-box").innerHTML = opsHtml();
    refreshLive();
    document.querySelector(`[data-lookup="cogm-product"][data-op="${form.ops.length - 1}"]`)?.focus();
  } else if (action === "cogm-add-wip") {
    form.wips.push(blankWip());
    form.dirty = true;
    document.getElementById("wip-box").innerHTML = wipsHtml();
    refreshLive();
  } else if (action === "cogm-rm-op" || action === "cogm-rm-wip") {
    const list = action === "cogm-rm-op" ? form.ops : form.wips;
    const [removed] = list.splice(Number(el.dataset.i), 1);
    if (removed.id) form.removed[action === "cogm-rm-op" ? "ops" : "wips"].push(removed.id);
    form.dirty = true;
    document.getElementById(action === "cogm-rm-op" ? "ops-box" : "wip-box").innerHTML = action === "cogm-rm-op" ? opsHtml() : wipsHtml();
    refreshLive();
  } else if (action === "cogm-save") {
    const id = form.id;
    const saved = await guarded(el, async () => {
      await persist();
      return true;
    });
    if (saved) {
      toast("Kertas kerja disimpan.");
      await renderForm(id);
    }
  } else if (["cogm-pull", "cogm-check"].includes(action)) {
    const id = form.id;
    const done = await guarded(el, async () => {
      if (form.dirty) await persist();
      if (action === "cogm-pull") await call(MODEL, "action_pull", { ids: [id] });
      return true;
    });
    if (done) {
      if (action === "cogm-pull") toast("Data buku besar ditarik.");
      form = null;
      await renderForm(id);
    }
  } else if (action === "cogm-post") {
    if (!window.confirm("Eksekusi jurnal COGM? Jurnal diposting pada tanggal akhir periode dan isi kertas kerja terkunci.")) return;
    const id = form.id;
    const done = await guarded(el, () => call(MODEL, "action_post", { ids: [id] }).then(() => true));
    if (done) {
      toast("Jurnal COGM dieksekusi.");
      form = null;
      await renderForm(id);
    }
  } else if (["cogm-reverse", "cogm-cancel", "cogm-draft"].includes(action)) {
    const id = form.id;
    const ask = {
      "cogm-reverse": "Batalkan jurnal COGM? Jurnal pembalik dibuat pada tanggal yang sama dan kertas kerja kembali ke draft.",
      "cogm-cancel": "Batalkan kertas kerja ini?",
    }[action];
    if (ask && !window.confirm(ask)) return;
    const method = { "cogm-reverse": "action_reverse", "cogm-cancel": "action_cancel", "cogm-draft": "action_draft" }[action];
    const done = await guarded(el, () => call(MODEL, method, { ids: [id] }).then(() => true));
    if (done) {
      toast({ "cogm-reverse": "Jurnal COGM dibatalkan.", "cogm-cancel": "Kertas kerja dibatalkan.", "cogm-draft": "Kertas kerja dikembalikan ke draft." }[action]);
      form = null;
      await renderForm(id);
    }
  } else if (action === "cogm-setup") {
    const done = await guarded(el, () => call("res.company", "kompakapps_setup_cogm", { ids: [ctx.company.id] }).then(() => true));
    if (done) {
      toast("Pengaturan COGM disiapkan.");
      await renderSetting();
    }
  } else if (action === "cogm-map-add") {
    cfg.maps.push({ id: null, account: null, section: "overhead", pct: "100" });
    paintSetting();
    document.querySelector(`[data-lookup="cogm-map-account"][data-map="${cfg.maps.length - 1}"]`)?.focus();
  } else if (action === "cogm-map-rm") {
    const [removed] = cfg.maps.splice(Number(el.dataset.i), 1);
    if (removed.id) cfg.removed.push(removed.id);
    paintSetting();
  } else if (action === "cogm-cfg-save") {
    const saved = await guarded(el, saveSetting);
    if (saved) {
      toast("Pengaturan COGM disimpan.");
      await renderSetting();
    }
  }
}

export function onInput(event, el) {
  const { dataset } = el;
  if (dataset.lookup) {
    // mengetik di kotak saran membatalkan pilihan sebelumnya sampai salah satu saran dipilih lagi
    if (dataset.lookup === "cogm-product" && form) form.ops[Number(dataset.op)].product = null;
    if (dataset.lookup === "cogm-wip-product" && form) form.wips[Number(dataset.wip)].product = null;
    if (dataset.lookup === "cogm-cfg-account" && cfg) cfg.accounts[dataset.role] = null;
    if (dataset.lookup === "cogm-map-account" && cfg) cfg.maps[Number(dataset.map)].account = null;
    runLookup(el, 250);
  } else if (dataset.new && draftNew) draftNew[dataset.new] = el.value;
  else if (dataset.ws && form) {
    form.headerValues[dataset.ws] = el.value;
    form.headerDirty = true;
    form.ws[dataset.ws] = el.value;
    markDirty();
  } else if (dataset.op !== undefined && dataset.field && form) {
    form.ops[Number(dataset.op)][dataset.field] = el.value;
    markDirty();
  } else if (dataset.wip !== undefined && dataset.field && form) {
    form.wips[Number(dataset.wip)][dataset.field] = el.value;
    markDirty();
  } else if (dataset.cfg && cfg) cfg[dataset.cfg] = dataset.cfg === "journal" ? Number(el.value) : el.value;
  else if (dataset.map !== undefined && dataset.field && cfg) {
    const row = cfg.maps[Number(dataset.map)];
    row[dataset.field] = el.value;
    if (dataset.field === "section") paintSetting();
  }
}
