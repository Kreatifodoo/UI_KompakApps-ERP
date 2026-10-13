// Jurnal Entry manual (D50): form buat, edit draf, posting, batalkan ke draf, duplikat, dan balik jurnal untuk account.move bertipe entry
// pada jurnal umum. Dipakai halaman journal.js (daftar dan rincian jurnal lain tetap baca-saja di sana).
// Draf disimpan dengan konteks check_move_validity=false (Odoo menolak draf tak seimbang bila tidak); keseimbangan diperiksa
// saat posting dari angka yang tersimpan di Odoo (termasuk baris pajak otomatis).
import {
  ACCOUNT_TYPE_LABELS, INPUT, app, badge, call, closeLookup, closeModal, ctx, dateText, esc, fieldBlock, guarded, hasGroup, money, openModal, plain,
  readOne, readonlyValue, registerLookup, runLookup, searchAccounts, searchRead, selectOptions, statTiles, statusbar, toast, today,
} from "./common.js";
import { analyticCell, analyticSummary, distributionChange, preloadAnalytic, readDistribution, registerAnalytic } from "./analyticpick.js";
import { loadTaxNames, registerTaxes, taxCell, taxChange, taxList } from "./taxpick.js";
import { printButton } from "./print.js";

const STATES = { draft: ["Draft", "muted"], posted: ["Terposting", "success"], cancel: ["Dibatalkan", "danger"] };
const FLOW = ["draft", "posted"];
const SCOPE = "journal";
const NO_CHECK = { check_move_validity: false };
const LOCKS = [
  ["hard_lock_date", "Kunci permanen"],
  ["fiscalyear_lock_date", "Kunci semua pengguna"],
  ["tax_lock_date", "Kunci pajak"],
];
const LOCK_NAMES = { "Hard Lock Date": "Kunci permanen", "Lock Date for All Users": "Kunci semua pengguna", "Tax Return Lock Date": "Kunci pajak", "Lock Date for Non-Advisers": "Kunci non-Advisor" };

// form: { id, state, date, journal, ref, narration, initial, lines, autoLines, removed, locks, advisor }
let form = null;
let journals = null;
let reversing = null;
const lineAt = (input) => form?.lines?.[Number(input.dataset.line)];
const box = () => document.querySelector("#je-lines");
const redraw = () => {
  if (box() && form) box().innerHTML = linesTable();
  updateBalance();
};
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (x) => Math.round(x * 100) / 100;
const currencyName = () => ctx.company?.currency_id?.[1];
const toHtml = (text) => `<p>${esc(text.trim()).replace(/\n/g, "<br>")}</p>`;

export function leave() {
  form = null;
  reversing = null;
}

/** Jurnal umum yang boleh dipakai jurnal manual. */
async function generalJournals() {
  journals ??= searchRead("account.journal", [["type", "=", "general"]], ["display_name"], { order: "sequence, code" }).catch((error) => {
    journals = null;
    throw error;
  });
  return journals;
}

/** Jurnal manual: bertipe entry, memakai jurnal umum, dan bukan hasil dokumen lain (pembayaran, valuasi stok, aset). */
export async function isManual(move, links) {
  if (move.move_type !== "entry" || links.length) return false;
  const list = await generalJournals();
  if (!list.some((j) => j.id === move.journal_id?.[0])) return false;
  const assets = await searchRead("account.asset.line", [["move_id", "=", move.id]], ["id"], { limit: 1 }).catch(() => []);
  return !assets.length;
}

/** Galat Odoo yang umum diganti pesan Indonesia (kunci periode, tak seimbang). */
function friendly(error) {
  const text = String(error?.message ?? "");
  const lock = text.match(/prior to and inclusive of: (.+?) \((\d\d)\/(\d\d)\/(\d{4})\)/);
  if (lock) {
    const name = LOCK_NAMES[lock[1]] ?? lock[1];
    return new Error(`Periode terkunci (${name} sampai ${lock[3]}/${lock[2]}/${lock[4]}): jurnal pada atau sebelum tanggal itu tidak bisa ditambah atau diubah. Ubah tanggal jurnal, atau buka kunci di Setting > Company bila diizinkan.`);
  }
  if (/not balanced/i.test(text)) return new Error("Jurnal tidak seimbang: total debit harus sama dengan total kredit.");
  return error;
}
const run = (button, task) =>
  guarded(button, async () => {
    try {
      return await task();
    } catch (error) {
      throw friendly(error);
    }
  });

/* ---------- Pemilih ---------- */

registerLookup("jentry-account", {
  search: (q) => searchAccounts(q),
  sub: (r) => ACCOUNT_TYPE_LABELS[r.account_type] ?? "",
  isChosen: (input) => lineAt(input)?.account?.display_name === input.value,
  choose: (input, item) => {
    lineAt(input).account = { id: item.id, display_name: item.display_name };
    input.value = item.display_name;
    document.querySelector(`[data-line="${input.dataset.line}"][data-field="name"]`)?.focus();
  },
});
registerLookup("jentry-partner", {
  search: (q) => searchRead("res.partner", q ? [["name", "ilike", q]] : [], ["display_name"], { limit: 10, order: "name" }),
  isChosen: (input) => lineAt(input)?.partner?.display_name === input.value,
  choose: (input, item) => {
    lineAt(input).partner = { id: item.id, display_name: item.display_name };
    input.value = item.display_name;
  },
});
registerAnalytic(SCOPE, {
  get: (i) => form?.lines?.[Number(i)]?.analytic ?? {},
  set: (i, dist) => {
    const line = form?.lines?.[Number(i)];
    if (!line) return;
    line.analytic = dist;
    const button = document.querySelector(`[data-an-open="${SCOPE}"][data-an-key="${i}"]`);
    if (button) button.outerHTML = analyticCell(SCOPE, i, dist);
  },
  label: (i) => form?.lines?.[Number(i)]?.name || form?.lines?.[Number(i)]?.account?.display_name || "",
});
registerTaxes(SCOPE, {
  use: ["sale", "purchase", "none"],
  get: (i) => form?.lines?.[Number(i)]?.taxes ?? [],
  set: (i, taxes) => {
    const line = form?.lines?.[Number(i)];
    if (!line) return;
    line.taxes = taxes;
    line.taxTouched = true;
    const cell = document.querySelector(`[data-tx-cell="${i}"]`);
    if (cell) cell.innerHTML = taxCell(SCOPE, i, taxes);
    updateBalance();
  },
});

/* ---------- Baris ---------- */

const emptyLine = () => ({
  id: null, account: null, account0: null, partner: null, partner0: null, name: "", name0: "", debit: "", credit: "", debit0: 0, credit0: 0,
  analytic: undefined, analytic0: undefined, taxes: [], taxes0: undefined, taxTouched: false,
});
function lineFromRow(l, taxName) {
  const analytic = readDistribution(l.analytic_distribution);
  const account = l.account_id ? { id: l.account_id[0], display_name: l.account_id[1] } : null;
  return {
    id: l.id, account, account0: account?.id ?? null, partner: l.partner_id ? { id: l.partner_id[0], display_name: l.partner_id[1] } : null, partner0: l.partner_id?.[0] ?? null,
    name: l.name || "", name0: l.name || "", debit: l.debit || "", credit: l.credit || "", debit0: l.debit, credit0: l.credit,
    analytic, analytic0: analytic, taxes: taxList(l.tax_ids, taxName), taxes0: l.tax_ids, taxTouched: false,
  };
}

function totals() {
  let debit = 0;
  let credit = 0;
  for (const l of form.lines) {
    debit += num(l.debit);
    credit += num(l.credit);
  }
  for (const a of form.autoLines) {
    debit += a.debit;
    credit += a.credit;
  }
  return { debit: round2(debit), credit: round2(credit), diff: round2(debit - credit) };
}

function balanceHtml() {
  const t = totals();
  const ok = Math.abs(t.diff) < 0.005;
  const pendingTax = form.lines.some((l) => l.taxTouched && l.taxes.length);
  const text = ok
    ? "Seimbang"
    : `Tidak seimbang: ${t.diff > 0 ? "debit" : "kredit"} lebih besar ${money(Math.abs(t.diff), currencyName())}`;
  return `<div class="flex flex-wrap items-center justify-end gap-x-6 gap-y-1 text-sm">
    <span class="text-gray-500">Total Debit <span class="font-semibold text-gray-900" id="je-debit">${money(t.debit, currencyName())}</span></span>
    <span class="text-gray-500">Total Kredit <span class="font-semibold text-gray-900" id="je-credit">${money(t.credit, currencyName())}</span></span>
    <span id="je-diff" class="font-semibold ${ok ? "text-emerald-600" : "text-rose-600"}" role="status">${esc(text)}</span>
    ${ok ? "" : `<button type="button" data-action="je-balance" class="text-indigo-600 hover:text-indigo-800 font-medium">Tambah baris penyeimbang</button>`}
  </div>${pendingTax ? '<p class="text-xs text-gray-500 mt-1 text-right">Baris pajak ditambahkan otomatis oleh Odoo saat disimpan; periksa keseimbangan setelah Simpan.</p>' : ""}`;
}
function updateBalance() {
  const target = document.querySelector("#je-balance");
  if (target && form) target.innerHTML = balanceHtml();
}

function linesTable() {
  const rows = form.lines
    .map(
      (l, i) => `<tr class="align-top">
        <td class="py-2 pr-2 min-w-56"><input data-lookup="jentry-account" data-line="${i}" autocomplete="off" role="combobox" aria-autocomplete="list" value="${esc(l.account?.display_name ?? "")}" placeholder="Cari kode atau nama akun..." class="${INPUT}" aria-label="Akun baris ${i + 1}"></td>
        <td class="py-2 px-2 min-w-44"><input data-lookup="jentry-partner" data-line="${i}" autocomplete="off" role="combobox" aria-autocomplete="list" value="${esc(l.partner?.display_name ?? "")}" placeholder="Mitra (opsional)" class="${INPUT}" aria-label="Mitra baris ${i + 1}"></td>
        <td class="py-2 px-2 min-w-40"><input data-line="${i}" data-field="name" value="${esc(l.name)}" placeholder="Label" class="${INPUT}" aria-label="Label baris ${i + 1}"></td>
        <td class="py-2 px-2 min-w-36"><input type="number" min="0" step="any" data-line="${i}" data-field="debit" value="${esc(l.debit)}" placeholder="0" class="${INPUT} text-right" aria-label="Debit baris ${i + 1}"></td>
        <td class="py-2 px-2 min-w-36"><input type="number" min="0" step="any" data-line="${i}" data-field="credit" value="${esc(l.credit)}" placeholder="0" class="${INPUT} text-right" aria-label="Kredit baris ${i + 1}"></td>
        <td class="py-2 px-2 min-w-48" data-tx-cell="${i}">${taxCell(SCOPE, i, l.taxes)}</td>
        <td class="py-2 px-2 min-w-48">${analyticCell(SCOPE, i, l.analytic)}</td>
        <td class="py-2 pl-2 w-10 text-center"><button type="button" data-action="je-remove-line" data-line="${i}" class="text-gray-400 hover:text-rose-600 mt-2" aria-label="Hapus baris ${i + 1}"><i class="fas fa-trash-alt"></i></button></td>
      </tr>`,
    )
    .join("");
  const auto = form.autoLines
    .map(
      (a) => `<tr class="align-top text-gray-500 bg-gray-50"><td class="py-2 px-2 text-sm">${esc(a.account)}</td><td class="py-2 px-2 text-sm"></td>
        <td class="py-2 px-2 text-sm">${esc(a.name)}</td><td class="py-2 px-2 text-sm text-right">${a.debit ? money(a.debit, currencyName()) : ""}</td>
        <td class="py-2 px-2 text-sm text-right">${a.credit ? money(a.credit, currencyName()) : ""}</td><td class="py-2 px-2 text-xs" colspan="3">Baris otomatis dari pajak</td></tr>`,
    )
    .join("");
  const heads = ["Akun", "Mitra", "Label", "Debit", "Kredit", "Pajak", "Analitik", ""];
  return `<table class="w-full text-left">
      <thead><tr>${heads.map((h) => `<th class="pb-2 px-2 text-xs font-semibold text-gray-600 uppercase ${h === "Debit" || h === "Kredit" ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>
      <tbody>${rows}${auto}</tbody></table>
    <div class="flex flex-wrap gap-4 mt-1">
      <button type="button" data-action="je-add-line" class="text-sm text-indigo-600 font-medium hover:text-indigo-800"><i class="fas fa-plus mr-1"></i>Tambah baris</button>
    </div>
    <div id="je-balance" class="mt-3 border-t border-gray-200 pt-3">${balanceHtml()}</div>`;
}

function lockHint(date) {
  const locks = form?.locks;
  if (!date || !locks) return "";
  for (const [key, label] of LOCKS) {
    if (locks[key] && date <= locks[key]) {
      return `Tanggal ini berada dalam periode terkunci (${label} sampai ${dateText(locks[key])}). ${
        key === "hard_lock_date" ? "Jurnal tidak bisa diposting pada tanggal ini." : "Hanya pengguna Advisor yang dapat memposting pada tanggal ini."}`;
    }
  }
  return "";
}

/* ---------- Tampilan ---------- */

const BUTTONS = {
  draft: [
    { action: "je-save", label: "Simpan", kind: "primary" },
    { action: "je-post", label: "Posting", kind: "primary" },
    { action: "je-dup", label: "Duplikat" },
    { action: "je-cancel", label: "Batalkan", kind: "danger" },
  ],
  posted: [
    { action: "je-reverse", label: "Balik Jurnal", kind: "primary" },
    { action: "je-draft", label: "Batalkan ke Draf" },
    { action: "je-dup", label: "Duplikat" },
  ],
  cancel: [
    { action: "je-draft", label: "Kembalikan ke Draf", kind: "primary" },
    { action: "je-dup", label: "Duplikat" },
  ],
};
const btn = (b, id) => {
  const klass =
    b.kind === "primary" ? "bg-indigo-600 text-white hover:bg-indigo-700" : b.kind === "danger" ? "bg-white text-rose-600 border border-rose-300 hover:bg-rose-50" : "bg-white text-gray-700 border border-gray-300 hover:bg-gray-50";
  return `<button data-action="${b.action}" data-id="${id ?? ""}" class="px-4 py-2 rounded-lg text-sm font-medium ${klass}">${b.label}</button>`;
};

/** Menggambar jurnal manual: id null = baru. `known` (opsional) adalah move yang sudah dibaca pemanggil. */
export async function renderEntry(id) {
  closeLookup();
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  await preloadAnalytic();
  const creating = id === null;
  const list = await generalJournals();
  const [advisor, company] = await Promise.all([hasGroup("account.group_account_manager").catch(() => false), readOne("res.company", ctx.company.id, LOCKS.map(([key]) => key))]);
  const locks = Object.fromEntries(LOCKS.map(([key]) => [key, company?.[key] || null]));
  if (creating) {
    const first = emptyLine();
    const second = emptyLine();
    const values = { date: today(), ref: "", narration: "" };
    form = { id: null, state: "draft", ...values, journal: list[0]?.id ?? "", journalList: list, initial: { ...values, journal: list[0]?.id ?? "" }, lines: [first, second], autoLines: [], removed: [], locks, advisor };
    app.innerHTML = page(null, []);
    return;
  }
  const move = await readOne("account.move", id, ["name", "state", "move_type", "date", "ref", "journal_id", "narration", "currency_id", "amount_total", "reversed_entry_id", "reversal_move_ids"]);
  if (!move || move.move_type !== "entry") {
    app.innerHTML = '<p class="text-sm text-rose-600">Jurnal tidak ditemukan.</p>';
    return;
  }
  const rows = await searchRead(
    "account.move.line",
    [["move_id", "=", id]],
    ["account_id", "name", "partner_id", "debit", "credit", "display_type", "analytic_distribution", "tax_ids", "matching_number"],
    { order: "sequence, id" },
  );
  const taxName = await loadTaxNames(rows.flatMap((l) => l.tax_ids));
  const own = rows.filter((l) => l.display_type === "product");
  const autoLines = rows.filter((l) => l.display_type !== "product").map((l) => ({ account: l.account_id?.[1] ?? "", name: l.name || "", debit: l.debit, credit: l.credit }));
  const values = { date: move.date || "", ref: move.ref || "", narration: plain(move.narration || "") };
  form = {
    id, state: move.state, ...values, journal: move.journal_id?.[0], journalName: move.journal_id?.[1], initial: { ...values, journal: move.journal_id?.[0] },
    journalList: list, lines: own.map((l) => lineFromRow(l, taxName)), autoLines, removed: [], locks, advisor, move, rows, taxName,
  };
  app.innerHTML = page(move, rows);
}

function headerFields(editable, list) {
  if (!editable) {
    const m = form.move;
    return `${fieldBlock("Jurnal", readonlyValue(form.journalName))}
      ${fieldBlock("Tanggal", readonlyValue(dateText(form.date)))}
      ${fieldBlock("Referensi", readonlyValue(form.ref))}
      ${fieldBlock("Total", readonlyValue(money(m.amount_total, m.currency_id?.[1])))}
      ${form.narration ? `<div class="md:col-span-2">${fieldBlock("Catatan", readonlyValue(form.narration))}</div>` : ""}`;
  }
  return `${fieldBlock("Jurnal", `<select data-value="journal" class="${INPUT}" aria-label="Jurnal">${selectOptions(list, Number(form.journal) || null)}</select>`)}
    ${fieldBlock("Tanggal", `<input type="date" data-value="date" value="${esc(form.date)}" class="${INPUT}" aria-label="Tanggal"><p id="je-lockhint" class="text-xs text-amber-700 mt-1">${esc(lockHint(form.date))}</p>`)}
    ${fieldBlock("Referensi", `<input data-value="ref" value="${esc(form.ref)}" placeholder="mis. nomor bukti atau keterangan singkat" class="${INPUT}">`)}
    ${fieldBlock("Catatan", `<textarea data-value="narration" rows="2" class="${INPUT}">${esc(form.narration)}</textarea>`)}`;
}

function readonlyLines(rows, currency) {
  const t = { debit: rows.reduce((s, l) => s + l.debit, 0), credit: rows.reduce((s, l) => s + l.credit, 0) };
  const body = rows
    .map(
      (l) => `<tr><td class="py-2 px-4 text-sm">${esc(l.account_id?.[1])}</td><td class="py-2 px-4 text-sm">${esc(l.partner_id?.[1] ?? "")}</td>
        <td class="py-2 px-4 text-sm">${esc(l.name || "")}</td><td class="py-2 px-4 text-sm text-right">${l.debit ? money(l.debit, currency) : ""}</td>
        <td class="py-2 px-4 text-sm text-right">${l.credit ? money(l.credit, currency) : ""}</td>
        <td class="py-2 px-4 text-sm">${esc((l.tax_ids ?? []).map((id) => form.taxName.get(id) ?? `#${id}`).join(", "))}</td>
        <td class="py-2 px-4 text-sm">${esc(analyticSummary(l.analytic_distribution))}</td><td class="py-2 px-4 text-sm text-gray-500">${esc(l.matching_number || "")}</td></tr>`,
    )
    .join("");
  const ok = Math.abs(t.debit - t.credit) < 0.005;
  return `<table class="w-full text-left"><thead class="bg-gray-50"><tr>${["Akun", "Mitra", "Label", "Debit", "Kredit", "Pajak", "Analitik", "Rekonsiliasi"]
    .map((h, i) => `<th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase ${i === 3 || i === 4 ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>
    <tbody class="divide-y divide-gray-100">${body}</tbody>
    <tfoot class="bg-gray-50 font-semibold"><tr><td colspan="3" class="py-2 px-4 text-sm">Total <span class="font-normal ${ok ? "text-emerald-600" : "text-rose-600"}">(${ok ? "seimbang" : "tidak seimbang"})</span></td>
      <td class="py-2 px-4 text-sm text-right">${money(t.debit, currency)}</td><td class="py-2 px-4 text-sm text-right">${money(t.credit, currency)}</td><td colspan="3"></td></tr></tfoot></table>`;
}

function page(move, rows) {
  const creating = form.id === null;
  const editable = creating || form.state === "draft";
  const name = move?.name && move.name !== "/" ? move.name : "Draft";
  const tiles = creating
    ? ""
    : `<div class="flex flex-wrap gap-2 mb-4">${statTiles([
        { count: move.reversed_entry_id ? 1 : 0, label: `Membalik ${move.reversed_entry_id?.[1] ?? ""}`, icon: "fa-rotate-left", href: `#/journal/${move.reversed_entry_id?.[0]}` },
        { count: move.reversal_move_ids.length, label: "Jurnal Pembalik", icon: "fa-rotate-left", href: `#/journal?ids=${move.reversal_move_ids.join(",")}` },
        { count: rows.length, label: "Item Jurnal", icon: "fa-book", target: "je-section" },
      ])}</div>`;
  const actions = creating
    ? ""
    : `<div class="flex flex-wrap gap-2">${(BUTTONS[form.state] ?? []).map((b) => btn(b, form.id)).join("")}${printButton("journal.entry", form.id)}</div>`;
  const saveBar = creating
    ? `<div class="flex gap-2 mt-4">
         <button data-action="je-save" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50">Simpan Draf</button>
         <button data-action="je-save-post" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Simpan dan Posting</button>
         <a href="#/journal" data-action="je-discard" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Buang</a>
       </div>`
    : "";
  const inner = editable ? `<div id="je-lines">${linesTable()}</div>${saveBar}` : readonlyLines(rows, move.currency_id?.[1]);
  return `
    <div class="text-sm text-gray-500 mb-2"><a href="#/journal" class="hover:text-indigo-600">Jurnal Entry</a> / ${esc(creating ? "Baru" : name)}</div>
    <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-3 mb-3">${actions}${statusbar(FLOW, STATES, creating ? "draft" : form.state)}</div>
    ${tiles}
    <div class="mb-3"><h1 class="text-2xl font-bold text-gray-900">${creating ? "Jurnal Entry Baru" : esc(name)}</h1>
      ${creating ? "" : `<div class="mt-2">${badge(STATES, form.state)}</div>`}</div>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-2 gap-x-8 gap-y-4" id="je-header">${headerFields(editable, form.journalList)}</section>
    <section id="je-section" class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 p-4 overflow-x-auto">
      <div class="text-sm font-semibold mb-3">Item Jurnal</div>${inner}
    </section>`;
}

/* ---------- Simpan ---------- */

/** Baris yang dikirim: baris baru yang kosong dilewati; akun harus dipilih dari kotak saran; debit dan kredit tidak negatif. */
function resolveLines() {
  const out = [];
  form.lines.forEach((l, i) => {
    const empty = !l.account && !l.name.trim() && !num(l.debit) && !num(l.credit) && !l.partner;
    if (!l.id && empty) return;
    if (!l.account) throw new Error(`Baris ${i + 1}: pilih akun dari kotak saran.`);
    const debit = num(l.debit);
    const credit = num(l.credit);
    if (debit < 0 || credit < 0) throw new Error(`Baris ${i + 1}: debit dan kredit tidak boleh negatif.`);
    if (debit > 0 && credit > 0) throw new Error(`Baris ${i + 1}: isi debit atau kredit saja, tidak keduanya.`);
    if (!debit && !credit) throw new Error(`Baris ${i + 1}: isi jumlah debit atau kredit.`);
    out.push(l);
  });
  return out;
}

function newLineValues(l) {
  const vals = { account_id: l.account.id, debit: num(l.debit), credit: num(l.credit) };
  if (l.name.trim()) vals.name = l.name.trim();
  if (l.partner) vals.partner_id = l.partner.id;
  const analytic = distributionChange(l.analytic, undefined);
  if (analytic !== undefined) vals.analytic_distribution = analytic;
  const tax = taxChange(l.taxes, undefined, l.taxTouched);
  if (tax !== undefined) vals.tax_ids = tax;
  return vals;
}
function changedLineValues(l) {
  const vals = {};
  if (l.account.id !== l.account0) vals.account_id = l.account.id;
  if ((l.partner?.id ?? null) !== l.partner0) vals.partner_id = l.partner?.id ?? false;
  if (l.name.trim() !== l.name0) vals.name = l.name.trim();
  if (num(l.debit) !== l.debit0 || num(l.credit) !== l.credit0) Object.assign(vals, { debit: num(l.debit), credit: num(l.credit) });
  const analytic = distributionChange(l.analytic, l.analytic0);
  if (analytic !== undefined) vals.analytic_distribution = analytic;
  const tax = taxChange(l.taxes, l.taxes0, l.taxTouched);
  if (tax !== undefined) vals.tax_ids = tax;
  return vals;
}

function checkHeader() {
  if (!form.date) throw new Error("Isi tanggal jurnal.");
  if (!Number(form.journal)) throw new Error("Pilih jurnal.");
}

/** Membuat draf baru dan mengembalikan id. */
async function createMove() {
  checkHeader();
  const lines = resolveLines();
  if (!lines.length) throw new Error("Tambahkan minimal satu baris jurnal.");
  const vals = { move_type: "entry", date: form.date, journal_id: Number(form.journal), line_ids: lines.map((l) => [0, 0, newLineValues(l)]) };
  if (form.ref.trim()) vals.ref = form.ref.trim();
  if (form.narration.trim()) vals.narration = toHtml(form.narration);
  const [id] = await call("account.move", "create", { vals_list: [vals], context: NO_CHECK });
  return id;
}

/** Menulis perubahan draf: hanya field dan baris yang berubah. */
async function persist() {
  checkHeader();
  const lines = resolveLines();
  const commands = [];
  for (const l of lines) {
    if (!l.id) commands.push([0, 0, newLineValues(l)]);
    else {
      const vals = changedLineValues(l);
      if (Object.keys(vals).length) commands.push([1, l.id, vals]);
    }
  }
  commands.push(...form.removed.map((lineId) => [2, lineId, 0]));
  const vals = {};
  if (form.date !== form.initial.date) vals.date = form.date;
  if (Number(form.journal) !== form.initial.journal) vals.journal_id = Number(form.journal);
  if (form.ref !== form.initial.ref) vals.ref = form.ref.trim() || false;
  if (form.narration !== form.initial.narration) vals.narration = form.narration.trim() ? toHtml(form.narration) : false;
  if (commands.length) vals.line_ids = commands;
  if (Object.keys(vals).length) await call("account.move", "write", { ids: [form.id], vals, context: NO_CHECK });
}

/** Memastikan jurnal tersimpan seimbang di Odoo (termasuk baris pajak otomatis) dan tanggalnya tidak di periode terkunci permanen. */
async function assertPostable(id) {
  const items = await searchRead("account.move.line", [["move_id", "=", id]], ["debit", "credit"]);
  if (!items.length) throw new Error("Jurnal belum punya baris.");
  const debit = round2(items.reduce((s, l) => s + l.debit, 0));
  const credit = round2(items.reduce((s, l) => s + l.credit, 0));
  if (Math.abs(debit - credit) >= 0.005) {
    const cur = currencyName();
    throw new Error(`Jurnal tidak seimbang: total debit ${money(debit, cur)}, total kredit ${money(credit, cur)} (selisih ${money(Math.abs(debit - credit), cur)}). Seimbangkan dulu sebelum posting.`);
  }
  const { locks, advisor } = form;
  const hit = LOCKS.find(([key]) => locks[key] && form.date <= locks[key] && (key === "hard_lock_date" || (key === "fiscalyear_lock_date" && !advisor)));
  if (hit) throw new Error(`Tanggal ${dateText(form.date)} berada dalam periode terkunci (${hit[1]} sampai ${dateText(locks[hit[0]])}). Ubah tanggal jurnal ke setelah tanggal kunci.`);
}

async function save(button, post) {
  const creating = form.id === null;
  const result = await run(button, async () => {
    const id = creating ? await createMove() : (await persist(), form.id);
    if (post) {
      try {
        await assertPostable(id);
        await call("account.move", "action_post", { ids: [id] });
      } catch (error) {
        return { id, postError: friendly(error) };
      }
    }
    return { id };
  });
  if (!result) return;
  const { id, postError } = result;
  if (postError) toast(`Draf tersimpan, tetapi belum diposting: ${postError.message}`, "error");
  else toast(post ? "Jurnal diposting." : creating ? "Jurnal disimpan sebagai draf." : "Perubahan disimpan.");
  if (post && !postError) {
    const [after] = await call("account.move", "read", { ids: [id], fields: ["date"] }).catch(() => [null]);
    if (after && after.date !== form.date) toast(`Tanggal jurnal diubah Odoo menjadi ${dateText(after.date)} karena periode terkunci.`);
  }
  form = null;
  if (location.hash === `#/journal/${id}`) await renderEntry(id);
  else location.hash = `#/journal/${id}`;
}

async function simple(button, id, method, message, { context } = {}) {
  const ok = await run(button, () => call("account.move", method, { ids: [id], ...(context ? { context } : {}) }));
  if (ok === undefined) return;
  toast(message);
  form = null;
  await renderEntry(id);
}

async function duplicate(button, id) {
  const copy = await run(button, async () => {
    const result = await call("account.move", "copy", { ids: [id] });
    const newId = Array.isArray(result) ? result[0] : result;
    if (!newId) throw new Error("Odoo tidak mengembalikan jurnal salinan.");
    return newId;
  });
  if (!copy) return;
  toast("Jurnal diduplikat sebagai draf baru.");
  form = null;
  location.hash = `#/journal/${copy}`;
}

/* ---------- Balik jurnal (wizard account.move.reversal) ---------- */

async function openReverse(id) {
  reversing = { id, journalId: form?.journal };
  openModal(
    "Balik Jurnal",
    `<form data-form="je-reverse" class="space-y-4">
       ${fieldBlock("Tanggal pembalikan", `<input type="date" data-reverse="date" value="${esc(today())}" class="${INPUT}">`)}
       ${fieldBlock("Alasan", `<input data-reverse="reason" value="" placeholder="mis. koreksi salah catat" class="${INPUT}">`)}
       <p class="text-xs text-gray-500">Odoo membuat jurnal pembalik berisi debit dan kredit yang tertukar dan langsung memostingnya; jurnal asal tidak berubah.</p>
     </form>`,
    `<button data-action="modal-close" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Batal</button>
     <button data-action="je-reverse-confirm" class="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700">Balik Jurnal</button>`,
    () => {
      reversing = null;
    },
  );
}

async function confirmReverse(button) {
  if (!reversing) return;
  const { id, journalId } = reversing;
  const reason = document.querySelector('[data-reverse="reason"]')?.value.trim();
  const date = document.querySelector('[data-reverse="date"]')?.value;
  if (!date) {
    toast("Isi tanggal pembalikan.", "error");
    return;
  }
  const context = { active_model: "account.move", active_ids: [id] };
  const created = await run(button, async () => {
    const vals = { move_ids: [[6, 0, [id]]], date, ...(journalId ? { journal_id: journalId } : {}), ...(reason ? { reason } : {}) };
    const [wizard] = await call("account.move.reversal", "create", { vals_list: [vals], context });
    const result = await call("account.move.reversal", "reverse_moves", { ids: [wizard], context });
    if (!result?.res_id) throw new Error("Odoo tidak mengembalikan jurnal pembalik. Periksa di daftar jurnal.");
    return result.res_id;
  });
  if (!created) return;
  closeModal();
  toast("Jurnal pembalik dibuat dan diposting.");
  form = null;
  location.hash = `#/journal/${created}`;
}

/* ---------- Penangan peristiwa (dipanggil journal.js; mengembalikan true bila ditangani) ---------- */

export function onClick(event, el) {
  const { action } = el.dataset;
  if (!action?.startsWith("je-")) return false;
  const id = Number(el.dataset.id) || form?.id || null;
  if (action === "je-discard") form = null;
  else if (action === "je-add-line") {
    form.lines.push(emptyLine());
    redraw();
    document.querySelector(`[data-line="${form.lines.length - 1}"][data-lookup="jentry-account"]`)?.focus();
  } else if (action === "je-remove-line") {
    const [gone] = form.lines.splice(Number(el.dataset.line), 1);
    if (gone?.id) form.removed.push(gone.id);
    redraw();
  } else if (action === "je-balance") {
    const t = totals();
    const line = emptyLine();
    if (t.diff > 0) line.credit = round2(t.diff);
    else line.debit = round2(-t.diff);
    form.lines.push(line);
    redraw();
    document.querySelector(`[data-line="${form.lines.length - 1}"][data-lookup="jentry-account"]`)?.focus();
  } else if (action === "je-save") save(el, false);
  else if (action === "je-save-post") save(el, true);
  else if (action === "je-post") save(el, true);
  else if (action === "je-cancel") {
    if (window.confirm("Batalkan jurnal draf ini?")) simple(el, id, "button_cancel", "Jurnal dibatalkan.", { context: NO_CHECK });
  } else if (action === "je-draft") {
    const msg = form?.state === "posted" ? "Kembalikan jurnal ke draf? Rekonsiliasi yang ada akan dilepas." : "Kembalikan jurnal ke draf?";
    if (window.confirm(msg)) simple(el, id, "button_draft", "Jurnal dikembalikan ke draf.");
  } else if (action === "je-dup") duplicate(el, id);
  else if (action === "je-reverse") openReverse(id);
  else if (action === "je-reverse-confirm") confirmReverse(el);
  return true;
}

export function onInput(event, el) {
  if (!form) return false;
  if (el.dataset.lookup === "jentry-account") {
    const line = lineAt(el);
    if (line) line.account = null; // teks diubah: pilihan lama tidak berlaku sampai memilih dari kotak saran
    runLookup(el, 250);
  } else if (el.dataset.lookup === "jentry-partner") {
    const line = lineAt(el);
    if (line) line.partner = null;
    runLookup(el, 250);
  } else if (el.dataset.lookup?.startsWith("tax-")) runLookup(el, 250);
  else if (el.dataset.line !== undefined && el.dataset.field) {
    const line = lineAt(el);
    if (!line) return true;
    line[el.dataset.field] = el.value;
    // debit dan kredit saling meniadakan pada satu baris
    if ((el.dataset.field === "debit" || el.dataset.field === "credit") && num(el.value) > 0) {
      const other = el.dataset.field === "debit" ? "credit" : "debit";
      line[other] = "";
      const input = document.querySelector(`[data-line="${el.dataset.line}"][data-field="${other}"]`);
      if (input) input.value = "";
    }
    if (el.dataset.field === "debit" || el.dataset.field === "credit") updateBalance();
  } else if (el.dataset.value) {
    form[el.dataset.value] = el.value;
    if (el.dataset.value === "date") {
      const hint = document.querySelector("#je-lockhint");
      if (hint) hint.textContent = lockHint(el.value);
    }
  } else return false;
  return true;
}

export function onChange(event, el) {
  if (!form || !el.dataset.value) return false;
  form[el.dataset.value] = el.value;
  return true;
}

export async function onSubmit(event, formEl, kind) {
  if (kind !== "je-reverse") return false;
  await confirmReverse(null);
  return true;
}

/** Daftar jurnal umum untuk halaman lain (mis. uji). */
export const manualJournals = generalJournals;
